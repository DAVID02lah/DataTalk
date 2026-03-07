// ============================================================
// script.js — Data Talk Frontend Logic
// ============================================================
// Handles: Particle animation, file upload (to backend), Gemini chat,
//          chart rendering, and dashboard pinning.
// ============================================================

const API_BASE = "http://localhost:5000";

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function sanitizeHtml(value) {
    const raw = String(value ?? "");
    if (window.DOMPurify) {
        return window.DOMPurify.sanitize(raw);
    }
    return escapeHtml(raw);
}

function renderMarkdown(text) {
    try {
        return sanitizeHtml(marked.parse(text || ""));
    } catch (e) {
        return `<p>${escapeHtml(text || "")}</p>`;
    }
}

// --- Particle Canvas Animation ---
const canvas = document.getElementById("particle-canvas");
let ctx;
let particlesArray;

if (canvas) {
    ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    particlesArray = [];
}

let particleColor = "rgba(0, 0, 0, 0.5)";

let mouse = {
    x: null,
    y: null,
    radius: canvas ? (canvas.height / 80) * (canvas.width / 80) : 100,
};

window.addEventListener("mousemove", (event) => {
    mouse.x = event.x;
    mouse.y = event.y;
});

class Particle {
    constructor(x, y, directionX, directionY, size, color) {
        this.x = x;
        this.y = y;
        this.directionX = directionX;
        this.directionY = directionY;
        this.size = size;
        this.color = color;
    }
    draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2, false);
        ctx.fillStyle = this.color;
        ctx.fill();
    }
    update() {
        if (this.x > canvas.width || this.x < 0) this.directionX = -this.directionX;
        if (this.y > canvas.height || this.y < 0) this.directionY = -this.directionY;
        let dx = mouse.x - this.x;
        let dy = mouse.y - this.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < mouse.radius + this.size) {
            if (mouse.x < this.x && this.x < canvas.width - this.size * 10) this.x += 10;
            if (mouse.x > this.x && this.x > this.size * 10) this.x -= 10;
            if (mouse.y < this.y && this.y < canvas.height - this.size * 10) this.y += 10;
            if (mouse.y > this.y && this.y > this.size * 10) this.y -= 10;
        }
        this.x += this.directionX;
        this.y += this.directionY;
        this.draw();
    }
}

function initParticles() {
    particlesArray = [];
    let numberOfParticles = (canvas.height * canvas.width) / 9000;
    for (let i = 0; i < numberOfParticles; i++) {
        let size = Math.random() * 5 + 1;
        let x = Math.random() * (innerWidth - size * 4) + size * 2;
        let y = Math.random() * (innerHeight - size * 4) + size * 2;
        let directionX = Math.random() * 2 - 1;
        let directionY = Math.random() * 2 - 1;
        particlesArray.push(new Particle(x, y, directionX, directionY, size, particleColor));
    }
}

function connectParticles() {
    for (let a = 0; a < particlesArray.length; a++) {
        for (let b = a; b < particlesArray.length; b++) {
            let distance =
                (particlesArray[a].x - particlesArray[b].x) ** 2 +
                (particlesArray[a].y - particlesArray[b].y) ** 2;
            if (distance < (canvas.width / 7) * (canvas.height / 7)) {
                let opacity = 1 - distance / 20000;
                ctx.strokeStyle = particleColor.replace("0.5)", opacity + ")");
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(particlesArray[a].x, particlesArray[a].y);
                ctx.lineTo(particlesArray[b].x, particlesArray[b].y);
                ctx.stroke();
            }
        }
    }
}

function animateParticles() {
    if (!canvas) return;
    requestAnimationFrame(animateParticles);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = 0; i < particlesArray.length; i++) {
        particlesArray[i].update();
    }
    connectParticles();
}

window.addEventListener("resize", () => {
    if (canvas) {
        canvas.width = innerWidth;
        canvas.height = innerHeight;
        mouse.radius = (canvas.height / 80) ** 2;
        initParticles();
    }
});

// ============================================================
// App State
// ============================================================
let activeFile = null;       // { filename, summary }
let chatMessages = [];       // Array of { role, text, chart }
let hot = null;              // Handsontable instance
let isWaitingForAI = false;  // Prevents double-sends

