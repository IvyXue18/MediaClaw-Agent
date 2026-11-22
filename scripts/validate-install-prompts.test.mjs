import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {SUPPORTED_AGENT_HOST_KEYS, agentHostDeviceDisplayName} from "../plugins/mediaclaw/scripts/agent-hosts.mjs";
import {INSTALL_PROMPT_PATH, INSTALL_PROMPT_PURPOSES, INSTALL_PROMPT_MAX_BYTES, validateInstallPrompts} from "./validate-install-prompts.mjs";

const catalog = JSON.parse(readFileSync(INSTALL_PROMPT_PATH, "utf8"));
const contract = JSON.parse(readFileSync(new URL("../plugins/mediaclaw/contracts/mcp-v1.json", import.meta.url), "utf8"));
const mutate = (edit) => { const result = structuredClone(catalog); edit(result); return result; };
const forPurposes = (host, check) => {
  for (const purpose of INSTALL_PROMPT_PURPOSES) check(catalog.hosts[host][purpose], purpose);
};

test("the single catalog supports the runtime's eight hosts and all three purposes", () => {
  assert.deepEqual(Object.keys(catalog.hosts), SUPPORTED_AGENT_HOST_KEYS);
  assert.equal(SUPPORTED_AGENT_HOST_KEYS.length, 8);
  assert.deepEqual(validateInstallPrompts(catalog, {expectedAgentVersion: contract.serverVersion}), []);
});

test("malformed and incomplete remote catalogs fail validation", () => {
  for (const value of [null, [], {}, {schemaVersion: 1}]) assert.ok(validateInstallPrompts(value).length);
  const mutations = [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.revision = "latest"; },
    (value) => { value.publishedAt = "yesterday"; },
    (value) => { value.agentVersion = "0.4.0-local.1"; },
    (value) => { value.extensionCompatibility.maxVersion = "0.3.1"; },
    (value) => { value.documentationUrl = "https://example.com/install"; },
    (value) => { delete value.hosts.cursor; },
    (value) => { value.hosts.unknown = value.hosts.codex; },
    (value) => { delete value.hosts.workbuddy.repair; },
    (value) => { value.hosts.workbuddy.upgrade = ""; },
  ];
  for (const edit of mutations) assert.ok(validateInstallPrompts(mutate(edit)).length);
  assert.ok(validateInstallPrompts(catalog, {expectedAgentVersion: "9.0.0"}).length);
});

test("every prompt offers the same-version domestic package when GitHub is unreachable", () => {
  for (const host of SUPPORTED_AGENT_HOST_KEYS) {
    forPurposes(host, (prompt) => {
      assert.match(prompt, new RegExp(`media\\.mediaclaw\\.app/agent/package/v${catalog.agentVersion.replaceAll(".", "\\.")}/MediaClaw-Agent\\.zip\\.sha256`));
      assert.match(prompt, /不需要 VPN/);
    });
  }
  const withoutMirror = mutate((value) => {
    value.hosts.cursor.install = value.hosts.cursor.install.replaceAll("https://media.mediaclaw.app/agent/package/", "https://example.com/");
  });
  assert.ok(validateInstallPrompts(withoutMirror).some((error) => /domestic package mirror/.test(error)));
});

