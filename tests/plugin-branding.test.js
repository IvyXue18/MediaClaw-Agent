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
  assert.match(skill, /升级 Agent／升级社媒虾／升级到最新版/);
  assert.match(skill, /已安装并验版到哪个版本/);
  assert.match(skill, /完全退出状态中指定的 Codex／WorkBuddy/);
  assert.match(skill, /回到原对话发送“继续”/);
  assert.match(skill, /不得在旧进程里调用其他 MediaClaw 工具/);
  assert.match(skill, /已升级并激活到 \{activeVersion\}/);
  assert.match(skill, /continuation\.originalGoal/);
  assert.match(skill, /本会话状态改为 `dismissed`/);
});

test("analysis requests reuse assets before collection and keep workbench parity", () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills/mediaclaw-content-research/SKILL.md"),
    "utf8",
  );
  const adapter = fs.readFileSync(
    path.join(pluginRoot, "scripts/mcp-server.mjs"),
    "utf8",
  );
  const accountMethod = fs.readFileSync(
    path.join(
      pluginRoot,
      "skills/mediaclaw-content-research/references/account-content-strategy.md",
    ),
    "utf8",
  );
  const noteMethod = fs.readFileSync(
    path.join(
      pluginRoot,
      "skills/mediaclaw-content-research/references/single-note-breakdown.md",
    ),
    "utf8",
  );
  const methods = readJson("contracts/methods-v1.json");

  assert.match(
    skill,
    /local\.studio \+ account_analysis[\s\S]*remote\.workbench \+ account_analysis[\s\S]*local\.data_pool \+ capture_record/,
  );
  assert.match(
    skill,
    /local\.studio \+ note_breakdown[\s\S]*remote\.workbench \+ note_breakdown[\s\S]*local\.data_pool \+ capture_record/,
  );
  assert.match(skill, /已有分析直接复用/);
  assert.match(skill, /不得把 50 条基础作品变成 50 个详情页/);
  assert.match(accountMethod, /ACCOUNT_STYLE_ANALYSIS_PROMPT_VERSION=4\.2\.0/);
  assert.match(skill, /任何分析都必须先判断逐字稿是否会显著提升当前任务/);
  assert.match(skill, /逐字稿必要性判断默认偏向不新增提取/);
  assert.match(skill, /用户主动触发/);
  assert.match(skill, /Agent 主动触发/);
  assert.match(skill, /旧 Codex 任务消息/);
  assert.match(skill, /不得用来冒充已有报告或原始数据/);
  assert.match(accountMethod, /50 条基础作品、15 条代表详情和 12 个封面证据/);
  assert.match(accountMethod, /逐字稿必要性决定/);
  assert.match(accountMethod, /默认不新增提取/);
  assert.match(noteMethod, /视频文案/);
  assert.match(noteMethod, /Agent.*主动报价/);
  assert.match(adapter, /所有分析任务都必须先判断逐字稿是否会显著提升当前结论/);
  assert.match(adapter, /默认优先不新提取/);
  assert.match(noteMethod, /NOTE_BREAKDOWN_PROMPT_VERSION=1\.8\.0/);
  assert.match(noteMethod, /VIDEO_NOTE_BREAKDOWN_PROMPT_VERSION=1\.3\.1/);
  assert.equal(
    methods.methods.find((method) => method.id === "account-content-strategy-v1")
      .version,
    "2.0.0",
  );
  assert.equal(
    methods.methods.find((method) => method.id === "single-note-breakdown-v1")
      .version,
    "3.0.0",
  );
});
