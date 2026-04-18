"use strict";

const state = {
  me: null, // { id, name, kind }
  currentPath: "",
  devices: [],
  status: null, // { host, sharedRoot, lan, port }
  tunnel: { running: false, url: null },
  ws: null,
  pingTimer: null,
  searchTimer: null,
  // Upload preferences (can be tweaked from the UI).
  uploadPrefs: {
    autoResizeImages: true,
    maxImageDim: 2048,
    jpegQuality: 0.85,
    // Files larger than this are uploaded in 4 MB chunks so the browser
    // never needs to hold the whole file in RAM (critical on low-memory HPs).
    chunkThreshold: 8 * 1024 * 1024,
    chunkSize: 4 * 1024 * 1024,
    maxRetries: 3,
  },
  update: {
    latest: null,
    hasUpdate: false,
    downloading: false,
    downloaded: false,
  },
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function toast(message, kind = "") {
  const container = $("toasts");
  if (!container) return;
  const t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity 0.3s ease";
  }, 2400);
  setTimeout(() => t.remove(), 2800);
}

function show(el) { if (el) el.classList.remove("hidden"); }
function hide(el) { if (el) el.classList.add("hidden"); }

function loadMe() {
  try {
    const raw = localStorage.getItem("lfs-me");
    return raw ? JSON.parse(raw) : null;
  } catch (_err) {
    return null;
  }
}

function saveMe(me) {
  localStorage.setItem("lfs-me", JSON.stringify(me));
}

function clearMe() {
  localStorage.removeItem("lfs-me");
}

function loadUploadPrefs() {
  try {
    const raw = localStorage.getItem("lfs-upload-prefs");
    if (!raw) return;
    Object.assign(state.uploadPrefs, JSON.parse(raw));
  } catch (_err) { /* ignore */ }
}

function saveUploadPrefs() {
  try {
    localStorage.setItem("lfs-upload-prefs", JSON.stringify(state.uploadPrefs));
  } catch (_err) { /* ignore */ }
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_err) {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || "request failed";
    throw new Error(msg);
  }
  return data;
}

async function registerDevice() {
  const nameEl = $("device-name");
  const errorEl = $("register-error");
  const name = (nameEl.value || "").trim();
  const kind = document.querySelector('input[name="kind"]:checked')?.value || "mobile";
  hide(errorEl);
  if (!name) {
    errorEl.textContent = "Nama device wajib diisi.";
    show(errorEl);
    return;
  }
  try {
    const { device } = await api("/api/devices/register", {
      method: "POST",
      body: JSON.stringify({ name, kind }),
    });
    state.me = device;
    saveMe(device);
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.message;
    show(errorEl);
  }
}

async function enterApp() {
  hide($("register-screen"));
  show($("main-screen"));
  setText($("my-name"), state.me.name + " (" + state.me.kind + ")");
  await loadStatus();
  await loadFiles("");
  openWebSocket();
  startPinging();
  setupPwaSync();
  if (window.lanFileShare && window.lanFileShare.isElectronHost) {
    show($("pick-folder"));
    show($("check-update"));
    wireUpdateListener();
  }
}

async function updateInstallHint() {
  const banner = $("install-hint");
  if (!banner) return;
  // Only show on HP (mobile), when on plain HTTP from a non-localhost host,
  // when install can't already be triggered natively, and when the user
  // hasn't dismissed it.
  const dismissed = localStorage.getItem("lfs-install-hint-dismissed") === "1";
  const isMobile = state.me && state.me.kind === "mobile";
  const isHttp = location.protocol === "http:";
  const isLocalhost = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  const alreadyInstalled = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
  if (!dismissed && isMobile && isHttp && !isLocalhost && !alreadyInstalled) {
    show(banner);
  } else {
    hide(banner);
  }
}

function maybeShowSharedToast() {
  try {
    const params = new URLSearchParams(location.search);
    const shared = Number(params.get("shared") || 0);
    if (shared > 0) {
      const dest = params.get("dest") || "Shared-from-Phone";
      toast(`${shared} file diterima dari share → ${dest}`, "ok");
      params.delete("shared");
      params.delete("dest");
      const q = params.toString();
      history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
    }
  } catch (_err) { /* ignore */ }
}

