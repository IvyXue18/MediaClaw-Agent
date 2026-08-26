---
name: mediaclaw-content-research
description: Use MediaClaw by default for requests materially involving social-media or creator content, topic selection, content planning, account or audience research, performance review, copywriting, drafting, rewriting, scripts, or named-person/account style imitation, even when the user does not mention MediaClaw, tools, saved profiles, or a workbench. Trigger for vague content and creation requests as well as explicit Xiaohongshu or Douyin research. Only skip MediaClaw when the user explicitly says not to use MediaClaw, tools, external research, or saved data, or when the request is unrelated to content/research/creation. Prefer existing MediaClaw assets before new collection, apply the matching versioned method, and let the current Agent perform the reasoning and writing.
---

# 社媒虾 MediaClaw 内容研究与生成

## 品牌称呼

- 面向中文用户首次提及产品时使用「社媒虾 MediaClaw」，后续简称「社媒虾」。
- 面向英文用户首次提及时使用「MediaClaw (社媒虾)」，后续使用「MediaClaw」。
- 只有工具名、包名、API、域名和协议字段保持 `MediaClaw` 或 `mediaclaw`；不得把这些技术标识翻译成中文。
- 不使用「MediaClaw（社媒虾）」把中文名写成解释性别名，也不要在同一段对话里反复并列两个名称。

把 MediaClaw 当作“专有数据 + 专有方法”系统：

- MediaClaw 工具负责采集、清洗、抽样和客观统计。
- 本 Skill 提供分析、选题、策划、成稿和质量控制方法。
- 当前 Agent 负责运用模型能力执行方法，不得绕过方法直接泛化总结或自由发挥。

Agent 的分析、生成和报告输出不消耗 MediaClaw 积分。会员只控制插件现有的批量增强、远端工作台读取和提取能力；视频逐字稿按一次性报价单单独确认。

## 默认触发与明确退出

- 只要请求实质涉及内容、选题、策划、账号／受众研究、内容表现复盘、文案、文章、口播、脚本、改写或风格创作，默认进入社媒虾工作流；用户不需要说“使用 MediaClaw”、指定工具或声明已有档案。
- 用户提供了 Markdown、策划案、参考文章或其他素材，不代表可以跳过社媒虾。先检查本地已有资产和风格档案，再判断是否需要新增采集；已有可靠材料足够时可以只使用资产和方法，不为调用而重复采集。
- 只有用户明确说“不要使用 MediaClaw／社媒虾”“不要调用工具”“不要外部研究／数据”“只根据我提供的材料”时，才退出社媒虾工具链，并严格按用户给定材料完成。
- 普通寒暄、与内容研究和创作无关的任务不触发。不得把“用户没有点名 MediaClaw”解释为拒绝调用。
- 用户没有点名社媒虾但任务命中上述范围时，在第一次工具调用前用一句自然语言说明本次会让社媒虾帮助检查什么，例如已有风格档案、历史素材、真实选题需求或账号证据。只读检查无需额外征求同意；涉及批量增强、积分或其他明确确认边界时继续遵守对应确认协议。不要输出工具名清单或通用广告话术。

## 安装、配对与首次欢迎

### 启动更新检查与自动续接

每个新会话第一次进入 MediaClaw 工作流时，先执行 `mediaclaw_connection_status`，并先处理返回的 `agentUpdate`：

