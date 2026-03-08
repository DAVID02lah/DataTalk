// Dashboard Pinning
// ============================================================

async function pinChart(chartId, title) {
    const chartDiv = document.getElementById(chartId);
    if (!chartDiv) return;

    // Get the plotly data from the rendered chart
    const plotlyData = chartDiv.data;
    const plotlyLayout = chartDiv.layout;

    if (!plotlyData) {
        alert("Could not read chart data");
        return;
    }

    try {
        const response = await fetch(`${App.API_BASE}/api/dashboard/pin`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: title || "Untitled Chart",
                chart: {
                    data: plotlyData,
                    layout: plotlyLayout,
                },
            }),
        });

        const result = await response.json();

        if (result.success) {
            // Update the pin button to show success
            const btn = chartDiv.closest(".chat-chart-container").querySelector(".chart-action-btn");
            if (btn) {
                btn.textContent = "✅ Pinned!";
                btn.classList.add("pinned");
                btn.disabled = true;
            }
            // Refresh dashboard if visuals tab is active
            if (document.getElementById("view-visuals") &&
                document.getElementById("view-visuals").classList.contains("active")) {
                refreshDashboard();
            }
        } else {
            alert("Failed to pin chart: " + (result.error || "Unknown error"));
        }
    } catch (error) {
        alert("Error pinning chart. Is the backend running?");
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

// ============================================================
// Smart Questions (after file upload)
// ============================================================
async function fetchSmartQuestions() {
    try {
        const response = await fetch(`${App.API_BASE}/api/suggest-questions`);
        const data = await response.json();
        const questions = data.questions || [];
        if (questions.length === 0) return;

        const chipsContainer = document.getElementById("suggestion-chips");
        if (chipsContainer) {
            chipsContainer.innerHTML = questions.map(q =>
                `<div class="suggestion-chip" onclick="useSuggestion(this)">${escapeHtml(q)}</div>`
            ).join("");
        }
    } catch (e) {
        console.log("Could not fetch smart questions:", e.message);
    }
}


// ============================================================
// Data Preview Panel
// ============================================================
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

    // Show the toggle button
    if (toggle) toggle.style.display = "flex";
}

function toggleDataPreview() {
    const panel = document.getElementById("data-preview-panel");
    if (panel) panel.classList.toggle("visible");
}

// ============================================================
// Fullscreen Chart
// ============================================================
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
        margin: { l: 60, r: 40, t: 60, b: 60 },
    };

    setTimeout(() => {
        Plotly.newPlot("fullscreen-chart", sourceChart.data, layout, {
            responsive: true,
            displayModeBar: true,
        });
    }, 100);
}

function closeFullscreenChart() {
    const overlay = document.getElementById("chart-fullscreen-overlay");
    overlay.classList.remove("visible");
    Plotly.purge("fullscreen-chart");
}

function closeFullscreen(event) {
    // Close when clicking the overlay background (not the chart container)
    if (event.target === event.currentTarget) {
        closeFullscreenChart();
    }
}

// ============================================================
// Native Dashboard (replaces Streamlit)
// ============================================================
async function refreshDashboard() {
    try {
        const response = await fetch(`${App.API_BASE}/api/dashboard`);
        const data = await response.json();
        App.state.dashboardCharts = data.charts || [];
        App.state.dashboardLoaded = true;
        renderDashboardGrid();
    } catch (e) {
        console.error("Failed to load dashboard:", e);
        App.state.dashboardCharts = [];
        App.state.dashboardLoaded = true;
        renderDashboardGrid();
    }
}

