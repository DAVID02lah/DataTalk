// File Upload (to Backend)
// ============================================================

let usageRefreshTimer = null;

function encodePathForRoute(pathValue) {
    return String(pathValue || "")
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/");
}

function basenameFromPath(pathValue) {
    const normalized = String(pathValue || "").replace(/\\+/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function formatRelativeTimestamp(isoValue) {
    if (!isoValue) return "";
    const ts = new Date(isoValue).getTime();
    if (Number.isNaN(ts)) return "";

    const diffSeconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSeconds < 60) return "just now";
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
    if (diffSeconds < 604800) return `${Math.floor(diffSeconds / 86400)}d ago`;

    return new Date(isoValue).toLocaleDateString();
}

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
        <input type="file" id="file-input" accept=".csv, .xlsx, .xls" style="display: none;">
        <button class="btn btn-primary upload-retry-btn" style="margin-top: 20px">Try Again</button>
    `;

    const retryBtn = dropZone.querySelector(".upload-retry-btn");
    const fileInput = dropZone.querySelector("#file-input");
    if (retryBtn && fileInput) {
        retryBtn.addEventListener("click", () => {
            fileInput.click();
        });
    }
    if (fileInput) {
        fileInput.addEventListener("change", function () {
            handleFileUpload(this.files);
        });
    }
}

function showAppError(message, options = {}) {
    const { channel = "chat", uploadDropZone = null } = options;

    if (channel === "upload") {
        const zone = uploadDropZone || document.getElementById("upload-container");
        if (zone) {
            showUploadError(zone, message);
            return;
        }
    }

    if (typeof appendErrorMessage === "function") {
        const chatView = document.getElementById("view-chat");
        const chatIsVisible = !chatView || chatView.classList.contains("active");
        if (chatIsVisible) {
            appendErrorMessage(message);
            return;
        }
    }

    showErrorToast(message);
}

function showErrorToast(message) {
    const toastContainerId = "app-error-toast-container";
    let container = document.getElementById(toastContainerId);

    if (!container) {
        container = document.createElement("div");
        container.id = toastContainerId;
        container.style.position = "fixed";
        container.style.top = "16px";
        container.style.right = "16px";
        container.style.zIndex = "4000";
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.gap = "8px";
        container.style.maxWidth = "340px";
        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.setAttribute("role", "alert");
    toast.textContent = String(message || "An error occurred.");
    toast.style.background = "rgba(198, 40, 40, 0.95)";
    toast.style.color = "#fff";
    toast.style.padding = "10px 12px";
    toast.style.borderRadius = "8px";
    toast.style.fontSize = "13px";
    toast.style.lineHeight = "1.4";
    toast.style.boxShadow = "0 6px 22px rgba(0, 0, 0, 0.22)";
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
    toast.style.transition = "opacity 0.2s ease, transform 0.2s ease";

    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
    });

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-6px)";
        setTimeout(() => {
            toast.remove();
            if (container && container.children.length === 0) {
                container.remove();
            }
        }, 220);
    }, 4500);
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

    // Client-side upload validation (1MB limit)
    const MAX_SIZE_MB = 1;
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        showUploadError(
            document.getElementById("upload-container"),
            `File size exceeds ${MAX_SIZE_MB}MB limit. Please upload a smaller dataset.`
        );
        return;
    }

    const ext = file.name.split(".").pop().toLowerCase();
    if (!["csv", "xlsx", "xls"].includes(ext)) {
        showAppError("Please upload a CSV or Excel file.", {
            channel: "upload",
            uploadDropZone: document.getElementById("upload-container"),
        });
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
            filename: result.path || result.filename,
            summary: result.summary,
        };

        await loadFileIntoGrid(file);
        showUploadSuccess(result);
        updateSidebarFileInfo(result.path || result.filename, result.summary);

        await refreshConversationList({ silent: true });
        await loadChatHistory({ replace: true, silent: true });
        await updateUsageSummary({ silent: true });
        if (typeof refreshDashboard === "function") {
            await refreshDashboard();
        }

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

        // Handsontable injects runtime CSS; force its color-scheme to light.
        enforceHandsontableLightScheme(gridContainer);
    }
}

function enforceHandsontableLightScheme(gridContainer) {
    if (!gridContainer) return;

    gridContainer.style.colorScheme = "light";

    const styleEls = gridContainer.querySelectorAll("style");
    styleEls.forEach((styleEl) => {
        const css = styleEl.textContent || "";
        if (!css.includes(":where(.ht-theme-main)")) return;

        const patched = css.replace(/color-scheme\s*:[^;]+;/g, "color-scheme: light;");
        if (patched !== css) {
            styleEl.textContent = patched;
        }
    });
}

function summaryPreviewToGridData(summary) {
    const preview = summary?.preview;
    if (!Array.isArray(preview) || preview.length === 0) return [];

    if (Array.isArray(preview[0])) {
        return preview;
    }

    if (typeof preview[0] === "object" && preview[0] !== null) {
        const columns = Array.isArray(summary?.columns)
            ? summary.columns
            : Object.keys(preview[0]);
        const rows = preview.map((row) => columns.map((col) => row?.[col] ?? ""));
        return [columns, ...rows];
    }

    return [];
}

function updateSidebarFileInfo(filename, summary) {
    const infoEl = document.getElementById("sidebar-file-info");
    const nameEl = document.getElementById("sidebar-filename");
    const metaEl = document.getElementById("sidebar-file-meta");
    if (infoEl && nameEl && metaEl) {
        const base = basenameFromPath(filename);
        const rows = summary?.shape?.rows ?? 0;
        const cols = summary?.shape?.columns ?? 0;

        nameEl.textContent = base || "-";
        metaEl.textContent = `${rows} rows × ${cols} cols`;
        infoEl.style.display = "block";
    }
}

function clearActiveFileUI() {
    App.state.activeFile = null;

    const infoEl = document.getElementById("sidebar-file-info");
    if (infoEl) infoEl.style.display = "none";

    const uploadContainer = document.getElementById("upload-container");
    const dataGridContainer = document.getElementById("data-grid-container");
    if (uploadContainer) uploadContainer.style.display = "flex";
    if (dataGridContainer) dataGridContainer.style.display = "none";

    if (App.state.hot) {
        App.state.hot.destroy();
        App.state.hot = null;
    }

    const previewBody = document.getElementById("data-preview-body");
    const previewToggle = document.getElementById("data-preview-toggle");
    if (previewBody) previewBody.innerHTML = "";
    if (previewToggle) previewToggle.style.display = "none";
}

async function loadDatasetForPath(filePath, options = {}) {
    const { silent = false, forceReload = false } = options;

    const normalizedPath = String(filePath || "").trim().replace(/^\/+|\/+$/g, "");
    if (!normalizedPath) {
        clearActiveFileUI();
        return false;
    }

    const currentPath = App.state.activeFile?.filename;
    if (!forceReload && currentPath === normalizedPath && App.state.activeFile?.summary) {
        return true;
    }

    try {
        const summaryResp = await fetch(`${App.API_BASE}/api/data-summary/${encodePathForRoute(normalizedPath)}`, {
            headers: App.getAuthHeaders()
        });
        const summaryData = await summaryResp.json().catch(() => ({}));
        if (!summaryResp.ok || summaryData.error || !summaryData.summary) {
            throw new Error(summaryData.error || "Failed to load dataset summary.");
        }

        const fullDataResp = await fetch(`${App.API_BASE}/api/data/${encodePathForRoute(normalizedPath)}`, {
            headers: App.getAuthHeaders()
        });

        if (fullDataResp.ok) {
            const fullData = await fullDataResp.json();
            loadGrid(fullData.data || []);
        } else {
            const previewGrid = summaryPreviewToGridData(summaryData.summary);
            if (previewGrid.length > 0) {
                loadGrid(previewGrid);
            }
        }

        App.state.activeFile = {
            filename: normalizedPath,
            summary: summaryData.summary,
        };

        updateSidebarFileInfo(normalizedPath, summaryData.summary);
        populateDataPreview(summaryData.summary);
        fetchSmartQuestions();
        return true;
    } catch (e) {
        if (!silent) {
            showAppError(e.message || "Failed to load dataset.");
        }
        return false;
    }
}

function renderConversationList() {
    const container = document.getElementById("conversation-list");
    if (!container) return;

    const sessions = Array.isArray(App.state.chatSessions) ? App.state.chatSessions : [];
    container.innerHTML = "";

    if (sessions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "conversation-meta";
        empty.textContent = "No saved conversations yet.";
        container.appendChild(empty);
        return;
    }

    sessions.forEach((session) => {
        const item = document.createElement("div");
        item.className = `conversation-item${session.id === App.state.activeSessionId ? " active" : ""}`;
        item.addEventListener("click", () => activateConversation(session.id));

        const title = document.createElement("div");
        title.className = "conversation-title";
        title.textContent = session.title || "New Conversation";

        const count = Number(session.message_count || 0);
        const relativeUpdated = formatRelativeTimestamp(session.updated_at);
        const meta = document.createElement("div");
        meta.className = "conversation-meta";
        meta.textContent = `${count} message${count === 1 ? "" : "s"}${relativeUpdated ? ` • ${relativeUpdated}` : ""}`;

        const actions = document.createElement("div");
        actions.className = "conversation-actions";
        const removeBtn = document.createElement("button");
        removeBtn.className = "sidebar-mini-btn danger";
        removeBtn.type = "button";
        removeBtn.textContent = "Delete";
        removeBtn.addEventListener("click", (event) => deleteConversation(session.id, event));
        actions.appendChild(removeBtn);

        item.appendChild(title);
        item.appendChild(meta);
        item.appendChild(actions);
        container.appendChild(item);
    });
}

async function refreshConversationList(options = {}) {
    const { silent = false } = options;
    try {
        const response = await fetch(`${App.API_BASE}/api/chat/sessions`, {
            headers: App.getAuthHeaders()
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
            throw new Error(data.error || "Failed to load conversations.");
        }

        App.state.chatSessions = data.sessions || [];
        if (Object.prototype.hasOwnProperty.call(data, "active_session_id")) {
            App.state.activeSessionId = data.active_session_id || null;
        } else if (!App.state.activeSessionId && App.state.chatSessions.length > 0) {
            App.state.activeSessionId = App.state.chatSessions[0].id || null;
        }
        renderConversationList();
        return data;
    } catch (e) {
        if (!silent) showAppError(e.message || "Could not load conversations.");
        return { sessions: [], active_session_id: null };
    }
}

async function syncActiveSessionFile() {
    const activeSession = (App.state.chatSessions || []).find((s) => s.id === App.state.activeSessionId);
    const path = activeSession?.filename;

    if (path) {
        await loadDatasetForPath(path, {
            silent: true,
            forceReload: true,
        });
        return;
    }

    if (!path) {
        clearActiveFileUI();
    }
}

async function activateConversation(sessionId) {
    if (!sessionId) return;

    try {
        const response = await fetch(`${App.API_BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}/activate`, {
            method: "POST",
            headers: App.getAuthHeaders(),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error || data.success === false) {
            throw new Error(data.text || data.error || "Failed to activate conversation.");
        }

        App.state.activeSessionId = data.active_session_id || sessionId;
        await refreshConversationList({ silent: true });
        await syncActiveSessionFile();
        await loadChatHistory({ replace: true, silent: true });
        await updateUsageSummary({ silent: true });
        if (typeof refreshDashboard === "function") {
            await refreshDashboard();
        }
    } catch (e) {
        showAppError(e.message || "Could not activate conversation.");
    }
}

async function createNewConversation() {
    try {
        const response = await fetch(`${App.API_BASE}/api/chat/sessions/new`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ filename: App.state.activeFile?.filename || null }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error || data.success === false) {
            throw new Error(data.text || data.error || "Failed to create conversation.");
        }

        App.state.activeSessionId = data.session?.id || null;
        await refreshConversationList({ silent: true });
        await syncActiveSessionFile();
        await loadChatHistory({ replace: true, silent: true });
        await updateUsageSummary({ silent: true });
        if (typeof clearDashboard === "function") {
            clearDashboard();
        }
        if (typeof refreshDashboard === "function") {
            await refreshDashboard();
        }
    } catch (e) {
        showAppError(e.message || "Could not create conversation.");
    }
}

async function deleteConversation(sessionId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    if (!sessionId) return;
    if (!window.confirm("Delete this conversation?")) return;

    try {
        const response = await fetch(`${App.API_BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
            headers: App.getAuthHeaders(),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error || data.success === false) {
            throw new Error(data.text || data.error || "Failed to delete conversation.");
        }

        App.state.activeSessionId = data.active_session_id || null;
        await refreshConversationList({ silent: true });
        await syncActiveSessionFile();
        await loadChatHistory({ replace: true, silent: true });
        await updateUsageSummary({ silent: true });
        if (typeof clearDashboard === "function") {
            clearDashboard();
        }
        if (typeof refreshDashboard === "function") {
            await refreshDashboard();
        }
    } catch (e) {
        showAppError(e.message || "Could not delete conversation.");
    }
}

