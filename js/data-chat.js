// File Upload (to Backend)
// ============================================================

function showUploadingState(dropZone, filename) {
    if (!dropZone) return;
    dropZone.innerHTML = `
        <div style="font-size: 2rem">⏳</div>
        <h3>Uploading ${escapeHtml(filename)}...</h3>
        <p>Processing your data...</p>
    `;
}

function showUploadSuccess(result) {
    const banner = document.getElementById("upload-success-banner");
    if (!banner) return;
    const s = result.summary;
    banner.innerHTML = `
        <div class="upload-success">
            <div class="check-icon">✓</div>
            <div class="upload-details">
                <h4>${escapeHtml(result.filename)} uploaded successfully!</h4>
                <p>${escapeHtml(`${s.shape.rows} rows × ${s.shape.columns} columns — ${s.columns.slice(0, 4).join(", ")}${s.columns.length > 4 ? "..." : ""}`)}</p>
            </div>
        </div>
    `;
    banner.style.display = "block";
}

function showUploadError(dropZone, errorMessage) {
    if (!dropZone) return;
    dropZone.innerHTML = `
        <div style="font-size: 3rem; opacity: 0.2">❌</div>
        <h3>Upload Failed</h3>
        <p>${escapeHtml(errorMessage)}</p>
        <button class="btn btn-primary" style="margin-top: 20px" 
            onclick="document.getElementById('file-input').click()">Try Again</button>
    `;
}

function loadFileIntoGrid(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: "array" });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                const json = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                loadGrid(json);
                resolve();
            } catch (err) {
                console.error("Grid load error:", err);
                reject(err);
            }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

async function handleFileUpload(files) {
    const file = files[0];
    if (!file) return;

    // Phase 3: Add Client-Side File Validation (10MB limit)
    const MAX_SIZE_MB = 10;
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        showUploadError(
            document.getElementById("upload-container"),
            `File size exceeds ${MAX_SIZE_MB}MB limit. Please upload a smaller dataset.`
        );
        return;
    }

    const ext = file.name.split(".").pop().toLowerCase();
    if (!["csv", "xlsx", "xls"].includes(ext)) {
        alert("Please upload a CSV or Excel file.");
        return;
    }

    const dropZone = document.getElementById("upload-container");
    showUploadingState(dropZone, file.name);

    try {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch(`${App.API_BASE}/api/upload`, {
            method: "POST",
            headers: App.getAuthHeaders(),
            body: formData,
        });

        const result = await response.json();

        if (!response.ok || result.error) {
            throw new Error(result.error || "Upload failed");
        }

        App.state.activeFile = {
            filename: result.filename,
            summary: result.summary,
        };

        await loadFileIntoGrid(file);
        showUploadSuccess(result);
        updateSidebarFileInfo(result.filename, result.summary);

        fetchSmartQuestions();
        populateDataPreview(result.summary);

    } catch (error) {
        console.error("Upload error:", error);
        showUploadError(dropZone, error.message);
    }
}

function loadGrid(data) {
    const dropZone = document.getElementById("upload-container");
    const gridContainer = document.getElementById("data-grid-container");

    if (dropZone) dropZone.style.display = "none";
    if (gridContainer) {
        gridContainer.style.display = "block";
        if (App.state.hot) App.state.hot.destroy();
        App.state.hot = new Handsontable(gridContainer, {
            data: data,
            rowHeaders: true,
            colHeaders: true,
            height: "100%",
            width: "100%",
            licenseKey: "non-commercial-and-evaluation",
            contextMenu: true,
            manualColumnResize: true,
            manualRowResize: true,
            filters: true,
            dropdownMenu: true,
            stretchH: "all",
        });

        // Handsontable injects theme CSS at runtime; force its color-scheme to light.
        patchHandsontableColorScheme(gridContainer);
    }
}

