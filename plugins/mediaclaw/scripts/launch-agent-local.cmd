#!/bin/sh
@goto windows 2>NUL
rm -f NUL
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE_BINARY="${MEDIACLAW_AGENT_NODE:-}"
if [ -z "$NODE_BINARY" ]; then
  for NODE_CANDIDATE in node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if command -v "$NODE_CANDIDATE" >/dev/null 2>&1 || [ -x "$NODE_CANDIDATE" ]; then
      NODE_BINARY="$NODE_CANDIDATE"
      break
    fi
  done
fi
if ! command -v "$NODE_BINARY" >/dev/null 2>&1 && [ ! -x "$NODE_BINARY" ]; then
  echo "MediaClaw Agent 本地源码启动需要 Node.js 22 或更高版本。请在豆包工作连接器中将 MEDIACLAW_AGENT_NODE 设为 node 的绝对路径。" >&2
  exit 1
fi
if ! "$NODE_BINARY" -e "if (Math.sign(Number(process.versions.node.split('.')[0]) - 22) === -1) process.exit(1)" >/dev/null 2>&1; then
  echo "MediaClaw Agent 本地源码启动需要 Node.js 22 或更高版本。" >&2
  exit 1
fi
export MEDIACLAW_AGENT_CHANNEL="${MEDIACLAW_AGENT_CHANNEL:-local}"
export MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK="${MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK:-1}"
export MEDIACLAW_AGENT_SUPERVISED="1"
export MEDIACLAW_AGENT_RUNTIME_VERSION="${MEDIACLAW_AGENT_RUNTIME_VERSION:-0.4.0-beta.1-local.20261005.1}"
RESTART_LIMIT="${MEDIACLAW_AGENT_LOCAL_RESTART_LIMIT:-3}"
RESTART_DELAY="${MEDIACLAW_AGENT_LOCAL_RESTART_DELAY_SECONDS:-1}"
case "$RESTART_LIMIT" in
  ''|*[!0-9]*) RESTART_LIMIT=3 ;;
esac
ATTEMPT=0
while :; do
  "$NODE_BINARY" "$SCRIPT_DIR/mcp-server.mjs" "$@"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -eq 0 ]; then
    exit 0
  fi
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge "$RESTART_LIMIT" ]; then
    exit "$EXIT_CODE"
  fi
  echo "[mediaclaw] local Agent adapter exited unexpectedly; restarting ($ATTEMPT/$RESTART_LIMIT)." >&2
  sleep "$RESTART_DELAY"
done

:windows
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "NODE_BINARY=%MEDIACLAW_AGENT_NODE%"
if not defined NODE_BINARY set "NODE_BINARY=node"
"%NODE_BINARY%" -e "process.exit(0)" >NUL 2>&1
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BINARY=%ProgramFiles%\nodejs\node.exe"
"%NODE_BINARY%" -e "process.exit(0)" >NUL 2>&1
if errorlevel 1 if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BINARY=%LOCALAPPDATA%\Programs\nodejs\node.exe"
"%NODE_BINARY%" -e "process.exit(0)" >NUL 2>&1
if errorlevel 1 if exist "%USERPROFILE%\.volta\bin\node.exe" set "NODE_BINARY=%USERPROFILE%\.volta\bin\node.exe"
"%NODE_BINARY%" -e "if (Math.sign(Number(process.versions.node.split('.')[0]) - 22) === -1) process.exit(1)" >NUL 2>&1
if errorlevel 1 (
  echo MediaClaw Agent 本地源码启动需要 Node.js 22 或更高版本。请在豆包工作连接器中将 MEDIACLAW_AGENT_NODE 设为 node.exe 的绝对路径。 1>&2
  exit /b 1
)
if not defined MEDIACLAW_AGENT_CHANNEL set "MEDIACLAW_AGENT_CHANNEL=local"
if not defined MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK set "MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK=1"
set "MEDIACLAW_AGENT_SUPERVISED=1"
if not defined MEDIACLAW_AGENT_RUNTIME_VERSION set "MEDIACLAW_AGENT_RUNTIME_VERSION=0.4.0-beta.1-local.20261005.1"
if not defined MEDIACLAW_AGENT_LOCAL_RESTART_LIMIT set "MEDIACLAW_AGENT_LOCAL_RESTART_LIMIT=3"
if not defined MEDIACLAW_AGENT_LOCAL_RESTART_DELAY_SECONDS set "MEDIACLAW_AGENT_LOCAL_RESTART_DELAY_SECONDS=1"
set /a "ATTEMPT=0"
:run_local_adapter
"%NODE_BINARY%" "%SCRIPT_DIR%mcp-server.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" exit /b 0
set /a "ATTEMPT+=1"
if %ATTEMPT% GEQ %MEDIACLAW_AGENT_LOCAL_RESTART_LIMIT% exit /b %EXIT_CODE%
echo [mediaclaw] local Agent adapter exited unexpectedly; restarting (%ATTEMPT%/%MEDIACLAW_AGENT_LOCAL_RESTART_LIMIT%). 1>&2
timeout /t %MEDIACLAW_AGENT_LOCAL_RESTART_DELAY_SECONDS% /nobreak >NUL 2>&1
goto run_local_adapter
