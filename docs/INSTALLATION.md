# 安装与连接 MediaClaw Agent

MediaClaw Agent 需要与 MediaClaw 浏览器插件配合使用。普通用户不需要自行配置端口、令牌或运行服务。当前正式版本为 `0.4.0`（GitHub Latest），支持 Codex、WorkBuddy、豆包工作、Claude Code、Grok Build、Grok Bot（云电脑）、DeepSeek Harness 和 Cursor，需要配套 MediaClaw 浏览器插件 `0.4.0`。实际可用能力以连接后返回的结果为准。

## 第一步：准备浏览器插件

1. 安装或升级 MediaClaw 浏览器插件。
2. 在 MediaClaw 插件中完成有效会员验证。
3. 在浏览器中登录需要使用的小红书、抖音或 TikTok 账号。
4. 确认插件可以正常打开。

## 第二步：把安装交给 Agent

浏览器插件和 Agent 是两个独立安装包，版本须分别核对：`0.4.0` Agent 配套 `0.4.0` 浏览器插件。在当前宿主的新对话中直接发送以下提示词；豆包工作由 Agent 准备配置，再由你保存连接器，Grok Bot 在自己的云电脑上安装：

> 请从 https://github.com/IvyXue18/MediaClaw-Agent 安装、升级或修复 MediaClaw 官方接入包，先读取 https://github.com/IvyXue18/MediaClaw-Agent/blob/main/docs/INSTALLATION.md 中当前宿主的安装说明。按当前宿主选择 marketplace 或 STDIO 接入，使用官方仓库默认分支和正式启动器，以及当前宿主的正确标识，DeepSeek Harness 必须是 deepseek-harness，不能改成 workbuddy；保留其他插件与 MCP 配置。平台和芯片识别、官方运行时准备、SHA-256 校验及连接复查都由你完成；完成后核对实际运行版本为 0.4.0、宿主身份与连接状态，再引导我批准设备。不要让我下载 ZIP、选择 `.exe` 或使用终端，不要向我索取平台 Cookie、Token 或本机令牌，也不要把工具注册成功当成已经连接浏览器。

以下安装操作由 Agent 执行：

1. **Codex、WorkBuddy、Claude Code**：用宿主自身的插件管理工具或 CLI 注册官方 `IvyXue18/MediaClaw-Agent` 为 `mediaclaw-agent` marketplace，再安装 `mediaclaw@mediaclaw-agent`。同名市场已存在时先核对来源并刷新；若仍指向旧本地目录或其他来源，仅移除这一个旧市场注册，按官方来源重新注册并重新安装，保留其他市场和插件。通过宿主列表核对来源、安装路径、启用状态和版本 `0.4.0`；不得手写安装注册文件。WorkBuddy 每次调用 CLI 都须使用实际用户数据目录，见下方排查说明。
2. **豆包工作、Grok Build、Grok Bot、DeepSeek Harness、Cursor**：先把官方仓库 `https://github.com/IvyXue18/MediaClaw-Agent.git` 的默认分支克隆到长期目录：本机为 `~/.mediaclaw/MediaClaw-Agent`，Windows 为 `%USERPROFILE%\.mediaclaw\MediaClaw-Agent`；Grok Bot 为 `/workspace/mediaclaw/MediaClaw-Agent`。已有目录先核对 origin 为官方地址、工作区无未保存改动，再从官方地址更新到当前正式版；之前固定在预发布标签的目录同样更新到正式版。有本地改动时保留原目录，在另一个长期目录准备正式版，也不要修改开发源码仓。然后按下方宿主说明配置 STDIO：命令指向该目录下 `plugins/mediaclaw/scripts/launch-agent.cmd` 的绝对路径，Grok Bot 使用 `plugins/mediaclaw/scripts/launch-agent`。这些正式启动器会自动下载并校验当前版本的原生运行时，不使用 `launch-agent-local.cmd`，不需要用户安装 Node。
3. 重开需要重开的宿主，用 MCP 握手或连接状态核对实际 Adapter 版本为 `0.4.0`，且宿主标识与下表一致。运行的仍是旧版本、仅清单版本变了、或工具尚未加载时，都不能宣布安装完成。连接器工具已注册也不等于浏览器已配对；继续按“批准连接”核查。