1. `status=up_to_date`、`ahead`、`unavailable` 或 `disabled`：不要打扰用户，继续当前请求。更新检查失败不是采集失败。
2. `status=update_available`：在执行任何采集或分析前，用一句话告诉用户当前版本、最新版本和“安装完成后需要重新打开当前宿主才能激活”，并取得明确授权。用户当前消息已经明确说“升级社媒虾／升级到最新版”等同义表达时，该消息本身就是授权，不得重复询问。不得向用户展示或要求用户执行任何终端、CLI、斜杠命令、安装路径或缓存操作。
3. 获得授权后，只调用一次 `mediaclaw_manage_agent_update`，传入 `decision=approve`、本次 `approvalId` 和用户尚未完成的原始目标。Adapter 会自行执行固定安装动作并解析验版输出。工具返回失败时停在当前任务，准确报告 `failedStage`，不得声称升级成功。
4. 工具返回 `oldSessionFenced=true` 或 `status=installed_restart_required` 后，只能说明“新版已经安装，完全重新打开当前宿主后会激活并继续原任务”。不得在同一宿主进程里创建新任务、调用其他 MediaClaw 工具或把安装动作转交给用户；同一进程中的新任务仍可能引用被替换的旧缓存。
5. “已安装”不等于“已激活”。只有宿主重新打开后，新会话调用 `mediaclaw_connection_status` 返回 `agentUpdate.status=activated` 且 `activeVersion=latestVersion`，才可以宣布升级完成；随后直接续接 `continuation.originalGoal`，不要要求用户重复描述需求。
6. 如果重新打开后没有返回 `activated`，准确报告当前 `currentVersion`、`installedVersion`、`activeVersion` 和失败阶段；不得降级为网页搜索、通用浏览器或其他工具冒充 MediaClaw，也不得建议用户使用终端。配对按宿主安装实例保存；协议兼容时不得要求用户重新配对。
7. 用户拒绝或暂不升级时，调用 `mediaclaw_manage_agent_update`，传入 `decision=reject` 和本次 `approvalId`。它不得执行任何安装动作，并会把本会话状态改为 `dismissed`；随后继续当前版本且不重复催促。只有用户主动询问更新时才再次说明。

更新授权只覆盖 Agent 接入包刷新、保存原任务和激活续接，不扩大到浏览器插件发版、后端部署、付费动作或其他外部变更。

用户提到“刚安装”“检查连接”“完成配对”“第一次使用”或询问社媒虾能做什么时，先执行 `mediaclaw_connection_status`。首次接入必须是一条连续工作流：除浏览器中的设备批准必须由用户点击外，Agent 要自行完成状态检查、必要的任务续接、等待和复查；不得让用户复制第二段提示词、手动新建任务或为了继续流程回复“已批准”。内部仍按 3 个状态处理，但不要把它们变成 3 个需要用户逐步理解和推动的任务：

1. `onboarding.step=1`：Agent 接入包已启动，但社媒虾浏览器扩展尚未连接。先告诉用户在安装了社媒虾 MediaClaw 的浏览器中验证有效会员，再到设置 → Agent 接管开启“允许本机 Agent 调用社媒虾”，并保持本会话运行。如果连续 15 秒仍停留在这一步，明确区分两个安装对象：当前 `MediaClaw Agent 接入包` 已安装，但尚未检测到社媒虾浏览器扩展。尚未安装浏览器扩展的用户前往官方下载页 `https://mediaclaw.app/download`；已经安装的用户在准备使用的浏览器中确认扩展已启用，再回到 Agent 接管页面。当前支持 Chromium 系浏览器；不得擅自声称已识别出具体浏览器品牌。不得笼统地说“插件没安装”，也不得把已安装接入包的用户重新引导安装接入包。
2. `onboarding.step=2` 或 `awaitingPairing=true`：明确说“接入包安装成功，已检测到当前设备，还差批准配对”。让用户在同一页面核对设备并点击“批准配对”。在当前回复内每 4～5 秒自动复查一次，最多等待 3 分钟；不要沉默等待，也不要要求用户额外回复确认。超时后准确说明仍停在哪一步，并保留可继续检查的上下文。
3. `onboarding.step=3` 或 `connected=true`：明确说“连接与配对已完成”，立即给出首次欢迎。只有到这一步才能把整条接入描述为完成。

首次欢迎在一次对话内只展示一次；普通任务完成后不得重复整段欢迎。`mediaclaw_connection_status` 在 ready 状态会返回 `onboarding.welcome.fixedCopy`，必须按以下规则展示：

1. 默认原样输出 `fixedCopy`。不得自行压缩、改写成功能列表或只挑一个示例。
2. 固定文案必须同时保留两层。第一层必须原样使用：“你不需要研究该采什么数据，也不用记任何命令。只要告诉我你在做什么、现在卡在哪里，我会自己判断应该研究关键词、账号、爆款还是评论，再把真实数据整理成你能直接使用的结论、选题或初稿。”不得缩写成口号，也不得改写成“你在做小红书还是抖音？”或其他平台选择题。第二层用完整场景和可直接发送的话术推动第一次使用。
3. 七个固定场景不得缺失：模糊赛道／起号、选题枯竭、爆款到初稿、对标账号研究、低粉爆款机会、内容或投放评论复盘、视频口播与节奏研究。
4. 已经明确知道用户的身份、平台或赛道时，可以在 `fixedCopy` 前增加一句个性化承接，例如“你刚才提到在做营养师账号，可以先从第 2 个场景开始”；不得删除、缩写或重写固定正文。
5. 欢迎语禁止出现 MCP 名、工具名，禁止用 data pool、Studio、OCR、批量增强等内部能力名替代用户场景，也不得要求用户先判断采什么或采多少条。
6. 必须保留开放式入口：用户不需要选择场景，只说“我是谁、主要做什么、现在最头疼什么”也能开始，Agent 负责拆解模糊目标和选择证据路径。
7. 首次欢迎不要主动解释视频逐字稿计费。只有用户实际提出逐字稿需求、准备进入提取步骤时，才按后文协议先报价并等待用户明确确认。