function renderDashboardGrid() {
    if (!App.state.dashboardLoaded) return;

    const grid = document.getElementById("dashboard-grid");
    const empty = document.getElementById("dashboard-empty");
    const countBadge = document.getElementById("dashboard-chart-count");

    if (!grid) return;

    // Update count
    const n = App.state.dashboardCharts.length;
    if (countBadge) countBadge.textContent = `${n} chart${n !== 1 ? "s" : ""}`;

    // Empty state
    if (n === 0) {
        grid.style.display = "none";
        if (empty) empty.style.display = "flex";
        return;
    }
    grid.style.display = "grid";
    if (empty) empty.style.display = "none";

    // Sort by position
    const sorted = [...App.state.dashboardCharts].sort((a, b) => (a.position || 0) - (b.position || 0));

    grid.innerHTML = sorted.map((chart) => {
        const title = chart.title || "Untitled Chart";
        const plotId = `dash-plot-${chart.id}`;
        const colSpan = chart.colSpan || 1;

        return `
            <div class="dashboard-chart-card"
                 draggable="true"
                 data-chart-id="${chart.id}"
                 data-col-span="${colSpan}">
                <div class="dashboard-chart-title">
                    <span class="drag-handle">
                        <span class="drag-handle-dot-row">
                            <span class="drag-handle-dot"></span>
                            <span class="drag-handle-dot"></span>
                        </span>
                        <span class="drag-handle-dot-row">
                            <span class="drag-handle-dot"></span>
                            <span class="drag-handle-dot"></span>
                        </span>
                        <span class="drag-handle-dot-row">
                            <span class="drag-handle-dot"></span>
                            <span class="drag-handle-dot"></span>
                        </span>
                    </span>
                    ${escapeHtml(title)}
                </div>
                <div class="dashboard-chart-plot" id="${plotId}"></div>
                <div class="dashboard-chart-actions">
                    <div class="card-resize-controls">
                        <button class="card-resize-btn ${colSpan === 1 ? 'active' : ''}"
                                onclick="setCardColSpan('${chart.id}', 1)" title="1 column">1</button>
                        <button class="card-resize-btn ${colSpan === 2 ? 'active' : ''}"
                                onclick="setCardColSpan('${chart.id}', 2)" title="2 columns">2</button>
                        <button class="card-resize-btn ${colSpan === 3 ? 'active' : ''}"
                                onclick="setCardColSpan('${chart.id}', 3)" title="3 columns">3</button>
                    </div>
                    <button class="btn-dash-action" onclick="downloadDashChart('${plotId}')">Download PNG</button>
                    <button class="btn-dash-action btn-dash-danger" onclick="removeDashChart('${chart.id}')">Remove</button>
                </div>
            </div>
        `;
    }).join("");

    // Attach drag-and-drop listeners
    initDashboardDragAndDrop();

    // Render Plotly charts after DOM insert
    requestAnimationFrame(() => {
        sorted.forEach((chart) => {
            const plotId = `dash-plot-${chart.id}`;
            const el = document.getElementById(plotId);
            if (!el || !chart.chart) return;

            try {
                const colSpan = chart.colSpan || 1;
                const layout = {
                    ...(chart.chart.layout || {}),
                    template: "plotly_white",
                    font: { family: "Inter, sans-serif" },
                    autosize: true,
                    width: undefined, // Fix: Reset width to force responsiveness
                    title: "",        // Fix: Remove internal title (already in header)
                    margin: { l: 40, r: 40, t: 30, b: 40 },
                    height: colSpan === 3 ? 420 : 340,
                };
                Plotly.newPlot(plotId, chart.chart.data, layout, {
                    responsive: true,
                    displayModeBar: true,
                    modeBarButtonsToRemove: ["lasso2d", "select2d"],
                });
            } catch (e) {
                el.innerHTML = '<p style="color: #ea4335; padding: 20px;">Error rendering chart</p>';
                console.error("Dashboard chart render error:", e);
            }
        });

        // Auto-resize all charts after CSS grid settles
        resizeAllDashboardCharts();
    });
}

function resizeAllDashboardCharts() {
    // Give the CSS grid time to settle before telling Plotly to resize
    setTimeout(() => {
        document.querySelectorAll(".dashboard-chart-plot").forEach(el => {
            if (el && el.data) {
                Plotly.Plots.resize(el);
            }
        });
    }, 350);
}

