import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";

function waitForText(stream, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}; output=${text}`));
    }, timeoutMs);
    function onData(chunk) {
      text += chunk.toString("utf8");
      if (!pattern.test(text)) return;
      cleanup();
      resolve(text);
    }
    function cleanup() {
      clearTimeout(timer);
      stream.off("data", onData);
    }
    stream.on("data", onData);
  });
}

test("a newer Adapter makes an older shared Broker exit for replacement", async (t) => {
  const port = 20000 + Math.floor(Math.random() * 1000);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "mediaclaw-broker-upgrade-"),
  );
  t.after(() => rm(stateDirectory, {recursive: true, force: true}));
  const broker = spawn(
    process.execPath,
    [path.resolve("plugins/mediaclaw/scripts/broker-server.mjs")],
    {
      env: {
        ...process.env,
        MEDIACLAW_AGENT_PORT: String(port),
        MEDIACLAW_AGENT_STATE_DIR: stateDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => broker.kill("SIGTERM"));
  await waitForText(broker.stderr, /shared Agent Broker listening/);

  const exited = new Promise((resolve) => broker.once("exit", resolve));
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/adapters/register`,
    {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        hostKey: "codex",
        displayName: "Future MediaClaw Agent",
        adapterVersion: "0.3.2",
        instanceId: "future-adapter",
      }),
    },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.restartRequired, true);
  assert.equal(body.error.code, "BROKER_RESTART_REQUIRED");
  assert.equal(body.brokerVersion, "0.3.1");
  assert.equal(body.adapterVersion, "0.3.2");

  const exitCode = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Broker did not exit for upgrade")), 2_000),
    ),
  ]);
  assert.equal(exitCode, 0);
});