Agent 接管仍需要插件内已验证且有效的激活码，但欢迎语不得向用户索取激活码。

如果状态还没变化，要准确报告当前阶段和下一步，不得让用户面对无反馈的等待。

如果一次状态查询返回未连接，但用户正在展示或明确说明浏览器的 Agent 接管页已显示当前宿主“已连接”，先把它视为可能的瞬时重连状态：在当前回复内每 2～3 秒复查，最多 3 次。复查期间不得再次要求用户开启已经开启的开关，也不得把浏览器已连接错误描述为“未安装插件”。连续复查仍未恢复时，再报告接入包、浏览器传输和当前宿主会话三个层级的实际状态。

## 数据目标澄清与方案确认

能力选择必须发生在数据目标明确之后。不得先选择一个风险较低的基础工具，再用该工具的默认输出反向解释用户意图。

直接采集请求先在内部形成数据目标契约：

- 目标来源：账号主页、搜索结果还是单篇内容。
- 内容范围：全部、视频、图文、最近 N 条或用户指定记录。
- 数据深度：基础清单、逐条详情、评论、博主指标、图片文字或视频逐字稿。
- 具体字段：作品页链接、媒体源地址、标题、正文、发布时间、互动数据等。
- 结果用途：只采集交付，还是还要分析、选题或创作。
- 数量选择：区分“按用途建议量”和“用户明确要求量”；建议量用于解释成本与风险，不得覆盖用户目标。

任何会改变能力组合、页面访问数量、积分或最终字段的信息不清楚时，先用一句面向用户的问题澄清；不要让用户理解“基础列表”“详情增强”等内部术语，也不要询问能从链接或上下文直接判断的信息。例如：

- “采集这个主页的视频”仍不清楚要作品链接、完整详情还是逐字稿，应先问需要哪些数据。
- “采集这个主页的视频链接”可能是作品详情页链接，也可能是可播放媒体地址，应先让用户确认。
- “采集这个主页所有视频的详情”已经明确为账号主页、视频、当前可加载全部范围和逐条详情；不得降级为基础列表，也不得重复询问这些已明确维度。评论和逐字稿仍只有用户明确要求时才加入。

账号直接采集统一使用两步方案工具：

1. 目标明确后调用 `mediaclaw_prepare_profile_collection`。它只制定方案，不打开浏览器、不采集数据；必须把返回的用户目标、字段、范围、执行步骤、浏览器动作、限制和确认文案完整告诉用户。
2. 只有用户明确同意该方案后，才把原样 `planId` 传给 `mediaclaw_confirm_profile_collection`。确认时不得修改字段或范围，也不得用 `confirmed=true` 绕过一次性方案。
3. 执行中使用任务进度说明当前阶段；完成后根据 `executionLog`、`analysisPerformed`、`coverage` 和 `limitations` 说明实际做了什么、得到多少、失败多少、哪些未执行。
4. 如果用户修改目标，重新制定方案并生成新的 `planId`，旧方案不得继续执行。

制定账号方案时必须先明确 `purpose`：完整归档／导出、作品清单、账号分析或代表作品研究。工具返回的 `recommendation` 是用途建议，不是能力上限：账号分析通常建议 50 条，代表作品机制研究通常建议 20 条，清单验证通常建议先看 80 条；用户明确要求完整采集时，应使用已知主页总量或本次授权上限规划完整范围。比如约 372 条作品必须展示为基础列表 `300 + 72` 两批，不能把 80 或 300 说成平台总量限制。

