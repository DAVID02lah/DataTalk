// Chat message rendering — DOM construction for messages, charts, tables, stats.

function renderChartHtml(chartJson) {
    if (!chartJson || typeof chartJson !== "object") return { html: "", chartId: null };
    App.state.chartCounter++;
    const chartId = `chat-chart-${App.state.chartCounter}`;
    const chartTitle = chartJson.layout?.title?.text || chartJson.layout?.title || "Chart";
    const html = `
        <div class="chat-chart-container" style="position: relative;">
            <div id="${chartId}" style="width: 100%; height: ${CONFIG.CHART_HEIGHT_DEFAULT}px;"></div>
            <div class="chart-actions">
                <button class="chart-action-btn" onclick="pinChart('${chartId}', '${escapeAttr(typeof chartTitle === 'string' ? chartTitle : 'Chart')}')">📌 Pin to Dashboard</button>
                <button class="chart-action-btn" onclick="downloadChart('${chartId}')">📥 Download PNG</button>
                <button class="chart-action-btn expand-btn" onclick="openFullscreenChart('${chartId}')">🔍 Expand</button>
            </div>
        </div>
    `;
    return { html, chartId };
}

function renderStatsHtml(statsJson) {
    if (!statsJson || !Array.isArray(statsJson) || statsJson.length === 0) return "";
    return `<div class="chat-stats-row">
        ${statsJson.map(s => `<div class="stat-card">
            <div class="stat-value">${escapeHtml(s.value)}</div>
            <div class="stat-label">${escapeHtml(s.label)}</div>
        </div>`).join("")}
    </div>`;
}

