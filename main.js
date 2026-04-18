"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const { startServer } = require("./server");

let mainWindow = null;
let serverInfo = null;
let tray = null;
let quittingForReal = false;

// Cloudflare Tunnel child state. A single tunnel at a time — starting again
// tears down the previous child first so we never leak processes.
const tunnelState = {
  proc: null,
  url: null,
  starting: false,
};

// electron-updater is optional at dev time (not bundled with the repo
// installer), so we require it lazily and fall back to no-op when missing.
let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
} catch (_err) {
  autoUpdater = null;
}

// Compare two semver-like strings. Returns 1 if a > b, -1 if a < b, 0 if
// equal. Only the numeric release-tuple is compared; pre-release tags
// ("-beta.1" etc.) are ignored, which is fine for our "is there a newer
// published release?" check.
function compareVersions(a, b) {
  const parse = (v) => String(v || "0")
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] || 0;
    const y = bv[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function sendUpdateEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("update-event", payload);
  } catch (_err) {
    /* window gone */
  }
}

function wireAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.on("checking-for-update", () => {
    sendUpdateEvent({ type: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    sendUpdateEvent({ type: "available", version: info && info.version, notes: info && info.releaseNotes });
  });
  autoUpdater.on("update-not-available", (info) => {
    sendUpdateEvent({ type: "not-available", version: info && info.version });
  });
  autoUpdater.on("error", (err) => {
    sendUpdateEvent({ type: "error", message: err && err.message ? err.message : String(err) });
  });
  autoUpdater.on("download-progress", (p) => {
    sendUpdateEvent({ type: "progress", percent: p.percent, bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total });
  });
  autoUpdater.on("update-downloaded", (info) => {
    sendUpdateEvent({ type: "downloaded", version: info && info.version });
  });
}

const configPath = path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch (_err) {
    return {};
  }
}

function saveConfig(config) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("Failed to save config:", err);
  }
}

