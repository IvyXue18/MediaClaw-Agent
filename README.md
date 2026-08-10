# MediaClaw Agent

MediaClaw Agent 是 MediaClaw 浏览器插件的本机 Agent 接入包。它把同一套 Skill、MCP 工具和本机连接能力安装到 Codex、Claude Code 等 Agent 宿主；真正的平台读取、采集、会员校验、积分扣除和人工确认仍由浏览器插件执行。

> 当前状态：V0.3 技术预览，供联调和验收使用。Codex、Claude Code 可以开始测试；WorkBuddy 清单已预留，但尚未完成真实宿主安装验证。

## 用户需要安装什么

用户需要两部分，缺一不可：

1. 从浏览器插件市场安装或升级 MediaClaw 浏览器插件。
2. 在每个要使用的 Agent 宿主中安装一次本仓库的接入包。

浏览器插件不会自动修改 Codex、Claude Code 或 WorkBuddy 的配置；本仓库也不会替代浏览器插件。Agent 安装完成后，打开 MediaClaw 设置中的“Agent 接管”，批准该宿主的设备配对即可。

## 直接交给 Agent 安装

可以把下面这句话连同仓库链接发给当前 Agent：

> 请从 https://github.com/IvyXue18/MediaClaw-Agent 安装 MediaClaw Agent 接入包。先识别当前宿主，只安装这个宿主需要的入口；安装后检查连接状态，并引导我到浏览器插件里批准配对。不要要求我手工填写端口或令牌。

当前可用的安装命令入口：

### Codex

```bash
codex plugin marketplace add IvyXue18/MediaClaw-Agent
codex plugin add mediaclaw@mediaclaw-agent
```

安装后新建一个 Codex 任务，使 Skill 与 MCP 工具完成加载。

### Claude Code

```bash
claude plugin marketplace add IvyXue18/MediaClaw-Agent
claude plugin install mediaclaw@mediaclaw-agent
```

安装后重启 Claude Code 会话。仓库清单已通过 Claude Code 严格格式校验；正式对外前还需完成整套配对和真实采集验收。

### WorkBuddy

仓库已包含 `.workbuddy-plugin/plugin.json`，但在拿到可测试的 WorkBuddy 宿主前，不把它标记为“已支持”。插件设置页应显示“待安装”；只有检测到真实启动过的 adapter 后才显示“可测试”。

## 能力边界

- Agent：理解任务、调用 MCP、读取获准数据、使用 Skill 组织分析与内容生成。
- 本机接入包：保存宿主设备身份、连接浏览器插件、转发任务、统一协议和结果结构。
- 浏览器插件：访问已登录页面、执行读取/采集/提取、实施免费与会员能力差异、积分和人工确认。
- Agent 不直接解析小红书或抖音页面，不持有浏览器登录态，也不能绕过插件授权。
- 逐字稿只走浏览器插件现有的报价与确认流程；V0.3 不提供 BYOK 和本地绕过方案。

详细说明见 [安装与配对](docs/INSTALLATION.md)、[架构与权限边界](docs/ARCHITECTURE.md) 和 [开发状态](docs/DEVELOPMENT.md)。

## 本地开发验证

```bash
npm run check
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/mediaclaw
claude plugin validate --strict .
```

本项目当前只使用 Node.js 内置模块，没有运行时 npm 依赖。

## 许可与发布

本仓库采用 [Apache License 2.0](LICENSE)。它允许使用、修改和商业分发，并要求保留许可证与相关声明；已经按该许可证发布的版本，其既有授权不能通过后续换证追回。
