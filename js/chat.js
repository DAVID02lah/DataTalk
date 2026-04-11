// Chat messaging — SSE streaming, message send/receive, history load/clear.

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

// --- SSE frame parsing ---

function normalizeSSEChunk(chunkText) {
    return String(chunkText || "").replace(/\r\n/g, "\n");
}

function parseSSEFrame(frameText) {
    const lines = frameText.split("\n");
    let eventName = "";
    const dataLines = [];

    for (const rawLine of lines) {
        if (!rawLine || rawLine.startsWith(":")) continue;

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

    if (!eventName || dataLines.length === 0) return null;

    return { eventName, dataText: dataLines.join("\n"), dataLines };
}

function parseSSEJsonPayload(frame) {
    try {
        return JSON.parse(frame.dataText);
    } catch (primaryError) {
        // Some backends split string values across multiple SSE data lines.
        if (frame.dataLines.length <= 1) throw primaryError;

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
        if (!frame) return;

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

// --- Send message ---

async function sendMessage(skipCache = false) {
    const input = document.getElementById("chat-input");
    if (!input) return;

    const sendBtn = document.getElementById("send-btn");
    const message = input.value.trim();
    if (!message || App.state.isWaitingForAI) return;

    input.value = "";
    input.style.height = "auto";

    showChatMessages();
    setChatComposerBusyState(input, sendBtn, true);
    appendChatMessage("user", message);

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
    const text = chip.textContent.replace(/^[^\w]+/, "").trim();
    const input = document.getElementById("chat-input");
    if (input) {
        input.value = text;
        sendMessage();
    }
}

function useFollowup(chip) {
    const text = chip.textContent.trim();
    const input = document.getElementById("chat-input");
    if (input) {
        input.value = text;
        sendMessage();
    }
}

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

// --- Chat history ---

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

        showChatMessages();

        // API returns newest-first; reverse for chronological UI order.
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

        if (typeof clearDashboard === 'function') {
            clearDashboard();
        }

        await refreshSessionDependentViews();

    } catch (e) {
        console.error("Error clearing chat:", e);
        showAppError(e.message || "Error clearing chat history.");
    }
}
