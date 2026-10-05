import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const readJson = (...parts) =>
  JSON.parse(fs.readFileSync(path.join(projectRoot, ...parts), "utf8"));

const marketplace = readJson(".claude-plugin", "marketplace.json");
const plugin = readJson("plugins", "mediaclaw", ".claude-plugin", "plugin.json");
const codexPlugin = readJson("plugins", "mediaclaw", ".codex-plugin", "plugin.json");

test("Claude Code marketplace uses the shared marketplace name and plugin source", () => {
  // `claude plugin install mediaclaw@mediaclaw-agent` and the update plan depend on these names
  assert.equal(marketplace.name, "mediaclaw-agent");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "mediaclaw");
  assert.equal(marketplace.plugins[0].source, "./plugins/mediaclaw");
});

test("Claude Code plugin version stays in lockstep with the other hosts", () => {
  assert.equal(plugin.version, codexPlugin.version);
  assert.equal(marketplace.plugins[0].version, codexPlugin.version);
});

test("Claude Code plugin launches the shared adapter as the claude host", () => {
  assert.equal(plugin.name, "mediaclaw");
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.mcpServers, "./.mcp.claude.json");
  const mcpConfig = readJson("plugins", "mediaclaw", plugin.mcpServers);
  const server = mcpConfig.mcpServers.mediaclaw;
  assert.equal(server.command, "${CLAUDE_PLUGIN_ROOT}/scripts/launch-agent.cmd");
  assert.equal(
    Object.hasOwn(server, "cwd"),
    false,
    "Claude Code must resolve the launcher from the plugin root, not the session cwd",
  );
  assert.equal(server.env.MEDIACLAW_AGENT_HOST, "claude");
  assert.equal(server.env.MEDIACLAW_AGENT_DEVICE_NAME, "MediaClaw Agent (Claude Code)");
});

test("launchers keep the runtime in Claude Code's persistent plugin data directory", () => {
  const scripts = path.join(projectRoot, "plugins", "mediaclaw", "scripts");
  const posix = fs.readFileSync(path.join(scripts, "launch-agent"), "utf8");
  const windows = fs.readFileSync(path.join(scripts, "launch-agent.cmd"), "utf8");
  assert.match(posix, /CLAUDE_PLUGIN_DATA\/runtime\/\$RELEASE_VERSION/);
  assert.match(windows, /CLAUDE_PLUGIN_DATA%\\runtime\\%RELEASE_VERSION%/);
});