test("source and field size limits match the backend, including UTF-8 JSON bytes", () => {
  const exactPrompt = mutate((value) => {
    value.hosts.codex.install += "文".repeat(30_000 - value.hosts.codex.install.length);
    value.hosts.codex.displayName = "A".repeat(80);
  });
  assert.deepEqual(validateInstallPrompts(exactPrompt), []);
  const oversizedPrompt = structuredClone(exactPrompt);
  oversizedPrompt.hosts.codex.install += "文";
  assert.ok(validateInstallPrompts(oversizedPrompt).some((error) => /30000/.test(error)));
  const oversizedName = structuredClone(exactPrompt);
  oversizedName.hosts.codex.displayName += "A";
  assert.ok(validateInstallPrompts(oversizedName).some((error) => /displayName/.test(error)));
  for (const field of ["displayName", ...INSTALL_PROMPT_PURPOSES]) {
    assert.ok(validateInstallPrompts(mutate((value) => { value.hosts.codex[field] += "\u0000"; })).some((error) => /NUL/.test(error)));
  }
  assert.ok(validateInstallPrompts(mutate((value) => { value.revision = `2026-11-03.${"1".repeat(80)}`; })).some((error) => /revision/.test(error)));

  const text = JSON.stringify(catalog);
  const atByteLimit = text + " ".repeat(INSTALL_PROMPT_MAX_BYTES - Buffer.byteLength(text));
  assert.deepEqual(validateInstallPrompts(catalog, {sourceText: atByteLimit}), []);
  assert.ok(validateInstallPrompts(catalog, {sourceText: `${atByteLimit} `}).some((error) => /512 KiB/.test(error)));
  const oversizedCatalog = mutate((value) => {
    for (const host of SUPPORTED_AGENT_HOST_KEYS) {
      for (const purpose of INSTALL_PROMPT_PURPOSES) {
        value.hosts[host][purpose] += "文".repeat(30_000 - value.hosts[host][purpose].length);
      }
    }
  });
  assert.ok(validateInstallPrompts(oversizedCatalog).some((error) => /512 KiB/.test(error)));
});

test("versions use at most six digits per component and prohibit leading zeros", () => {
  for (const version of ["00.4.0", "0.04.0", "0.4.00", "1000000.4.0", "0.1000000.0", "0.4.1000000"]) {
    for (const field of ["agentVersion", "minVersion", "maxVersion"]) {
      const invalid = mutate((value) => {
        if (field === "agentVersion") value.agentVersion = version;
        else value.extensionCompatibility[field] = version;
      });
      assert.ok(validateInstallPrompts(invalid).some((error) => error.includes(field)), `${field} must reject ${version}`);
    }
  }
  const maximumVersion = "999999.999999.999999";
  const valid = mutate((value) => {
    value.agentVersion = maximumVersion;
    value.extensionCompatibility = {minVersion: "0.0.0", maxVersion: maximumVersion};
    for (const host of SUPPORTED_AGENT_HOST_KEYS) {
      for (const purpose of INSTALL_PROMPT_PURPOSES) value.hosts[host][purpose] = value.hosts[host][purpose]
        .replaceAll(`实际运行版本为 ${catalog.agentVersion}`, `实际运行版本为 ${maximumVersion}`)
        .replaceAll(`/package/v${catalog.agentVersion}/`, `/package/v${maximumVersion}/`);
    }
  });
  assert.deepEqual(validateInstallPrompts(valid), []);
});

test("public prompts reject the previous development launcher and connected shortcut regressions", () => {
  for (const unsafe of [
    "\n命令=plugins/mediaclaw/scripts/launch-agent-local.cmd",
    "\nMEDIACLAW_AGENT_CHANNEL=local",
    "\n读取 .mcp.doubao-work.local.json",
    "\n如果本会话已经能调用 mediaclaw_connection_status，跳过安装",
  ]) {
    const invalid = mutate((value) => { value.hosts["doubao-work"].install += unsafe; });
    assert.ok(validateInstallPrompts(invalid).some((error) => /developer|bypass/.test(error)));
  }
});

test("repair and upgrade cannot lose identity preservation or actual-version checks", () => {
  for (const purpose of ["repair", "upgrade"]) {
    for (const required of [
      "即使工具已经存在或 connected=true，也必须核对实际运行版本、正式渠道、官方来源及启动路径",
      `实际运行版本为 ${catalog.agentVersion}`,
      "device.agentChannel=release",
      "保留设备身份、已批准配对和持久数据",
      "MEDIACLAW_AGENT_RUNTIME_VERSION",
    ]) {
      const invalid = mutate((value) => { value.hosts.workbuddy[purpose] = value.hosts.workbuddy[purpose].replaceAll(required, ""); });
      assert.ok(validateInstallPrompts(invalid).length, `must reject removal of ${required}`);
    }
  }
});

