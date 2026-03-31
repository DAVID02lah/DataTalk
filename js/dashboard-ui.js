// ============================================================
// Dashboard Pinning
// ============================================================

async function pinChart(chartId, title) {
    const chartDiv = document.getElementById(chartId);
    if (!chartDiv) return;

    // Get the plotly data from the rendered chart
    const plotlyData = chartDiv.data;
    const plotlyLayout = chartDiv.layout;

    if (!plotlyData) {
        appendErrorMessage("Could not read chart data to pin.");
        return;
    }

    try {
        const response = await fetch(`${App.API_BASE}/api/dashboard/pin`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
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
            appendErrorMessage("Failed to pin chart: " + (result.error || "Unknown error"));
        }
    } catch (error) {
        appendErrorMessage("Error pinning chart. Is the backend running?");
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
        width: null,
        margin: { l: 60, r: 40, t: 60, b: 60 },
    };

    setTimeout(() => {
        Plotly.newPlot("fullscreen-chart", sourceChart.data, layout, {
            responsive: true,
            displayModeBar: true,
        });

        // Focus management: focus the close button when opened
        const closeBtn = overlay.querySelector('.close-fullscreen');
        if (closeBtn) closeBtn.focus();
    }, CONFIG.PLOTLY_RENDER_TIMEOUT);
}

function closeFullscreenChart() {
    const overlay = document.getElementById("chart-fullscreen-overlay");
    overlay.classList.remove("visible");
    Plotly.purge("fullscreen-chart");

    // Return focus to the original active element if we stored it, or just body
    document.body.focus();
}

function closeFullscreen(event) {
    // Close when clicking the overlay background (not the chart container)
    if (event.target === event.currentTarget) {
        closeFullscreenChart();
    }
}

// Global Keyboard Accessibility for Modals
document.addEventListener('keydown', function (event) {
    const overlay = document.getElementById("chart-fullscreen-overlay");
    if (!overlay || !overlay.classList.contains("visible")) return;

    if (event.key === "Escape") {
        closeFullscreenChart();
        return;
    }

    if (event.key === "Tab") {
        const focusableElements = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');

        // Plotly might inject elements, so we query dynamically
        const firstFocusableElement = focusableElements[0];
        const lastFocusableElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey) { /* shift + tab */
            if (document.activeElement === firstFocusableElement) {
                lastFocusableElement.focus();
                event.preventDefault();
            }
        } else { /* tab */
            if (document.activeElement === lastFocusableElement) {
                firstFocusableElement.focus();
                event.preventDefault();
            }
        }
    }
});

// ============================================================
// GridStack-Based Dashboard (replaces old CSS grid)
// ============================================================

let dashboardGrid = null;              // GridStack instance
let dashboardLayoutSaveDebounce = null; // Debounce layout saves
let dashboardResizeDebounce = null;     // Debounce Plotly resize
let activeCustomizerChartId = null;     // Currently customizing chart

/**
 * Initialize the GridStack instance for the pinned-chart dashboard.
 */
function initDashboardGridStack() {
    if (dashboardGrid) return dashboardGrid;

    const gridEl = document.getElementById('dashboard-grid-stack');
    if (!gridEl) {
        console.error('GridStack container #dashboard-grid-stack not found');
        return null;
    }

    try {
        dashboardGrid = GridStack.init({
            column: 12,              // 12-column grid (Power BI standard)
            cellHeight: 60,          // Each row = 60px
            margin: 8,              // Gap between widgets
            float: true,             // Allow items anywhere
            animate: true,           // Smooth transitions
            removable: false,        // Don't allow drag-out removal
            maxRow: 12,              // Cap at 12 rows (720px)
            resizable: {
                handles: 'e, se, s, sw, w'  // Resize from edges
            },
            acceptWidgets: false,
            disableOneColumnMode: true,
        }, gridEl);

        // When user finishes dragging/resizing, save layout (debounced)
        dashboardGrid.on('change', () => {
            clearTimeout(dashboardLayoutSaveDebounce);
            dashboardLayoutSaveDebounce = setTimeout(() => {
                saveDashboardLayoutFromGrid();
            }, 500);
        });

        // Handle resize to update Plotly charts
        dashboardGrid.on('resizestop', (event, el) => {
            clearTimeout(dashboardResizeDebounce);
            dashboardResizeDebounce = setTimeout(() => {
                const plotEls = el.querySelectorAll('.js-plotly-plot');
                plotEls.forEach(plotEl => {
                    if (plotEl && typeof Plotly !== 'undefined' && plotEl.data) {
                        try {
                            Plotly.Plots.resize(plotEl);
                        } catch (e) {
                            console.warn('Failed to resize Plotly chart:', e);
                        }
                    }
                });
            }, 200);
        });

        return dashboardGrid;
    } catch (e) {
        console.error('Failed to initialize GridStack:', e);
        return null;
    }
}

