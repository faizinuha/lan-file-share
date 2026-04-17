# LAN File Share

> Aplikasi **Electron (PC)** + **PWA (HP)** untuk berbagi file dua arah di jaringan lokal yang sama. Tinggal masukin nama device, langsung bisa browse / upload / download / preview / rename / hapus / bikin folder / search / share-link antar device.

[![CI](https://github.com/faizinuha/lan-file-share/actions/workflows/ci.yml/badge.svg)](https://github.com/faizinuha/lan-file-share/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E=18-brightgreen.svg)](https://nodejs.org)
[![Electron 30](https://img.shields.io/badge/electron-30-47848F.svg)](https://www.electronjs.org)

---

## Daftar isi

- [Gambaran singkat](#gambaran-singkat)
- [Fitur](#fitur)
- [Cara kerja](#cara-kerja)
- [Jalankan di PC (Electron)](#jalankan-di-pc-electron)
- [Akses dari HP (PWA)](#akses-dari-hp-pwa)
- [Mode server-only](#mode-server-only-tanpa-electron)
- [Apakah bisa diakses jarak jauh?](#apakah-bisa-diakses-jarak-jauh)
- [API reference](#api-reference)
- [Konfigurasi & environment](#konfigurasi--environment)
- [Struktur folder](#struktur-folder)
- [Troubleshooting](#troubleshooting)
- [Keamanan](#keamanan)
- [Development](#development)
- [Roadmap](#roadmap)
- [Lisensi](#lisensi)

---

## Gambaran singkat

Aplikasi ini dibuat biar HP dan PC bisa tuker-tukeran file di jaringan rumah / kantor **tanpa perlu cloud**, tanpa kabel, tanpa install aplikasi mobile dari store.

Di PC, app jalan sebagai aplikasi desktop (Electron). Di HP, app tampil sebagai halaman web yang bisa di-install ke home screen lewat tombol "Add to Home Screen" → berubah jadi ikon aplikasi standalone (tanpa address bar, support fullscreen, offline shell).

Kedua sisi identik: sama-sama bisa lihat file device lain dan upload ke device manapun (file sebenernya disimpan di PC yang jadi host server, tiap device punya subfolder pribadi yang terlabel pakai nama mereka).

## Fitur

- **Register pakai nama device** — tiap HP / PC daftar nama (misal `HP-Faiz`, `Laptop-Kerja`) yang muncul di list device online.
- **File explorer** — breadcrumb, grid view, thumbnail foto otomatis.
- **Upload** — tombol + drag & drop, multi-file, streaming ke disk (default max 10 GB/file).
- **Download** — satu klik.
- **Preview** inline: foto, video, audio, teks, JSON, XML.
- **Rename** file / folder.
- **Hapus** file / folder (rekursif).
- **Bikin folder** baru.
- **Search** rekursif di folder aktif (maks 200 hasil).
- **Share link** dengan token acak 128-bit + expiry (15 menit, 1 jam, 24 jam, 7 hari). Bisa dibuka tanpa register.
- **WebSocket** untuk presence device + auto-refresh file list saat file berubah.
- **QR code** — di PC ada tombol QR yang tampilin alamat server, tinggal scan dari HP.
- **PWA** — HP bisa "Add to Home Screen" sebagai aplikasi standalone. Offline shell.
- **Proteksi path traversal** — semua akses file dibatasi di `sharedRoot`.

## Cara kerja

```
┌─────────────────────────┐     WiFi / LAN yang sama     ┌─────────────────────────┐
│   PC / Mac (Electron)   │  <── HTTP + WebSocket ──>    │   HP (browser / PWA)    │
│                         │                              │                         │
│  ┌───────────────────┐  │                              │  ┌───────────────────┐  │
│  │  Electron window  │  │                              │  │   Chrome/Safari   │  │
│  │  (UI yang sama)   │  │                              │  │  atau PWA install │  │
│  └───────────────────┘  │                              │  └───────────────────┘  │
│           │             │                              │           │             │
│  ┌───────────────────┐  │  port 5000 (default)         │           │             │
│  │  Express + WS     │<─┼─ 0.0.0.0:5000 ──>            │           │             │
│  │  + multer + qrcode│  │                              │           │             │
│  └───────────────────┘  │                              │           │             │
│           │             │                              │                         │
│   ~/LanFileShare/       │                              │                         │
│   ├─ PC-Faiz-xxxxxx/    │                              │                         │
│   ├─ HP-Faiz-yyyyyy/    │                              │                         │
│   └─ HP-Istri-zzzzzz/   │                              │                         │
└─────────────────────────┘                              └─────────────────────────┘
```

- **PC yang jalanin Electron = host**. Server HTTP + WebSocket ada di PC itu. Semua file tersimpan di `~/LanFileShare` (bisa diganti).
- **Tiap device** yang register bikin subfolder pribadi dengan namanya sendiri. Tapi semua device bisa lihat seluruh isi `sharedRoot` (konsep "shared drive"), jadi tuker file gampang.
- **HP nggak perlu install** apapun dari app store — cukup buka URL lalu "Add to Home Screen" di Chrome/Safari.
- **Real-time**: WebSocket kasih tahu device lain pas ada file baru / rename / delete → UI auto-refresh.

## Jalankan di PC (Electron)

### Prasyarat

- [Node.js](https://nodejs.org) 18 atau lebih tinggi
- Git
- Windows / macOS / Linux

### Install & jalankan

```bash
git clone https://github.com/faizinuha/lan-file-share.git
cd lan-file-share
npm install
npm start
```

Saat pertama kali jalan:

1. Bikin folder `~/LanFileShare` (atau folder yang kamu pilih) sebagai root shared.
2. Start server di port `5000`.
3. Buka window Electron dengan UI register.

Lalu:

- Isi nama device (misal `PC-Faiz`) → klik Masuk.
- Klik tombol **QR** di pojok kanan atas → screen tampilin QR code & URL (contoh `http://192.168.1.5:5000`).
- Dari HP, scan QR-nya atau ketik URL manual.

### Ganti folder shared

Di Electron window, klik tombol **Pilih folder** → pilih folder yang mau kamu share. Restart app biar efektif.

## Akses dari HP (PWA)

1. Pastikan HP & PC di **WiFi yang sama**.
2. Di HP, buka Chrome (Android) atau Safari (iOS), ketik URL yang muncul di QR code (misal `http://192.168.1.5:5000`).
3. Isi nama HP (misal `HP-Faiz`) → klik Masuk.
4. Install sebagai app:
   - **Android (Chrome)**: menu (⋮) → **Add to Home screen** / **Install app**.
   - **iOS (Safari)**: tombol Share → **Add to Home Screen**.
5. Ikon aplikasi muncul di home screen. Klik → app kebuka fullscreen, tanpa address bar, tampil seperti aplikasi native.

## Mode server-only (tanpa Electron)

Kalau kamu mau jalanin app ini di server headless (Raspberry Pi, NAS, cloud VPS), skip Electron dan pakai server mentahnya:

```bash
npm install
LAN_FILE_SHARE_ROOT=/srv/shared LAN_FILE_SHARE_PORT=5000 npm run server
```

Lalu akses dari browser / HP: `http://<ip-server>:5000`.

Jalan sebagai systemd service:

```ini
# /etc/systemd/system/lan-file-share.service
[Unit]
Description=LAN File Share
After=network.target

[Service]
Type=simple
User=sharer
WorkingDirectory=/opt/lan-file-share
Environment=LAN_FILE_SHARE_ROOT=/srv/shared
Environment=LAN_FILE_SHARE_PORT=5000
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now lan-file-share
```

## Apakah bisa diakses jarak jauh?

**Secara default: TIDAK** — app ini dirancang buat LAN saja (HP & PC harus di WiFi yang sama). Server listen di `0.0.0.0` dan **nggak punya autentikasi apapun**, jadi jangan langsung expose ke internet tanpa proteksi.

Tapi bisa diakses remote pakai salah satu cara di bawah:

### Opsi 1 — Tailscale (rekomendasi, paling aman)

[Tailscale](https://tailscale.com) bikin VPN mesh gratis (hingga 3 user / 100 device) antar device kamu. Setelah install, HP dan PC punya IP Tailscale (100.x.y.z) yang cuma bisa diakses dari device yang terdaftar di akun kamu.

```bash
# Di PC:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Di HP: install app Tailscale dari Play Store / App Store, login.
```

Setelah connect, cek IP Tailscale PC: `tailscale ip -4`. Akses dari HP (meski HP lagi pakai data seluler di luar rumah): `http://<tailscale-ip-pc>:5000`.

### Opsi 2 — Cloudflare Tunnel (gratis, public HTTPS)

Kalau kamu punya domain di Cloudflare:

```bash
# Install cloudflared di PC:
brew install cloudflared     # macOS
# atau download dari https://github.com/cloudflare/cloudflared/releases

cloudflared tunnel login
cloudflared tunnel create lan-file-share
cloudflared tunnel route dns lan-file-share share.yourdomain.com
cloudflared tunnel --url http://localhost:5000 run lan-file-share
```

App bisa diakses di `https://share.yourdomain.com`. **Wajib tambah Cloudflare Access** (login SSO Google/Microsoft/dll) biar nggak siapa aja bisa buka.

### Opsi 3 — ngrok (paling cepat, URL acak)

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 5000
```

Output kasih URL publik `https://xxx-xxx.ngrok-free.app`. Share ke HP (bisa di data seluler). **URL ganti tiap restart di tier gratis.** Tambah basic-auth via `ngrok http --basic-auth="user:pass" 5000` biar aman.

### Opsi 4 — Port forwarding router (NOT RECOMMENDED)

Teknisnya bisa: forward port 5000 router kamu ke IP LAN PC, lalu akses via IP publik. **TAPI**: app belum punya auth, jadi siapapun yang tau IP kamu bisa akses semua file. Jangan pakai cara ini kecuali kamu udah kasih lapisan reverse proxy dengan basic auth (caddy / nginx).

> **Ringkasan keamanan**: remote access SELALU butuh lapisan tambahan (VPN Tailscale, Cloudflare Access, atau reverse proxy dengan auth). Lihat [Roadmap](#roadmap) untuk fitur auth built-in yang lagi direncanakan.

## API reference

Semua endpoint balikin JSON kecuali yang streaming file. Error format: `{ "error": "..." }`.

### `GET /api/status`

Status server + daftar IP LAN.

```json
{
  "ok": true,
  "host": { "id": "...", "name": "PC-Faiz", "kind": "pc", "folder": "PC-Faiz-abcdef" },
  "sharedRoot": "/home/faiz/LanFileShare",
  "lan": [{ "iface": "wlan0", "address": "192.168.1.5" }],
  "port": 5000
}
```

### `GET /api/qrcode?ip=<optional>`

Balikin `{ url, dataUrl }` (dataUrl = base64 PNG QR code, bisa langsung dipasang ke `<img>`).

### `POST /api/devices/register`

Body: `{ "name": "HP-Faiz", "kind": "mobile" | "pc" }` → `{ device: { id, name, slug, kind, folder } }`.

### `POST /api/devices/:id/ping`

Keep-alive; kalau 45 detik nggak ping, device di-reap otomatis.

### `GET /api/devices`

List semua device yang online.

### `DELETE /api/devices/:id`

Kick device (tidak bisa kick host).

### `GET /api/files?path=<relative>`

Browse folder. Balikin `{ path, entries: [{ name, path, size, mtime, isDirectory, mime }] }`.

### `GET /api/files/search?query=<q>&path=<base>`

Rekursif by-filename. Maks 200 hasil.

### `GET /api/files/download?path=<relative>`

Stream download, dengan `Content-Disposition: attachment`.

### `GET /api/files/preview?path=<relative>`

Stream dengan `Content-Type` sesuai mime — cocok untuk `<img>`, `<video>`, `<audio>`, `fetch().text()`.

### `POST /api/files/upload?path=<target-dir>`

Multipart form, field `files` (multi). Balikin `{ uploaded: [{ name, size }] }`.

### `POST /api/files/mkdir`

Body: `{ "path": "parent", "name": "new-folder" }`.

### `POST /api/files/rename`

Body: `{ "path": "path/to/file.txt", "newName": "newname.txt" }`.

### `DELETE /api/files?path=<relative>`

Hapus file / folder rekursif. Nggak bisa hapus root.

### `POST /api/share`

Body: `{ "path": "file.txt", "expiresInMinutes": 60, "maxDownloads": 3 }` → `{ token, url, expiresAt }`.

### `GET /share/:token`

Public download (tanpa auth). Otomatis expired setelah `expiresAt` atau setelah `maxDownloads` terpakai.

### `WS /ws`

WebSocket broadcast channel. Server → client:

- `{ type: "devices", devices: [...] }` — device list berubah
- `{ type: "files-changed", path: "..." }` — folder `path` berubah (upload/delete/mkdir/rename)

Client → server: `{ type: "ping", deviceId }` (keep-alive alternatif HTTP ping).

## Konfigurasi & environment

| Variable | Default | Deskripsi |
|---|---|---|
| `LAN_FILE_SHARE_PORT` | `5000` | Port HTTP server |
| `LAN_FILE_SHARE_ROOT` | `~/LanFileShare` | Folder root shared (hanya mode server-only; Electron simpan di config) |
| `LAN_FILE_SHARE_DEV` | unset | `1` untuk buka DevTools Electron |

Config Electron tersimpan di:

- Linux: `~/.config/lan-file-share/config.json`
- macOS: `~/Library/Application Support/lan-file-share/config.json`
- Windows: `%APPDATA%\lan-file-share\config.json`

## Struktur folder

```
.
├── main.js                  # Electron main (BrowserWindow + IPC)
├── preload.js               # Preload script (contextBridge API)
├── server.js                # Express + WebSocket server
├── public/                  # Frontend (juga di-load Electron)
│   ├── index.html           # Register screen + main app
│   ├── app.js               # Client logic
│   ├── styles.css           # Theme: slate + blue accent
│   ├── manifest.webmanifest # PWA manifest
│   ├── service-worker.js    # Offline shell cache
│   └── icons/               # SVG + PNG (generated)
├── scripts/
│   ├── generate-icons.js    # Generate icon-192.png & icon-512.png
│   └── smoke-test.js        # CI end-to-end test
├── .github/workflows/ci.yml # Lint + smoke test matrix
├── .eslintrc.json
├── package.json
├── LICENSE (MIT)
└── README.md
```

## Troubleshooting

### HP nggak bisa buka URL

- **Pastikan WiFi sama**. Kalau PC pake WiFi tamu dan HP pake WiFi utama, nggak akan nyambung.
- **Firewall PC**: izinin port 5000 di network private.
  - Windows: Windows Defender Firewall → Allow an app → add Node.js / Electron on Private networks.
  - macOS: System Settings → Network → Firewall → tambah Electron.
  - Linux: `sudo ufw allow from 192.168.0.0/16 to any port 5000`.
- **IP yang benar**: pastikan ngambil IP dari QR code, bukan `127.0.0.1`.

### Service worker nggak register di iOS Safari

iOS hanya kasih izin PWA di **HTTPS**. Untuk LAN, ini keterbatasan. Workaround: pakai Cloudflare Tunnel / ngrok biar dapat HTTPS.

### Port 5000 udah kepake

```bash
LAN_FILE_SHARE_PORT=5050 npm start
```

### Upload besar gagal

Edit `server.js` pada multer config (`limits: { fileSize: ... }`), pastikan RAM/disk cukup.

### Electron window blank

Cek DevTools dengan `LAN_FILE_SHARE_DEV=1 npm start`. Kemungkinan besar server gagal start (port bentrok, permission folder).

## Keamanan

- **Tidak ada autentikasi** — siapa aja yang di-WiFi yang sama bisa akses semua file di `sharedRoot`. **Jangan run di WiFi publik**.
- **Path traversal diproteksi** — semua path divalidasi terhadap `sharedRoot` dan segment `..` ditolak eksplisit.
- **Share token** acak 128-bit dengan expiry & optional max-downloads.
- **Dotfiles disembunyikan** dari listing (file `.env`, `.git`, dll).
- **Upload size limit 10 GB** default — sesuaikan kalau perlu.
- **Tidak ada HTTPS** by default — konten upload/download plaintext di LAN. Pakai Cloudflare Tunnel / reverse proxy untuk HTTPS.

Lihat [Roadmap](#roadmap) untuk fitur PIN per-device & HTTPS self-signed yang lagi direncanakan.

## Development

```bash
# Install
npm install

# Lint
npm run lint

# Smoke test (end-to-end, tanpa Electron)
node scripts/smoke-test.js

# Electron dev mode (DevTools terbuka)
LAN_FILE_SHARE_DEV=1 npm start

# Server-only dev mode
LAN_FILE_SHARE_PORT=5055 LAN_FILE_SHARE_ROOT=/tmp/lfs node server.js
```

### Testing manual

1. `node server.js` di PC.
2. Buka `http://localhost:5000` di browser, register device `Tester`.
3. Buka tab incognito, register device `Tester2`.
4. Upload di satu tab, verify muncul otomatis di tab lain (WebSocket push).

### CI

GitHub Actions (`.github/workflows/ci.yml`) jalanin:

- **Lint** (Node 18 / 20 / 22) — `npm run lint`
- **Smoke test** (Linux / macOS / Windows, Node 20) — `node scripts/smoke-test.js`
- **Audit** — `npm audit --omit=dev --audit-level=high` (non-blocking)

## Roadmap

- [ ] **PIN / passcode per-device** (proteksi minimum untuk jaringan umum)
- [ ] **HTTPS self-signed** + instalasi CA cert (biar service worker & Camera API jalan di LAN)
- [ ] **mDNS / Bonjour discovery** biar nggak perlu ketik IP
- [ ] **Zip selected files** → download sebagai 1 archive
- [ ] **Build installer** Electron via electron-builder (`.dmg`, `.exe`, `AppImage`)
- [ ] **Per-device private folder** (read/write isolation)
- [ ] **Resume / chunked upload** untuk file sangat besar
- [ ] **Transfer langsung peer-to-peer** via WebRTC (HP → HP tanpa lewat server)

## Lisensi

MIT © faizinuha — lihat [LICENSE](LICENSE).

## Kontribusi

PR welcome. Ikutin konvensi:

- Pesan commit jelas.
- Jalanin `npm run lint` sebelum push.
- Jalanin `node scripts/smoke-test.js` kalau nyentuh `server.js` atau API.
