"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const crypto = require("crypto");
const mime = require("mime-types");
const multer = require("multer");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const { nanoid } = require("nanoid");
const { createWebdavHandler } = require("./webdav");
const { createChunkUploadHandler } = require("./upload-chunks");

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === "IPv4" && !info.internal) {
        addrs.push({ iface: name, address: info.address });
      }
    }
  }
  return addrs;
}

/**
 * @param {{ path: string, root: string }} args
 * @returns {string} absolute path
 */
function resolveSafe({ path: relPath, root }) {
  const raw = (relPath || "").replace(/\\/g, "/");
  // Reject any explicit traversal segment. This is a belt-and-suspenders
  // check: we also clamp via path.resolve below, but rejecting here gives
  // callers a clearer error rather than silently mapping outside input
  // back into the root.
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((p) => p === "..")) {
    const err = new Error("Path traversal detected");
    err.status = 400;
    throw err;
  }
  const normalizedRel = path.posix.normalize("/" + raw).replace(/^\/+/, "");
  const absolute = path.resolve(root, normalizedRel);
  const rootResolved = path.resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    const err = new Error("Path traversal detected");
    err.status = 400;
    throw err;
  }
  return absolute;
}

function slugifyDeviceName(name) {
  return String(name || "device")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "device";
}

/**
 * @param {{ port?: number, sharedRoot: string, hostDeviceName?: string }} options
 */