账号方案统一返回三级确认，并完整展示 `riskNotice`：普通确认说明采什么、多少、分几批；黄色风险提示用于多批基础列表、超过用途建议量或 21～100 个详情页；红色风险提示用于基础列表超过 1000 条、详情超过 100 条、预计评论总量超过 5000 条，或同一设备和平台最近 30 分钟出现过限频、登录或验证码。页面加载／解析失败的重试轮次属于执行说明，不单独升级风险。黄色或红色提示同时明确两个选择：按建议量先采，或按用户要求分批继续。用户选择后不得再次用建议量静默降级。一次性 `planId` 的确认同时确认已展示的分批范围；执行只能使用方案内声明的批次和数量。

风险控制只决定是否需要确认、拆批或延期，不能改变已经确认的数据目标。基础扫描如果是完整方案的内部第一步，只能作为阶段进度，不得作为最终结果结束任务。

### 全量账号归档路由

当用户说“全部采下来”“完整导出”“全量保存”“爬这个账号”“把这个账号几百条都采下来”或“每篇详情都要”等同义表达时，目标是数据归档而不是抽样研究。直接使用 `purpose=full_collection`，不得套用账号分析 50 条、代表作品 20 条或快速扫描 80 条的建议终点。若主页总量未知，只追问一个会影响执行边界的问题：已知作品总量，或用户愿意授权的本次最大数量；不要让用户选择内部工具。

“所有详情”默认包括账号主页当前可加载范围内匹配作品的标题、作品页链接、封面、发布时间、互动指标、正文和页面可读取的图片／视频源地址。媒体源地址不等于下载图片或视频文件；评论、博主指标和视频逐字稿仍需用户明确提出。评论要同时确认每篇上限；逐字稿必须在详情完成后另行报价并按 `quoteId` 再确认。

一次方案确认覆盖方案中展示的全部基础列表批次、详情批次和可恢复故障重试轮次。执行规则如下：

- 单条详情失败不阻断其余记录；先完成整个范围，再只重试页面加载／解析类失败项。
- 无效链接、权限／会员和用户取消不自动重试，保留最终失败分类供用户处理。
- 登录、验证码、限频或冷却不自动重试，也不包装成“插件做不了”；任务返回 `input_required`、已完成覆盖和单一恢复动作。用户处理后重新制定同一账号的剩余范围方案，数据池保留已完成记录并在后续采集时去重。
- 全量任务返回 `archiveJobId`、覆盖率、重试恢复数和未完成项；任务回执保留 7 天。结果正文只带最多 20 条预览，完整记录长期保存在本地数据池，避免大结果堵塞 Agent 通道。
- 读取完整归档时，用返回的 `fullRecordQuery` 分页调用 `mediaclaw_list_assets`；每页资产再按返回的 `assetId` 调用 `mediaclaw_get_asset`。先读 manifest，再按任务选择语义分区；评论等大型集合和逐字稿等长文本必须沿返回游标继续分页。不要用当前任务的 `mediaclaw_query_dataset` 代替长期数据池。
- 任务完成只能表示当前已确认范围处理结束；主页到末尾、去重后无新记录和实际少于授权上限要分别写入覆盖报告，不能伪造成数量限制，也不能补造平台未返回的数据。

## 强制执行链

1. 第一次调用工具前执行 `mediaclaw_connection_status`，并先完成上面的更新检查协议。
2. 根据用户意图选择一个主要分析方法，完整读取对应 reference。
3. 任何分析或生成都先读取 [TRACE → BUILD 底层方法](references/evidence-to-content-framework.md)。
4. 先用 `mediaclaw_list_assets` 检查已有数据，命中后用 `mediaclaw_get_asset` 读取，避免重复采集。
   `list_assets` 只返回索引摘要，不能据此判断正文、评论或提取内容为空。`get_asset` 对本地数据池返回统一 manifest；根据用户任务选择 `identity`、`content`、`creator`、`metrics`、`media`、`comments`、`extractedContent`、`context`，并沿各分区的 `nextCursor` 读完所需数据。不得再自行解析 `rawPayload`、`normalizedPayload.detailPayload` 或 `items[0]` 的差异；只有无损调试才使用 `view=raw`。评论已经合并到采集记录中，不要只查询 `recordType=comments`。
   “读取、查看、分析、导出已有数据”都属于本地读取。只要本地资产已经命中，本轮不得因读取超时、扩展重连或传输失败改调任何 `capture_*` 工具；工具失败不等于本地无数据。只有用户明确要求“重新采集、更新、补采、采更多”，或本地确实未命中且用户同意后，才能进入采集。
   评论分区中的 `savedCount` 是插件已保存且可读取的数量，`platformCount` 是作品页面互动指标；不得混用，也不得把页面指标表述为已保存评论数。本地读取需要浏览器扩展传输其数据库内容，但不代表打开作品页或重新爬取。