// ============================================================
// Fetch & Render Dashboard
// ============================================================

async function refreshDashboard() {
    try {
        const response = await fetch(`${App.API_BASE}/api/dashboard`, {
            headers: App.getAuthHeaders()
        });
        const data = await response.json();
        App.state.dashboardCharts = data.charts || [];
        App.state.dashboardCards = data.cards || [];
        App.state.dashboardLoaded = true;
        renderDashboardGrid();
    } catch (e) {
        console.error("Failed to load dashboard:", e);
        App.state.dashboardCharts = [];
        App.state.dashboardCards = [];
        App.state.dashboardLoaded = true;
        renderDashboardGrid();
    }
}

function renderDashboardGrid() {
    if (!App.state.dashboardLoaded) return;

    // Initialize GridStack if not already done
    if (!dashboardGrid) {
        if (!initDashboardGridStack()) {
            console.error('Cannot render dashboard: grid not initialized');
            return;
        }
    }

    const emptyEl = document.getElementById("dashboard-empty");
    const countBadge = document.getElementById("dashboard-chart-count");
    const charts = App.state.dashboardCharts || [];
    const cards = App.state.dashboardCards || [];
    const totalWidgets = charts.length + cards.length;

    // Update count
    if (countBadge) countBadge.textContent = `${totalWidgets} widget${totalWidgets !== 1 ? "s" : ""}`;

    // Empty state
    if (totalWidgets === 0) {
        if (emptyEl) emptyEl.classList.remove("hidden");
        try { dashboardGrid.removeAll(false); } catch (e) { }
        return;
    }
    if (emptyEl) emptyEl.classList.add("hidden");

    // Clear existing widgets safely
    try {
        dashboardGrid.removeAll(false);
    } catch (e) {
        console.warn('Failed to clear grid:', e);
    }

    // Sort by position
    const sorted = [...charts].sort((a, b) => (a.position || 0) - (b.position || 0));

    // Add each chart as a widget
    sorted.forEach((chart, index) => {
        if (!chart || !chart.id) return;

        const widgetId = `widget-dash-${chart.id}`;

        // Use saved grid position if available, otherwise auto-layout
        const gridPos = chart.gridPos || {};
        const layoutOverrides = {
            x: gridPos.x ?? (index % 2) * 6,
            y: gridPos.y ?? Math.floor(index / 2) * 6,
            w: gridPos.w ?? 6,
            h: gridPos.h ?? 6,
        };

        addDashboardChartWidget(chart, widgetId, layoutOverrides);
    });

    // Add card widgets
    cards.forEach((card, index) => {
        if (!card || !card.id) return;

        const widgetId = `widget-card-${card.id}`;
        const gridPos = card.gridPos || {};
        const layoutOverrides = {
            x: gridPos.x ?? (index % 4) * 3,
            y: gridPos.y ?? Math.floor(index / 4) * 2 + (charts.length > 0 ? 10 : 0),
            w: gridPos.w ?? 3,
            h: gridPos.h ?? 2,
        };

        addDashboardCardWidget(card, widgetId, layoutOverrides);
    });
}

/**
 * Add a single pinned chart as a GridStack widget.
 */