async function loadStatus() {
  try {
    const s = await api("/api/status");
    state.status = s;
    const lan = s.lan && s.lan[0];
    if (lan) {
      setText($("server-ip"), `Server: ${lan.address}:${s.port}`);
    }
    // Device list may have been fetched before status (host id unknown then)
    // — re-render so the host pill + kick-button gating is correct.
    renderDevices();
    updateInstallHint();
  } catch (_err) {
    setText($("server-ip"), "Server: ?");
  }
}

function openWebSocket() {
  try {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      $("status-dot").classList.add("online");
      try {
        ws.send(JSON.stringify({ type: "ping", deviceId: state.me.id }));
      } catch (_err) { /* ignore */ }
    };
    ws.onclose = () => {
      $("status-dot").classList.remove("online");
      setTimeout(openWebSocket, 2000);
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "devices") {
          state.devices = msg.devices;
          renderDevices();
        } else if (msg.type === "files-changed") {
          loadFiles(state.currentPath).catch(() => { /* ignore */ });
        }
      } catch (_err) { /* ignore */ }
    };
  } catch (err) {
    console.error("ws failed:", err);
  }
}

function startPinging() {
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pingTimer = setInterval(async () => {
    if (!state.me) return;
    try {
      await api(`/api/devices/${encodeURIComponent(state.me.id)}/ping`, { method: "POST" });
    } catch (_err) {
      try {
        const { device } = await api("/api/devices/register", {
          method: "POST",
          body: JSON.stringify({ name: state.me.name, kind: state.me.kind }),
        });
        state.me = device;
        saveMe(device);
      } catch (_err2) { /* ignore */ }
    }
  }, 15_000);
}

function renderDevices() {
  const ul = $("device-list");
  ul.innerHTML = "";
  const hostId = state.status && state.status.host && state.status.host.id;
  for (const d of state.devices) {
    const li = document.createElement("li");
    const isMe = state.me && d.id === state.me.id;
    const isHost = hostId && d.id === hostId;
    if (isMe) li.classList.add("me");
    if (isHost) li.classList.add("host");
    // Host (PC server) and self are never kickable.
    const canKick = !isHost && !isMe;
    li.innerHTML = `
      <span class="dev-name">${escapeHtml(d.name)}</span>
      <span class="kind">${escapeHtml(d.kind)}${isHost ? " · host" : ""}</span>
      ${canKick ? `<button class="kick-btn" data-id="${escapeHtml(d.id)}" title="Keluarkan dari daftar online" aria-label="Keluarkan ${escapeHtml(d.name)} dari daftar">✕</button>` : ""}
    `;
    ul.appendChild(li);
  }
}