function renderTableHtml(tableJson) {
    if (!tableJson || !tableJson.headers || !tableJson.rows) return "";
    const tableId = `chat-table-${App.state.chartCounter || Date.now()}`;
    return `
        <div class="chat-table-wrapper" id="${tableId}" style="display: none; overflow-x: auto;">
            <table class="chat-data-table">
                <thead><tr>${tableJson.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
                <tbody>${tableJson.rows.map(row => `<tr>${row.map(v => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</tbody>
            </table>
        </div>
    `;
}

function renderFollowupHtml(followupArr) {
    if (!followupArr || !Array.isArray(followupArr) || followupArr.length === 0) return "";
    return `<div class="followup-chips">
        ${followupArr.map(q => `<button class="followup-chip" onclick="useFollowup(this)">${escapeHtml(q)}</button>`).join("")}
    </div>`;
}

function renderActionsHtml(tableJson, isCached, originalQuery) {
    const tableToggleBtn = (tableJson && tableJson.headers && tableJson.rows)
        ? `<button class="table-toggle-btn" onclick="toggleTable('chat-table-${App.state.chartCounter || Date.now()}', this)">📊 Show as table</button>`
        : "";
    const regenerateBtn = originalQuery
        ? `<button class="regenerate-btn" onclick="regenerateLastResponse('${escapeAttr(originalQuery)}')">🔄 Regenerate</button>`
        : "";
    const cachedBadge = isCached ? `<span class="cached-badge">⚡ Cached</span>` : "";
    if (!tableToggleBtn && !regenerateBtn) return "";
    return `<div class="msg-actions">
        ${tableToggleBtn}
        ${regenerateBtn}
        ${cachedBadge}
    </div>`;
}

function mountPlotlyChart(chartId, chartJson, options = {}) {
    if (!chartId || !chartJson) return;

    const {
        stripTitle = false,
        layoutOverrides = {},
        plotConfigOverrides = {},
    } = options;

    setTimeout(() => {
        try {
            const layout = {
                ...(chartJson.layout || {}),
                template: "plotly_white",
                font: { family: "Inter, sans-serif" },
                autosize: true,
                width: null,
                margin: { l: 50, r: 30, t: 50, b: 50 },
                ...layoutOverrides,
            };

            if (stripTitle) {
                layout.title = "";
            }

            const plotConfig = {
                responsive: false,
                displayModeBar: false,
                modeBarButtonsToRemove: ["lasso2d", "select2d"],
                ...plotConfigOverrides,
            };

            Plotly.newPlot(chartId, chartJson.data, layout, plotConfig);
        } catch (e) {
            console.error("Plotly render error:", e);
            document.getElementById(chartId).innerHTML =
                '<p style="color: #ea4335;">Error rendering chart</p>';
        }
    }, CONFIG.PLOTLY_RENDER_TIMEOUT);
}

// --- Main chat message renderer ---

function appendChatMessage(role, text, chartJson, tableJson, statsJson, followupArr, isCached, originalQuery) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const msgDiv = document.createElement("div");
    msgDiv.className = "chat-msg";
    if (role === "ai") msgDiv.classList.add("streaming-text");

    const avatarClass = role === "user" ? "user" : "ai";
    const avatarText = role === "user"
        ? (App.state.user?.avatar_initials || "?")
        : "AI";
    const name = role === "user" ? "You" : "Data Talk AI";

    const htmlText = renderMarkdown(text);
    const chart = renderChartHtml(chartJson);
    const statsHtml = renderStatsHtml(statsJson);
    const tableHtml = renderTableHtml(tableJson);
    const followupHtml = renderFollowupHtml(followupArr);
    const actionsHtml = role === "ai" ? renderActionsHtml(tableJson, isCached, originalQuery) : "";

    msgDiv.innerHTML = `
        <div class="chat-msg-header">
            <div class="chat-msg-avatar ${avatarClass}">${avatarText}</div>
            <div class="chat-msg-name">${name}</div>
        </div>
        <div class="chat-msg-body">
            ${htmlText}
            ${chart.html}
            ${statsHtml}
            ${tableHtml}
            ${actionsHtml}
            ${followupHtml}
        </div>
    `;

    container.appendChild(msgDiv);
    mountPlotlyChart(chart.chartId, chartJson);

    if (role === "ai") {
        setTimeout(() => msgDiv.classList.remove("streaming-text"), 600);
    }

    container.scrollTop = container.scrollHeight;
    App.state.chatMessages.push({ role, text, chart: chartJson || null, table: tableJson || null, stats: statsJson || null });
}

// --- Table toggle ---

function toggleTable(tableId, btn) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const isHidden = table.style.display === "none";
    table.style.display = isHidden ? "block" : "none";
    if (btn) {
        btn.textContent = isHidden ? "📊 Hide table" : "📊 Show as table";
        btn.classList.toggle("active", isHidden);
    }
}

// --- Chat view state helpers ---

function showChatMessages() {
    const hero = document.getElementById("chat-hero");
    const messages = document.getElementById("chat-messages");
    if (hero) hero.style.display = "none";
    if (messages) messages.classList.add("has-messages");
}

function showChatHero() {
    const hero = document.getElementById("chat-hero");
    const messages = document.getElementById("chat-messages");
    if (hero) hero.style.display = "";
    if (messages) messages.classList.remove("has-messages");
}

function resetChatMessagesUI() {
    const container = document.getElementById("chat-messages");
    if (container) container.innerHTML = "";
    App.state.chatMessages = [];
    App.state.chartCounter = 0;
}

// --- Typing / progress indicator ---

function showTypingIndicator() {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const indicator = document.createElement("div");
    indicator.id = "typing-indicator";
    indicator.className = "chat-msg";
    indicator.innerHTML = `
        <div class="chat-msg-header">
            <div class="chat-msg-avatar ai">AI</div>
            <div class="chat-msg-name">Data Talk AI</div>
        </div>
        <div class="typing-indicator">
            <div class="typing-progress-text">Analysing your data...</div>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>
    `;
    container.appendChild(indicator);
    container.scrollTop = container.scrollHeight;
}

function updateTypingPhase(phaseText) {
    const el = document.querySelector("#typing-indicator .typing-progress-text");
    if (el && phaseText) {
        el.classList.remove("phase-change");
        void el.offsetWidth; // Force reflow for animation restart
        el.textContent = phaseText;
        el.classList.add("phase-change");
    }
}

function hideTypingIndicator() {
    const indicator = document.getElementById("typing-indicator");
    if (indicator) indicator.remove();
}

function appendErrorMessage(text) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const msgDiv = document.createElement("div");
    msgDiv.className = "chat-msg chat-error-msg";

    const htmlText = renderMarkdown(text);

    msgDiv.innerHTML = `
        <div class="chat-error-banner">
            <div class="chat-error-icon" aria-hidden="true">!</div>
            <div class="chat-error-body">
                <strong>Error:</strong>
                ${htmlText}
            </div>
        </div>
    `;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}


// --- Shared Plotly resize observer for chat container ---

function resizeChatPlotlyCharts(chatContainer) {
    chatContainer.querySelectorAll('[id^="chat-chart-"]').forEach((chartEl) => {
        if (chartEl._fullLayout) {
            Plotly.Plots.resize(chartEl);
        }
    });
}

function createChatPlotlyResizeScheduler(chatContainer) {
    const state = { rafId: 0, width: 0, height: 0 };

    const scheduleResize = () => {
        const rect = chatContainer.getBoundingClientRect();
        const nextWidth = Math.round(rect.width);
        const nextHeight = Math.round(rect.height);
        const sizeChanged = nextWidth !== state.width || nextHeight !== state.height;

        if (!sizeChanged && state.rafId === 0) return;

        state.width = nextWidth;
        state.height = nextHeight;

        if (state.rafId !== 0) return;

        state.rafId = requestAnimationFrame(() => {
            state.rafId = 0;
            resizeChatPlotlyCharts(chatContainer);
        });
    };

    scheduleResize.cancel = () => {
        if (state.rafId !== 0) {
            cancelAnimationFrame(state.rafId);
            state.rafId = 0;
        }
    };

    return scheduleResize;
}

// Wire up the shared resize observer once the DOM is ready.
document.addEventListener("DOMContentLoaded", () => {
    const chatContainer = document.getElementById("chat-messages");
    if (!chatContainer || typeof ResizeObserver === "undefined" || typeof Plotly === "undefined") return;

    const scheduleResize = createChatPlotlyResizeScheduler(chatContainer);
    const resizeObserver = new ResizeObserver(() => {
        scheduleResize();
    });

    resizeObserver.observe(chatContainer);
    scheduleResize();

    window.addEventListener("beforeunload", () => {
        resizeObserver.disconnect();
        scheduleResize.cancel();
    }, { once: true });
});
