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

test("all supported Agent hosts inherit the broad default MediaClaw trigger", () => {
  const codexPlugin = readJson(".codex-plugin/plugin.json");
  const workbuddyPlugin = readJson(".codebuddy-plugin/plugin.json");
  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills/mediaclaw-content-research/SKILL.md"),
    "utf8",
  );
  const adapter = fs.readFileSync(
    path.join(pluginRoot, "scripts/mcp-server.mjs"),
    "utf8",
  );

  for (const description of [
    codexPlugin.description,
    workbuddyPlugin.description,
    skill,
    adapter,
  ]) {
    assert.match(description, /content|内容/);
    assert.match(description, /topic|选题/);
    assert.match(description, /rewrit|改写/);
    assert.match(description, /explicit|明确/);
  }
  assert.match(skill, /even when the user does not mention MediaClaw/);
  assert.match(skill, /不得把“用户没有点名 MediaClaw”解释为拒绝调用/);
  assert.match(skill, /第一次工具调用前用一句自然语言说明/);
  assert.match(skill, /每 2～3 秒复查，最多 3 次/);
});

test("Agent update instructions use the orchestrator and preserve host continuation", () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills/mediaclaw-content-research/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /mediaclaw_manage_agent_update/);
  assert.match(skill, /decision=approve/);
  assert.match(skill, /decision=reject/);
  assert.match(skill, /不得向用户展示或要求用户执行任何终端/);
  assert.match(skill, /oldSessionFenced=true/);
  assert.match(skill, /完全重新打开当前宿主/);
  assert.match(skill, /不得在同一宿主进程里创建新任务/);
  assert.match(skill, /continuation\.originalGoal/);
  assert.match(skill, /本会话状态改为 `dismissed`/);
});
