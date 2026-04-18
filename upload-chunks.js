"use strict";

// Chunked upload helper. Splits large files into 4 MB pieces on the client
// (see public/app.js) and reassembles them here. This is critical for
// low-memory phones: the browser never needs to load the full file into
// RAM — each chunk is a Blob slice that streams straight to the network.
//
// Wire format:
//   POST /api/files/upload-chunk?sessionId=<id>&chunkIndex=N&totalChunks=M&fileName=<name>&targetPath=<dir>
//   Body: raw bytes of the chunk (Content-Type: application/octet-stream)
//
// Server state lives in <sharedRoot>/.lfs-uploads/<sessionId>/chunk-<N>.
// Sessions older than 6 hours are garbage collected.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const MAX_CHUNK_BYTES = 16 * 1024 * 1024; // hard cap per chunk (16 MB)
const MAX_TOTAL_CHUNKS = 20_000; // supports ~320 GB at max chunk size
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function sanitizeSegment(name) {
  return String(name || "").replace(/[/\\\0]/g, "_").replace(/\.\./g, "_");
}

function sanitizeSessionId(id) {
  const s = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!s) return null;
  return s.slice(0, 80);
}

function chunksRoot(sharedRoot) {
  return path.join(sharedRoot, ".lfs-uploads");
}

async function ensureChunksRoot(sharedRoot) {
  await fsp.mkdir(chunksRoot(sharedRoot), { recursive: true });
}

async function reapOldSessions(sharedRoot) {
  const root = chunksRoot(sharedRoot);
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      const st = await fsp.stat(dir);
      if (now - st.mtimeMs > SESSION_TTL_MS) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    } catch (_err) {
      /* ignore */
    }
  }
}

/**
 * Create an Express-style middleware that handles POST /api/files/upload-chunk.
 * The caller is expected to have already applied `resolveSafe` on targetPath.
 *
 * @param {{ sharedRoot: string, resolveSafe: (o: { path: string, root: string }) => string, onComplete?: (info: { relPath: string, absPath: string, size: number, dirRel: string, req: import("http").IncomingMessage }) => (void | Promise<void>) }} opts
 */
function createChunkUploadHandler(opts) {
  const { sharedRoot, resolveSafe, onComplete } = opts;
  ensureChunksRoot(sharedRoot).catch(() => { /* best-effort */ });
  setInterval(() => reapOldSessions(sharedRoot).catch(() => {}), 30 * 60 * 1000).unref();

  return async function handleChunkUpload(req, res) {
    try {
      const sessionId = sanitizeSessionId(req.query.sessionId);
      const chunkIndex = parseInt(String(req.query.chunkIndex || ""), 10);
      const totalChunks = parseInt(String(req.query.totalChunks || ""), 10);
      const fileName = sanitizeSegment(req.query.fileName);
      const targetPath = String(req.query.targetPath || "");

      if (!sessionId) return res.status(400).json({ error: "sessionId required" });
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return res.status(400).json({ error: "bad chunkIndex" });
      }
      if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_TOTAL_CHUNKS) {
        return res.status(400).json({ error: "bad totalChunks" });
      }
      if (chunkIndex >= totalChunks) {
        return res.status(400).json({ error: "chunkIndex >= totalChunks" });
      }
      if (!fileName) return res.status(400).json({ error: "fileName required" });

      // Validate target directory up-front (will throw for traversal).
      const targetAbsDir = resolveSafe({ path: targetPath, root: sharedRoot });
      await fsp.mkdir(targetAbsDir, { recursive: true });

      const sessionDir = path.join(chunksRoot(sharedRoot), sessionId);
      await fsp.mkdir(sessionDir, { recursive: true });

      const chunkPath = path.join(sessionDir, `chunk-${chunkIndex.toString().padStart(6, "0")}`);

      // Stream body straight to disk — never buffer the whole chunk in memory.
      await new Promise((resolve, reject) => {
        let bytes = 0;
        const ws = fs.createWriteStream(chunkPath);
        req.on("data", (buf) => {
          bytes += buf.length;
          if (bytes > MAX_CHUNK_BYTES) {
            req.destroy(new Error("chunk too large"));
            ws.destroy();
            reject(new Error("chunk too large"));
          }
        });
        req.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", resolve);
        req.pipe(ws);
      });

      // If this wasn't the last chunk, just ack.
      if (chunkIndex < totalChunks - 1) {
        return res.json({ ok: true, received: chunkIndex, totalChunks });
      }

      // Last chunk — verify we have all of them, then assemble.
      const missing = [];
      for (let i = 0; i < totalChunks; i++) {
        const p = path.join(sessionDir, `chunk-${i.toString().padStart(6, "0")}`);
        try {
          await fsp.access(p);
        } catch (_err) {
          missing.push(i);
        }
      }
      if (missing.length > 0) {
        return res.status(409).json({
          error: "missing chunks",
          missing: missing.slice(0, 50),
        });
      }

      const finalAbs = path.join(targetAbsDir, fileName);
      const tmpAssembled = finalAbs + ".lfs-part";
      const out = fs.createWriteStream(tmpAssembled);
      let totalSize = 0;
      try {
        for (let i = 0; i < totalChunks; i++) {
          const p = path.join(sessionDir, `chunk-${i.toString().padStart(6, "0")}`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve, reject) => {
            const rs = fs.createReadStream(p);
            rs.on("error", reject);
            rs.on("data", (b) => { totalSize += b.length; });
            rs.on("end", resolve);
            rs.pipe(out, { end: false });
          });
        }
        await new Promise((resolve, reject) => {
          out.on("finish", resolve);
          out.on("error", reject);
          out.end();
        });
        await fsp.rename(tmpAssembled, finalAbs);
      } catch (err) {
        try { await fsp.rm(tmpAssembled, { force: true }); } catch (_e) { /* ignore */ }
        throw err;
      }

      // Cleanup session folder (best-effort).
      try { await fsp.rm(sessionDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

      const dirRel = String(targetPath || "").replace(/^\/+/, "");
      const relPath = (dirRel ? dirRel + "/" : "") + fileName;
      if (onComplete) {
        // Pass `req` so the caller can read uploader headers (the small
        // upload endpoint has the headers inline, the chunk endpoint
        // needs them forwarded). We await in case the caller persists
        // metadata asynchronously — otherwise the response could race
        // the client's subsequent list refresh.
        try { await onComplete({ relPath, absPath: finalAbs, size: totalSize, dirRel, req }); } catch (_err) { /* ignore */ }
      }
      return res.json({ ok: true, assembled: true, name: fileName, size: totalSize, path: relPath });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[upload-chunk] error:", err);
      // Respect err.status when set (e.g. resolveSafe tags path-traversal
      // with status=400). Only fall back to 500 for truly unexpected
      // errors, matching the global Express error handler in server.js.
      const status = err && Number.isInteger(err.status) ? err.status : 500;
      return res.status(status).json({ error: err && err.message ? err.message : String(err) });
    }
  };
}

module.exports = { createChunkUploadHandler };
