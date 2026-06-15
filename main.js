"use strict";

// RatedTracker Companion (desktop).
//
// An Electron shell that loads ratedtracker.com and runs a small read-only file
// API in the Node main process on 127.0.0.1. Because Electron ships its own
// Chromium, the site's existing live-sync talks to that API directly on Windows
// and macOS, with no browser file-access limits, no Program Files block, and no
// Safari mixed-content problem. The API only ever reads WoWCombatLog*.txt and
// RatedTracker.lua. It never uploads, copies, moves, or deletes anything.

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = require("electron");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch (e) {
  autoUpdater = null;
}

const APP_NAME = "RatedTracker Companion";
const SITE_URL = "https://ratedtracker.com/";
const PORT = 3456;
const GOOGLE_REDIRECT = "http://127.0.0.1:" + PORT + "/oauth2/callback";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const STREAM_CHUNK = 256 * 1024;
const EXPOSE_HEADERS = "X-Log-Filename, X-Log-Size, X-Log-Offset, X-Sv-Filename, X-Sv-Account-Path";
const ALLOWED_ORIGINS = new Set(["https://ratedtracker.com", "https://www.ratedtracker.com"]);

let mainWindow = null;
let tray = null;
let retailRoot = null;
let companionPrefs = { closeAction: null, rememberClose: false, zoomFactor: 1 };

function prefsFile() {
  try {
    return path.join(app.getPath("userData"), "companion-prefs.json");
  } catch (e) {
    return path.join(os.tmpdir(), "rt-companion-prefs.json");
  }
}

function loadCompanionPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf-8"));
    if (raw && typeof raw === "object") companionPrefs = raw;
  } catch (e) {
    companionPrefs = { closeAction: null, rememberClose: false, zoomFactor: 1 };
  }
  if (companionPrefs.closeAction !== "tray" && companionPrefs.closeAction !== "quit") {
    companionPrefs.closeAction = null;
  }
  companionPrefs.rememberClose = !!companionPrefs.rememberClose;
  let z = Number(companionPrefs.zoomFactor);
  if (!isFinite(z) || z <= 0) z = 1;
  companionPrefs.zoomFactor = Math.max(0.5, Math.min(3, z));
}

function saveCompanionPrefs() {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(companionPrefs));
  } catch (e) {
    /* best effort */
  }
}

function hideToTray() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

async function handleWindowClose() {
  if (!mainWindow || mainWindow.isDestroyed() || app.isQuitting) return;

  if (companionPrefs.rememberClose && companionPrefs.closeAction === "tray") {
    hideToTray();
    return;
  }
  if (companionPrefs.rememberClose && companionPrefs.closeAction === "quit") {
    quitApp();
    return;
  }

  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["Close to taskbar", "Close app", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: APP_NAME,
    message: "Close RatedTracker Companion?",
    detail: "Close to taskbar keeps sync running in the background. Close app stops the companion.",
    checkboxLabel: "Remember my choice",
    checkboxChecked: false,
  });

  if (result.response === 2) return;

  if (result.checkboxChecked) {
    companionPrefs.rememberClose = true;
    companionPrefs.closeAction = result.response === 0 ? "tray" : "quit";
    saveCompanionPrefs();
  }

  if (result.response === 0) hideToTray();
  else if (result.response === 1) quitApp();
}

// ---------------------------------------------------------------------------
// Auto-update (electron-updater + GitHub Releases)
//
// Only runs in the installed (electron-builder) build. The portable zip and dev
// (electron .) have no embedded update metadata, so the guards below no-op there.
// The download is verified by sha512 from latest.yml, so it works unsigned; the
// only signing-sensitive surface is Windows SmartScreen on first manual install.
// ---------------------------------------------------------------------------

let updateDownloaded = false;
let manualUpdateCheck = false;

function updatesSupported() {
  return !!(autoUpdater && app.isPackaged);
}

function checkForUpdatesSafe() {
  if (!updatesSupported()) return;
  try {
    autoUpdater.checkForUpdates();
  } catch (e) {
    /* best effort */
  }
}

