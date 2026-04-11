// data-chat.js — Top-level glue and shared helpers.
// Module-specific logic lives in chat-render.js, chat.js, sessions.js, upload.js, usage.js.

// --- Path helpers ---

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

function escapeAttr(str) {
    return String(str ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/\r/g, "")
        .replace(/\n/g, "\\n")
        .replace(/'/g, "\\'")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// --- Error display ---

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

// --- Dashboard sidebar initialization (entry point called from core.js DOMContentLoaded) ---

async function checkExistingFiles() {
    try {
        await refreshSessionDependentViews({ syncActiveFile: true });
    } catch (e) {
        console.log("Backend not available yet:", e.message);
    }
}

async function initializeDashboardSidebarState() {
    captureDefaultUploadMarkup();
    bindNewConversationModalControls();
    await checkExistingFiles();
    startUsageSummaryAutoRefresh();
}
