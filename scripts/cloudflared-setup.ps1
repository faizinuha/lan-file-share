# Quick Cloudflare Tunnel launcher for LAN File Share on Windows (PowerShell 5+).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\cloudflared-setup.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\cloudflared-setup.ps1 -Port 5050
#
# Downloads cloudflared.exe next to the script if it isn't already on PATH,
# then opens a *.trycloudflare.com tunnel to your local LAN File Share.

param(
  [int]$Port = 5000
)

$ErrorActionPreference = "Stop"

function Resolve-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $binDir = Join-Path $PSScriptRoot "..\bin"
  if (!(Test-Path $binDir)) { New-Item -ItemType Directory -Force -Path $binDir | Out-Null }
  $target = Join-Path $binDir "cloudflared.exe"
  if (!(Test-Path $target)) {
    $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
    Write-Host "Downloading cloudflared ($arch) ..."
    Invoke-WebRequest -Uri $url -OutFile $target
  }
  return $target
}

$bin = Resolve-Cloudflared
Write-Host ""
Write-Host "Starting tunnel to http://localhost:$Port ..."
Write-Host "Copy the https://*.trycloudflare.com URL that appears below — that's"
Write-Host "the link you can share with phones / friends / remote laptops."
Write-Host ""

& $bin tunnel --url "http://localhost:$Port"
