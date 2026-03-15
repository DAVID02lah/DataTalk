// ============================================================
// script.js — Data Talk Frontend Logic
// ============================================================
// Handles: Particle animation, file upload (to backend), Gemini chat,
//          chart rendering, and dashboard pinning.
// ============================================================

// ============================================================
// Global Application State & Config
// ============================================================
const App = {
    API_BASE: window.location.origin,
    state: {
        activeFile: null,           // { filename, summary }
        chatMessages: [],           // Array of { role, text, chart }
        hot: null,                  // Handsontable instance
        isWaitingForAI: false,      // Prevents double-sends
        chartCounter: 0,            // Counter for unique chart IDs
        dashboardCharts: [],        // Pinned dashboard charts
        draggedChartId: null,       // Currently dragged chart ID
        dashboardLoaded: false,     // Whether dashboard has been loaded
        progressInterval: null,     // Typing indicator interval
        progressPhaseIndex: 0,      // Current progress phase
    },

    /** Return headers object with the Bearer token for authenticated API requests. */
    getAuthHeaders(extra = {}) {
        const token = localStorage.getItem('dt_access_token');
        return {
            'Authorization': token ? `Bearer ${token}` : '',
            ...extra
        };
    },

    /** Validate the stored session token; redirect to login if invalid. */
    async checkSession() {
        const token = localStorage.getItem('dt_access_token');
        if (!token) {
            window.location.href = 'login.html';
            return false;
        }
        try {
            const res = await fetch(`${App.API_BASE}/api/auth/session`, {
                headers: App.getAuthHeaders()
            });
            if (!res.ok) {
                App.signOut();
                return false;
            }
            const data = await res.json();
            if (data.valid && data.user) {
                App.loadUserProfile(data.user);
            }
            return true;
        } catch {
            App.signOut();
            return false;
        }
    },

    /** Clear stored auth data and redirect to login page. */
    signOut() {
        const token = localStorage.getItem('dt_access_token');
        if (token) {
            fetch(`${App.API_BASE}/api/auth/logout`, {
                method: 'POST',
                headers: App.getAuthHeaders()
            }).catch(() => { });
        }
        localStorage.removeItem('dt_access_token');
        localStorage.removeItem('dt_refresh_token');
        localStorage.removeItem('dt_user');
        window.location.href = 'login.html';
    },

    /** Update the UI with the authenticated user's profile info. */
    loadUserProfile(user) {
        const nameEl = document.querySelector('.user-profile .user-name');
        const initialsEl = document.querySelector('.user-profile .user-avatar');
        if (nameEl && user.display_name) {
            nameEl.textContent = user.display_name;
        }
        if (initialsEl && user.avatar_initials) {
            initialsEl.textContent = user.avatar_initials;
        }
    },

    // ============================================================
    // Theme (Dark / Light Mode)
    // ============================================================

    /** Apply saved theme or detect system preference. */
    initTheme() {
        const saved = localStorage.getItem('dt_theme');
        if (saved) {
            document.documentElement.setAttribute('data-theme', saved);
        } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
        }
        App.updateThemeIcon();
    },

    /** Toggle between light and dark mode. */
    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('dt_theme', next);
        App.updateThemeIcon();
        
        // Update particle color if canvas exists
        if (window.updateParticleTheme) {
            window.updateParticleTheme(next);
        }
    },

    /** Sync the theme toggle button icon. */
    updateThemeIcon() {
        const btn = document.getElementById('theme-toggle-btn');
        if (!btn) return;
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        btn.textContent = isDark ? '☀️' : '🌙';
        btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    }
};

// Apply theme immediately to prevent flash of wrong theme
App.initTheme();

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

let particleColor = document.documentElement.getAttribute('data-theme') === 'dark' ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.5)";

window.updateParticleTheme = function(theme) {
    particleColor = theme === 'dark' ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.5)";
    if (document.getElementById("particle-canvas")) {
        initParticles();
    }
};

let mouse = {
    x: null,
    y: null,
    radius: canvas ? (canvas.height / 80) * (canvas.width / 80) : 100,
};

let mouseTimer = null;

window.addEventListener("mousemove", (event) => {
    mouse.x = event.x;
    mouse.y = event.y;

    if (mouseTimer) {
        clearTimeout(mouseTimer);
    }
    
    // Stop particle reaction after 150ms of mouse inactivity
    mouseTimer = setTimeout(() => {
        mouse.x = null;
        mouse.y = null;
    }, 150);
});

window.addEventListener("mouseout", () => {
    mouse.x = null;
    mouse.y = null;
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
        
        if (mouse.x != null && mouse.y != null) {
            let dx = mouse.x - this.x;
            let dy = mouse.y - this.y;
            let distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < mouse.radius + this.size) {
                if (mouse.x < this.x && this.x < canvas.width - this.size * 10) this.x += 10;
                if (mouse.x > this.x && this.x > this.size * 10) this.x -= 10;
                if (mouse.y < this.y && this.y < canvas.height - this.size * 10) this.y += 10;
                if (mouse.y > this.y && this.y > this.size * 10) this.y -= 10;
            }
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
    const maxDistanceSq = (canvas.width / 7) * (canvas.height / 7);
    const maxDist = Math.sqrt(maxDistanceSq);

    for (let a = 0; a < particlesArray.length; a++) {
        for (let b = a + 1; b < particlesArray.length; b++) {
            // Early exit using 1D bounding box
            let dx = particlesArray[a].x - particlesArray[b].x;
            if (Math.abs(dx) > maxDist) continue;

            let dy = particlesArray[a].y - particlesArray[b].y;
            if (Math.abs(dy) > maxDist) continue;

            let distanceSq = dx * dx + dy * dy;

            if (distanceSq < maxDistanceSq) {
                let opacity = 1 - distanceSq / 20000;
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
// App State (consolidated in App.state above)
// ============================================================

// ============================================================
// DOM Ready
// ============================================================
document.addEventListener("DOMContentLoaded", async () => {
    // --- Particles ---
    if (canvas) {
        initParticles();
        animateParticles();
    }

    // --- Auth: verify session before loading dashboard ---
    const isDashboard = !!document.getElementById('page-title');
    if (isDashboard) {
        const valid = await App.checkSession();
        if (!valid) return; // Redirected to login
    }

    // --- Sign Out button ---
    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            App.signOut();
        });
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