// ============================================================
// DOM Ready
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
    // --- Particles ---
    if (canvas) {
        initParticles();
        animateParticles();
    }

    // --- File Upload (Drag & Drop + Click) ---
    const dropZone = document.getElementById("upload-container");
    const fileInput = document.getElementById("file-input");
    const gridContainer = document.getElementById("data-grid-container");

    if (dropZone) {
        ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) =>
            dropZone.addEventListener(ev, preventDefaults, false)
        );
        ["dragenter", "dragover"].forEach((ev) =>
            dropZone.addEventListener(ev, () => {
                dropZone.style.background = "rgba(66, 133, 244, 0.1)";
                dropZone.style.borderColor = "#4285f4";
            }, false)
        );
        ["dragleave", "drop"].forEach((ev) =>
            dropZone.addEventListener(ev, () => {
                dropZone.style.background = "rgba(255, 255, 255, 0.3)";
                dropZone.style.borderColor = "#dadce0";
            }, false)
        );
        dropZone.addEventListener("drop", (e) => {
            handleFileUpload(e.dataTransfer.files);
        }, false);
    }

    if (fileInput) {
        fileInput.addEventListener("change", function () {
            handleFileUpload(this.files);
        });
    }

    // --- Chat Input (Enter to send) ---
    const chatInput = document.getElementById("chat-input");
    const chatSendBtn = document.getElementById("send-btn");

    if (chatInput) {
        if (chatSendBtn) chatSendBtn.disabled = !chatInput.value.trim();

        chatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (chatInput.value.trim()) sendMessage();
            }
        });
        // Auto-resize textarea & toggle button
        chatInput.addEventListener("input", function () {
            if (chatSendBtn) chatSendBtn.disabled = !this.value.trim();
            this.style.height = "auto";
            this.style.height = Math.min(this.scrollHeight, 120) + "px";
        });
    }

    // --- Check for existing uploaded files ---
    checkExistingFiles();

    // --- Load chat history from server ---
    loadChatHistory();
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

// ============================================================
// View Switching
// ============================================================
function switchView(viewName) {
    document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
    const buttons = document.querySelectorAll(".sidebar-nav .nav-item");
    if (viewName === "data") buttons[0].classList.add("active");
    if (viewName === "chat") buttons[1].classList.add("active");
    if (viewName === "visuals") buttons[2].classList.add("active");

    const titles = {
        data: "Data Connector",
        chat: "Chat Analysis",
        visuals: "Visualisations",
    };
    document.getElementById("page-title").innerText = titles[viewName];

    document.querySelectorAll(".view-section").forEach((el) => el.classList.remove("active"));
    document.getElementById("view-" + viewName).classList.add("active");

    // Refresh dashboard when switching to visuals
    if (viewName === "visuals") {
        refreshDashboard();
    }
}

// ============================================================
// File Upload (to Backend)
// ============================================================
async function handleFileUpload(files) {
    const file = files[0];
    if (!file) return;

    const ext = file.name.split(".").pop().toLowerCase();
    if (!["csv", "xlsx", "xls"].includes(ext)) {
        alert("Please upload a CSV or Excel file.");
        return;
    }

    const dropZone = document.getElementById("upload-container");
    const gridContainer = document.getElementById("data-grid-container");

    // Show uploading state
    if (dropZone) {
        dropZone.innerHTML = `
            <div style="font-size: 2rem">⏳</div>
            <h3>Uploading ${escapeHtml(file.name)}...</h3>
            <p>Processing your data...</p>
        `;
    }

    try {
        // 1. Upload to backend
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch(`${API_BASE}/api/upload`, {
            method: "POST",
            body: formData,
        });

        const result = await response.json();

        if (!response.ok || result.error) {
            throw new Error(result.error || "Upload failed");
        }

        // 2. Save active file info
        activeFile = {
            filename: result.filename,
            summary: result.summary,
        };

        // 3. Show success banner
        const banner = document.getElementById("upload-success-banner");
        if (banner) {
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

        // 4. Also load into Handsontable (local preview via SheetJS)
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: "array" });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                const json = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                loadGrid(json);
            } catch (err) {
                console.error("Grid load error:", err);
            }
        };
        reader.readAsArrayBuffer(file);

        // 5. Update sidebar info
        updateSidebarFileInfo(result.filename, result.summary);

        // 6. Update chat hero subtitle
        const subtitle = document.getElementById("chat-hero-subtitle");
        if (subtitle) {
            subtitle.textContent = `Analyzing: ${result.filename} (${result.summary.shape.rows} rows)`;
        }

        // 7. Fetch smart questions from Gemini
        fetchSmartQuestions();

        // 8. Populate data preview panel
        populateDataPreview(result.summary);


    } catch (error) {
        console.error("Upload error:", error);
        if (dropZone) {
            dropZone.innerHTML = `
                <div style="font-size: 3rem; opacity: 0.2">❌</div>
                <h3>Upload Failed</h3>
                <p>${escapeHtml(error.message)}</p>
                <button class="btn btn-primary" style="margin-top: 20px" 
                    onclick="document.getElementById('file-input').click()">Try Again</button>
            `;
        }
    }
}