function renderUsageSummary(summary) {
    const usageTitle = document.getElementById("usage-messages-left");
    const usageSubtitle = document.getElementById("usage-subtitle");
    const usageFill = document.getElementById("usage-progress-fill");
    const usageMetrics = document.getElementById("usage-metrics");
    const usageTrack = document.querySelector("#usage-panel .usage-progress-track");

    const budget = summary?.request_budget || {};
    const tokenUsage = summary?.token_usage || {};

    const limit = Number(budget.limit || 0);
    const used = Number(budget.used || 0);
    const remaining = Number(budget.remaining || 0);
    const windowSeconds = Number(budget.window_seconds || 0);
    const resetIn = Number(budget.reset_in_seconds || 0);

    const percentUsed = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;

    if (usageTitle) {
        usageTitle.textContent = limit > 0
            ? `${remaining} of ${limit} messages left`
            : `${remaining} messages left`;
    }

    if (usageSubtitle) {
        if (remaining === 0 && resetIn > 0) {
            usageSubtitle.textContent = `Rate window resets in ${resetIn}s`;
        } else if (windowSeconds >= 60) {
            usageSubtitle.textContent = `${Math.round(windowSeconds / 60)} minute rate window`;
        } else {
            usageSubtitle.textContent = `${windowSeconds}s rate window`;
        }
    }

    if (usageFill) {
        usageFill.style.width = `${percentUsed.toFixed(1)}%`;
    }

    if (usageTrack) {
        usageTrack.setAttribute("aria-valuenow", String(Math.round(percentUsed)));
    }

    if (usageMetrics) {
        const totalTokens = Number(tokenUsage.total_tokens || 0);
        const costUsd = Number(tokenUsage.cost_usd || 0);
        const costMyr = Number(tokenUsage.cost_myr || 0);
        usageMetrics.textContent = `Tokens: ${totalTokens.toLocaleString()} | USD: $${costUsd.toFixed(4)} | MYR: RM${costMyr.toFixed(4)}`;
    }
}