function defaultSharedRoot() {
  const home = app.getPath("home");
  return path.join(home, "LanFileShare");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function bootstrap() {
  const config = loadConfig();
  const sharedRoot = config.sharedRoot || defaultSharedRoot();
  ensureDir(sharedRoot);

  const hostName = config.hostName || `PC-${os.hostname()}`;
  const port = Number(process.env.LAN_FILE_SHARE_PORT) || config.port || 5000;

  serverInfo = await startServer({
    port,
    sharedRoot,
    hostDeviceName: hostName,
  });

  saveConfig({ ...config, sharedRoot, hostName, port: serverInfo.port });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "LAN File Share",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const url = `http://127.0.0.1:${serverInfo.port}/?host=1`;
  mainWindow.loadURL(url);

  if (process.env.LAN_FILE_SHARE_DEV) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("close", (e) => {
    // When a tray is active the first close hides the window instead of
    // killing the app — keeps foreground uploads/tunnel alive. User can
    // "Keluar" from the tray menu for a real quit.
    if (!quittingForReal && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("pick-shared-root", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Pilih folder yang mau dibagikan",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  const newRoot = result.filePaths[0];
  const config = loadConfig();
  saveConfig({ ...config, sharedRoot: newRoot });
  return { canceled: false, path: newRoot, restartRequired: true };
});

ipcMain.handle("open-external", async (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
  }
});

ipcMain.handle("get-server-info", async () => {
  return serverInfo ? serverInfo.publicInfo() : null;
});

ipcMain.handle("check-for-update", async () => {
  if (!autoUpdater) {
    return { supported: false, reason: "electron-updater not available (dev build?)" };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const currentVersion = app.getVersion();
    const latestVersion = result && result.updateInfo && result.updateInfo.version;
    // electron-updater's checkForUpdates() always reports updateInfo.version
    // as the latest *published* release, even when the running app is on a
    // newer dev build. Use semver comparison so we never show an update
    // notification for a downgrade.
    const hasUpdate = !!latestVersion && compareVersions(latestVersion, currentVersion) > 0;
    return {
      supported: true,
      currentVersion,
      latestVersion,
      hasUpdate,
    };
  } catch (err) {
    return { supported: true, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle("download-update", async () => {
  if (!autoUpdater) return { supported: false };
  try {
    await autoUpdater.downloadUpdate();
    return { supported: true, started: true };
  } catch (err) {
    return { supported: true, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle("install-update", async () => {
  if (!autoUpdater) return { supported: false };
  // Quit and install. The app will restart automatically.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { supported: true };
});

// --- Cloudflare Tunnel child process management ---------------------------
// `cloudflared tunnel --url http://localhost:<port>` spawns a quick tunnel
// and prints a `https://<random>.trycloudflare.com` URL to stderr once the
// connection is up. We parse that line, remember it, and surface it to the
// renderer so the UI can show a QR for the HP. Output of stdout/stderr after
// the URL is captured is discarded.

function sendTunnelEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send("tunnel-event", payload); } catch (_err) { /* ignore */ }
}

function cloudflaredBinary() {
  if (process.env.CLOUDFLARED_PATH) return process.env.CLOUDFLARED_PATH;
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function killTunnel() {
  if (!tunnelState.proc) return;
  try {
    if (process.platform === "win32") {
      // cloudflared on Windows handles Ctrl+C cleanly via SIGTERM equiv.
      tunnelState.proc.kill();
    } else {
      tunnelState.proc.kill("SIGTERM");
    }
  } catch (_err) { /* ignore */ }
  tunnelState.proc = null;
  tunnelState.url = null;
  tunnelState.starting = false;
}

async function startTunnel() {
  if (tunnelState.starting) {
    return { ok: false, error: "Tunnel sedang dimulai, tunggu sebentar." };
  }
  if (tunnelState.proc && tunnelState.url) {
    return { ok: true, url: tunnelState.url, reused: true };
  }
  if (tunnelState.proc) {
    // A process is alive but we don't have a URL yet — assume it's stuck,
    // clean up and retry fresh.
    killTunnel();
  }
  if (!serverInfo) {
    return { ok: false, error: "Server belum siap" };
  }

  tunnelState.starting = true;

  let proc;
  try {
    proc = spawn(cloudflaredBinary(), [
      "tunnel",
      "--url",
      `http://localhost:${serverInfo.port}`,
      "--no-autoupdate",
    ], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    tunnelState.starting = false;
    return { ok: false, error: `cloudflared gagal dijalankan: ${err && err.message ? err.message : String(err)}` };
  }

  tunnelState.proc = proc;

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      tunnelState.starting = false;
      resolve(payload);
    };

    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const handleChunk = (chunk) => {
      const text = chunk.toString();
      if (tunnelState.url) return;
      const m = text.match(urlRe);
      if (m) {
        tunnelState.url = m[0];
        sendTunnelEvent({ type: "ready", url: tunnelState.url });
        finish({ ok: true, url: tunnelState.url });
      }
    };

    proc.stdout.on("data", handleChunk);
    proc.stderr.on("data", handleChunk);

    proc.on("error", (err) => {
      killTunnel();
      const hint = err && err.code === "ENOENT"
        ? "cloudflared nggak ketemu di PATH. Install dulu dari https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        : (err && err.message ? err.message : String(err));
      finish({ ok: false, error: hint });
    });

    proc.on("exit", (code) => {
      const url = tunnelState.url;
      // Only reset shared state if *this* process is still the active one.
      // Otherwise a SIGTERM'd proc1 firing exit after a new startTunnel()
      // would overwrite tunnelState.proc (now proc2) to null and orphan it.
      if (tunnelState.proc === proc) {
        tunnelState.proc = null;
        tunnelState.url = null;
        tunnelState.starting = false;
        sendTunnelEvent({ type: "exit", code, url });
      }
      if (!settled) {
        finish({ ok: false, error: `cloudflared keluar (code ${code}) sebelum URL muncul` });
      }
    });

    // Guard rail: if no URL is seen in 45s, abort.
    setTimeout(() => {
      if (!tunnelState.url) {
        killTunnel();
        finish({ ok: false, error: "Timeout: cloudflared nggak kasih URL dalam 45 detik" });
      }
    }, 45_000);
  });
}

ipcMain.handle("start-tunnel", () => startTunnel());
ipcMain.handle("stop-tunnel", async () => { killTunnel(); return { ok: true }; });
ipcMain.handle("get-tunnel-status", async () => ({
  running: !!(tunnelState.proc && tunnelState.url),
  url: tunnelState.url,
}));

// --- System tray ---------------------------------------------------------
// Keeps the app quickly reachable after the user closes the window — a
// common request so foreground uploads keep running.

function trayIcon() {
  // Fall back to a 1x1 empty image if the PNG isn't present yet (e.g. in a
  // fresh checkout before `npm run generate-icons`). Electron still renders
  // a placeholder in the tray so the menu works.
  const p = path.join(__dirname, "public", "icons", "icon-192.png");
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    // 16px for Windows/Linux, 18px for macOS template.
    return img.resize({ width: process.platform === "darwin" ? 18 : 16 });
  }
  return nativeImage.createEmpty();
}

function openSharedRoot() {
  if (serverInfo && serverInfo.sharedRoot) {
    shell.openPath(serverInfo.sharedRoot).catch(() => { /* ignore */ });
  }
}

function toggleWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Tampilkan aplikasi", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
    { label: "Buka folder shared", click: openSharedRoot },
    { type: "separator" },
    {
      label: tunnelState.url ? `Tunnel: ${tunnelState.url}` : "Install ke HP (tunnel)",
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        if (mainWindow) mainWindow.webContents.send("tunnel-event", { type: "open-modal" });
      },
    },
    {
      label: "Cek update",
      click: () => {
        if (!autoUpdater) return;
        autoUpdater.checkForUpdates().catch(() => { /* ignore */ });
      },
    },
    { type: "separator" },
    {
      label: "Keluar",
      click: () => {
        quittingForReal = true;
        app.quit();
      },
    },
  ]);
}

function setupTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip("LAN File Share");
    tray.setContextMenu(buildTrayMenu());
    tray.on("click", () => {
      if (process.platform !== "darwin") toggleWindow();
    });
    tray.on("double-click", toggleWindow);
  } catch (err) {
    // Trays are unsupported on some Linux configurations (e.g. Wayland
    // without status-notifier support) — fall back to window-only mode.
    console.error("Tray setup failed:", err);
    tray = null;
  }
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

app.whenReady().then(async () => {
  try {
    await bootstrap();
    createWindow();
    setupTray();
    wireAutoUpdater();
    // Silent check ~5s after window is up. The UI receives events via IPC
    // and shows a toast + modal only if an update is actually available.
    if (autoUpdater && app.isPackaged) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => { /* ignore */ });
      }, 5000);
    }
  } catch (err) {
    dialog.showErrorBox("Gagal memulai server", String(err && err.stack ? err.stack : err));
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Keep tunnel label fresh in the tray context menu.
setInterval(() => refreshTrayMenu(), 10_000).unref();

app.on("before-quit", () => {
  quittingForReal = true;
  killTunnel();
});

app.on("window-all-closed", () => {
  // With a tray active we intentionally keep the app running on all
  // platforms until the user picks "Keluar" from the tray.
  if (tray) return;
  if (process.platform !== "darwin") app.quit();
});