test("Codex retains authorized continuation and honest tool-loading boundaries", () => {
  forPurposes("codex", (prompt) => {
    assert.match(prompt, /codex plugin add mediaclaw@mediaclaw-agent/);
    assert.match(prompt, /codex plugin marketplace upgrade mediaclaw-agent/);
    assert.match(prompt, /自动创建一个 projectless 新任务/);
    assert.match(prompt, /你已被明确授权创建并打开这个续接任务/);
    assert.match(prompt, /不得在界面尚未切换时声称新对话已经打开/);
    assert.match(prompt, /请点击下方「打开聊天」/);
    assert.match(prompt, /不得在当前任务宣布首次接入全部完成/);
    assert.match(prompt, /每 4～5 秒自动复查一次，最多等待 3 分钟/);
    assert.match(prompt, /连续 15 秒仍未检测到浏览器扩展/);
    assert.match(prompt, /https:\/\/mediaclaw.app\/download/);
    assert.match(prompt, /不要把 Agent 接入包和社媒虾浏览器扩展都简称为“插件”/);
    assert.doesNotMatch(prompt, /你不需要研究该采什么数据，也不用记任何命令/);
  });
});

test("WorkBuddy uses its own CLI, configuration directory and official marketplace", () => {
  forPurposes("workbuddy", (prompt) => {
    assert.match(prompt, /app\.asar\.unpacked\/cli\/bin\/codebuddy/);
    assert.match(prompt, /CODEBUDDY_CONFIG_DIR/);
    assert.match(prompt, /~\/\.workbuddy-ai/);
    assert.match(prompt, /marketplace list 不附加 --json/);
    assert.match(prompt, /codebuddy plugin marketplace update mediaclaw-agent[\s\S]*codebuddy plugin install mediaclaw@mediaclaw-agent --scope user/);
    assert.match(prompt, /codebuddy plugin update mediaclaw@mediaclaw-agent --scope user/);
    assert.match(prompt, /codebuddy plugin enable mediaclaw@mediaclaw-agent --scope user/);
    assert.match(prompt, /不要手写 installed_plugins.json/);
    assert.match(prompt, /备份并仅移除该冲突项，保留其他连接器/);
    assert.match(prompt, /完全退出并重新打开宿主/);
    assert.match(prompt, /不承诺新会话会自动开始检查/);
    assert.doesNotMatch(prompt, /执行 \/plugin (?:install|update|marketplace)/);
  });
});

test("Doubao is manual, uses the official runtime and preflights GUI-like conditions", () => {
  forPurposes("doubao-work", (prompt) => {
    assert.match(prompt, /由我手动配置/);
    assert.match(prompt, /不要使用电脑操作/);
    assert.match(prompt, /不要打包或上传 ZIP/);
    assert.match(prompt, /plugins\/mediaclaw\/scripts\/launch-agent\.cmd/);
    assert.match(prompt, /不需要用户安装 Node/);
    assert.match(prompt, /仓库外的工作目录、GUI 常见的精简 PATH/);
    assert.match(prompt, /MCP initialize 和 tools\/list/);
    assert.match(prompt, new RegExp(`实际版本为 ${catalog.agentVersion.replaceAll(".", "\\.")}`));
    assert.match(prompt, /服务名为 mediaclaw-agent-adapter/);
    assert.match(prompt, /配置项 \/ 填写值/);
    assert.match(prompt, /变量名 \/ 值/);
    assert.match(prompt, /服务器名称=mediaclaw/);
    assert.match(prompt, /参数=留空/);
    assert.match(prompt, /不要在填写表中添加 CWD 或工作目录/);
    assert.match(prompt, /保留并编辑当前连接器/);
    assert.match(prompt, /不要使用 kill、pkill、killall/);
    assert.match(prompt, /只使用连接器管理页的关闭\/启用操作，由用户手动完成/);
    assert.match(prompt, /\*\*接下来需要你手动配置连接器。可以先查看\[豆包工作连接器配置教程\]/);
    assert.doesNotMatch(prompt, /launch-agent-local|自动创建并打开|不要让我.*手动新建任务/);
  });
});

