import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const pluginRoot = path.join(projectRoot, "plugins", "mediaclaw");
const logoPath = path.join(pluginRoot, "assets", "logo.png");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, relativePath), "utf8"));
}

test("MediaClaw host surfaces share the canonical MC logo", () => {
  const codexPlugin = readJson(".codex-plugin/plugin.json");
  const workbuddySkillMeta = readJson(
    "skills/mediaclaw-content-research/_user_meta.json",
  );

  assert.equal(fs.existsSync(logoPath), true);
  assert.equal(codexPlugin.interface.composerIcon, "./assets/logo.png");
  assert.equal(codexPlugin.interface.logo, "./assets/logo.png");
  assert.equal(workbuddySkillMeta.iconSource, "https://mediaclaw.app/logo.png");
});

test("V0.3 only publishes Codex and WorkBuddy entry points", () => {
  assert.equal(fs.existsSync(path.join(projectRoot, ".claude-plugin")), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, ".claude-plugin")), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, ".mcp.claude.json")), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, "manifest.json")), false);
});