async function kickDevice(id, name) {
  const ok = await openConfirm({
    title: "Keluarkan dari daftar",
    message: `Yakin keluarkan "${name}" dari daftar device online? Device itu bisa register ulang kapan aja.`,
  });
  if (!ok) return;
  try {
    await api(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(`"${name}" dikeluarkan`, "success");
  } catch (err) {
    toast(`Gagal: ${err.message || err}`, "error");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function humanSize(n) {
  if (!n && n !== 0) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function humanDate(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch (_err) {
    return "";
  }
}

function breadcrumbParts(p) {
  const parts = (p || "").split("/").filter(Boolean);
  const acc = [];
  const out = [{ label: "Root", path: "" }];
  for (const part of parts) {
    acc.push(part);
    out.push({ label: part, path: acc.join("/") });
  }
  return out;
}

function renderBreadcrumbs() {
  const nav = $("breadcrumbs");
  nav.innerHTML = "";
  const parts = breadcrumbParts(state.currentPath);
  parts.forEach((part, idx) => {
    const span = document.createElement("span");
    span.className = "crumb" + (idx === parts.length - 1 ? " current" : "");
    span.textContent = part.label;
    if (idx !== parts.length - 1) {
      span.addEventListener("click", () => loadFiles(part.path));
    }
    nav.appendChild(span);
    if (idx < parts.length - 1) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      nav.appendChild(sep);
    }
  });
}

async function loadFiles(relPath) {
  state.currentPath = (relPath || "").replace(/^\/+/, "");
  renderBreadcrumbs();
  try {
    const { entries } = await api(`/api/files?path=${encodeURIComponent(state.currentPath)}`);
    renderFileList(entries);
  } catch (err) {
    toast("Gagal buka folder: " + err.message, "error");
  }
}

function fileIcon(entry) {
  if (entry.isDirectory) return "F";
  const m = entry.mime || "";
  if (m.startsWith("image/")) return "I";
  if (m.startsWith("video/")) return "V";
  if (m.startsWith("audio/")) return "A";
  if (m.startsWith("text/")) return "T";
  if (m.includes("pdf")) return "P";
  return "?";
}

function renderFileList(entries) {
  const list = $("file-list");
  const empty = $("empty-state");
  list.innerHTML = "";
  if (!entries || entries.length === 0) {
    show(empty);
    return;
  }
  hide(empty);
  for (const e of entries) {
    const card = document.createElement("div");
    card.className = "file-card";
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (!e.isDirectory && e.mime && e.mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = `/api/files/preview?path=${encodeURIComponent(e.path)}`;
      img.loading = "lazy";
      img.alt = e.name;
      thumb.appendChild(img);
    } else {
      thumb.textContent = fileIcon(e);
    }
    const name = document.createElement("div");
    name.className = "name";
    name.title = e.name;
    name.textContent = e.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${e.isDirectory ? "folder" : humanSize(e.size)}</span><span>${humanDate(e.mtime)}</span>`;
    const actions = document.createElement("div");
    actions.className = "actions";

    if (e.isDirectory) {
      card.addEventListener("click", () => loadFiles(e.path));
    } else {
      card.addEventListener("click", (ev) => {
        if (ev.target.closest("button")) return;
        openPreview(e);
      });
    }

    if (!e.isDirectory) {
      const dl = document.createElement("button");
      dl.textContent = "Download";
      dl.addEventListener("click", (ev) => { ev.stopPropagation(); downloadFile(e); });
      actions.appendChild(dl);
      const share = document.createElement("button");
      share.textContent = "Share";
      share.addEventListener("click", (ev) => { ev.stopPropagation(); openShare(e); });
      actions.appendChild(share);
    }
    const rn = document.createElement("button");
    rn.textContent = "Rename";
    rn.addEventListener("click", (ev) => { ev.stopPropagation(); renameEntry(e); });
    actions.appendChild(rn);
    const del = document.createElement("button");
    del.textContent = "Hapus";
    del.addEventListener("click", (ev) => { ev.stopPropagation(); deleteEntry(e); });
    actions.appendChild(del);

    card.appendChild(thumb);
    card.appendChild(name);
    card.appendChild(meta);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function downloadFile(entry) {
  const a = document.createElement("a");
  a.href = `/api/files/download?path=${encodeURIComponent(entry.path)}`;
  a.download = entry.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openPreview(entry) {
  const modal = $("preview-modal");
  const body = $("preview-body");
  setText($("preview-name"), entry.name);
  body.innerHTML = "";
  const url = `/api/files/preview?path=${encodeURIComponent(entry.path)}`;
  const m = entry.mime || "";
  if (m.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = url;
    body.appendChild(img);
  } else if (m.startsWith("video/")) {
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    body.appendChild(v);
  } else if (m.startsWith("audio/")) {
    const a = document.createElement("audio");
    a.src = url;
    a.controls = true;
    body.appendChild(a);
  } else if (m.startsWith("text/") || m.includes("json") || m.includes("xml")) {
    const pre = document.createElement("pre");
    pre.textContent = "Loading...";
    body.appendChild(pre);
    fetch(url).then((r) => r.text()).then((t) => { pre.textContent = t; }).catch((err) => { pre.textContent = "Gagal memuat: " + err.message; });
  } else {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Tidak ada preview untuk tipe ini. Pakai tombol Download.";
    body.appendChild(p);
  }
  show(modal);
}

function openShare(entry) {
  const modal = $("share-modal");
  setText($("share-file"), entry.path);
  hide($("share-result"));
  modal.dataset.path = entry.path;
  show(modal);
}

async function generateShareLink() {
  const modal = $("share-modal");
  const rel = modal.dataset.path;
  const expiresInMinutes = Number($("share-expiry").value);
  try {
    const { url } = await api("/api/share", {
      method: "POST",
      body: JSON.stringify({ path: rel, expiresInMinutes }),
    });
    $("share-url").value = url;
    show($("share-result"));
  } catch (err) {
    toast("Gagal buat link: " + err.message, "error");
  }
}

function renameEntry(entry) {
  openPrompt({
    title: "Rename",
    label: "Nama baru",
    value: entry.name,
    onOk: async (newName) => {
      if (!newName || newName === entry.name) return;
      try {
        await api("/api/files/rename", {
          method: "POST",
          body: JSON.stringify({ path: entry.path, newName }),
        });
        toast("Rename berhasil", "ok");
        await loadFiles(state.currentPath);
      } catch (err) {
        toast("Gagal rename: " + err.message, "error");
      }
    },
  });
}

function deleteEntry(entry) {
  openConfirm({
    title: "Hapus?",
    message: `Yakin mau hapus "${entry.name}"? Ini tidak bisa di-undo.`,
    onOk: async () => {
      try {
        await api(`/api/files?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" });
        toast("Terhapus", "ok");
        await loadFiles(state.currentPath);
      } catch (err) {
        toast("Gagal hapus: " + err.message, "error");
      }
    },
  });
}