function promptRestartToUpdate(version) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog
    .showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: APP_NAME,
      message: "A new version of RatedTracker Companion is ready.",
      detail:
        (version ? "Version " + version + " has been downloaded. " : "An update has been downloaded. ") +
        "Restart to finish updating.",
    })
    .then((r) => {
      if (r.response === 0) {
        app.isQuitting = true;
        try {
          autoUpdater.quitAndInstall();
        } catch (e) {
          /* if quitAndInstall fails, the update still applies on next quit */
        }
      }
    });
}

function manualCheckForUpdates() {
  if (updateDownloaded) {
    promptRestartToUpdate(null);
    return;
  }
  if (!updatesSupported()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        buttons: ["OK"],
        noLink: true,
        title: APP_NAME,
        message: "Automatic updates are available in the installed version.",
        detail: "This copy was run without the installer, so it cannot update itself. Download the latest installer from ratedtracker.com.",
      });
    }
    return;
  }
  manualUpdateCheck = true;
  checkForUpdatesSafe();
}

function setupAutoUpdates() {
  if (!updatesSupported()) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", () => {
    if (manualUpdateCheck && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        buttons: ["OK"],
        noLink: true,
        title: APP_NAME,
        message: "Update found.",
        detail: "It is downloading in the background. You will be asked to restart when it is ready.",
      });
    }
    manualUpdateCheck = false;
  });

  autoUpdater.on("update-not-available", () => {
    if (manualUpdateCheck && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        buttons: ["OK"],
        noLink: true,
        title: APP_NAME,
        message: "You are up to date.",
        detail: "Version " + app.getVersion() + " is the latest.",
      });
    }
    manualUpdateCheck = false;
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateDownloaded = true;
    refreshTrayMenu();
    promptRestartToUpdate(info && info.version);
  });

  autoUpdater.on("error", (err) => {
    if (manualUpdateCheck && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        buttons: ["OK"],
        noLink: true,
        title: APP_NAME,
        message: "Could not check for updates.",
        detail: String((err && err.message) || err || "Unknown error"),
      });
    }
    manualUpdateCheck = false;
    console.error(APP_NAME + " update error:", (err && err.message) || err);
  });

  checkForUpdatesSafe();
  // Re-check periodically for long-running tray sessions.
  setInterval(checkForUpdatesSafe, 6 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// WoW install detection
// ---------------------------------------------------------------------------

function candidateRoots() {
  const roots = [];
  if (process.platform === "win32") {
    const drives = ["C", "D", "E", "F", "G"];
    const suffixes = [
      "Program Files (x86)\\World of Warcraft\\_retail_",
      "Program Files\\World of Warcraft\\_retail_",
      "World of Warcraft\\_retail_",
      "Games\\World of Warcraft\\_retail_",
      "Battle.net\\World of Warcraft\\_retail_",
    ];
    for (const d of drives) {
      for (const s of suffixes) roots.push(d + ":\\" + s);
    }
  } else if (process.platform === "darwin") {
    roots.push("/Applications/World of Warcraft/_retail_");
    roots.push(path.join(os.homedir(), "Applications/World of Warcraft/_retail_"));
  } else if (process.platform === "linux") {
    const home = os.homedir();
    // WoW on Linux runs through Wine/Lutris/Bottles/Proton. Probe the common prefix layouts;
    // the user can always pick the folder manually if their prefix differs.
    const winSuffixes = [
      "drive_c/Program Files (x86)/World of Warcraft/_retail_",
      "drive_c/Program Files/World of Warcraft/_retail_",
      "drive_c/Games/World of Warcraft/_retail_",
    ];
    const prefixes = [
      path.join(home, "Games/world-of-warcraft"),
      path.join(home, "Games/battlenet"),
      path.join(home, "Games/battle-net"),
      path.join(home, ".wine"),
      path.join(home, ".var/app/com.usebottles.bottles/data/bottles/bottles/WoW"),
      path.join(home, "Games/world-of-warcraft/drive_c/users", process.env.USER || "user"),
    ];
    for (const p of prefixes) {
      for (const s of winSuffixes) roots.push(path.join(p, s));
    }
    // Native (rare) and direct layouts.
    roots.push(path.join(home, "World of Warcraft/_retail_"));
    roots.push(path.join(home, "Games/World of Warcraft/_retail_"));
  }
  return roots;
}

function detectRetailRoot() {
  for (const r of candidateRoots()) {
    try {
      if (fs.existsSync(path.join(r, "Logs")) || fs.existsSync(path.join(r, "WTF"))) return r;
    } catch (e) {
      /* keep looking */
    }
  }
  return null;
}

function logsDir() {
  return retailRoot ? path.join(retailRoot, "Logs") : null;
}

function wtfAccountDir() {
  return retailRoot ? path.join(retailRoot, "WTF", "Account") : null;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function fileInfo(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return { name: path.basename(p), mtime: Math.floor(st.mtimeMs), size: st.size };
  } catch (e) {
    return null;
  }
}

function listCombatLogs() {
  const d = logsDir();
  if (!d) return [];
  let names;
  try {
    names = fs.readdirSync(d);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^wowcombatlog.*\.txt$/i.test(n)) continue;
    const info = fileInfo(path.join(d, n));
    if (info) out.push(info);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 24);
}