| 宿主 | `MEDIACLAW_AGENT_HOST` | 设备显示名 |
| --- | --- | --- |
| Codex | `codex` | `MediaClaw Agent (Codex)` |
| WorkBuddy | `workbuddy` | `MediaClaw Agent (WorkBuddy)` |
| 豆包工作 | `doubao-work` | `MediaClaw Agent (豆包工作)` |
| Claude Code | `claude` | `MediaClaw Agent (Claude Code)` |
| Grok Build | `grok-build` | `MediaClaw Agent (Grok Build)` |
| Grok Bot（云电脑） | `grok-bot` | `MediaClaw Agent (Grok Bot 云电脑)` |
| DeepSeek Harness | `deepseek-harness` | `MediaClaw Agent (DeepSeek Harness)` |
| Cursor | `cursor` | `MediaClaw Agent (Cursor)` |

marketplace 安装由包内清单提供这些环境变量。直连配置只新增或更新 MediaClaw 自己的条目，不覆盖整个配置文件；如曾把 DeepSeek 配成 `workbuddy`，应改回 `deepseek-harness`，保留真正的 WorkBuddy 配置。各宿主会使用各自身份并分别请求配对。

Agent 负责识别宿主、注册官方来源和安装接入包。接入包第一次启动时会自动识别 Windows、macOS 或 Linux 及当前芯片，从官方 Release 获取唯一匹配的原生运行时并校验；用户不需要安装 Node、Bash、WSL 或 Git Bash。首次安装发生在当前对话已经启动之后时，宿主可能要求重新打开应用或进入一个已加载插件的新对话；Agent 应说明原因并把下一步收敛为一个明确的界面动作，不要求用户输入安装命令。

当前原生运行时覆盖 macOS x64/ARM64、Windows x64/ARM64，以及 Linux glibc/musl 的 x64/ARM64。浏览器或系统策略完全禁止本机程序、GitHub 下载或 `127.0.0.1` 回环连接时，Agent 必须报告具体受限环节，不能把它误报为安装成功。

### WorkBuddy 提示没有安装能力时

找不到插件管理工具，或终端的 PATH 中没有 `codebuddy`，不代表 WorkBuddy 无法安装。请让 Agent 继续检查 WorkBuddy 应用自带的 CLI；macOS 的 WorkBuddy AI 常见入口是 `/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`，其他安装位置和系统应按实际应用目录定位。Node 脚本入口使用本机或宿主已有的 Node 执行，不需要用户另装命令行工具。

Agent 应先核实 WorkBuddy 的实际用户数据目录，每次调用内置 CLI 都通过 `CODEBUDDY_CONFIG_DIR` 指向同一目录（WorkBuddy AI 常见为 `~/.workbuddy-ai`）。先用插件与市场列表确认操作的是当前 WorkBuddy，避免写到独立 CodeBuddy 的配置目录。市场已注册时仍需确认官方来源并刷新，再安装或更新 `mediaclaw@mediaclaw-agent`，通过宿主列表复查实际版本、安装路径和启用状态。上述操作由 Agent 执行，不要求用户输入终端或斜杠命令，也不能靠手写安装记录代替宿主安装。

安装能力与会话管理能力应分别检查。缺少自动新建会话能力时，Agent 仍应先完成安装、启用和验版，再说明必要的重开或新会话动作。没有实际创建续接会话或设置续接机制时，不能承诺新会话会自行开始检查。如果内置 CLI 也确实不可用，Agent 应简短说明具体失败点，并按当前界面给出最少操作步骤。

### Claude Code

Claude Code（终端、桌面版 Code 标签和 IDE 扩展）使用同一个官方 marketplace。Agent 通过 Claude Code 自带的插件命令注册 `IvyXue18/MediaClaw-Agent` 并安装 `mediaclaw@mediaclaw-agent`，再用插件列表复查实际版本和启用状态；这些命令由 Agent 执行，不要求用户输入。Claude Code 不会给已经开始的会话热加载刚安装的插件，安装后需要新开一个会话（或重启 Claude Code）才会出现社媒虾工具；Agent 应明确说明这一步。

Claude Code 的终端、桌面版和 IDE 共用同一个设备身份，在浏览器插件中批准一次即可。

### Grok Build

Grok Build 没有插件市场，使用本机 MCP 连接器。Agent 按上方步骤把官方仓库保存在 `~/.mediaclaw/MediaClaw-Agent`（Windows 为 `%USERPROFILE%\.mediaclaw\MediaClaw-Agent`），备份后只在 `~/.grok/config.toml` 中新增或替换 `[mcp_servers.mediaclaw]`：`command` 为该目录下 `plugins/mediaclaw/scripts/launch-agent.cmd` 的绝对路径，`env` 设置 `MEDIACLAW_AGENT_HOST = "grok-build"` 与 `MEDIACLAW_AGENT_DEVICE_NAME = "MediaClaw Agent (Grok Build)"`。随后用 `grok mcp list --json` 和 `grok mcp doctor mediaclaw --json` 复查。Grok 也会读取 `~/.claude.json`、`.cursor/mcp.json` 和项目 `.mcp.json`，需要确认只生效一份 `mediaclaw`。当前会话没有出现工具时，在 TUI 中用 `/mcps` 按 `r` 刷新，或重新运行 `grok`。之后在 Grok Build 中说“升级 MediaClaw Agent”即可自动更新：Agent 从官方地址取得已确认的稳定版并验版，再提示重新运行 `grok` 激活。

