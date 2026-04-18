"use strict";

/**
 * End-to-end smoke test for the server. Spins up the Express server on a
 * random port, exercises each REST endpoint, then shuts down cleanly.
 * Intended to be run in CI across Linux / macOS / Windows.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const { startServer } = require("../server");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-test-"));
const PORT = 5000 + Math.floor(Math.random() * 1000);

let passed = 0;
let failed = 0;
function check(name, ok, details) {
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`[${label}] ${name}${details ? " — " + details : ""}`);
  if (ok) passed++;
  else failed++;
}

function rawRequest(method, urlPath, body, contentType, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : Buffer.alloc(0);
    const opts = {
      hostname: "127.0.0.1",
      port: PORT,
      method,
      path: urlPath,
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": payload.length,
        ...(extraHeaders || {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, raw: data, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

function request(method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port: PORT,
      method,
      path: urlPath,
      headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (_err) {
          parsed = { raw: data };
        }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", reject);
    if (body) {
      if (typeof body === "string" || Buffer.isBuffer(body)) req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function multipartUpload(urlPath, filename, content) {
  return new Promise((resolve, reject) => {
    const boundary = "----lfsboundary" + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      "utf8"
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const payload = Buffer.concat([head, Buffer.from(content), tail]);
    const opts = {
      hostname: "127.0.0.1",
      port: PORT,
      method: "POST",
      path: urlPath,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length,
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (_err) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Starting test server on ${PORT} with root ${tmpRoot}`);
  const server = await startServer({ port: PORT, sharedRoot: tmpRoot, hostDeviceName: "PC-ci" });

  try {
    const status = await request("GET", "/api/status");
    check("GET /api/status 200", status.status === 200 && status.body.ok === true);

    const reg = await request("POST", "/api/devices/register", { name: "HP-CI", kind: "mobile" });
    check("POST /api/devices/register", reg.status === 200 && reg.body.device && reg.body.device.id);

    const devId = reg.body && reg.body.device && reg.body.device.id;

    const ping = await request("POST", `/api/devices/${encodeURIComponent(devId)}/ping`);
    check("POST /api/devices/:id/ping", ping.status === 200);

    const devices = await request("GET", "/api/devices");
    check("GET /api/devices lists CI devices",
      devices.status === 200 && devices.body.devices.some((d) => d.name === "HP-CI"));

    const mkdir = await request("POST", "/api/files/mkdir", { path: "", name: "uploads" });
    check("POST /api/files/mkdir", mkdir.status === 200);

    const upload = await multipartUpload("/api/files/upload?path=uploads", "hello.txt", "hello world\n");
    check("POST /api/files/upload", upload.status === 200 && upload.body.uploaded && upload.body.uploaded.length === 1);

    const list = await request("GET", "/api/files?path=uploads");
    check("GET /api/files lists uploaded file",
      list.status === 200 && list.body.entries.some((e) => e.name === "hello.txt"));

    const search = await request("GET", "/api/files/search?query=hello");
    check("GET /api/files/search finds file",
      search.status === 200 && search.body.results.some((e) => e.name === "hello.txt"));

    const rename = await request("POST", "/api/files/rename", { path: "uploads/hello.txt", newName: "hi.txt" });
    check("POST /api/files/rename", rename.status === 200);

    const share = await request("POST", "/api/share", { path: "uploads/hi.txt", expiresInMinutes: 1 });
    check("POST /api/share returns token", share.status === 200 && typeof share.body.token === "string");

    const shareDl = await request("GET", `/share/${share.body.token}`);
    check("GET /share/:token downloads file", shareDl.status === 200 && shareDl.raw.includes("hello world"));

    const preview = await request("GET", "/api/files/preview?path=uploads/hi.txt");
    check("GET /api/files/preview returns file", preview.status === 200 && preview.raw.includes("hello world"));

    const download = await request("GET", "/api/files/download?path=uploads/hi.txt");
    check("GET /api/files/download returns file", download.status === 200 && download.raw.includes("hello world"));

    const del = await request("DELETE", "/api/files?path=uploads/hi.txt");
    check("DELETE /api/files", del.status === 200);

    const listAfter = await request("GET", "/api/files?path=uploads");
    check("file is actually deleted",
      listAfter.status === 200 && !listAfter.body.entries.some((e) => e.name === "hi.txt"));

    const traversal = await request("GET", "/api/files?path=..%2F..%2Fetc");
    check("path traversal is blocked", traversal.status === 400);

    // WebDAV smoke tests
    const davOptions = await request("OPTIONS", "/webdav/");
    check("WebDAV OPTIONS advertises DAV", davOptions.status === 200);

    const davPut = await rawRequest("PUT", "/webdav/uploads/dav.txt", "webdav content\n", "text/plain");
    check("WebDAV PUT creates file", davPut.status === 201 || davPut.status === 204);

    const davGet = await request("GET", "/webdav/uploads/dav.txt");
    check("WebDAV GET returns file", davGet.status === 200 && davGet.raw.includes("webdav content"));

    const davPropfind = await rawRequest("PROPFIND", "/webdav/uploads/", "", "application/xml", { Depth: "1" });
    check("WebDAV PROPFIND lists folder",
      davPropfind.status === 207 && davPropfind.raw.includes("dav.txt"));

    const davMkcol = await rawRequest("MKCOL", "/webdav/uploads/dav-folder/", "", "application/xml");
    check("WebDAV MKCOL creates folder", davMkcol.status === 201);

    const davMove = await rawRequest("MOVE", "/webdav/uploads/dav.txt", "", "application/xml", {
      Destination: `http://127.0.0.1:${PORT}/webdav/uploads/dav-moved.txt`,
      Overwrite: "T",
    });
    check("WebDAV MOVE renames file", davMove.status === 201 || davMove.status === 204);

    const davDelete = await rawRequest("DELETE", "/webdav/uploads/dav-moved.txt", "", "application/xml");
    check("WebDAV DELETE removes file", davDelete.status === 204);

    // Chunked upload endpoint (low-memory phone fix).
    const sid = "chunksmoke" + Date.now().toString(36);
    const chunk0 = Buffer.from("HELLO-CHUNK-0|");
    const chunk1 = Buffer.from("HELLO-CHUNK-1|");
    const chunk2 = Buffer.from("END");
    const expected = Buffer.concat([chunk0, chunk1, chunk2]).toString("utf8");

    const mkChunkUrl = (idx) =>
      `/api/files/upload-chunk?sessionId=${sid}&chunkIndex=${idx}&totalChunks=3` +
      `&fileName=chunked.bin&targetPath=uploads`;

    const c0 = await rawRequest("POST", mkChunkUrl(0), chunk0, "application/octet-stream");
    check("POST /api/files/upload-chunk 0/3 accepted", c0.status === 200);
    const c1 = await rawRequest("POST", mkChunkUrl(1), chunk1, "application/octet-stream");
    check("POST /api/files/upload-chunk 1/3 accepted", c1.status === 200);
    const c2 = await rawRequest("POST", mkChunkUrl(2), chunk2, "application/octet-stream");
    check(
      "POST /api/files/upload-chunk 2/3 assembles file",
      c2.status === 200 && /"assembled":true/.test(c2.raw || "")
    );

    const chunkGet = await request("GET", "/api/files/download?path=uploads/chunked.bin");
    check(
      "chunked file reassembles identically",
      chunkGet.status === 200 && chunkGet.raw === expected
    );

    // Path traversal through chunked endpoint must be blocked.
    const badChunk = await rawRequest(
      "POST",
      `/api/files/upload-chunk?sessionId=bad&chunkIndex=0&totalChunks=1&fileName=x.txt&targetPath=..%2F..%2Fetc`,
      "x",
      "application/octet-stream"
    );
    check("chunked upload rejects path traversal", badChunk.status >= 400);
  } finally {
    await server.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_err) { /* ignore */ }
  }

  // eslint-disable-next-line no-console
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