function addDashboardChartWidget(chartData, widgetId, layoutOverrides) {
    if (!dashboardGrid || !chartData) return;

    const chartId = chartData.id;
    const title = chartData.title || 'Untitled Chart';
    const plotId = `dash-plot-${chartId}`;
    const hasChart = chartData.chart && chartData.chart.data;

    const contentHtml = `
        <div class="widget-header" data-widget-id="${widgetId}">
            <span class="widget-title">${escapeHtml(title)}</span>
            <div class="widget-actions">
                <button class="widget-btn" onclick="openChartCustomizer('${chartId}')" title="Customize">⚙️</button>
                <button class="widget-btn" onclick="openFullscreenChart('${plotId}')" title="Fullscreen">🔍</button>
                <button class="widget-btn" onclick="downloadDashChart('${plotId}')" title="Download PNG">📥</button>
                <button class="widget-btn widget-btn-danger" onclick="removeDashChart('${chartId}')" title="Remove">×</button>
            </div>
        </div>
        <div class="widget-body" id="body-${chartId}">
            ${hasChart
            ? `<div id="${plotId}" class="chart-container"></div>`
            : `<div class="widget-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">No chart data</div>`
        }
        </div>
    `;

    try {
        dashboardGrid.addWidget({
            x: layoutOverrides.x,
            y: layoutOverrides.y,
            w: layoutOverrides.w,
            h: layoutOverrides.h,
            id: widgetId,
            content: contentHtml,
        });
    } catch (e) {
        console.error('Failed to add dashboard widget:', e);
        return;
    }

    // Mount Plotly after DOM insertion
    if (hasChart) {
        requestAnimationFrame(() => {
            const plotEl = document.getElementById(plotId);
            if (plotEl && typeof Plotly !== 'undefined') {
                try {
                    mountPlotlyChart(plotId, chartData.chart);
                } catch (e) {
                    console.error('Failed to mount Plotly chart:', e);
                    plotEl.innerHTML = '<div style="color: #ea4335; padding: 20px;">Error rendering chart</div>';
                }
            }
        });
    }
}

/**
 * mountPlotlyChart — renders Plotly JSON into a DOM element.
 * (Shared utility for dashboard widgets)
 */
function mountPlotlyChart(chartElementId, chartJson) {
    if (!chartElementId || !chartJson) return;
    setTimeout(() => {
        try {
            const layout = {
                ...(chartJson.layout || {}),
                template: "plotly_white",
                font: { family: "Inter, sans-serif" },
                autosize: true,
                width: undefined,
                height: undefined,
                title: "",
                margin: { l: 50, r: 30, t: 30, b: 50 },
            };
            Plotly.newPlot(chartElementId, chartJson.data, layout, {
                responsive: true,
                displayModeBar: true,
                modeBarButtonsToRemove: ["lasso2d", "select2d"],
            });
        } catch (e) {
            console.error("Plotly render error:", e);
            const el = document.getElementById(chartElementId);
            if (el) el.innerHTML = '<p style="color: #ea4335;">Error rendering chart</p>';
        }
    }, CONFIG.PLOTLY_RENDER_TIMEOUT);
}

// ============================================================
// Layout Persistence (save GridStack positions to backend)
// ============================================================

function saveDashboardLayoutFromGrid() {
    if (!dashboardGrid) return;

    try {
        const gridItems = dashboardGrid.save(false);
        if (!gridItems || !Array.isArray(gridItems)) return;

        // Update positions for both charts and cards
        gridItems.forEach(item => {
            if (!item || !item.id) return;
            const pos = { x: item.x, y: item.y, w: item.w, h: item.h };

            if (item.id.startsWith('widget-dash-')) {
                const chartId = item.id.replace('widget-dash-', '');
                const chart = (App.state.dashboardCharts || []).find(c => c.id === chartId);
                if (chart) chart.gridPos = pos;
            } else if (item.id.startsWith('widget-card-')) {
                const cardId = item.id.replace('widget-card-', '');
                const card = (App.state.dashboardCards || []).find(c => c.id === cardId);
                if (card) card.gridPos = pos;
            }
        });

        // Persist to backend
        saveDashboardToBackend();
    } catch (e) {
        console.error('Failed to save dashboard layout:', e);
    }
}

