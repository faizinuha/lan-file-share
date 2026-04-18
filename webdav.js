"use strict";

/**
 * Minimal WebDAV (RFC 4918) handler mounted at /webdav.
 *
 * Implements the subset needed for native file explorers on Windows,
 * macOS (Finder), iOS (Files app), Android (Files by Google, Solid
 * Explorer, etc.) to mount the shared folder as a network drive:
 *
 *   OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY,
 *   PROPPATCH (stub), LOCK / UNLOCK (stub).
 *
 * Authentication is intentionally omitted — WebDAV surface is guarded
 * by the same "LAN-only" trust boundary as the REST API. Remote access
 * should be layered behind Tailscale / Cloudflare Access / a reverse
 * proxy with basic auth.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const mime = require("mime-types");

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[c]));
}

function toHttpDate(ms) {
  return new Date(ms).toUTCString();
}

function hrefEncode(rel, isDir) {
  const segs = String(rel || "").split("/").filter(Boolean).map(encodeURIComponent);
  let href = "/webdav/" + segs.join("/");
  if (isDir && !href.endsWith("/")) href += "/";
  if (!isDir) href = href.replace(/\/$/, "");
  if (href === "/webdav") href = "/webdav/";
  return href;
}

async function statOrNull(p) {
  try { return await fsp.stat(p); } catch (_err) { return null; }
}

function safeResolve(root, reqPath) {
  const clean = String(reqPath || "").replace(/^\/+|\/+$/g, "");
  if (clean.split("/").some((p) => p === "..")) return null;
  const abs = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return { abs, rel: clean };
}

function buildPropfind(entries) {
  const parts = ['<?xml version="1.0" encoding="utf-8"?>', '<D:multistatus xmlns:D="DAV:">'];
  for (const e of entries) {
    const href = hrefEncode(e.rel, e.isDir);
    parts.push("<D:response>");
    parts.push(`<D:href>${escapeXml(href)}</D:href>`);
    parts.push("<D:propstat>");
    parts.push("<D:prop>");
    const displayname = e.rel === "" ? "root" : path.posix.basename(e.rel);
    parts.push(`<D:displayname>${escapeXml(displayname)}</D:displayname>`);
    parts.push(`<D:getlastmodified>${toHttpDate(e.mtime)}</D:getlastmodified>`);
    if (e.isDir) {
      parts.push("<D:resourcetype><D:collection/></D:resourcetype>");
    } else {
      parts.push("<D:resourcetype/>");
      parts.push(`<D:getcontentlength>${e.size}</D:getcontentlength>`);
      parts.push(`<D:getcontenttype>${escapeXml(e.mimeType)}</D:getcontenttype>`);
    }
    parts.push("<D:supportedlock>");
    parts.push("<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>");
    parts.push("</D:supportedlock>");
    parts.push("</D:prop>");
    parts.push("<D:status>HTTP/1.1 200 OK</D:status>");
    parts.push("</D:propstat>");
    parts.push("</D:response>");
  }
  parts.push("</D:multistatus>");
  return parts.join("");
}

function entryFromStat(rel, abs, st) {
  return {
    rel,
    isDir: st.isDirectory(),
    size: st.size,
    mtime: st.mtimeMs,
    mimeType: st.isDirectory() ? "httpd/unix-directory" : mime.lookup(abs) || "application/octet-stream",
  };
}

function createWebdavHandler({ root, onChange }) {
  return async function webdavHandler(req, res) {
    // Discard any request body that the parent Express pipeline may have
    // buffered for methods that don't use it.
    try {
      const method = req.method.toUpperCase();
      const reqPath = decodeURIComponent(String(req.path || "/"));

      if (method === "OPTIONS") {
        res.setHeader("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK");
        res.setHeader("DAV", "1, 2");
        res.setHeader("MS-Author-Via", "DAV");
        return res.status(200).end();
      }

      const resolved = safeResolve(root, reqPath);
      if (!resolved) {
        return res.status(403).end();
      }
      const { abs, rel } = resolved;

      if (method === "PROPFIND") {
        const st = await statOrNull(abs);
        if (!st) return res.status(404).end();
        const depthHeader = req.headers.depth;
        const depth = depthHeader === undefined ? "infinity" : String(depthHeader);
        const entries = [entryFromStat(rel, abs, st)];
        if (st.isDirectory() && depth !== "0") {
          let children = [];
          try { children = await fsp.readdir(abs, { withFileTypes: true }); } catch (_err) { children = []; }
          for (const c of children) {
            if (c.name.startsWith(".")) continue;
            const childAbs = path.join(abs, c.name);
            const cst = await statOrNull(childAbs);
            if (!cst) continue;
            const childRel = rel ? path.posix.join(rel, c.name) : c.name;
            entries.push(entryFromStat(childRel, childAbs, cst));
          }
        }
        const xml = buildPropfind(entries);
        res.status(207);
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        return res.end(xml);
      }

      if (method === "GET" || method === "HEAD") {
        const st = await statOrNull(abs);
        if (!st) return res.status(404).end();
        if (st.isDirectory()) {
          // Some clients (Windows Explorer) issue GET on a folder. Return
          // a simple HTML index so browsers can also crawl.
          let children = [];
          try { children = await fsp.readdir(abs); } catch (_err) { children = []; }
          const links = children
            .filter((n) => !n.startsWith("."))
            .map((n) => `<li><a href="${escapeXml(encodeURIComponent(n))}">${escapeXml(n)}</a></li>`)
            .join("");
          const html = `<!doctype html><html><body><h1>WebDAV: /${escapeXml(rel || "")}</h1><ul>${links}</ul></body></html>`;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          if (method === "HEAD") return res.end();
          return res.end(html);
        }
        res.setHeader("Content-Type", mime.lookup(abs) || "application/octet-stream");
        res.setHeader("Content-Length", st.size);
        res.setHeader("Last-Modified", toHttpDate(st.mtimeMs));
        res.setHeader("Accept-Ranges", "bytes");
        if (method === "HEAD") return res.end();
        return fs.createReadStream(abs).pipe(res);
      }

      if (method === "PUT") {
        if (rel === "") return res.status(403).end();
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        const existed = !!(await statOrNull(abs));
        const out = fs.createWriteStream(abs);
        req.pipe(out);
        return new Promise((resolve) => {
          out.on("finish", () => {
            if (onChange) onChange(path.posix.dirname(rel));
            res.status(existed ? 204 : 201).end();
            resolve();
          });
          out.on("error", (err) => {
            res.status(500).end(String(err.message || err));
            resolve();
          });
        });
      }

      if (method === "MKCOL") {
        try {
          await fsp.mkdir(abs, { recursive: false });
          if (onChange) onChange(path.posix.dirname(rel));
          return res.status(201).end();
        } catch (err) {
          if (err.code === "EEXIST") return res.status(405).end();
          return res.status(409).end();
        }
      }

      if (method === "DELETE") {
        if (rel === "") return res.status(403).end();
        try {
          await fsp.rm(abs, { recursive: true, force: true });
          if (onChange) onChange(path.posix.dirname(rel));
          return res.status(204).end();
        } catch (_err) {
          return res.status(500).end();
        }
      }

      if (method === "MOVE" || method === "COPY") {
        const destHeader = req.headers.destination;
        if (!destHeader) return res.status(400).end();
        let destPath;
        try {
          const parsed = new URL(String(destHeader), `http://${req.headers.host || "localhost"}`);
          destPath = decodeURIComponent(parsed.pathname);
        } catch (_err) {
          destPath = String(destHeader);
        }
        destPath = destPath.replace(/^\/webdav\/?/, "");
        const destResolved = safeResolve(root, destPath);
        if (!destResolved) return res.status(403).end();

        const overwrite = String(req.headers.overwrite || "T").toUpperCase() !== "F";
        const destExists = !!(await statOrNull(destResolved.abs));
        if (destExists && !overwrite) return res.status(412).end();

        if (method === "MOVE") {
          await fsp.mkdir(path.dirname(destResolved.abs), { recursive: true });
          await fsp.rename(abs, destResolved.abs);
        } else {
          await fsp.mkdir(path.dirname(destResolved.abs), { recursive: true });
          await fsp.cp(abs, destResolved.abs, { recursive: true });
        }
        if (onChange) {
          onChange(path.posix.dirname(rel));
          onChange(path.posix.dirname(destResolved.rel));
        }
        return res.status(destExists ? 204 : 201).end();
      }

      if (method === "LOCK") {
        // We don't actually implement locking; return a synthetic exclusive
        // write lock so clients like Finder / Windows Explorer proceed.
        const token = "opaquelocktoken:" + crypto.randomBytes(8).toString("hex");
        const xml =
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
          "<D:locktype><D:write/></D:locktype>" +
          "<D:lockscope><D:exclusive/></D:lockscope>" +
          "<D:depth>infinity</D:depth>" +
          "<D:timeout>Second-600</D:timeout>" +
          `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
          "</D:activelock></D:lockdiscovery></D:prop>";
        res.setHeader("Lock-Token", `<${token}>`);
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        return res.status(200).end(xml);
      }

      if (method === "UNLOCK") {
        return res.status(204).end();
      }

      if (method === "PROPPATCH") {
        // Accept but ignore. Return a synthetic 200 for all requested props.
        const xml =
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<D:multistatus xmlns:D="DAV:"><D:response>' +
          `<D:href>${escapeXml(hrefEncode(rel, true))}</D:href>` +
          "<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
          "</D:response></D:multistatus>";
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        return res.status(207).end(xml);
      }

      return res.status(405).end();
    } catch (err) {
      if (!res.headersSent) res.status(500).end(String((err && err.message) || err));
    }
  };
}

module.exports = { createWebdavHandler };