function loadGrid(data) {
    const dropZone = document.getElementById("upload-container");
    const gridContainer = document.getElementById("data-grid-container");

    if (dropZone) dropZone.style.display = "none";
    if (gridContainer) {
        gridContainer.style.display = "block";
        if (hot) hot.destroy();
        hot = new Handsontable(gridContainer, {
            data: data,
            rowHeaders: true,
            colHeaders: true,
            height: "100%",
            width: "100%",
            licenseKey: "non-commercial-and-evaluation",
            contextMenu: true,
            manualColumnResize: true,
            manualRowResize: true,
            filters: true,
            dropdownMenu: true,
            stretchH: "all",
        });
    }
}

function updateSidebarFileInfo(filename, summary) {
    const infoEl = document.getElementById("sidebar-file-info");
    const nameEl = document.getElementById("sidebar-filename");
    const metaEl = document.getElementById("sidebar-file-meta");
    if (infoEl && nameEl && metaEl) {
        nameEl.textContent = filename;
        metaEl.textContent = `${summary.shape.rows} rows × ${summary.shape.columns} cols`;
        infoEl.style.display = "block";
    }
}

async function checkExistingFiles() {
    try {
        const response = await fetch(`${API_BASE}/api/files`);
        const data = await response.json();
        if (data.active && data.files.length > 0) {
            const file = data.files.find((f) => f.filename === data.active);
            if (file) {
                // Fetch summary
                const sumResp = await fetch(`${API_BASE}/api/data-summary/${encodeURIComponent(data.active)}`);
                const sumData = await sumResp.json();
                activeFile = { filename: data.active, summary: sumData.summary };
                updateSidebarFileInfo(data.active, sumData.summary);

                // Show data grid in Data Connector automatically on load
                const uploadContainer = document.getElementById('upload-container');
                const dataGridContainer = document.getElementById('data-grid-container');
                if (uploadContainer && dataGridContainer && sumData.summary.preview) {
                    uploadContainer.style.display = 'none';
                    dataGridContainer.style.display = 'block';

                    // Fetch full data for the grid instead of using the 5-row preview
                    try {
                        const fullDataResp = await fetch(`${API_BASE}/api/data/${encodeURIComponent(data.active)}`);
                        if (fullDataResp.ok) {
                            const fullData = await fullDataResp.json();
                            loadGrid(fullData.data);
                        } else {
                            loadGrid(sumData.summary.preview); // Fallback to preview
                        }
                    } catch (e) {
                        console.error("Failed to fetch full data:", e);
                        loadGrid(sumData.summary.preview); // Fallback to preview
                    }
                }

                const subtitle = document.getElementById("chat-hero-subtitle");
                if (subtitle) {
                    subtitle.textContent = `Analyzing: ${data.active} (${sumData.summary.shape.rows} rows)`;
                }
            }
        }
    } catch (e) {
        // Backend not running yet — that's ok
        console.log("Backend not available yet:", e.message);
    }
}

