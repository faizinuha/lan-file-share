"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { startServer } = require("./server");

let mainWindow = null;
let serverInfo = null;

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

app.whenReady().then(async () => {
  try {
    await bootstrap();
    createWindow();
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
