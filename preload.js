"use strict";

// No privileged bridge is exposed to the page. The renderer reaches the local
// read-only API over http://127.0.0.1 exactly as a normal browser would, so the
// loaded site needs no desktop-specific code path.

// Ctrl + mouse wheel page zoom. Chromium's native ctrl+wheel gesture is
// unreliable in this shell, so cancel it here and drive zoom from the main
// process over IPC. ipcRenderer is available in a sandboxed preload and stays
// isolated from the page world.
const { ipcRenderer } = require("electron");
window.addEventListener(
  "wheel",
  function (e) {
    if (!e.ctrlKey) return;
    const t = e.target;
    if (t && t.closest && t.closest("[data-map-viewport]")) return;
    e.preventDefault();
    ipcRenderer.send("rt-zoom-wheel", e.deltaY < 0 ? 1 : -1);
  },
  { passive: false, capture: true }
);
