// Widget customizer panel — live editing of chart and widget visual properties.

let activeCustomizerChartId = null;
let activeCustomizerWidgetId = null;

// --- Entry Point ---

function openWidgetCustomizer(widgetId) {
    activeCustomizerWidgetId = widgetId;
    const panel = document.getElementById('chart-customizer');
    if (!panel) return;

    const isChart = widgetId.startsWith('widget-dash-');

    updateCustomizerHeading(isChart);
    setChartSectionsVisible(isChart);

    if (isChart) {
        activeCustomizerChartId = widgetId.replace('widget-dash-', '');
        populateChartFields();
    } else {
        activeCustomizerChartId = null;
        populateWidgetTitle();
    }
    panel.classList.add('visible');
}

function closeChartCustomizer() {
    const panel = document.getElementById('chart-customizer');
    if (panel) panel.classList.remove('visible');
    activeCustomizerChartId = null;
    activeCustomizerWidgetId = null;
}

// --- Panel Setup ---

function updateCustomizerHeading(isChart) {
    const heading = document.querySelector('#chart-customizer .customizer-header h3');
    if (heading) heading.textContent = isChart ? 'Customise Chart' : 'Customise Card';
}

function setChartSectionsVisible(visible) {
    document.querySelectorAll('[data-chart-only]').forEach(el => {
        el.style.display = visible ? '' : 'none';
    });
}

// --- Field Population ---

function populateWidgetTitle() {
    const titleInput = document.getElementById('custom-title');
    if (!titleInput) return;
    const stateItem = findWidgetStateItem(activeCustomizerWidgetId);
    titleInput.value = stateItem?.title || '';
}

function populateChartFields() {
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    if (!plotEl || !plotEl.data) {
        console.warn('No plot data for customizer');
        return;
    }

    const layout = plotEl.layout || {};

    const titleInput = document.getElementById('custom-title');
    const xaxisInput = document.getElementById('custom-xaxis');
    const yaxisInput = document.getElementById('custom-yaxis');
    const scaleSelect = document.getElementById('custom-scale');

    if (titleInput) titleInput.value = (typeof layout.title === 'object' ? layout.title.text : layout.title) || '';
    if (xaxisInput) xaxisInput.value = layout.xaxis?.title?.text || layout.xaxis?.title || '';
    if (yaxisInput) yaxisInput.value = layout.yaxis?.title?.text || layout.yaxis?.title || '';
    if (scaleSelect) scaleSelect.value = layout.yaxis?.type || 'linear';

    populateTraceColorPickers(plotEl);
}

function populateTraceColorPickers(plotEl) {
    const colorDiv = document.getElementById('custom-color-pickers');
    if (!colorDiv || !plotEl.data) return;

    colorDiv.innerHTML = plotEl.data.map((trace, i) => {
        const color = getTraceColor(trace);
        const name = trace.name || `Trace ${i + 1}`;
        return `
            <div class="color-picker-row">
                <input type="color" value="${color}" data-trace-index="${i}">
                <input type="text" class="trace-name-input" value="${escapeHtml(name)}" data-trace-index="${i}" placeholder="Trace name">
            </div>
        `;
    }).join('');

    colorDiv.querySelectorAll('input[type="color"]').forEach(inputEl => {
        const i = Number(inputEl.dataset.traceIndex || "0");
        inputEl.addEventListener("input", () => applyTraceColor(i, inputEl.value));
        inputEl.addEventListener("change", () => applyTraceColor(i, inputEl.value));
    });

    colorDiv.querySelectorAll('input.trace-name-input').forEach(inputEl => {
        const i = Number(inputEl.dataset.traceIndex || "0");
        inputEl.addEventListener("input", () => applyTraceName(i, inputEl.value));
        inputEl.addEventListener("change", () => applyTraceName(i, inputEl.value));
    });
}

// --- Live Apply ---

function getTraceColor(trace) {
    const color = trace.marker?.color || trace.line?.color || '#4285f4';
    if (Array.isArray(color)) return color[0] || '#4285f4';
    if (typeof color === 'string' && color.startsWith('#')) return color;
    return '#4285f4';
}

