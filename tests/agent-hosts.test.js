import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import {execFileSync} from "node:child_process";
import {loadOrCreateDeviceIdentity} from "../plugins/mediaclaw/scripts/device-identity.mjs";
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
    "claude",
    "grok-build",
    "grok-bot",
  ]);
  assert.equal(normalizeAgentHostKey("codebuddy"), "workbuddy");
  assert.equal(normalizeAgentHostKey("doubao"), "doubao-work");
  assert.equal(normalizeAgentHostKey("doubao_work"), "doubao-work");
  assert.equal(isSupportedAgentHost("doubaowork"), true);
  assert.equal(normalizeAgentHostKey("claude-desktop"), "claude");
  assert.equal(normalizeAgentHostKey("claude_code"), "claude");
  assert.equal(normalizeAgentHostKey("claude-cowork"), "claude");
  assert.equal(isSupportedAgentHost("claude"), true);
  assert.equal(isSupportedAgentHost("claude-code"), true);
  assert.equal(normalizeAgentHostKey("grok"), "grok-build");
  assert.equal(normalizeAgentHostKey("grok_build"), "grok-build");
  assert.equal(normalizeAgentHostKey("grok_bot"), "grok-bot");
  assert.equal(normalizeAgentHostKey("GrokBot"), "grok-bot");
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
  assert.equal(agentHostSupportsAutomaticUpdate("claude"), true);
  assert.equal(agentHostDisplayName("claude-code"), "Claude Code");
  assert.equal(
    agentHostDeviceDisplayName("claude"),
    "MediaClaw Agent (Claude Code)",
  );
  // Grok hosts run a cloned launcher without a plugin manager, so no automatic update.
  assert.equal(agentHostSupportsAutomaticUpdate("grok-build"), false);
  assert.equal(agentHostSupportsAutomaticUpdate("grok-bot"), false);
  assert.equal(agentHostDisplayName("grok"), "Grok Build");
  assert.equal(agentHostDisplayName("grok-bot"), "Grok Bot");
  assert.equal(agentHostDeviceDisplayName("grok-build"), "MediaClaw Agent (Grok Build)");
  assert.equal(agentHostDeviceDisplayName("grok-bot"), "MediaClaw Agent (Grok Bot 云电脑)");
});

test("Agent host detection keeps explicit connector identity authoritative", () => {
  assert.equal(
    detectAgentHostKey({MEDIACLAW_AGENT_HOST: "doubao_work"}),
    "doubao-work",
  );
  assert.equal(detectAgentHostKey({CODEBUDDY_PLUGIN_ROOT: "/tmp/plugin"}), "workbuddy");
  assert.equal(detectAgentHostKey({CLAUDECODE: "1"}), "claude");
  assert.equal(
    detectAgentHostKey({MEDIACLAW_AGENT_HOST: "claude-code", CLAUDECODE: "1"}),
    "claude",
  );
  assert.equal(detectAgentHostKey({MEDIACLAW_AGENT_HOST: "grok-bot", CLAUDECODE: "1"}), "grok-bot");
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

const unsupportedHosts = ["cursor", "future-agent", "grok-desktop"];

test("unsupported host keys cannot resolve to a supported host or updater", () => {
  for (const host of unsupportedHosts) {
    assert.equal(normalizeAgentHostKey(host), host);
    assert.equal(isSupportedAgentHost(host), false);
    assert.equal(agentHostSupportsAutomaticUpdate(host), false);
    assert.equal(detectAgentHostKey({MEDIACLAW_AGENT_HOST: host}), host);
  }
});

test("unsupported hosts cannot create or reuse a persisted device identity", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mediaclaw-unsupported-host-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const stateDirectory = path.join(directory, "identity");
  for (const host of unsupportedHosts) {
    await assert.rejects(loadOrCreateDeviceIdentity({stateDirectory, host}), /Unsupported MediaClaw Agent host/);
  }
  assert.equal(fs.existsSync(stateDirectory), false);
  await loadOrCreateDeviceIdentity({stateDirectory, host: "codex"});
  const identityPath = path.join(stateDirectory, "device-identity.json");
  const original = fs.readFileSync(identityPath, "utf8");
  await assert.rejects(loadOrCreateDeviceIdentity({stateDirectory, host: "cursor"}), /Unsupported MediaClaw Agent host/);
  assert.equal(fs.readFileSync(identityPath, "utf8"), original);
});

test("Adapter startup rejects an unsupported explicit host", () => {
  assert.throws(() => execFileSync(process.execPath, [path.resolve("plugins/mediaclaw/scripts/mcp-server.mjs")], {
    env: {...process.env, MEDIACLAW_AGENT_HOST: "cursor"},
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3000,
  }), (error) => {
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /MediaClaw Agent only supports: codex, workbuddy, doubao-work, claude, grok-build, grok-bot/);
    return true;
  });
});