async function saveDashboardToBackend() {
    try {
        await fetch(`${App.API_BASE}/api/dashboard`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                charts: App.state.dashboardCharts || [],
                cards: App.state.dashboardCards || [],
            }),
        });
    } catch (e) {
        console.error("Failed to save dashboard:", e);
    }
}

// ============================================================
// Resize all dashboard charts (called on tab switch)
// ============================================================

function resizeDashboardOnActivate() {
    if (!dashboardGrid) return;

    // Give GridStack time to become visible and settle
    setTimeout(() => {
        const gridItems = dashboardGrid.getGridItems();
        if (gridItems && gridItems.length > 0) {
            gridItems.forEach(item => {
                const plotEls = item.querySelectorAll('.js-plotly-plot');
                plotEls.forEach(plotEl => {
                    if (plotEl && plotEl.data && typeof Plotly !== 'undefined') {
                        try {
                            Plotly.Plots.resize(plotEl);
                        } catch (e) {
                            console.warn('Failed to resize chart on tab switch:', e);
                        }
                    }
                });
            });
        }
    }, 200);
}

// ============================================================
// Dashboard: Remove, Download, Clear
// ============================================================

async function removeDashChart(chartId) {
    try {
        const resp = await fetch(`${App.API_BASE}/api/dashboard/remove/${chartId}`, {
            method: "DELETE",
            headers: App.getAuthHeaders()
        });
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
    if (!confirm("Remove all widgets from the dashboard?")) return;
    try {
        await fetch(`${App.API_BASE}/api/dashboard`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ charts: [], cards: [] }),
        });
        refreshDashboard();
    } catch (e) {
        alert("Error clearing dashboard.");
        console.error(e);
    }
}

/**
 * Clear dashboard widgets from the UI (called by clearChatHistory).
 */
function clearDashboard() {
    App.state.dashboardCharts = [];
    App.state.dashboardCards = [];
    App.state.dashboardLoaded = false;
    if (dashboardGrid) {
        try { dashboardGrid.removeAll(false); } catch (e) { }
    }
    const emptyEl = document.getElementById("dashboard-empty");
    if (emptyEl) emptyEl.classList.remove("hidden");
    const countBadge = document.getElementById("dashboard-chart-count");
    if (countBadge) countBadge.textContent = "0 widgets";
}

// ============================================================
// Chart Customizer Panel
// ============================================================

function openChartCustomizer(chartId) {
    activeCustomizerChartId = chartId;
    const panel = document.getElementById('chart-customizer');
    if (!panel) return;

    panel.classList.add('visible');

    const plotEl = document.getElementById(`dash-plot-${chartId}`);
    if (!plotEl || !plotEl.data) {
        console.warn('No plot data for customizer');
        return;
    }

    // Populate current values
    const layout = plotEl.layout || {};

    const titleInput = document.getElementById('custom-title');
    const xaxisInput = document.getElementById('custom-xaxis');
    const yaxisInput = document.getElementById('custom-yaxis');
    const scaleSelect = document.getElementById('custom-scale');

    if (titleInput) {
        titleInput.value = (typeof layout.title === 'object' ? layout.title.text : layout.title) || '';
    }
    if (xaxisInput) {
        xaxisInput.value = layout.xaxis?.title?.text || layout.xaxis?.title || '';
    }
    if (yaxisInput) {
        yaxisInput.value = layout.yaxis?.title?.text || layout.yaxis?.title || '';
    }
    if (scaleSelect) {
        scaleSelect.value = layout.yaxis?.type || 'linear';
    }

    // Generate color pickers for each trace
    const colorDiv = document.getElementById('custom-color-pickers');
    if (colorDiv && plotEl.data) {
        colorDiv.innerHTML = plotEl.data.map((trace, i) => {
            const color = getTraceColor(trace);
            const name = trace.name || `Trace ${i + 1}`;
            return `
                <div class="color-picker-row">
                    <input type="color" value="${color}" onchange="applyTraceColor(${i}, this.value)">
                    <span>${escapeHtml(name)}</span>
                </div>
            `;
        }).join('');
    }
}

