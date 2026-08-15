# MediaClaw Agent

MediaClaw Agent 是 [MediaClaw](https://mediaclaw.app) 的官方 Agent 接入包，面向 Codex 和 WorkBuddy 提供安装入口。连接成功后，你可以直接使用 MediaClaw 浏览器插件已经提供的内容采集、资料读取和社媒研究能力，并继续完成选题、策划与内容创作。

它不能单独使用：你还需要安装 MediaClaw 浏览器插件、完成有效会员验证，并在浏览器中批准当前 Agent。页面访问、积分消耗和需要人工确认的操作，始终以浏览器插件中的提示为准。

> 当前版本为 `0.3.0 RC`。请以 [Releases](https://github.com/IvyXue18/MediaClaw-Agent/releases) 中的版本说明和 MediaClaw 插件实际提示为准。

## 可以做什么

连接成功后，你可以直接让 Agent：

- 读取 MediaClaw 中已经保存的数据、账号分析、风格档案、选题和生成结果。
- 获取小红书、抖音的单篇内容，采集关键词搜索结果、账号内容和评论。
- 补充内容详情、识别图片文字，并在服务可用时获取视频逐字稿。
- 研究关键词趋势、长尾需求、账号内容策略、近期高表现内容和赛道对标账号。
- 拆解一篇内容的选题、结构、表达和互动信号。
- 基于真实证据生成选题、标题、内容方案、大纲、图文稿、口播稿或视频脚本。
- 使用已保存的账号风格完成适配、改写，并输出 Markdown 或 HTML 报告。
- 查询长任务进度，或取消仍在执行的任务。

例如，你可以这样说：

> 分析“小户型收纳”最近有哪些内容机会，先检查我已有的数据，不够再补充采集，最后给我 10 个选题。

> 拆解这个小红书链接为什么表现好，再结合我保存的账号风格写一篇新稿。

> 研究这个抖音账号近期高表现内容，给我下一阶段的内容方向和 7 天选题计划。

Agent 接管需要有效会员。逐字稿等计费能力还会在执行前展示预计积分并再次确认；Agent 不应在未确认时替你产生费用。

## 自动检查 Agent 更新

每个新会话第一次使用 MediaClaw 时，Agent 会检查官方接入包版本。发现新版本后，它会先说明版本变化并征求你的授权；同意后由 Agent 刷新对应宿主的 marketplace、验证安装结果，并创建一个已经加载新版本的新任务继续原需求。你不需要手动输入升级命令、重新描述需求或重新配对。

当前会话已经加载的 Skill 和 MCP 不能热更新，因此升级完成后必须由新任务续接。更新检查失败不会阻塞当前版本使用；未经授权不会修改本机安装。

## 安装前准备

你需要：

1. 安装或升级 MediaClaw 浏览器插件。
2. 在 MediaClaw 插件中完成有效会员验证。
3. 在浏览器中登录你要使用的小红书或抖音账号。
4. 在 Codex 或 WorkBuddy 中安装本仓库的 MediaClaw 接入包。
5. 打开 MediaClaw 插件的“Agent 接管”，批准当前 Agent。

## 把这一段发给 Agent

你可以直接把下面的话发给 Codex 或 WorkBuddy：

> 请识别你当前运行在 Codex 还是 WorkBuddy，并从 https://github.com/IvyXue18/MediaClaw-Agent 安装对应的 MediaClaw 官方接入包。安装完成后新建或提示我新建一个会话，检查 MediaClaw 连接状态，再引导我到浏览器插件的“Agent 接管”中批准当前设备。不要向我索取激活码、Cookie、平台 Token、端口或本机令牌。

也可以查看分宿主安装步骤：[安装与连接](docs/INSTALLATION.md)。

## 使用边界

- MediaClaw Agent 必须配合官方浏览器插件使用，不能替代浏览器插件。
- Agent 只能使用你在浏览器插件中批准的能力。
- 遇到登录失效、验证码、平台限制或风险提示时，任务可能暂停并请你在浏览器中处理。
- 涉及会员、积分或外部写入的操作，以执行前显示的范围和确认信息为准。
- 请不要在对话、Issue 或日志中提交 Cookie、Token、激活码、设备私钥或真实用户数据。

## 更多信息

- MediaClaw 官网：[mediaclaw.app](https://mediaclaw.app)
- 安装与连接：[docs/INSTALLATION.md](docs/INSTALLATION.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 版本记录：[CHANGELOG.md](CHANGELOG.md)
- 开源许可：[Apache License 2.0](LICENSE)
