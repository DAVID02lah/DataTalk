// Shared UI helpers for dashboard interactions.
(function initUiUtils(window) {
    function fallbackConfirm(options = {}) {
        console.warn("Confirmation modal is unavailable.", options);
        return Promise.resolve(false);
    }

    function confirmDialog(options = {}) {
        const modal = document.getElementById("confirm-modal");
        const titleEl = document.getElementById("confirm-modal-title");
        const messageEl = document.getElementById("confirm-modal-message");
        const confirmBtn = document.getElementById("confirm-modal-confirm");
        const cancelBtn = document.getElementById("confirm-modal-cancel");
        const closeBtn = document.getElementById("confirm-modal-close");

        if (!modal || !titleEl || !messageEl || !confirmBtn || !cancelBtn || !closeBtn) {
            return fallbackConfirm(options);
        }

        const {
            title = "Confirm",
            message = "Are you sure you want to continue?",
            confirmText = "Confirm",
            cancelText = "Cancel",
            danger = false,
        } = options;

        titleEl.textContent = title;
        messageEl.textContent = message;
        confirmBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;
        confirmBtn.classList.toggle("btn-dashboard-danger", !!danger);

        return new Promise((resolve) => {
            let resolved = false;

            function finish(value) {
                if (resolved) return;
                resolved = true;
                cleanup();
                resolve(value);
            }

            function onEscape(event) {
                if (event.key === "Escape") {
                    finish(false);
                }
            }

            function cleanup() {
                modal.style.display = "none";
                document.removeEventListener("keydown", onEscape);
                confirmBtn.removeEventListener("click", onConfirm);
                cancelBtn.removeEventListener("click", onCancel);
                closeBtn.removeEventListener("click", onCancel);
                modal.removeEventListener("click", onOverlayClick);
            }

            function onConfirm() {
                finish(true);
            }

            function onCancel() {
                finish(false);
            }

            function onOverlayClick(event) {
                if (event.target === modal) {
                    finish(false);
                }
            }

            confirmBtn.addEventListener("click", onConfirm);
            cancelBtn.addEventListener("click", onCancel);
            closeBtn.addEventListener("click", onCancel);
            modal.addEventListener("click", onOverlayClick);
            document.addEventListener("keydown", onEscape);

            modal.style.display = "flex";
            confirmBtn.focus();
        });
    }

    // --- Shared API fetch helpers (used by data-chat and dashboard-ui) ---

    function createUserFacingError(message) {
        const err = new Error(message || "An unexpected error occurred.");
        err.userFacing = true;
        return err;
    }

    async function fetchApiJson(url, options = {}) {
        const response = await fetch(url, options);
        let data;
        try {
            data = await response.json();
        } catch (e) {
            data = {};
            if (!response.ok) {
                // If it fails to parse JSON and the status is an error, try to capture the text or status.
                data.error = `HTTP ${response.status} ${response.statusText}`;
            }
        }
        return { response, data };
    }

    function assertApiSuccess(response, data, fallbackMessage, options = {}) {
        const { requireSuccessFlag = false } = options;
        const failed = !response.ok || data.error || (requireSuccessFlag && data.success === false);
        if (failed) {
            throw createUserFacingError(data.text || data.error || fallbackMessage);
        }
    }

    window.UIUtils = {
        confirm: confirmDialog,
        createUserFacingError,
        fetchApiJson,
        assertApiSuccess,
    };

    // Expose as bare globals — called unqualified throughout the codebase.
    window.createUserFacingError = createUserFacingError;
    window.fetchApiJson = fetchApiJson;
    window.assertApiSuccess = assertApiSuccess;
})(window);
