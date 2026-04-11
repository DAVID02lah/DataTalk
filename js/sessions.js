// Conversation session management — list, create, activate, delete sessions.

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

// --- Payload application ---

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

// --- Conversation list rendering ---

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

// --- API interactions ---

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
        await loadDatasetForPath(path, { silent: true, forceReload: true });
    } else {
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

// --- Create / Delete ---

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

// --- New Conversation Modal ---

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
