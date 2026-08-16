import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binary = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "standalone runtime path is required");

const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "mediaclaw-agent-smoke-"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const child = spawn(binary, [], {
  env: {
    ...process.env,
    MEDIACLAW_AGENT_BROKER_IDLE_MS: "500",
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
  assert.equal(response.result?.serverInfo?.version, "0.3.0-rc.2");
  assert.match(response.result?.serverInfo?.icons?.[0]?.src || "", /^data:image\/png;base64,/);
  console.log("Standalone runtime smoke test passed.");
} finally {
  child.kill("SIGTERM");
  await rm(stateDirectory, {recursive: true, force: true});
}
