// Centralized browser auth helper for Data Talk.
// Uses httpOnly cookies for auth and keeps only non-sensitive user info in sessionStorage.
(function initAuthClient(window) {
    const API_BASE = window.location.origin;
    const LEGACY_STORAGE_KEYS = ["dt_access_token", "dt_refresh_token", "dt_user"];
    const SESSION_USER_KEY = "dt_user_session";

    // Clears legacy authentication tokens from localStorage to keep credentials secure.
    function clearLegacyStorage() {
        LEGACY_STORAGE_KEYS.forEach((key) => {
            try {
                localStorage.removeItem(key);
            } catch (_) {
                // Ignore storage access errors (private mode / blocked storage).
            }
        });
    }

    // Removes the temporarily cached user object from sessionStorage on signout or expiry.
    function clearCachedUser() {
        try {
            sessionStorage.removeItem(SESSION_USER_KEY);
        } catch (_) {
            // Ignore storage access errors.
        }
    }

    // Caches non-sensitive user metadata in sessionStorage for instant UI responsiveness.
    function setCachedUser(user) {
        if (!user || typeof user !== "object") {
            clearCachedUser();
            return;
        }

        try {
            sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
        } catch (_) {
            // Ignore storage access errors.
        }
    }

    // Retrieves and parses the temporarily cached user metadata for UI rendering.
    function getCachedUser() {
        try {
            const raw = sessionStorage.getItem(SESSION_USER_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    // Utility to construct HTTP request headers, merging them with any custom parameters.
    function getAuthHeaders(extra = {}) {
        return {
            ...extra, //spread operator, unpack all key prop from exist obje to new
        };
    }

    // Wrapper for the native fetch API to automatically parse JSON and pass credentials.
    async function fetchJson(path, options = {}) {
        const response = await fetch(`${API_BASE}${path}`, {
            credentials: "same-origin",
            ...options, //spread operator, unpack all key prop from exist obje to new
        });
        const data = await response.json().catch(() => ({}));
        return { response, data };
    }

    // Validates the current session status with the backend and updates the cached user info.
    async function getSession() {
        try {
            const { response, data } = await fetchJson("/api/auth/session", {
                headers: getAuthHeaders(),
            });
            if (!response.ok || !data.valid || !data.user) {
                clearCachedUser();
                return null;
            }
            setCachedUser(data.user);
            return data.user;
        } catch (_) {
            return null;
        }
    }

    // Performs backend logout API call, destroys all local session states, and redirects to login page.
    async function signOut(options = {}) {
        const { redirect = true } = options;

        try {
            await fetchJson("/api/auth/logout", {
                method: "POST",
                headers: getAuthHeaders(),
            });
        } catch (_) {
            // Always proceed with local cleanup to avoid sticky client state.
        } finally {
            clearCachedUser();
            clearLegacyStorage();
            if (redirect) {
                window.location.href = "login.html";
            }
        }
    }

    clearLegacyStorage();

    // Exposes the public authentication API to the global window scope for other scripts to access.
    window.AuthClient = {
        API_BASE,
        clearLegacyStorage,
        clearCachedUser,
        setCachedUser,
        getCachedUser,
        getAuthHeaders,
        getSession,
        signOut,
    };
})(window);
