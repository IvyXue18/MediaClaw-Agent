#!/bin/sh
@goto windows 2>NUL
rm -f NUL
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/launch-agent" "$@"
exit 1

:windows
@echo off
setlocal

set "RELEASE_VERSION=v0.4.2"
set "REPOSITORY=IvyXue18/MediaClaw-Agent"
set "ASSET=mediaclaw-agent-windows-x64.exe"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ASSET=mediaclaw-agent-windows-arm64.exe"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ASSET=mediaclaw-agent-windows-arm64.exe"

if defined PLUGIN_DATA (
  set "RUNTIME_ROOT=%PLUGIN_DATA%\runtime\%RELEASE_VERSION%"
) else if defined CODEBUDDY_PLUGIN_DATA (
  set "RUNTIME_ROOT=%CODEBUDDY_PLUGIN_DATA%\runtime\%RELEASE_VERSION%"
) else if defined CLAUDE_PLUGIN_DATA (
  set "RUNTIME_ROOT=%CLAUDE_PLUGIN_DATA%\runtime\%RELEASE_VERSION%"
) else if defined LOCALAPPDATA (
  set "RUNTIME_ROOT=%LOCALAPPDATA%\MediaClaw\Agent\runtime\%RELEASE_VERSION%"
) else (
  set "RUNTIME_ROOT=%USERPROFILE%\.mediaclaw-agent\runtime\%RELEASE_VERSION%"
)

set "BINARY=%RUNTIME_ROOT%\%ASSET%"
if exist "%BINARY%" goto run

echo MediaClaw Agent 正在准备当前电脑所需的官方组件（优先使用国内下载源，失败时改用 GitHub）…… 1>&2
set "MEDIACLAW_AGENT_RUNTIME_ROOT=%RUNTIME_ROOT%"
set "MEDIACLAW_AGENT_RUNTIME_ASSET=%ASSET%"
set "MEDIACLAW_AGENT_RUNTIME_MIRROR_URL=https://media.mediaclaw.app/agent/runtime/%RELEASE_VERSION%"
set "MEDIACLAW_AGENT_RUNTIME_GITHUB_URL=https://github.com/%REPOSITORY%/releases/download/%RELEASE_VERSION%"

rem Each source is verified against its own release checksum list. curl.exe abandons a source slower than
rem 50 KB/s for 30 seconds; when curl.exe itself cannot run or cannot complete TLS on this PC (exit 2, 35, 60),
rem the same file is fetched with Invoke-WebRequest instead.
rem A host started from PowerShell 7 passes down its PSModulePath, which makes Windows PowerShell lose
rem cmdlets such as Get-FileHash; the variable is cleared for this call only and the hash uses .NET directly.
setlocal
set "PSModulePath="
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$ProgressPreference = 'SilentlyContinue';" ^
  "$root = $env:MEDIACLAW_AGENT_RUNTIME_ROOT;" ^
  "$asset = $env:MEDIACLAW_AGENT_RUNTIME_ASSET;" ^
  "$binary = Join-Path $root $asset;" ^
  "$nonce = [Guid]::NewGuid().ToString('N');" ^
  "$binaryTemp = $binary + '.' + $nonce + '.tmp';" ^
  "$checksums = Join-Path $root 'checksums.txt';" ^
  "$checksumsTemp = $checksums + '.' + $nonce + '.tmp';" ^
  "New-Item -ItemType Directory -Force -Path $root | Out-Null;" ^
  "$curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "function Save-RuntimeFile([string]$uri, [string]$out) {" ^
  "  if ($curl) {" ^
  "    & $curl.Path --fail --location --silent --connect-timeout 15 --speed-limit 51200 --speed-time 30 --output $out $uri;" ^
  "    if ($LASTEXITCODE -eq 0) { return };" ^
  "    if (@(2, 35, 60) -notcontains $LASTEXITCODE) { throw ('curl exit ' + $LASTEXITCODE) }" ^
  "  };" ^
  "  Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $out" ^
  "}" ^
  "function Get-Runtime([string]$base) {" ^
  "  try {" ^
  "    Save-RuntimeFile ($base + '/' + $asset) $binaryTemp;" ^
  "    Save-RuntimeFile ($base + '/checksums.txt') $checksumsTemp;" ^
  "    $line = Get-Content $checksumsTemp | Where-Object { $_ -match ('\s+\*?' + [regex]::Escape($asset) + '$') } | Select-Object -First 1;" ^
  "    if (-not $line) { throw ('release manifest has no checksum for ' + $asset) };" ^
  "    $expected = ($line -split '\s+')[0].ToLowerInvariant();" ^
  "    $stream = [System.IO.File]::OpenRead($binaryTemp);" ^
  "    try { $actual = ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $stream.Dispose() };" ^
  "    if ($actual -ne $expected) { throw 'runtime checksum verification failed' };" ^
  "    Move-Item -Force $checksumsTemp $checksums;" ^
  "    Move-Item -Force $binaryTemp $binary;" ^
  "    return $true" ^
  "  } catch {" ^
  "    [Console]::Error.WriteLine('MediaClaw Agent runtime source failed: ' + $base + ' (' + $_.Exception.Message + ')');" ^
  "    return $false" ^
  "  } finally {" ^
  "    Remove-Item -Force -ErrorAction SilentlyContinue $binaryTemp, $checksumsTemp" ^
  "  }" ^
  "}" ^
  "if (-not (Get-Runtime $env:MEDIACLAW_AGENT_RUNTIME_MIRROR_URL) -and -not (Get-Runtime $env:MEDIACLAW_AGENT_RUNTIME_GITHUB_URL)) { exit 1 };" ^
  "exit 0"

if errorlevel 1 (
  echo MediaClaw Agent 官方组件下载或校验失败（国内下载源与 GitHub 均未成功），已拒绝启动。请检查网络后重试。 1>&2
  exit /b 1
)
endlocal
echo MediaClaw Agent 官方组件已校验，正在建立本机连接。 1>&2

:run
set "MEDIACLAW_AGENT_STANDALONE=1"
if not defined MEDIACLAW_AGENT_PACKAGE_ROOT if exist "%~dp0..\..\..\.git" for %%I in ("%~dp0..\..\..") do set "MEDIACLAW_AGENT_PACKAGE_ROOT=%%~fI"
"%BINARY%" %*
exit /b %ERRORLEVEL%
