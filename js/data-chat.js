// File Upload (to Backend)
// ============================================================

let usageRefreshTimer = null;
let defaultUploadContainerMarkup = null;
let lastUsageSummaryAt = 0;

const USAGE_SUMMARY_MIN_INTERVAL_MS = 30_000;
const USAGE_SUMMARY_POLL_INTERVAL_MS = 60_000;

function captureDefaultUploadMarkup() {
    if (defaultUploadContainerMarkup !== null) return;
    const uploadContainer = document.getElementById("upload-container");
    if (!uploadContainer) return;
    defaultUploadContainerMarkup = uploadContainer.innerHTML;
}

function restoreUploadContainerMarkup() {
    const uploadContainer = document.getElementById("upload-container");
    if (!uploadContainer || defaultUploadContainerMarkup === null) return;

    uploadContainer.innerHTML = defaultUploadContainerMarkup;

    const fileInput = uploadContainer.querySelector("#file-input");
    const browseBtn = uploadContainer.querySelector("#browse-file-btn");
    if (fileInput) {
        fileInput.addEventListener("change", function () {
            handleFileUpload(this.files);
        });
    }
    if (browseBtn && fileInput) {
        browseBtn.addEventListener("click", () => {
            fileInput.click();
        });
    }
}

/** Toggle visibility of the Data Connector save toolbar. */
function setDataEditorVisibility(isVisible) {
    const toolbar = document.getElementById("data-editor-toolbar");
    if (!toolbar) return;
    toolbar.style.display = isVisible ? "flex" : "none";
}

/** Update the save status indicator to reflect dirty/saving/saved/error states. */
function setDataSaveStatus(state, message = "") {
    const statusEl = document.getElementById("data-save-status");
    const saveBtn = document.getElementById("save-data-btn");
    if (!statusEl || !saveBtn) return;

    statusEl.classList.remove("is-dirty", "is-saving", "is-saved", "is-error");

    if (state === "hidden") {
        setDataEditorVisibility(false);
        saveBtn.disabled = true;
        statusEl.textContent = "";
        return;
    }

    setDataEditorVisibility(true);

    if (state === "clean") {
        const fallback = App.state.lastDatasetSavedAt
            ? `Saved at ${App.state.lastDatasetSavedAt}.`
            : "No unsaved changes.";
        statusEl.textContent = message || fallback;
        saveBtn.disabled = true;
        App.state.dataGridDirty = false;
        App.state.isSavingDataset = false;
        return;
    }

    if (state === "dirty") {
        statusEl.classList.add("is-dirty");
        statusEl.textContent = message || "You have unsaved changes.";
        saveBtn.disabled = false;
        App.state.dataGridDirty = true;
        App.state.isSavingDataset = false;
        return;
    }

    if (state === "saving") {
        statusEl.classList.add("is-saving");
        statusEl.textContent = message || "Saving dataset...";
        saveBtn.disabled = true;
        App.state.isSavingDataset = true;
        return;
    }

    if (state === "saved") {
        statusEl.classList.add("is-saved");
        statusEl.textContent = message || "Changes saved.";
        saveBtn.disabled = true;
        App.state.dataGridDirty = false;
        App.state.isSavingDataset = false;
        return;
    }

    if (state === "error") {
        statusEl.classList.add("is-error");
        statusEl.textContent = message || "Save failed. Please retry.";
        saveBtn.disabled = false;
        App.state.dataGridDirty = true;
        App.state.isSavingDataset = false;
    }
}

function getGridDataForSave() {
    if (!App.state.hot) return [];
    const data = App.state.hot.getData();
    return Array.isArray(data) ? data : [];
}