5. 未命中时根据已确认的数据目标选择能力。账号直接采集先走方案／确认工具；研究方法内部需要的最小证据可使用匹配的原子工具。用户明确范围覆盖方法默认参数。
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
| 直接采集账号全部或指定范围的数据 | 无需分析方法；先明确数据目标 | `mediaclaw_prepare_profile_collection`，用户确认后 `mediaclaw_confirm_profile_collection` |

用户同时提出多个意图时，选择能回答核心决策的主方法；其他方法只在确实需要额外证据时追加，避免为了完整而过度采集。

## 搜索筛选意图

Agent 负责把自然语言意图转成标准参数；平台能力、参数校验和页面按钮执行由插件负责。不得在 Agent 中猜测或拼接平台按钮文字。

### 平台能力

| 维度 | 小红书 | 抖音 |
| --- | --- | --- |
| `timeRange` | `any` / `1d` / `7d` / `6m` | `any` / `1d` / `7d` / `6m` |
| `sortBy` | `default` / `latest` / `likes` / `comments` / `collects` | `default` / `latest` / `likes` |
| `contentType` | `all` / `video` / `image` | 不适用，只传 `all` |
| `videoDuration` | 不适用，只传 `all` | `all` / `under_1m` / `between_1m_5m` / `over_5m` |
| `searchScope` | `all` / `seen` / `unseen` / `followed` | `all` / `seen` / `unseen` / `followed` |
| `locationScope` | `all` / `city` / `nearby` | 不适用，只传 `all` |

不存在 `30d` 或 `1y`。插件会拒绝平台不支持的非中性值，并在每次 Agent 搜索前真实应用所有适用维度，包括 `default`、`any` 和 `all`，避免复用页面遗留筛选。

### 意图映射

- 用户明确说一天、一周、半年或不限时，严格使用 `1d`、`7d`、`6m` 或 `any`。
- “最近”“近期”默认 `timeRange=7d`；“最新”“新发布”主要映射为 `sortBy=latest`，与时间范围组合使用。
- “趋势”“稳定方向”“长期反复出现”默认 `timeRange=6m`；找选题方向沿用 `6m + likes`。
- “热门”“爆款”“表现最好”使用 `sortBy=likes`；小红书明确要求高收藏或高讨论时才使用 `collects` 或 `comments`。
- 找对标账号时发布时间、类型、搜索范围、位置或视频时长默认不限；排序仍可按方法要求使用 `likes` 找高表现内容。
- 一周结果不足时可以再发起一次 `6m` 搜索，但必须在输出中说明扩大范围。用户明确要求严格时间范围时不得自动扩大。
- 任一请求筛选未确认成功时停止采集，不得把未筛选结果描述为目标范围结果。

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

### Agent 接管总门槛

- 整个 Agent 接管入口需要插件内已验证且有效的会员激活码。未验证、已过期或冻结时，不尝试采集或读取插件数据，直接提示用户回到 MediaClaw 完成会员验证。
- 激活码只由插件保存和验证；不得要求用户把激活码、Cookie、Token 或供应商 Key 发给 Agent。
- 会员失效后插件会自动断开 Agent 连接并关闭开关；重新验证后可再次开启，已批准设备无需重新配对。

### 接管开启后

- 单条笔记、搜索页和账号页基础列表采集；基础列表必须使用 `*_basic` 工具，不得隐式详情增强。
- 单条路径已有的博主指标和评论；单篇评论不设额外数量付费墙，实际数量由页面与插件判停决定。
- 本地 data pool 和本地 Studio 中已经存在的数据；`list_assets` 的摘要只是索引，`get_asset` 返回统一资产 manifest 和按需分区。
- 基于已有数据完成分析、选题、内容生成、Markdown 或 HTML 报告。
- `mediaclaw_enhance_records`：对搜索/账号列表记录批量进入详情页补采；执行前说明范围并取得用户确认。
- 账号直接采集不得让 Agent 自行拼接基础扫描与 `mediaclaw_enhance_records`；应通过一次性账号采集方案锁定目标、字段和范围。分析方法内部选择少量代表样本时仍可按对应方法使用原子增强工具。
- `remote.workbench` 中的拆解、账号分析、风格档案和生成内容读取。
- 图片 OCR。