### DeepSeek Harness

DeepSeek Harness 没有插件市场，使用官方 `@deepseek-ai/dsh-mcp-client` 的 stdio 连接。Agent 按上方步骤把官方仓库保存在 `~/.mediaclaw/MediaClaw-Agent`，备份后在当前 profile 的 `~/.dsh/profiles/<profile>/cordis.patch.yml`（桌面版为 `desktop`）末尾追加一个 `insert` 补丁：补丁文件只能覆盖已有条目，新增插件不写成 `- insert: [ … ]` 会被静默跳过。已有 `id: mediaclaw` 时原位更新该条目，不重复追加。条目为 `id: mediaclaw`、`name: '@deepseek-ai/dsh-mcp-client'`，`config` 中 `serverName: mediaclaw`、`transport: stdio`、`command` 指向 `plugins/mediaclaw/scripts/launch-agent.cmd` 的绝对路径，`env` 设置 `MEDIACLAW_AGENT_HOST: deepseek-harness` 与 `MEDIACLAW_AGENT_DEVICE_NAME: 'MediaClaw Agent (DeepSeek Harness)'`。宿主会过滤含 KEY、TOKEN、SECRET、PASSWORD 或以 `DSH_` 开头的变量名。保存后完全退出并重新打开 DeepSeek Harness，新会话中出现 `mcp__mediaclaw__*` 工具后，继续核对实际版本和浏览器配对，成功连接后才算接入完成。若启动时报宿主不受支持，应检查是否误装 `0.3.1` 等旧版本，不得将标识改成 `workbuddy` 来绕过。之后说“升级 MediaClaw Agent”即可自动更新，完成后重开 DeepSeek Harness 激活。

### Cursor

Cursor 的编辑器和 `cursor-agent` 命令行共用用户级 `~/.cursor/mcp.json`，配一次两边都能用，并共用同一个设备身份。Agent 按上方步骤把官方仓库保存在 `~/.mediaclaw/MediaClaw-Agent`，备份后只新增或替换 `mcpServers.mediaclaw`：`command` 为该目录下 `plugins/mediaclaw/scripts/launch-agent.cmd` 的绝对路径，`env` 设置 `MEDIACLAW_AGENT_HOST: "cursor"` 与 `MEDIACLAW_AGENT_DEVICE_NAME: "MediaClaw Agent (Cursor)"`；不要写进项目的 `.cursor/mcp.json`。用 `cursor-agent mcp list-tools mediaclaw` 确认工具，编辑器中在 Cursor Settings → MCP 确认已启用，新开 Agent 对话后即可配对。之后说“升级 MediaClaw Agent”即可自动更新。

### Grok Bot（云电脑）

Grok Bot 在自己的云电脑上工作，浏览器插件和 Agent 都安装在那台云电脑里，用户本地电脑不需要安装。持久文件统一放在 `/workspace/mediaclaw`：

1. 浏览器插件：先在云电脑浏览器打开 Chrome 应用商店安装 MediaClaw 浏览器插件，并确认版本为 `0.4.0`；商店不可用时从 `https://mediaclaw.app/download` 下载安装包，解压后在 `chrome://extensions` 开启开发者模式并加载已解压的扩展程序。
2. 激活：用户在对话中提供激活码，Bot 在插件中填写并确认会员有效，不把激活码写入文件或日志。
3. 连接器：按上方步骤把官方仓库保存到 `/workspace/mediaclaw/MediaClaw-Agent`，用 Grok Bot 的自定义 MCP 服务器能力新增 stdio 服务器 `mediaclaw`，启动命令为 `plugins/mediaclaw/scripts/launch-agent`，环境变量为 `MEDIACLAW_AGENT_HOST=grok-bot`、`MEDIACLAW_AGENT_DEVICE_NAME=MediaClaw Agent (Grok Bot 云电脑)`、`MEDIACLAW_AGENT_STATE_DIR=/workspace/mediaclaw/state`、`PLUGIN_DATA=/workspace/mediaclaw/plugin-data`，让设备身份与运行时在云电脑恢复后保留。之后在 Grok Bot 中说“升级 MediaClaw Agent”，Bot 从官方地址更新该目录并验版，新开对话即可激活。
4. 配对与登录：在插件“Agent 接管”中开启调用；出现待批准设备时，由 Bot 在云电脑浏览器中自行点击“批准配对”，只批准设备名为 `MediaClaw Agent (Grok Bot 云电脑)` 且是自己刚启动的连接器，名称不符或出现其他设备时停止并告知用户。用户只需接管画面扫码或输入账号登录平台。