/** Persist edited grid data and reload the dataset summary so downstream AI calls use fresh data. */
async function saveDatasetChanges() {
    const activeFilename = App.state.activeFile?.filename;
    if (!activeFilename || !App.state.hot) {
        showAppError("Upload a dataset before saving edits.");
        return;
    }

    if (App.state.isSavingDataset) return;

    const gridData = getGridDataForSave();
    if (!Array.isArray(gridData) || gridData.length === 0) {
        showAppError("No editable grid data found to save.");
        return;
    }

    try {
        setDataSaveStatus("saving");

        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/data/${encodePathForRoute(activeFilename)}`, {
            method: "PUT",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ data: gridData }),
        });
        assertApiSuccess(response, data, "Failed to save dataset changes.", { requireSuccessFlag: true });

        const savedAt = data.saved_at ? new Date(data.saved_at).toLocaleTimeString() : new Date().toLocaleTimeString();
        App.state.lastDatasetSavedAt = savedAt;
        const savedMessage = `Saved at ${savedAt}.`;

        await loadDatasetForPath(activeFilename, {
            silent: true,
            forceReload: true,
        });

        setDataSaveStatus("saved", savedMessage);
        if (App.state.dataSaveStateTimer) {
            clearTimeout(App.state.dataSaveStateTimer);
        }
        App.state.dataSaveStateTimer = setTimeout(() => {
            if (!App.state.dataGridDirty && !App.state.isSavingDataset) {
                setDataSaveStatus("clean", savedMessage);
            }
        }, 2500);

        await refreshConversationList({ silent: true });
        fetchSmartQuestions({ force: true });
    } catch (e) {
        setDataSaveStatus("error", e.message || "Save failed. Please retry.");
        showAppError(e.message || "Failed to save dataset changes.");
    }
}

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

function getMaxChatSessions() {
    const configuredMax = Number(App.state.maxChatSessions);
    if (Number.isFinite(configuredMax) && configuredMax > 0) {
        return Math.floor(configuredMax);
    }
    return 2;
}

function hasReachedChatSessionLimit() {
    const sessions = Array.isArray(App.state.chatSessions) ? App.state.chatSessions : [];
    return sessions.length >= getMaxChatSessions();
}

function updateNewConversationButtonState() {
    const newConversationBtn = document.querySelector("#conversation-panel .sidebar-panel-header .sidebar-mini-btn");
    if (!newConversationBtn) return;

    const maxSessions = getMaxChatSessions();
    const sessions = Array.isArray(App.state.chatSessions) ? App.state.chatSessions : [];
    const reachedLimit = sessions.length >= maxSessions;

    newConversationBtn.disabled = reachedLimit;
    newConversationBtn.title = reachedLimit
        ? `Maximum ${maxSessions} conversations reached. Delete one to create another.`
        : "New conversation";
}

function showUploadingState(dropZone, filename) {
    if (!dropZone) return;
    captureDefaultUploadMarkup();
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

function createUserFacingError(message) {
    const err = new Error(message || "An unexpected error occurred.");
    err.userFacing = true;
    return err;
}

async function fetchApiJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    return { response, data };
}

function assertApiSuccess(response, data, fallbackMessage, options = {}) {
    const { requireSuccessFlag = false } = options;
    const failed = !response.ok || data.error || (requireSuccessFlag && data.success === false);
    if (failed) {
        throw createUserFacingError(data.text || data.error || fallbackMessage);
    }
}

function hydrateChatHistory(historyItems) {
    resetChatMessagesUI();

    const items = Array.isArray(historyItems) ? historyItems : [];
    if (items.length === 0) {
        showChatHero();
        return;
    }

    showChatMessages();
    const chronological = [...items].reverse();
    chronological.forEach((msg) => {
        const role = msg.role === "user" ? "user" : "ai";
        appendChatMessage(role, msg.text, msg.chart || null, msg.table || null, msg.stats || null);
    });
}

function applySessionPayload(sessionPayload) {
    if (!sessionPayload || typeof sessionPayload !== "object") return;

    const previousSessionId = App.state.activeSessionId;

    if (Array.isArray(sessionPayload.sessions)) {
        App.state.chatSessions = sessionPayload.sessions;
    }

    const maxSessions = Number(sessionPayload.max_chat_sessions);
    if (Number.isFinite(maxSessions) && maxSessions > 0) {
        App.state.maxChatSessions = Math.floor(maxSessions);
    }

    if (Object.prototype.hasOwnProperty.call(sessionPayload, "active_session_id")) {
        App.state.activeSessionId = sessionPayload.active_session_id || null;
    }

    if (previousSessionId !== App.state.activeSessionId) {
        // Session-scoped dashboard widgets should not bleed across conversations.
        App.state.dashboardLoaded = false;
        App.state.dashboardCharts = [];
        App.state.dashboardCards = [];
    }

    renderConversationList();
}

async function refreshSessionDependentViews(options = {}) {
    const {
        syncActiveFile = false,
        clearDashboardFirst = false,
    } = options;

    const sessionPayload = await refreshConversationList({ silent: true });
    const pendingTasks = [];

    if (syncActiveFile) {
        const pathFromPayload = String(sessionPayload?.active_filename || "").trim();
        if (pathFromPayload) {
            pendingTasks.push(loadDatasetForPath(pathFromPayload, { silent: true, forceReload: true }));
        } else {
            pendingTasks.push(syncActiveSessionFile());
        }
    }

    if (Array.isArray(sessionPayload?.history)) {
        hydrateChatHistory(sessionPayload.history);
    } else {
        pendingTasks.push(loadChatHistory({ replace: true, silent: true }));
    }

    pendingTasks.push(updateUsageSummary({ silent: true }));

    if (clearDashboardFirst && typeof clearDashboard === "function") {
        clearDashboard();
    }
    if (typeof refreshDashboard === "function") {
        const shouldRefreshVisuals = typeof isVisualsViewActive !== "function" || isVisualsViewActive();
        if (shouldRefreshVisuals || clearDashboardFirst) {
            pendingTasks.push(refreshDashboard());
        }
    }

    await Promise.all(pendingTasks);
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

        const { response, data: result } = await fetchApiJson(`${App.API_BASE}/api/upload`, {
            method: "POST",
            headers: App.getAuthHeaders(),
            body: formData,
        });
        assertApiSuccess(response, result, "Upload failed");

        App.state.activeFile = {
            filename: result.path || result.filename,
            summary: result.summary,
        };

        const loadedFromServer = await loadDatasetForPath(result.path || result.filename, {
            silent: true,
            forceReload: true,
        });
        if (!loadedFromServer) {
            await loadFileIntoGrid(file);
        }
        showUploadSuccess(result);
        updateSidebarFileInfo(result.path || result.filename, result.summary);

        await refreshSessionDependentViews();

        fetchSmartQuestions();
        populateDataPreview(result.summary);

    } catch (error) {
        console.error("Upload error:", error);
        showUploadError(dropZone, error.message || "Upload failed");
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
            autoRowSize: true,
            autoColumnSize: {
                samplingRatio: 50,
                allowSampleDuplicates: false,
            },
            wordWrap: true,
            contextMenu: true,
            manualColumnResize: true,
            manualRowResize: true,
            filters: true,
            dropdownMenu: true,
            stretchH: "none",
            renderAllRows: false,
            viewportRowRenderingOffset: 20,
            viewportColumnRenderingOffset: 10,
            afterChange(changes, source) {
                if (!changes || source === "loadData") return;
                if (App.state.isSavingDataset) return;
                setDataSaveStatus("dirty");
            },
        });

        // Handsontable injects runtime CSS; force its color-scheme to light.
        enforceHandsontableLightScheme(gridContainer);
        setDataSaveStatus("clean");
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

    if (App.state.dataSaveStateTimer) {
        clearTimeout(App.state.dataSaveStateTimer);
        App.state.dataSaveStateTimer = null;
    }

    const infoEl = document.getElementById("sidebar-file-info");
    if (infoEl) infoEl.style.display = "none";

    const uploadContainer = document.getElementById("upload-container");
    const dataGridContainer = document.getElementById("data-grid-container");
    restoreUploadContainerMarkup();
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

    setDataSaveStatus("hidden");
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
        const summaryUrl = `${App.API_BASE}/api/data-summary/${encodePathForRoute(normalizedPath)}`;
        const fullDataUrl = `${App.API_BASE}/api/data/${encodePathForRoute(normalizedPath)}`;

        const [summaryResult, fullDataResult] = await Promise.all([
            fetchApiJson(summaryUrl, {
                headers: App.getAuthHeaders()
            }),
            fetchApiJson(fullDataUrl, {
                headers: App.getAuthHeaders()
            }),
        ]);

        const { response: summaryResp, data: summaryData } = summaryResult;
        assertApiSuccess(summaryResp, summaryData, "Failed to load dataset summary.");
        if (!summaryData.summary) {
            throw createUserFacingError("Failed to load dataset summary.");
        }

        const { response: fullDataResp, data: fullData } = fullDataResult;

        if (fullDataResp.ok && Array.isArray(fullData?.data)) {
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
    updateNewConversationButtonState();

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
        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/chat/sessions`, {
            headers: App.getAuthHeaders()
        });
        assertApiSuccess(response, data, "Failed to load conversations.");

        applySessionPayload(data);
        if (!App.state.activeSessionId && Array.isArray(App.state.chatSessions) && App.state.chatSessions.length > 0) {
            App.state.activeSessionId = App.state.chatSessions[0].id || null;
        }
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
    } else {
        // No file is bound to this session — reset the data connector panel.
        clearActiveFileUI();
    }
}

