#!/bin/sh
@goto windows 2>/dev/null || :
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/launch-agent" "$@"
exit 1

: <<'WINDOWS_BATCH'
:windows
@echo off
setlocal

set "RELEASE_VERSION=v0.3.1"
set "REPOSITORY=IvyXue18/MediaClaw-Agent"
set "ASSET=mediaclaw-agent-windows-x64.exe"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ASSET=mediaclaw-agent-windows-arm64.exe"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ASSET=mediaclaw-agent-windows-arm64.exe"

if defined PLUGIN_DATA (
  set "RUNTIME_ROOT=%PLUGIN_DATA%\runtime\%RELEASE_VERSION%"
) else if defined CODEBUDDY_PLUGIN_DATA (
  set "RUNTIME_ROOT=%CODEBUDDY_PLUGIN_DATA%\runtime\%RELEASE_VERSION%"
) else if defined LOCALAPPDATA (
  set "RUNTIME_ROOT=%LOCALAPPDATA%\MediaClaw\Agent\runtime\%RELEASE_VERSION%"
) else (
  set "RUNTIME_ROOT=%USERPROFILE%\.mediaclaw-agent\runtime\%RELEASE_VERSION%"
)

set "BINARY=%RUNTIME_ROOT%\%ASSET%"
if exist "%BINARY%" goto run

echo MediaClaw Agent 正在准备当前电脑所需的官方组件…… 1>&2
set "MEDIACLAW_AGENT_RUNTIME_ROOT=%RUNTIME_ROOT%"
set "MEDIACLAW_AGENT_RUNTIME_ASSET=%ASSET%"
set "MEDIACLAW_AGENT_RUNTIME_BASE_URL=https://github.com/%REPOSITORY%/releases/download/%RELEASE_VERSION%"

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$root = $env:MEDIACLAW_AGENT_RUNTIME_ROOT;" ^
  "$asset = $env:MEDIACLAW_AGENT_RUNTIME_ASSET;" ^
  "$base = $env:MEDIACLAW_AGENT_RUNTIME_BASE_URL;" ^
  "$binary = Join-Path $root $asset;" ^
  "$nonce = [Guid]::NewGuid().ToString('N');" ^
  "$binaryTemp = $binary + '.' + $nonce + '.tmp';" ^
  "$checksums = Join-Path $root 'checksums.txt';" ^
  "$checksumsTemp = $checksums + '.' + $nonce + '.tmp';" ^
  "New-Item -ItemType Directory -Force -Path $root | Out-Null;" ^
  "try {" ^
  "  Invoke-WebRequest -UseBasicParsing -Uri ($base + '/' + $asset) -OutFile $binaryTemp;" ^
  "  Invoke-WebRequest -UseBasicParsing -Uri ($base + '/checksums.txt') -OutFile $checksumsTemp;" ^
  "  $line = Get-Content $checksumsTemp | Where-Object { $_ -match ('\s+\*?' + [regex]::Escape($asset) + '$') } | Select-Object -First 1;" ^
  "  if (-not $line) { throw ('Release manifest has no checksum for ' + $asset) };" ^
  "  $expected = ($line -split '\s+')[0].ToLowerInvariant();" ^
  "  $actual = (Get-FileHash -Algorithm SHA256 -Path $binaryTemp).Hash.ToLowerInvariant();" ^
  "  if ($actual -ne $expected) { throw 'Runtime checksum verification failed' };" ^
  "  Move-Item -Force $checksumsTemp $checksums;" ^
  "  Move-Item -Force $binaryTemp $binary;" ^
  "} finally {" ^
  "  Remove-Item -Force -ErrorAction SilentlyContinue $binaryTemp, $checksumsTemp;" ^
  "}"

if errorlevel 1 (
  echo MediaClaw Agent 官方组件下载或校验失败，已拒绝启动。 1>&2
  exit /b 1
)
echo MediaClaw Agent 官方组件已校验，正在建立本机连接。 1>&2

:run
set "MEDIACLAW_AGENT_STANDALONE=1"
"%BINARY%" %*
exit /b %ERRORLEVEL%
WINDOWS_BATCH