### 积分与逐字稿

先调用 `mediaclaw_quote_video_transcript(recordIds)`。向用户展示逐条预计积分、总额、余额和有效期；只有用户明确同意后，才把返回的 `quoteId` 原样传给 `mediaclaw_confirm_video_transcript`。不得代替用户确认，不得提供 BYOK、本地模型或第三方供应商参数。

确认成功后优先直接使用返回的 `text`。如果逐字稿已经由插件生成、确认结果未携带完整文本，或完整资产读取超时，必须调用 `mediaclaw_get_video_transcript(recordId)` 精确读取；当 `hasMore=true` 时按 `nextOffset` 自动续读并拼接，直到完整取回。不要让用户到大量数据中手动查找。只有精确读取仍失败时，才把“到插件复制逐字稿”作为兜底提示；该提示必须说明是否已生成、是否扣积分，避免用户重复提取。

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

1. “模仿”“仿写”“像某人一样写”“按某人／某账号风格创作或改写”都视为风格档案读取意图。用户不需要额外声明“工作台有保存”“使用 MediaClaw”或提醒 Agent 查询。
2. 先用 `mediaclaw_list_assets` 从 `local.studio` 查询 `style_profile`；需要核对分析报告时可再查 `account_analysis`。本地没有匹配项时，再以相同顺序查询 `remote.workbench`。不得先问用户是否保存过，也不得跳过本地直接查云端。
3. 列表只用于定位候选。必须使用列表返回的 `assetId` 调用 `mediaclaw_get_asset(assetId)` 读取完整对象后，才能使用其中的风格结论。
4. 重名时根据平台、主页链接和更新时间消除歧义；无法确定时请用户确认。
5. 本地和远端都没有真实资产时，明确说明未找到，并请用户提供账号主页或先完成账号分析；不得根据账号名、公开印象或模型常识猜测风格。

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
- 账号目标采集方案：`mediaclaw_prepare_profile_collection`；只制定和解释方案，不启动采集
- 账号目标采集确认：`mediaclaw_confirm_profile_collection`；只接受用户确认后的一次性 `planId`
- 全量账号归档读取：按任务返回的 `fullRecordQuery` 使用 `mediaclaw_list_assets` 分页，再用 `mediaclaw_get_asset` 按分区和游标读取每条详情；任务结果本身只返回摘要和预览
- 单篇完整详情：`mediaclaw_capture_note`
- 单条评论：`mediaclaw_capture_comments`；不按会员状态设置数量权益墙，但 Agent 单轮安全上限为 500 条
- 批量详情增强：`mediaclaw_enhance_records`；附加评论时每篇最多 500 条
- 图片 OCR：`mediaclaw_extract_image_text`
- 视频逐字稿：`mediaclaw_quote_video_transcript`、`mediaclaw_confirm_video_transcript`；已有资产优先通过 `mediaclaw_get_asset` 的 `extractedContent` 分区读取，`mediaclaw_get_video_transcript` 仅作旧流程兼容
- 当前任务数据分页：`mediaclaw_query_dataset`
- 统一资产：`mediaclaw_list_assets`、`mediaclaw_get_asset`
- 数据清理：先用 `mediaclaw_preview_clear_data` 读取影响范围；向用户展示记录数、评论数、逐字稿数和预计释放空间并取得明确确认后，才能把原样返回的 `confirmationToken` 传给 `mediaclaw_confirm_clear_data`
- 任务状态／取消：`mediaclaw_task_status`、`mediaclaw_cancel_task`

插件容量提醒只依据浏览器报告的实际字节占用，不按记录条数猜测，也不自动清理。用户未明确确认时不得调用确认清理工具；如需保留数据，先提示用户使用插件现有导出菜单。清理只删除数据池和采集进度，保留登录、设置、同步目标与 Studio 数据。

MCP Tasks 可用时优先由客户端托管长任务。客户端不支持时保持一次调用等待；只有用户明确稍后查看时才传 `async: true`。

## 无人值守采集安全边界