同一云电脑上的其他 Bot 共享浏览器登录状态；平台提示环境或网络风险时，可在 Grok 设置的 Computer 中让流量经由用户桌面。

## 豆包工作接入

豆包工作接入由用户在“技能 · 连接器 · 伙伴 → 连接器”中手动填写并保存。Agent 通过本地文件与命令能力解析本机路径、完成握手预检，再直接回复以下中文配置表和简短步骤，不操控电脑、不上传技能 ZIP，也不自动新建任务。建立连接不以导入技能为前提；已有技能和连接器应复用。

先按上方步骤准备官方仓库的长期安装目录，再填写本地连接器。尖括号内容必须在展示给用户前替换为该目录的真实绝对路径：

| 配置项 | 填写值 |
| --- | --- |
| 服务器名称 | `mediaclaw` |
| 类型 | 本地电脑 / 自定义连接器 |
| 传输类型 | `STDIO` |
| 命令 | `<MediaClaw-Agent绝对路径>/plugins/mediaclaw/scripts/launch-agent.cmd` |
| 参数 | 留空，不点击“添加”，不输入“留空”二字 |
| `MEDIACLAW_AGENT_HOST` | `doubao-work` |
| `MEDIACLAW_AGENT_DEVICE_NAME` | `MediaClaw Agent (豆包工作)` |

填写时变量名和值必须分栏输入，不加引号、不写等号、不留首尾空格。设备名必须完整保留空格、括号和“豆包工作”。命令必须是绝对路径，参数必须真正留空。界面没有工作目录输入框，不需要填写 CWD（工作目录）；启动器按自身位置定位程序文件。

在让用户保存前，安装 Agent 必须使用同一命令绝对路径和上表两个环境变量，在仓库外的工作目录、GUI 常见的精简 `PATH` 下完成 MCP `initialize` 和 `tools/list`；只有服务名为 `mediaclaw-agent-adapter`、实际版本为 `0.4.0` 且工具列表包含 `mediaclaw_connection_status` 才算预检通过。宿主保存后仍应以连接器管理页真实列出工具为最终成功标准。

连接失败时保留并编辑现有的 `mediaclaw`，不要创建第二个。优先按以下顺序定位：

1. 运行时下载或校验失败：核对安装目录的版本、当前平台以及 GitHub 下载是否可达；不要改成旧版运行时或源码启动器绕过。
2. 命令文件不存在：重新定位长期保存的 Agent 仓库，禁止使用下载临时目录。
3. 权限不足：确认启动脚本可执行以及仓库目录可读取。
4. `TRANSPORT_CLOSED`：只在豆包连接器管理页关闭后重新启用一次，不结束相关进程、不重复卸载。

配置表后请用户核对并点击保存、启用，确认连接器列出工具。若当前任务未加载工具，提示用户手动新建工作任务并发送“检查 MediaClaw 连接”；需要配对时，到社媒虾 → 设置 → Agent 接管，开启允许本机 Agent 调用并批准设备。给完步骤即可结束回复，不代操作，也不在等待填表时持续轮询。只有实际连接状态为成功时才能宣布接入完成。

## 后续更新

在已有 MediaClaw 的 Codex、WorkBuddy、Claude Code、Grok Build、Grok Bot、DeepSeek Harness 或 Cursor 对话中直接说“升级 MediaClaw Agent”即可；已安装 `0.3.1` 或 0.4 预发布版的用户都会更新到当前正式版。这句话本身代表明确授权；Agent 会自行刷新官方 marketplace 或官方仓库目录、安装、核验版本并保存原任务，不向用户展示或要求用户执行终端、CLI、斜杠命令、缓存清理或路径操作。

安装完成后必须完全退出并重新打开当前宿主。运行中的旧对话不能热加载新 Skill/MCP，同一进程里再建对话也不能作为新版生效证据。重开后只有状态显示新版已经真实激活，才会自动继续原任务；已有设备批准默认复用。正式版更新只跟随正式 Release，不跟随 prerelease。

