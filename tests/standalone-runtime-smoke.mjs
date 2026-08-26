import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json" with {type: "json"};

const binary = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "standalone runtime path is required");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBrokerHealth(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json();
      if (response.ok && body?.service === "mediaclaw-agent-broker") {
        return body;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `standalone Broker health check timed out: ${lastError?.message || "no response"}`,
  );
}

async function waitForBrokerShutdown(port, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      return;
    }
    await delay(50);
  }
  throw new Error("standalone Broker did not exit after the Adapter stopped");
}

async function expectOversizedBridgeRequestRejected(port) {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/adapters/register`,
    {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        hostKey: "codex",
        padding: "x".repeat(1024 * 1024),
      }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.match(String(body.error || ""), /body is too large/);
}

async function waitForBrokerHandshake(port, timeoutMs = 5_000) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    let hello = null;
    let adapterDevice = null;
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new Error(
          `standalone Broker WebSocket handshake timed out: ${JSON.stringify({hello, adapterDevice})}`,
        ),
      );
    }, timeoutMs);
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === "broker.hello") {
          hello = message;
          adapterDevice = message.devices?.find(
            (device) => device.host === "codex",
          ) || adapterDevice;
        } else if (
          message?.type === "device.hello" &&
          message.device?.host === "codex"
        ) {
          adapterDevice = message.device;
        }
        if (!hello || !adapterDevice) return;
        clearTimeout(timer);
        socket.addEventListener(
          "close",
          () => resolve({hello, adapterDevice}),
          {once: true},
        );
        socket.close();
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(
        new Error(
          `standalone Broker WebSocket failed: ${event.message || "connection error"}`,
        ),
      );
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
}

const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "mediaclaw-agent-smoke-"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const child = spawn(binary, [], {
  env: {
    ...process.env,
    MEDIACLAW_AGENT_BROKER_IDLE_MS: "500",
    MEDIACLAW_AGENT_ADAPTER_SWEEP_MS: "100",
    MEDIACLAW_AGENT_ADAPTER_TTL_MS: "500",
    MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK: "1",
    MEDIACLAW_AGENT_HOST: "codex",
    MEDIACLAW_AGENT_PORT: String(port),
    MEDIACLAW_AGENT_STANDALONE: "1",
    MEDIACLAW_AGENT_STATE_DIR: stateDirectory,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {protocolVersion: "2025-11-25"},
  })}\n`);

  const deadline = Date.now() + 15_000;
  let response = null;
  while (Date.now() < deadline && !response) {
    response = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .find((message) => message?.id === 1) || null;
    if (!response) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(response, `standalone runtime did not initialize: ${stderr}`);
  assert.equal(response.result?.serverInfo?.version, packageJson.version);
  assert.match(response.result?.serverInfo?.icons?.[0]?.src || "", /^data:image\/png;base64,/);
  const health = await waitForBrokerHealth(port);
  assert.equal(health.websocketPath, "/extension");
  await expectOversizedBridgeRequestRejected(port);
  const {hello, adapterDevice} = await waitForBrokerHandshake(port);
  assert.equal(hello.serverVersion, response.result.serverInfo.version);
  assert.equal(hello.protocolVersion, "3");
  assert.equal(adapterDevice.host, "codex");
  console.log("Standalone runtime MCP and WebSocket smoke test passed.");
} finally {
  await stopChild(child);
  await waitForBrokerShutdown(port);
  await rm(stateDirectory, {recursive: true, force: true});
}
