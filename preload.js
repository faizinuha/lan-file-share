"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lanFileShare", {
  isElectronHost: true,
  pickSharedRoot: () => ipcRenderer.invoke("pick-shared-root"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  getServerInfo: () => ipcRenderer.invoke("get-server-info"),
});
