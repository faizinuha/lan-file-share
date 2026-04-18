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

  // Cloudflare Tunnel — spawn cloudflared as child process of Electron main,
  // expose the public HTTPS URL back to the renderer so it can be shown with
  // a QR code. HP scans the QR, opens the HTTPS URL in Chrome/Safari, and
  // gets the proper "Install app" browser prompt (plain-LAN HTTP never does).
  startTunnel: () => ipcRenderer.invoke("start-tunnel"),
  stopTunnel: () => ipcRenderer.invoke("stop-tunnel"),
  getTunnelStatus: () => ipcRenderer.invoke("get-tunnel-status"),
  onTunnelEvent: (handler) => {
    const listener = (_evt, payload) => {
      try { handler(payload); } catch (_err) { /* ignore */ }
    };
    ipcRenderer.on("tunnel-event", listener);
    return () => ipcRenderer.removeListener("tunnel-event", listener);
  },
});
