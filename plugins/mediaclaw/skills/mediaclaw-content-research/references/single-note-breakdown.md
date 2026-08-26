# 单篇内容深度拆解方法

- Method ID: `single-note-breakdown-v1`
- Version: `3.0.0`
- Workbench contracts: `NOTE_BREAKDOWN_PROMPT_VERSION=1.8.0`，`VIDEO_NOTE_BREAKDOWN_PROMPT_VERSION=1.3.1`，`IMAGE_NOTE_ANALYSIS_PROMPT_VERSION=1.3.0`
- Tools: `mediaclaw_list_assets`、`mediaclaw_get_asset`；只有资产不足时才使用 `mediaclaw_capture_note` 与对应提取工具

## 目标

还原一篇内容如何建立承诺、组织信息和获得反馈，并将可迁移机制与不可复制素材分开。不要只做段落摘要。

## 默认证据

- 已有拆解：先查本地 Studio，再查远端工作台的同一作品 `note_breakdown`；命中后直接复用，不重复分析。
- 已采集原始资产：没有拆解时查本地数据池的同一作品 `capture_record`，读取 `identity/content/creator/metrics/media/comments/extractedContent/context` 全部所需分区。
- 单条内容详情：标题、正文、作者、发布时间、互动指标、作品链接、媒体地址和插件实际保存的其他字段。
- 单条评论：保持插件现有单条路径，不增加 Agent 专属条数限制；工作台核心提示最多消费 60 条评论时，Agent 也按相同上限选择有代表性的已保存评论，不把页面评论指标当成已保存内容。
- 图片：逐页图片、OCR、作者文案／引用文字／品牌文字／不确定文字与 UI 噪声分类，以及封面—标题共享分析。
- 视频：正文描述、封面—标题共享分析、真实逐字稿及可用的句级时间戳。缺失逐字稿时先报价，用户明确同意后再用 `quoteId` 确认。用户主动说“逐字稿／视频文案／口播文字／视频说了什么／字幕文字版”时应识别为提取需求；用户只说“分析／拆解这条视频”时，Agent 也必须在口播、叙事、语言或节奏证据必要且逐字稿缺失时主动报价。“帮我写视频文案”属于生成，不是提取。

缺少 OCR 或逐字稿时，继续分析已知的标题、正文和互动数据，但不得推断未读取的画面或口播。不得提供 BYOK、本地模型或其他供应商绕过参数。

同一作品已经存在采集记录但只缺 OCR、逐字稿或评论时，只补缺失分区，不重新采集整篇。用户明确要求“重新分析／更新”时可以重算报告，但仍复用已有原始资产并只补增量。

## 分析步骤

1. 先检查已有 `note_breakdown` 是否能回答当前问题；能回答就直接复用，并说明分析时间与覆盖，不重新运行以下步骤。
2. 没有已有拆解时，复原内容任务：
   - 写给谁
   - 发生在什么场景
   - 解决什么矛盾
   - 承诺什么变化
   - 希望用户采取什么行动
3. 使用与工作台相同的“相关→点击→开头停留→期待→留存→回报→互动”漏斗，并标记内容结构：
   - 标题与封面入口
   - 开头承诺
   - 信息展开
   - 证明与示范
   - 转折和异议处理
   - 行动引导
   - 结尾闭环
4. 合并正文、逐页 OCR 或真实逐字稿，判断标题与封面承诺是否真正兑现。图片按页分析内容推进、视觉与图文配合；视频按时间证据分析前 2 秒、前 5 秒、阶段推进、节奏、证明、回报和结尾。没有时间戳时不得猜精确秒数，没有视频画面时不得声称看到了镜头、字幕或剪辑。
5. 从评论中区分：
   - 被验证的吸引点
   - 未解决的问题
   - 反对或不信任
   - 行动和购买意图
   - 表达误读
6. 把结果分为：
   - 可迁移机制：结构、证明、信息顺序和形式。
   - 条件性机制：只有具备特定受众或资源时成立。
   - 不可复制素材：个人经历、成绩、案例和独特身份。
7. 给出一个最值得迁移的机制和一个最大风险，不堆砌技巧。用户还要求选题时，再按工作台契约生成 9 个近／中／远变化的新选题，每档 3 个，并说明保留机制、改变变量和与来源的真实差异。

## 输出契约

Agent 可以用自然语言向用户展示，但内部必须完成工作台同构字段，不得只输出一段概括：

1. `coreTakeaway/summary/confidence.level/reasons/limitations`
2. `sourceAnalysis.targetAudience/audienceSituation/audienceNeed/tension/coreThesis/viralMechanisms`
3. `sourceAnalysis.titleAnalysis/contentStructure/strengths/weaknesses/socialMediaFunnel`
4. `commentInsights.summary/audienceSignals/questions/disagreements/unmetNeeds/evidence`
5. 视频额外完成 `videoAnalysis.sourceAlignment/hook2s/expectation5s/timeline/pacing/trustAndProof/payoff/ending/spokenLanguage/dropOffRisks`；无口播或时间证据的字段留空并降级置信度。
6. 图文额外消费逐页分析、视觉风格、页面顺序、图文分工和承诺兑现证据，不得在高层结论里重复换词堆叠。
7. 面向用户补充可迁移、条件性和不可复制部分，以及一个首选机制和一个最大风险。
8. 用户需要创作时：
   - 选题：读取 [证据驱动选题方法](topic-ideation.md)。
   - 大纲：读取 [内容任务书方法](content-brief.md)。
   - 成稿：读取 [证据驱动成稿方法](content-drafting.md)。

最终向用户说明本次是复用已有拆解，还是基于已有原始数据新分析；同时报告详情、评论、OCR／逐页图片、逐字稿／时间戳覆盖和所用工作台契约版本。

## 禁止

- 表现数据不能证明具体因果。
- 不把评论样本当作全部受众。
- 不根据未提取的图片或口播虚构内容。
- 不直接复用原作者的个人经历、数据、案例或独特句子。