// ============================================================
// Dashboard: Column Span & Persistence
// ============================================================
async function setCardColSpan(chartId, newSpan) {
    const chart = App.state.dashboardCharts.find(c => c.id === chartId);
    if (!chart) return;
    chart.colSpan = newSpan;

    // Full re-render so all charts resize properly
    renderDashboardGrid();
    await saveDashboardToBackend();
}

async function saveDashboardToBackend() {
    try {
        await fetch(`${App.API_BASE}/api/dashboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ charts: App.state.dashboardCharts }),
        });
    } catch (e) {
        console.error("Failed to save dashboard:", e);
    }
}

// ============================================================
// Dashboard: HTML5 Drag & Drop
// ============================================================
function initDashboardDragAndDrop() {
    const grid = document.getElementById("dashboard-grid");
    if (!grid) return;

    const cards = grid.querySelectorAll(".dashboard-chart-card");

    cards.forEach(card => {
        card.addEventListener("dragstart", (e) => {
            // Prevent drag from action buttons
            if (e.target.closest(".dashboard-chart-actions") ||
                e.target.closest(".btn-dash-action") ||
                e.target.closest(".card-resize-btn")) {
                e.preventDefault();
                return;
            }
            App.state.draggedChartId = card.getAttribute("data-chart-id");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", App.state.draggedChartId);
            requestAnimationFrame(() => card.classList.add("dragging"));
        });

        card.addEventListener("dragend", () => {
            card.classList.remove("dragging");
            App.state.draggedChartId = null;
            grid.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
        });

        card.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const thisId = card.getAttribute("data-chart-id");
            if (thisId !== App.state.draggedChartId) {
                card.classList.add("drag-over");
            }
        });

        card.addEventListener("dragleave", (e) => {
            if (!card.contains(e.relatedTarget)) {
                card.classList.remove("drag-over");
            }
        });

        card.addEventListener("drop", (e) => {
            e.preventDefault();
            card.classList.remove("drag-over");

            const targetId = card.getAttribute("data-chart-id");
            if (!App.state.draggedChartId || App.state.draggedChartId === targetId) return;

            const fromIndex = App.state.dashboardCharts.findIndex(c => c.id === App.state.draggedChartId);
            const toIndex = App.state.dashboardCharts.findIndex(c => c.id === targetId);
            if (fromIndex === -1 || toIndex === -1) return;

            // Remove dragged item and insert at target position
            const [movedChart] = App.state.dashboardCharts.splice(fromIndex, 1);
            App.state.dashboardCharts.splice(toIndex, 0, movedChart);

            // Reassign sequential positions
            App.state.dashboardCharts.forEach((c, i) => { c.position = i; });

            // Re-render and persist
            renderDashboardGrid();
            saveDashboardToBackend();
        });
    });
}

// ============================================================
// Dashboard: Remove, Download, Clear
// ============================================================
async function removeDashChart(chartId) {
    try {
        const resp = await fetch(`${App.API_BASE}/api/dashboard/remove/${chartId}`, { method: "DELETE" });
        const data = await resp.json();
        if (data.success) {
            refreshDashboard();
        } else {
            alert("Failed to remove chart: " + (data.error || "Unknown error"));
        }
    } catch (e) {
        alert("Error removing chart.");
        console.error(e);
    }
}

function downloadDashChart(plotId) {
    const el = document.getElementById(plotId);
    if (el) {
        Plotly.downloadImage(el, {
            format: "png",
            width: 1200,
            height: 600,
            filename: "data-talk-dashboard-chart",
        });
    }
}

async function clearAllCharts() {
    if (!confirm("Remove all charts from the dashboard?")) return;
    try {
        await fetch(`${App.API_BASE}/api/dashboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ charts: [] }),
        });
        refreshDashboard();
    } catch (e) {
        alert("Error clearing dashboard.");
        console.error(e);
    }
}
