---
name: mediaclaw-content-research
description: Use MediaClaw for evidence-based Xiaohongshu or Douyin research and content creation. Trigger when the user asks for keyword trends, content opportunities, long-tail demand, benchmark accounts, account strategy, recent hits, single-post breakdowns, evidence-backed topic ideas, content briefs, full drafts, or writing from a saved MediaClaw style profile. Collect with MediaClaw, apply the matching versioned method, and let the current Agent perform the reasoning and writing.
---

# MediaClaw 内容研究与生成

把 MediaClaw 当作“专有数据 + 专有方法”系统：

- MediaClaw 工具负责采集、清洗、抽样和客观统计。
- 本 Skill 提供分析、选题、策划、成稿和质量控制方法。
- 当前 Agent 负责运用模型能力执行方法，不得绕过方法直接泛化总结或自由发挥。

Agent 的分析、生成和报告输出不消耗 MediaClaw 积分。会员只控制插件现有的批量增强、远端工作台读取和提取能力；视频逐字稿按一次性报价单单独确认。

## 强制执行链

1. 第一次调用工具前执行 `mediaclaw_connection_status`。
2. 根据用户意图选择一个主要分析方法，完整读取对应 reference。
3. 任何分析或生成都先读取 [TRACE → BUILD 底层方法](references/evidence-to-content-framework.md)。
4. 先用 `mediaclaw_list_assets` 检查已有数据，命中后用 `mediaclaw_get_asset` 读取完整记录，避免重复采集。
5. 未命中时使用匹配的原子采集工具；用户明确范围覆盖默认参数。
6. 先完成 TRACE：证据地形、重复信号、受众矛盾、内容机制和执行机会。
7. 用户需要选题、大纲或成稿时，再读取对应生成方法并执行 BUILD。
8. 交付前读取并执行 [内容质量闸门](references/content-quality-gate.md)；失败项先修订。
9. 只向用户展示有用结论、证据、限制和成品，不展示冗长内部推理。

不得只调用工具后凭通用常识输出。不得把 `recommendedMethodId` 当作结论；它表示下一步必须执行的方法资产。

## 分析方法路由

| 用户意图 | 必读方法 | 首选工具 |
| --- | --- | --- |
| 关键词趋势、找机会、找爆款方向 | [关键词选题趋势](references/keyword-topic-trends.md) | `mediaclaw_capture_search_basic` |
| 长尾词、搜索需求、用户还在搜什么 | [长尾需求分析](references/keyword-longtail-demand.md) | `mediaclaw_research_longtail_keywords` |
| 研究整个账号、制定账号内容策略 | [账号内容策略](references/account-content-strategy.md) | `mediaclaw_capture_profile_basic`，必要时 `mediaclaw_enhance_records` |
| 找某个账号近期爆款 | [账号近期爆款](references/account-recent-hits.md) | `mediaclaw_research_account_hits` |
| 找赛道对标账号 | [对标账号发现](references/benchmark-account-discovery.md) | `mediaclaw_research_benchmark_accounts` |
| 拆解、复盘一篇内容 | [单篇内容深度拆解](references/single-note-breakdown.md) | `mediaclaw_capture_note` |

用户同时提出多个意图时，选择能回答核心决策的主方法；其他方法只在确实需要额外证据时追加，避免为了完整而过度采集。

## 内容生成路由

生成必须消费已经形成的 TRACE 结论或用户提供的可靠事实，不能只消费热门标题。

| 用户要的结果 | 必读方法 |
| --- | --- |
| 选题、内容方向、标题候选 | [证据驱动选题](references/topic-ideation.md) |
| 内容策划、创作方案、大纲 | [内容任务书](references/content-brief.md) |
| 完整图文、口播稿、视频脚本 | [证据驱动成稿](references/content-drafting.md) |
| 按已保存账号风格创作或改写 | [已保存账号风格适配](references/saved-account-style.md)，再叠加任务对应的选题／任务书／成稿方法 |

如果用户一句话同时要求“研究并直接写”，先在内部完成分析和任务书，再交付成稿；不要跳过中间方法。