async function activateConversation(sessionId) {
    if (!sessionId) return;

    try {
        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}/activate`, {
            method: "POST",
            headers: App.getAuthHeaders(),
        });
        assertApiSuccess(response, data, "Failed to activate conversation.", { requireSuccessFlag: true });

        await applyConversationTransition(data);
    } catch (e) {
        showAppError(e.message || "Could not activate conversation.");
    }
}

async function applyConversationTransition(payload, options = {}) {
    const { clearDashboardFirst = false } = options;

    applySessionPayload(payload);

    const pendingTasks = [];
    if (Array.isArray(payload?.history)) {
        hydrateChatHistory(payload.history);
    } else {
        pendingTasks.push(loadChatHistory({ replace: true, silent: true }));
    }

    const activeFilename = String(payload?.active_filename || "").trim();
    if (activeFilename) {
        pendingTasks.push(loadDatasetForPath(activeFilename, { silent: true, forceReload: true }));
    } else {
        clearActiveFileUI();
    }

    if (clearDashboardFirst && typeof clearDashboard === "function") {
        clearDashboard();
    }

    if (typeof refreshDashboard === "function") {
        const shouldRefreshVisuals = typeof isVisualsViewActive !== "function" || isVisualsViewActive();
        if (shouldRefreshVisuals || clearDashboardFirst) {
            pendingTasks.push(refreshDashboard());
        }
    }

    pendingTasks.push(updateUsageSummary({ silent: true }));
    await Promise.all(pendingTasks);
}

function listKnownConversationFiles() {
    const fromSessions = (App.state.chatSessions || [])
        .map((session) => String(session?.filename || "").trim())
        .filter(Boolean);
    const active = String(App.state.activeFile?.filename || "").trim();
    if (active) fromSessions.push(active);
    return [...new Set(fromSessions)];
}

async function fetchUploadedFiles() {
    const { response, data } = await fetchApiJson(`${App.API_BASE}/api/files`, {
        headers: App.getAuthHeaders(),
    });
    assertApiSuccess(response, data, "Failed to load uploaded files.");
    return Array.isArray(data.files) ? data.files : [];
}

function showNewConversationError(message) {
    const errorEl = document.getElementById("new-conversation-error");
    if (!errorEl) return;
    if (!message) {
        errorEl.style.display = "none";
        errorEl.textContent = "";
        return;
    }
    errorEl.style.display = "block";
    errorEl.textContent = message;
}

function updateNewConversationModalState() {
    const selected = document.querySelector('input[name="new-conversation-source"]:checked')?.value || "blank";
    const existingSelect = document.getElementById("new-conversation-existing-file");
    const uploadNowWrap = document.getElementById("new-conversation-upload-now-wrap");

    if (existingSelect) {
        existingSelect.disabled = selected !== "existing";
    }
    if (uploadNowWrap) {
        uploadNowWrap.style.display = selected === "blank" ? "flex" : "none";
    }
}

function closeNewConversationModal() {
    const modal = document.getElementById("new-conversation-modal");
    if (!modal) return;
    modal.style.display = "none";
    showNewConversationError("");
}

async function openNewConversationModal() {
    const modal = document.getElementById("new-conversation-modal");
    const existingSelect = document.getElementById("new-conversation-existing-file");
    const currentRadio = document.getElementById("new-conversation-choice-current");
    const currentWrap = document.getElementById("new-conversation-choice-current-wrap");
    const existingRadio = document.getElementById("new-conversation-choice-existing");
    const blankRadio = document.getElementById("new-conversation-choice-blank");
    if (!modal || !existingSelect || !currentRadio || !existingRadio || !blankRadio || !currentWrap) return;

    const currentFile = String(App.state.activeFile?.filename || "").trim();
    currentRadio.disabled = !currentFile;
    currentWrap.style.opacity = currentFile ? "1" : "0.55";

    existingSelect.innerHTML = '<option value="">Loading uploaded files...</option>';

    try {
        const uploaded = await fetchUploadedFiles();
        const known = listKnownConversationFiles();
        const mergedFiles = [...new Set([...uploaded, ...known])];

        if (mergedFiles.length === 0) {
            existingSelect.innerHTML = '<option value="">No uploaded files found</option>';
            existingRadio.disabled = true;
        } else {
            existingRadio.disabled = false;
            existingSelect.innerHTML = mergedFiles
                .map((pathValue) => `<option value="${escapeAttr(pathValue)}">${escapeHtml(basenameFromPath(pathValue))}</option>`)
                .join("");
        }

        if (currentFile) {
            currentRadio.checked = true;
        } else if (mergedFiles.length > 0) {
            existingRadio.checked = true;
        } else {
            blankRadio.checked = true;
        }
    } catch (e) {
        existingSelect.innerHTML = '<option value="">Failed to load files</option>';
        existingRadio.disabled = true;
        blankRadio.checked = true;
        showNewConversationError(e.message || "Could not load uploaded files.");
    }

    modal.style.display = "flex";
    updateNewConversationModalState();
}

async function submitNewConversationSelection() {
    const selected = document.querySelector('input[name="new-conversation-source"]:checked')?.value || "blank";
    const existingSelect = document.getElementById("new-conversation-existing-file");
    const uploadNow = document.getElementById("new-conversation-upload-now")?.checked;
    const confirmBtn = document.getElementById("new-conversation-confirm-btn");

    const payload = {};
    if (selected === "current") {
        const currentFilename = String(App.state.activeFile?.filename || "").trim();
        if (!currentFilename) {
            showNewConversationError("No active dataset is available for this option.");
            return;
        }
        payload.filename = currentFilename;
        payload.use_active_file = true;
    } else if (selected === "existing") {
        const selectedFilename = String(existingSelect?.value || "").trim();
        if (!selectedFilename) {
            showNewConversationError("Select an uploaded dataset to continue.");
            return;
        }
        payload.filename = selectedFilename;
    } else {
        payload.filename = null;
    }

    try {
        showNewConversationError("");
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = "Creating...";
        }

        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/chat/sessions/new`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(payload),
        });
        assertApiSuccess(response, data, "Failed to create conversation.", { requireSuccessFlag: true });

        await applyConversationTransition(data, { clearDashboardFirst: true });
        closeNewConversationModal();

        if (selected === "blank" && uploadNow) {
            switchView("data");
            const fileInput = document.getElementById("file-input");
            if (fileInput) fileInput.click();
        }
    } catch (e) {
        showNewConversationError(e.message || "Could not create conversation.");
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = "Create";
        }
    }
}

