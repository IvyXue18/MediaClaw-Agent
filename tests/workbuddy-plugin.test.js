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
  assert.equal(
    server.command,
    "${CODEBUDDY_PLUGIN_ROOT}/scripts/launch-agent.cmd",
  );
  assert.equal(Object.hasOwn(server, "args"), false);
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
  assert.equal(server.command, "./scripts/launch-agent.cmd");
  assert.equal(server.cwd, ".");
  assert.equal(Object.hasOwn(server, "args"), false);
  assert.equal(
    Object.hasOwn(server, "env"),
    false,
    "the inline definition must detect WorkBuddy instead of forcing Codex",
  );
});

test("the marketplace ships native launchers for POSIX and Windows hosts", () => {
  const scripts = path.join(projectRoot, "plugins", "mediaclaw", "scripts");
  const posixLauncher = path.join(scripts, "launch-agent");
  const windowsLauncher = path.join(scripts, "launch-agent.cmd");
  assert.equal(fs.existsSync(posixLauncher), true);
  assert.equal(fs.existsSync(windowsLauncher), true);
  assert.match(fs.readFileSync(posixLauncher, "utf8"), /PLUGIN_DATA/);
  assert.match(fs.readFileSync(posixLauncher, "utf8"), /Linux-aarch64/);
  assert.match(fs.readFileSync(posixLauncher, "utf8"), /linux-arm64-musl/);
  assert.match(fs.readFileSync(windowsLauncher, "utf8"), /windows-arm64\.exe/);
  assert.match(fs.readFileSync(windowsLauncher, "utf8"), /Get-FileHash/);
  assert.match(
    fs.readFileSync(windowsLauncher, "utf8"),
    /^:; .*exec .*launch-agent/,
    "the shared .cmd launcher must begin with a line that POSIX executes and cmd.exe treats as a label",
  );
});