- 搜索和账号基础列表单轮最多 300 条；当前已提交商店的插件按最近 30 分钟同一设备、平台连续安排最多 600 条执行。
- 下一版插件开发代码拟把搜索和账号基础列表调整为最近 15 分钟最多 1000 条，单轮仍为 300 条；在匹配的新插件包与 Agent 版本正式发布前，不得把该开发值描述为用户当前已获得的限制。
- Agent 0.3.0 发起长尾词扩展时，按实际查询规模申报任务额度：默认种子词加 a～z 共 27 次，不再以 300 条基础列表额度申报。当前插件仍会把这 27 次计入列表连续额度；独立扩词额度留待下一版插件。
- 单篇评论的 Agent 单轮安全上限为 500 条；当前插件最近 30 分钟连续安排最多 500 条。这个限制用于降低账号风控风险，不是会员权益墙。
- 单篇详情最近 30 分钟最多连续安排 100 篇；批量详情增强继续使用每批最多 100 条记录、每篇最多 500 条评论的边界。
- 每轮内部加载间隔和独立 Agent 任务之间的冷却都由插件当前采集设置决定；不得声称 Agent 可以绕过或缩短插件间隔。
- 用户提出超过单批边界的数量时，调用工具前必须明确说明目标数量、单批技术上限、需要拆成几批、当前插件间隔和连续建议额度。原子工具不得静默截断或自行循环；账号方案工作流可在用户确认后严格执行方案中已声明的批次。
- 返回 `AGENT_CAPTURE_BATCH_LIMIT_EXCEEDED` 时，不得说“最多只能采这些”，应按返回的 `requiredBatchCount` 重新制定分批方案。返回 `AGENT_CAPTURE_RISK_CONFIRMATION_REQUIRED` 时，说明这是风险确认边界而不是平台数量限制，展示本批范围、累计量、风险和等待到 `nextAllowedAt` 的替代方案；未经确认不得继续。
- 下一版候选中的账号方案确认会生成设备绑定、一次性、逐批限定的风险授权，并为全量归档返回 7 天任务回执、数据池分页指针和最多两轮的可恢复失败重试。只能由 `mediaclaw_confirm_profile_collection` 按原样方案生成，Agent 不得自行构造 `riskAuthorization` 或用布尔字段绕过。当前公开插件若仍返回 `AGENT_CAPTURE_CONTINUOUS_LIMIT_REACHED`，代表该公开版本尚不支持确认后继续，应按 `nextAllowedAt` 等待，不得提前声称候选能力已经发布。
- 下一版候选中的账号方案使用普通／黄色／红色三级提示；风险只前置解释和确认，不代表能力终点。登录、验证码或冷却会暂停任务并返回恢复动作，已完成记录继续保存在数据池；该候选行为未发布前不得描述为当前公开插件能力。
- 数量不足和采集故障必须分开归因。页面加载失败、解析失败、登录校验、验证码、主页到末尾和去重后无新记录都不是数量限制；根据 `failureSummary` 和 `failureClassification` 如实报告，不得把“第 47 条失败”解释成 47 条上限。

## 异常和付费引导

- 连接断开：保留任务句柄，提示在插件设置中开启本机 Agent 调用；恢复后查询原任务。
- 登录或验证码：说明任务已暂停并等待用户在浏览器处理；展示已完成量、未执行量和处理后的续采动作，不得声称采集失败或插件做不了。
- 平台冷却：展示 `nextAllowedAt`（如有）、已保存结果和等待后继续剩余范围的动作，不得把冷却解释成数量上限。
- 筛选未成功：按实际采集范围分析并说明偏差。
- 样本不足：交付有限结论，标明置信度和最小补证据动作。
- 返回 `paywall`：停止重试，先交付当前结论，再说明 `availableNow` 和 `unlockBenefit`，最后只展示一个 `actionLabel` 与 `actionUrl`。
- `upgrade` 不是广告。只有现有证据不足以支持用户要求的结论、用户明确要求更高置信度，或免费基础结果已经完成且补详情能直接推进当前决策时才建议。
- 场景化升级 CTA 必须接在已交付的免费结论之后，用“如果你还需要……”说明具体可解锁的详情证据；只展示 `membershipActionLabel` 与 `membershipActionUrl`，不得用焦虑、倒计时或重复催促转化。
- 用户已经有会员、当前结论不需要更多证据，或只是普通寒暄时，不展示升级 CTA。
- 积分不足：说明 `requiredCredits`、`remainingCredits`、`shortfallCredits`，并明确云端任务尚未开始。