// ======================================================================
// Uploads
// ======================================================================
//
// Low-memory phones fail large photo uploads for three reasons: the camera
// JPEG is huge (5-20 MB), the browser tries to buffer the whole multipart
// body in RAM, and a single dropped TCP packet kills the whole transfer.
//
//   1. If the file is an image and auto-resize is on, we draw it to a
//      <canvas> and re-encode at a sensible size (default 2048px, 85%
//      JPEG). Usually shrinks a 5 MB phone photo to ~300 KB.
//   2. For any file above `chunkThreshold` (default 8 MB) we switch from
//      multipart form-data to our own /api/files/upload-chunk endpoint.
//      File.slice() returns a lightweight Blob reference, not a copy, so
//      RAM stays flat.
//   3. Every chunk (and every non-chunked upload) is wrapped in a retry
//      with exponential backoff, so transient drops don't abort transfers.

async function resizeImageIfNeeded(file) {
  const prefs = state.uploadPrefs;
  if (!prefs.autoResizeImages) return file;
  if (!file.type || !file.type.startsWith("image/")) return file;
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;
  if (file.size < 500 * 1024) return file;
  try {
    const bitmap = typeof createImageBitmap === "function"
      ? await createImageBitmap(file)
      : await loadImageFallback(file);
    const origW = bitmap.width || bitmap.naturalWidth || 0;
    const origH = bitmap.height || bitmap.naturalHeight || 0;
    if (!origW || !origH) return file;
    const max = prefs.maxImageDim;
    const scale = Math.min(1, max / Math.max(origW, origH));
    const w = Math.round(origW * scale);
    const h = Math.round(origH * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", prefs.jpegQuality)
    );
    if (!blob || blob.size >= file.size) return file;
    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg", lastModified: Date.now() });
  } catch (err) {
    console.warn("resize failed, uploading original:", err);
    return file;
  }
}

function loadImageFallback(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, { maxRetries, label }) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt += 1;
      if (attempt > maxRetries) throw err;
      const backoff = Math.min(8000, 500 * Math.pow(2, attempt - 1));
      console.warn(`[${label}] attempt ${attempt} failed:`, err.message || err, `retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

function updateUploadQueueUI() {
  const panel = $("upload-panel");
  const list = $("upload-list");
  if (!panel || !list) return;
  if (list.children.length === 0) hide(panel); else show(panel);
}

function addUploadItem(name, size) {
  const list = $("upload-list");
  if (!list) return { setProgress: () => {}, setStatus: () => {}, remove: () => {} };
  const row = document.createElement("div");
  row.className = "upload-item";
  row.innerHTML = `
    <div class="upload-head">
      <span class="upload-name"></span>
      <span class="upload-size"></span>
    </div>
    <div class="upload-bar"><div class="upload-fill"></div></div>
    <div class="upload-status muted">Menyiapkan...</div>
  `;
  row.querySelector(".upload-name").textContent = name;
  row.querySelector(".upload-size").textContent = humanSize(size);
  list.appendChild(row);
  updateUploadQueueUI();
  const fill = row.querySelector(".upload-fill");
  const status = row.querySelector(".upload-status");
  return {
    setProgress(pct) { fill.style.width = Math.max(0, Math.min(100, pct)) + "%"; },
    setStatus(text, kind) {
      status.textContent = text;
      status.className = "upload-status" + (kind ? " " + kind : " muted");
    },
    remove() {
      setTimeout(() => { row.remove(); updateUploadQueueUI(); }, 1500);
    },
  };
}

async function uploadOneSmall(file, targetPath, ui) {
  const url = `/api/files/upload?path=${encodeURIComponent(targetPath)}`;
  const prefs = state.uploadPrefs;
  await withRetry(async (attempt) => {
    if (attempt > 0) ui.setStatus(`Retry ${attempt}...`);
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) ui.setProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText || "upload failed"}`));
      };
      xhr.onerror = () => reject(new Error("network error"));
      xhr.ontimeout = () => reject(new Error("timeout"));
      const fd = new FormData();
      fd.append("files", file, file.name);
      xhr.send(fd);
    });
  }, { maxRetries: prefs.maxRetries, label: `upload ${file.name}` });
}

