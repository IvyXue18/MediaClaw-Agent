# Changelog

## 0.4.0-rc.1 — 2026-10-26（Pre-release）

面向 `0.4.0` 浏览器插件的 Agent 候选版，合并了从未正式发布的 0.3.2 改动（见下方小节），提供 TikTok 能力接入及新增宿主入口。新增宿主属于候选支持，实际兼容性与可用能力以当前宿主和浏览器插件连接结果为准。

- 通过固定标签 `v0.4.0-rc.1` 安装候选，宿主清单和正式启动器对应同一候选运行时；安装后核对真实活动版本，不能只看插件注册记录。
- 提供 Codex、WorkBuddy、豆包工作、Claude Code、Grok Build、Grok Bot、DeepSeek Harness、Cursor 的候选安装说明。各宿主使用自己的身份标识，DeepSeek Harness 使用 `deepseek-harness`，不借用 `workbuddy`。
- 本次为 GitHub Pre-release，稳定版 Latest 保持 `v0.3.1`，正式用户不会自动升级到候选。安装说明及可复制给 Agent 的提示词见 [安装与连接](docs/INSTALLATION.md#安装-04-候选版)。

- 新增 Claude Code 宿主：提供 Claude Code marketplace 与插件清单，复用同一套 MCP 与内容研究 Skill。Claude Code 的终端、桌面版和 IDE 共用一个设备身份，在浏览器插件中批准一次即可；支持“升级 MediaClaw Agent”自动更新，运行时保存在 Claude Code 的持久插件数据目录。
- 新增 Grok Build 宿主：Grok Build 没有插件市场，Agent 把官方仓库克隆到用户目录，并在 `~/.grok/config.toml` 中登记 `mediaclaw` 本机 MCP 连接器（`MEDIACLAW_AGENT_HOST=grok-build`）。
- 新增 Grok Bot（云电脑）宿主：浏览器插件与 Agent 都安装在 Grok 云电脑中，持久文件位于 `/workspace/mediaclaw`；Bot 自行批准本设备配对，用户只需接管画面登录平台。
- 新增 DeepSeek Harness 宿主：通过官方 `@deepseek-ai/dsh-mcp-client` 的 stdio 连接接入，在 profile 的 `cordis.patch.yml` 中以 `insert` 补丁登记 `mediaclaw`（`MEDIACLAW_AGENT_HOST=deepseek-harness`）。
- 新增 Cursor 宿主：编辑器与 cursor-agent 命令行共用用户级 `~/.cursor/mcp.json`，在其中登记 `mediaclaw` 本机连接器（`MEDIACLAW_AGENT_HOST=cursor`），两边共用一个设备身份。
- Grok Build、Grok Bot、DeepSeek Harness 与 Cursor 支持“升级 MediaClaw Agent”一句话自动更新：启动器从官方仓库的克隆目录运行时导出 `MEDIACLAW_AGENT_PACKAGE_ROOT`，Adapter 在用户同意后在安装目录干净时从官方地址获取已确认稳定版标签并仅快进到该版本，再核对清单版本，提示重开宿主激活；没有克隆目录时（如本地源码启动）仍提示重新执行安装提示。
- 不受支持的宿主不能注册到 Broker、创建设备身份或请求升级。

## 0.3.2 — 未单独发布，并入 0.4.0

- 新增已连接插件能力核查，明确 Agent 可调用、宿主编排及尚无入口的能力，不再凭版本号推断对齐。
- 设备配对后，方案、修改、确认和停止统一留在 Agent 对话。普通具体采集可沿用当前请求；模糊研究目标先给可改方案再等回复，默认时间与数量不构成许可。
- 缺少授权时，支持的宿主可显示对话确认框，否则直接在当前对话等待自然回复；不要求固定口令，不提供插件批准入口。原生确认框填写修改意见时先修订方案，本次不执行。
- 评论触达支持完整发送预览、在对话明确同意后确认发送、替换待确认方案和取消/停止。不同已配对宿主的计划相互隔离，发送凭据绑定准备时的浏览器配对连接会话；原宿主重连后仍可查看、取消或重新准备方案，旧连接会话的凭据不能直接发送。修正旧版 Agent schema 曾误加的候选人数 `maxItems: 25`，人数、滚动预算、分组与风控以插件实际校验为准。
- 评论触达可按用户明确意图在对话开启或关闭；开启不发送，关闭停止剩余发送且不撤回已发消息，不开放额度或风控设置修改。
- 逐字稿扣费、清理和私信发送保留各自的实际预览、期限和范围检查。清理使用新版统一范围，旧范围确认不能扩大删除，清理结果不再写回数据池。
- 通用方案固定范围、归属和一次执行；同一方案的内部拆批及已声明重试不重复询问。修改待执行范围时替换旧方案；运行中先取消并核查状态，再准备新方案。
- 会话文字授权按 Agent 转述证据记录，不能独立验证用户来源。状态不明时先查原任务与已完成数据，避免重复执行；原生事件与文字转述不混称同一种批准凭据。

## 0.3.1 — 2026-08-27

- 保持 marketplace 和一条提示词安装入口不变，启动器自动选择当前系统和芯片对应的官方原生运行时。
- 新增 Windows x64、Windows ARM64 发布产物与原生 CI 冒烟，并继续覆盖 macOS x64/ARM64、Linux glibc/musl x64/ARM64。
- MCP 不再固定调用 `/bin/bash`；Windows 使用系统自带命令环境，macOS/Linux 使用 POSIX 启动器，普通用户不需要 Node、Bash、WSL 或 Git Bash。
- 运行时保存在宿主提供的持久插件数据目录，升级后自动准备新版且复用原有设备身份；安装异常时重复同一条提示词即可执行修复，无需卸载。
- 修复 standalone Broker 的 Bun WebSocket 传输与请求体上限，并在每个原生 runner 上验证 MCP、Broker、浏览器 WebSocket 和平台启动器。
- 新增账号采集方案准备与确认工具：先复用已有分析和原始数据，再按用户目标补齐缺口；需要多批执行时会展示建议量、完整目标、批次和风险等级。
- 扩展本地数据池与工作台资产读取能力，支持按条件检索、读取完整账号分析，并对较大报告和证据列表分页返回。
- 采集任务不再在连续额度边界静默缩量；用户确认后按声明批次继续，并按实际成功数量结算，失败、取消和未使用预留量自动释放。
- 优化单篇拆解工作流：已有报告优先复用，已有原始数据其次复用，确有缺口时才采集；换一批选题会过滤重复命题并自动补齐近、中、远三组结果。

## 0.3.0 — 2026-08-17

- 首次正式发布 MediaClaw Agent，支持 Codex 与 WorkBuddy 两个宿主。
- 统一发布 Skill、MCP 契约、共享 Broker、宿主 Adapter 和双宿主 marketplace。
- 默认承接内容研究、选题、策划、复盘、写作、改写和风格适配需求；用户明确拒绝工具或外部研究时尊重其选择。
- 支持读取既有 MediaClaw 资产、受控调用浏览器能力、长任务查询与取消，以及跨 Adapter 重启恢复。
- 加固宿主身份和任务结果隔离；浏览器未确认取消时不伪造终态，并保留部分结果。
- 提供面向普通用户的一句话升级：Agent 自行更新和验版，安装后要求完整重开宿主，并以新版 Adapter 的真实活动版本作为成功条件后续接原请求。
- 双宿主改用插件内稳定启动器解析当前安装目录，避免清单已更新但旧缓存 Runtime 仍在运行；正式版更新检查忽略 prerelease。

## 0.3.0-rc.2 — 2026-08-16

- Close the one-click upgrade loop: require explicit approval, run only fixed host commands, verify the installed version, return a projectless continuation task, and fence the old session from further MediaClaw calls.
- Persist in-flight task snapshots in the shared Broker so task status, cancellation, and eventual results survive Adapter replacement without repeating task execution.
- Wait for the browser's cancellation acknowledgement before reporting `cancelled`; preserve running state on rejection or timeout and retain partial results reported by the browser.
- Broaden MediaClaw's shared trigger across supported Agent hosts: content, topic selection, planning, research, review, drafting, rewriting, scripts, and style adaptation now default to MediaClaw unless the user explicitly opts out.
- Make implicit MediaClaw use visible with one concise explanation of what existing assets or evidence will be checked.
- Retry transient connection-status mismatches before asking users to repeat browser setup.

## 0.3.0-rc.1 — 2026-08-15

- 新会话首次使用时检查官方 Agent 版本；发现更新后先取得用户授权，再由 Agent 刷新 marketplace、验证版本并创建新版续接任务。
- 新版 Adapter 遇到仍在运行的旧版共享 Broker 时会触发安全重启，避免新任务继续复用旧 Runtime。
- V0.3 正式宿主范围收敛为 Codex 和 WorkBuddy。
- 移除其他宿主的 marketplace、桌面扩展、安装入口和用户说明。
- 同步最新 MCP 工具契约、共享 Broker、确认链路和取消终态修复。
- 保留底层适配代码作为未来兼容储备，但当前握手只接受 Codex/WorkBuddy。

## 0.3.0-alpha.1 — 2026-08-10

MediaClaw Agent 首个公开预览版：

- 提供首版 MediaClaw Agent 安装与连接预览。
- 支持在用户批准后连接 MediaClaw 浏览器插件。
- 支持读取已有内容资产，以及调用小红书、抖音的内容采集能力。
- 支持关键词、账号、对标和单篇内容研究。
- 支持基于已获证据完成选题、策划、内容生成和报告输出。
- 对需要会员、积分或人工确认的能力继续遵循 MediaClaw 插件中的提示。

这是 Alpha 版本，具体兼容性与可用能力请以当前 Release 说明和 MediaClaw 插件实际提示为准。
