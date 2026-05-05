// Widget customizer panel — live editing of chart and widget visual properties.

let activeCustomizerChartId = null;
let activeCustomizerWidgetId = null;

// Chart types that lack Cartesian axes (x/y labels are irrelevant)
const NON_CARTESIAN_TYPES = new Set([
    'pie', 'sunburst', 'treemap', 'funnelarea', 'sankey', 'indicator',
]);

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

/** Hide axis-related sections for non-Cartesian chart types (pie, sunburst, etc.) */
function setAxisSectionsVisible(visible) {
    document.querySelectorAll('[data-axis-only]').forEach(el => {
        el.style.display = visible ? '' : 'none';
    });
}

// --- Chart Type Detection ---

/** Returns the primary chart type string from the first trace, or 'scatter' as default. */
function detectChartType(plotEl) {
    const firstTrace = plotEl?.data?.[0];
    return (firstTrace?.type || 'scatter').toLowerCase();
}

/** True if the chart type uses Cartesian axes (bar, scatter, line, etc.). */
function isCartesianChart(chartType) {
    return !NON_CARTESIAN_TYPES.has(chartType);
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
    const chartType = detectChartType(plotEl);
    const cartesian = isCartesianChart(chartType);

    const titleInput = document.getElementById('custom-title');
    const xaxisInput = document.getElementById('custom-xaxis');
    const yaxisInput = document.getElementById('custom-yaxis');
    const scaleSelect = document.getElementById('custom-scale');

    if (titleInput) titleInput.value = (typeof layout.title === 'object' ? layout.title.text : layout.title) || '';

    // Only populate axis fields for Cartesian charts
    if (cartesian) {
        if (xaxisInput) xaxisInput.value = layout.xaxis?.title?.text || layout.xaxis?.title || '';
        if (yaxisInput) yaxisInput.value = layout.yaxis?.title?.text || layout.yaxis?.title || '';
        if (scaleSelect) scaleSelect.value = layout.yaxis?.type || 'linear';
    } else {
        if (xaxisInput) xaxisInput.value = '';
        if (yaxisInput) yaxisInput.value = '';
    }

    setAxisSectionsVisible(cartesian);
    populateTraceColorPickers(plotEl, chartType);
}

// --- Color Picker Logic ---

/**
 * Build color picker rows.
 * - Pie/donut: one picker per slice (reads from `marker.colors` array).
 * - Single-trace bar with color array: one picker per bar.
 * - Multi-trace: one picker per trace.
 */
function populateTraceColorPickers(plotEl, chartType) {
    const colorDiv = document.getElementById('custom-color-pickers');
    if (!colorDiv || !plotEl.data) return;

    colorDiv.innerHTML = '';

    if (isPieType(chartType)) {
        buildPieColorPickers(colorDiv, plotEl);
    } else if (hasSingleTraceWithColorArray(plotEl)) {
        buildPerBarColorPickers(colorDiv, plotEl);
    } else {
        buildPerTraceColorPickers(colorDiv, plotEl);
    }

    attachAddColorButton(colorDiv, plotEl, chartType);
}

function isPieType(chartType) {
    return chartType === 'pie' || chartType === 'funnelarea';
}

function hasSingleTraceWithColorArray(plotEl) {
    return plotEl.data.length === 1 && Array.isArray(plotEl.data[0]?.marker?.color);
}

// --- Pie / Donut Color Pickers (one per sector) ---

function buildPieColorPickers(container, plotEl) {
    const trace = plotEl.data[0];
    if (!trace) return;

    const labels = trace.labels || [];
    const colors = trace.marker?.colors || [];
    const defaultPalette = ['#4285f4', '#ea4335', '#fbbc05', '#34a853', '#ff6d01', '#46bdc6', '#7b1fa2', '#c2185b'];

    labels.forEach((label, i) => {
        const rawColor = colors[i] || defaultPalette[i % defaultPalette.length];
        const hex = toHexColor(rawColor);

        const row = createColorPickerRow(hex, String(label), i);
        container.appendChild(row);

        const colorInput = row.querySelector('input[type="color"]');
        colorInput.addEventListener('input', () => applyPieSectorColor(i, colorInput.value));
        colorInput.addEventListener('change', () => applyPieSectorColor(i, colorInput.value));
    });
}

// --- Single-Trace Multi-Bar Color Pickers (one per bar) ---

function buildPerBarColorPickers(container, plotEl) {
    const trace = plotEl.data[0];
    const colorArray = trace.marker?.color || [];
    const labels = trace.x || trace.y || [];
    const defaultPalette = ['#4285f4', '#ea4335', '#fbbc05', '#34a853', '#ff6d01', '#46bdc6', '#7b1fa2', '#c2185b'];

    colorArray.forEach((rawColor, i) => {
        const hex = toHexColor(rawColor || defaultPalette[i % defaultPalette.length]);
        const name = String(labels[i] ?? `Bar ${i + 1}`);

        const row = createColorPickerRow(hex, name, i);
        container.appendChild(row);

        const colorInput = row.querySelector('input[type="color"]');
        colorInput.addEventListener('input', () => applyBarElementColor(i, colorInput.value));
        colorInput.addEventListener('change', () => applyBarElementColor(i, colorInput.value));
    });
}

// --- Multi-Trace Color Pickers (one per trace — original behaviour) ---

