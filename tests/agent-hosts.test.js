import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  agentHostDeviceDisplayName,
  agentHostDisplayName,
  agentHostSupportsAutomaticUpdate,
  detectAgentHostKey,
  isSupportedAgentHost,
  normalizeAgentHostKey,
  SUPPORTED_AGENT_HOST_KEYS,
} from "../plugins/mediaclaw/scripts/agent-hosts.mjs";

test("Agent hosts resolve canonical keys and retained aliases from one registry", () => {
  assert.deepEqual(SUPPORTED_AGENT_HOST_KEYS, [
    "codex",
    "workbuddy",
    "doubao-work",
  ]);
  assert.equal(normalizeAgentHostKey("codebuddy"), "workbuddy");
  assert.equal(normalizeAgentHostKey("doubao"), "doubao-work");
  assert.equal(normalizeAgentHostKey("doubao_work"), "doubao-work");
  assert.equal(normalizeAgentHostKey("claude-desktop"), "claude");
  assert.equal(isSupportedAgentHost("doubaowork"), true);
  assert.equal(isSupportedAgentHost("claude"), false);
});

test("Agent host registry owns user-facing identity and update capabilities", () => {
  assert.equal(agentHostDisplayName("doubao"), "豆包工作");
  assert.equal(
    agentHostDeviceDisplayName("doubao-work"),
    "MediaClaw Agent (豆包工作)",
  );
  assert.equal(agentHostSupportsAutomaticUpdate("codex"), true);
  assert.equal(agentHostSupportsAutomaticUpdate("workbuddy"), true);
  assert.equal(agentHostSupportsAutomaticUpdate("doubao-work"), false);
});

test("Agent host detection keeps explicit connector identity authoritative", () => {
  assert.equal(
    detectAgentHostKey({MEDIACLAW_AGENT_HOST: "doubao_work"}),
    "doubao-work",
  );
  assert.equal(detectAgentHostKey({CODEBUDDY_PLUGIN_ROOT: "/tmp/plugin"}), "workbuddy");
  assert.equal(detectAgentHostKey({}), "codex");
});

test("Doubao Work STDIO contract reuses the canonical cross-platform launcher", () => {
  const config = JSON.parse(
    fs.readFileSync(
      path.resolve("plugins/mediaclaw/.mcp.doubao-work.json"),
      "utf8",
    ),
  );
  const server = config.mcpServers.mediaclaw;
  assert.equal(server.command, "./scripts/launch-agent.cmd");
  assert.equal(server.cwd, ".");
  assert.equal(server.env.MEDIACLAW_AGENT_HOST, "doubao-work");
  assert.equal(
    server.env.MEDIACLAW_AGENT_DEVICE_NAME,
    "MediaClaw Agent (豆包工作)",
  );
});

test("Doubao Work local STDIO contract runs the current Agent source tree", () => {
  const config = JSON.parse(
    fs.readFileSync(
      path.resolve("plugins/mediaclaw/.mcp.doubao-work.local.json"),
      "utf8",
    ),
  );
  const server = config.mcpServers.mediaclaw;
  assert.equal(server.command, "./scripts/launch-agent-local.cmd");
  assert.equal(server.cwd, ".");
  assert.equal(server.env.MEDIACLAW_AGENT_HOST, "doubao-work");
  assert.equal(server.env.MEDIACLAW_AGENT_CHANNEL, "local");

  const launcher = path.resolve(
    "plugins/mediaclaw/scripts/launch-agent-local.cmd",
  );
  assert.equal(fs.existsSync(launcher), true);
  assert.match(
    fs.readFileSync(launcher, "utf8"),
    /mcp-server\.mjs/,
  );
});