function patchHandsontableColorScheme(gridContainer) {
    if (!gridContainer) return;

    // Keep computed scheme driven by CSS variable.
    gridContainer.style.colorScheme = "var(--ht-color-scheme, light)";

    const styleEls = gridContainer.querySelectorAll("style");
    styleEls.forEach((styleEl) => {
        const css = styleEl.textContent || "";
        if (!css.includes(":where(.ht-theme-main)")) return;

        const patched = css.replace(
            "color-scheme: light dark;",
            "color-scheme: var(--ht-color-scheme, light);"
        );
        if (patched !== css) {
            styleEl.textContent = patched;
        }
    });
}

function updateSidebarFileInfo(filename, summary) {
    const infoEl = document.getElementById("sidebar-file-info");
    const nameEl = document.getElementById("sidebar-filename");
    const metaEl = document.getElementById("sidebar-file-meta");
    if (infoEl && nameEl && metaEl) {
        nameEl.textContent = filename;
        metaEl.textContent = `${summary.shape.rows} rows × ${summary.shape.columns} cols`;
        infoEl.style.display = "block";
    }
}

async function checkExistingFiles() {
    try {
        const response = await fetch(`${App.API_BASE}/api/files`, {
            headers: App.getAuthHeaders()
        });
        const data = await response.json();
        if (data.active && data.files.length > 0) {
            const file = data.files.find((f) => f.filename === data.active);
            if (file) {
                // Fetch summary
                const sumResp = await fetch(`${App.API_BASE}/api/data-summary/${encodeURIComponent(data.active)}`, {
                    headers: App.getAuthHeaders()
                });
                const sumData = await sumResp.json();
                App.state.activeFile = { filename: data.active, summary: sumData.summary };
                updateSidebarFileInfo(data.active, sumData.summary);

                // Show data grid in Data Connector automatically on load
                const uploadContainer = document.getElementById('upload-container');
                const dataGridContainer = document.getElementById('data-grid-container');
                if (uploadContainer && dataGridContainer && sumData.summary.preview) {
                    uploadContainer.style.display = 'none';
                    dataGridContainer.style.display = 'block';

                    // Fetch full data for the grid instead of using the 5-row preview
                    try {
                        const fullDataResp = await fetch(`${App.API_BASE}/api/data/${encodeURIComponent(data.active)}`, {
                            headers: App.getAuthHeaders()
                        });
                        if (fullDataResp.ok) {
                            const fullData = await fullDataResp.json();
                            loadGrid(fullData.data);
                        } else {
                            loadGrid(sumData.summary.preview); // Fallback to preview
                        }
                    } catch (e) {
                        console.error("Failed to fetch full data:", e);
                        loadGrid(sumData.summary.preview); // Fallback to preview
                    }
                }
            }
        }
    } catch (e) {
        // Backend not running yet — that's ok
        console.log("Backend not available yet:", e.message);
    }
}

// ============================================================
// Chat — Gemini Integration
// ============================================================
async function sendMessage(skipCache = false) {
    const input = document.getElementById("chat-input");
    const message = input.value.trim();
    if (!message || App.state.isWaitingForAI) return;

    // Clear input
    input.value = "";
    input.style.height = "auto";

    // Switch to message view (hide hero)
    showChatMessages();

    // Disable inputs to prevent multi-sends
    input.disabled = true;
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.disabled = true;

    // Add user message
    appendChatMessage("user", message);

    // Show typing indicator
    App.state.isWaitingForAI = true;
    showTypingIndicator();

    try {
        const response = await fetch(`${App.API_BASE}/api/chat/stream`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                message: message,
                filename: App.state.activeFile ? App.state.activeFile.filename : null,
                skip_cache: skipCache,
            }),
        });

        if (!response.ok) {
            // Non-streaming error (e.g. 400/401)
            const errData = await response.json().catch(() => ({}));
            hideTypingIndicator();
            appendErrorMessage(errData.text || errData.error || "An unexpected error occurred.");
            return;
        }

        // Consume the SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResult = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            // Keep the last (possibly incomplete) line in the buffer
            buffer = lines.pop() || "";

            let currentEvent = null;
            for (const line of lines) {
                if (line.startsWith("event: ")) {
                    currentEvent = line.slice(7).trim();
                } else if (line.startsWith("data: ") && currentEvent) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (currentEvent === "phase") {
                            updateTypingPhase(data.message || data.phase);
                        } else if (currentEvent === "result") {
                            finalResult = data;
                        } else if (currentEvent === "error") {
                            hideTypingIndicator();
                            appendErrorMessage(data.text || "An error occurred.");
                            return;
                        }
                        // "done" event — loop will end when stream closes
                    } catch (e) {
                        console.warn("SSE parse error:", e);
                    }
                    currentEvent = null;
                }
            }
        }

        hideTypingIndicator();

        if (finalResult) {
            appendChatMessage("ai", finalResult.text, finalResult.chart, finalResult.table,
                finalResult.stats, finalResult.followup, finalResult.cached, message);
        } else {
            appendErrorMessage("No response received from the server.");
        }

    } catch (error) {
        hideTypingIndicator();
        appendErrorMessage(
            `Could not connect to the backend. Make sure \`server.py\` is running.\n\n\`${error.message}\``
        );
    } finally {
        App.state.isWaitingForAI = false;
        input.disabled = false;
        if (sendBtn) sendBtn.disabled = !input.value.trim();
        input.focus();
    }
}

