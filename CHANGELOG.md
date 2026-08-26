# Changelog

## 0.3.1 — Unreleased

- 保持 marketplace 和一条提示词安装入口不变，启动器自动选择当前系统和芯片对应的官方原生运行时。
- 新增 Windows x64、Windows ARM64 发布产物与原生 CI 冒烟，并继续覆盖 macOS x64/ARM64、Linux glibc/musl x64/ARM64。
- MCP 不再固定调用 `/bin/bash`；Windows 使用系统自带命令环境，macOS/Linux 使用 POSIX 启动器，普通用户不需要 Node、Bash、WSL 或 Git Bash。
- 运行时保存在宿主提供的持久插件数据目录，升级后自动准备新版且复用原有设备身份；安装异常时重复同一条提示词即可执行修复，无需卸载。
- 修复 standalone Broker 的 Bun WebSocket 传输与请求体上限，并在每个原生 runner 上验证 MCP、Broker、浏览器 WebSocket 和平台启动器。

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
