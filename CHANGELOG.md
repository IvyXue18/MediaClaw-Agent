# Changelog

## 0.3.0-alpha.1 — 2026-08-10

首个公开预览版：

- 提供 Codex 与 Claude Code 的插件清单、共享 Skill 和 MCP 工具契约。
- 将本机连接拆分为共享 Broker 与每宿主薄 adapter；Codex、Claude Code 等宿主各自拥有独立设备身份、配对、会话和撤销边界。
- 浏览器采集任务全局串行，并按发起设备隔离任务查询、取消、恢复和结果返回。
- 支持 macOS arm64/x64 与 Linux arm64/x64 的免 Node.js 单文件运行时；发布资产附带 SHA-256 校验和与 GitHub 构建来源证明。
- 保持浏览器插件为页面访问、采集、会员、积分和人工确认的唯一执行与授权边界。

已知限制：

- WorkBuddy 只有候选清单，尚未完成真实宿主安装与端到端验收。
- Windows 自动运行时尚未接入启动器。
- 浏览器内“官方来源已验证”标记尚未接入 Release attestation。
- 会员、积分、OCR 与逐字稿需要继续完成真实激活码验收；本版本不支持 BYOK 或本地转录绕过。
