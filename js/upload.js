// File upload, grid initialization, dataset loading and saving.

let defaultUploadContainerMarkup = null;

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

// --- Data editor toolbar ---

function setDataEditorVisibility(isVisible) {
    const toolbar = document.getElementById("data-editor-toolbar");
    if (!toolbar) return;
    toolbar.style.display = isVisible ? "flex" : "none";
}

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

// --- Grid data ---

function getGridDataForSave() {
    if (!App.state.hot) return [];
    const data = App.state.hot.getData();
    return Array.isArray(data) ? data : [];
}

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

        await loadDatasetForPath(activeFilename, { silent: true, forceReload: true });

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

// --- Upload UI states ---

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
        <div class="upload-next-steps">
            <div class="next-steps-header">
                <span class="next-steps-icon">🚀</span>
                <h4>What's Next?</h4>
            </div>
            <ol class="next-steps-list">
                <li><strong>Chat Analysis</strong> — Ask questions about your data in natural language</li>
                <li><strong>Visualisations</strong> — Pin charts to a dashboard canvas</li>
            </ol>
            <button class="btn btn-primary next-steps-cta" id="goto-chat-btn" onclick="switchView('chat')">
                Start Analysing →
            </button>
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
        retryBtn.addEventListener("click", () => fileInput.click());
    }
    if (fileInput) {
        fileInput.addEventListener("change", function () {
            handleFileUpload(this.files);
        });
    }
}

// --- Grid rendering ---

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

    if (Array.isArray(preview[0])) return preview;

    if (typeof preview[0] === "object" && preview[0] !== null) {
        const columns = Array.isArray(summary?.columns)
            ? summary.columns
            : Object.keys(preview[0]);
        const rows = preview.map((row) => columns.map((col) => row?.[col] ?? ""));
        return [columns, ...rows];
    }

    return [];
}

// --- Sidebar file info ---

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

    const uploadSuccessBanner = document.getElementById("upload-success-banner");
    if (uploadSuccessBanner) {
        uploadSuccessBanner.style.display = "none";
        uploadSuccessBanner.innerHTML = "";
    }

    const suggestionChips = document.getElementById("suggestion-chips");
    if (suggestionChips) {
        suggestionChips.innerHTML = "";
    }
    App.state.lastSuggestedQuestionsFile = null;

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

    if (typeof fetchSmartQuestions === 'function') {
        fetchSmartQuestions({ force: true });
    }
}

// --- Dataset loading from backend ---

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
        // Fetch only the first page to keep initial load fast and memory-bounded.
        const fullDataUrl = `${App.API_BASE}/api/data/${encodePathForRoute(normalizedPath)}?page=1&per_page=200`;

        const [summaryResult, fullDataResult] = await Promise.all([
            fetchApiJson(summaryUrl, { headers: App.getAuthHeaders() }),
            fetchApiJson(fullDataUrl, { headers: App.getAuthHeaders() }),
        ]);

        const { response: summaryResp, data: summaryData } = summaryResult;
        assertApiSuccess(summaryResp, summaryData, "Failed to load dataset summary.");
        if (!summaryData.summary) {
            throw createUserFacingError("Failed to load dataset summary.");
        }

        const { response: fullDataResp, data: fullData } = fullDataResult;

        if (fullDataResp.ok && Array.isArray(fullData?.data)) {
            loadGrid(fullData.data || []);
            // Append remaining pages in the background so the grid is
            // immediately interactive while extra rows stream in.
            if (fullData.total_pages > 1) {
                loadRemainingPages(normalizedPath, fullData);
            }
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

async function loadRemainingPages(filePath, firstPageResult) {
    const { total_pages, per_page } = firstPageResult;
    if (!App.state.hot || total_pages <= 1) return;

    for (let page = 2; page <= total_pages; page++) {
        // Stop appending if the user navigated away from this file.
        if (App.state.activeFile?.filename !== filePath) break;

        try {
            const url = `${App.API_BASE}/api/data/${encodePathForRoute(filePath)}?page=${page}&per_page=${per_page}`;
            const { response, data } = await fetchApiJson(url, {
                headers: App.getAuthHeaders(),
            });
            if (!response.ok || !Array.isArray(data?.data)) break;

            const currentData = App.state.hot.getData();
            const merged = [...currentData, ...data.data];
            App.state.hot.loadData(merged);
        } catch (e) {
            console.warn(`Background page ${page} load failed:`, e);
            break;
        }
    }
}

function getMaxUploadSizeMb() {
    const configuredMax = Number(App.state.maxUploadMb);
    if (Number.isFinite(configuredMax) && configuredMax > 0) {
        return configuredMax;
    }
    return null;
}

// --- Main upload handler ---

async function handleFileUpload(files) {
    const file = files[0];
    if (!file) return;

    const maxSizeMb = getMaxUploadSizeMb();
    if (maxSizeMb !== null && file.size > maxSizeMb * 1024 * 1024) {
        showUploadError(
            document.getElementById("upload-container"),
            `File size exceeds ${maxSizeMb}MB limit. Please upload a smaller dataset.`
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