function getTraceColor(trace) {
    const color = trace.marker?.color || trace.line?.color || '#4285f4';
    if (Array.isArray(color)) return color[0] || '#4285f4';
    if (typeof color === 'string' && color.startsWith('#')) return color;
    if (typeof color === 'string' && color.startsWith('rgb')) {
        return '#4285f4'; // Default if can't parse
    }
    return '#4285f4';
}

function closeChartCustomizer() {
    const panel = document.getElementById('chart-customizer');
    if (panel) panel.classList.remove('visible');
    activeCustomizerChartId = null;
}

function applyCustomTitle() {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    const titleInput = document.getElementById('custom-title');
    if (!plotEl || !titleInput || typeof Plotly === 'undefined') return;

    try {
        Plotly.relayout(plotEl, { 'title.text': titleInput.value });
    } catch (e) {
        console.error('Failed to update title:', e);
    }
}

function applyTraceColor(traceIndex, color) {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    if (!plotEl || typeof Plotly === 'undefined') return;

    try {
        Plotly.restyle(plotEl, { 'marker.color': color, 'line.color': color }, [traceIndex]);
    } catch (e) {
        console.error('Failed to update color:', e);
    }
}

function applyCustomAxis(axis) {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    const input = document.getElementById(`custom-${axis}axis`);
    if (!plotEl || !input || typeof Plotly === 'undefined') return;

    try {
        Plotly.relayout(plotEl, { [`${axis}axis.title.text`]: input.value });
    } catch (e) {
        console.error('Failed to update axis:', e);
    }
}

function applyCustomScale() {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    const select = document.getElementById('custom-scale');
    if (!plotEl || !select || typeof Plotly === 'undefined') return;

    try {
        Plotly.relayout(plotEl, { 'yaxis.type': select.value });
    } catch (e) {
        console.error('Failed to update scale:', e);
    }
}

function applyCustomLegend() {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    const select = document.getElementById('custom-legend');
    if (!plotEl || !select || typeof Plotly === 'undefined') return;

    const pos = select.value;
    const legendConfig = {
        right: { showlegend: true, 'legend.orientation': 'v', 'legend.x': 1.02, 'legend.y': 1 },
        bottom: { showlegend: true, 'legend.orientation': 'h', 'legend.x': 0.5, 'legend.y': -0.15, 'legend.xanchor': 'center' },
        top: { showlegend: true, 'legend.orientation': 'h', 'legend.x': 0.5, 'legend.y': 1.1, 'legend.xanchor': 'center' },
        none: { showlegend: false },
    };

    try {
        Plotly.relayout(plotEl, legendConfig[pos] || {});
    } catch (e) {
        console.error('Failed to update legend:', e);
    }
}

// ============================================================
// KPI Card Widget
// ============================================================

/**
 * Add a single KPI card as a GridStack widget.
 */
function addDashboardCardWidget(cardData, widgetId, layoutOverrides) {
    if (!dashboardGrid || !cardData) return;

    const cardId = cardData.id;

    // Format the value
    let formattedValue = '—';
    if (cardData.value !== null && cardData.value !== undefined) {
        if (typeof cardData.value === 'number') {
            formattedValue = cardData.value.toLocaleString(undefined, { maximumFractionDigits: 2 });
        } else {
            formattedValue = String(cardData.value);
        }
    }

    const aggLabel = (cardData.aggregation || 'count').charAt(0).toUpperCase() + (cardData.aggregation || 'count').slice(1);
    const title = cardData.title || `${aggLabel} of ${cardData.column || 'Unknown'}`;

    const contentHtml = `
        <div class="widget-header" data-widget-id="${widgetId}">
            <span class="widget-title">${escapeHtml(title)}</span>
            <div class="widget-actions">
                <button class="widget-btn widget-btn-danger" onclick="removeDashCard('${cardId}')" title="Remove">×</button>
            </div>
        </div>
        <div class="widget-body kpi-card-body" id="card-body-${cardId}">
            <div class="kpi-value">${escapeHtml(formattedValue)}</div>
            <div class="kpi-label">${escapeHtml(aggLabel)} of ${escapeHtml(cardData.column || '')}</div>
        </div>
    `;

    try {
        dashboardGrid.addWidget({
            x: layoutOverrides.x,
            y: layoutOverrides.y,
            w: layoutOverrides.w,
            h: layoutOverrides.h,
            id: widgetId,
            content: contentHtml,
        });
    } catch (e) {
        console.error('Failed to add card widget:', e);
    }
}

