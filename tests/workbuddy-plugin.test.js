import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const marketplace = JSON.parse(
  fs.readFileSync(
    path.join(projectRoot, ".codebuddy-plugin", "marketplace.json"),
    "utf8",
  ),
);
const plugin = JSON.parse(
  fs.readFileSync(
    path.join(
      projectRoot,
      "plugins",
      "mediaclaw",
      ".codebuddy-plugin",
      "plugin.json",
    ),
    "utf8",
  ),
);

test("WorkBuddy marketplace points to the shared MediaClaw plugin", () => {
  assert.ok(["mediaclaw-local", "mediaclaw-agent"].includes(marketplace.name));
  assert.equal(marketplace.plugins[0].name, "mediaclaw");
  assert.equal(marketplace.plugins[0].source, "./plugins/mediaclaw");
});

test("WorkBuddy plugin launches the shared adapter with an independent host", () => {
  assert.equal(plugin.mcpServers, "./.mcp.workbuddy.json");
  const mcpConfig = JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, "plugins", "mediaclaw", plugin.mcpServers),
      "utf8",
    ),
  );
  const server = mcpConfig.mcpServers.mediaclaw;
  assert.equal(server.command, "/bin/bash");
  assert.deepEqual(server.args, [
    "-lc",
    'exec "${CODEBUDDY_PLUGIN_ROOT}/scripts/launch-agent.sh"',
  ]);
  assert.equal(
    Object.hasOwn(server, "cwd"),
    false,
    "WorkBuddy must not resolve the launcher relative to the conversation cwd",
  );
  assert.equal(server.env.MEDIACLAW_AGENT_HOST, "workbuddy");
  assert.equal(
    server.env.MEDIACLAW_AGENT_DEVICE_NAME,
    "MediaClaw Agent (WorkBuddy)",
  );
  assert.equal(plugin.skills, "./skills/");
});

test("WorkBuddy inline discovery keeps the shared MCP definition host-neutral", () => {
  const mcpConfig = JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, "plugins", "mediaclaw", ".mcp.json"),
      "utf8",
    ),
  );
  const server = mcpConfig.mcpServers.mediaclaw;
  assert.equal(server.command, "/bin/bash");
  assert.equal(server.args[0], "-lc");
  assert.match(server.args[1], /CODEBUDDY_PLUGIN_ROOT/);
  assert.match(server.args[1], /CODEX_PLUGIN_ROOT/);
  assert.match(server.args[1], /scripts\/launch-agent\.sh/);
  assert.equal(
    Object.hasOwn(server, "env"),
    false,
    "the inline definition must detect WorkBuddy instead of forcing Codex",
  );
});
