# Changelog

## v0.6.1 — 2026-04-18

### Bug Fixes
- **review**: reset state.entries on failed loadFiles to avoid stale render (8bc7e33)

## v0.6.0 — 2026-04-18

### Features
- shared folder with uploader metadata (no more per-device folders) (3efa576)

### Bug Fixes
- **review**: add per-directory mutex to meta read-modify-write (6893c11)
- **review**: search results get uploader metadata; doSearch updates state.entries (1a051a7)

## v0.5.0 — 2026-04-18

### Features
- **hp**: kick device, system tray, install-to-HP via Cloudflare Tunnel, Web Share Target (a000867)

### Bug Fixes
- **ci**: force_bump path must also bump off highest tag, not package.json (0056fbe)
- **ci**: release.yml bump off highest tag, use refs/tags/... on checkout (efeb3b0)
- **review**: 45s tunnel timeout must not kill newer active proc (040c1c9)
- **review**: tunnel finish() must not clobber newer proc's starting flag (3741da5)
- **review**: tunnel exit handler race + tray open-modal event handler (e1f9b96)
- **review**: kickDevice uses onOk callback; /api/qrcode accepts url param (17bc4b0)

All notable changes to this project are documented here. Entries below
`v0.3.0` are hand-curated; from `v0.3.0` onward the
[`Auto-release (Conventional Commits)`](.github/workflows/release-auto.yml)
workflow prepends a new section automatically on every push to `main`.

## v0.2.0 — 2026-04-18

### Features
- Auto-update via `electron-updater` (startup check + manual "Cek update" button + download/install modal).
- Client-side image resize before upload (canvas, max 2048px, JPEG 85%) so low-memory phones don't OOM on large photos.
- Chunked upload for files > 8 MB (4 MB chunks, 3x retry with exponential backoff, path-traversal hardening).
- Cloudflare Tunnel helper scripts (`scripts/cloudflared-setup.sh` / `.ps1`) for free HTTPS remote access.

### Bug Fixes
- Chunked upload endpoint now returns HTTP 400 (not 500) on path traversal.
- Update check uses a numeric semver comparator — dev builds ahead of the
  latest published release no longer trigger a spurious "update available"
  modal, and `v0.10.0` is correctly newer than `v0.2.0`.

## v0.1.0 — 2026-04-18

Initial release: Electron + Express + PWA + WebSocket core, WebDAV mount at
`/webdav`, device registration, browse/upload/download/preview/rename/delete/
mkdir/search, share links, QR onboarding, and installer builds for Windows
(NSIS + portable), macOS (DMG + ZIP), and Linux (AppImage + .deb).
