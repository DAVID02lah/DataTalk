// KPI card modal — add/remove statistical cards to the dashboard.

function formatAggregationLabel(aggregation = 'count') {
    const safe = String(aggregation || 'count');
    return safe.charAt(0).toUpperCase() + safe.slice(1);
}

function setCardModalError(errorEl, message = '') {
    if (!errorEl) return;
    if (!message) {
        errorEl.style.display = 'none';
        return;
    }
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

function setCardSubmitButtonState(buttonEl, isBusy) {
    if (!buttonEl) return;
    buttonEl.disabled = isBusy;
    buttonEl.innerHTML = isBusy ? 'Adding...' : 'Add Card';
}

async function loadCardColumns() {
    if (App.state.activeFile?.summary?.columns) {
        return App.state.activeFile.summary.columns;
    }

    if (!App.state.activeFile?.filename) {
        return [];
    }

    const { response, data } = await fetchApiJson(`${App.API_BASE}/api/data-summary/${encodeURIComponent(App.state.activeFile.filename)}`, {
        headers: App.getAuthHeaders()
    });
    if (!response.ok) {
        return [];
    }
    return data.summary?.columns || [];
}

function buildDashboardCard({ column, aggregation, title, value }) {
    const aggLabel = formatAggregationLabel(aggregation);
    return {
        id: `card_${Date.now()}`,
        column,
        aggregation,
        title: title || `${aggLabel} of ${column}`,
        value,
    };
}

// --- Modal ---

async function showAddCardModal() {
    const modal = document.getElementById("add-card-modal");
    const titleInput = document.getElementById("card-title-input");
    const errorEl = document.getElementById("card-add-error");

    if (modal) modal.style.display = "flex";
    if (titleInput) titleInput.value = "";
    if (errorEl) errorEl.style.display = "none";

    const colSelect = document.getElementById("card-column-select");
    if (!colSelect) return;

    colSelect.innerHTML = '<option value="">Loading columns...</option>';

    try {
        const columns = await loadCardColumns();

        if (columns.length > 0) {
            colSelect.innerHTML = '<option value="">Select a column...</option>' +
                columns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        } else {
            colSelect.innerHTML = '<option value="">No columns available — upload a dataset first</option>';
        }
    } catch (e) {
        console.error('Failed to load columns:', e);
        colSelect.innerHTML = '<option value="">Error loading columns</option>';
    }
}

function closeAddCardModal() {
    const modal = document.getElementById("add-card-modal");
    if (modal) modal.style.display = "none";
}

async function submitAddCard() {
    const colSelect = document.getElementById("card-column-select");
    const aggSelect = document.getElementById("card-agg-select");
    const titleInput = document.getElementById("card-title-input");
    const errEl = document.getElementById("card-add-error");
    const btn = document.getElementById("btn-submit-card");

    const column = colSelect ? colSelect.value : '';
    const aggregation = aggSelect ? aggSelect.value : 'count';
    const title = titleInput ? titleInput.value.trim() : '';

    if (!column) {
        setCardModalError(errEl, 'Please select a column.');
        return;
    }

    setCardSubmitButtonState(btn, true);
    setCardModalError(errEl);

    try {
        const { response, data } = await fetchApiJson(`${App.API_BASE}/api/dashboard/card-data`, {
            method: "POST",
            headers: App.getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                column,
                aggregation,
                session_id: getDashboardSessionId ? getDashboardSessionId() : undefined
            })
        });

        assertApiSuccess(response, data, 'Failed to fetch card data.');
        const newCard = buildDashboardCard({
            column,
            aggregation,
            title,
            value: data.value,
        });

        if (!App.state.dashboardCards) App.state.dashboardCards = [];
        App.state.dashboardCards.push(newCard);
        await saveDashboardToBackend();

        closeAddCardModal();
        renderDashboardGrid();

    } catch (e) {
        console.error('Failed to add card:', e);
        setCardModalError(errEl, e.message || 'Network error while connecting to server.');
    } finally {
        setCardSubmitButtonState(btn, false);
    }
}
