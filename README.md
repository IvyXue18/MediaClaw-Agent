# MediaClaw Agent

MediaClaw Agent 是 [MediaClaw](https://mediaclaw.app) 的官方 Agent 接入包，面向 Codex 和 WorkBuddy 提供安装入口。连接成功后，你可以直接使用 MediaClaw 浏览器插件已经提供的内容采集、资料读取和社媒研究能力，并继续完成选题、策划与内容创作。

它不能单独使用：你还需要安装 MediaClaw 浏览器插件、完成有效会员验证，并在浏览器中批准当前 Agent。页面访问、积分消耗和需要人工确认的操作，始终以浏览器插件中的提示为准。

> 当前正式版本为 `0.3.0`。请以 [Releases](https://github.com/IvyXue18/MediaClaw-Agent/releases) 中的版本说明和 MediaClaw 插件实际提示为准。

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

每个新会话第一次使用 MediaClaw 时，Agent 会检查官方稳定版。你也可以在 Codex 或 WorkBuddy 的 MediaClaw 对话里直接说：

> 升级 MediaClaw Agent。

这句话本身就是升级授权。Agent 会自行刷新官方来源、安装并核验新版本，同时保存你升级前没有做完的请求；不会让你打开终端、输入命令、寻找缓存目录或重新描述需求。

宿主不会给运行中的旧对话热加载已经替换的 Skill 和 MCP。安装完成后，Agent 会明确提示你完全退出并重新打开 Codex 或 WorkBuddy；这是用户唯一需要做的动作。重开后只有当前运行版本确实等于目标版本，Agent 才会宣布升级完成并继续原请求。安装记录变了但旧进程仍在运行时，不算升级成功。更新检查失败不会阻塞当前版本使用；正式版不会自动跟随 prerelease。

## 安装前准备

你需要：

1. 安装或升级 MediaClaw 浏览器插件。
2. 在 MediaClaw 插件中完成有效会员验证。
3. 在浏览器中登录你要使用的小红书或抖音账号。
4. 在 Codex 或 WorkBuddy 中安装本仓库的 MediaClaw 接入包。
5. 打开 MediaClaw 插件的“Agent 接管”，批准当前 Agent。

## 第一次安装也可以交给 Agent

你可以直接把下面的话发给 Codex 或 WorkBuddy：

> 请从 https://github.com/IvyXue18/MediaClaw-Agent 安装当前宿主对应的 MediaClaw 官方接入包，完成后继续检查连接并引导我批准设备。所有可以自动完成的步骤都由你完成，不要让我使用终端，也不要向我索取激活码、Cookie、平台 Token、端口或本机令牌。

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