从旧版升级时，marketplace 宿主以 marketplace 为唯一版本来源，连接器宿主以官方仓库目录为唯一版本来源。升级后的第一次启动会在宿主提供的持久插件数据目录中准备当前平台的新运行时，原设备身份与浏览器批准不会因运行时替换而清空。原先“显示已安装但始终未连接”的用户可以再次发送同一条安装提示词；Agent 应刷新 marketplace、修复缺失运行时并复查连接，不要求先卸载。

豆包工作暂不支持这句话自动升级。需要更新时，重新发送第二步的安装提示词：Agent 更新长期安装目录并重新完成握手预检，现有 `mediaclaw` 连接器的命令路径不变时无需重新填写，在连接器管理页关闭后重新启用一次即可。原连接器仍指向 `launch-agent-local.cmd`，或带有 `MEDIACLAW_AGENT_CHANNEL`、`MEDIACLAW_AGENT_NODE` 时，按上方配置表把命令改为 `launch-agent.cmd` 并删除这两个变量。

如果自动升级失败，让 Agent 直接说明失败发生在“检查、安装、验版、重开激活”中的哪一步即可，不需要用户改用命令行修复。

## 第三步：批准连接

1. 在新会话中说：“检查 MediaClaw 连接状态。”
2. 打开 MediaClaw 浏览器插件 → 设置 → Agent 接管。
3. 开启“允许本机 Agent 调用”。
4. 核对当前 Agent 名称，在待确认列表中点击“批准”。
5. 回到 Agent，再次说：“检查 MediaClaw 连接状态，并告诉我现在能做什么。”

每个 Agent 需要分别批准。撤销其中一个不会影响其他已经批准的 Agent。

## 配对之后，在 Agent 对话里工作

批准设备允许 Agent 连接社媒虾，不代表批准后续所有采集。`0.4.0` 包含原 0.3.2 的对话方案改进，不会在运行中的 `0.3.1` 会话里自动生效，升级并重开宿主后才会生效；以已安装版本和 Release 说明为准。

新版先读取已有数据。普通具体请求已明确采集对象和范围时，可直接按请求执行；只给研究目标时，先在 Agent 对话说明来源、时间、数量和内容范围，允许修改，再等你的回复。默认值不是许可，一次授权覆盖同方案已说明的批次和重试。

需要确认时，支持的宿主可使用对话确认框；没有确认框也能直接在当前对话自然回复，不要求固定口令。填写修改意见会先修订方案，关闭或拒绝不会批准。除设备配对外，不需要到插件查找批准或“核对发送”入口。

扣费、清理和私信发送先在对话展示实际报价、删除与保留范围，或发送账号、完整实际收件人名单和话术，再等待针对该预览的明确回复。待执行方案可修改；运行中的任务先停止并核查状态，再准备新方案。当前版本缺少相应工具时，Agent 应准确说明限制并保留未执行状态。

## 常见问题

### 安装后没有检测到 Agent

- 确认安装完成后创建了全新的 Agent 会话。
- 确认 MediaClaw 浏览器插件已经开启。
- 回到 Agent 再次要求它检查连接状态。
- 如果仍未连接，让 Agent 报告具体安装状态和错误信息，不要反复重装。

### 一直显示等待批准

打开浏览器插件的“Agent 接管”，检查待确认列表并批准当前 Agent。不要把激活码、Cookie、Token 或任何本机令牌发给 Agent。

### 采集过程中要求处理浏览器

登录失效、验证码、平台限制或页面异常时，MediaClaw 可能暂停任务。按浏览器中的提示处理后，再让 Agent 查询原任务状态。

### 为什么有些能力不能使用

`0.4.0` 提供已连接插件能力核查，旧版已安装会话不会自动获得。TikTok 目前支持单篇作品、作者主页、搜索列表、已显示评论、采集增强和数据池读取，不支持探索页、逐字稿、配图文字、私信和监控；首次使用 TikTok 时需要在社媒虾侧栏授权 TikTok 访问。新版会区分当前 Agent 可调用、由 Agent 编排分析及尚未接入的操作；相同版本号或连接成功不代表每个功能都已接入。支持的私信与清理流程在 Agent 对话展示实际预览并等明确回复，不引导用户回插件确认。

Agent 接管需要有效会员；逐字稿等计费能力还需要足够积分和执行前确认。平台登录状态、页面状态和安全限制也可能影响任务。让 Agent 说明缺少的条件和最小下一步，不要让它尝试绕过插件提示。

## 卸载

先在 MediaClaw 浏览器插件的“Agent 接管”中撤销对应 Agent，再使用 Codex、WorkBuddy 或 Claude Code 自己的插件管理入口卸载 MediaClaw；使用连接器接入的宿主，删除其配置中的 `mediaclaw` 条目即可，其他配置保持不变。