async function removeDashCard(cardId) {
    if (!App.state.dashboardCards) return;
    App.state.dashboardCards = App.state.dashboardCards.filter(c => c.id !== cardId);
    await saveDashboardToBackend();
    renderDashboardGrid();
}

// ============================================================
// Add Card Modal
// ============================================================

async function showAddCardModal() {
    const modal = document.getElementById("add-card-modal");
    const titleInput = document.getElementById("card-title-input");
    const errorEl = document.getElementById("card-add-error");

    if (modal) modal.style.display = "flex";
    if (titleInput) titleInput.value = "";
    if (errorEl) errorEl.style.display = "none";

    // Populate column dropdown from active file schema
    const colSelect = document.getElementById("card-column-select");
    if (!colSelect) return;

    colSelect.innerHTML = '<option value="">Loading columns...</option>';

    try {
        let columns = [];

        if (App.state.activeFile && App.state.activeFile.summary && App.state.activeFile.summary.columns) {
            columns = App.state.activeFile.summary.columns;
        } else if (App.state.activeFile && App.state.activeFile.filename) {
            const response = await fetch(`${App.API_BASE}/api/data-summary/${encodeURIComponent(App.state.activeFile.filename)}`, {
                headers: App.getAuthHeaders()
            });

            if (response.ok) {
                const data = await response.json();
                columns = data.summary?.columns || [];
            }
        }

        if (columns.length > 0) {
            colSelect.innerHTML = '<option value="">Select a column...</option>' +
                columns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        } else {
            colSelect.innerHTML = '<option value="">No columns available — upload a dataset first</option>';
        }
    } catch (e) {
        console.error('Failed to load columns:', e);
        colSelect.innerHTML = '<option value="">Error loading columns</option>';
    }
}

function closeAddCardModal() {
    const modal = document.getElementById("add-card-modal");
    if (modal) modal.style.display = "none";
}

async function submitAddCard() {
    const colSelect = document.getElementById("card-column-select");
    const aggSelect = document.getElementById("card-agg-select");
    const titleInput = document.getElementById("card-title-input");
    const errEl = document.getElementById("card-add-error");
    const btn = document.getElementById("btn-submit-card");

    const column = colSelect ? colSelect.value : '';
    const aggregation = aggSelect ? aggSelect.value : 'count';
    const title = titleInput ? titleInput.value.trim() : '';

    if (!column) {
        if (errEl) {
            errEl.textContent = "Please select a column.";
            errEl.style.display = "block";
        }
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = "Adding...";
    }
    if (errEl) errEl.style.display = "none";

    try {
        // Fetch the computed value from the backend
        const response = await fetch(`${App.API_BASE}/api/dashboard/card-data`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ column, aggregation })
        });

        const data = await response.json();

        if (data.error) {
            if (errEl) {
                errEl.textContent = data.error;
                errEl.style.display = "block";
            }
            return;
        }

        // Build the card object
        const aggLabel = aggregation.charAt(0).toUpperCase() + aggregation.slice(1);
        const newCard = {
            id: `card_${Date.now()}`,
            column: column,
            aggregation: aggregation,
            title: title || `${aggLabel} of ${column}`,
            value: data.value,
        };

        // Add to state and persist
        if (!App.state.dashboardCards) App.state.dashboardCards = [];
        App.state.dashboardCards.push(newCard);
        await saveDashboardToBackend();

        closeAddCardModal();
        renderDashboardGrid();

    } catch (e) {
        console.error('Failed to add card:', e);
        if (errEl) {
            errEl.textContent = "Network error while connecting to server.";
            errEl.style.display = "block";
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = "Add Card";
        }
    }
}
