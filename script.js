// Legacy entry point kept for backward compatibility.
// New code is split across js/core.js, js/data-chat.js, js/dashboard-ui.js.
(function loadFrontendModules() {
    // core.js must load first (provides globals), then the rest load in parallel
    const core = document.createElement("script");
    core.src = "js/core.js";
    core.onload = function () {
        ["js/data-chat.js", "js/dashboard-ui.js"].forEach(function (src) {
            const s = document.createElement("script");
            s.src = src;
            s.async = true;
            document.body.appendChild(s);
        });
    };
    document.body.appendChild(core);
})();
