# Changelog

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