test("Claude preserves official marketplace and a new-session continuation", () => {
  forPurposes("claude", (prompt) => {
    assert.match(prompt, /claude plugin marketplace add IvyXue18\/MediaClaw-Agent/);
    assert.match(prompt, /claude plugin install mediaclaw@mediaclaw-agent --scope user/);
    assert.match(prompt, /claude plugin update mediaclaw@mediaclaw-agent --scope user --yes/);
    assert.match(prompt, /不会给已经开始的会话热加载刚安装的插件/);
    assert.match(prompt, /保留其他连接器/);
  });
});

test("Grok Build uses the user-level connector with discovery and reload checks", () => {
  forPurposes("grok-build", (prompt) => {
    assert.match(prompt, /\[mcp_servers\.mediaclaw\]/);
    assert.match(prompt, /grok mcp doctor mediaclaw --json/);
    assert.match(prompt, /Grok 也会读取 ~\/\.claude.json、.cursor\/mcp.json 和项目 .mcp.json/);
    assert.match(prompt, /\/mcps 并按 r 刷新/);
    assert.match(prompt, /不要使用 --scope project/);
  });
});

test("Grok Bot keeps installation, state and narrowly authorized approval on its cloud computer", () => {
  forPurposes("grok-bot", (prompt) => {
    assert.ok(prompt.indexOf("chromewebstore.google.com/detail/") < prompt.indexOf("https://mediaclaw.app/download"));
    assert.match(prompt, /加载已解压的扩展程序/);
    assert.match(prompt, /\/workspace\/mediaclaw\/MediaClaw-Agent\/plugins\/mediaclaw\/scripts\/launch-agent/);
    assert.match(prompt, /MEDIACLAW_AGENT_STATE_DIR=\/workspace\/mediaclaw\/state/);
    assert.match(prompt, /PLUGIN_DATA=\/workspace\/mediaclaw\/plugin-data/);
    assert.match(prompt, /我已授权你在云电脑浏览器中替我点击“批准配对”/);
    assert.match(prompt, /出现其他设备或名称不符时不要批准/);
    assert.match(prompt, /只有平台扫码或输入账号登录需要请我接管画面/);
    assert.match(prompt, /不要让我把密码、验证码或 Cookie 发在对话里/);
    assert.match(prompt, /激活码只用于本次填写，不要写入文件、日志或回显全文/);
  });
});

test("DeepSeek retains insert patches and its real identity", () => {
  forPurposes("deepseek-harness", (prompt) => {
    assert.match(prompt, /@deepseek-ai\/dsh-mcp-client/);
    assert.match(prompt, /cordis\.patch\.yml/);
    assert.match(prompt, /- insert: \[ 条目 \]/);
    assert.match(prompt, /failOnStartupError: false/);
    assert.match(prompt, /不能将 MEDIACLAW_AGENT_HOST 改为 workbuddy 来绕过/);
    assert.match(prompt, /完全退出并重新打开 DeepSeek Harness/);
  });
});

test("Cursor keeps one user-level connector shared with the CLI", () => {
  forPurposes("cursor", (prompt) => {
    assert.match(prompt, /~\/\.cursor\/mcp\.json/);
    assert.match(prompt, /cursor-agent mcp list-tools mediaclaw/);
    assert.match(prompt, /不要写进项目的 \.cursor\/mcp\.json/);
    assert.match(prompt, /Cursor Settings → MCP/);
  });
});

test("public docs link to the catalog entry instead of maintaining a copyable installer", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const installation = readFileSync(new URL("../docs/INSTALLATION.md", import.meta.url), "utf8");
  for (const doc of [readme, installation]) {
    assert.ok(doc.includes(catalog.documentationUrl));
    assert.match(doc, /https:\/\/api\.mediaclaw\.app\/api\/agent-prompts/);
    assert.match(doc, /contracts\/install-prompts\.json/);
    assert.doesNotMatch(doc, /^> 请从 https:\/\/github.com\/IvyXue18\/MediaClaw-Agent 安装/m);
  }
  for (const host of SUPPORTED_AGENT_HOST_KEYS) {
    assert.ok(installation.includes(`\`${host}\``));
    assert.ok(installation.includes(`\`${agentHostDeviceDisplayName(host)}\``));
  }
  assert.match(installation, /命令 \| `<MediaClaw-Agent绝对路径>\/plugins\/mediaclaw\/scripts\/launch-agent.cmd`/);
});