function latestCombatLog() {
  const list = listCombatLogs();
  return list.length ? path.join(logsDir(), list[0].name) : null;
}

function latestSavedVariables() {
  const base = wtfAccountDir();
  if (!base) return null;
  let best = null;
  let bestMtime = 0;
  let accounts;
  try {
    accounts = fs.readdirSync(base);
  } catch (e) {
    return null;
  }
  for (const acct of accounts) {
    const sv = path.join(base, acct, "SavedVariables", "RatedTracker.lua");
    try {
      const st = fs.statSync(sv);
      if (st.isFile() && st.mtimeMs >= bestMtime) {
        best = sv;
        bestMtime = st.mtimeMs;
      }
    } catch (e) {
      /* this account has no RatedTracker SV */
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Google Drive OAuth (system browser + loopback)
//
// Google blocks OAuth inside embedded/desktop web views, so sign-in happens in the
// user's real browser. Google redirects back to GOOGLE_REDIRECT on this loopback
// server, where we exchange the code for tokens (Google's token endpoint is not
// reliably reachable from a page via CORS, so it is done here in Node). Only the
// refresh token is persisted; the page asks us for short-lived access tokens.
// ---------------------------------------------------------------------------

// Built-in RatedTracker Google client. The client ID is public (it appears in the OAuth
// redirect). The client secret is injected at build time from generated-config.js so it
// never lives in the public source repo; in dev it is simply absent and the user supplies
// their own Google client. (A desktop client secret is not truly confidential, but keeping
// it out of the public repo avoids automated scanning / revocation.)
const DEFAULT_GOOGLE_CLIENT_ID = "289698782999-1nts45fkqnoaag1qsmrjs0r4kp99n3u5.apps.googleusercontent.com";
let DEFAULT_GOOGLE_CLIENT_SECRET = "";
try {
  const injected = require("./generated-config");
  if (injected && injected.googleClientSecret) DEFAULT_GOOGLE_CLIENT_SECRET = String(injected.googleClientSecret);
} catch (e) {
  /* no injected config (dev build); built-in Google client unavailable */
}

let googleStore = {}; // { [clientId]: { refresh_token } }
let pendingGoogle = null; // { state, verifier, clientId, secret, req, res, timer }

function resolveGoogleCreds(clientId, secret) {
  clientId = String(clientId || "").trim();
  secret = String(secret || "").trim();
  if (!clientId) clientId = DEFAULT_GOOGLE_CLIENT_ID;
  if (!secret && clientId && clientId === DEFAULT_GOOGLE_CLIENT_ID) secret = DEFAULT_GOOGLE_CLIENT_SECRET;
  return { clientId: clientId, secret: secret };
}

function googleAuthFile() {
  try {
    return path.join(app.getPath("userData"), "google-auth.json");
  } catch (e) {
    return path.join(os.tmpdir(), "rt-google-auth.json");
  }
}
function loadGoogleStore() {
  try {
    googleStore = JSON.parse(fs.readFileSync(googleAuthFile(), "utf-8")) || {};
  } catch (e) {
    googleStore = {};
  }
}
function saveGoogleStore() {
  try {
    fs.writeFileSync(googleAuthFile(), JSON.stringify(googleStore));
  } catch (e) {
    /* best effort */
  }
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makePkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier: verifier, challenge: challenge };
}

function httpsPostForm(host, pathName, formObj) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(formObj).toString();
    const r = https.request(
      {
        host: host,
        path: pathName,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (resp) => {
        let body = "";
        resp.on("data", (c) => (body += c));
        resp.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (e) {
            /* leave null */
          }
          resolve({ status: resp.statusCode, json: json, body: body });
        });
      }
    );
    r.on("error", reject);
    r.write(data);
    r.end();
  });
}

