// dashboard-ui.js — Top-level glue for dashboard features.
// Module-specific logic lives in dashboard-grid.js, dashboard-widgets.js,
// dashboard-customizer.js, dashboard-cards.js.

// --- Session helpers ---

function getDashboardSessionId() {
    return App.state.activeSessionId || "";
}

function withDashboardSession(url) {
    const sessionId = getDashboardSessionId();
    if (!sessionId) return url;
    const glue = url.includes("?") ? "&" : "?";
    return `${url}${glue}session_id=${encodeURIComponent(sessionId)}`;
}

// fetchApiJson, assertApiSuccess — provided by ui-utils.js

// --- State helpers ---

function updatePinnedChartButton(chartDiv) {
    const chartContainer = chartDiv.closest(".chat-chart-container");
    const btn = chartContainer ? chartContainer.querySelector(".chart-action-btn") : null;
    if (!btn) return;
    btn.textContent = "✅ Pinned!";
    btn.classList.add("pinned");
    btn.disabled = true;
}

function isVisualsViewActive() {
    const visualsView = document.getElementById("view-visuals");
    return !!visualsView && visualsView.classList.contains("active");
}

function applyDashboardPayload(data) {
    App.state.dashboardCharts = Array.isArray(data?.charts) ? data.charts : [];
    App.state.dashboardCards = Array.isArray(data?.cards) ? data.cards : [];
    App.state.dashboardLoaded = true;
}

let dashboardRefreshPromise = null;
let smartQuestionsRequest = null;

function appendPinnedChartToState(chart) {
    if (!chart || !chart.id) return;
    if (!Array.isArray(App.state.dashboardCharts)) {
        App.state.dashboardCharts = [];
    }
    const exists = App.state.dashboardCharts.some((item) => item && item.id === chart.id);
    if (exists) return;

    App.state.dashboardCharts.push(chart);
    App.state.dashboardLoaded = true;
}

// --- Layout helpers ---

function chartLayoutFromGridPos(index, gridPos = {}) {
    return {
        x: gridPos.x ?? (index % 2) * 6,
        y: gridPos.y ?? Math.floor(index / 2) * 6,
        w: gridPos.w ?? 6,
        h: gridPos.h ?? 6,
    };
}

function cardLayoutFromGridPos(index, chartsCount, gridPos = {}) {
    return {
        x: gridPos.x ?? (index % 4) * 3,
        y: gridPos.y ?? Math.floor(index / 4) * 2 + (chartsCount > 0 ? 10 : 0),
        w: gridPos.w ?? 3,
        h: gridPos.h ?? 2,
    };
}

async function persistDashboardState(charts = App.state.dashboardCharts || [], cards = App.state.dashboardCards || []) {
    const { response, data } = await fetchApiJson(`${App.API_BASE}/api/dashboard`, {
        method: "POST",
        headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            session_id: getDashboardSessionId(),
            charts,
            cards,
        }),
    });
    assertApiSuccess(response, data, "Failed to save dashboard.", { requireSuccessFlag: true });
    return data;
}

// --- Pin chart ---

async function pinChart(chartId, title) {
    const chartDiv = document.getElementById(chartId);
    if (!chartDiv) return;

    const plotlyData = chartDiv.data;
    const plotlyLayout = chartDiv.layout;

    if (!plotlyData) {
        appendErrorMessage("Could not read chart data to pin.");
        return;
    }

    try {
        const { response, data: result } = await fetchApiJson(`${App.API_BASE}/api/dashboard/pin`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                session_id: getDashboardSessionId(),
                title: title || "Untitled Chart",
                chart: {
                    data: plotlyData,
                    layout: plotlyLayout,
                },
            }),
        });

        assertApiSuccess(response, result, "Failed to pin chart.", { requireSuccessFlag: true });
        updatePinnedChartButton(chartDiv);

        appendPinnedChartToState(result.chart);

        if (isVisualsViewActive()) {
            renderDashboardGrid();
        }
    } catch (error) {
        appendErrorMessage(error.message || "Error pinning chart. Is the backend running?");
        console.error("Pin error:", error);
    }
}

function downloadChart(chartId) {
    const chartDiv = document.getElementById(chartId);
    if (chartDiv) {
        Plotly.downloadImage(chartDiv, {
            format: "png",
            width: 1200,
            height: 600,
            filename: "data-talk-chart",
        });
    }
}

// --- Smart Questions ---