## 证据层级与付费边界

### 无激活码也可用

- 单条笔记完整采集，以及单条路径已有的评论和博主指标。
- 搜索页和账号页基础列表采集；必须使用 `*_basic` 工具，不得隐式详情增强。
- 本地 data pool 和本地 Studio 中已经存在的数据；`list_assets` 的摘要只是索引，`get_asset` 返回完整记录。
- 基于已有数据完成分析、选题、内容生成、Markdown 或 HTML 报告。

### 需要有效会员

- `mediaclaw_enhance_records`：对搜索/账号列表记录批量进入详情页补采；执行前说明范围并取得用户确认。
- `remote.workbench` 中的拆解、账号分析、风格档案和生成内容读取。
- 图片 OCR。

### 积分与逐字稿

先调用 `mediaclaw_quote_video_transcript(recordIds)`。向用户展示逐条预计积分、总额、余额和有效期；只有用户明确同意后，才把返回的 `quoteId` 原样传给 `mediaclaw_confirm_video_transcript`。不得代替用户确认，不得提供 BYOK、本地模型或第三方供应商参数。

没有深采权益时继续交付免费结论，并降低机制判断的置信度。不得把分析包装成失败或称为付费能力。

## 代表样本规则

需要增强时，从已有列表中选择能回答问题的最小充分样本，至少覆盖：

- 高表现样本
- 中等或典型样本
- 低表现或反例
- 近期样本
- 不同内容形式

只选择高赞内容会失去基线和反例，禁止这样抽样。

## 风格档案规则

用户要求按某账号风格创作时：

1. 先从 `local.studio` 的 `style_profile` / `account_analysis` 查询；需要远端时再查 `remote.workbench`。
2. 使用 `mediaclaw_get_asset(assetId)` 读取完整对象后才能使用其中的风格结论。
3. 重名时根据平台、主页链接和更新时间消除歧义；无法确定时请用户确认。
4. 没有真实资产时不得根据账号名猜测风格。

## 用户要求优先级

按以下顺序处理冲突：

1. 事实完整性、证据可追溯、隐私、版权和禁止编造。
2. 用户明确指定的范围、目标、身份、观点和输出形式。
3. 对应版本化方法的默认规则。
4. Agent 的一般表达优化。

## 工具补充

- 原子关键词扫描：`mediaclaw_capture_search_basic`
- 联想词采集：`mediaclaw_expand_keywords`
- 账号基础列表：`mediaclaw_capture_profile_basic`
- 单篇完整详情：`mediaclaw_capture_note`
- 单条评论：`mediaclaw_capture_comments`
- 批量详情增强：`mediaclaw_enhance_records`
- 图片 OCR：`mediaclaw_extract_image_text`
- 视频逐字稿：`mediaclaw_quote_video_transcript`、`mediaclaw_confirm_video_transcript`
- 当前任务数据分页：`mediaclaw_query_dataset`
- 统一资产：`mediaclaw_list_assets`、`mediaclaw_get_asset`
- 任务状态／取消：`mediaclaw_task_status`、`mediaclaw_cancel_task`

MCP Tasks 可用时优先由客户端托管长任务。客户端不支持时保持一次调用等待；只有用户明确稍后查看时才传 `async: true`。

## 异常和付费引导

- 连接断开：保留任务句柄，提示在插件设置中开启本机 Agent 调用；恢复后查询原任务。
- 登录或验证码：说明正在等待用户在浏览器处理，不得声称采集失败。
- 筛选未成功：按实际采集范围分析并说明偏差。
- 样本不足：交付有限结论，标明置信度和最小补证据动作。
- 返回 `paywall`：停止重试，先交付当前结论，再说明 `availableNow` 和 `unlockBenefit`，最后只展示一个 `actionLabel` 与 `actionUrl`。
- `upgrade` 不是广告。只有现有证据不足以支持用户要求的结论，或用户明确要求更高置信度时才建议。
- 积分不足：说明 `requiredCredits`、`remainingCredits`、`shortfallCredits`，并明确云端任务尚未开始。