function callbackPage(title, note) {
  const safe = String(title).replace(/[<>&]/g, "");
  return (
    "<!doctype html><meta charset=utf-8><title>RatedTracker</title>" +
    "<body style='font-family:system-ui,Segoe UI,Arial;background:#15171a;color:#e8e8e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
    "<div style='text-align:center;max-width:520px;padding:0 24px'>" +
    "<h2 style='color:#e6c878;margin:0 0 8px'>" +
    safe +
    "</h2><p style='color:#9aa'>" +
    String(note || "You can close this tab and return to RatedTracker.") +
    "</p></div>"
  );
}
function sendHtml(res, html) {
  const b = Buffer.from(html, "utf-8");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", b.length);
  res.setHeader("Cache-Control", "no-store");
  res.end(b);
}

function startGoogleConnect(req, res, u) {
  const creds = resolveGoogleCreds(u.searchParams.get("clientId"), u.searchParams.get("secret"));
  const clientId = creds.clientId;
  const secret = creds.secret;
  if (!clientId) return sendJson(req, res, { ok: false, error: "Google Drive isn't set up yet." }, 400);
  if (!secret) return sendJson(req, res, { ok: false, error: "Missing Google client secret." }, 400);

  if (pendingGoogle) {
    try {
      clearTimeout(pendingGoogle.timer);
    } catch (e) {}
    try {
      sendJson(pendingGoogle.req, pendingGoogle.res, { ok: false, error: "Sign-in restarted." });
    } catch (e) {}
    pendingGoogle = null;
  }

  const pk = makePkce();
  const state = b64url(crypto.randomBytes(16));
  pendingGoogle = { state: state, verifier: pk.verifier, clientId: clientId, secret: secret, req: req, res: res, timer: null };
  pendingGoogle.timer = setTimeout(() => {
    if (!pendingGoogle) return;
    try {
      sendJson(pendingGoogle.req, pendingGoogle.res, { ok: false, error: "Google sign-in timed out. Try again." });
    } catch (e) {}
    pendingGoogle = null;
  }, 180000);

  const au = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  au.searchParams.set("client_id", clientId);
  au.searchParams.set("redirect_uri", GOOGLE_REDIRECT);
  au.searchParams.set("response_type", "code");
  au.searchParams.set("scope", DRIVE_SCOPE);
  au.searchParams.set("access_type", "offline");
  au.searchParams.set("prompt", "consent");
  au.searchParams.set("include_granted_scopes", "true");
  au.searchParams.set("code_challenge", pk.challenge);
  au.searchParams.set("code_challenge_method", "S256");
  au.searchParams.set("state", state);
  try {
    shell.openExternal(au.toString());
  } catch (e) {
    try {
      clearTimeout(pendingGoogle.timer);
    } catch (e2) {}
    pendingGoogle = null;
    return sendJson(req, res, { ok: false, error: "Could not open your browser for sign-in." });
  }
  // Response is held open and resolved by handleGoogleCallback (or the timeout above).
}

