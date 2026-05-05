/**
 * js/inactivity-timer.js
 * 
 * Monitors user interaction to automatically log out idle sessions.
 * WHY: This protects the user's data and session security if they leave their device unattended.
 */

(function initInactivityTimer(window) {
    const INACTIVITY_LIMIT_MS = 10 * 60 * 1000; // 10 minutes
    const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
    const THROTTLE_LIMIT_MS = 1000; // 1 second

    let lastActiveTime = Date.now();
    let checkIntervalId = null;
    let throttleTimeoutId = null;

    /**
     * Updates the last active timestamp. Throttled to prevent performance
     * degradation from high-frequency events like 'mousemove' and 'scroll'.
     * WHY: Processing every single mouse movement or scroll causes layout thrashing and high CPU usage.
     */
    function updateActivityTime() {
        if (throttleTimeoutId) return;

        // Leading-edge throttle: update the timestamp IMMEDIATELY so
        // checkInactivity() never sees a stale value while the user is active.
        // The timeout only suppresses redundant follow-up events for performance.
        lastActiveTime = Date.now();
        throttleTimeoutId = setTimeout(() => {
            throttleTimeoutId = null;
        }, THROTTLE_LIMIT_MS);
    }

    /**
     * Checks if the inactivity duration has exceeded the limit.
     * Logs the user out if the limit is breached.
     * WHY: We run this periodically to ensure expiry handles gracefully and consistently.
     */
    function checkInactivity() {
        const timeIdle = Date.now() - lastActiveTime;
        if (timeIdle > INACTIVITY_LIMIT_MS) {
            handleSessionTimeout();
        }
    }

    /**
     * Triggers the sign-out process.
     * WHY: Extracted to a separate function for clean abstraction.
     */
    function handleSessionTimeout() {
        stopMonitoring();
        if (window.AuthClient && typeof window.AuthClient.signOut === "function") {
            // Passing redirect:true ensures the user is cleanly routed back to login.html
            window.AuthClient.signOut({ redirect: true });
        } else {
            // Fallback if AuthClient somehow unloads
            window.location.href = "login.html";
        }
    }

    /**
     * Attaches global event listeners for user activity.
     * WHY: We capture multiple modes of interaction (mouse, keyboard, touch) to correctly identify active use.
     */
    function startMonitoring() {
        // We use passive listeners for scrolling and touch to not block main thread rendering
        const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel"];
        events.forEach(event => {
            document.addEventListener(event, updateActivityTime, { passive: true });
        });

        checkIntervalId = setInterval(checkInactivity, CHECK_INTERVAL_MS);
    }

    /**
     * Detaches global event listeners and intervals.
     * WHY: Clean-up prevents memory leaks when the service is stopped or page unloads.
     */
    function stopMonitoring() {
        const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel"];
        events.forEach(event => {
            document.removeEventListener(event, updateActivityTime);
        });

        if (checkIntervalId) {
            clearInterval(checkIntervalId);
            checkIntervalId = null;
        }
        if (throttleTimeoutId) {
            clearTimeout(throttleTimeoutId);
            throttleTimeoutId = null;
        }
    }

    // Initialize automatically when loaded
    startMonitoring();

    // Export module just in case manual management is required elsewhere (like turning it off in specific views)
    window.InactivityTimer = {
        start: startMonitoring,
        stop: stopMonitoring,
        updateActivityTime
    };

})(window);
