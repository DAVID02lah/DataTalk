// Usage tracking — sidebar budget/token display and auto-refresh.

let usageRefreshTimer = null;
let lastUsageSummaryAt = 0;

const USAGE_SUMMARY_MIN_INTERVAL_MS = 30_000;
const USAGE_SUMMARY_POLL_INTERVAL_MS = 60_000;

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

    // Only bind the visibility listener once across the life of the page.
    if (!startUsageSummaryAutoRefresh._boundVisibilityListener) {
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                updateUsageSummary({ silent: true, force: true });
            }
        });
        startUsageSummaryAutoRefresh._boundVisibilityListener = true;
    }
}

// Clean up the polling timer when the page unloads.
window.addEventListener("beforeunload", () => {
    if (usageRefreshTimer) {
        clearInterval(usageRefreshTimer);
        usageRefreshTimer = null;
    }
});