async function updateUsageSummary(options = {}) {
    const { silent = false } = options;
    try {
        const response = await fetch(`${App.API_BASE}/api/usage/summary`, {
            headers: App.getAuthHeaders()
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
            throw new Error(data.error || "Failed to fetch usage summary.");
        }

        renderUsageSummary(data);
        return data;
    } catch (e) {
        if (!silent) {
            showAppError(e.message || "Could not load usage summary.");
        }
        return null;
    }
}

function startUsageSummaryAutoRefresh() {
    if (usageRefreshTimer) {
        clearInterval(usageRefreshTimer);
    }
    usageRefreshTimer = setInterval(() => {
        updateUsageSummary({ silent: true });
    }, 15000);
}

async function checkExistingFiles() {
    try {
        await refreshConversationList({ silent: true });
        await syncActiveSessionFile();
    } catch (e) {
        console.log("Backend not available yet:", e.message);
    }
}

async function initializeDashboardSidebarState() {
    await checkExistingFiles();
    await loadChatHistory({ replace: true, silent: true });
    await refreshConversationList({ silent: true });
    await syncActiveSessionFile();
    await updateUsageSummary({ silent: true });
    if (typeof refreshDashboard === "function") {
        await refreshDashboard();
    }
    startUsageSummaryAutoRefresh();
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
                session_id: App.state.activeSessionId || null,
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
        let currentEvent = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            // Keep the last (possibly incomplete) line in the buffer
            buffer = lines.pop() || "";
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
            if (finalResult.session_id) {
                App.state.activeSessionId = finalResult.session_id;
            }
            appendChatMessage("ai", finalResult.text, finalResult.chart, finalResult.table,
                finalResult.stats, finalResult.followup, finalResult.cached, message);
            await refreshConversationList({ silent: true });
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
        updateUsageSummary({ silent: true });
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

// ============================================================
// Load Chat History on Page Load
// ============================================================
async function loadChatHistory(options = {}) {
    const { replace = false, silent = false } = options;

    if (replace) {
        resetChatMessagesUI();
    }

    try {
        const response = await fetch(`${App.API_BASE}/api/chat/history`, {
            headers: App.getAuthHeaders()
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
            throw new Error(data.error || data.text || "Could not load chat history.");
        }

        if (data.session_id) {
            App.state.activeSessionId = data.session_id;
        }

        const history = data.history || [];

        if (history.length === 0) {
            showChatHero();
            return data;
        }

        // Switch to message view
        showChatMessages();

        // Render each message (API returns newest-first; reverse for chronological UI order)
        const chronological = [...history].reverse();
        for (const msg of chronological) {
            const role = msg.role === "user" ? "user" : "ai";
            appendChatMessage(role, msg.text, msg.chart || null, msg.table || null, msg.stats || null);
        }
        return data;
    } catch (e) {
        if (!silent) {
            console.log("Could not load chat history:", e.message);
        }
        return null;
    }
}

async function clearChatHistory() {
    try {
        const response = await fetch(`${App.API_BASE}/api/chat/clear`, {
            method: "POST",
            headers: App.getAuthHeaders()
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false || data.error) {
            throw new Error(data.error || "Failed to clear chat history.");
        }

        resetChatMessagesUI();
        showChatHero();
        clearActiveFileUI();

        App.state.chatSessions = [];
        App.state.activeSessionId = null;

        // Clear dashboard widgets
        if (typeof clearDashboard === 'function') {
            clearDashboard();
        }

        await refreshConversationList({ silent: true });
        await loadChatHistory({ replace: true, silent: true });
        await refreshConversationList({ silent: true });
        await updateUsageSummary({ silent: true });
        if (typeof refreshDashboard === "function") {
            await refreshDashboard();
        }

    } catch (e) {
        console.error("Error clearing chat:", e);
        showAppError(e.message || "Error clearing chat history.");
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
                displayModeBar: true,
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

// ============================================================
// Shared chart resize observer — one observer for the whole
// chat container instead of one ResizeObserver per chart.
// (Plotly's responsive:false disables the per-chart observers.)
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
    const chatContainer = document.getElementById("chat-messages");
    if (!chatContainer || typeof ResizeObserver === "undefined") return;

    let _resizeTimer;
    new ResizeObserver(() => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            chatContainer.querySelectorAll('[id^="chat-chart-"]').forEach(el => {
                if (el._fullLayout) Plotly.Plots.resize(el);
            });
        }, 150);
    }).observe(chatContainer);
});

window.addEventListener("beforeunload", () => {
    if (usageRefreshTimer) {
        clearInterval(usageRefreshTimer);
        usageRefreshTimer = null;
    }
});
