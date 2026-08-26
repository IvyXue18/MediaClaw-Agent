# 账号内容策略方法

- Method ID: `account-content-strategy-v1`
- Version: `2.0.0`
- Workbench contract: `ACCOUNT_STYLE_ANALYSIS_PROMPT_VERSION=4.2.0`，`ACCOUNT_STYLE_PACK_SCHEMA_VERSION=3.7`
- Tools: `mediaclaw_list_assets`、`mediaclaw_get_asset`；只有资产不足时才使用 `mediaclaw_prepare_profile_collection`／`mediaclaw_confirm_profile_collection`

## 目标

回答账号在持续写什么、哪些方向相对有效、内容机制如何组合，以及下一阶段应保留、调整和验证什么。不要把它退化为高赞作品列表或人格标签。

## 证据输入

- 已有报告层：本地 Studio 或远端工作台中同一账号的 `account_analysis`。命中后直接复用，不重复分析。
- 基础层：同一账号最多 50 条作品列表数据；账号不足 50 条时使用全部可得作品。基础层分析完整标题语料、发布时间、内容类型和账号内部互动分布，不自动逐条打开详情页。
- 详情层：默认 15 条代表作品。与工作台一致，优先覆盖最多 5 条高表现、6 条接近账号中位水平的典型样本、4 条低表现样本；样本不足时按实际数量使用。
- 逐字稿层：最多 8 条代表视频。已有逐字稿直接复用；缺失逐字稿必须先报价并由用户确认。逐字稿既可由用户主动提出，也必须由 Agent 在分析需要口播、叙事、语言或节奏证据时主动提出。默认不新增提取；只分析标题、选题和表现分布时可以判断为不需要，分析视频内容机制、口播结构或语言风格时通常应建议最小样本。
- 视觉层：最多 12 个代表封面证据；没有真实图片输入时视觉结论保持缺失，不得从标题推断。
- 可选证据：主页指标、详情评论、图片逐页 OCR、真实已保存风格资产。

基础 50、详情 15 和封面 12 是账号新分析的工作台同构证据基线；逐字稿 8 是判断确有必要后的代表样本上限，不是默认提取量。不得把这些层级误解成“对 50 条作品全部打开详情、提取逐字稿”。已有数据只缺某一层时只补该层。

## 代表样本选择

详情层按工作台的高／典型／低表现分层选择；最终综合还必须在全部基础样本和可用详情中检查：

- 高表现样本：观察可能的放大机制。
- 近期样本：观察当前方向而非历史惯性；即使没有进入详情层，也要纳入列表级时间变化判断。
- 典型样本：观察账号最常见的稳定做法。
- 低表现或反例：防止把常见元素误判为成功原因。
- 不同内容形式：避免只分析一种载体；某种形式没有足够详情或逐字稿时，明确降级对应维度。

## 分析步骤

1. 按 TRACE 的 Terrain 检查平台、账号身份、分析时间、基础样本、详情、评论、OCR、逐字稿和封面覆盖。已有报告能回答当前问题时到此停止，不重算。
   没有可复用报告且需要新分析时，账号分析方案必须自动采用 50 条基础作品、15 条代表详情和 12 个封面证据，并显式记录逐字稿必要性决定。判断为需要时，完成代表详情选择后只为最多 8 条代表视频中缺少逐字稿的项目生成报价；判断为不需要时说明当前问题为何能由现有证据回答。展示作品、逐条积分、总积分、余额和有效期后，用户确认才提取。
2. 对全部基础样本计算账号内部点赞中位数、近期基线、异常峰值、内容类型占比和时间变化；不得只列最高赞，也不得用当前粉丝数倒推曝光率或历史表现。
3. 对完整标题语料提炼 3～6 种可执行标题方法。标题规律必须使用全部基础样本，不能只看有详情、逐字稿或高互动的作品。
4. 将作品归入 3～6 个边界清楚、尽量互斥的内容支柱／`topicPlaybooks`。每个支柱用“人群 × 场景 × 任务”定义，并列出全部样本、代表样本和反例。
5. 比较各支柱的发布占比、稳定表现、峰值、近期变化和高低表现差异。相关性只能写成表现观察，不能写成确定因果。
6. 从代表详情、OCR 和逐字稿提炼标题承诺、开头、信息递进、证明、回报、互动、语言和形式机制。视频与图文必须在各自类型内部比较；少于 3 条或缺少同题材对照时标记 `insufficient`。
7. 从至少 2 条真实样本重复出现的动作组合归纳 `contentFrameworks`；单条信号只能标记 `emerging`，证据不足允许为空。`topicPlaybooks` 回答写什么，`contentFrameworks` 回答怎么讲，两者不得混为一谈。
8. 区分：
   - 账号资产：长期重复且具有识别度的做法。
   - 表现机制：在高表现样本中更强、在反例中更弱的做法。
   - 偶发素材：依赖单个事件、身份或不可复制资源的做法。
9. 输出下一阶段策略：保留、放大、减少、试验，并为每项绑定 1～3 个真实 `sampleId`。需要选题时再单独生成 `ideaBank`，不得为了填选题挤压核心报告。

## 输出契约

Agent 可以用自然语言向用户展示，但内部必须完成工作台同构字段，不得退化为精简版摘要：

1. `report.coreTakeaway/summary/positioning/audienceNeed/contentPromise`
2. `report.contentPillars/topicPatterns/viralPatterns/audienceInsights`
3. `report.titleAnalysis/viewpointAnalysis/bodyAnalysis/formatAnalysis/visualSystem`
4. `report.scriptAnalysis/scriptLanguageStyle/frameworkStatus/contentFrameworks/scriptArchetypes`
5. `report.topicPlaybooks/learnable/avoid`
6. 用户需要选题时生成 `report.ideaBank/topicDirections`，每项说明保留的机制、改变的变量、与来源样本的差异及证据 ID。
7. `stylePack.coreIdentity/contentPillars/topicRules/titleRules/angleRules/viewpointRules/structureRules/languageStyle/visualRules/scriptLanguageStyle/contentFrameworks/diagnosisRubric/avoidRules/promptBriefs`
8. `evidenceIndex` 和 `confidence.level/reasons/limitations`

每个关键规则引用真实样本，视觉、正文、逐字稿或评论不可用时保持空结构并写入限制，不得用基础列表推测。最终向用户说明本次是复用已有报告，还是基于已有原始数据新分析；同时报告实际基础样本数、详情数、逐字稿数、封面／OCR／评论覆盖和分析契约版本。

## 禁止

- 不以粉丝量直接判断内容质量。
- 不根据列表标题推断完整叙事和视觉系统。
- 不把单篇爆款的个人经历包装成账号通用方法。