function useSuggestion(chip) {
    const text = chip.textContent.replace(/^[^\w]+/, "").trim(); // Remove emoji prefix
    const input = document.getElementById("chat-input");
    if (input) {
        input.value = text;
        sendMessage();
    }
}

function showChatMessages() {
    const hero = document.getElementById("chat-hero");
    const messages = document.getElementById("chat-messages");
    if (hero) hero.style.display = "none";
    if (messages) messages.classList.add("has-messages");
}

// ============================================================
// Load Chat History on Page Load
// ============================================================
async function loadChatHistory() {
    try {
        const response = await fetch(`${App.API_BASE}/api/chat/history`, {
            headers: App.getAuthHeaders()
        });
        const data = await response.json();
        const history = data.history || [];

        if (history.length === 0) return;

        // Switch to message view
        showChatMessages();

        // Render each message
        for (const msg of history) {
            const role = msg.role === "user" ? "user" : "ai";
            appendChatMessage(role, msg.text, msg.chart || null, msg.table || null, msg.stats || null);
        }
    } catch (e) {
        console.log("Could not load chat history:", e.message);
    }
}

async function clearChatHistory() {
    try {
        await fetch(`${App.API_BASE}/api/chat/clear`, { method: "POST", headers: App.getAuthHeaders() });
        // Clear the UI
        const container = document.getElementById("chat-messages");
        if (container) container.innerHTML = "";
        App.state.chatMessages = [];
        App.state.chartCounter = 0;
        // Show hero again
        const hero = document.getElementById("chat-hero");
        const messages = document.getElementById("chat-messages");
        if (hero) hero.style.display = "";
        if (messages) messages.classList.remove("has-messages");

        // Reset Data Connector Active State
        App.state.activeFile = null;
        const infoEl = document.getElementById("sidebar-file-info");
        if (infoEl) infoEl.style.display = "none";

        const uploadContainer = document.getElementById("upload-container");
        const dataGridContainer = document.getElementById("data-grid-container");
        if (uploadContainer) uploadContainer.style.display = "flex";
        if (dataGridContainer) dataGridContainer.style.display = "none";

    } catch (e) {
        console.error("Error clearing chat:", e);
    }
}

// ============================================================
// Chat Message Rendering — Helper Functions
// ============================================================

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
                <button class="chart-action-btn" onclick="enableAnnotation('${chartId}')">📝 Annotate</button>
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

function mountPlotlyChart(chartId, chartJson) {
    if (!chartId || !chartJson) return;
    setTimeout(() => {
        try {
            const layout = {
                ...(chartJson.layout || {}),
                template: "plotly_white",
                font: { family: "Inter, sans-serif" },
                autosize: true,
                width: null,
                margin: { l: 50, r: 30, t: 50, b: 50 },
            };
            Plotly.newPlot(chartId, chartJson.data, layout, {
                responsive: true,
                displayModeBar: true,
                modeBarButtonsToRemove: ["lasso2d", "select2d"],
            });
        } catch (e) {
            console.error("Plotly render error:", e);
            document.getElementById(chartId).innerHTML =
                '<p style="color: #ea4335;">Error rendering chart</p>';
        }
    }, CONFIG.PLOTLY_RENDER_TIMEOUT);
}

