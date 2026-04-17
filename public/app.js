"use strict";

const state = {
  me: null, // { id, name, kind }
  currentPath: "",
  devices: [],
  ws: null,
  pingTimer: null,
  searchTimer: null,
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

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

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
  // Show Electron-only controls
  if (window.lanFileShare && window.lanFileShare.isElectronHost) {
    show($("pick-folder"));
  }
}

async function loadStatus() {
  try {
    const s = await api("/api/status");
    const lan = s.lan && s.lan[0];
    if (lan) {
      setText($("server-ip"), `Server: ${lan.address}:${s.port}`);
    }
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
          // refresh if we're in that folder or a parent
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
      // if server restarted & forgot us, re-register silently
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
  for (const d of state.devices) {
    const li = document.createElement("li");
    if (state.me && d.id === state.me.id) li.classList.add("me");
    li.innerHTML = `
      <span>${escapeHtml(d.name)}</span>
      <span class="kind">${escapeHtml(d.kind)}</span>
    `;
    ul.appendChild(li);
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
  if (entry.isDirectory) return "📁";
  const m = entry.mime || "";
  if (m.startsWith("image/")) return "🖼️";
  if (m.startsWith("video/")) return "🎞️";
  if (m.startsWith("audio/")) return "🎵";
  if (m.startsWith("text/")) return "📄";
  if (m.includes("pdf")) return "📕";
  return "📦";
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

function uploadFiles(files) {
  if (!files || files.length === 0) return;
  const fd = new FormData();
  for (const f of files) fd.append("files", f, f.name);
  const url = `/api/files/upload?path=${encodeURIComponent(state.currentPath)}`;
  fetch(url, { method: "POST", body: fd })
    .then((r) => r.json().then((j) => ({ r, j })))
    .then(({ r, j }) => {
      if (!r.ok) throw new Error((j && j.error) || "upload failed");
      toast(`Upload ${j.uploaded.length} file`, "ok");
      loadFiles(state.currentPath);
    })
    .catch((err) => toast("Upload gagal: " + err.message, "error"));
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

  // Drag & drop upload
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
  wireUp();
  const saved = loadMe();
  if (saved) {
    state.me = saved;
    try {
      await api(`/api/devices/${encodeURIComponent(saved.id)}/ping`, { method: "POST" });
    } catch (_err) {
      // server doesn't know us anymore — re-register
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
  }
}

init().catch((err) => {
  console.error(err);
  toast("Init gagal: " + err.message, "error");
});