function buildPerTraceColorPickers(container, plotEl) {
    plotEl.data.forEach((trace, i) => {
        const color = getTraceColor(trace);
        const name = trace.name || `Trace ${i + 1}`;

        const row = createColorPickerRow(color, name, i);
        container.appendChild(row);

        const colorInput = row.querySelector('input[type="color"]');
        const nameInput = row.querySelector('.trace-name-input');

        colorInput.addEventListener('input', () => applyTraceColor(i, colorInput.value));
        colorInput.addEventListener('change', () => applyTraceColor(i, colorInput.value));

        if (nameInput) {
            nameInput.addEventListener('input', () => applyTraceName(i, nameInput.value));
            nameInput.addEventListener('change', () => applyTraceName(i, nameInput.value));
        }
    });
}

// --- "Add Colour" Button ---

function attachAddColorButton(container, plotEl, chartType) {
    // Only useful for pie charts or single-trace color-array charts
    const isPie = isPieType(chartType);
    const isColorArray = hasSingleTraceWithColorArray(plotEl);
    if (!isPie && !isColorArray) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-add-colour';
    btn.textContent = '+ Add Colour';
    btn.addEventListener('click', () => onAddColour(plotEl, chartType));
    container.appendChild(btn);
}

function onAddColour(plotEl, chartType) {
    const trace = plotEl?.data?.[0];
    if (!trace) return;

    const defaultPalette = ['#4285f4', '#ea4335', '#fbbc05', '#34a853', '#ff6d01', '#46bdc6', '#7b1fa2', '#c2185b'];

    if (isPieType(chartType)) {
        // Ensure marker.colors array exists and extend it with one more colour
        if (!trace.marker) trace.marker = {};
        if (!Array.isArray(trace.marker.colors)) {
            trace.marker.colors = (trace.labels || []).map((_, i) => defaultPalette[i % defaultPalette.length]);
        }
        const nextColor = defaultPalette[trace.marker.colors.length % defaultPalette.length];
        trace.marker.colors.push(nextColor);
    } else {
        // Single-trace bar with color array
        if (!trace.marker) trace.marker = {};
        if (!Array.isArray(trace.marker.color)) {
            trace.marker.color = [];
        }
        const nextColor = defaultPalette[trace.marker.color.length % defaultPalette.length];
        trace.marker.color.push(nextColor);
    }

    Plotly.redraw(plotEl);
    populateTraceColorPickers(plotEl, chartType);
}

// --- DOM Factory ---

function createColorPickerRow(hexColor, labelText, index) {
    const row = document.createElement('div');
    row.className = 'color-picker-row';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = hexColor;
    colorInput.dataset.traceIndex = index;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'trace-name-input';
    nameInput.value = labelText;
    nameInput.dataset.traceIndex = index;
    nameInput.placeholder = 'Label';

    row.appendChild(colorInput);
    row.appendChild(nameInput);
    return row;
}

// --- Live Apply ---

function getTraceColor(trace) {
    // Check marker.colors (pie), then marker.color, then line.color
    const pieColors = trace.marker?.colors;
    if (Array.isArray(pieColors) && pieColors.length > 0) {
        return toHexColor(pieColors[0]);
    }

    const color = trace.marker?.color || trace.line?.color || '#4285f4';
    if (Array.isArray(color)) return toHexColor(color[0] || '#4285f4');
    if (typeof color === 'string') return toHexColor(color);
    return '#4285f4';
}

/** Convert CSS colour names and rgb() strings to hex for the colour input. */
function toHexColor(color) {
    if (!color || typeof color !== 'string') return '#4285f4';
    const trimmed = color.trim();
    if (trimmed.startsWith('#') && (trimmed.length === 4 || trimmed.length === 7)) return trimmed;

    // Use a temporary element to resolve CSS colour names and rgb() to hex
    const temp = document.createElement('span');
    temp.style.color = trimmed;
    document.body.appendChild(temp);
    const computed = getComputedStyle(temp).color;
    document.body.removeChild(temp);

    const match = computed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return '#4285f4';

    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
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

/** Apply a unified colour to a whole trace (multi-trace charts). */
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

/** Apply colour to a single pie/donut sector via `marker.colors[index]`. */
function applyPieSectorColor(sectorIndex, color) {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    if (!plotEl || typeof Plotly === 'undefined') return;

    try {
        const trace = plotEl.data?.[0];
        if (!trace) return;
        if (!trace.marker) trace.marker = {};

        const defaultPalette = ['#4285f4', '#ea4335', '#fbbc05', '#34a853', '#ff6d01', '#46bdc6', '#7b1fa2', '#c2185b'];

        // Ensure colors array is properly initialised
        if (!Array.isArray(trace.marker.colors)) {
            trace.marker.colors = (trace.labels || []).map((_, i) => defaultPalette[i % defaultPalette.length]);
        }

        // Extend if needed
        while (trace.marker.colors.length <= sectorIndex) {
            trace.marker.colors.push(defaultPalette[trace.marker.colors.length % defaultPalette.length]);
        }

        trace.marker.colors[sectorIndex] = color;
        Plotly.redraw(plotEl);
    } catch (e) {
        console.error('Failed to update pie sector color:', e);
    }
}

/** Apply colour to a single bar in a colour-array trace via `marker.color[index]`. */
function applyBarElementColor(barIndex, color) {
    if (!activeCustomizerChartId) return;
    const plotEl = document.getElementById(`dash-plot-${activeCustomizerChartId}`);
    if (!plotEl || typeof Plotly === 'undefined') return;

    try {
        const trace = plotEl.data?.[0];
        if (!trace || !Array.isArray(trace.marker?.color)) return;

        trace.marker.color[barIndex] = color;
        Plotly.redraw(plotEl);
    } catch (e) {
        console.error('Failed to update bar element color:', e);
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