// ============================================================
// Chat — Gemini Integration
// ============================================================
async function sendMessage(skipCache = false) {
    const input = document.getElementById("chat-input");
    const message = input.value.trim();
    if (!message || isWaitingForAI) return;

    // Clear input
    input.value = "";
    input.style.height = "auto";

    // Switch to message view (hide hero)
    showChatMessages();

    // Add user message
    appendChatMessage("user", message);

    // Show typing indicator
    isWaitingForAI = true;
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.disabled = true;
    showTypingIndicator();

    try {
        const response = await fetch(`${API_BASE}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: message,
                filename: activeFile ? activeFile.filename : null,
                skip_cache: skipCache,
            }),
        });

        const result = await response.json();
        hideTypingIndicator();

        if (!response.ok || result.error) {
            appendErrorMessage(result.text || "An unexpected error occurred. Please try again.");
        } else {
            // Add AI message with all data
            appendChatMessage("ai", result.text, result.chart, result.table, result.stats,
                result.followup, result.cached, message);
        }

    } catch (error) {
        hideTypingIndicator();
        appendErrorMessage(
            `Could not connect to the backend. Make sure \`server.py\` is running.\n\n\`${error.message}\``
        );
    } finally {
        isWaitingForAI = false;
        if (sendBtn) sendBtn.disabled = false;
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

// ============================================================
// Load Chat History on Page Load
// ============================================================
async function loadChatHistory() {
    try {
        const response = await fetch(`${API_BASE}/api/chat/history`);
        const data = await response.json();
        const history = data.history || [];

        if (history.length === 0) return;

        // Switch to message view
        showChatMessages();

        // Render each message
        for (const msg of history) {
            const role = msg.role === "user" ? "user" : "ai";
            appendChatMessage(role, msg.text, msg.chart || null, msg.table || null, msg.stats || null);
        }
    } catch (e) {
        console.log("Could not load chat history:", e.message);
    }
}

async function clearChatHistory() {
    try {
        await fetch(`${API_BASE}/api/chat/clear`, { method: "POST" });
        // Clear the UI
        const container = document.getElementById("chat-messages");
        if (container) container.innerHTML = "";
        chatMessages = [];
        chartCounter = 0;
        // Show hero again
        const hero = document.getElementById("chat-hero");
        const messages = document.getElementById("chat-messages");
        if (hero) hero.style.display = "";
        if (messages) messages.classList.remove("has-messages");

        // Reset Data Connector Active State
        activeFile = null;
        const infoEl = document.getElementById("sidebar-file-info");
        if (infoEl) infoEl.style.display = "none";

        const uploadContainer = document.getElementById("upload-container");
        const dataGridContainer = document.getElementById("data-grid-container");
        if (uploadContainer) uploadContainer.style.display = "flex";
        if (dataGridContainer) dataGridContainer.style.display = "none";

        const subtitle = document.getElementById("chat-hero-subtitle");
        if (subtitle) subtitle.textContent = "Upload a dataset to get started";

    } catch (e) {
        console.error("Error clearing chat:", e);
    }
}

// ============================================================
// Chat Message Rendering
// ============================================================
let chartCounter = 0;

function appendChatMessage(role, text, chartJson, tableJson, statsJson, followupArr, isCached, originalQuery) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const msgDiv = document.createElement("div");
    msgDiv.className = "chat-msg";
    if (role === "ai") msgDiv.classList.add("streaming-text");

    const avatarClass = role === "user" ? "user" : "ai";
    const avatarText = role === "user" ? "D" : "AI";
    const name = role === "user" ? "You" : "Data Talk AI";

    // Parse markdown
    let htmlText = renderMarkdown(text);

    let chartHtml = "";
    if (chartJson && typeof chartJson === "object") {
        chartCounter++;
        const chartId = `chat-chart-${chartCounter}`;
        const chartTitle = chartJson.layout?.title?.text || chartJson.layout?.title || "Chart";

        chartHtml = `
            <div class="chat-chart-container" style="position: relative;">
                <div id="${chartId}" style="width: 100%; height: 380px;"></div>
                <div class="chart-actions">
                    <button class="chart-action-btn" onclick="pinChart('${chartId}', '${escapeAttr(typeof chartTitle === 'string' ? chartTitle : 'Chart')}')">📌 Pin to Dashboard</button>
                    <button class="chart-action-btn" onclick="downloadChart('${chartId}')">📥 Download PNG</button>
                    <button class="chart-action-btn expand-btn" onclick="openFullscreenChart('${chartId}')">🔍 Expand</button>
                    <button class="chart-action-btn" onclick="enableAnnotation('${chartId}')">📝 Annotate</button>
                </div>
            </div>
        `;
    }

    // Stats cards
    let statsHtml = "";
    if (statsJson && Array.isArray(statsJson) && statsJson.length > 0) {
        statsHtml = `<div class="chat-stats-row">
            ${statsJson.map(s => `<div class="stat-card">
                <div class="stat-value">${escapeHtml(s.value)}</div>
                <div class="stat-label">${escapeHtml(s.label)}</div>
            </div>`).join("")}
        </div>`;
    }

    // Table toggle button
    let tableHtml = "";
    if (tableJson && tableJson.headers && tableJson.rows) {
        const tableId = `chat-table-${chartCounter || Date.now()}`;
        tableHtml = `
            <div class="chat-table-wrapper" id="${tableId}" style="display: none; overflow-x: auto;">
                <table class="chat-data-table">
                    <thead><tr>${tableJson.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
                    <tbody>${tableJson.rows.map(row => `<tr>${row.map(v => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</tbody>
                </table>
            </div>
        `;
    }

    // Follow-up suggestion chips
    let followupHtml = "";
    if (followupArr && Array.isArray(followupArr) && followupArr.length > 0) {
        followupHtml = `<div class="followup-chips">
            ${followupArr.map(q => `<button class="followup-chip" onclick="useFollowup(this)">${escapeHtml(q)}</button>`).join("")}
        </div>`;
    }

    // AI message actions row (table toggle + regenerate + cached badge in one row)
    let actionsHtml = "";
    if (role === "ai") {
        const tableToggleBtn = (tableJson && tableJson.headers && tableJson.rows)
            ? `<button class="table-toggle-btn" onclick="toggleTable('chat-table-${chartCounter || Date.now()}', this)">📊 Show as table</button>`
            : "";
        const regenerateBtn = originalQuery
            ? `<button class="regenerate-btn" onclick="regenerateLastResponse('${escapeAttr(originalQuery)}')">🔄 Regenerate</button>`
            : "";
        const cachedBadge = isCached ? `<span class="cached-badge">⚡ Cached</span>` : "";

        if (tableToggleBtn || regenerateBtn) {
            actionsHtml = `<div class="msg-actions">
                ${tableToggleBtn}
                ${regenerateBtn}
                ${cachedBadge}
            </div>`;
        }
    }

    msgDiv.innerHTML = `
        <div class="chat-msg-header">
            <div class="chat-msg-avatar ${avatarClass}">${avatarText}</div>
            <div class="chat-msg-name">${name}</div>
        </div>
        <div class="chat-msg-body">
            ${htmlText}
            ${chartHtml}
            ${statsHtml}
            ${tableHtml}
            ${actionsHtml}
            ${followupHtml}
        </div>
    `;

    container.appendChild(msgDiv);

    // Render Plotly chart after DOM insert
    if (chartJson && typeof chartJson === "object") {
        const chartId = `chat-chart-${chartCounter}`;
        setTimeout(() => {
            try {
                const layout = {
                    ...(chartJson.layout || {}),
                    template: "plotly_white",
                    font: { family: "Inter, sans-serif" },
                    autosize: true,
                    margin: { l: 50, r: 30, t: 50, b: 50 },
                };
                Plotly.newPlot(chartId, chartJson.data, layout, {
                    responsive: true,
                    displayModeBar: true,
                    modeBarButtonsToRemove: ["lasso2d", "select2d"],
                });
            } catch (e) {
                console.error("Plotly render error:", e);
                document.getElementById(chartId).innerHTML =
                    '<p style="color: #ea4335;">Error rendering chart</p>';
            }
        }, 100);
    }

    // Remove streaming class after animation
    if (role === "ai") {
        setTimeout(() => msgDiv.classList.remove("streaming-text"), 600);
    }

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;

    // Save to local history
    chatMessages.push({ role, text, chart: chartJson || null, table: tableJson || null, stats: statsJson || null });
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
let progressInterval = null;
let progressPhaseIndex = 0;

const PROGRESS_PHASES = [
    "Extracting data...",
    "Generating analysis code...",
    "Running analysis...",
    "Interpreting results...",
    "Almost done...",
];

function showTypingIndicator() {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    progressPhaseIndex = 0;

    const indicator = document.createElement("div");
    indicator.id = "typing-indicator";
    indicator.className = "chat-msg";
    indicator.innerHTML = `
        <div class="chat-msg-header">
            <div class="chat-msg-avatar ai">AI</div>
            <div class="chat-msg-name">Data Talk AI</div>
        </div>
        <div class="typing-indicator">
            <div class="typing-progress-text">${PROGRESS_PHASES[0]}</div>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>
    `;
    container.appendChild(indicator);
    container.scrollTop = container.scrollHeight;

    // Cycle through phase messages
    progressPhaseIndex = 1;
    progressInterval = setInterval(() => {
        if (progressPhaseIndex >= PROGRESS_PHASES.length) {
            clearInterval(progressInterval);
            progressInterval = null;
            return;
        }
        const textEl = document.querySelector("#typing-indicator .typing-progress-text");
        if (textEl) {
            textEl.textContent = PROGRESS_PHASES[progressPhaseIndex];
            textEl.classList.add("phase-change");
            setTimeout(() => textEl.classList.remove("phase-change"), 300);
        }
        progressPhaseIndex++;
    }, 2500);
}

function hideTypingIndicator() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
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
            <div class="chat-error-icon">!</div>
            <div class="chat-error-body">${htmlText}</div>
        </div>
    `;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}

// ============================================================
// Dashboard Pinning
// ============================================================

async function pinChart(chartId, title) {
    const chartDiv = document.getElementById(chartId);
    if (!chartDiv) return;

    // Get the plotly data from the rendered chart
    const plotlyData = chartDiv.data;
    const plotlyLayout = chartDiv.layout;

    if (!plotlyData) {
        alert("Could not read chart data");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/dashboard/pin`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: title || "Untitled Chart",
                chart: {
                    data: plotlyData,
                    layout: plotlyLayout,
                },
            }),
        });

        const result = await response.json();

        if (result.success) {
            // Update the pin button to show success
            const btn = chartDiv.closest(".chat-chart-container").querySelector(".chart-action-btn");
            if (btn) {
                btn.textContent = "✅ Pinned!";
                btn.classList.add("pinned");
                btn.disabled = true;
            }
            // Refresh dashboard if visuals tab is active
            if (document.getElementById("view-visuals") &&
                document.getElementById("view-visuals").classList.contains("active")) {
                refreshDashboard();
            }
        } else {
            alert("Failed to pin chart: " + (result.error || "Unknown error"));
        }
    } catch (error) {
        alert("Error pinning chart. Is the backend running?");
        console.error("Pin error:", error);
    }
}

function downloadChart(chartId) {
    const chartDiv = document.getElementById(chartId);
    if (chartDiv) {
        Plotly.downloadImage(chartDiv, {
            format: "png",
            width: 1200,
            height: 600,
            filename: "data-talk-chart",
        });
    }
}

// ============================================================
// Smart Questions (after file upload)
// ============================================================
async function fetchSmartQuestions() {
    try {
        const response = await fetch(`${API_BASE}/api/suggest-questions`);
        const data = await response.json();
        const questions = data.questions || [];
        if (questions.length === 0) return;

        const chipsContainer = document.getElementById("suggestion-chips");
        if (chipsContainer) {
            chipsContainer.innerHTML = questions.map(q =>
                `<div class="suggestion-chip" onclick="useSuggestion(this)">${escapeHtml(q)}</div>`
            ).join("");
        }
    } catch (e) {
        console.log("Could not fetch smart questions:", e.message);
    }
}


// ============================================================
// Data Preview Panel
// ============================================================
function populateDataPreview(summary) {
    if (!summary || !summary.columns) return;

    const body = document.getElementById("data-preview-body");
    const toggle = document.getElementById("data-preview-toggle");
    if (!body) return;

    const dtypes = summary.dtypes || {};
    body.innerHTML = summary.columns.map(col => {
        const dtype = dtypes[col] || "unknown";
        const typeLabel = dtype.includes("int") || dtype.includes("float") ? "numeric"
            : dtype.includes("object") ? "text"
                : dtype.includes("datetime") ? "date"
                    : dtype;
        return `<div class="data-preview-col">
            <span class="col-name" title="${escapeHtml(col)}">${escapeHtml(col)}</span>
            <span class="col-type">${escapeHtml(typeLabel)}</span>
        </div>`;
    }).join("");

    // Show the toggle button
    if (toggle) toggle.style.display = "flex";
}

function toggleDataPreview() {
    const panel = document.getElementById("data-preview-panel");
    if (panel) panel.classList.toggle("visible");
}

// ============================================================
// Fullscreen Chart
// ============================================================
function openFullscreenChart(chartId) {
    const sourceChart = document.getElementById(chartId);
    if (!sourceChart || !sourceChart.data) return;

    const overlay = document.getElementById("chart-fullscreen-overlay");
    overlay.classList.add("visible");

    const layout = {
        ...(sourceChart.layout || {}),
        template: "plotly_white",
        font: { family: "Inter, sans-serif" },
        autosize: true,
        margin: { l: 60, r: 40, t: 60, b: 60 },
    };

    setTimeout(() => {
        Plotly.newPlot("fullscreen-chart", sourceChart.data, layout, {
            responsive: true,
            displayModeBar: true,
        });
    }, 100);
}

function closeFullscreenChart() {
    const overlay = document.getElementById("chart-fullscreen-overlay");
    overlay.classList.remove("visible");
    Plotly.purge("fullscreen-chart");
}

function closeFullscreen(event) {
    // Close when clicking the overlay background (not the chart container)
    if (event.target === event.currentTarget) {
        closeFullscreenChart();
    }
}

// ============================================================
// Native Dashboard (replaces Streamlit)
// ============================================================
let dashboardCharts = [];
let draggedChartId = null;
let dashboardLoaded = false;

async function refreshDashboard() {
    try {
        const response = await fetch(`${API_BASE}/api/dashboard`);
        const data = await response.json();
        dashboardCharts = data.charts || [];
        dashboardLoaded = true;
        renderDashboardGrid();
    } catch (e) {
        console.error("Failed to load dashboard:", e);
        dashboardCharts = [];
        dashboardLoaded = true;
        renderDashboardGrid();
    }
}

function renderDashboardGrid() {
    if (!dashboardLoaded) return;

    const grid = document.getElementById("dashboard-grid");
    const empty = document.getElementById("dashboard-empty");
    const countBadge = document.getElementById("dashboard-chart-count");

    if (!grid) return;

    // Update count
    const n = dashboardCharts.length;
    if (countBadge) countBadge.textContent = `${n} chart${n !== 1 ? "s" : ""}`;

    // Empty state
    if (n === 0) {
        grid.style.display = "none";
        if (empty) empty.style.display = "flex";
        return;
    }
    grid.style.display = "grid";
    if (empty) empty.style.display = "none";

    // Sort by position
    const sorted = [...dashboardCharts].sort((a, b) => (a.position || 0) - (b.position || 0));

    grid.innerHTML = sorted.map((chart) => {
        const title = chart.title || "Untitled Chart";
        const plotId = `dash-plot-${chart.id}`;
        const colSpan = chart.colSpan || 1;

        return `
            <div class="dashboard-chart-card"
                 draggable="true"
                 data-chart-id="${chart.id}"
                 data-col-span="${colSpan}">
                <div class="dashboard-chart-title">
                    <span class="drag-handle">
                        <span class="drag-handle-dot-row">
                            <span class="drag-handle-dot"></span>
                            <span class="drag-handle-dot"></span>
                        </span>
                        <span class="drag-handle-dot-row">
                            <span class="drag-handle-dot"></span>
                            <span class="drag-handle-dot"></span>
                        </span>
                        <span class="drag-handle-dot-row">
                            <span class="drag-handle-dot"></span>
                            <span class="drag-handle-dot"></span>
                        </span>
                    </span>
                    ${escapeHtml(title)}
                </div>
                <div class="dashboard-chart-plot" id="${plotId}"></div>
                <div class="dashboard-chart-actions">
                    <div class="card-resize-controls">
                        <button class="card-resize-btn ${colSpan === 1 ? 'active' : ''}"
                                onclick="setCardColSpan('${chart.id}', 1)" title="1 column">1</button>
                        <button class="card-resize-btn ${colSpan === 2 ? 'active' : ''}"
                                onclick="setCardColSpan('${chart.id}', 2)" title="2 columns">2</button>
                        <button class="card-resize-btn ${colSpan === 3 ? 'active' : ''}"
                                onclick="setCardColSpan('${chart.id}', 3)" title="3 columns">3</button>
                    </div>
                    <button class="btn-dash-action" onclick="downloadDashChart('${plotId}')">Download PNG</button>
                    <button class="btn-dash-action btn-dash-danger" onclick="removeDashChart('${chart.id}')">Remove</button>
                </div>
            </div>
        `;
    }).join("");

    // Attach drag-and-drop listeners
    initDashboardDragAndDrop();

    // Render Plotly charts after DOM insert
    requestAnimationFrame(() => {
        sorted.forEach((chart) => {
            const plotId = `dash-plot-${chart.id}`;
            const el = document.getElementById(plotId);
            if (!el || !chart.chart) return;

            try {
                const colSpan = chart.colSpan || 1;
                const layout = {
                    ...(chart.chart.layout || {}),
                    template: "plotly_white",
                    font: { family: "Inter, sans-serif" },
                    autosize: true,
                    width: undefined, // Fix: Reset width to force responsiveness
                    title: "",        // Fix: Remove internal title (already in header)
                    margin: { l: 40, r: 40, t: 30, b: 40 },
                    height: colSpan === 3 ? 420 : 340,
                };
                Plotly.newPlot(plotId, chart.chart.data, layout, {
                    responsive: true,
                    displayModeBar: true,
                    modeBarButtonsToRemove: ["lasso2d", "select2d"],
                });
            } catch (e) {
                el.innerHTML = '<p style="color: #ea4335; padding: 20px;">Error rendering chart</p>';
                console.error("Dashboard chart render error:", e);
            }
        });

        // Auto-resize all charts after CSS grid settles
        resizeAllDashboardCharts();
    });
}

function resizeAllDashboardCharts() {
    // Give the CSS grid time to settle before telling Plotly to resize
    setTimeout(() => {
        document.querySelectorAll(".dashboard-chart-plot").forEach(el => {
            if (el && el.data) {
                Plotly.Plots.resize(el);
            }
        });
    }, 350);
}

// ============================================================
// Dashboard: Column Span & Persistence
// ============================================================
async function setCardColSpan(chartId, newSpan) {
    const chart = dashboardCharts.find(c => c.id === chartId);
    if (!chart) return;
    chart.colSpan = newSpan;

    // Full re-render so all charts resize properly
    renderDashboardGrid();
    await saveDashboardToBackend();
}

async function saveDashboardToBackend() {
    try {
        await fetch(`${API_BASE}/api/dashboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ charts: dashboardCharts }),
        });
    } catch (e) {
        console.error("Failed to save dashboard:", e);
    }
}