function applyCustomTitle() {
    const titleInput = document.getElementById('custom-title');
    if (!titleInput) return;

    // Charts also have a Plotly title that needs syncing
    if (activeCustomizerChartId) {
        const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
        if (plotEl && typeof Plotly !== 'undefined') {
            try {
                Plotly.relayout(plotEl, { 'title.text': titleInput.value });
            } catch (e) {
                console.error('Failed to update title:', e);
            }
        }
    }

    // Header title input must stay in sync so the user sees the change outside the panel
    if (activeCustomizerWidgetId) {
        const headerEl = document.querySelector(
            `.widget-header[data-widget-id="${activeCustomizerWidgetId}"] .widget-title`
        );
        if (headerEl) headerEl.value = titleInput.value;
    }
}

function applyTraceColor(traceIndex, color) {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    if (!plotEl || typeof Plotly === 'undefined') return;

    try {
        const trace = plotEl.data?.[traceIndex] || {};
        if (!trace.marker) trace.marker = {};

        if (Array.isArray(trace.marker.color)) {
            trace.marker.color = trace.marker.color.map(() => color);
        } else {
            trace.marker.color = color;
        }

        if (trace.line) trace.line.color = color;
        if (trace.fillcolor) trace.fillcolor = color;

        Plotly.redraw(plotEl);
    } catch (e) {
        console.error('Failed to update color:', e);
    }
}

function applyTraceName(traceIndex, newName) {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    if (!plotEl || typeof Plotly === 'undefined') return;

    try {
        const trace = plotEl.data?.[traceIndex];
        if (trace) {
            trace.name = newName;
            Plotly.redraw(plotEl);
        }
    } catch (e) {
        console.error('Failed to update trace name:', e);
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
    if (!plotEl || typeof Plotly === 'undefined') return;

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

// --- Save ---

async function saveCustomizedChart() {
    if (!activeCustomizerWidgetId) return;

    const stateItem = findWidgetStateItem(activeCustomizerWidgetId);
    if (!stateItem) return;

    const saveBtn = document.getElementById('save-customizer-btn');

    try {
        showSaveButtonState(saveBtn, 'saving');

        // Plotly stores chart data in the DOM — snapshot it to persist across sessions
        if (activeCustomizerChartId) {
            saveChartPlotlyState(stateItem);
        }

        // Widget header title and state must stay in sync for persistence
        const titleVal = document.getElementById('custom-title')?.value;
        if (titleVal !== undefined) {
            stateItem.title = titleVal;
            const widgetTitleEl = document.querySelector(
                `.widget-header[data-widget-id="${activeCustomizerWidgetId}"] .widget-title`
            );
            if (widgetTitleEl) widgetTitleEl.value = titleVal;
        }

        await saveDashboardToBackend();
        showSaveButtonState(saveBtn, 'success');

        // Brief pause so user sees confirmation before panel closes
        setTimeout(() => closeChartCustomizer(), 800);
    } catch (e) {
        console.error('Error saving customisations:', e);
        showSaveButtonState(saveBtn, 'error');
    }
}

function showSaveButtonState(btn, state) {
    if (!btn) return;

    const labels = { saving: 'Saving...', success: '✓ Saved!', error: '✗ Save Failed' };
    btn.textContent = labels[state] || 'Save Changes';
    btn.disabled = state === 'saving';

    // Reset button after error so user can retry
    if (state === 'error') {
        setTimeout(() => {
            btn.textContent = 'Save Changes';
            btn.disabled = false;
        }, 2000);
    }
}

function saveChartPlotlyState(stateItem) {
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    if (!plotEl || !plotEl.data || !plotEl.layout) return;

    if (!stateItem.chart) stateItem.chart = {};

    // Hard clone to prevent circular JSON references
    stateItem.chart.data = JSON.parse(JSON.stringify(plotEl.data));
    stateItem.chart.layout = JSON.parse(JSON.stringify(plotEl.layout));
}