async function handleGoogleCallback(req, res, u) {
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const err = u.searchParams.get("error");

  if (!pendingGoogle || !state || state !== pendingGoogle.state) {
    return sendHtml(res, callbackPage("Sign-in could not be matched", "Start the connection again from RatedTracker."));
  }
  const pend = pendingGoogle;
  pendingGoogle = null;
  try {
    clearTimeout(pend.timer);
  } catch (e) {}

  if (err || !code) {
    try {
      sendJson(pend.req, pend.res, { ok: false, error: err || "Google returned no authorization code." });
    } catch (e) {}
    return sendHtml(res, callbackPage("Sign-in was cancelled", "You can close this tab."));
  }

  try {
    const tok = await httpsPostForm("oauth2.googleapis.com", "/token", {
      code: code,
      client_id: pend.clientId,
      client_secret: pend.secret,
      code_verifier: pend.verifier,
      grant_type: "authorization_code",
      redirect_uri: GOOGLE_REDIRECT,
    });
    if (tok.status >= 200 && tok.status < 300 && tok.json && tok.json.access_token) {
      if (tok.json.refresh_token) {
        googleStore[pend.clientId] = { refresh_token: tok.json.refresh_token };
        saveGoogleStore();
      }
      try {
        sendJson(pend.req, pend.res, { ok: true, access_token: tok.json.access_token, expires_in: tok.json.expires_in || 3600 });
      } catch (e) {}
      return sendHtml(res, callbackPage("Connected to Google Drive", "You can close this tab and return to RatedTracker."));
    }
    const em = (tok.json && (tok.json.error_description || tok.json.error)) || "HTTP " + tok.status;
    try {
      sendJson(pend.req, pend.res, { ok: false, error: "Token exchange failed: " + em });
    } catch (e) {}
    return sendHtml(res, callbackPage("Sign-in failed", String(em)));
  } catch (e) {
    try {
      sendJson(pend.req, pend.res, { ok: false, error: String((e && e.message) || e) });
    } catch (e2) {}
    return sendHtml(res, callbackPage("Sign-in failed", "Please try again."));
  }
}

