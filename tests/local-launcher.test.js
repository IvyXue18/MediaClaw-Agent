import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function findAdapterChildPid(parentPid) {
  const {stdout} = await execFileAsync("pgrep", [
    "-P",
    String(parentPid),
    "-f",
    "mcp-server.mjs",
  ]);
  return Number(String(stdout).trim().split(/\s+/)[0]);
}

function createMessageReader(stream) {
  let buffer = "";
  const messages = [];
  const waiters = new Set();

  function flush() {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // Diagnostics belong on stderr; ignore non-protocol stdout defensively.
        }
      }
      newline = buffer.indexOf("\n");
    }
    for (const waiter of waiters) waiter();
  }

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    flush();
  });

  return {
    async waitFor(predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = messages.find(predicate);
        if (match) return match;
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(wake);
            resolve();
          }, 50);
          const wake = () => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
        });
      }
      return null;
    },
  };
}

test("Doubao Work local launcher starts outside the repository without a configured working directory", {timeout: 25_000}, async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "mediaclaw-doubao-local-"),
  );
  const pluginRoot = path.resolve("plugins/mediaclaw");
  const launcher = path.join(pluginRoot, "scripts", "launch-agent-local.cmd");
  const command = process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : launcher;
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", launcher]
    : [];
  const child = spawn(command, args, {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      MEDIACLAW_AGENT_NODE: process.execPath,
      MEDIACLAW_AGENT_ADAPTER_SWEEP_MS: "100",
      MEDIACLAW_AGENT_ADAPTER_TTL_MS: "300",
      MEDIACLAW_AGENT_BROKER_IDLE_MS: "300",
      MEDIACLAW_AGENT_CHANNEL: "local",
      MEDIACLAW_AGENT_DEVICE_NAME: "MediaClaw Agent (豆包工作)",
      MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK: "1",
      MEDIACLAW_AGENT_HOST: "doubao-work",
      MEDIACLAW_AGENT_LOCAL_RESTART_DELAY_SECONDS: "0.05",
      MEDIACLAW_AGENT_PORT: String(30_000 + Math.floor(Math.random() * 10_000)),
      MEDIACLAW_AGENT_STATE_DIR: path.join(temporaryRoot, "state"),
      PATH: process.platform === "win32"
        ? String(process.env.SystemRoot || "C:\\Windows")
        : "/usr/bin:/bin",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createMessageReader(child.stdout);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {protocolVersion: "2025-11-25"},
    })}\n`);
    const initialized = await reader.waitFor((message) => message?.id === 1);
    assert.ok(initialized, `local launcher did not initialize: ${stderr}`);
    assert.equal(initialized.result?.serverInfo?.name, "mediaclaw-agent-adapter");
    assert.equal(initialized.result?.serverInfo?.version, "0.4.0-beta.1-local.20261005.1");

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })}\n`);
    const tools = await reader.waitFor((message) => message?.id === 2);
    assert.ok(tools, `local launcher did not list tools: ${stderr}`);
    assert.equal(
      tools.result?.tools?.some(
        (tool) => tool?.name === "mediaclaw_connection_status",
      ),
      true,
    );

    if (process.platform !== "win32") {
      const adapterPid = await findAdapterChildPid(child.pid);
      assert.equal(Number.isInteger(adapterPid), true);
      process.kill(adapterPid, "SIGTERM");

      const restartDeadline = Date.now() + 5_000;
      while (
        !stderr.includes("local Agent adapter exited unexpectedly; restarting") &&
        Date.now() < restartDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(
        stderr,
        /local Agent adapter exited unexpectedly; restarting/,
      );

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {protocolVersion: "2025-11-25"},
      })}\n`);
      const reinitialized = await reader.waitFor(
        (message) => message?.id === 3,
      );
      assert.ok(
        reinitialized,
        `local launcher did not recover after adapter exit: ${stderr}`,
      );
      assert.equal(
        reinitialized.result?.serverInfo?.name,
        "mediaclaw-agent-adapter",
      );
    }
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});
