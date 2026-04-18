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
- [Auto-release (Conventional Commits)](#auto-release-conventional-commits)
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
- **WebDAV** di `/webdav` — mount folder shared sebagai drive network di Windows Explorer, macOS Finder, iOS Files, atau file manager Android. File muncul langsung di file explorer native tanpa buka aplikasi.
- **Auto-update** (Electron) — cek GitHub Releases otomatis pas startup + tombol manual "Cek update". Notifikasi in-app + download + install + restart, semua dari dalam aplikasi. Lihat [Auto-update](#auto-update-electron).
- **Upload tahan banting untuk HP low-memory** — foto otomatis di-resize client-side (max 2048px / JPEG 85%) sebelum upload, file besar (>8 MB) dipecah jadi chunk 4 MB streaming (memori HP tetep kecil), tiap chunk di-retry 3x dengan exponential backoff kalau WiFi drop. Lihat [Upload dari HP](#upload-dari-hp-anti-gagal-low-memory).
- **Remote access via Cloudflare Tunnel** — one-liner script buat bikin public HTTPS URL gratis tanpa port forward / domain. Lihat [Remote access jarak jauh](#apakah-bisa-diakses-jarak-jauh).

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

## Install (prebuilt)

Cara paling gampang: download installer untuk OS kamu dari halaman [Releases](https://github.com/faizinuha/lan-file-share/releases/latest) dan install seperti aplikasi biasa. Setelah install, app muncul:

- **Windows**: Start Menu → "LAN File Share" (+ shortcut desktop, + entry di Add/Remove Programs untuk uninstall).
- **macOS**: Applications → "LAN File Share" (Launchpad, Spotlight).
- **Linux (.deb / Debian / Ubuntu)**: `sudo dpkg -i lan-file-share_*.deb` — muncul di Activities / Applications menu (kategori Network / File Transfer).
- **Linux (.AppImage)**: `chmod +x 'LAN File Share-*.AppImage' && ./'LAN File Share-*.AppImage'` — portable, 1 file.

File yang tersedia per release:

| OS | File |
|---|---|
| Windows x64 (installer) | `LAN File Share Setup 0.1.0.exe` |
| Windows x64 (portable) | `LAN File Share 0.1.0.exe` |
| macOS (Intel + Apple Silicon, DMG) | `LAN File Share-0.1.0.dmg`, `-arm64.dmg` |
| macOS (zip) | `LAN File Share-0.1.0-mac.zip` |
| Linux x64 (AppImage) | `LAN File Share-0.1.0.AppImage` |
| Linux x64 (Debian/Ubuntu) | `lan-file-share_0.1.0_amd64.deb` |

> Pertama kali jalan di Windows, **Microsoft SmartScreen** bisa warn ("Windows protected your PC") karena installer belum signed. Klik **More info → Run anyway**. Masalah yang sama di macOS Gatekeeper untuk DMG: buka System Settings → Privacy & Security → Open Anyway.

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

### Build installer sendiri

```bash
npm run dist          # Build untuk OS saat ini
npm run dist:win      # Windows (.exe NSIS installer + portable)
npm run dist:mac      # macOS (.dmg universal x64 + arm64 + .zip)
npm run dist:linux    # Linux (.AppImage + .deb)
npm run pack          # Hanya unpacked folder, tanpa bikin installer (cepat, buat debug)
```

Hasil masuk ke `dist/`. Config ada di `package.json` pada field `build` (electron-builder). Untuk build macOS code-signed kamu butuh Apple Developer ID + set env `CSC_LINK` / `CSC_KEY_PASSWORD`; untuk Windows Authenticode set `CSC_LINK` pointing ke `.pfx`.

### Release otomatis via GitHub Actions

Tag commit dengan format `vX.Y.Z`:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) akan:

1. Build installer di `ubuntu-latest`, `macos-latest`, `windows-latest` secara paralel.
2. Upload tiap artifact ke GitHub Release (draft) dengan release notes auto-generated.
3. Kamu tinggal publish draft-nya biar user bisa download.

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

## Muncul di file explorer native (WebDAV)

Selain pakai UI Electron / PWA, kamu bisa mount folder shared langsung sebagai **network drive** lewat protokol WebDAV di endpoint `/webdav`. Hasilnya file muncul persis di "My Files" / Finder / Explorer tanpa perlu buka aplikasi.

> Port & host yang dipakai di contoh: `http://192.168.1.5:5000` — ganti sesuai alamat PC kamu (lihat QR code / status di app).

### Windows 10 / 11

Registry patch (sekali saja — biar Windows bisa connect HTTP tanpa HTTPS):

1. Buka **regedit** → `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters`
2. Set **`BasicAuthLevel`** = `2` dan **`FileSizeLimitInBytes`** = `ffffffff` (hex).
3. Restart service **WebClient** (`net stop webclient && net start webclient`).

Lalu:

- Buka **This PC** → **Map network drive**
- Folder: `\\192.168.1.5@5000\webdav\` (perhatikan `@5000` untuk port non-default)
- Atau via Explorer address bar: `http://192.168.1.5:5000/webdav/`

### macOS (Finder)

- **Finder** → menu **Go** → **Connect to Server** (⌘K)
- URL: `http://192.168.1.5:5000/webdav/`
- Connect sebagai **Guest** (app ini memang tanpa auth di LAN).
- Mount muncul di sidebar Finder; drag & drop langsung ke sini.

### iOS & iPadOS (Files app bawaan)

- Buka **Files** → tab **Browse** → tombol titik tiga (⋯) → **Connect to Server**
- Server: `http://192.168.1.5:5000/webdav`
- Connect as **Guest**
- Mount muncul di **Shared** section Files app — bisa dibuka, upload foto langsung dari Photos ("Save to Files" → pilih server ini).

### Android

Android nggak punya WebDAV built-in. Gunakan salah satu file manager berikut:

- **Solid Explorer** (Play Store, berbayar)
- **Cx File Explorer** (gratis) — **+** → Remote → WebDAV
- **RaiDrive** untuk ChromeOS
- Server URL: `http://192.168.1.5:5000/webdav` — anonymous / guest.

### Linux (GNOME Files / Dolphin)

- Nautilus: **Other Locations** → ketik `dav://192.168.1.5:5000/webdav/`
- KDE Dolphin: ketik `webdav://192.168.1.5:5000/webdav/` di address bar
- CLI: `sudo mount -t davfs http://192.168.1.5:5000/webdav /mnt/lfs` (butuh `davfs2`)

> **Catatan**: karena tanpa HTTPS, iOS Files kadang nolak connect (butuh TLS). Solusi: jalankan di belakang Cloudflare Tunnel (lihat section [Apakah bisa diakses jarak jauh?](#apakah-bisa-diakses-jarak-jauh)) yang otomatis kasih HTTPS.

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

**Cara paling cepet (nggak perlu domain)** — pakai *quick tunnel*: cloudflared kasih URL `https://*.trycloudflare.com` gratis selama prosesnya jalan. Di repo ini ada helper script yang download binary-nya otomatis:

```bash
# Linux / macOS
./scripts/cloudflared-setup.sh              # pake port default 5000
./scripts/cloudflared-setup.sh --port 5050  # port lain

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File .\scripts\cloudflared-setup.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\cloudflared-setup.ps1 -Port 5050
```

Copy URL `https://xxx-xxx.trycloudflare.com` yang muncul di output → share ke HP, ke teman, atau buat diakses dari luar rumah. HP nggak perlu di WiFi yang sama. Kelemahan: URL berubah tiap restart, dan masih belum ada auth — share URL-nya ke orang yang kamu percaya aja.

**Cara permanen (punya domain di Cloudflare)** — bikin tunnel permanen dengan subdomain tetap:

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

### WebDAV `/webdav/*`

Full RFC 4918 subset: `OPTIONS`, `PROPFIND` (depth 0/1), `GET`, `HEAD`, `PUT`, `MKCOL`, `DELETE`, `MOVE`, `COPY`, `LOCK`, `UNLOCK`, `PROPPATCH`. Tidak ada auth — tutup dengan reverse proxy sebelum expose keluar LAN.

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
├── webdav.js                # WebDAV (RFC 4918) handler mounted at /webdav
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

## Auto-update (Electron)

App desktop pake [electron-updater](https://www.electron.build/auto-update) buat cek versi terbaru dari **GitHub Releases**. Cara kerjanya:

- Pas startup (setelah window muncul ~5 detik), app cek rilis terbaru di `github.com/faizinuha/lan-file-share/releases`. Kalau versi `package.json` di app < versi release terbaru, muncul toast + modal "Update tersedia" dengan tombol **Download**.
- Download jalan di background (progress bar di modal). Kalau udah selesai, tombol berubah jadi **Install & restart** — klik, app keluar + installer kecil jalan, abis itu app buka lagi di versi baru.
- Tombol manual **"Cek update"** di topbar buat cek on-demand.
- Kalau app dijalanin dengan `npm start` (dev mode), updater dimatikan otomatis (`app.isPackaged === false`).

Untuk maintainer yang mau rilis versi baru, ada dua cara:

**(A) Otomatis lewat Conventional Commits — default.** Cukup commit ke `main` pakai format `feat: ...`, `fix: ...`, atau `feat!: ...`, lalu workflow [`release-auto.yml`](.github/workflows/release-auto.yml) nge-bump `package.json`, bikin tag `vX.Y.Z`, dan dispatch `release.yml` yang build 3 OS + publish GitHub Release. User yang udah install app dapat notifikasi update otomatis. Detail konvensinya lihat [Auto-release](#auto-release-conventional-commits) di bawah.

**(B) Manual kalau mau full control.** Bump `package.json` version sendiri → `git tag vX.Y.Z && git push --tags` → GitHub Actions `release.yml` build 3 OS + upload artifact + `latest.yml/latest-mac.yml/latest-linux.yml` ke GitHub Release.

## Auto-release (Conventional Commits)

Tiap push ke `main` di-scan pake [`scripts/conventional-bump.js`](scripts/conventional-bump.js). Kalau ada commit yang matching pola di bawah, workflow [`release-auto.yml`](.github/workflows/release-auto.yml) otomatis:

1. Tentuin level bump (patch / minor / major) dari commit subjects.
2. `npm version X.Y.Z --no-git-tag-version` → update `package.json` + `package-lock.json`.
3. Prepend entry baru ke `CHANGELOG.md` (release notes di-generate dari commit subjects).
4. Commit `chore(release): vX.Y.Z [skip release]` + annotated tag `vX.Y.Z`, push ke `main`.
5. Dispatch `release.yml` buat build `.exe` / `.dmg` / `.AppImage` / `.deb` dan publish GitHub Release — electron-updater di app yang udah ke-install bakal auto-notify.

### Format commit

Pakai [Conventional Commits](https://www.conventionalcommits.org) versi minimal:

| Subject prefix | Contoh | Efek |
|---|---|---|
| `feat:` / `feat(scope):` | `feat(upload): add drag & drop` | **minor** bump (0.2.0 → 0.3.0) |
| `fix:` / `fix(scope):` | `fix(server): guard ENOENT on preview` | **patch** bump (0.2.0 → 0.2.1) |
| `perf:` | `perf(chunks): stream reassembly` | **patch** bump |
| `feat!:` / `fix!:` / body punya `BREAKING CHANGE:` | `feat!: change WebDAV url prefix` | **major** bump (0.2.0 → 1.0.0) |
| `chore:` / `docs:` / `refactor:` / `test:` / `ci:` / `build:` / `style:` / `revert:` | `docs: fix typo` | **tidak rilis** — push ditolerir, skip aja |

### Skip / force / troubleshoot

- **Skip 1 commit**: tulis `[skip release]` di body commit, atau di-merge-commit via squash pakai pesan `chore: ...`.
- **Force bump manual**: trigger `release-auto.yml` lewat GitHub UI (`Actions` → `Auto-release` → `Run workflow`) dan isi `force_bump` = `patch` / `minor` / `major`. Ini bypass parser — berguna kalau Conventional Commits dibungkus squash-merge dan parser nggak ketemu prefix.
- **Ngga ada commit rilisable**: workflow exit 0 tanpa tag — aman.
- **Lihat perhitungan lokal sebelum push**: `node scripts/conventional-bump.js` — output `bump=…`, `new_version=…`, `notes=…` ke stdout (dry-run, nggak modifikasi apa pun).

### Kenapa nggak pake `standard-version` / `semantic-release`?

Script 170-line tanpa deps tambahan lebih gampang di-audit dan nggak masuk ke `node_modules` buat user yang cuma mau install app. Juga nggak ada risk tools auto-release nge-publish ke npm registry (app ini bukan library).

## Upload dari HP (anti-gagal low-memory)

HP murah / lama sering gagal upload foto besar karena (1) camera JPEG 5-20 MB, (2) browser coba buffer seluruh body di RAM, dan (3) satu paket TCP drop bikin seluruh upload gagal. App ini atasi semua tiga:

1. **Auto-resize foto sebelum upload.** Kalau file bertipe image dan toggle "Auto-resize foto" di toolbar aktif (default ON), foto digambar ulang di `<canvas>` ke max dimensi 2048px + JPEG 85% quality. Foto 5 MB biasanya turun jadi ~300 KB. GIF dan SVG di-skip. File di bawah 500 KB juga di-skip (nggak ada gunanya re-encode). Kalau hasil re-encode justru lebih besar dari asli, file asli dipakai.
2. **Chunked streaming upload.** File > 8 MB dipecah client-side jadi chunk 4 MB via `File.slice()`. `.slice()` cuma bikin Blob reference — bukan copy — jadi RAM tetep flat walau file 5 GB. Tiap chunk di-POST ke `/api/files/upload-chunk?sessionId=...&chunkIndex=N&totalChunks=M&fileName=...&targetPath=...`. Server simpen tiap chunk ke `<sharedRoot>/.lfs-uploads/<sessionId>/chunk-NNNNNN`, dan pas chunk terakhir masuk, di-reassemble streaming ke file final + cleanup session. Session yang nggantung > 6 jam di-garbage-collect otomatis.
3. **Retry 3x dengan exponential backoff.** Semua upload (chunked atau tidak) di-wrap di helper retry: kalau xhr error / timeout / HTTP 5xx, coba lagi setelah 0.5s, 1s, 2s (max 4 attempts total). Berarti HP kamu bisa kehilangan koneksi WiFi sebentar, balik lagi, upload lanjut tanpa manual retry.

Semuanya ditangani otomatis — cuma aktifin / matikan toggle resize kalau mau aja (misal ngirim foto original buat cetak). Progress per-file muncul di panel "Upload berlangsung" di atas file list, lengkap dengan indikator chunk ke-berapa.

## Roadmap

- [ ] **PIN / passcode per-device** (proteksi minimum untuk jaringan umum)
- [ ] **HTTPS self-signed** + instalasi CA cert (biar service worker & Camera API jalan di LAN)
- [ ] **mDNS / Bonjour discovery** biar nggak perlu ketik IP
- [ ] **Zip selected files** → download sebagai 1 archive
- [x] **Build installer** Electron via electron-builder (`.dmg`, `.exe`, `AppImage`, `.deb`) (done)
- [x] **Auto-update** via electron-updater + GitHub Releases (done)
- [x] **Chunked / resumable upload** + client-side image resize (done)
- [x] **Cloudflare Tunnel helper script** buat remote access gratis (done)
- [ ] **Per-device private folder** (read/write isolation)
- [ ] **Share foto ke orang (non-register)** via link yang bisa di-browse, bukan cuma 1 file
- [ ] **Transfer langsung peer-to-peer** via WebRTC (HP → HP tanpa lewat server)
- [x] **WebDAV** — bisa mount sebagai network drive di file explorer native (done)

## Lisensi

MIT © faizinuha — lihat [LICENSE](LICENSE).

## Kontribusi

PR welcome. Ikutin konvensi:

- Pesan commit jelas.
- Jalanin `npm run lint` sebelum push.
- Jalanin `node scripts/smoke-test.js` kalau nyentuh `server.js` atau API.
