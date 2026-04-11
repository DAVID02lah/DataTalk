// Chart customizer panel — live editing of Plotly chart properties.

let activeCustomizerChartId = null;

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
                    <input type="color" value="${color}" data-trace-index="${i}">
                    <span>${escapeHtml(name)}</span>
                </div>
            `;
        }).join('');

        colorDiv.querySelectorAll('input[type="color"]').forEach((inputEl) => {
            const traceIndex = Number(inputEl.dataset.traceIndex || "0");
            inputEl.addEventListener("input", () => applyTraceColor(traceIndex, inputEl.value));
            inputEl.addEventListener("change", () => applyTraceColor(traceIndex, inputEl.value));
        });
    }
}

function getTraceColor(trace) {
    const color = trace.marker?.color || trace.line?.color || '#4285f4';
    if (Array.isArray(color)) return color[0] || '#4285f4';
    if (typeof color === 'string' && color.startsWith('#')) return color;
    if (typeof color === 'string' && color.startsWith('rgb')) {
        return '#4285f4';
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
        const trace = plotEl.data?.[traceIndex] || {};

        if (!trace.marker) {
            trace.marker = {};
        }

        if (Array.isArray(trace.marker.color)) {
            trace.marker.color = trace.marker.color.map(() => color);
        } else {
            trace.marker.color = color;
        }

        if (trace.line) {
            trace.line.color = color;
        }
        if (trace.fillcolor) {
            trace.fillcolor = color;
        }

        Plotly.redraw(plotEl);
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
