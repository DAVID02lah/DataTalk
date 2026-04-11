// GridStack initialization, layout persistence, and resize sweep.

let dashboardGrid = null;
let dashboardLayoutSaveDebounce = null;
let dashboardResizeDebounce = null;

function removeAllDashboardWidgets() {
    if (!dashboardGrid) return;
    try {
        dashboardGrid.removeAll(true);
    } catch (e) {
        console.warn('Failed to fully remove dashboard widgets:', e);
    }
}

function resizePlotlyElement(plotEl) {
    if (!plotEl || typeof Plotly === 'undefined' || !plotEl.data) return;
    try {
        Plotly.Plots.resize(plotEl);
    } catch (e) {
        console.warn('Failed to resize Plotly chart:', e);
    }
}

function schedulePlotlyStabilizeResize(plotEl, delays = [120, 260, 450, 700]) {
    delays.forEach((delay) => {
        setTimeout(() => {
            if (!plotEl || !plotEl.isConnected) return;
            const parent = plotEl.parentElement;
            if (!parent || parent.clientWidth <= 0 || parent.clientHeight <= 0) return;
            resizePlotlyElement(plotEl);
        }, delay);
    });
}

function scheduleDashboardResizeSweep(delays = [140, 320, 620]) {
    delays.forEach((delay) => {
        setTimeout(() => {
            if (!dashboardGrid) return;
            const gridItems = dashboardGrid.getGridItems();
            gridItems.forEach(item => {
                const plotEls = item.querySelectorAll('.js-plotly-plot');
                plotEls.forEach(resizePlotlyElement);
            });
        }, delay);
    });
}

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
            column: 12,
            cellHeight: 60,
            margin: 8,
            float: true,
            animate: true,
            removable: false,
            maxRow: 12,
            draggable: {
                handle: '.widget-header',
                cancel: '.widget-btn, .widget-btn *, .ui-resizable-handle',
                scroll: false,
            },
            resizable: {
                handles: 'e, se, s, sw, w'
            },
            acceptWidgets: false,
            disableOneColumnMode: true,
        }, gridEl);

        dashboardGrid.on('change', () => {
            clearTimeout(dashboardLayoutSaveDebounce);
            dashboardLayoutSaveDebounce = setTimeout(() => {
                saveDashboardLayoutFromGrid();
            }, 500);
        });

        dashboardGrid.on('resizestop', (event, el) => {
            clearTimeout(dashboardResizeDebounce);
            dashboardResizeDebounce = setTimeout(() => {
                const plotEls = el.querySelectorAll('.js-plotly-plot');
                plotEls.forEach(resizePlotlyElement);
            }, 200);
        });

        return dashboardGrid;
    } catch (e) {
        console.error('Failed to initialize GridStack:', e);
        return null;
    }
}

// --- Render ---

function renderDashboardGrid() {
    if (!App.state.dashboardLoaded) return;

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

    if (countBadge) countBadge.textContent = `${totalWidgets} widget${totalWidgets !== 1 ? "s" : ""}`;

    if (totalWidgets === 0) {
        if (emptyEl) emptyEl.classList.remove("hidden");
        removeAllDashboardWidgets();
        return;
    }
    if (emptyEl) emptyEl.classList.add("hidden");

    removeAllDashboardWidgets();

    const sorted = [...charts].sort((a, b) => (a.position || 0) - (b.position || 0));

    sorted.forEach((chart, index) => {
        if (!chart || !chart.id) return;
        const widgetId = `widget-dash-${chart.id}`;
        const layoutOverrides = chartLayoutFromGridPos(index, chart.gridPos || {});
        addDashboardChartWidget(chart, widgetId, layoutOverrides);
    });

    cards.forEach((card, index) => {
        if (!card || !card.id) return;
        const widgetId = `widget-card-${card.id}`;
        const layoutOverrides = cardLayoutFromGridPos(index, charts.length, card.gridPos || {});
        addDashboardCardWidget(card, widgetId, layoutOverrides);
    });

    scheduleDashboardResizeSweep();
}

// --- Layout persistence ---

function saveDashboardLayoutFromGrid() {
    if (!dashboardGrid) return;

    try {
        const gridItems = dashboardGrid.save(false);
        if (!gridItems || !Array.isArray(gridItems)) return;

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

        saveDashboardToBackend();
    } catch (e) {
        console.error('Failed to save dashboard layout:', e);
    }
}

async function saveDashboardToBackend() {
    try {
        await persistDashboardState();
    } catch (e) {
        console.error("Failed to save dashboard:", e);
    }
}

// --- Tab-switch resize ---

function resizeDashboardOnActivate() {
    if (!dashboardGrid) return;

    setTimeout(() => {
        const gridItems = dashboardGrid.getGridItems();
        if (gridItems && gridItems.length > 0) {
            gridItems.forEach(item => {
                const plotEls = item.querySelectorAll('.js-plotly-plot');
                plotEls.forEach(resizePlotlyElement);
            });
        }
    }, 200);

    scheduleDashboardResizeSweep([320, 620]);
}
