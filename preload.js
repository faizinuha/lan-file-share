"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lanFileShare", {
  isElectronHost: true,
  pickSharedRoot: () => ipcRenderer.invoke("pick-shared-root"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  getServerInfo: () => ipcRenderer.invoke("get-server-info"),
  checkForUpdate: () => ipcRenderer.invoke("check-for-update"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateEvent: (handler) => {
    const listener = (_evt, payload) => {
      try { handler(payload); } catch (_err) { /* ignore */ }
    };
    ipcRenderer.on("update-event", listener);
    return () => ipcRenderer.removeListener("update-event", listener);
  },
});
