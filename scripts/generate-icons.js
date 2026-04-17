"use strict";

/**
 * Generates icon-192.png and icon-512.png from icon.svg using pure-Node
 * PNG encoding. No external image libraries needed so there is nothing to
 * fail during `npm install`.
 *
 * We rasterize a solid square with a blue radial-style gradient background
 * plus a simple "LS" monogram — that's enough for the PWA install prompt
 * and the taskbar icon. For a richer icon, drop a real PNG at
 * public/icons/icon-192.png and public/icons/icon-512.png and this script
 * will leave it alone.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const outDir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);
  // Gradient colors (slate-900 -> blue-800)
  const c1 = [15, 23, 42, 255];
  const c2 = [30, 58, 138, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR;
      const t = Math.min(1, r);
      const i = (y * size + x) * 4;
      rgba[i] = lerp(c1[0], c2[0], t);
      rgba[i + 1] = lerp(c1[1], c2[1], t);
      rgba[i + 2] = lerp(c1[2], c2[2], t);
      rgba[i + 3] = 255;
    }
  }

  // Two overlapping rounded squares to mimic "share" icon
  const block = (x0, y0, w, h, color) => {
    const radius = Math.floor(Math.min(w, h) * 0.12);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        // rounded corner check
        const lx = x - x0;
        const ly = y - y0;
        let inside = true;
        if (lx < radius && ly < radius) inside = (lx - radius) ** 2 + (ly - radius) ** 2 <= radius ** 2;
        else if (lx >= w - radius && ly < radius) inside = (lx - (w - radius)) ** 2 + (ly - radius) ** 2 <= radius ** 2;
        else if (lx < radius && ly >= h - radius) inside = (lx - radius) ** 2 + (ly - (h - radius)) ** 2 <= radius ** 2;
        else if (lx >= w - radius && ly >= h - radius) inside = (lx - (w - radius)) ** 2 + (ly - (h - radius)) ** 2 <= radius ** 2;
        if (!inside) continue;
        const i = (y * size + x) * 4;
        rgba[i] = color[0];
        rgba[i + 1] = color[1];
        rgba[i + 2] = color[2];
        rgba[i + 3] = color[3];
      }
    }
  };

  const s = size;
  block(Math.round(s * 0.18), Math.round(s * 0.22), Math.round(s * 0.42), Math.round(s * 0.32), [30, 64, 175, 255]);
  block(Math.round(s * 0.42), Math.round(s * 0.46), Math.round(s * 0.42), Math.round(s * 0.32), [37, 99, 235, 255]);

  return encodePng(size, size, rgba);
}

function writeIfMissing(name, buf) {
  const p = path.join(outDir, name);
  if (fs.existsSync(p)) return false;
  fs.writeFileSync(p, buf);
  return true;
}

let wrote = 0;
for (const size of [192, 512]) {
  const buf = drawIcon(size);
  if (writeIfMissing(`icon-${size}.png`, buf)) {
    wrote++;
    // eslint-disable-next-line no-console
    console.log(`Generated public/icons/icon-${size}.png`);
  }
}
if (wrote === 0) {
  // eslint-disable-next-line no-console
  console.log("Icons already exist; skipping.");
}
