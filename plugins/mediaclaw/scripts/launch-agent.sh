#!/usr/bin/env bash

set -euo pipefail

RELEASE_VERSION="v0.3.0-rc.1"
REPOSITORY="IvyXue18/MediaClaw-Agent"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 22 ]; then
    exec node "$SCRIPT_DIR/mcp-server.mjs"
  fi
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET="mediaclaw-agent-darwin-arm64" ;;
  Darwin-x86_64) ASSET="mediaclaw-agent-darwin-x64" ;;
  Linux-x86_64) ASSET="mediaclaw-agent-linux-x64" ;;
  Linux-aarch64|Linux-arm64) ASSET="mediaclaw-agent-linux-arm64" ;;
  *)
    echo "MediaClaw Agent 暂不支持当前系统：$(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

STATE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/mediaclaw-agent/runtime/$RELEASE_VERSION"
BINARY="$STATE_ROOT/$ASSET"
CHECKSUMS="$STATE_ROOT/checksums.txt"
BASE_URL="https://github.com/$REPOSITORY/releases/download/$RELEASE_VERSION"
mkdir -p "$STATE_ROOT"

if [ ! -x "$BINARY" ]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "MediaClaw Agent 首次安装需要 curl 下载官方运行时。" >&2
    exit 1
  fi
  echo "MediaClaw Agent 正在下载首次运行所需的官方组件……" >&2
  trap 'rm -f "$BINARY.tmp" "$CHECKSUMS.tmp"' EXIT
  curl --fail --location --silent --show-error \
    "$BASE_URL/$ASSET" --output "$BINARY.tmp"
  curl --fail --location --silent --show-error \
    "$BASE_URL/checksums.txt" --output "$CHECKSUMS.tmp"
  mv "$CHECKSUMS.tmp" "$CHECKSUMS"
  EXPECTED="$(awk -v name="$ASSET" '$2 == name {print $1}' "$CHECKSUMS")"
  if [ -z "$EXPECTED" ]; then
    echo "MediaClaw Agent 发布包缺少 $ASSET 的校验值。" >&2
    exit 1
  fi
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$BINARY.tmp" | awk '{print $1}')"
  else
    ACTUAL="$(sha256sum "$BINARY.tmp" | awk '{print $1}')"
  fi
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "MediaClaw Agent 运行时校验失败，已拒绝启动。" >&2
    rm -f "$BINARY.tmp"
    exit 1
  fi
  mv "$BINARY.tmp" "$BINARY"
  chmod 0755 "$BINARY"
  trap - EXIT
  echo "MediaClaw Agent 官方组件已校验，正在建立本机连接。" >&2
fi

export MEDIACLAW_AGENT_STANDALONE=1
exec "$BINARY"