async function fetchSmartQuestions(options = {}) {
    const { force = false } = options;
    const activeFilename = String(App.state.activeFile?.filename || "").trim();

    if (!force && activeFilename && App.state.lastSuggestedQuestionsFile === activeFilename) {
        return;
    }
    if (smartQuestionsRequest) {
        return smartQuestionsRequest;
    }

    smartQuestionsRequest = (async () => {
    try {
        const response = await fetch(`${App.API_BASE}/api/suggest-questions`, {
            headers: App.getAuthHeaders()
        });
        const data = await response.json();
        const questions = data.questions || [];
        if (questions.length === 0) return;

        const chipsContainer = document.getElementById("suggestion-chips");
        if (chipsContainer) {
            chipsContainer.innerHTML = questions.map(q =>
                `<div class="suggestion-chip" onclick="useSuggestion(this)">${escapeHtml(q)}</div>`
            ).join("");
        }

        App.state.lastSuggestedQuestionsFile = activeFilename || null;
    } catch (e) {
        console.log("Could not fetch smart questions:", e.message);
    } finally {
        smartQuestionsRequest = null;
    }
    })();

    return smartQuestionsRequest;
}

// --- Data Preview Panel ---

function populateDataPreview(summary) {
    if (!summary || !summary.columns) return;

    const body = document.getElementById("data-preview-body");
    const toggle = document.getElementById("data-preview-toggle");
    if (!body) return;

    const dtypes = summary.dtypes || {};
    body.innerHTML = summary.columns.map(col => {
        const dtype = dtypes[col] || "unknown";
        const typeLabel = dtype.includes("int") || dtype.includes("float") ? "numeric"
            : dtype.includes("object") ? "text"
                : dtype.includes("datetime") ? "date"
                    : dtype;
        return `<div class="data-preview-col">
            <span class="col-name" title="${escapeHtml(col)}">${escapeHtml(col)}</span>
            <span class="col-type">${escapeHtml(typeLabel)}</span>
        </div>`;
    }).join("");

    if (toggle) toggle.style.display = "flex";
}

function toggleDataPreview() {
    const panel = document.getElementById("data-preview-panel");
    if (panel) panel.classList.toggle("visible");
}

// --- Fullscreen Chart ---

function openFullscreenChart(chartId) {
    const sourceChart = document.getElementById(chartId);
    if (!sourceChart || !sourceChart.data) return;

    const overlay = document.getElementById("chart-fullscreen-overlay");
    overlay.classList.add("visible");

    const layout = {
        ...(sourceChart.layout || {}),
        template: "plotly_white",
        font: { family: "Inter, sans-serif" },
        autosize: true,
        width: null,
        margin: { l: 60, r: 40, t: 60, b: 60 },
    };

    setTimeout(() => {
        Plotly.newPlot("fullscreen-chart", sourceChart.data, layout, {
            responsive: true,
            displayModeBar: true,
        });

        const closeBtn = overlay.querySelector('.close-fullscreen');
        if (closeBtn) closeBtn.focus();
    }, CONFIG.PLOTLY_RENDER_TIMEOUT);
}

function closeFullscreenChart() {
    const overlay = document.getElementById("chart-fullscreen-overlay");
    overlay.classList.remove("visible");
    Plotly.purge("fullscreen-chart");
    document.body.focus();
}

function closeFullscreen(event) {
    if (event.target === event.currentTarget) {
        closeFullscreenChart();
    }
}

// --- Refresh dashboard ---

async function refreshDashboard() {
    if (App.state.dashboardLoaded) {
        renderDashboardGrid();
        return {
            charts: App.state.dashboardCharts || [],
            cards: App.state.dashboardCards || [],
        };
    }

    if (dashboardRefreshPromise) {
        return dashboardRefreshPromise;
    }

    dashboardRefreshPromise = (async () => {
    try {
        const { data } = await fetchApiJson(withDashboardSession(`${App.API_BASE}/api/dashboard`), {
            headers: App.getAuthHeaders()
        });
        applyDashboardPayload(data);
        renderDashboardGrid();
        return data;
    } catch (e) {
        console.error("Failed to load dashboard:", e);
        applyDashboardPayload({ charts: [], cards: [] });
        renderDashboardGrid();
        return null;
    } finally {
        dashboardRefreshPromise = null;
    }
    })();

    return dashboardRefreshPromise;
}

// --- Global keyboard accessibility for fullscreen modals ---

document.addEventListener('keydown', function (event) {
    const overlay = document.getElementById("chart-fullscreen-overlay");
    if (!overlay || !overlay.classList.contains("visible")) return;

    if (event.key === "Escape") {
        closeFullscreenChart();
        return;
    }

    if (event.key === "Tab") {
        const focusableElements = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        const firstFocusableElement = focusableElements[0];
        const lastFocusableElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey) {
            if (document.activeElement === firstFocusableElement) {
                lastFocusableElement.focus();
                event.preventDefault();
            }
        } else {
            if (document.activeElement === lastFocusableElement) {
                firstFocusableElement.focus();
                event.preventDefault();
            }
        }
    }
});
