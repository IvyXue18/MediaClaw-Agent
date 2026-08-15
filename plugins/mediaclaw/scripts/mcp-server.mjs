#!/usr/bin/env node

import crypto from "node:crypto";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createAgentUpdateChecker} from "./agent-update.mjs";

const SERVER_NAME = "mediaclaw-agent-adapter";
const SERVER_VERSION = "0.3.0-rc.1";
const logoPath = globalThis.Bun
  ? (await import("../assets/logo.png", {with: {type: "file"}})).default
  : fileURLToPath(new URL("../assets/logo.png", import.meta.url));
const SERVER_ICONS = [
  {
    src: `data:image/png;base64,${readFileSync(logoPath).toString("base64")}`,
    mimeType: "image/png",
    sizes: ["128x128"],
  },
];
const PROTOCOL_VERSION = "3";
const BROKER_PORT = Number(process.env.MEDIACLAW_AGENT_PORT || 17373);
const BROKER_ORIGIN = `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_START_TIMEOUT_MS = 10_000;
const BROKER_CALL_TIMEOUT_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const instanceId = `adapter_${crypto.randomUUID()}`;
const brokerPath = fileURLToPath(new URL("./broker-server.mjs", import.meta.url));
const standaloneRuntime = process.env.MEDIACLAW_AGENT_STANDALONE === "1";

function normalizeHostKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (
    ["claude", "claude-code", "claude-desktop", "claude-cowork"].includes(
      normalized,
    )
  ) {
    return "claude";
  }
  return normalized;
}

function detectHostKey() {
  const explicit = normalizeHostKey(process.env.MEDIACLAW_AGENT_HOST);
  if (explicit) return explicit;
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return "claude";
  }
  if (process.env.WORKBUDDY_HOME || process.env.WORKBUDDY_HOST) {
    return "workbuddy";
  }
  if (process.env.CODEBUDDY_PLUGIN_ROOT || process.env.CODEBUDDY_CONFIG_DIR) {
    return "workbuddy";
  }
  return "codex";
}

function hostDisplayName(hostKey) {
  const explicit = String(process.env.MEDIACLAW_AGENT_DEVICE_NAME || "").trim();
  if (explicit) return explicit;
  if (hostKey === "codex") return "MediaClaw Agent (Codex)";
  if (hostKey === "claude") return "MediaClaw Agent (Claude)";
  if (hostKey === "workbuddy") return "MediaClaw Agent (WorkBuddy)";
  return `MediaClaw Agent (${hostKey})`;
}

const hostKey = detectHostKey();
if (!["codex", "workbuddy"].includes(hostKey)) {
  throw new Error("MediaClaw Agent V0.3 only supports Codex and WorkBuddy");
}
const displayName = hostDisplayName(hostKey);
const agentUpdateChecker = createAgentUpdateChecker({
  currentVersion: SERVER_VERSION,
  hostKey,
});
const initialAgentUpdateCheck = agentUpdateChecker.check();
let adapterToken = "";
let registration = null;
let registrationPromise = null;
let heartbeatTimer = null;
let stopping = false;
let lastRegistrationError = "";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(pathname, payload, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BROKER_ORIGIN}${pathname}`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        body?.error?.message || `Broker returned HTTP ${response.status}`,
      );
      error.code = body?.error?.code || "BROKER_HTTP_ERROR";
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function brokerHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${BROKER_ORIGIN}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === "mediaclaw-agent-broker";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureBroker() {
  if (await brokerHealth()) return;
  const child = spawn(
    process.execPath,
    standaloneRuntime ? ["--broker"] : [brokerPath],
    {
    detached: true,
    stdio: "ignore",
    env: {...process.env},
    },
  );
  child.unref();
  const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await brokerHealth()) return;
    await delay(100);
  }
  throw new Error("MediaClaw Broker 启动超时，请检查本机端口 17373");
}

async function registerAdapter() {
  if (adapterToken && registration) return registration;
  if (registrationPromise) return registrationPromise;
  registrationPromise = (async () => {
    await ensureBroker();
    const registrationPayload = {
      hostKey,
      displayName,
      adapterVersion: SERVER_VERSION,
      instanceId,
    };
    try {
      registration = await fetchJson(
        "/v1/adapters/register",
        registrationPayload,
      );
    } catch (error) {
      if (error?.code !== "BROKER_RESTART_REQUIRED") throw error;
      const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
      while (Date.now() < deadline && (await brokerHealth())) {
        await delay(100);
      }
      await ensureBroker();
      registration = await fetchJson(
        "/v1/adapters/register",
        registrationPayload,
      );
    }
    adapterToken = String(registration.token || "");
    if (!adapterToken) throw new Error("MediaClaw Broker 未返回 Adapter 会话");
    lastRegistrationError = "";
    return registration;
  })();
  try {
    return await registrationPromise;
  } finally {
    registrationPromise = null;
  }
}

function reportRegistrationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === lastRegistrationError) return;
  lastRegistrationError = message;
  process.stderr.write(
    `[mediaclaw] ${hostKey} 等待连接本机 Broker：${message}\n`,
  );
}

async function callBroker(method, params = {}) {
  if (!adapterToken) await registerAdapter();
  try {
    return await fetchJson(
      "/v1/mcp",
      {token: adapterToken, method, params},
      method === "tools/call" ? BROKER_CALL_TIMEOUT_MS : 30_000,
    );
  } catch (error) {
    if (error?.code !== "ADAPTER_AUTH_REQUIRED") throw error;
    await registerAdapter();
    return await fetchJson(
      "/v1/mcp",
      {token: adapterToken, method, params},
      method === "tools/call" ? BROKER_CALL_TIMEOUT_MS : 30_000,
    );
  }
}

function writeMessage(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeResult(id, result) {
  writeMessage({jsonrpc: "2.0", id, result});
}

function writeError(id, code, message, data = undefined) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {code, message, ...(data === undefined ? {} : {data})},
  });
}

function isConnectionStatusCall(message) {
  return (
    message?.method === "tools/call" &&
    message?.params?.name === "mediaclaw_connection_status"
  );
}

async function attachAgentUpdate(result) {
  if (!result?.structuredContent) return result;
  const structuredContent = {
    ...result.structuredContent,
    agentUpdate: await initialAgentUpdateCheck,
  };
  return {
    ...result,
    structuredContent,
    content: Array.isArray(result.content)
      ? result.content.map((item) =>
          item?.type === "text"
            ? {...item, text: JSON.stringify(structuredContent, null, 2)}
            : item,
        )
      : result.content,
  };
}

async function handleRequest(message) {
  if (!message || typeof message !== "object") return;
  if (message.method === "notifications/initialized") return;
  if (message.id === undefined || message.id === null) return;
  try {
    if (message.method === "initialize") {
      writeResult(message.id, {
        protocolVersion: message.params?.protocolVersion || "2025-11-25",
        capabilities: {tools: {listChanged: false}},
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          icons: SERVER_ICONS,
        },
        instructions:
          "先调用 mediaclaw_connection_status 检查连接和 Agent 版本。agentUpdate.status=update_available 时，必须先取得用户明确授权，再按返回的固定升级计划刷新 marketplace、验证版本，并创建加载新版的新任务继续原请求；当前任务不能热加载新版。MediaClaw 浏览器插件负责真实读取、采集、会员、积分和人工确认；当前 Agent 负责按 Skill 分析和生成。视频逐字稿必须先报价，取得用户明确同意后才能确认；V0.3 不支持 BYOK 或本地转录。",
      });
      return;
    }
    if (message.method === "ping") {
      writeResult(message.id, {});
      return;
    }
    let result = await callBroker(message.method, message.params || {});
    if (isConnectionStatusCall(message)) {
      result = await attachAgentUpdate(result);
    }
    if (result?.error && Number.isFinite(Number(result.error.code))) {
      writeError(
        message.id,
        Number(result.error.code),
        String(result.error.message || "MediaClaw Broker request failed"),
        result.error.data,
      );
      return;
    }
    writeResult(message.id, result);
  } catch (error) {
    writeError(
      message.id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

let inputBuffer = Buffer.alloc(0);

function consumeInput() {
  while (inputBuffer.length > 0) {
    const asText = inputBuffer.toString("utf8");
    if (/^content-length:/i.test(asText)) {
      const headerEnd = inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = inputBuffer.subarray(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        inputBuffer = inputBuffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (inputBuffer.length < end) return;
      const body = inputBuffer.subarray(start, end).toString("utf8");
      inputBuffer = inputBuffer.subarray(end);
      try {
        void handleRequest(JSON.parse(body));
      } catch {
        // Ignore malformed input.
      }
      continue;
    }
    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) return;
    const line = inputBuffer.subarray(0, newline).toString("utf8").trim();
    inputBuffer = inputBuffer.subarray(newline + 1);
    if (!line) continue;
    try {
      void handleRequest(JSON.parse(line));
    } catch {
      // Ignore malformed input.
    }
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (adapterToken) {
    await fetchJson(
      "/v1/adapters/unregister",
      {token: adapterToken},
      1_000,
    ).catch(() => null);
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
  consumeInput();
});
process.stdin.on("end", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});

await registerAdapter().catch(reportRegistrationError);
heartbeatTimer = setInterval(() => {
  if (!adapterToken) {
    void registerAdapter().catch(reportRegistrationError);
    return;
  }
  void fetchJson("/v1/adapters/heartbeat", {token: adapterToken}, 2_000).catch(
    (error) => {
      adapterToken = "";
      reportRegistrationError(error);
    },
  );
}, Math.min(HEARTBEAT_INTERVAL_MS, 5_000));
heartbeatTimer.unref?.();
if (adapterToken) {
  process.stderr.write(
    `[mediaclaw] ${hostKey} Adapter connected to shared Broker on 127.0.0.1:${BROKER_PORT}\n`,
  );
}
