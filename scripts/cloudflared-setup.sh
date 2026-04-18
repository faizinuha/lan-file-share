#!/usr/bin/env bash
# Quick Cloudflare Tunnel launcher for LAN File Share on Linux / macOS.
#
# Wraps your local http://localhost:PORT server in a public HTTPS URL so
# you can send/receive files from anywhere without port forwarding.
#
# Usage:
#   ./scripts/cloudflared-setup.sh              # tunnels port 5000
#   ./scripts/cloudflared-setup.sh --port 5050  # different port
#
# The free tier gives you a *.trycloudflare.com URL that changes every
# restart. For a permanent URL on your own domain, see the README section
# "Cloudflare Tunnel with a custom domain (permanent URL)".

set -euo pipefail

PORT="5000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found in PATH — installing to ./bin/cloudflared ..."
  mkdir -p bin
  UNAME_S="$(uname -s)"
  UNAME_M="$(uname -m)"
  if [[ "$UNAME_S" == "Darwin" ]]; then
    if [[ "$UNAME_M" == "arm64" ]]; then
      URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
    else
      URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
    fi
    curl -fsSL -o /tmp/cloudflared.tgz "$URL"
    tar -xzf /tmp/cloudflared.tgz -C bin/
    chmod +x bin/cloudflared
  elif [[ "$UNAME_S" == "Linux" ]]; then
    case "$UNAME_M" in
      x86_64|amd64) ARCH="amd64" ;;
      aarch64|arm64) ARCH="arm64" ;;
      armv7l|armv7) ARCH="arm" ;;
      *) echo "Unsupported arch: $UNAME_M" >&2; exit 1 ;;
    esac
    URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"
    curl -fsSL -o bin/cloudflared "$URL"
    chmod +x bin/cloudflared
  else
    echo "Unsupported OS: $UNAME_S" >&2
    exit 1
  fi
  CLOUDFLARED="./bin/cloudflared"
else
  CLOUDFLARED="cloudflared"
fi

echo
echo "Starting tunnel to http://localhost:${PORT} ..."
echo "Copy the https://*.trycloudflare.com URL that appears below — that's"
echo "the link you can share with phones / friends / remote laptops."
echo

exec "$CLOUDFLARED" tunnel --url "http://localhost:${PORT}"