async function handleGoogleToken(req, res, u) {
  const creds = resolveGoogleCreds(u.searchParams.get("clientId"), u.searchParams.get("secret"));
  const clientId = creds.clientId;
  const secret = creds.secret;
  const rec = clientId ? googleStore[clientId] : null;
  if (!rec || !rec.refresh_token) return sendJson(req, res, { ok: false, needConnect: true });
  try {
    const tok = await httpsPostForm("oauth2.googleapis.com", "/token", {
      client_id: clientId,
      client_secret: secret,
      refresh_token: rec.refresh_token,
      grant_type: "refresh_token",
    });
    if (tok.status >= 200 && tok.status < 300 && tok.json && tok.json.access_token) {
      return sendJson(req, res, { ok: true, access_token: tok.json.access_token, expires_in: tok.json.expires_in || 3600 });
    }
    if (tok.status === 400 || tok.status === 401) {
      delete googleStore[clientId];
      saveGoogleStore();
      return sendJson(req, res, { ok: false, needConnect: true });
    }
    const em = (tok.json && (tok.json.error_description || tok.json.error)) || "HTTP " + tok.status;
    return sendJson(req, res, { ok: false, error: em });
  } catch (e) {
    return sendJson(req, res, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// Local read-only HTTP API
// ---------------------------------------------------------------------------

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  const o = origin.toLowerCase();
  return o.startsWith("http://127.0.0.1") || o.startsWith("http://localhost") || o.startsWith("http://[::1]");
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  }
}

function sendJson(req, res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  res.statusCode = code || 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Cache-Control", "no-store");
  applyCors(req, res);
  res.end(body);
}

function send404(req, res, msg) {
  const body = Buffer.from(msg || "not found", "utf-8");
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  applyCors(req, res);
  res.end(body);
}

function serveCombatLog(req, res, u) {
  const name = u.searchParams.get("name");
  let offset = parseInt(u.searchParams.get("offset") || "", 10);
  if (!Number.isFinite(offset)) offset = null;

  let logPath = null;
  if (name) {
    const safe = path.basename(name);
    if (/^wowcombatlog.*\.txt$/i.test(safe) && logsDir()) {
      const cand = path.join(logsDir(), safe);
      if (fileInfo(cand)) logPath = cand;
    }
  } else {
    logPath = latestCombatLog();
  }
  if (!logPath) return send404(req, res, "no combat log found");

  let size;
  try {
    size = fs.statSync(logPath).size;
  } catch (e) {
    return send404(req, res, String(e));
  }

  let readFrom = 0;
  if (offset != null && offset > 0 && offset <= size) {
    // Align to a line boundary so we never emit a partial first line to the parser.
    try {
      const fd = fs.openSync(logPath, "r");
      const probe = Buffer.alloc(1);
      fs.readSync(fd, probe, 0, 1, offset - 1);
      if (probe[0] === 0x0a) {
        readFrom = offset;
      } else {
        let pos = offset;
        const buf = Buffer.alloc(8192);
        let found = false;
        while (pos < size && !found) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
          if (n <= 0) break;
          const idx = buf.subarray(0, n).indexOf(0x0a);
          if (idx >= 0) {
            readFrom = pos + idx + 1;
            found = true;
          } else {
            pos += n;
          }
        }
        if (!found) readFrom = size;
      }
      fs.closeSync(fd);
    } catch (e) {
      readFrom = 0;
    }
  }

  const remaining = Math.max(0, size - readFrom);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", remaining);
  res.setHeader("X-Log-Filename", path.basename(logPath));
  res.setHeader("X-Log-Size", String(size));
  res.setHeader("X-Log-Offset", String(readFrom));
  res.setHeader("Cache-Control", "no-store");
  applyCors(req, res);

  const stream = fs.createReadStream(logPath, {
    start: readFrom,
    end: size > 0 ? size - 1 : 0,
    highWaterMark: STREAM_CHUNK,
  });
  stream.on("error", () => {
    try {
      res.destroy();
    } catch (e) {
      /* ignore */
    }
  });
  stream.pipe(res);
}

