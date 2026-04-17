"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { startServer } = require("./server");

let mainWindow = null;
let serverInfo = null;

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

app.whenReady().then(async () => {
  try {
    await bootstrap();
    createWindow();
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