async function startServer(options) {
  const sharedRoot = path.resolve(options.sharedRoot);
  await fsp.mkdir(sharedRoot, { recursive: true });

  const hostDeviceName = options.hostDeviceName || `PC-${os.hostname()}`;
  const port = options.port || 5000;

  // WebSocket server reference. Declared up front so closures below can
  // safely reference it (broadcast() is a no-op until this is assigned).
  let wss = null;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Devices registry (in-memory). Each entry: { id, name, slug, kind, lastSeen, ip }
  const devices = new Map();

  // Share tokens: { token -> { absPath, expiresAt, downloads, maxDownloads?, createdBy } }
  const shareTokens = new Map();

  function registerDevice({ name, kind, ip }) {
    const slug = slugifyDeviceName(name);
    const id = slug + "-" + nanoid(6);
    const device = {
      id,
      name: String(name).slice(0, 80),
      slug,
      kind: kind === "pc" ? "pc" : "mobile",
      ip: ip || "",
      lastSeen: Date.now(),
    };
    devices.set(id, device);

    // Create that device's personal folder (inside sharedRoot) so uploads have a home.
    const personalDir = path.join(sharedRoot, device.name + "-" + id.slice(-6));
    fs.mkdirSync(personalDir, { recursive: true });
    device.folder = path.basename(personalDir);

    broadcastDevices();
    return device;
  }

  // Seed host device (the PC running Electron)
  const hostDevice = registerDevice({ name: hostDeviceName, kind: "pc", ip: "127.0.0.1" });

  function touchDevice(id) {
    const d = devices.get(id);
    if (d) {
      d.lastSeen = Date.now();
    }
  }

  function reapDevices() {
    const now = Date.now();
    let changed = false;
    for (const [id, d] of devices) {
      if (id === hostDevice.id) continue;
      if (now - d.lastSeen > 45_000) {
        devices.delete(id);
        changed = true;
      }
    }
    if (changed) broadcastDevices();
  }
  setInterval(reapDevices, 15_000).unref();

  function reapShareTokens() {
    const now = Date.now();
    for (const [token, meta] of shareTokens) {
      if (meta.expiresAt && meta.expiresAt < now) shareTokens.delete(token);
    }
  }
  setInterval(reapShareTokens, 60_000).unref();

  // --- Helpers ---
  async function statEntry(absPath, relPath) {
    const st = await fsp.stat(absPath);
    return {
      name: path.basename(absPath),
      path: relPath,
      size: st.size,
      mtime: st.mtimeMs,
      isDirectory: st.isDirectory(),
      mime: st.isDirectory() ? "inode/directory" : mime.lookup(absPath) || "application/octet-stream",
    };
  }

  async function listDir(absDir, relDir) {
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // hide dotfiles for safety/UX
      try {
        const childAbs = path.join(absDir, e.name);
        const childRel = path.posix.join(relDir || "", e.name);
        out.push(await statEntry(childAbs, childRel));
      } catch (_err) {
        /* ignore unreadable entries */
      }
    }
    out.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  // --- Middleware ---

  // WebDAV endpoint so native file explorers (Windows, macOS Finder, iOS
  // Files, Android file managers) can mount the shared folder as a drive.
  // Mount *before* the JSON body parser doesn't help — PUT uploads must
  // remain raw streams, so we only json-parse /api/* routes below.
  app.use("/webdav", createWebdavHandler({
    root: sharedRoot,
    onChange: (dirRel) => broadcastEvent({ type: "files-changed", path: dirRel || "" }),
  }));

  // Static PWA frontend
  app.use(express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith("service-worker.js")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }));

  // --- API routes ---

  app.get("/api/status", (_req, res) => {
    res.json({
      ok: true,
      host: hostDevice,
      sharedRoot,
      lan: getLanAddresses(),
      port,
    });
  });

  app.get("/api/qrcode", async (req, res) => {
    const lan = getLanAddresses()[0];
    const ip = (req.query.ip && String(req.query.ip)) || (lan && lan.address) || "127.0.0.1";
    const url = `http://${ip}:${port}/`;
    try {
      const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
      res.json({ url, dataUrl });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/devices/register", (req, res) => {
    const name = (req.body && req.body.name) || "";
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "name required" });
    }
    const kind = req.body && req.body.kind;
    const ip = (req.ip || req.headers["x-forwarded-for"] || "").toString();
    const device = registerDevice({ name: name.trim(), kind, ip });
    res.json({ device });
  });

  app.post("/api/devices/:id/ping", (req, res) => {
    const id = req.params.id;
    if (!devices.has(id)) return res.status(404).json({ error: "unknown device" });
    touchDevice(id);
    res.json({ ok: true });
  });

  app.delete("/api/devices/:id", (req, res) => {
    const id = req.params.id;
    if (id === hostDevice.id) return res.status(400).json({ error: "cannot remove host" });
    if (devices.delete(id)) broadcastDevices();
    res.json({ ok: true });
  });

  app.get("/api/devices", (_req, res) => {
    res.json({ devices: Array.from(devices.values()) });
  });

  app.get("/api/files", async (req, res, next) => {
    try {
      const rel = String(req.query.path || "");
      const abs = resolveSafe({ path: rel, root: sharedRoot });
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) {
        return res.status(400).json({ error: "path is not a directory" });
      }
      const entries = await listDir(abs, rel);
      res.json({ path: rel.replace(/^\/+/, ""), entries });
    } catch (err) {
      if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
      next(err);
    }
  });

  app.get("/api/files/search", async (req, res, next) => {
    try {
      const query = String(req.query.query || "").toLowerCase();
      const rel = String(req.query.path || "");
      if (!query) return res.json({ results: [] });
      const abs = resolveSafe({ path: rel, root: sharedRoot });
      const results = [];
      const maxResults = 200;

      const walk = async (dir, relDir) => {
        if (results.length >= maxResults) return;
        let list;
        try {
          list = await fsp.readdir(dir, { withFileTypes: true });
        } catch (_err) {
          return;
        }
        for (const e of list) {
          if (results.length >= maxResults) return;
          if (e.name.startsWith(".")) continue;
          const nameLower = e.name.toLowerCase();
          const childAbs = path.join(dir, e.name);
          const childRel = path.posix.join(relDir, e.name);
          if (nameLower.includes(query)) {
            try {
              results.push(await statEntry(childAbs, childRel));
            } catch (_err) {
              /* ignore */
            }
          }
          if (e.isDirectory()) await walk(childAbs, childRel);
        }
      };

      await walk(abs, rel.replace(/^\/+/, ""));
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/files/download", async (req, res, next) => {
    try {
      const rel = String(req.query.path || "");
      if (!rel) return res.status(400).json({ error: "path required" });
      const abs = resolveSafe({ path: rel, root: sharedRoot });
      const st = await fsp.stat(abs);
      if (st.isDirectory()) return res.status(400).json({ error: "cannot download a directory" });
      res.download(abs, path.basename(abs));
    } catch (err) {
      if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
      next(err);
    }
  });

  app.get("/api/files/preview", async (req, res, next) => {
    try {
      const rel = String(req.query.path || "");
      if (!rel) return res.status(400).json({ error: "path required" });
      const abs = resolveSafe({ path: rel, root: sharedRoot });
      const st = await fsp.stat(abs);
      if (st.isDirectory()) return res.status(400).json({ error: "cannot preview a directory" });
      res.setHeader("Content-Type", mime.lookup(abs) || "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=60");
      fs.createReadStream(abs).pipe(res);
    } catch (err) {
      if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
      next(err);
    }
  });

  // Upload (streaming to disk inside sharedRoot)
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        try {
          const targetRel = String(req.query.path || "");
          const abs = resolveSafe({ path: targetRel, root: sharedRoot });
          fs.mkdirSync(abs, { recursive: true });
          cb(null, abs);
        } catch (err) {
          cb(err, "");
        }
      },
      filename: (_req, file, cb) => {
        // sanitize uploaded filename
        const safe = file.originalname.replace(/[/\\\0]/g, "_");
        cb(null, safe);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB
  });

  app.post("/api/files/upload", upload.array("files", 50), (req, res) => {
    const uploaded = (req.files || []).map((f) => ({
      name: f.originalname,
      size: f.size,
    }));
    broadcastEvent({ type: "files-changed", path: String(req.query.path || "") });
    res.json({ uploaded });
  });

  // Chunked upload endpoint (for low-memory phones and huge files). Each
  // chunk is streamed straight to disk so the browser never holds the full
  // file in RAM and partial uploads can be retried individually.
  //
  // IMPORTANT: no body parser before this — the handler pipes the raw
  // request into a WriteStream. The global `express.json()` parser above
  // only activates for Content-Type: application/json, so binary uploads
  // pass through untouched.
  app.post(
    "/api/files/upload-chunk",
    createChunkUploadHandler({
      sharedRoot,
      resolveSafe,
      onComplete: ({ dirRel }) => {
        broadcastEvent({ type: "files-changed", path: dirRel || "" });
      },
    }),
  );

  app.post("/api/files/mkdir", async (req, res, next) => {
    try {
      const rel = String((req.body && req.body.path) || "");
      const name = String((req.body && req.body.name) || "").replace(/[/\\\0]/g, "_").trim();
      if (!name) return res.status(400).json({ error: "name required" });
      const parent = resolveSafe({ path: rel, root: sharedRoot });
      const target = path.join(parent, name);
      if (!target.startsWith(path.resolve(sharedRoot))) {
        return res.status(400).json({ error: "invalid path" });
      }
      await fsp.mkdir(target, { recursive: false });
      broadcastEvent({ type: "files-changed", path: rel });
      res.json({ ok: true });
    } catch (err) {
      if (err.code === "EEXIST") return res.status(409).json({ error: "already exists" });
      next(err);
    }
  });

  app.post("/api/files/rename", async (req, res, next) => {
    try {
      const rel = String((req.body && req.body.path) || "");
      const newName = String((req.body && req.body.newName) || "").replace(/[/\\\0]/g, "_").trim();
      if (!rel || !newName) return res.status(400).json({ error: "path and newName required" });
      const src = resolveSafe({ path: rel, root: sharedRoot });
      const dst = path.join(path.dirname(src), newName);
      if (!dst.startsWith(path.resolve(sharedRoot))) {
        return res.status(400).json({ error: "invalid path" });
      }
      await fsp.rename(src, dst);
      broadcastEvent({ type: "files-changed", path: path.posix.dirname(rel) });
      res.json({ ok: true });
    } catch (err) {
      if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
      next(err);
    }
  });

  app.delete("/api/files", async (req, res, next) => {
    try {
      const rel = String(req.query.path || "");
      if (!rel) return res.status(400).json({ error: "path required" });
      const abs = resolveSafe({ path: rel, root: sharedRoot });
      if (abs === path.resolve(sharedRoot)) {
        return res.status(400).json({ error: "cannot delete root" });
      }
      await fsp.rm(abs, { recursive: true, force: true });
      broadcastEvent({ type: "files-changed", path: path.posix.dirname(rel) });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Share links
  app.post("/api/share", async (req, res, next) => {
    try {
      const rel = String((req.body && req.body.path) || "");
      const expiresInMinutes = Number((req.body && req.body.expiresInMinutes) || 60);
      const maxDownloads = req.body && req.body.maxDownloads ? Number(req.body.maxDownloads) : null;
      if (!rel) return res.status(400).json({ error: "path required" });
      const abs = resolveSafe({ path: rel, root: sharedRoot });
      await fsp.stat(abs); // ensure exists
      const token = crypto.randomBytes(16).toString("hex");
      shareTokens.set(token, {
        absPath: abs,
        relPath: rel,
        expiresAt: Date.now() + expiresInMinutes * 60 * 1000,
        maxDownloads,
        downloads: 0,
      });
      const lan = getLanAddresses()[0];
      const ip = lan ? lan.address : "127.0.0.1";
      res.json({
        token,
        url: `http://${ip}:${port}/share/${token}`,
        expiresAt: shareTokens.get(token).expiresAt,
      });
    } catch (err) {
      if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
      next(err);
    }
  });

  app.get("/share/:token", async (req, res) => {
    const meta = shareTokens.get(req.params.token);
    if (!meta) return res.status(404).send("Share link not found or expired");
    if (meta.expiresAt && meta.expiresAt < Date.now()) {
      shareTokens.delete(req.params.token);
      return res.status(410).send("Share link expired");
    }
    if (meta.maxDownloads && meta.downloads >= meta.maxDownloads) {
      return res.status(410).send("Download limit reached");
    }
    try {
      const st = await fsp.stat(meta.absPath);
      if (st.isDirectory()) {
        return res.status(400).send("Cannot share a directory (zip first)");
      }
      meta.downloads += 1;
      res.download(meta.absPath, path.basename(meta.absPath));
    } catch (_err) {
      res.status(404).send("File not found");
    }
  });

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || String(err) });
  });

  // --- HTTP + WebSocket ---
  const server = http.createServer(app);
  wss = new WebSocketServer({ server, path: "/ws" });

  function broadcast(payload) {
    if (!wss) return; // server not ready yet
    const msg = JSON.stringify(payload);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try {
          client.send(msg);
        } catch (_err) {
          /* ignore */
        }
      }
    });
  }
  function broadcastDevices() {
    broadcast({ type: "devices", devices: Array.from(devices.values()) });
  }
  function broadcastEvent(evt) {
    broadcast(evt);
  }

  wss.on("connection", (ws) => {
    // Send initial device list
    try {
      ws.send(JSON.stringify({ type: "devices", devices: Array.from(devices.values()) }));
    } catch (_err) {
      /* ignore */
    }
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping" && msg.deviceId) {
          touchDevice(msg.deviceId);
        }
      } catch (_err) {
        /* ignore malformed */
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });

  return {
    port,
    sharedRoot,
    host: hostDevice,
    publicInfo() {
      return {
        port,
        sharedRoot,
        host: hostDevice,
        lan: getLanAddresses(),
      };
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { startServer };

if (require.main === module) {
  const sharedRoot = process.env.LAN_FILE_SHARE_ROOT || path.join(os.homedir(), "LanFileShare");
  const port = Number(process.env.LAN_FILE_SHARE_PORT) || 5000;
  startServer({ port, sharedRoot, hostDeviceName: `PC-${os.hostname()}` })
    .then((info) => {
      const lan = getLanAddresses()[0];
      const ip = lan ? lan.address : "127.0.0.1";
      // eslint-disable-next-line no-console
      console.log(`[lan-file-share] listening on http://${ip}:${info.port}  root=${info.sharedRoot}`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Failed to start server:", err);
      process.exit(1);
    });
}