function handleRequest(req, res) {
  let u;
  try {
    u = new URL(req.url, "http://127.0.0.1");
  } catch (e) {
    return send404(req, res, "bad request");
  }
  const p = u.pathname;

  if (req.method === "OPTIONS") {
    res.statusCode = originAllowed(req.headers.origin) ? 204 : 403;
    applyCors(req, res);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Content-Length", "0");
    return res.end();
  }

  if (p === "/" || p === "/api/ping") {
    return sendJson(req, res, {
      ok: true,
      app: APP_NAME,
      version: app.getVersion(),
      desktop: true,
      wowDetected: retailRoot != null,
      retailRoot: retailRoot,
    });
  }

  if (p === "/oauth2/callback") {
    void handleGoogleCallback(req, res, u);
    return;
  }
  if (p === "/api/google/connect") {
    return startGoogleConnect(req, res, u);
  }
  if (p === "/api/google/token") {
    void handleGoogleToken(req, res, u);
    return;
  }
  if (p === "/api/google/status") {
    const clientId = resolveGoogleCreds(u.searchParams.get("clientId"), "").clientId;
    const rec = clientId ? googleStore[clientId] : null;
    return sendJson(req, res, { ok: true, connected: !!(rec && rec.refresh_token) });
  }
  if (p === "/api/google/disconnect") {
    const clientId = resolveGoogleCreds(u.searchParams.get("clientId"), "").clientId;
    if (clientId && googleStore[clientId]) {
      delete googleStore[clientId];
      saveGoogleStore();
    }
    return sendJson(req, res, { ok: true });
  }

  if (p === "/api/watch/status") {
    const cl = latestCombatLog();
    const sv = latestSavedVariables();
    return sendJson(req, res, {
      ok: true,
      combatLog: cl ? fileInfo(cl) : null,
      savedVariables: sv ? fileInfo(sv) : null,
      logsDir: logsDir() && fs.existsSync(logsDir()) ? logsDir() : null,
      wtfDir: wtfAccountDir() && fs.existsSync(wtfAccountDir()) ? wtfAccountDir() : null,
      source: "companion-desktop",
    });
  }

  if (p === "/api/saved-variables") {
    const sv = latestSavedVariables();
    if (!sv) return send404(req, res, "no SavedVariables/RatedTracker.lua found");
    let data;
    try {
      data = fs.readFileSync(sv);
    } catch (e) {
      return send404(req, res, String(e));
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", data.length);
    res.setHeader("X-Sv-Filename", path.basename(sv));
    try {
      res.setHeader("X-Sv-Account-Path", path.basename(path.dirname(path.dirname(sv))));
    } catch (e) {
      /* ignore */
    }
    res.setHeader("Cache-Control", "no-store");
    applyCors(req, res);
    return res.end(data);
  }

  if (p === "/api/wow-combat-log-list") {
    return sendJson(req, res, listCombatLogs());
  }

  if (p === "/api/wow-combat-log") {
    return serveCombatLog(req, res, u);
  }

  return send404(req, res, "not found");
}

function startApiServer() {
  const server = http.createServer(handleRequest);
  // The Google connect request is held open until the browser redirect returns, so do not
  // let an idle-socket timeout kill it mid sign-in.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.on("error", (e) => {
    // Port busy most likely means another companion (or a second app copy) is already
    // serving. The window still works; the site uses whichever instance answers.
    console.error(APP_NAME + ": API bind failed:", e && e.message);
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(APP_NAME + " API on http://127.0.0.1:" + PORT + "/");
  });
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------

function iconPath() {
  const ico = path.join(__dirname, "assets", "icon.ico");
  return fs.existsSync(ico) ? ico : null;
}

function isAuthPopupUrl(u) {
  // Federated sign-in popups (the "Continue with Google/Apple/Microsoft" buttons on Dropbox's
  // authorize page) are opened with window.open and must run as a real in-app popup window so
  // they can post the result back to the opener. Sending them to the system browser breaks the
  // handshake (the external window has no way to talk to the page inside the app).
  try {
    const h = new URL(u).hostname.toLowerCase();
    return (
      h === "dropbox.com" ||
      h.endsWith(".dropbox.com") ||
      h === "google.com" ||
      h.endsWith(".google.com") ||
      h === "appleid.apple.com" ||
      h.endsWith(".apple.com") ||
      h.endsWith(".microsoftonline.com") ||
      h === "login.live.com" ||
      h.endsWith(".live.com") ||
      h.endsWith(".microsoft.com")
    );
  } catch (e) {
    return false;
  }
}

function cleanUserAgent() {
  // Strip "AppName/x" and "Electron/x" tokens so requests look like plain Chrome. Google refuses
  // OAuth from user agents it recognizes as an embedded app ("disallowed_useragent").
  let ua = app.userAgentFallback || "";
  ua = ua.replace(/\sElectron\/\S+/g, "");
  ua = ua.replace(new RegExp("\\s" + APP_NAME.replace(/[^A-Za-z0-9]/g, "") + "\\/\\S+", "g"), "");
  return ua.trim();
}

