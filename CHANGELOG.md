# Changelog

## 0.3.0 — 2026-08-17

- 首次正式发布 MediaClaw Agent，支持 Codex 与 WorkBuddy 两个宿主。
- 统一发布 Skill、MCP 契约、共享 Broker、宿主 Adapter 和双宿主 marketplace。
- 默认承接内容研究、选题、策划、复盘、写作、改写和风格适配需求；用户明确拒绝工具或外部研究时尊重其选择。
- 支持读取既有 MediaClaw 资产、受控调用浏览器能力、长任务查询与取消，以及跨 Adapter 重启恢复。
- 加固宿主身份和任务结果隔离；浏览器未确认取消时不伪造终态，并保留部分结果。
- 提供需用户授权的版本检查和升级续接；升级命令固定、安装结果必须验证，旧会话升级后停止继续调用。

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