// ============================================================
// Dashboard: HTML5 Drag & Drop
// ============================================================
function initDashboardDragAndDrop() {
    const grid = document.getElementById("dashboard-grid");
    if (!grid) return;

    const cards = grid.querySelectorAll(".dashboard-chart-card");

    cards.forEach(card => {
        card.addEventListener("dragstart", (e) => {
            // Prevent drag from action buttons
            if (e.target.closest(".dashboard-chart-actions") ||
                e.target.closest(".btn-dash-action") ||
                e.target.closest(".card-resize-btn")) {
                e.preventDefault();
                return;
            }
            draggedChartId = card.getAttribute("data-chart-id");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", draggedChartId);
            requestAnimationFrame(() => card.classList.add("dragging"));
        });

        card.addEventListener("dragend", () => {
            card.classList.remove("dragging");
            draggedChartId = null;
            grid.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
        });

        card.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const thisId = card.getAttribute("data-chart-id");
            if (thisId !== draggedChartId) {
                card.classList.add("drag-over");
            }
        });

        card.addEventListener("dragleave", (e) => {
            if (!card.contains(e.relatedTarget)) {
                card.classList.remove("drag-over");
            }
        });

        card.addEventListener("drop", (e) => {
            e.preventDefault();
            card.classList.remove("drag-over");

            const targetId = card.getAttribute("data-chart-id");
            if (!draggedChartId || draggedChartId === targetId) return;

            const fromIndex = dashboardCharts.findIndex(c => c.id === draggedChartId);
            const toIndex = dashboardCharts.findIndex(c => c.id === targetId);
            if (fromIndex === -1 || toIndex === -1) return;

            // Remove dragged item and insert at target position
            const [movedChart] = dashboardCharts.splice(fromIndex, 1);
            dashboardCharts.splice(toIndex, 0, movedChart);

            // Reassign sequential positions
            dashboardCharts.forEach((c, i) => { c.position = i; });

            // Re-render and persist
            renderDashboardGrid();
            saveDashboardToBackend();
        });
    });
}

// ============================================================
// Dashboard: Remove, Download, Clear
// ============================================================
async function removeDashChart(chartId) {
    try {
        const resp = await fetch(`${API_BASE}/api/dashboard/remove/${chartId}`, { method: "DELETE" });
        const data = await resp.json();
        if (data.success) {
            refreshDashboard();
        } else {
            alert("Failed to remove chart: " + (data.error || "Unknown error"));
        }
    } catch (e) {
        alert("Error removing chart.");
        console.error(e);
    }
}

function downloadDashChart(plotId) {
    const el = document.getElementById(plotId);
    if (el) {
        Plotly.downloadImage(el, {
            format: "png",
            width: 1200,
            height: 600,
            filename: "data-talk-dashboard-chart",
        });
    }
}

async function clearAllCharts() {
    if (!confirm("Remove all charts from the dashboard?")) return;
    try {
        await fetch(`${API_BASE}/api/dashboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ charts: [] }),
        });
        refreshDashboard();
    } catch (e) {
        alert("Error clearing dashboard.");
        console.error(e);
    }
}
