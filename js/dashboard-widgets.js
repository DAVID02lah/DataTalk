// Dashboard widget rendering — chart and KPI card widgets, remove/clear actions.

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
        <div class="widget-header retracted" data-widget-id="${widgetId}">
            <input class="widget-title" value="${escapeHtml(title)}" placeholder="" onchange="updateWidgetTitle('${widgetId}', this.value)" style="border:none; background:transparent; font-weight:inherit; color:inherit; font-size:inherit; font-family:inherit; outline:none; text-overflow:ellipsis; flex:1; min-width:50px;">
            <div class="widget-actions">
                <button class="widget-btn" onclick="toggleWidgetCollapse('${widgetId}')" title="Hold to Drag / Click to Collapse">↕</button>
                <button class="widget-btn" onclick="openWidgetCustomizer('${widgetId}')" title="Customise">✏️</button>
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

    let widgetEl = null;
    try {
        widgetEl = dashboardGrid.addWidget({
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

    if (hasChart) {
        requestAnimationFrame(() => {
            const plotEl = widgetEl
                ? widgetEl.querySelector(`#${plotId}`)
                : document.getElementById(plotId);
            if (plotEl && typeof Plotly !== 'undefined') {
                try {
                    mountPlotlyChart(plotId, chartData.chart, {
                        stripTitle: false,
                        layoutOverrides: {
                            width: undefined,
                            height: undefined,
                            margin: { l: 60, r: 30, t: 30, b: 60, autoexpand: true },
                            dragmode: false,
                            xaxis: { automargin: true },
                            yaxis: { automargin: true },
                        },
                        plotConfigOverrides: {
                            responsive: true,
                        },
                    });
                    schedulePlotlyStabilizeResize(plotEl);
                } catch (e) {
                    console.error('Failed to mount Plotly chart:', e);
                    plotEl.innerHTML = '<div style="color: #ea4335; padding: 20px;">Error rendering chart</div>';
                }
            }
        });
    }
}

/**
 * Add a single KPI card as a GridStack widget.
 */
function addDashboardCardWidget(cardData, widgetId, layoutOverrides) {
    if (!dashboardGrid || !cardData) return;

    const cardId = cardData.id;

    let formattedValue = '—';
    if (cardData.value !== null && cardData.value !== undefined) {
        if (typeof cardData.value === 'number') {
            formattedValue = cardData.value.toLocaleString(undefined, { maximumFractionDigits: 2 });
        } else {
            formattedValue = String(cardData.value);
        }
    }

    const aggLabel = formatAggregationLabel(cardData.aggregation || 'count');
    const title = cardData.title || `${aggLabel} of ${cardData.column || 'Unknown'}`;

    const contentHtml = `
        <div class="widget-header retracted" data-widget-id="${widgetId}">
            <input class="widget-title" value="${escapeHtml(title)}" placeholder="" onchange="updateWidgetTitle('${widgetId}', this.value)" style="border:none; background:transparent; font-weight:inherit; color:inherit; font-size:inherit; font-family:inherit; outline:none; text-overflow:ellipsis; flex:1; min-width:50px;">
            <div class="widget-actions">
                <button class="widget-btn" onclick="toggleWidgetCollapse('${widgetId}')" title="Hold to Drag / Click to Collapse">↕</button>
                <button class="widget-btn" onclick="openWidgetCustomizer('${widgetId}')" title="Customise">✏️</button>
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

// --- Remove / Clear ---

async function removeDashChart(chartId) {
    let confirmed = true;
    if (window.UIUtils && typeof window.UIUtils.confirm === "function") {
        confirmed = await window.UIUtils.confirm({
            title: "Remove chart",
            message: "This chart widget will be removed from the dashboard.",
            confirmText: "Remove",
            danger: true,
        });
    } else {
        showAppError("Confirmation dialog is unavailable right now. Please refresh and try again.");
        return;
    }
    if (!confirmed) return;

    try {
        const { response, data } = await fetchApiJson(withDashboardSession(`${App.API_BASE}/api/dashboard/remove/${chartId}`), {
            method: "DELETE",
            headers: App.getAuthHeaders()
        });
        assertApiSuccess(response, data, "Failed to remove chart.", { requireSuccessFlag: true });

        App.state.dashboardCharts = (App.state.dashboardCharts || []).filter((chart) => chart?.id !== chartId);
        App.state.dashboardLoaded = true;
        renderDashboardGrid();
    } catch (e) {
        showAppError(e.message || "Error removing chart.");
        console.error(e);
    }
}

async function removeDashCard(cardId) {
    if (!App.state.dashboardCards) return;
    App.state.dashboardCards = App.state.dashboardCards.filter(c => c.id !== cardId);
    await saveDashboardToBackend();
    renderDashboardGrid();
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
    let confirmed = true;
    if (window.UIUtils && typeof window.UIUtils.confirm === "function") {
        confirmed = await window.UIUtils.confirm({
            title: "Clear dashboard",
            message: "All chart and card widgets in this conversation dashboard will be removed.",
            confirmText: "Clear all",
            danger: true,
        });
    } else {
        showAppError("Confirmation dialog is unavailable right now. Please refresh and try again.");
        return;
    }
    if (!confirmed) return;

    try {
        await persistDashboardState([], []);
        App.state.dashboardCharts = [];
        App.state.dashboardCards = [];
        App.state.dashboardLoaded = true;
        renderDashboardGrid();
    } catch (e) {
        showAppError(e.message || "Error clearing dashboard.");
        console.error(e);
    }
}

function clearDashboard() {
    App.state.dashboardCharts = [];
    App.state.dashboardCards = [];
    App.state.dashboardLoaded = false;
    removeAllDashboardWidgets();
    const emptyEl = document.getElementById("dashboard-empty");
    if (emptyEl) emptyEl.classList.remove("hidden");
    const countBadge = document.getElementById("dashboard-chart-count");
    if (countBadge) countBadge.textContent = "0 widgets";
}

// --- Widget Mechanics ---

async function updateWidgetTitle(widgetId, newTitle) {
    const stateItem = findWidgetStateItem(widgetId);
    if (!stateItem) return;
    stateItem.title = newTitle;
    await saveDashboardToBackend();
}

function toggleWidgetCollapse(widgetId) {
    const header = document.querySelector(`.widget-header[data-widget-id="${widgetId}"]`);
    if (header) {
        header.classList.toggle('retracted');
        
        // Plotly needs a resize event to recalculate after the header expands
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 150);
    }
}

function findWidgetStateItem(widgetId) {
    if (widgetId.startsWith('widget-dash-')) {
        const id = widgetId.replace('widget-dash-', '');
        return (App.state.dashboardCharts || []).find(c => c.id === id);
    }
    if (widgetId.startsWith('widget-card-')) {
        const id = widgetId.replace('widget-card-', '');
        return (App.state.dashboardCards || []).find(c => c.id === id);
    }
    return null;
}

function findWidgetBodyElement(widgetId) {
    if (widgetId.startsWith('widget-dash-')) {
        const id = widgetId.replace('widget-dash-', '');
        return document.getElementById(`body-${id}`);
    }
    if (widgetId.startsWith('widget-card-')) {
        const id = widgetId.replace('widget-card-', '');
        return document.getElementById(`card-body-${id}`);
    }
    return null;
}