function createNewConversation() {
    if (hasReachedChatSessionLimit()) {
        const maxSessions = getMaxChatSessions();
        showAppError(`You can keep up to ${maxSessions} conversations. Delete one before creating a new conversation.`);
        return;
    }
    openNewConversationModal();
}

async function deleteConversation(sessionId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    if (!sessionId) return;

    let confirmed = true;
    if (window.UIUtils && typeof window.UIUtils.confirm === "function") {
        confirmed = await window.UIUtils.confirm({
            title: "Delete conversation",
            message: "This conversation and its messages will be removed.",
            confirmText: "Delete",
            danger: true,
        });
    } else {
        showAppError("Confirmation dialog is unavailable right now. Please refresh and try again.");
        return;
    }
    if (!confirmed) return;

    try {
        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
            headers: App.getAuthHeaders(),
        });
        assertApiSuccess(response, data, "Failed to delete conversation.", { requireSuccessFlag: true });

        await applyConversationTransition(data, { clearDashboardFirst: true });
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
    const { silent = false, force = false } = options;

    const now = Date.now();
    if (!force && (now - lastUsageSummaryAt) < USAGE_SUMMARY_MIN_INTERVAL_MS) {
        return App.state.lastUsageSummary || null;
    }

    try {
        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/usage/summary`, {
            headers: App.getAuthHeaders()
        });
        assertApiSuccess(response, data, "Failed to fetch usage summary.");

        renderUsageSummary(data);
        lastUsageSummaryAt = now;
        App.state.lastUsageSummary = data;
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

    if (!document.hidden) {
        updateUsageSummary({ silent: true, force: true });
    }

    usageRefreshTimer = setInterval(() => {
        if (document.hidden) return;
        updateUsageSummary({ silent: true });
    }, USAGE_SUMMARY_POLL_INTERVAL_MS);

    if (!startUsageSummaryAutoRefresh._boundVisibilityListener) {
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                updateUsageSummary({ silent: true, force: true });
            }
        });
        startUsageSummaryAutoRefresh._boundVisibilityListener = true;
    }
}

async function checkExistingFiles() {
    try {
        await refreshSessionDependentViews({ syncActiveFile: true });
    } catch (e) {
        console.log("Backend not available yet:", e.message);
    }
}

function bindNewConversationModalControls() {
    const modal = document.getElementById("new-conversation-modal");
    if (!modal || modal.dataset.bound === "true") return;

    const radios = modal.querySelectorAll('input[name="new-conversation-source"]');
    radios.forEach((radio) => {
        radio.addEventListener("change", updateNewConversationModalState);
    });

    modal.addEventListener("click", (event) => {
        if (event.target === modal) {
            closeNewConversationModal();
        }
    });

    modal.dataset.bound = "true";
}

async function initializeDashboardSidebarState() {
    captureDefaultUploadMarkup();
    bindNewConversationModalControls();
    await checkExistingFiles();
    startUsageSummaryAutoRefresh();
}

function setChatComposerBusyState(inputEl, sendBtn, isBusy) {
    if (inputEl) {
        inputEl.disabled = isBusy;
    }
    if (sendBtn) {
        sendBtn.disabled = isBusy || !inputEl || !inputEl.value.trim();
    }
    if (!isBusy && inputEl) {
        inputEl.focus();
    }
}

function buildChatStreamPayload(message, skipCache) {
    return {
        message,
        filename: App.state.activeFile ? App.state.activeFile.filename : null,
        skip_cache: skipCache,
        session_id: App.state.activeSessionId || null,
    };
}

function applyChatStreamEvent(eventName, payload, streamState) {
    if (eventName === "phase") {
        updateTypingPhase(payload.message || payload.phase);
        return;
    }

    if (eventName === "result") {
        streamState.finalResult = payload;
        return;
    }

    if (eventName === "error") {
        throw createUserFacingError(payload.text || "An error occurred.");
    }
}

function normalizeSSEChunk(chunkText) {
    return String(chunkText || "").replace(/\r\n/g, "\n");
}

function parseSSEFrame(frameText) {
    const lines = frameText.split("\n");
    let eventName = "";
    const dataLines = [];

    for (const rawLine of lines) {
        if (!rawLine || rawLine.startsWith(":")) {
            continue;
        }

        const separatorIndex = rawLine.indexOf(":");
        const fieldName = separatorIndex >= 0 ? rawLine.slice(0, separatorIndex) : rawLine;
        let fieldValue = separatorIndex >= 0 ? rawLine.slice(separatorIndex + 1) : "";
        if (fieldValue.startsWith(" ")) {
            fieldValue = fieldValue.slice(1);
        }

        if (fieldName === "event") {
            eventName = fieldValue.trim();
            continue;
        }

        if (fieldName === "data") {
            dataLines.push(fieldValue);
        }
    }

    if (!eventName || dataLines.length === 0) {
        return null;
    }

    return {
        eventName,
        dataText: dataLines.join("\n"),
        dataLines,
    };
}

function parseSSEJsonPayload(frame) {
    try {
        return JSON.parse(frame.dataText);
    } catch (primaryError) {
        // Some backends may split string values across multiple SSE data lines.
        if (frame.dataLines.length <= 1) {
            throw primaryError;
        }

        try {
            return JSON.parse(frame.dataLines.join("\\n"));
        } catch {
            throw primaryError;
        }
    }
}

function consumeSSEFrames(bufferText, onFrame) {
    let buffer = bufferText;
    let boundaryIndex = buffer.indexOf("\n\n");

    while (boundaryIndex !== -1) {
        const frameText = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);

        if (frameText.trim()) {
            onFrame(frameText);
        }

        boundaryIndex = buffer.indexOf("\n\n");
    }

    return buffer;
}

async function readChatStreamResult(response) {
    const reader = response.body?.getReader();
    if (!reader) {
        throw createUserFacingError("No response stream was returned.");
    }

    const decoder = new TextDecoder();
    const streamState = { finalResult: null };
    let buffer = "";

    const handleFrame = (frameText) => {
        const frame = parseSSEFrame(frameText);
        if (!frame) {
            return;
        }

        let payload;
        try {
            payload = parseSSEJsonPayload(frame);
        } catch (error) {
            console.warn("SSE parse error:", error);
            return;
        }

        applyChatStreamEvent(frame.eventName, payload, streamState);
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += normalizeSSEChunk(decoder.decode(value, { stream: true }));
        buffer = consumeSSEFrames(buffer, handleFrame);
    }

    buffer += normalizeSSEChunk(decoder.decode());
    buffer = consumeSSEFrames(buffer, handleFrame);

    if (buffer.trim()) {
        handleFrame(buffer);
    }

    return streamState.finalResult;
}

// ============================================================
// Chat — Gemini Integration
// ============================================================
async function sendMessage(skipCache = false) {
    const input = document.getElementById("chat-input");
    if (!input) return;

    const sendBtn = document.getElementById("send-btn");
    const message = input.value.trim();
    if (!message || App.state.isWaitingForAI) return;

    // Clear input
    input.value = "";
    input.style.height = "auto";

    // Switch to message view (hide hero)
    showChatMessages();

    // Disable inputs to prevent multi-sends
    setChatComposerBusyState(input, sendBtn, true);

    // Add user message
    appendChatMessage("user", message);

    // Show typing indicator
    App.state.isWaitingForAI = true;
    showTypingIndicator();

    try {
        const response = await fetch(`${App.API_BASE}/api/chat/stream`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(buildChatStreamPayload(message, skipCache)),
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw createUserFacingError(errData.text || errData.error || "An unexpected error occurred.");
        }

        const finalResult = await readChatStreamResult(response);

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
        if (error && error.userFacing) {
            appendErrorMessage(error.message || "An error occurred.");
        } else {
            appendErrorMessage(
                `Could not connect to the backend. Make sure \`server.py\` is running.\n\n\`${error.message}\``
            );
        }
    } finally {
        App.state.isWaitingForAI = false;
        setChatComposerBusyState(input, sendBtn, false);
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
        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/chat/history`, {
            headers: App.getAuthHeaders()
        });
        assertApiSuccess(response, data, "Could not load chat history.");

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
        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/chat/clear`, {
            method: "POST",
            headers: App.getAuthHeaders()
        });
        assertApiSuccess(response, data, "Failed to clear chat history.", { requireSuccessFlag: true });

        resetChatMessagesUI();
        showChatHero();
        clearActiveFileUI();

        App.state.chatSessions = [];
        App.state.activeSessionId = null;

        // Clear dashboard widgets
        if (typeof clearDashboard === 'function') {
            clearDashboard();
        }

        await refreshSessionDependentViews();

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
function resizeChatPlotlyCharts(chatContainer) {
    chatContainer.querySelectorAll('[id^="chat-chart-"]').forEach((chartEl) => {
        if (chartEl._fullLayout) {
            Plotly.Plots.resize(chartEl);
        }
    });
}

function createChatPlotlyResizeScheduler(chatContainer) {
    const state = {
        rafId: 0,
        width: 0,
        height: 0,
    };

    const scheduleResize = () => {
        const rect = chatContainer.getBoundingClientRect();
        const nextWidth = Math.round(rect.width);
        const nextHeight = Math.round(rect.height);
        const sizeChanged = nextWidth !== state.width || nextHeight !== state.height;

        if (!sizeChanged && state.rafId === 0) {
            return;
        }

        state.width = nextWidth;
        state.height = nextHeight;

        if (state.rafId !== 0) {
            return;
        }

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

window.addEventListener("beforeunload", () => {
    if (usageRefreshTimer) {
        clearInterval(usageRefreshTimer);
        usageRefreshTimer = null;
    }
});