async function uploadOneChunked(file, targetPath, ui) {
  const prefs = state.uploadPrefs;
  const chunkSize = prefs.chunkSize;
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const sessionId = (crypto.randomUUID && crypto.randomUUID().replace(/-/g, "")) ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2));
  let sent = 0;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const blob = file.slice(start, end);
    const url = `/api/files/upload-chunk?sessionId=${encodeURIComponent(sessionId)}` +
      `&chunkIndex=${i}&totalChunks=${totalChunks}` +
      `&fileName=${encodeURIComponent(file.name)}` +
      `&targetPath=${encodeURIComponent(targetPath)}`;

    // eslint-disable-next-line no-await-in-loop
    await withRetry(async (attempt) => {
      if (attempt > 0) ui.setStatus(`Retry chunk ${i + 1}/${totalChunks} (attempt ${attempt})...`);
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const localFraction = e.loaded / e.total;
            const overall = (sent + localFraction * blob.size) / file.size;
            ui.setProgress(overall * 100);
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || xhr.statusText || "chunk failed"}`));
        };
        xhr.onerror = () => reject(new Error("network error"));
        xhr.ontimeout = () => reject(new Error("timeout"));
        xhr.send(blob);
      });
    }, { maxRetries: prefs.maxRetries, label: `chunk ${i + 1}/${totalChunks} ${file.name}` });

    sent += blob.size;
    ui.setProgress((sent / file.size) * 100);
    ui.setStatus(`Chunk ${i + 1}/${totalChunks} terkirim`);
  }
  ui.setProgress(100);
}

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  const targetPath = state.currentPath;
  const prefs = state.uploadPrefs;
  for (const original of files) {
    // eslint-disable-next-line no-await-in-loop
    await uploadOneWithUI(original, targetPath, prefs);
  }
  loadFiles(state.currentPath).catch(() => { /* ignore */ });
}

async function uploadOneWithUI(original, targetPath, prefs) {
  const ui = addUploadItem(original.name, original.size);
  try {
    ui.setStatus("Memproses...");
    let file = original;
    if (prefs.autoResizeImages && original.type && original.type.startsWith("image/")) {
      file = await resizeImageIfNeeded(original);
      if (file !== original) {
        ui.setStatus(`Foto di-resize ${humanSize(original.size)} -> ${humanSize(file.size)}`);
      }
    }
    if (file.size > prefs.chunkThreshold) {
      ui.setStatus(`Mengirim ${Math.ceil(file.size / prefs.chunkSize)} chunk...`);
      await uploadOneChunked(file, targetPath, ui);
    } else {
      ui.setStatus("Mengunggah...");
      await uploadOneSmall(file, targetPath, ui);
    }
    ui.setProgress(100);
    ui.setStatus("Selesai", "ok");
    toast(`Upload: ${file.name}`, "ok");
  } catch (err) {
    ui.setStatus("Gagal: " + (err.message || err), "error");
    toast("Upload gagal: " + (err.message || err), "error");
  } finally {
    ui.remove();
  }
}

function promptMkdir() {
  openPrompt({
    title: "Folder baru",
    label: "Nama folder",
    value: "",
    onOk: async (name) => {
      if (!name) return;
      try {
        await api("/api/files/mkdir", {
          method: "POST",
          body: JSON.stringify({ path: state.currentPath, name }),
        });
        toast("Folder dibuat", "ok");
        await loadFiles(state.currentPath);
      } catch (err) {
        toast("Gagal: " + err.message, "error");
      }
    },
  });
}

async function showQr() {
  const modal = $("qr-modal");
  show(modal);
  try {
    const { url, dataUrl } = await api("/api/qrcode");
    $("qr-img").src = dataUrl;
    $("qr-url").textContent = url;
  } catch (err) {
    toast("Gagal buat QR: " + err.message, "error");
  }
}

function openConfirm({ title, message, onOk }) {
  const modal = $("confirm-modal");
  setText($("confirm-title"), title);
  setText($("confirm-message"), message);
  const ok = $("confirm-ok");
  const handler = () => {
    ok.removeEventListener("click", handler);
    hide(modal);
    Promise.resolve(onOk && onOk()).catch(() => { /* ignore */ });
  };
  ok.addEventListener("click", handler);
  show(modal);
}

function openPrompt({ title, label, value, onOk }) {
  const modal = $("prompt-modal");
  setText($("prompt-title"), title);
  setText($("prompt-label"), label);
  const input = $("prompt-input");
  input.value = value || "";
  const ok = $("prompt-ok");
  const handler = () => {
    ok.removeEventListener("click", handler);
    input.removeEventListener("keydown", keyHandler);
    hide(modal);
    Promise.resolve(onOk && onOk(input.value.trim())).catch(() => { /* ignore */ });
  };
  const keyHandler = (e) => {
    if (e.key === "Enter") handler();
  };
  ok.addEventListener("click", handler);
  input.addEventListener("keydown", keyHandler);
  show(modal);
  setTimeout(() => input.focus(), 0);
}

async function doSearch(query) {
  if (!query) {
    await loadFiles(state.currentPath);
    return;
  }
  try {
    const { results } = await api(`/api/files/search?query=${encodeURIComponent(query)}&path=${encodeURIComponent(state.currentPath)}`);
    renderFileList(results);
  } catch (err) {
    toast("Pencarian gagal: " + err.message, "error");
  }
}

function setupPwaSync() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => { /* ignore */ });
  }
}

// ======================================================================
// Auto-update (Electron-only)
// ======================================================================

function wireUpdateListener() {
  if (!(window.lanFileShare && window.lanFileShare.onUpdateEvent)) return;
  window.lanFileShare.onUpdateEvent((evt) => {
    if (!evt || !evt.type) return;
    const modal = $("update-modal");
    const status = $("update-status");
    const progress = $("update-progress");
    const fill = $("update-progress-fill");
    const installBtn = $("update-install");
    const downloadBtn = $("update-download");
    switch (evt.type) {
      case "checking":
        setText(status, "Mengecek update...");
        break;
      case "available":
        state.update.latest = evt.version;
        state.update.hasUpdate = true;
        setText(status, `Versi baru tersedia: v${evt.version}`);
        setText($("update-version"), `v${evt.version}`);
        show(modal);
        show(downloadBtn);
        hide(installBtn);
        hide(progress);
        toast(`Update v${evt.version} tersedia`, "ok");
        break;
      case "not-available":
        setText(status, "Sudah versi terbaru.");
        break;
      case "progress": {
        state.update.downloading = true;
        const pct = Math.round(evt.percent || 0);
        show(progress);
        fill.style.width = pct + "%";
        setText(status, `Download ${pct}% (${humanSize(evt.transferred)} / ${humanSize(evt.total)})`);
        break;
      }
      case "downloaded":
        state.update.downloading = false;
        state.update.downloaded = true;
        setText(status, `Update v${evt.version} siap diinstall.`);
        hide(downloadBtn);
        show(installBtn);
        toast("Update siap - klik Install sekarang.", "ok");
        break;
      case "error":
        setText(status, "Gagal: " + (evt.message || "unknown"));
        break;
      default:
        break;
    }
  });
}

async function manualCheckUpdate() {
  if (!(window.lanFileShare && window.lanFileShare.checkForUpdate)) {
    toast("Cek update cuma tersedia di app desktop.", "error");
    return;
  }
  toast("Mengecek update...");
  try {
    const result = await window.lanFileShare.checkForUpdate();
    if (!result) return;
    if (!result.supported) {
      toast("Updater nggak aktif di build dev.", "error");
      return;
    }
    if (result.error) {
      toast("Gagal cek: " + result.error, "error");
      return;
    }
    if (result.hasUpdate) {
      setText($("update-version"), `v${result.latestVersion}`);
      show($("update-modal"));
    } else {
      toast(`Sudah versi terbaru (v${result.currentVersion}).`, "ok");
    }
  } catch (err) {
    toast("Gagal cek: " + err.message, "error");
  }
}

async function startUpdateDownload() {
  if (!(window.lanFileShare && window.lanFileShare.downloadUpdate)) return;
  try {
    const res = await window.lanFileShare.downloadUpdate();
    if (res && res.error) toast("Download gagal: " + res.error, "error");
  } catch (err) {
    toast("Download gagal: " + err.message, "error");
  }
}

async function installUpdateNow() {
  if (!(window.lanFileShare && window.lanFileShare.installUpdate)) return;
  try {
    await window.lanFileShare.installUpdate();
  } catch (err) {
    toast("Install gagal: " + err.message, "error");
  }
}

function wireInstallHp() {
  const btn = $("install-hp");
  const modal = $("install-hp-modal");
  if (!btn || !modal) return;

  const lf = window.lanFileShare;
  const pre = $("install-hp-prestart");
  const starting = $("install-hp-starting");
  const running = $("install-hp-running");
  const errBox = $("install-hp-error");
  const errMsg = $("install-hp-error-msg");
  const urlEl = $("tunnel-url");
  const qrEl = $("tunnel-qr");
  const startBtn = $("start-tunnel");
  const stopBtn = $("stop-tunnel");
  const retryBtn = $("retry-tunnel");
  const copyBtn = $("copy-tunnel-url");
  const downloadLink = $("cloudflared-download");

  // Only the Electron host PC can start a tunnel (PWA on HP can't spawn
  // child processes), so we show the "Install ke HP" button only there.
  if (lf && lf.startTunnel) {
    btn.classList.remove("hidden");
  }

  btn.addEventListener("click", async () => {
    show(modal);
    // Reflect current tunnel state when reopening the modal.
    if (state.tunnel.running && state.tunnel.url) {
      showRunning(state.tunnel.url);
    } else {
      showPrestart();
    }
  });

  function showPrestart() {
    hide(starting); hide(running); hide(errBox); show(pre);
  }
  function showStarting() {
    hide(pre); hide(running); hide(errBox); show(starting);
  }
  function showError(message) {
    hide(pre); hide(starting); hide(running); show(errBox);
    errMsg.textContent = message || "Tunnel gagal — cek log";
  }
  async function showRunning(publicUrl) {
    hide(pre); hide(starting); hide(errBox); show(running);
    urlEl.textContent = publicUrl;
    try {
      const res = await fetch(`/api/qrcode?url=${encodeURIComponent(publicUrl)}`);
      const data = await res.json();
      qrEl.src = data.dataUrl || "";
    } catch (_err) { /* qrEl blank is acceptable */ }
  }

  if (startBtn) startBtn.addEventListener("click", startTunnelFlow);
  if (retryBtn) retryBtn.addEventListener("click", startTunnelFlow);

  if (stopBtn) stopBtn.addEventListener("click", async () => {
    if (!lf || !lf.stopTunnel) return;
    await lf.stopTunnel();
    state.tunnel = { running: false, url: null };
    toast("Tunnel dihentikan", "ok");
    showPrestart();
  });

  if (copyBtn) copyBtn.addEventListener("click", () => {
    try {
      navigator.clipboard.writeText(urlEl.textContent);
      toast("URL disalin", "ok");
    } catch (_err) { /* ignore */ }
  });

  if (downloadLink) downloadLink.addEventListener("click", (e) => {
    e.preventDefault();
    const url = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
    if (lf && lf.openExternal) lf.openExternal(url);
    else window.open(url, "_blank");
  });

  async function startTunnelFlow() {
    if (!lf || !lf.startTunnel) {
      showError("cloudflared integration hanya jalan di Electron PC");
      return;
    }
    showStarting();
    try {
      const res = await lf.startTunnel();
      if (res && res.ok && res.url) {
        state.tunnel = { running: true, url: res.url };
        await showRunning(res.url);
        toast("Tunnel aktif — scan QR di HP", "ok");
      } else {
        showError((res && res.error) || "Tunnel nggak sempat siap (timeout)");
      }
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
    }
  }

  if (lf && lf.onTunnelEvent) {
    lf.onTunnelEvent((evt) => {
      if (!evt) return;
      if (evt.type === "ready" && evt.url) {
        state.tunnel = { running: true, url: evt.url };
        showRunning(evt.url);
      } else if (evt.type === "exit") {
        state.tunnel = { running: false, url: null };
        if (!modal.classList.contains("hidden")) showPrestart();
      }
    });
  }
}

function wireUp() {
  els.registerBtn = $("register-btn");
  els.registerBtn.addEventListener("click", registerDevice);
  $("device-name").addEventListener("keydown", (e) => { if (e.key === "Enter") registerDevice(); });

  $("show-qr").addEventListener("click", showQr);
  $("change-name").addEventListener("click", () => {
    clearMe();
    location.reload();
  });
  $("pick-folder").addEventListener("click", async () => {
    if (!(window.lanFileShare && window.lanFileShare.pickSharedRoot)) return;
    const res = await window.lanFileShare.pickSharedRoot();
    if (!res.canceled) {
      toast("Folder diganti. Restart aplikasi buat terapin.", "ok");
    }
  });

  // Delegated click for the per-device kick ("✕") button in the sidebar.
  $("device-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".kick-btn");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    const dev = state.devices.find((d) => d.id === id);
    kickDevice(id, dev ? dev.name : id);
  });

  // HTTP-only install hint: user dismisses forever via the ×.
  const hintDismiss = $("install-hint-dismiss");
  if (hintDismiss) hintDismiss.addEventListener("click", () => {
    localStorage.setItem("lfs-install-hint-dismissed", "1");
    hide($("install-hint"));
  });

  // Install-to-HP (Cloudflare Tunnel) flow — Electron host only. Buttons
  // drive main.js via preload IPC; fallback message if we're not in Electron.
  wireInstallHp();

  const checkUpdateBtn = $("check-update");
  if (checkUpdateBtn) checkUpdateBtn.addEventListener("click", manualCheckUpdate);
  const downloadBtn = $("update-download");
  if (downloadBtn) downloadBtn.addEventListener("click", startUpdateDownload);
  const installBtn = $("update-install");
  if (installBtn) installBtn.addEventListener("click", installUpdateNow);

  const resizeToggle = $("toggle-resize");
  if (resizeToggle) {
    resizeToggle.checked = state.uploadPrefs.autoResizeImages;
    resizeToggle.addEventListener("change", () => {
      state.uploadPrefs.autoResizeImages = resizeToggle.checked;
      saveUploadPrefs();
      toast(resizeToggle.checked ? "Auto-resize foto: ON" : "Auto-resize foto: OFF", "ok");
    });
  }

  $("btn-upload").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => {
    uploadFiles(e.target.files);
    e.target.value = "";
  });
  $("btn-mkdir").addEventListener("click", promptMkdir);

  $("search").addEventListener("input", (e) => {
    clearTimeout(state.searchTimer);
    const v = e.target.value.trim();
    state.searchTimer = setTimeout(() => doSearch(v), 250);
  });

  $("generate-share").addEventListener("click", generateShareLink);
  $("copy-share").addEventListener("click", () => {
    const input = $("share-url");
    input.select();
    try {
      navigator.clipboard.writeText(input.value);
      toast("Link disalin", "ok");
    } catch (_err) {
      document.execCommand("copy");
    }
  });

  document.addEventListener("click", (e) => {
    const closeBtn = e.target.closest("[data-close]");
    if (closeBtn) {
      const modal = closeBtn.closest(".modal");
      if (modal) hide(modal);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal").forEach(hide);
  });

  const content = document.querySelector(".content");
  if (content) {
    ["dragenter", "dragover"].forEach((ev) => content.addEventListener(ev, (e) => { e.preventDefault(); }));
    content.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
    });
  }
}

async function init() {
  loadUploadPrefs();
  wireUp();
  maybeShowSharedToast();
  const saved = loadMe();
  if (saved) {
    state.me = saved;
    try {
      await api(`/api/devices/${encodeURIComponent(saved.id)}/ping`, { method: "POST" });
    } catch (_err) {
      try {
        const { device } = await api("/api/devices/register", {
          method: "POST",
          body: JSON.stringify({ name: saved.name, kind: saved.kind }),
        });
        state.me = device;
        saveMe(device);
      } catch (_err2) {
        clearMe();
        state.me = null;
      }
    }
  }
  if (state.me) {
    await enterApp();
    updateInstallHint();
  }
}

init().catch((err) => {
  console.error(err);
  toast("Init gagal: " + err.message, "error");
});