function createWindow() {
  const ic = iconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: ic || undefined,
    backgroundColor: "#0f0f0f",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(SITE_URL);

  // Browser-style zoom (Ctrl +/-/0 and Ctrl+mousewheel). Persisted so the chosen size
  // survives restarts, and reapplied on every load since Chromium resets it per navigation.
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.1;
  function applyZoom(f) {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(f * 100) / 100));
    companionPrefs.zoomFactor = z;
    try {
      mainWindow.webContents.setZoomFactor(z);
    } catch (e) {
      /* window gone */
    }
    saveCompanionPrefs();
  }
  mainWindow.webContents.on("did-finish-load", () => {
    try {
      mainWindow.webContents.setZoomFactor(companionPrefs.zoomFactor || 1);
    } catch (e) {
      /* window gone */
    }
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt || input.meta) return;
    const k = input.key || "";
    if (k === "+" || k === "=" || k === "Add") {
      applyZoom((companionPrefs.zoomFactor || 1) + ZOOM_STEP);
      event.preventDefault();
    } else if (k === "-" || k === "_" || k === "Subtract") {
      applyZoom((companionPrefs.zoomFactor || 1) - ZOOM_STEP);
      event.preventDefault();
    } else if (k === "0" || k === "Insert") {
      applyZoom(1);
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("zoom-changed", (_event, direction) => {
    const cur = companionPrefs.zoomFactor || 1;
    applyZoom(direction === "in" ? cur + ZOOM_STEP : cur - ZOOM_STEP);
  });

  // Auto-recover from a black screen. If Chromium's render process crashes (commonly an
  // out-of-memory after a long session parsing large combat logs) or the load fails, reload the
  // window instead of leaving a dead black view. A backoff guards against a tight reload loop.
  let rendererReloads = 0;
  let lastReloadAt = 0;
  function recoverRenderer() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const now = Date.now();
    if (now - lastReloadAt > 60000) rendererReloads = 0;
    lastReloadAt = now;
    rendererReloads += 1;
    if (rendererReloads > 5) return;
    const delay = Math.min(1000 * rendererReloads, 5000);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        mainWindow.webContents.reloadIgnoringCache();
      } catch (e) {
        try {
          mainWindow.loadURL(SITE_URL);
        } catch (e2) {
          /* give up; tray Quit/relaunch */
        }
      }
    }, delay);
  }
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    if (details && details.reason === "clean-exit") return;
    recoverRenderer();
  });
  mainWindow.webContents.on("unresponsive", recoverRenderer);
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) recoverRenderer();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopupUrl(url)) {
      // Open the provider sign-in as a real in-app popup so it can hand the result back to the
      // page that opened it (Dropbox's "Continue with Google/Apple/Microsoft").
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          backgroundColor: "#ffffff",
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    void handleWindowClose();
  });
}

function buildTray() {
  const ic = iconPath();
  const img = ic ? nativeImage.createFromPath(ic) : nativeImage.createEmpty();
  tray = new Tray(img);
  refreshTrayMenu();
  tray.setToolTip(APP_NAME);
  tray.on("double-click", showWindow);
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { label: "Version " + app.getVersion(), enabled: false },
    { label: "WoW: " + (retailRoot || "not detected"), enabled: false },
    { type: "separator" },
    { label: "Open RatedTracker", click: showWindow },
    {
      label: "Open WoW Logs folder",
      enabled: !!logsDir(),
      click: () => {
        if (logsDir()) shell.openPath(logsDir());
      },
    },
    updateDownloaded
      ? { label: "Restart to update", click: () => promptRestartToUpdate(null) }
      : { label: "Check for updates", click: manualCheckForUpdates },
    { label: "Re-detect WoW install", click: () => { retailRoot = detectRetailRoot(); refreshTrayMenu(); } },
    {
      label: process.platform === "win32" ? "Start with Windows" : "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "Not affiliated with or endorsed by Blizzard Entertainment.", enabled: false },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function showWindow() {
  if (!mainWindow) createWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// Single instance: focus the existing window instead of launching a second copy.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    try {
      app.userAgentFallback = cleanUserAgent();
    } catch (e) {
      /* keep default UA */
    }
    retailRoot = detectRetailRoot();
    loadGoogleStore();
    loadCompanionPrefs();
    startApiServer();
    createWindow();
    buildTray();
    setupAutoUpdates();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on("window-all-closed", () => {
    // Stay alive in the tray; do not quit on window close.
  });
}