// ============================================================
// Chat Message Rendering — Main Function
// ============================================================

function appendChatMessage(role, text, chartJson, tableJson, statsJson, followupArr, isCached, originalQuery) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const msgDiv = document.createElement("div");
    msgDiv.className = "chat-msg";
    if (role === "ai") msgDiv.classList.add("streaming-text");

    const avatarClass = role === "user" ? "user" : "ai";
    const avatarText = role === "user" ? "D" : "AI";
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

function escapeAttr(str) {
    return String(str ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/\r/g, "")
        .replace(/\n/g, "\\n")
        .replace(/'/g, "\\'")
        .replace(/\"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ============================================================
// Table Toggle
// ============================================================
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

// ============================================================
// Regenerate Response (#12)
// ============================================================
async function regenerateLastResponse(query) {
    const container = document.getElementById("chat-messages");
    if (!container) return;
    const messages = container.querySelectorAll(".chat-msg");
    if (messages.length > 0) {
        messages[messages.length - 1].remove();
    }
    const input = document.getElementById("chat-input");
    if (input) {
        input.value = query;
        sendMessage();
    }
}

// ============================================================
// Follow-up Suggestion Chips (#13)
// ============================================================
function useFollowup(chip) {
    const text = chip.textContent.trim();
    const input = document.getElementById("chat-input");
    if (input) {
        input.value = text;
        sendMessage();
    }
}

// ============================================================
// Chart Annotation (#27)
// ============================================================
function enableAnnotation(chartId) {
    const chartEl = document.getElementById(chartId);
    if (!chartEl) return;

    chartEl.on("plotly_click", function (eventData) {
        if (!eventData || !eventData.points || eventData.points.length === 0) return;
        const point = eventData.points[0];
        const container = chartEl.closest(".chat-chart-container");
        if (!container) return;

        const existing = container.querySelector(".annotation-input-overlay");
        if (existing) existing.remove();

        const overlay = document.createElement("div");
        overlay.className = "annotation-input-overlay";
        overlay.style.left = "50%";
        overlay.style.top = "10px";
        overlay.style.transform = "translateX(-50%)";
        overlay.innerHTML = `
            <input type="text" placeholder="Add annotation..." autofocus />
            <button onclick="addAnnotation('${chartId}', '${point.x}', ${point.y}, this)">Add</button>
        `;
        container.appendChild(overlay);

        const inp = overlay.querySelector("input");
        inp.focus();
        inp.addEventListener("keydown", function (e) {
            if (e.key === "Enter") addAnnotation(chartId, point.x, point.y, overlay.querySelector("button"));
            else if (e.key === "Escape") overlay.remove();
        });
    });
}

function addAnnotation(chartId, x, y, btnEl) {
    const overlay = btnEl.closest(".annotation-input-overlay");
    const inp = overlay.querySelector("input");
    const text = inp.value.trim();
    if (!text) return;

    const chartEl = document.getElementById(chartId);
    const existingAnnotations = (chartEl.layout && chartEl.layout.annotations) || [];

    Plotly.relayout(chartId, {
        annotations: [...existingAnnotations, {
            x: x, y: y, text: text,
            showarrow: true, arrowhead: 2, arrowsize: 1,
            arrowcolor: "#4285f4",
            font: { size: 12, color: "#4285f4", family: "Inter, sans-serif" },
            bgcolor: "rgba(255,255,255,0.9)",
            bordercolor: "#4285f4", borderwidth: 1, borderpad: 4,
        }]
    });
    overlay.remove();
}

// ============================================================
// Typing / Progress Indicator
// ============================================================

const PROGRESS_PHASES = [
    "Extracting data...",
    "Generating analysis code...",
    "Running analysis...",
    "Interpreting results...",
    "Almost done...",
];

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
            <div class="typing-progress-text">Analyzing your data...</div>
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

// ============================================================
