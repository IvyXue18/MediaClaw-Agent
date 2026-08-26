#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {AsyncLocalStorage} from "node:async_hooks";
import METHOD_REGISTRY from "../contracts/methods-v1.json" with {type: "json"};
import MCP_CONTRACT from "../contracts/mcp-v1.json" with {type: "json"};
import {compareVersions} from "./agent-update.mjs";
import {createLoopbackWebSocketServer} from "./websocket-server.mjs";
import {
  buildDeviceProofPayload,
  loadOrCreateDeviceIdentity,
  resolveStateDirectory,
} from "./device-identity.mjs";

const SERVER_NAME = "mediaclaw-agent-broker";
const SERVER_VERSION = MCP_CONTRACT.serverVersion;
const PROTOCOL_VERSION = MCP_CONTRACT.protocolVersion;
const DEFAULT_PORT = Number(process.env.MEDIACLAW_AGENT_PORT || 17373);
const DEFAULT_SCAN_LIMIT = 80;
const MAX_SCAN_LIMIT = 300;
const DEFAULT_KEYWORD_EXPANSION_QUERY_LIMIT = 27;
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_ARCHIVE_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const LOCAL_ASSET_QUEUE_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.MEDIACLAW_LOCAL_ASSET_QUEUE_TIMEOUT_MS || 5 * 60_000),
);
const LOCAL_ASSET_EXECUTION_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.MEDIACLAW_LOCAL_ASSET_EXECUTION_TIMEOUT_MS || 2 * 60_000),
);
const TASK_WATCHDOG_INTERVAL_MS = Math.max(
  50,
  Number(process.env.MEDIACLAW_TASK_WATCHDOG_INTERVAL_MS || 5_000),
);
const CAPTURE_START_ACK_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.MEDIACLAW_CAPTURE_START_ACK_TIMEOUT_MS || 45_000),
);
const BRIDGE_HTTP_ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;
const BRIDGE_RPC_BODY_LIMIT_BYTES = 1024 * 1024;
const ADAPTER_TTL_MS = Number(
  process.env.MEDIACLAW_AGENT_ADAPTER_TTL_MS || 45_000,
);
const ADAPTER_SWEEP_INTERVAL_MS = Number(
  process.env.MEDIACLAW_AGENT_ADAPTER_SWEEP_MS || 15_000,
);
const BROKER_IDLE_TIMEOUT_MS = Number(
  process.env.MEDIACLAW_AGENT_BROKER_IDLE_MS || 5 * 60_000,
);
const MAX_RESULT_TRANSFER_CHUNKS = 1024;
const MAX_RESULT_TRANSFER_CHARS = 32 * 1024 * 1024;
const PROFILE_COLLECTION_PLAN_TTL_MS = 15 * 60 * 1000;
const TASK_CANCEL_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.MEDIACLAW_AGENT_CANCEL_TIMEOUT_MS || 10_000),
);
const AGENT_PRICING_URL =
  "https://mediaclaw.app/pricing?source=agent";
const BROWSER_EXTENSION_DOWNLOAD_URL = "https://mediaclaw.app/download";
const OFFICIAL_BROWSER_EXTENSION_IDS = new Set([
  "ihclbgfnkclacfkbedkdnbpmkcdaccje",
  "moalagonhjmhmoiaehciejkkingpajpl",
]);
const AGENT_FIRST_USE_VALUE_PROMISE =
  "你不需要研究该采什么数据，也不用记任何命令。只要告诉我你在做什么、现在卡在哪里，我会自己判断应该研究关键词、账号、爆款还是评论，再把真实数据整理成你能直接使用的结论、选题或初稿。";
const AGENT_FIRST_USE_FIXED_COPY = [
  "社媒虾 MediaClaw 已连接好了。",
  "",
  AGENT_FIRST_USE_VALUE_PROMISE,
  "",
  "下面这些情况，都可以直接交给我：",
  "",
  "1. 想做一个方向，但不知道从哪里切入",
  "   你可以说：‘我想做小红书家居收纳账号，但现在完全没有方向。先帮我看清这个赛道，找出新号更容易切入的机会，再给我两周选题。’",
  "   我会帮你看清竞争格局、用户需求、低粉爆款和可切入方向，最后落到一份能执行的选题安排。",
  "",
  "2. 每天都在发，但下一篇不知道写什么",
  "   你可以说：‘我是营养师，这周不知道发什么。帮我看看用户最近在搜什么、评论区反复问什么，给我 10 个真正有人需要的选题。’",
  "   我会从真实搜索需求和评论问题里找选题，不让你继续靠感觉硬想。",
  "",
  "3. 刷到一篇爆款，想借鉴但不想照抄",
  "   你可以说：‘这篇内容很火：〈内容链接〉。帮我拆清楚它为什么有效、评论区还在追问什么，再给我 5 个适合我账号的新角度。选出最值得做的一个，写成初稿。’",
  "   我会把可借鉴的选题、结构和表达机制，与原作者不可复制的身份、经历和素材分开，再生成属于你的新内容。",
  "",
  "4. 找到一个对标账号，但看不懂究竟该学什么",
  "   你可以说：‘这是我想研究的账号：〈主页链接〉。不要只总结它发了什么，帮我找出它最近真正稳定有效的选题、标题和内容结构，再告诉我哪些适合我、哪些我学不了。’",
  "   我会区分偶然爆款和稳定规律，给你可以学习的做法、适用条件和不能照搬的部分。",
  "",
  "5. 刚起号，想找普通账号也能复制的机会",
  "   你可以说：‘我刚起号，不想只研究几十万粉的大博主。帮我找这个赛道里的低粉高赞内容，分析它们靠什么跑出来，再给我一套适合小账号执行的选题方案。’",
  "   我会优先找账号体量与你更接近、但单篇表现突出的样本，避免用大号流量误导你的判断。",
  "",
  "6. 发过一批内容或做完投放，想知道用户真实怎么想",
  "   你可以说：‘这些是我们最近发布或投放的内容：〈多个链接〉。帮我汇总评论里的共性反馈、购买顾虑和反复追问，再告诉我下一轮内容应该补什么。’",
  "   我会把评论从热闹的互动区变成需求、异议、选题和潜在线索，给出下一步行动。",
  "",
  "7. 看到一条不错的视频，想研究口播和节奏",
  "   你可以说：‘帮我研究这条视频：〈视频链接〉。我想知道它的开头为什么能留人、内容怎么推进、哪些方法可以改成适合我的脚本。’",
  "   我会把视频里的开头、推进、表达和节奏拆开，告诉你哪些方法值得借鉴，并把可迁移的方法变成适合你的脚本方向。",
  "",
  "如果你不想挑场景，也可以只告诉我三件事：你是谁、主要做什么、现在最头疼什么。比如：‘我是做本地餐饮的，想做小红书，但不知道顾客会搜什么。’剩下该看哪些词、采哪些内容、研究哪些账号，我来判断。",
  "",
  "你现在最想解决哪件事？",
].join("\n");
const AGENT_FIRST_USE_GUIDE = Object.freeze({
  title: "社媒虾 MediaClaw 已连接好了",
  structure: "fixed_two_layer_scenario_onboarding",
  firstLayer: AGENT_FIRST_USE_VALUE_PROMISE,
  scenarios: Object.freeze([
    Object.freeze({id: "new_direction", title: "想做一个方向，但不知道从哪里切入"}),
    Object.freeze({id: "content_drought", title: "每天都在发，但下一篇不知道写什么"}),
    Object.freeze({id: "viral_to_draft", title: "刷到一篇爆款，想借鉴但不想照抄"}),
    Object.freeze({id: "account_strategy", title: "找到对标账号，但看不懂究竟该学什么"}),
    Object.freeze({id: "small_account_opportunity", title: "刚起号，想找普通账号也能复制的机会"}),
    Object.freeze({id: "comment_feedback", title: "发过一批内容或做完投放，想知道用户真实怎么想"}),
    Object.freeze({id: "video_script", title: "看到一条不错的视频，想研究口播和节奏"}),
  ]),
  fixedCopy: AGENT_FIRST_USE_FIXED_COPY,
  presentationPolicy: Object.freeze({
    default: "原样展示 fixedCopy，不把它改写成功能列表。",
    allowedAdaptation:
      "已经明确知道用户的角色、平台或赛道时，可以在 fixedCopy 前补充一句个性化承接；不得删除、缩写或改写 fixedCopy。",
    forbidden:
      "不得罗列工具名、MCP 名、Studio、OCR、批量增强等内部能力替代用户场景；不得只给一个示例；不得要求用户先决定采什么数据，也不得把第一层改写成‘你在做小红书还是抖音？’或其他平台选择题。",
  }),
  openEndedStart:
    "如果不想挑场景，只需告诉我：你是谁、主要做什么、现在最头疼什么，剩下的由我判断。",
  membershipPolicy: "Agent 接管需要插件内已验证且有效的会员激活码。",
});
const KEYWORD_TOPIC_METHOD_ID = "keyword-topic-trends-v1";
const KEYWORD_LONGTAIL_METHOD_ID = "keyword-longtail-demand-v1";
const ACCOUNT_HITS_METHOD_ID = "account-recent-hits-v1";
const BENCHMARK_ACCOUNT_METHOD_ID = "benchmark-account-discovery-v1";
const SINGLE_NOTE_METHOD_ID = "single-note-breakdown-v1";
const BROKER_STATE_DIRECTORY = resolveStateDirectory();
const requestContext = new AsyncLocalStorage();
const adapters = new Map();
const adapterTokens = new Map();
const deviceSessions = new Map();
const METHOD_BY_ID = new Map(
  METHOD_REGISTRY.methods.map((method) => [method.id, method]),
);
const MAX_DEEP_COLLECT_LIMIT = 100;
const MAX_TRANSCRIPT_QUOTE_ITEMS = 20;
const MAX_PROFILE_COLLECTION_PLAN_ITEMS = 10_000;
const MAX_PROFILE_ARCHIVE_RESULT_PREVIEW = 20;
const DEFAULT_PROFILE_ARCHIVE_RETRY_PASSES = 1;
const MAX_PROFILE_ARCHIVE_RETRY_PASSES = 2;
const PROFILE_DETAIL_YELLOW_THRESHOLD = 20;
const PROFILE_DETAIL_RED_THRESHOLD = 100;
const PROFILE_COMMENT_RED_TOTAL_THRESHOLD = 5_000;
const PROFILE_RECENT_RISK_SIGNAL_WINDOW_MS = 30 * 60 * 1000;
const ACCOUNT_ANALYSIS_DETAIL_TARGET = 15;
const ACCOUNT_ANALYSIS_TRANSCRIPT_TARGET = 8;
const ACCOUNT_ANALYSIS_COVER_TARGET = 12;
const PROFILE_COLLECTION_PURPOSES = Object.freeze({
  full_collection: Object.freeze({
    label: "完整归档或导出",
    recommendation: "requested_scope",
    rationale: "完整性就是目标，应按主页已知或估算总量制定分批方案。",
  }),
  inventory_export: Object.freeze({
    label: "作品清单或链接导出",
    recommendation: 80,
    rationale: "80 条通常足以先验证字段和导出格式，再决定是否覆盖完整主页。",
  }),
  account_analysis: Object.freeze({
    label: "账号内容与风格分析",
    recommendation: 50,
    rationale: "账号分析最多使用 50 条作品，继续增加基础列表通常不会提高分析输入覆盖。",
  }),
  representative_research: Object.freeze({
    label: "代表作品与内容机制研究",
    recommendation: 20,
    rationale: "优先补齐 20 条代表作品详情，通常比机械打开全部详情更适合解释内容机制。",
  }),
});
const PROFILE_COLLECTION_BASIC_FIELDS = Object.freeze([
  "title",
  "post_page_url",
  "cover",
  "publish_time",
  "engagement_metrics",
]);
const PROFILE_COLLECTION_DETAIL_FIELDS = Object.freeze([
  "content_text",
  "media_urls",
  "comments",
  "blogger_metrics",
  "video_transcript",
]);
const ACCOUNT_ANALYSIS_REQUIRED_FIELDS = Object.freeze([
  "account_profile",
  ...PROFILE_COLLECTION_BASIC_FIELDS,
  "content_text",
  "media_urls",
]);
const PROFILE_COLLECTION_FIELD_LABELS = Object.freeze({
  account_profile: "账号主页信息",
  title: "作品标题",
  post_page_url: "作品详情页链接",
  cover: "封面",
  publish_time: "发布时间",
  engagement_metrics: "点赞、收藏、评论等互动数据",
  content_text: "作品正文",
  media_urls: "详情页可获取的图片或视频媒体地址",
  comments: "作品评论",
  blogger_metrics: "详情页可获取的博主指标",
  video_transcript: "视频逐字稿（另需报价确认）",
});
const AGENT_DEEP_CAPTURE_UPGRADE = Object.freeze({
  featureKey: "capture.enhancement",
  requiresCredential: true,
  positioning: "evidence_upgrade_not_agent_analysis",
  title: "按需补齐详情证据",
  message:
    "基础列表可以直接用于分析；只有在需要解释正文、视觉或互动机制时，再选择最小充分样本进行详情增强。",
  actionLabel: "选择记录并补采详情",
  maxSampleCount: MAX_DEEP_COLLECT_LIMIT,
  suggestOnlyWhen: Object.freeze([
    "现有样本不足以支持高置信度结论",
    "需要解释标题、正文、视觉或互动机制",
    "用户明确要求更完整的证据",
  ]),
  unlocks: Object.freeze([
    "所选代表内容的完整详情",
    "更完整的正文与互动证据",
    "可选评论与博主指标补采",
  ]),
});

const tasks = new Map();
const idempotentTaskIds = new Map();
const resultTransfers = new Map();
const pendingTaskCancellations = new Map();
const profileCollectionPlans = new Map();
const TASK_STATE_PATH = path.join(BROKER_STATE_DIRECTORY, "tasks-v1.json");
let taskStateWrite = Promise.resolve();
const extensionPeers = new Set();
let extensionPeer = null;
let extensionInfo = null;
let activeExtensionTaskId = "";
const recoveredTaskIds = [];
let bridgeStatus = {
  listening: false,
  host: "127.0.0.1",
  port: DEFAULT_PORT,
  error: null,
};
let brokerUpgradeScheduled = false;

function buildConnectionOnboarding({connected = false, awaitingPairing = false} = {}) {
  if (connected) {
    return {
      stage: "ready",
      step: 3,
      stepCount: 3,
      statusLabel: "连接与配对已完成",
      nextAction: {
        type: "start_first_task",
        label: "直接告诉我你在做什么、现在最头疼什么",
      },
      welcome: AGENT_FIRST_USE_GUIDE,
    };
  }
  if (awaitingPairing) {
    return {
      stage: "awaiting_approval",
      step: 2,
      stepCount: 3,
      statusLabel: "接入包已安装，等待批准配对",
      nextAction: {
        type: "approve_in_extension",
        label: "到安装了社媒虾的浏览器 → 社媒虾 → 设置 → Agent 接管中批准当前设备",
      },
      welcome: null,
    };
  }
  return {
    stage: "waiting_for_extension",
    step: 1,
    stepCount: 3,
    statusLabel: "接入包已启动，等待浏览器插件连接",
    nextAction: {
      type: "enable_extension",
      label: "在安装了社媒虾的浏览器中打开扩展设置并开启 Agent 接管；尚未安装浏览器扩展时前往官方下载页",
    },
    browserExtension: {
      status: "not_detected",
      productName: "社媒虾 MediaClaw 浏览器扩展",
      supportedBrowserFamily: "Chromium",
      downloadUrl: BROWSER_EXTENSION_DOWNLOAD_URL,
      installedHelp:
        "如果已经安装，请在准备使用的浏览器中确认扩展已启用，再打开设置 → Agent 接管。",
    },
    welcome: null,
  };
}

function normalizeHostKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (
    ["claude", "claude-code", "claude-desktop", "claude-cowork"].includes(
      normalized,
    )
  ) {
    return "claude";
  }
  return normalized || "agent";
}

function defaultHostDisplayName(hostKey) {
  if (hostKey === "codex") return "MediaClaw Agent (Codex)";
  if (hostKey === "claude") return "MediaClaw Agent (Claude)";
  if (hostKey === "workbuddy") return "MediaClaw Agent (WorkBuddy)";
  return `MediaClaw Agent (${hostKey})`;
}

function publicDevice(adapter) {
  return {
    deviceId: adapter.identity.deviceId,
    publicKey: adapter.identity.publicKey,
    fingerprint: adapter.identity.fingerprint,
    displayName: adapter.displayName,
    host: adapter.hostKey,
    adapterVersion: adapter.adapterVersion,
    agentChannel: adapter.agentChannel,
  };
}

async function ensureAdapterIdentity({
  hostKey,
  displayName,
  adapterVersion,
  agentChannel,
}) {
  const normalizedHostKey = normalizeHostKey(hostKey);
  let adapter = adapters.get(normalizedHostKey);
  if (!adapter) {
    const identity = await loadOrCreateDeviceIdentity({
      host: normalizedHostKey,
      displayName: displayName || defaultHostDisplayName(normalizedHostKey),
      stateDirectory: path.join(
        BROKER_STATE_DIRECTORY,
        "hosts",
        normalizedHostKey,
      ),
    });
    adapter = {
      hostKey: normalizedHostKey,
      displayName: displayName || identity.displayName,
      adapterVersion: adapterVersion || SERVER_VERSION,
      agentChannel: agentChannel === "local" ? "local" : "release",
      identity,
      instances: new Map(),
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    adapters.set(normalizedHostKey, adapter);
  } else {
    adapter.displayName = displayName || adapter.displayName;
    adapter.adapterVersion = adapterVersion || adapter.adapterVersion;
    adapter.agentChannel = agentChannel === "local" ? "local" : "release";
    adapter.lastSeenAt = Date.now();
  }
  disconnectIncompatibleExtension(adapter);
  return adapter;
}

function getAdapterByDeviceId(deviceId) {
  return [...adapters.values()].find(
    (adapter) => adapter.identity.deviceId === deviceId,
  );
}

function adapterSession(adapter) {
  return adapter ? deviceSessions.get(adapter.identity.deviceId) || null : null;
}

function extensionAllowedForAdapter(adapter, extensionId) {
  return !(
    adapter?.agentChannel === "local" &&
    OFFICIAL_BROWSER_EXTENSION_IDS.has(normalizeText(extensionId, 200))
  );
}

function disconnectIncompatibleExtension(adapter) {
  const session = adapterSession(adapter);
  if (!session || extensionAllowedForAdapter(adapter, session.extensionId)) {
    return;
  }
  const rejectedPeer = extensionPeer;
  deviceSessions.delete(adapter.identity.deviceId);
  extensionPeer = null;
  extensionInfo = null;
  rejectedPeer?.close(
    1008,
    "The local MediaClaw Agent candidate only accepts a local browser extension",
  );
}

function announceAdapter(adapter) {
  for (const peer of extensionPeers) {
    peer.send({
      type: "device.hello",
      protocolVersion: PROTOCOL_VERSION,
      device: publicDevice(adapter),
    });
  }
}

function recommendedMethod(methodId) {
  const method = METHOD_BY_ID.get(methodId);
  if (!method) {
    throw new Error(`Unknown MediaClaw method: ${methodId}`);
  }
  return {
    recommendedMethodId: method.id,
    recommendedMethodVersion: method.version,
    recommendedMethod: {
      id: method.id,
      version: method.version,
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix = "task") {
  return `${prefix}_${Date.now().toString(36)}_${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}

function normalizeLimit(value, fallback = DEFAULT_SCAN_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(MAX_SCAN_LIMIT, Math.max(1, Math.floor(number)));
}

function keywordExpansionQueryLimit(suffixLetters) {
  if (!Array.isArray(suffixLetters)) {
    return DEFAULT_KEYWORD_EXPANSION_QUERY_LIMIT;
  }
  const normalizedSuffixes = new Set(
    suffixLetters
      .map((item) => String(item || "").trim().toLowerCase())
      .filter((item) => /^[a-z]$/.test(item)),
  );
  return 1 + normalizedSuffixes.size;
}

function normalizePlatform(value) {
  const platform = String(value || "xiaohongshu").trim().toLowerCase();
  return platform === "douyin" ? "douyin" : "xiaohongshu";
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeKeywordFilterEnum(value, allowed, fallback, dimension) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (!allowed.includes(normalized)) {
    throw new Error(
      `不支持的筛选参数 ${dimension}=${normalized}；可选值：${allowed.join(", ")}`,
    );
  }
  return normalized;
}

function normalizeKeywordTimeRange(value) {
  return normalizeKeywordFilterEnum(
    value,
    ["any", "1d", "7d", "6m"],
    "any",
    "timeRange",
  );
}

function normalizeKeywordSortBy(value) {
  return normalizeKeywordFilterEnum(
    value,
    ["default", "latest", "likes", "collects", "comments"],
    "default",
    "sortBy",
  );
}

function normalizeKeywordContentType(value) {
  return normalizeKeywordFilterEnum(
    value,
    ["all", "image", "video"],
    "all",
    "contentType",
  );
}

function normalizeKeywordVideoDuration(value) {
  return normalizeKeywordFilterEnum(
    value,
    ["all", "under_1m", "between_1m_5m", "over_5m"],
    "all",
    "videoDuration",
  );
}

function normalizeKeywordSearchScope(value) {
  return normalizeKeywordFilterEnum(
    value,
    ["all", "seen", "unseen", "followed"],
    "all",
    "searchScope",
  );
}

function normalizeKeywordLocationScope(value) {
  return normalizeKeywordFilterEnum(
    value,
    ["all", "city", "nearby"],
    "all",
    "locationScope",
  );
}

const SEARCH_FILTER_CAPABILITIES = Object.freeze({
  xiaohongshu: Object.freeze({
    timeRange: Object.freeze(["any", "1d", "7d", "6m"]),
    sortBy: Object.freeze(["default", "latest", "likes", "comments", "collects"]),
    contentType: Object.freeze(["all", "video", "image"]),
    searchScope: Object.freeze(["all", "seen", "unseen", "followed"]),
    locationScope: Object.freeze(["all", "city", "nearby"]),
  }),
  douyin: Object.freeze({
    timeRange: Object.freeze(["any", "1d", "7d", "6m"]),
    sortBy: Object.freeze(["default", "latest", "likes"]),
    videoDuration: Object.freeze([
      "all",
      "under_1m",
      "between_1m_5m",
      "over_5m",
    ]),
    searchScope: Object.freeze(["all", "seen", "unseen", "followed"]),
  }),
});

const SEARCH_FILTER_NEUTRAL_VALUES = Object.freeze({
  timeRange: "any",
  sortBy: "default",
  contentType: "all",
  videoDuration: "all",
  searchScope: "all",
  locationScope: "all",
});

function assertPlatformSearchFilterSupported(platform, dimension, value) {
  const capabilities = SEARCH_FILTER_CAPABILITIES[platform];
  const supported = capabilities?.[dimension];
  const neutral = SEARCH_FILTER_NEUTRAL_VALUES[dimension];
  if (!supported) {
    if (value !== neutral) {
      throw new Error(
        `${platform} 不支持筛选参数 ${dimension}=${value}`,
      );
    }
    return null;
  }
  if (!supported.includes(value)) {
    throw new Error(
      `${platform} 不支持筛选参数 ${dimension}=${value}；可选值：${supported.join(", ")}`,
    );
  }
  return value;
}

function keywordSortDimension(sortBy) {
  return sortBy === "likes" || sortBy === "collects" || sortBy === "comments"
    ? sortBy
    : undefined;
}

function normalizeText(value, max = 1000) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeProfileCollectionPlatform(value, profileUrl = "") {
  const requested = normalizeText(value, 80).toLowerCase();
  if (requested) return normalizePlatform(requested);
  const url = normalizeText(profileUrl);
  if (/douyin\.com/i.test(url)) return "douyin";
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return "xiaohongshu";
  throw new Error("无法从主页链接识别平台，请先明确是小红书还是抖音");
}

function normalizeProfileCollectionFields(value, {allowEmpty = false} = {}) {
  const allowed = new Set([
    "account_profile",
    ...PROFILE_COLLECTION_BASIC_FIELDS,
    ...PROFILE_COLLECTION_DETAIL_FIELDS,
  ]);
  const fields = [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => normalizeText(item, 80).toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (fields.length === 0 && !allowEmpty) {
    throw new Error("requestedFields 不能为空；请先明确用户要获取哪些数据");
  }
  const unknown = fields.filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new Error(`不支持的数据字段：${unknown.join(", ")}`);
  }
  return fields;
}

function normalizeProfileCollectionCount(value, fallback = DEFAULT_SCAN_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return Math.max(1, Math.floor(Number(fallback) || DEFAULT_SCAN_LIMIT));
  }
  if (number > MAX_PROFILE_COLLECTION_PLAN_ITEMS) {
    throw new Error(
      `单个一次性方案最多声明 ${MAX_PROFILE_COLLECTION_PLAN_ITEMS} 条；更大的目标需要拆成多个可审计方案，不能静默截断`,
    );
  }
  return Math.max(1, Math.floor(number));
}

function splitProfileCollectionBatches(total, batchLimit) {
  const batches = [];
  let remaining = normalizeProfileCollectionCount(total, 1);
  while (remaining > 0) {
    const count = Math.min(batchLimit, remaining);
    batches.push(count);
    remaining -= count;
  }
  return batches;
}

function profileCollectionRecommendation(purpose, requestedCount) {
  const policy = PROFILE_COLLECTION_PURPOSES[purpose];
  const recommendedCount =
    policy.recommendation === "requested_scope"
      ? requestedCount
      : Math.min(requestedCount, policy.recommendation);
  return {
    purpose,
    purposeLabel: policy.label,
    requestedCount,
    recommendedCount,
    followsRecommendation: requestedCount <= recommendedCount,
    userScopePreserved: true,
    rationale: policy.rationale,
    decision:
      requestedCount > recommendedCount
        ? "用户目标超过建议样本量；确认后仍按用户要求的完整范围执行"
        : "用户目标处于建议范围内",
  };
}

function profileCollectionRiskLevel({
  requestedCount,
  recommendedCount,
  detailTargetCount,
  scanBatchCount,
  estimatedCommentCount,
  recentRiskSignalCount,
}) {
  if (
    requestedCount > 1000 ||
    detailTargetCount > PROFILE_DETAIL_RED_THRESHOLD ||
    estimatedCommentCount > PROFILE_COMMENT_RED_TOTAL_THRESHOLD ||
    recentRiskSignalCount > 0
  ) {
    return "red";
  }
  if (
    requestedCount > recommendedCount ||
    scanBatchCount > 1 ||
    detailTargetCount > PROFILE_DETAIL_YELLOW_THRESHOLD
  ) {
    return "yellow";
  }
  return "normal";
}

function recentProfileCollectionRiskSignals(adapter, platform) {
  const ownerDeviceId = profileCollectionPlanOwner(adapter);
  const cutoff = Date.now() - PROFILE_RECENT_RISK_SIGNAL_WINDOW_MS;
  const signalsByKey = new Map();
  for (const task of tasks.values()) {
    if (task?.owner?.deviceId !== ownerDeviceId) continue;
    const updatedAtMs = Date.parse(String(task.updatedAt || ""));
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= cutoff) continue;
    const rawTaskPlatform =
      task.captureTask?.platform || task.input?.platform || "";
    const taskPlatform = rawTaskPlatform
      ? normalizePlatform(rawTaskPlatform)
      : "";
    if (taskPlatform && platform && taskPlatform !== platform) continue;
    const candidates = [
      task.error,
      task.result?.error,
      task.result?.executionInterruption?.error,
      task.result?.failureSummary?.profile?.error,
      ...(task.result?.failureSummary?.scanBatches || []).map(
        (item) => item.error,
      ),
      ...(task.result?.failureSummary?.detailItems || []).map(
        (item) => item.error,
      ),
    ].filter(Boolean);
    for (const error of candidates) {
      const classification = classifyProfileCollectionFailure(error);
      if (
        !["platform_cooldown", "user_action_required"].includes(
          classification,
        )
      ) {
        continue;
      }
      const code = normalizeText(error?.code || error?.reason, 160);
      const signalKey = `${classification}:${code}`;
      const signal = {
        classification,
        code,
        occurredAt: task.updatedAt,
        message:
          classification === "platform_cooldown"
            ? "近期同一设备和平台出现过限频或冷却"
            : "近期同一设备和平台出现过登录或验证码校验",
      };
      const existing = signalsByKey.get(signalKey);
      if (
        !existing ||
        Date.parse(String(signal.occurredAt || "")) >
          Date.parse(String(existing.occurredAt || ""))
      ) {
        signalsByKey.set(signalKey, signal);
      }
    }
  }
  return [...signalsByKey.values()]
    .sort(
      (left, right) =>
        Date.parse(String(right.occurredAt || "")) -
        Date.parse(String(left.occurredAt || "")),
    )
    .slice(0, 5);
}

function profileCollectionPlanOwner(adapter) {
  return normalizeText(adapter?.identity?.deviceId, 160);
}

function profileCollectionContentLabel(contentType) {
  if (contentType === "video") return "视频作品";
  if (contentType === "image") return "图文作品";
  return "全部作品";
}

function isProfileCollectionVideoEntry(entry = {}, platform = "") {
  const noteType = normalizeText(entry.noteType, 80).toLowerCase();
  return (
    noteType === "video" ||
    noteType === "视频" ||
    noteType.includes("video") ||
    Boolean(entry.basic?.videoUrl) ||
    (platform === "douyin" && noteType !== "image")
  );
}

function publicProfileCollectionPlan(plan = {}) {
  return {
    planId: plan.planId,
    status: plan.usedAt ? "confirmed" : "awaiting_confirmation",
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    userGoal: plan.userGoal,
    intent: plan.intent,
    collectionScope: plan.collectionScope,
    requestedFields: plan.requestedFields,
    requestedData: plan.requestedData,
    recommendation: plan.recommendation,
    analysisContract: plan.analysisContract,
    archive: plan.archive,
    riskNotice: plan.riskNotice,
    solution: plan.solution,
    browserActions: plan.browserActions,
    safetyBoundaries: plan.safetyBoundaries,
    limitations: plan.limitations,
    confirmation: {
      required: true,
      startsCollection: false,
      nextTool: "mediaclaw_confirm_profile_collection",
      confirmationArgument: {planId: plan.planId},
      prompt: plan.confirmationPrompt,
    },
  };
}

function createProfileCollectionPlan(input = {}, adapter = null) {
  const cleanupBefore = Date.now() - PROFILE_COLLECTION_PLAN_TTL_MS;
  for (const [planId, existing] of profileCollectionPlans) {
    const usedAt = Date.parse(String(existing.usedAt || ""));
    if (
      existing.expiresAtMs <= Date.now() ||
      (Number.isFinite(usedAt) && usedAt <= cleanupBefore)
    ) {
      profileCollectionPlans.delete(planId);
    }
  }
  const profileUrl = normalizeText(input.profileUrl);
  try {
    const parsed = new URL(profileUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    throw new Error("profileUrl 必须是有效的账号主页链接");
  }
  const userGoal = normalizeText(input.userGoal, 1200);
  if (!userGoal) {
    throw new Error("userGoal 不能为空；请保留用户已经确认的数据目标");
  }
  const platform = normalizeProfileCollectionPlatform(input.platform, profileUrl);
  const contentType = normalizeEnum(
    input.contentType,
    ["all", "video", "image"],
    "all",
  );
  const coverage = normalizeEnum(
    input.coverage,
    ["all_available", "latest"],
    "all_available",
  );
  const purpose = normalizeEnum(
    input.purpose,
    Object.keys(PROFILE_COLLECTION_PURPOSES),
    "",
  );
  if (!purpose) {
    throw new Error("purpose 不能为空；请先明确用户采集这些数据是为了什么");
  }
  const userRequestedFields = normalizeProfileCollectionFields(
    input.requestedFields,
    {allowEmpty: purpose === "account_analysis"},
  );
  const userRequestsTranscript = userRequestedFields.includes(
    "video_transcript",
  );
  const requestedAnalysisTranscriptDecision = normalizeEnum(
    input.analysisTranscriptDecision,
    ["recommend", "not_needed"],
    "",
  );
  const analysisTranscriptReason = normalizeText(
    input.analysisTranscriptReason,
    800,
  );
  const analysisTranscriptDecision =
    contentType === "image"
      ? "not_applicable"
      : userRequestsTranscript
        ? "user_requested"
        : requestedAnalysisTranscriptDecision;
  if (
    purpose === "account_analysis" &&
    contentType !== "image" &&
    !analysisTranscriptDecision
  ) {
    throw new Error(
      "账号分析必须先判断逐字稿是否会显著提升当前任务：请设置 analysisTranscriptDecision=recommend 或 not_needed",
    );
  }
  if (
    purpose === "account_analysis" &&
    ["recommend", "not_needed"].includes(analysisTranscriptDecision) &&
    !analysisTranscriptReason
  ) {
    throw new Error(
      "账号分析必须说明逐字稿必要性判断理由，不能机械提取或机械跳过",
    );
  }
  const analysisRequiredFields =
    purpose === "account_analysis"
      ? [
          ...ACCOUNT_ANALYSIS_REQUIRED_FIELDS,
          ...(analysisTranscriptDecision === "recommend"
            ? ["video_transcript"]
            : []),
        ]
      : [];
  const requestedFields = [
    ...new Set([...analysisRequiredFields, ...userRequestedFields]),
  ];
  const autoAddedFields = requestedFields.filter(
    (field) => !userRequestedFields.includes(field),
  );
  if (
    purpose === "full_collection" &&
    (!Number.isFinite(Number(input.maxItems)) || Number(input.maxItems) <= 0)
  ) {
    throw new Error(
      "完整采集需要提供主页已知总量或本次明确授权的数量上限，不能再用 300 条默认值代替“全部”",
    );
  }
  const purposeRecommendation = PROFILE_COLLECTION_PURPOSES[purpose].recommendation;
  const defaultMaxItems =
    purposeRecommendation === "requested_scope"
      ? DEFAULT_SCAN_LIMIT
      : purposeRecommendation;
  const requestedMaxItems = normalizeProfileCollectionCount(
    input.maxItems,
    defaultMaxItems,
  );
  const archiveMode = purpose === "full_collection";
  const requiresDetail = requestedFields.some((field) =>
    PROFILE_COLLECTION_DETAIL_FIELDS.includes(field),
  );
  const requestsTranscript = requestedFields.includes("video_transcript");
  if (requestsTranscript && contentType === "image") {
    throw new Error("图文作品不能请求视频逐字稿；请先确认内容类型或移除该字段");
  }
  const defaultDetailTarget =
    purpose === "account_analysis"
      ? ACCOUNT_ANALYSIS_DETAIL_TARGET
      : purpose === "representative_research"
        ? PROFILE_COLLECTION_PURPOSES.representative_research.recommendation
        : requestedMaxItems;
  const requestedDetailTarget = Number(input.detailMaxItems);
  const detailTargetLimit = requiresDetail
    ? Math.min(
        requestedMaxItems,
        Math.max(
          1,
          Math.floor(
            Number.isFinite(requestedDetailTarget) && requestedDetailTarget > 0
              ? requestedDetailTarget
              : defaultDetailTarget,
          ),
        ),
      )
    : 0;
  const executionItemLimit = requiresDetail
    ? detailTargetLimit
    : requestedMaxItems;
  const requestedTranscriptTarget = Number(input.transcriptMaxItems);
  const defaultTranscriptTarget =
    purpose === "account_analysis"
      ? ACCOUNT_ANALYSIS_TRANSCRIPT_TARGET
      : MAX_TRANSCRIPT_QUOTE_ITEMS;
  const transcriptQuoteLimit = Math.min(
    executionItemLimit,
    MAX_TRANSCRIPT_QUOTE_ITEMS,
    Math.max(
      1,
      Math.floor(
        Number.isFinite(requestedTranscriptTarget) &&
          requestedTranscriptTarget > 0
          ? requestedTranscriptTarget
          : defaultTranscriptTarget,
      ),
    ),
  );
  const scanBatches = splitProfileCollectionBatches(
    requestedMaxItems,
    MAX_SCAN_LIMIT,
  );
  const detailBatches = requiresDetail
    ? splitProfileCollectionBatches(
        executionItemLimit,
        MAX_DEEP_COLLECT_LIMIT,
      )
    : [];
  const recommendation = profileCollectionRecommendation(
    purpose,
    requestedMaxItems,
  );
  const includeProfile = requestedFields.includes("account_profile");
  const includeComments = requestedFields.includes("comments");
  const commentsPerItemLimit = includeComments
    ? Math.min(
        500,
        Math.max(1, Math.floor(Number(input.commentsPerItemLimit) || 30)),
      )
    : 0;
  const estimatedCommentCount = includeComments
    ? detailTargetLimit * commentsPerItemLimit
    : 0;
  const recentRiskSignals = recentProfileCollectionRiskSignals(
    adapter,
    platform,
  );
  const riskLevel = profileCollectionRiskLevel({
    requestedCount: requestedMaxItems,
    recommendedCount: recommendation.recommendedCount,
    detailTargetCount: detailTargetLimit,
    scanBatchCount: scanBatches.length,
    estimatedCommentCount,
    recentRiskSignalCount: recentRiskSignals.length,
  });
  const requestedRetryPasses = Number(input.failureRetryPasses);
  const failureRetryPasses = Math.min(
    MAX_PROFILE_ARCHIVE_RETRY_PASSES,
    Math.max(
      0,
      Math.floor(
        Number.isFinite(requestedRetryPasses)
          ? requestedRetryPasses
          : archiveMode
            ? DEFAULT_PROFILE_ARCHIVE_RETRY_PASSES
            : 0,
      ),
    ),
  );
  const includeBloggerMetrics = requestedFields.includes("blogger_metrics");
  const requestedData = requestedFields.map((field) => ({
    field,
    label: PROFILE_COLLECTION_FIELD_LABELS[field],
    source: autoAddedFields.includes(field)
      ? "analysis_method"
      : "user_request",
    availability:
      field === "video_transcript"
        ? "详情采集后先报价，仍需用户单独确认积分"
        : field === "comments"
          ? `逐条详情页实际可获取，每篇最多 ${commentsPerItemLimit} 条`
        : requiresDetail && PROFILE_COLLECTION_DETAIL_FIELDS.includes(field)
          ? "逐条详情页实际可获取"
          : "账号主页基础扫描可获取",
  }));
  const steps = [];
  if (includeProfile) {
    steps.push({
      id: "profile_info",
      label: "读取账号主页信息",
      capability: "capture.blogger",
      purpose: "获取账号名、简介、粉丝和主页指标",
    });
  }
  steps.push({
    id: "profile_inventory",
    label: "扫描账号作品清单",
    capability: "capture.blogger",
    purpose: `定位主页中的${profileCollectionContentLabel(contentType)}并保存基础记录`,
    maxItems: requestedMaxItems,
    batches: scanBatches,
  });
  if (contentType !== "all") {
    steps.push({
      id: "content_filter",
      label: `筛选${profileCollectionContentLabel(contentType)}`,
      capability: "local_read",
      purpose: "只保留符合用户内容类型要求的数据池记录",
    });
  }
  if (requiresDetail) {
    steps.push({
      id: "detail_enhancement",
      label: "逐条补采作品详情",
      capability: "capture.enhancement",
      purpose: "打开选中记录的详情页，补齐用户已经确认的数据字段",
      maxItems: detailTargetLimit,
      batches: detailBatches,
      includeComments,
      commentsPerItemLimit,
      includeBloggerMetrics,
      failureRetryPasses,
    });
  }
  if (requestsTranscript) {
    steps.push({
      id: "transcript_quote",
      label: "生成视频逐字稿报价",
      capability: "extract.video_transcript",
      purpose: "只生成报价，不扣积分；报价后仍需用户单独确认",
      maxItems: transcriptQuoteLimit,
    });
  }
  steps.push({
    id: "coverage_audit",
    label: "核对实际采集覆盖",
    capability: "local_read",
    purpose: "报告计划数量、匹配数量、详情成功数、失败项和未执行项",
  });

  const limitations = [];
  if (scanBatches.length > 1) {
    limitations.push(
      `账号基础列表单批技术上限为 ${MAX_SCAN_LIMIT} 条，完整目标将按 ${scanBatches.join(" + ")} 分 ${scanBatches.length} 批执行`,
    );
  }
  if (detailBatches.length > 1) {
    limitations.push(
      `详情增强单批技术上限为 ${MAX_DEEP_COLLECT_LIMIT} 条，匹配记录将按最多 ${MAX_DEEP_COLLECT_LIMIT} 条一批继续补采，不会静默截断`,
    );
  }
  if (requestsTranscript && requestedMaxItems > MAX_TRANSCRIPT_QUOTE_ITEMS) {
    limitations.push(
      `逐字稿单次最多为 ${MAX_TRANSCRIPT_QUOTE_ITEMS} 条视频报价；本方案只为前 ${transcriptQuoteLimit} 条匹配视频生成报价`,
    );
  }
  if (requestsTranscript && contentType !== "video") {
    limitations.push("逐字稿只会应用于实际识别为视频的记录");
  }
  if (requiresDetail) {
    limitations.push("详情字段以平台页面和插件本次实际可读取结果为准，缺失字段不会被推测补写");
  }
  if (purpose === "account_analysis" && requiresDetail) {
    limitations.push(
      `账号分析先读取最多 ${requestedMaxItems} 条基础作品，再按工作台样本规则选择最多 ${detailTargetLimit} 条高表现、典型和低表现代表作品补齐详情`,
    );
  }
  if (purpose === "account_analysis" && autoAddedFields.length > 0) {
    limitations.push(
      `账号分析方法已自动补入工作台同构证据字段：${autoAddedFields
        .map((field) => PROFILE_COLLECTION_FIELD_LABELS[field])
        .join("、")}；逐字稿仍只生成报价，必须由用户另行确认积分后才提取`,
    );
  }
  if (requestedFields.includes("media_urls")) {
    limitations.push(
      "媒体字段返回页面实际可读取的图片或视频源地址；本方案不下载图片、视频二进制文件",
    );
  }
  const riskWarnings = [];
  if (requestedMaxItems > recommendation.recommendedCount) {
    riskWarnings.push(
      `按“${recommendation.purposeLabel}”用途建议先采 ${recommendation.recommendedCount} 条；用户要求 ${requestedMaxItems} 条，确认后仍按用户范围执行`,
    );
  }
  if (scanBatches.length > 1) {
    riskWarnings.push(
      `主页需要连续执行 ${scanBatches.length} 个基础列表批次，页面加载失败、登录校验或平台风控概率会随批次增加`,
    );
  }
  if (
    requiresDetail &&
    detailTargetLimit > PROFILE_DETAIL_YELLOW_THRESHOLD
  ) {
    riskWarnings.push(
      detailTargetLimit > PROFILE_DETAIL_RED_THRESHOLD
        ? `最多会逐条打开 ${detailTargetLimit} 个详情页，超过 ${PROFILE_DETAIL_RED_THRESHOLD} 条详情红色风险阈值；本次确认将作为分批继续的风险授权`
        : `最多会逐条打开 ${detailTargetLimit} 个详情页，超过 ${PROFILE_DETAIL_YELLOW_THRESHOLD} 条详情黄色提示阈值`,
    );
  }
  if (estimatedCommentCount > PROFILE_COMMENT_RED_TOTAL_THRESHOLD) {
    riskWarnings.push(
      `按每篇最多 ${commentsPerItemLimit} 条评论估算，本次最多会读取 ${estimatedCommentCount} 条评论，超过 ${PROFILE_COMMENT_RED_TOTAL_THRESHOLD} 条评论红色风险阈值`,
    );
  }
  if (recentRiskSignals.length > 0) {
    riskWarnings.push(
      `${recentRiskSignals[0].message}；本次方案升级为红色风险，请先确认平台页面已经恢复正常`,
    );
  }
  if (requestedMaxItems > 1000) {
    riskWarnings.push(
      "基础列表总量超过 15 分钟 1000 条的建议连续额度；本方案会保持单批上限与间隔，并按用户确认继续",
    );
  }

  const createdAtMs = Date.now();
  const plan = {
    planId: createId("profile_plan"),
    ownerDeviceId: profileCollectionPlanOwner(adapter),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + PROFILE_COLLECTION_PLAN_TTL_MS).toISOString(),
    expiresAtMs: createdAtMs + PROFILE_COLLECTION_PLAN_TTL_MS,
    usedAt: "",
    userGoal,
    intent: {
      target: "account_profile",
      profileUrl,
      platform,
      contentType,
      coverage,
      purpose,
      operationMode: archiveMode ? "full_archive" : "research_collection",
    },
    execution: {
      requestedMaxItems,
      scanLimit: requestedMaxItems,
      scanBatches,
      executionItemLimit,
      detailTargetLimit,
      detailBatches,
      transcriptQuoteLimit,
      requiresDetail,
      requestsTranscript,
      includeProfile,
      includeComments,
      commentsPerItemLimit,
      includeBloggerMetrics,
      failureRetryPasses,
    },
    collectionScope: {
      targetUrl: profileUrl,
      platform,
      content: profileCollectionContentLabel(contentType),
      coverage:
        coverage === "all_available"
          ? `主页当前可加载范围，最多 ${requestedMaxItems} 条`
          : `主页最近 ${requestedMaxItems} 条`,
      detailTargetLimit,
    },
    requestedFields,
    requestedData,
    recommendation,
    analysisContract:
      purpose === "account_analysis"
        ? {
            id: "workbench-account-analysis-v1",
            methodId: "account-content-strategy-v1",
            methodVersion: "2.0.0",
            workbenchPromptVersion: "4.2.0",
            workbenchSchemaVersion: "3.7",
            evidenceBaseline: {
              basicItems: requestedMaxItems,
              representativeDetails: detailTargetLimit,
              transcripts: requestsTranscript ? transcriptQuoteLimit : 0,
              covers: Math.min(
                ACCOUNT_ANALYSIS_COVER_TARGET,
                requestedMaxItems,
              ),
            },
            representativeSelection:
              "workbench_high5_typical6_low4",
            reusePolicy:
              "existing_analysis_then_existing_capture_then_collect_missing_evidence",
            fieldPolicy: {
              userRequestedFields,
              methodRequiredFields: analysisRequiredFields,
              autoAddedFields,
              transcriptTrigger:
                analysisTranscriptDecision,
              transcriptReason:
                analysisTranscriptDecision === "user_requested"
                  ? "用户主动要求逐字稿或对应的视频文字提取"
                  : analysisTranscriptReason,
              transcriptConfirmation: "explicit_quote_confirmation_required",
            },
          }
        : null,
    archive: archiveMode
      ? {
          enabled: true,
          storage: "mediaclaw_data_pool",
          resultDelivery: "summary_and_preview",
          fullRecordQuery: {
            tool: "mediaclaw_list_assets",
            arguments: {
              source: "local.data_pool",
              type: "capture_record",
              filters: {
                profileUrl,
                platform,
                recordType: "blogger_notes",
                contentType,
              },
              cursor: "",
              limit: 100,
            },
          },
          fullRecordRead: {
            tool: "mediaclaw_get_asset",
            argumentFromIndex: "assetId",
          },
          taskRetentionDays: PROFILE_ARCHIVE_JOB_TTL_MS / 86_400_000,
          failureRetryPasses,
        }
      : null,
    riskNotice: {
      level: riskLevel,
      color:
        riskLevel === "red"
          ? "red"
          : riskLevel === "yellow"
            ? "yellow"
            : "none",
      label:
        riskLevel === "red"
          ? "红色风险提示"
          : riskLevel === "yellow"
            ? "黄色风险提示"
            : "普通确认",
      confirmationRequired: true,
      changesRequestedScope: false,
      warnings: riskWarnings,
      estimates: {
        listItems: requestedMaxItems,
        detailPageVisits: detailTargetLimit,
        comments: estimatedCommentCount,
      },
      thresholds: {
        listBatch: MAX_SCAN_LIMIT,
        listRedTotal: 1000,
        detailYellow: PROFILE_DETAIL_YELLOW_THRESHOLD,
        detailRed: PROFILE_DETAIL_RED_THRESHOLD,
        commentsRedTotal: PROFILE_COMMENT_RED_TOTAL_THRESHOLD,
        recentSignalWindowMinutes:
          PROFILE_RECENT_RISK_SIGNAL_WINDOW_MS / 60_000,
      },
      recentSignals: recentRiskSignals,
      alternatives: [
        purpose === "full_collection"
          ? `先执行首批 ${Math.min(MAX_SCAN_LIMIT, requestedMaxItems)} 条验证页面和字段，再制定剩余方案`
          : `按建议范围先采 ${recommendation.recommendedCount} 条，再根据结果决定是否继续`,
        `按用户要求的 ${requestedMaxItems} 条分批执行`,
      ],
      confirmedAction: `按用户要求的 ${requestedMaxItems} 条分批执行`,
    },
    solution: {
      analysis: ["结构化用户数据目标", "按内容类型筛选记录", "核对计划与实际覆盖差异"],
      steps,
      producesExecutionAudit: true,
    },
    browserActions: {
      startsAfterConfirmation: true,
      profilePageVisits: scanBatches.length + (includeProfile ? 1 : 0),
      maximumDetailPageVisits: requiresDetail ? executionItemLimit : 0,
      maximumDetailPageVisitsWithRetries: requiresDetail
        ? detailTargetLimit * (1 + failureRetryPasses)
        : 0,
      scanBatches,
      detailBatches,
      canCancel: true,
    },
    safetyBoundaries: {
      basicScanBatchLimit: MAX_SCAN_LIMIT,
      detailBatchLimit: MAX_DEEP_COLLECT_LIMIT,
      basicListRecommendedContinuousLimit: 1000,
      detailRecommendedContinuousLimit: 100,
      confirmedPlanCanContinueAcrossRecommendedBoundary: true,
      transcriptQuoteLimit: MAX_TRANSCRIPT_QUOTE_ITEMS,
      planIsOneTime: true,
      planExpiresInMinutes: PROFILE_COLLECTION_PLAN_TTL_MS / 60_000,
    },
    limitations,
  };
  const fieldSummary = requestedData.map((item) => item.label).join("、");
  plan.confirmationPrompt = [
    `确认类型：${plan.riskNotice.label}。`,
    `用途：${recommendation.purposeLabel}。${recommendation.rationale}`,
    requestedMaxItems > recommendation.recommendedCount
      ? `建议先采 ${recommendation.recommendedCount} 条，但你要求 ${requestedMaxItems} 条；确认后不会降级，仍按 ${requestedMaxItems} 条执行。`
      : `计划按 ${requestedMaxItems} 条范围执行。`,
    `将打开 ${profileCollectionContentLabel(contentType)}所在的账号主页，基础列表分批为 ${scanBatches.join(" + ")}。`,
    requiresDetail
      ? `筛选后按代表样本规则逐条打开最多 ${detailTargetLimit} 个详情页，按 ${MAX_DEEP_COLLECT_LIMIT} 条以内分批。`
      : "只读取主页基础清单，不打开作品详情页。",
    failureRetryPasses > 0
      ? `页面加载或解析失败会自动重试最多 ${failureRetryPasses} 轮，单条失败不会中断其余记录。`
      : "",
    `计划获取：${fieldSummary}。`,
    riskWarnings.length > 0 ? `风险提示：${riskWarnings.join("；")}。` : "",
    limitations.length > 0 ? `限制：${limitations.join("；")}。` : "",
    "确认后才会开始采集；确认代表接受上述分批范围和风险，不代表放弃失败记录与覆盖报告。",
  ].filter(Boolean).join("");
  profileCollectionPlans.set(plan.planId, plan);
  return publicProfileCollectionPlan(plan);
}

function resolveProfileCollectionPlan(planId, adapter = null) {
  const normalizedPlanId = normalizeText(planId, 200);
  const plan = profileCollectionPlans.get(normalizedPlanId);
  if (!plan) {
    return {
      ok: false,
      error: {code: "PROFILE_COLLECTION_PLAN_NOT_FOUND", message: "采集方案不存在，请重新制定方案"},
    };
  }
  if (
    plan.ownerDeviceId &&
    plan.ownerDeviceId !== profileCollectionPlanOwner(adapter)
  ) {
    return {
      ok: false,
      error: {code: "PROFILE_COLLECTION_PLAN_OWNER_MISMATCH", message: "采集方案不属于当前设备"},
    };
  }
  if (plan.expiresAtMs <= Date.now()) {
    return {
      ok: false,
      error: {code: "PROFILE_COLLECTION_PLAN_EXPIRED", message: "采集方案已过期，请重新制定并确认"},
    };
  }
  if (plan.usedAt) {
    return {
      ok: false,
      error: {code: "PROFILE_COLLECTION_PLAN_ALREADY_USED", message: "采集方案已经确认执行，不能重复使用"},
    };
  }
  return {ok: true, plan};
}

function taskProtocolStatus(status) {
  if (status === "succeeded") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "input_required") return "input_required";
  return "working";
}

function taskSnapshot(task) {
  return {
    taskId: task.taskId,
    status: taskProtocolStatus(task.status),
    statusMessage: task.message || "",
    createdAt: task.createdAt,
    lastUpdatedAt: task.updatedAt,
    ttl: Number(task?.ttlMs) || TASK_TTL_MS,
    pollInterval: 1000,
  };
}

function serializableTask(task) {
  return {
    taskId: task.taskId,
    kind: task.kind,
    status: task.status,
    message: task.message,
    input: task.input,
    idempotencyKey: task.idempotencyKey || "",
    captureTask: task.captureTask,
    owner: task.owner,
    progress: task.progress,
    result: task.result,
    error: task.error,
    childTaskIds: task.childTaskIds,
    currentChildTaskId: task.currentChildTaskId,
    createdAt: task.createdAt,
    queuedAt: task.queuedAt || task.createdAt,
    startedAt: task.startedAt || "",
    updatedAt: task.updatedAt,
    ttlMs: Number(task.ttlMs) || TASK_TTL_MS,
  };
}

function scheduleTaskStatePersist() {
  const payload = JSON.stringify({
    version: 1,
    tasks: [...tasks.values()].map(serializableTask),
  });
  taskStateWrite = taskStateWrite
    .catch(() => null)
    .then(async () => {
      await fs.mkdir(BROKER_STATE_DIRECTORY, {recursive: true, mode: 0o700});
      const temporaryPath = `${TASK_STATE_PATH}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, payload, {mode: 0o600});
      await fs.rename(temporaryPath, TASK_STATE_PATH);
    })
    .catch((error) => {
      process.stderr.write(
        `[mediaclaw] cannot persist Agent task state: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    });
  return taskStateWrite;
}

function isLocalAssetReadTask(taskOrCaptureTask = {}) {
  const safe = taskOrCaptureTask && typeof taskOrCaptureTask === "object"
    ? taskOrCaptureTask
    : {};
  const captureTask = safe.captureTask || safe;
  return (
    captureTask?.mode === "data_pool_assets" &&
    captureTask?.options?.operation === "get"
  );
}

function isLocalAssetQueryTask(taskOrCaptureTask = {}) {
  const safe = taskOrCaptureTask && typeof taskOrCaptureTask === "object"
    ? taskOrCaptureTask
    : {};
  const captureTask = safe.captureTask || safe;
  return (
    ["data_pool_assets", "studio_assets"].includes(captureTask?.mode) &&
    ["get", "list"].includes(captureTask?.options?.operation)
  );
}

function isLegacyActiveLocalAssetReadTask(task = {}) {
  return (
    isLocalAssetReadTask(task) &&
    ["queued", "running", "cancel_pending", "waiting_for_extension"].includes(
      task.status,
    ) &&
    !normalizeText(task.captureTask?.options?.view, 40)
  );
}

function queuedTaskMessage(captureTask, {extensionConnected, sessionReady}) {
  if (isLocalAssetQueryTask(captureTask)) {
    if (extensionConnected && sessionReady) {
      return "等待浏览器插件读取本地已保存资产（不会重新采集）";
    }
    if (extensionConnected) {
      return "等待用户批准设备配对，以访问浏览器插件中的本地已保存资产";
    }
    return "需要连接 MediaClaw 浏览器插件以读取其本地数据库（不会访问作品页）";
  }
  if (extensionConnected && sessionReady) return "等待浏览器插件执行";
  if (extensionConnected) return "等待用户在 MediaClaw 插件中批准设备配对";
  return "等待 MediaClaw 插件开启 Agent 调用";
}

function completedTaskMessage(task, succeeded) {
  if (isLocalAssetQueryTask(task)) {
    return succeeded ? "本地已保存资产读取完成" : "本地已保存资产读取失败";
  }
  return succeeded ? "采集完成" : "采集未完成";
}

async function restoreTaskState() {
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(TASK_STATE_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(
        `[mediaclaw] cannot restore Agent task state: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    return;
  }
  const snapshots = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const restoredAtMs = Date.now();
  const unrestorableWorkflowChildIds = new Set(
    snapshots
      .filter(
        (snapshot) =>
          ["batch", "workflow"].includes(snapshot?.kind) &&
          ["running", "cancel_pending", "waiting_for_extension"].includes(
            snapshot?.status,
          ),
      )
      .flatMap((snapshot) =>
        Array.isArray(snapshot?.childTaskIds) ? snapshot.childTaskIds : [],
      )
      .map((taskId) => normalizeText(taskId, 160))
      .filter(Boolean),
  );
  let restoredStateChanged = false;
  for (const snapshot of snapshots) {
    const taskId = normalizeText(snapshot?.taskId, 160);
    const updatedAtMs = Date.parse(String(snapshot?.updatedAt || ""));
    const ttlMs = Math.max(
      TASK_TTL_MS,
      Number(snapshot?.ttlMs) || TASK_TTL_MS,
    );
    if (
      !taskId ||
      !Number.isFinite(updatedAtMs) ||
      updatedAtMs < Date.now() - ttlMs
    ) {
      continue;
    }
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const wasInFlight = [
      "running",
      "cancel_pending",
      "waiting_for_extension",
    ].includes(snapshot.status);
    const legacyLocalAssetRead = isLegacyActiveLocalAssetReadTask(snapshot);
    const activeLocalAssetQuery =
      isLocalAssetQueryTask(snapshot) &&
      ["queued", "running", "cancel_pending", "waiting_for_extension"].includes(
        snapshot.status,
      );
    const localAssetReferenceMs = Date.parse(
      String(
        snapshot.status === "running"
          ? snapshot.startedAt || snapshot.createdAt || snapshot.updatedAt || ""
          : snapshot.queuedAt || snapshot.createdAt || snapshot.updatedAt || "",
      ),
    );
    const expiredLocalAssetQuery =
      activeLocalAssetQuery &&
      Number.isFinite(localAssetReferenceMs) &&
      restoredAtMs - localAssetReferenceMs >=
        (snapshot.status === "running"
          ? LOCAL_ASSET_EXECUTION_TIMEOUT_MS
          : LOCAL_ASSET_QUEUE_TIMEOUT_MS);
    const invalidRestoredLocalAssetQuery =
      legacyLocalAssetRead || expiredLocalAssetQuery;
    const unrestorableWorkflow =
      wasInFlight && ["batch", "workflow"].includes(snapshot.kind);
    const orphanedWorkflowChild =
      wasInFlight && unrestorableWorkflowChildIds.has(taskId);
    const invalidRestoredTask =
      invalidRestoredLocalAssetQuery ||
      unrestorableWorkflow ||
      orphanedWorkflowChild;
    const task = {
      ...snapshot,
      taskId,
      ttlMs,
      status: invalidRestoredTask
        ? "failed"
        : wasInFlight
          ? "waiting_for_extension"
          : snapshot.status,
      message: invalidRestoredTask
        ? unrestorableWorkflow
          ? "多阶段任务因 Agent Broker 重启已自动终止；已完成采集结果仍保留"
          : orphanedWorkflowChild
            ? "所属多阶段任务已在重启时终止；未完成子任务已释放"
            : legacyLocalAssetRead
              ? "旧版完整资产读取已终止；请使用统一分区读取重新发起"
              : "本地资产读取已过期并自动终止，队列已释放"
        : wasInFlight
          ? isLocalAssetReadTask(snapshot)
          ? "本地资产读取已恢复，等待浏览器插件继续传输已保存数据"
          : "任务已从持久状态恢复，等待浏览器插件断点续跑"
        : snapshot.message,
      error: invalidRestoredTask
        ? unrestorableWorkflow
          ? {
              code: "ORCHESTRATION_RESTARTED",
              message: "多阶段任务无法在 Broker 进程重启后从内存执行点继续，已自动终止",
            }
          : orphanedWorkflowChild
            ? {
                code: "ORCHESTRATION_CHILD_RELEASED",
                message: "所属多阶段任务已终止，未完成子任务不再恢复",
              }
            : legacyLocalAssetRead
              ? {
                  code: "LEGACY_LOCAL_ASSET_READ_REPLACED",
                  message: "旧版完整资产读取可能产生超大重复数据，已由统一分区读取替代",
                }
              : {
                  code: "LOCAL_ASSET_READ_EXPIRED",
                  message: "本地资产读取等待或执行时间过长，已自动终止",
                }
        : snapshot.error,
      completion,
      resolveCompletion,
    };
    if (invalidRestoredTask) restoredStateChanged = true;
    tasks.set(taskId, task);
    if (task.idempotencyKey) {
      idempotentTaskIds.set(task.idempotencyKey, taskId);
    }
    if (
      ["succeeded", "failed", "cancelled", "input_required"].includes(
        task.status,
      )
    ) {
      resolveCompletion(task);
    }
  }
  if (restoredStateChanged) {
    await scheduleTaskStatePersist();
  }
}

function updateTask(task, patch = {}) {
  Object.assign(task, patch, {updatedAt: nowIso()});
  void scheduleTaskStatePersist();
  return task;
}

function createTask({
  kind = "capture",
  input = {},
  captureTask = null,
  taskId: requestedTaskId = "",
  ttlMs = TASK_TTL_MS,
} = {}) {
  const owner = requestContext.getStore()?.adapter || null;
  const rawIdempotencyKey = normalizeText(input?.idempotencyKey, 240);
  const idempotencyKey = rawIdempotencyKey
    ? `${owner?.identity?.deviceId || "unknown"}:${rawIdempotencyKey}`
    : "";
  const existingTaskId = idempotencyKey
    ? idempotentTaskIds.get(idempotencyKey)
    : "";
  if (existingTaskId && tasks.has(existingTaskId)) {
    return tasks.get(existingTaskId);
  }
  const idPrefix =
    kind === "batch" ? "batch" : kind === "workflow" ? "research" : "capture";
  const taskId =
    normalizeText(requestedTaskId, 160) ||
    createId(idPrefix);
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const session = adapterSession(owner);
  const extensionConnected = Boolean(extensionPeer);
  const sessionReady = Boolean(session);
  const task = {
    taskId,
    kind,
    status: extensionConnected && sessionReady ? "queued" : "waiting_for_extension",
    message: queuedTaskMessage(captureTask, {extensionConnected, sessionReady}),
    input,
    idempotencyKey,
    captureTask,
    owner: owner
      ? {
          hostKey: owner.hostKey,
          deviceId: owner.identity.deviceId,
          displayName: owner.displayName,
        }
      : null,
    progress: null,
    result: null,
    error: null,
    childTaskIds: [],
    currentChildTaskId: "",
    createdAt: nowIso(),
    queuedAt: nowIso(),
    startedAt: "",
    updatedAt: nowIso(),
    ttlMs: Math.max(TASK_TTL_MS, Number(ttlMs) || TASK_TTL_MS),
    completion,
    resolveCompletion,
  };
  tasks.set(taskId, task);
  if (idempotencyKey) idempotentTaskIds.set(idempotencyKey, taskId);
  void scheduleTaskStatePersist();
  return task;
}

function recoverTaskFromResult(taskId, message = {}) {
  const response = message.response || {};
  const captureTask =
    message.task && typeof message.task === "object" && !Array.isArray(message.task)
      ? {...message.task, taskId}
      : {taskId};
  const recoveredAdapter = getAdapterByDeviceId(
    normalizeText(message.deviceId, 160),
  );
  const task = requestContext.run(
    {adapter: recoveredAdapter},
    () =>
      createTask({
        taskId,
        input: {recoveredAfterDisconnect: true},
        captureTask,
      }),
  );
  const result = attachPaywall(
    compactCaptureResponse(response, captureTask),
    response,
  );
  const succeeded = response?.ok !== false && result.ok !== false;
  finishTask(task, {
    status: succeeded ? "succeeded" : "failed",
    result,
    error: succeeded
      ? null
      : result.error || {
          code: "CAPTURE_FAILED",
          message: "浏览器采集失败",
        },
    message: succeeded
      ? "已恢复断线期间完成的采集结果"
      : "已恢复断线期间的失败结果",
  });
  recoveredTaskIds.unshift(taskId);
  if (recoveredTaskIds.length > 20) {
    recoveredTaskIds.length = 20;
  }
  return task;
}

function finishTask(task, {status, result = null, error = null, message = ""}) {
  const progress =
    status === "succeeded" &&
    task.progress &&
    Number.isFinite(Number(task.progress.totalCount))
      ? {
          ...task.progress,
          processedCount: Number(task.progress.totalCount),
          currentUrl: "",
          currentProfileUrl: "",
        }
      : task.progress;
  updateTask(task, {
    status,
    result,
    error,
    progress,
    currentChildTaskId: "",
    message:
      message ||
      (status === "succeeded"
        ? completedTaskMessage(task, true)
        : error?.message || completedTaskMessage(task, false)),
  });
  task.resolveCompletion(task);
  return task;
}

function buildCaptureTask(mode, input = {}) {
  const isList =
    mode === "search_results" || mode === "profile_posts";
  const isStyleLibrary = mode === "stored_style_profiles";
  const isAssetQuery = [
    "paired_devices",
    "data_pool_assets",
    "studio_assets",
    "workbench_assets",
  ].includes(mode);
  const isDataPoolQuery = mode === "data_pool_query";
  const isImageExtraction = mode === "extract_image_text";
  const isVideoExtraction = mode === "extract_video_transcript";
  const isEnhancement = mode === "enhance_records";
  const isLocalOnly =
    isStyleLibrary ||
    isAssetQuery ||
    isDataPoolQuery ||
    isImageExtraction ||
    isVideoExtraction;
  const localResultOnly = isLocalOnly || isEnhancement;
  const options = {
    ...(input.options && typeof input.options === "object"
      ? input.options
      : {}),
    returnRecords: true,
  };
  if (isList && options.detailCapture === undefined) {
    options.detailCapture = false;
  }
  return {
    source: "local_agent",
    featureKey:
      normalizeText(input.featureKey, 160) ||
      (isEnhancement
        ? "capture.enhancement"
      : mode === "paired_devices"
        ? "asset.studio_local"
      : isStyleLibrary
        ? "asset.style_profile"
        : mode === "data_pool_assets"
          ? "asset.data_pool"
        : mode === "studio_assets"
          ? "asset.studio_local"
        : mode === "workbench_assets"
          ? "asset.workbench"
        : isDataPoolQuery
          ? "asset.data_pool"
          : isVideoExtraction
            ? "extract.video_transcript"
        : isImageExtraction
          ? "extract.image_text"
            : undefined),
    platform: normalizePlatform(input.platform),
    mode,
    keyword: normalizeText(input.keyword, 200),
    targetUrl: normalizeText(input.url || input.targetUrl),
    profileUrl: normalizeText(input.profileUrl || input.url),
    limit: normalizeLimit(
      input.limit,
      isList ? DEFAULT_SCAN_LIMIT : mode === "comments" ? 60 : 1,
    ),
    resultSinks: localResultOnly
      ? ["local_agent"]
      : ["data_pool", "local_agent"],
    options,
  };
}

function pickBasicItem(item = {}) {
  return {
    id: normalizeText(item.id || item.noteId || item.awemeId, 160),
    title: normalizeText(item.title || item.noteTitle || item.desc, 300),
    url: normalizeText(
      item.url || item.noteUrl || item.detailPageUrl || item.shareUrl,
    ),
    coverImageUrl: normalizeText(
      item.coverImageUrl || item.cover || item.coverUrl,
    ),
    author: normalizeText(
      item.author || item.authorName || item.nickname || item.bloggerName,
      240,
    ),
    authorUrl: normalizeText(
      item.authorUrl || item.authorProfileUrl || item.profileUrl,
    ),
    likes: Number(item.likes ?? item.likeCount ?? item.diggCount) || 0,
    collects:
      Number(item.collects ?? item.collectCount ?? item.favoriteCount) || 0,
    comments:
      Number(item.comments ?? item.commentCount ?? item.commentTotal) || 0,
    publishTime: normalizeText(
      item.publishTime ||
        item.publishDate ||
        item.publishDateRaw ||
        item.lastEditedAt ||
        item.createTime,
      120,
    ),
    contentType: normalizeText(
      item.contentType || item.noteType || item.type,
      80,
    ),
  };
}

function pickDetailItem(item = {}) {
  const basic = pickBasicItem(item);
  return {
    ...basic,
    content: normalizeText(
      item.content ||
        item.contentText ||
        item.desc ||
        item.description ||
        item.transcriptText,
      6_000,
    ),
    tags: (Array.isArray(item.tags) ? item.tags : [])
      .map((tag) => normalizeText(tag, 120))
      .filter(Boolean)
      .slice(0, 30),
    imageUrls: (
      Array.isArray(item.imageUrls)
        ? item.imageUrls
        : Array.isArray(item.images)
          ? item.images
          : []
    )
      .map((url) => normalizeText(url))
      .filter(Boolean)
      .slice(0, 20),
    videoUrl: normalizeText(
      item.videoUrl ||
        (Array.isArray(item.videoUrls) ? item.videoUrls[0] : ""),
    ),
    followersCount:
      Number(item.followersCount ?? item.bloggerFollowersCount) || 0,
  };
}

function pickAccountProfile(item = {}) {
  return {
    bloggerId: normalizeText(
      item.bloggerId || item.userId || item.secUid || item.authorId,
      200,
    ),
    bloggerName: normalizeText(
      item.bloggerName || item.nickname || item.author || item.authorName,
      240,
    ),
    bloggerUrl: normalizeText(
      item.bloggerUrl ||
        item.bloggerProfileUrl ||
        item.profileUrl ||
        item.authorUrl,
    ),
    avatarUrl: normalizeText(
      item.avatarUrl || item.avatar || item.avatarLarger,
    ),
    description: normalizeText(
      item.description || item.signature || item.bio,
      2_000,
    ),
    followingCount:
      Number(item.followingCount ?? item.followCount) || 0,
    followersCount:
      Number(
        item.followersCount ??
          item.bloggerFollowersCount ??
          item.followerCount ??
          item.fansCount,
      ) || 0,
    likedAndCollectedCount:
      Number(
        item.likedAndCollectedCount ??
          item.bloggerLikedAndCollectedCount ??
          item.totalFavorited,
      ) || 0,
    accountType: normalizeText(
      item.bloggerAccountType || item.accountType || item.userType,
      120,
    ),
    ipLocation: normalizeText(item.ipLocation || item.location, 120),
    captureTimestamp:
      item.captureTimestamp || item.capturedAt || item.updatedAt || null,
  };
}

function collectAccountProfile(response = {}) {
  const data =
    response?.data && typeof response.data === "object"
      ? response.data
      : response;
  const records = Array.isArray(data?.captureResult?.records)
    ? data.captureResult.records
    : Array.isArray(data?.records)
      ? data.records
      : [];
  for (const record of records) {
    const payload =
      record?.normalizedPayload ||
      record?.payload ||
      record?.rawPayload ||
      record?.data ||
      record?.profile ||
      record?.basic ||
      {};
    const profile = pickAccountProfile(payload);
    if (profile.bloggerId || profile.bloggerName || profile.bloggerUrl) {
      return profile;
    }
  }
  const rawCaptureResult =
    findObjectByKey(data, "rawCaptureResult") || data?.rawCaptureResult || {};
  const raw = rawCaptureResult?.data || data?.data || {};
  const profile = pickAccountProfile(raw);
  return profile.bloggerId || profile.bloggerName || profile.bloggerUrl
    ? profile
    : null;
}

function collectDetailRecords(response = {}) {
  const data =
    response?.data && typeof response.data === "object"
      ? response.data
      : response;
  const records = Array.isArray(data?.captureResult?.records)
    ? data.captureResult.records
    : Array.isArray(data?.records)
      ? data.records
      : [];
  const items = [];
  for (const record of records) {
    const payload =
      record?.normalizedPayload ||
      record?.payload ||
      record?.rawPayload ||
      record?.data ||
      {};
    const source = Array.isArray(payload?.items)
      ? payload.items[0] || {}
      : payload;
    const picked = pickDetailItem(source);
    if (picked.id || picked.title || picked.url || picked.content) {
      items.push(picked);
    }
  }
  if (items.length === 0) {
    const raw =
      data?.rawCaptureResult?.data?.data ||
      data?.rawCaptureResult?.data ||
      data?.data ||
      {};
    const picked = pickDetailItem(raw);
    if (picked.id || picked.title || picked.url || picked.content) {
      items.push(picked);
    }
  }
  return items;
}

function findArrayByKey(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return null;
  if (Array.isArray(value[key])) return value[key];
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findArrayByKey(child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function findObjectByKey(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return null;
  if (
    value[key] &&
    typeof value[key] === "object" &&
    !Array.isArray(value[key])
  ) {
    return value[key];
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findObjectByKey(child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function findValueByKey(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return value[key];
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findValueByKey(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function compactKeywordExpansionResponse(response = {}, captureTask = {}) {
  const expandedKeywords = [
    ...new Set(
      (findArrayByKey(response, "expandedKeywords") || [])
        .map((item) => normalizeText(item, 200))
        .filter(Boolean),
    ),
  ];
  const stats = findObjectByKey(response, "stats") || {};
  const captureRisk = findObjectByKey(response, "captureRisk");
  return {
    ok: response?.ok !== false,
    taskId: captureTask.taskId || "",
    mode: "keyword_suggestions",
    platform: captureTask.platform || "",
    keyword: captureTask.keyword || "",
    count: expandedKeywords.length,
    expandedKeywords,
    records: expandedKeywords.map((keyword) => ({keyword})),
    stats: {
      totalFound:
        Number(stats.totalFound ?? stats.totalCount ?? expandedKeywords.length) ||
        expandedKeywords.length,
      duplicatesRemoved:
        Number(stats.duplicatesRemoved ?? stats.duplicateCount) || 0,
      uniqueCount: expandedKeywords.length,
      queryCount:
        Number(
          stats.queryCount ??
            stats.queriesAttempted ??
            findValueByKey(response, "queryCount"),
        ) || 0,
    },
    ...(captureRisk ? {captureRisk} : {}),
    error: response?.error || null,
  };
}

function pickCommentItem(item = {}) {
  return {
    commentId: normalizeText(item.commentId || item.id, 160),
    content: normalizeText(
      item.content || item.commentText || item.text,
      2_000,
    ),
    userName: normalizeText(
      item.userName || item.author || item.nickname,
      240,
    ),
    userId: normalizeText(item.userId || item.authorId, 160),
    userUrl: normalizeText(item.userUrl || item.authorUrl, 1_000),
    publishTime: normalizeText(
      item.publishTime || item.createTime || item.createdAt,
      120,
    ),
    ipLocation: normalizeText(item.ipLocation || item.location, 120),
    likes: Number(item.likes ?? item.likeCount ?? item.diggCount) || 0,
  };
}

function collectCommentRecords(response = {}) {
  const data =
    response?.data && typeof response.data === "object"
      ? response.data
      : response;
  const records = Array.isArray(data?.captureResult?.records)
    ? data.captureResult.records
    : Array.isArray(data?.records)
      ? data.records
      : [];
  const items = [];
  const seen = new Set();

  function appendComments(input) {
    if (!Array.isArray(input)) return;
    for (const item of input) {
      const picked = pickCommentItem(item);
      if (!picked.commentId && !picked.content) continue;
      const key =
        picked.commentId ||
        `${picked.userId}|${picked.content}|${picked.publishTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(picked);
    }
  }

  for (const record of records) {
    appendComments(record?.items);
    const payload =
      record?.normalizedPayload ||
      record?.payload ||
      record?.rawPayload ||
      {};
    appendComments(payload?.items);
    appendComments(payload?.comments);
    appendComments(payload?.commentsCleanedItems);
    appendComments(payload?.commentItems);
    appendComments(payload?.commentList);
    appendComments(payload?.detailPayload?.items);
    appendComments(payload?.detailPayload?.comments);
    appendComments(payload?.detailPayload?.commentsCleanedItems);
    appendComments(payload?.detailPayload?.commentItems);
    appendComments(payload?.detailPayload?.commentList);
  }

  appendComments(data?.rawCaptureResult?.data?.items);
  appendComments(data?.items);
  return items;
}

function collectResultRecords(response = {}) {
  const data = response?.data && typeof response.data === "object"
    ? response.data
    : response;
  const records = Array.isArray(data?.captureResult?.records)
    ? data.captureResult.records
    : Array.isArray(data?.records)
      ? data.records
      : [];
  const items = [];
  for (const record of records) {
    if (Array.isArray(record?.items)) {
      items.push(...record.items.map(pickBasicItem));
      continue;
    }
    const payload =
      record?.normalizedPayload || record?.payload || record?.rawPayload || {};
    if (Array.isArray(payload?.items)) {
      items.push(...payload.items.map(pickBasicItem));
      continue;
    }
    const basic = record?.basic || payload;
    const picked = pickBasicItem(basic);
    if (picked.id || picked.title || picked.url) items.push(picked);
  }

  if (items.length === 0) {
    const rawItems = data?.rawCaptureResult?.data?.items;
    if (Array.isArray(rawItems)) {
      items.push(...rawItems.map(pickBasicItem));
    }
  }
  return items;
}

function collectAnalysisRecordsFromTaskResult(result = {}) {
  return collectResultRecords({
    data: {
      captureResult: {
        records: Array.isArray(result?.records) ? result.records : [],
      },
    },
  });
}

function collectDetailItemsFromTaskResult(result = {}) {
  return collectDetailRecords({
    data: {
      captureResult: {
        records: Array.isArray(result?.records) ? result.records : [],
      },
    },
  });
}

function findPaywall(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (
    value.paywall &&
    typeof value.paywall === "object" &&
    !Array.isArray(value.paywall)
  ) {
    return value.paywall;
  }
  for (const key of ["error", "data", "result", "rawCaptureResult"]) {
    const found = findPaywall(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function attachPaywall(result = {}, response = {}) {
  const paywall = findPaywall(response) || findPaywall(result);
  if (!paywall) return result;
  const sourceError =
    result.error && typeof result.error === "object"
      ? result.error
      : response?.error && typeof response.error === "object"
        ? response.error
        : {code: "PAYWALL_REQUIRED", message: paywall.message};
  return {
    ...result,
    paywall,
    error: {
      ...sourceError,
      code: sourceError.code || "PAYWALL_REQUIRED",
      message: sourceError.message || paywall.message,
      paywall,
      retryable: false,
    },
  };
}

function compactCaptureResponse(response = {}, captureTask = {}) {
  if (captureTask.mode === "paired_devices") {
    const rawCaptureResult = findObjectByKey(response, "rawCaptureResult") || {};
    return {
      ok: response?.ok !== false && rawCaptureResult?.ok !== false,
      taskId: captureTask.taskId || "",
      mode: captureTask.mode,
      ...(rawCaptureResult?.data || {}),
      error: response?.error || rawCaptureResult?.error || null,
    };
  }
  if (captureTask.mode === "enhance_records") {
    const rawCaptureResult = findObjectByKey(response, "rawCaptureResult") || {};
    const payload = rawCaptureResult?.data || {};
    const captureRisk = findObjectByKey(response, "captureRisk");
    return {
      ...payload,
      ok: response?.ok !== false && rawCaptureResult?.ok !== false,
      taskId: captureTask.taskId || "",
      mode: captureTask.mode,
      recordIds: Array.isArray(payload.recordIds)
        ? payload.recordIds
        : (captureTask?.options?.recordIds || []).slice(
            0,
            Number(captureRisk?.allowedCount) || undefined,
          ),
      ...(captureRisk ? {captureRisk} : {}),
      error: response?.error || rawCaptureResult?.error || payload?.error || null,
    };
  }
  if (["data_pool_assets", "studio_assets", "workbench_assets"].includes(captureTask.mode)) {
    const rawCaptureResult = findObjectByKey(response, "rawCaptureResult") || {};
    const payload =
      rawCaptureResult?.data &&
      typeof rawCaptureResult.data === "object" &&
      !Array.isArray(rawCaptureResult.data)
        ? rawCaptureResult.data
        : {};
    return {
      ...payload,
      ok: response?.ok !== false && rawCaptureResult?.ok !== false && payload?.ok !== false,
      taskId: captureTask.taskId || "",
      mode: captureTask.mode,
      error: response?.error || rawCaptureResult?.error || payload?.error || null,
    };
  }
  if (captureTask.mode === "stored_style_profiles") {
    const operation = captureTask?.options?.operation || "list";
    const rawCaptureResult =
      findObjectByKey(response, "rawCaptureResult") || {};
    const stylePayload =
      rawCaptureResult?.data &&
      typeof rawCaptureResult.data === "object" &&
      !Array.isArray(rawCaptureResult.data)
        ? rawCaptureResult.data
        : {};
    const profiles = Array.isArray(stylePayload.profiles)
      ? stylePayload.profiles
      : findArrayByKey(response, "profiles") || [];
    const profile =
      stylePayload.profile &&
      typeof stylePayload.profile === "object" &&
      !Array.isArray(stylePayload.profile)
        ? stylePayload.profile
        : findObjectByKey(response, "profile");
    const candidates = Array.isArray(stylePayload.candidates)
      ? stylePayload.candidates
      : findArrayByKey(response, "candidates") || [];
    const matchStatus =
      normalizeText(
        stylePayload.matchStatus ||
          findValueByKey(response, "matchStatus") ||
          (profile ? "matched" : ""),
        80,
      ) || (operation === "list" ? "listed" : "not_found");
    const matchedBy = normalizeText(
      stylePayload.matchedBy ||
        findValueByKey(response, "matchedBy") ||
        profile?.matchedBy,
      80,
    );
    const source = normalizeText(
      stylePayload.source || profile?.source || findValueByKey(response, "source"),
      80,
    );
    const ok =
      response?.ok !== false &&
      (operation === "list" || matchStatus === "matched");
    return {
      ok,
      taskId: captureTask.taskId || "",
      mode: "stored_style_profiles",
      operation,
      source,
      matchStatus,
      matchedBy,
      count: operation === "list" ? profiles.length : profile ? 1 : 0,
      ...(operation === "list" ? {profiles} : {}),
      ...(profile ? {profile} : {}),
      ...(candidates.length > 0 ? {candidates} : {}),
      error:
        response?.error ||
        (operation === "get" && matchStatus !== "matched"
          ? {
              code:
                matchStatus === "ambiguous"
                  ? "AMBIGUOUS_STYLE_PROFILE"
                  : "STYLE_PROFILE_NOT_FOUND",
              message:
                matchStatus === "ambiguous"
                  ? "匹配到多个已保存账号，请使用 profileId 精确选择"
                  : "没有找到匹配的已保存账号风格分析",
            }
          : null),
    };
  }
  if (captureTask?.options?.operation === "expand_keywords") {
    return compactKeywordExpansionResponse(response, captureTask);
  }
  if (captureTask.mode === "data_pool_query") {
    const rawCaptureResult =
      findObjectByKey(response, "rawCaptureResult") || {};
    const payload =
      rawCaptureResult?.data &&
      typeof rawCaptureResult.data === "object" &&
      !Array.isArray(rawCaptureResult.data)
        ? rawCaptureResult.data
        : {};
    return {
      ok: response?.ok !== false && rawCaptureResult?.ok !== false,
      taskId: captureTask.taskId || "",
      mode: "data_pool_query",
      operation: payload.operation || captureTask.options?.operation || "query",
      ...payload,
      error:
        response?.error ||
        rawCaptureResult?.error ||
        (rawCaptureResult?.ok === false
          ? {code: "DATA_POOL_QUERY_FAILED", message: "数据池查询失败"}
          : null),
    };
  }
  if (
    captureTask.mode === "extract_image_text" ||
    captureTask.mode === "extract_video_transcript"
  ) {
    const rawCaptureResult =
      findObjectByKey(response, "rawCaptureResult") || {};
    const payload =
      rawCaptureResult?.data &&
      typeof rawCaptureResult.data === "object" &&
      !Array.isArray(rawCaptureResult.data)
        ? rawCaptureResult.data
        : {};
    return {
      ok: response?.ok !== false && rawCaptureResult?.ok !== false,
      taskId: captureTask.taskId || "",
      mode: captureTask.mode,
      ...payload,
      error: response?.error || rawCaptureResult?.error || null,
    };
  }
  const data = response?.data && typeof response.data === "object"
    ? response.data
    : response;
  const isComments = captureTask.mode === "comments";
  const isDetail = captureTask.mode === "current_note";
  const isProfile = captureTask.mode === "profile_info";
  const captureResult = data?.captureResult || {};
  const captureRisk = findObjectByKey(response, "captureRisk");
  const commentItems = isComments ? collectCommentRecords(response) : [];
  const storedRecords = Array.isArray(captureResult.records)
    ? captureResult.records
    : [];
  const records = (
    storedRecords.length > 0
      ? storedRecords
    : isComments
      ? collectCommentRecords(response)
      : isProfile
        ? [collectAccountProfile(response)].filter(Boolean)
      : isDetail
        ? collectDetailRecords(response)
      : collectResultRecords(response)
  ).slice(
    0,
    normalizeLimit(captureTask.limit, MAX_SCAN_LIMIT),
  );
  const recordIds = [
    ...new Set(
      (findArrayByKey(response, "recordIds") || [])
        .map((item) => normalizeText(item, 160))
        .filter(Boolean),
    ),
  ];
  return {
    ok: response?.ok !== false && data?.ok !== false,
    taskId: captureTask.taskId || captureResult.taskId || "",
    mode: captureTask.mode || data?.task?.mode || "",
    platform: captureTask.platform || data?.task?.platform || "",
    dataScope:
      data?.captureResult?.dataScope || data?.dataScope || "agent_compact",
    count:
      Number(captureResult?.stats?.itemCount) ||
      commentItems.length ||
      records.length,
    stats: captureResult.stats || data?.rawCaptureResult?.data || {},
    diagnostics:
      captureResult.diagnostics ||
      data?.rawCaptureResult?.diagnostics ||
      data?.diagnostics ||
      {},
    records,
    recordIds,
    ...(isProfile ? {profile: collectAccountProfile(response)} : {}),
    ...(isComments ? {comments: commentItems} : {}),
    ...(captureRisk ? {captureRisk} : {}),
    error: response?.error || data?.error || captureResult.error || null,
  };
}

function pumpQueue() {
  if (!extensionPeer || activeExtensionTaskId) return;
  const next = [...tasks.values()].find(
    (task) =>
      task.kind === "capture" &&
      deviceSessions.has(task.owner?.deviceId) &&
      (task.status === "queued" || task.status === "waiting_for_extension"),
  );
  if (!next) return;
  activeExtensionTaskId = next.taskId;
  next.captureTask.taskId = next.taskId;
  updateTask(next, {
    status: "running",
    startedAt: nowIso(),
    message: isLocalAssetQueryTask(next)
      ? "浏览器插件正在读取并传输本地已保存资产，不会重新采集或访问作品页"
      : "浏览器正在执行采集",
  });
  extensionPeer.send({
    type: "task.start",
    taskId: next.taskId,
    deviceId: next.owner?.deviceId || "",
    sessionId: deviceSessions.get(next.owner?.deviceId)?.sessionId || "",
    task: next.captureTask,
  });
}

function expireStaleLocalAssetQueries(nowMs = Date.now()) {
  let releasedActiveTask = false;
  for (const task of tasks.values()) {
    if (
      !isLocalAssetQueryTask(task) ||
      !["queued", "running", "waiting_for_extension"].includes(task.status)
    ) {
      continue;
    }
    const isRunning = task.status === "running";
    const referenceMs = Date.parse(
      String(
        isRunning
          ? task.startedAt || task.createdAt || ""
          : task.queuedAt || task.createdAt || "",
      ),
    );
    const timeoutMs = isRunning
      ? LOCAL_ASSET_EXECUTION_TIMEOUT_MS
      : LOCAL_ASSET_QUEUE_TIMEOUT_MS;
    if (!Number.isFinite(referenceMs) || nowMs - referenceMs < timeoutMs) {
      continue;
    }
    const wasActive = activeExtensionTaskId === task.taskId;
    if (wasActive) {
      extensionPeer?.send({
        type: "task.cancel",
        taskId: task.taskId,
        deviceId: task.owner?.deviceId || "",
        sessionId: deviceSessions.get(task.owner?.deviceId)?.sessionId || "",
      });
      activeExtensionTaskId = "";
      releasedActiveTask = true;
    }
    finishTask(task, {
      status: "failed",
      error: {
        code: isRunning
          ? "LOCAL_ASSET_READ_TIMEOUT"
          : "LOCAL_ASSET_READ_QUEUE_EXPIRED",
        message: isRunning
          ? "本地资产读取执行超时，已自动终止并释放队列"
          : "本地资产读取等待超时，已自动终止",
      },
      message: isRunning
        ? "本地资产读取执行超时，已自动终止并释放队列"
        : "本地资产读取等待超时，已自动终止",
    });
  }
  if (releasedActiveTask || !activeExtensionTaskId) pumpQueue();
}

function expireUnacknowledgedCaptureTask(nowMs = Date.now()) {
  if (!activeExtensionTaskId) return;
  const task = tasks.get(activeExtensionTaskId);
  if (!task || task.kind !== "capture" || task.status !== "running") return;
  const progressStage = normalizeText(task.progress?.stage, 80);
  const isStarting =
    !task.progress || ["accepted", "queued", "resuming"].includes(progressStage);
  if (!isStarting) return;
  const referenceMs = Date.parse(
    String(
      task.progress?.updatedAt ||
        task.startedAt ||
        task.updatedAt ||
        task.createdAt ||
        "",
    ),
  );
  if (
    !Number.isFinite(referenceMs) ||
    nowMs - referenceMs < CAPTURE_START_ACK_TIMEOUT_MS
  ) {
    return;
  }
  extensionPeer?.send({
    type: "task.cancel",
    taskId: task.taskId,
    deviceId: task.owner?.deviceId || "",
    sessionId: deviceSessions.get(task.owner?.deviceId)?.sessionId || "",
  });
  activeExtensionTaskId = "";
  finishTask(task, {
    status: "failed",
    error: {
      code: "EXTENSION_TASK_START_TIMEOUT",
      message: "浏览器插件未在规定时间内确认并开始任务，已自动终止并释放队列",
    },
    message: "浏览器插件未确认开始任务，已自动终止并释放队列",
  });
  pumpQueue();
}

function requestResultRetry(taskId, reason) {
  resultTransfers.delete(taskId);
  const task = tasks.get(taskId);
  extensionPeer?.send({
    type: "task.result.retry",
    taskId,
    deviceId: task?.owner?.deviceId || "",
    reason,
  });
}

function acceptTaskResultMessage(message = {}) {
  const taskId = normalizeText(message.taskId, 160);
  if (!taskId) {
    return;
  }
  let task = tasks.get(taskId);
  const onlySessionDeviceId =
    deviceSessions.size === 1 ? deviceSessions.keys().next().value : "";
  const messageDeviceId = normalizeText(
    message.deviceId || task?.owner?.deviceId || onlySessionDeviceId,
    160,
  );
  if (task?.owner?.deviceId && messageDeviceId !== task.owner.deviceId) {
    return;
  }
  const recovered = !task;
  if (!task) {
    task = recoverTaskFromResult(taskId, {
      ...message,
      deviceId: messageDeviceId,
    });
  } else if (task.status !== "cancelled") {
    const alreadyFinished = ["succeeded", "failed"].includes(task.status);
    if (!alreadyFinished) {
      const response = message.response || {};
      if (response.canceled === true) {
        finishTask(task, {
          status: "cancelled",
          result: null,
          error: null,
          message: "浏览器已确认任务取消",
        });
      } else {
      const result = attachPaywall(
        compactCaptureResponse(response, task.captureTask),
        response,
      );
      const succeeded = response?.ok !== false && result.ok !== false;
      finishTask(task, {
        status: succeeded ? "succeeded" : "failed",
        result,
        error: succeeded
          ? null
          : result.error || {
              code: isLocalAssetQueryTask(task)
                ? "LOCAL_ASSET_READ_FAILED"
                : "CAPTURE_FAILED",
              message: isLocalAssetQueryTask(task)
                ? "浏览器插件本地资产读取失败"
                : "浏览器采集失败",
            },
      });
      }
    }
  }
  const cancellation = pendingTaskCancellations.get(taskId);
  if (cancellation) {
    cancellation.resolve({
      ok: task.status === "cancelled",
      canceled: task.status === "cancelled",
      reason: task.status === "cancelled" ? "confirmed_by_result" : "task_completed",
    });
  }
  if (activeExtensionTaskId === taskId) {
    activeExtensionTaskId = "";
  }
  extensionPeer?.send({
    type: "task.result.ack",
    taskId,
    deviceId: task.owner?.deviceId || messageDeviceId,
    recovered,
    status: task.status,
  });
  pumpQueue();
}

function handleResultTransferStart(message = {}) {
  const taskId = normalizeText(message.taskId, 160);
  const transferId = normalizeText(message.transferId, 320);
  const chunkCount = Math.floor(Number(message.chunkCount));
  const charLength = Math.floor(Number(message.charLength));
  if (
    !taskId ||
    !transferId ||
    !Number.isFinite(chunkCount) ||
    chunkCount <= 0 ||
    chunkCount > MAX_RESULT_TRANSFER_CHUNKS ||
    !Number.isFinite(charLength) ||
    charLength <= 0 ||
    charLength > MAX_RESULT_TRANSFER_CHARS
  ) {
    requestResultRetry(taskId, "invalid_transfer_metadata");
    return;
  }
  resultTransfers.set(taskId, {
    transferId,
    deviceId: normalizeText(
      message.deviceId || tasks.get(taskId)?.owner?.deviceId,
      160,
    ),
    chunkCount,
    charLength,
    chunks: new Array(chunkCount),
    receivedCount: 0,
  });
}

function handleResultTransferChunk(message = {}) {
  const taskId = normalizeText(message.taskId, 160);
  const transfer = resultTransfers.get(taskId);
  const transferId = normalizeText(message.transferId, 320);
  const index = Math.floor(Number(message.index));
  const data = typeof message.data === "string" ? message.data : "";
  if (
    !transfer ||
    transfer.transferId !== transferId ||
    !Number.isFinite(index) ||
    index < 0 ||
    index >= transfer.chunkCount ||
    !data
  ) {
    return;
  }
  if (transfer.chunks[index] === undefined) {
    transfer.chunks[index] = data;
    transfer.receivedCount += 1;
  }
}

function handleResultTransferEnd(message = {}) {
  const taskId = normalizeText(message.taskId, 160);
  const transfer = resultTransfers.get(taskId);
  const transferId = normalizeText(message.transferId, 320);
  if (
    !transfer ||
    transfer.transferId !== transferId ||
    transfer.receivedCount !== transfer.chunkCount
  ) {
    requestResultRetry(taskId, "incomplete_result_transfer");
    return;
  }
  const serialized = transfer.chunks.join("");
  if (serialized.length !== transfer.charLength) {
    requestResultRetry(taskId, "result_length_mismatch");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    requestResultRetry(taskId, "invalid_result_json");
    return;
  }
  resultTransfers.delete(taskId);
  acceptTaskResultMessage({
    type: "task.result",
    taskId,
    deviceId: transfer.deviceId,
    task: payload?.task || {},
    response: payload?.response || {},
  });
}

function handleExtensionMessage(message = {}, peer = null) {
  if (message.type === "session.challenge") {
    const challenge = message.challenge || {};
    const purpose = normalizeEnum(
      challenge.purpose,
      ["pairing", "session"],
      "pairing",
    );
    const deviceId = normalizeText(challenge.deviceId, 160);
    const challengeId = normalizeText(challenge.challengeId, 160);
    const nonce = normalizeText(challenge.nonce, 1000);
    const extensionId = normalizeText(challenge.extensionId, 240);
    const protocolVersion = normalizeText(
      challenge.protocolVersion,
      20,
    );
    const expiresAt = Number(challenge.expiresAt);
    const adapter = getAdapterByDeviceId(deviceId);
    if (
      !adapter ||
      !challengeId ||
      !nonce ||
      protocolVersion !== PROTOCOL_VERSION ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      peer?.send({
        type: "session.proof.error",
        code: "INVALID_SESSION_CHALLENGE",
        deviceId,
        challengeId,
      });
      return;
    }
    const payload = buildDeviceProofPayload({
      purpose,
      deviceId,
      challengeId,
      nonce,
      extensionId,
      protocolVersion,
    });
    peer?.send({
      type: "session.proof",
      purpose,
      deviceId,
      challengeId,
      signature: adapter.identity.sign(payload),
    });
    return;
  }
  if (message.type === "extension.hello") {
    const deviceId = normalizeText(message.deviceId, 160);
    const adapter = getAdapterByDeviceId(deviceId);
    const sessionId = normalizeText(message.sessionId, 200);
    if (
      normalizeText(message.protocolVersion, 20) !== PROTOCOL_VERSION ||
      !adapter ||
      !sessionId
    ) {
      return;
    }
    const nextExtensionId = normalizeText(message.extensionId, 200);
    if (!extensionAllowedForAdapter(adapter, nextExtensionId)) {
      peer?.close(
        1008,
        "The local MediaClaw Agent candidate only accepts a local browser extension",
      );
      return;
    }
    const activeExtensionId = normalizeText(extensionInfo?.extensionId, 200);
    if (
      extensionPeer &&
      extensionPeer !== peer &&
      activeExtensionId &&
      nextExtensionId !== activeExtensionId
    ) {
      peer?.close(
        1008,
        "Another authenticated MediaClaw extension is already active",
      );
      return;
    }
    if (extensionPeer && extensionPeer !== peer) {
      extensionPeer.close(
        1012,
        "The same MediaClaw extension opened a newer connection",
      );
    }
    extensionPeer = peer;
    extensionInfo = {
      extensionId: nextExtensionId,
      extensionVersion: normalizeText(message.extensionVersion, 80),
      protocolVersion: normalizeText(message.protocolVersion, 40),
      pendingResultCount:
        Math.max(0, Math.floor(Number(message.pendingResultCount) || 0)),
      recoveryResultCount:
        Math.max(0, Math.floor(Number(message.recoveryResultCount) || 0)),
      connectedAt: nowIso(),
    };
    deviceSessions.set(deviceId, {
      ...extensionInfo,
      deviceId,
      sessionId,
      hostKey: adapter.hostKey,
    });
    pumpQueue();
    return;
  }
  if (message.type === "extension.ping") {
    peer?.send({type: "server.pong", at: Date.now()});
    return;
  }

  if (!extensionPeer || peer !== extensionPeer) return;

  if (message.type === "task.result.start") {
    handleResultTransferStart(message);
    return;
  }
  if (message.type === "task.result.chunk") {
    handleResultTransferChunk(message);
    return;
  }
  if (message.type === "task.result.end") {
    handleResultTransferEnd(message);
    return;
  }
  if (message.type === "task.result") {
    acceptTaskResultMessage(message);
    return;
  }

  if (message.type === "task.cancel.result") {
    const taskId = normalizeText(message.taskId, 160);
    const task = tasks.get(taskId);
    const cancellation = pendingTaskCancellations.get(taskId);
    if (
      !task ||
      !cancellation ||
      (task.owner?.deviceId &&
        normalizeText(message.deviceId || task.owner.deviceId, 160) !==
          task.owner.deviceId)
    ) {
      return;
    }
    cancellation.resolve(message.response || {});
    return;
  }

  const taskId = normalizeText(message.taskId, 160);
  const task = tasks.get(taskId);

  if (!task) return;
  if (
    task.owner?.deviceId &&
    normalizeText(message.deviceId || task.owner.deviceId, 160) !== task.owner.deviceId
  ) {
    return;
  }

  if (message.type === "task.progress") {
    updateTask(task, {
      status: "running",
      progress: message.progress || null,
      message: normalizeText(
        message.progress?.message || "浏览器正在执行采集",
        500,
      ),
    });
    return;
  }
}

function handleExtensionClose(peer) {
  extensionPeers.delete(peer);
  if (extensionPeer !== peer) return;
  extensionPeer = null;
  extensionInfo = null;
  deviceSessions.clear();
  resultTransfers.clear();
  for (const cancellation of pendingTaskCancellations.values()) {
    cancellation.resolve({
      ok: false,
      canceled: false,
      reason: "extension_disconnected",
    });
  }
  if (activeExtensionTaskId) {
    const task = tasks.get(activeExtensionTaskId);
    if (task && task.status === "running") {
      updateTask(task, {
        status: "waiting_for_extension",
        message: "浏览器连接中断，重连后继续",
      });
    }
  }
  activeExtensionTaskId = "";
}

async function waitForTask(task, timeoutMs = LEGACY_WAIT_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const completed = await Promise.race([task.completion, timeout]);
  clearTimeout(timer);
  if (!completed) {
    throw new Error(
      "采集仍在后台运行。请使用 mediaclaw_task_status 查看进度。",
    );
  }
  return completed;
}

function toolResult(payload, {isError = false} = {}) {
  return {
    content: [{type: "text", text: JSON.stringify(payload, null, 2)}],
    structuredContent: payload,
    isError,
  };
}

function getTaskPublicResult(task) {
  return {
    task: taskSnapshot(task),
    progress: task.progress,
    result: task.result,
    error: task.error,
    paywall:
      task.error?.paywall ||
      task.result?.paywall ||
      null,
    childTaskIds: task.childTaskIds,
    currentChildTaskId: task.currentChildTaskId,
  };
}

function localAssetReadSignature(captureTask = {}) {
  if (!isLocalAssetReadTask(captureTask)) return "";
  const options = captureTask.options || {};
  const sections = Array.isArray(options.sections)
    ? [...new Set(options.sections.map((item) => normalizeText(item, 80)).filter(Boolean))]
        .sort()
    : [];
  const page = options.page && typeof options.page === "object"
    ? {
        path: normalizeText(options.page.path, 160),
        cursor: normalizeText(options.page.cursor ?? options.page.offset, 80),
        limit: Number(options.page.limit) || 0,
      }
    : {};
  return JSON.stringify({
    assetId: normalizeText(options.assetId, 1000),
    view: normalizeText(options.view, 40),
    sections,
    page,
  });
}

function findActiveLocalAssetRead(captureTask) {
  const signature = localAssetReadSignature(captureTask);
  if (!signature) return null;
  const ownerDeviceId = normalizeText(
    requestContext.getStore()?.adapter?.identity?.deviceId,
    160,
  );
  return [...tasks.values()].find(
    (task) =>
      task.kind === "capture" &&
      task.owner?.deviceId === ownerDeviceId &&
      ["queued", "running", "waiting_for_extension"].includes(task.status) &&
      localAssetReadSignature(task.captureTask) === signature,
  ) || null;
}

function startSingleCapture(mode, input = {}) {
  const captureTask = buildCaptureTask(mode, input);
  const activeLocalRead = findActiveLocalAssetRead(captureTask);
  if (activeLocalRead) return activeLocalRead;
  const task = createTask({input, captureTask});
  pumpQueue();
  return task;
}

async function runDeepBatch(parent, input = {}) {
  const urls = [...new Set(
    (Array.isArray(input.urls) ? input.urls : [])
      .map((url) => normalizeText(url))
      .filter(Boolean),
  )].slice(0, MAX_DEEP_COLLECT_LIMIT);
  if (urls.length === 0) {
    finishTask(parent, {
      status: "failed",
      error: {code: "INVALID_INPUT", message: "urls 至少需要一个链接"},
    });
    return;
  }

  const results = [];
  updateTask(parent, {
    status: "running",
    message: `开始补采 ${urls.length} 条重点内容`,
  });
  for (let index = 0; index < urls.length; index += 1) {
    if (parent.status === "cancelled") return;
    const child = startSingleCapture("current_note", {
      url: urls[index],
      platform: input.platform,
      featureKey: "capture.detail_batch",
      options: {
        includeComments: input.includeComments === true,
        includeBloggerMetrics: input.includeBloggerMetrics === true,
        confirmation: {confirmed: true, source: "mediaclaw_deep_collect"},
      },
    });
    parent.childTaskIds.push(child.taskId);
    updateTask(parent, {
      currentChildTaskId: child.taskId,
      progress: {
        processedCount: index,
        totalCount: urls.length,
        currentUrl: urls[index],
      },
      message: `正在补采第 ${index + 1}/${urls.length} 条`,
    });
    await child.completion;
    if (child.error?.paywall) {
      finishTask(parent, {
        status: "failed",
        result: {
          ok: false,
          requestedCount: urls.length,
          successCount: results.filter((item) => item?.ok !== false).length,
          failedCount: 0,
          results,
          paywall: child.error.paywall,
        },
        error: child.error,
        message: child.error.paywall.message || child.error.message,
      });
      return;
    }
    results.push(child.result || {ok: false, error: child.error});
  }
  const failedCount = results.filter((item) => item?.ok === false).length;
  finishTask(parent, {
    status: failedCount === results.length ? "failed" : "succeeded",
    result: {
      ok: failedCount === 0,
      requestedCount: urls.length,
      successCount: urls.length - failedCount,
      failedCount,
      results,
    },
    error:
      failedCount === results.length
        ? {code: "BATCH_FAILED", message: "重点内容补采全部失败"}
        : null,
    message:
      failedCount > 0
        ? `补采完成，${failedCount} 条失败`
        : `已补采 ${urls.length} 条重点内容`,
  });
}

function startDeepBatch(input = {}) {
  const parent = createTask({kind: "batch", input});
  void runDeepBatch(parent, input);
  return parent;
}

function average(values = []) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values = [], ratio = 0.5) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] || 0;
}

function buildKeywordResearchMetrics(records = []) {
  const likes = records
    .map((item) => Number(item?.likes) || 0)
    .sort((left, right) => right - left);
  const typeDistribution = {};
  for (const item of records) {
    const type = normalizeText(item?.contentType, 80) || "unknown";
    typeDistribution[type] = (typeDistribution[type] || 0) + 1;
  }
  const timestamps = records
    .map((item) => Date.parse(String(item?.publishTime || "")))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    recordCount: records.length,
    maxLikes: likes[0] || 0,
    medianLikes: percentile(likes, 0.5),
    p80Likes: percentile(likes, 0.8),
    p90Likes: percentile(likes, 0.9),
    top5AverageLikes: Math.round(average(likes.slice(0, 5))),
    top10AverageLikes: Math.round(average(likes.slice(0, 10))),
    over1000LikesCount: likes.filter((value) => value >= 1_000).length,
    over5000LikesCount: likes.filter((value) => value >= 5_000).length,
    contentTypeDistribution: typeDistribution,
    observedPublishRange:
      timestamps.length > 0
        ? {
            earliest: new Date(timestamps[0]).toISOString(),
            latest: new Date(timestamps[timestamps.length - 1]).toISOString(),
            datedRecordCount: timestamps.length,
          }
        : null,
  };
}

function selectRepresentativeKeywordRecords(records = [], requestedLimit = 15) {
  const limit = Math.min(
    DEFAULT_TOPIC_DETAIL_LIMIT,
    Math.max(1, Math.floor(Number(requestedLimit) || DEFAULT_TOPIC_DETAIL_LIMIT)),
  );
  const sorted = [...records]
    .filter((item) => normalizeText(item?.url))
    .sort((left, right) => (Number(right?.likes) || 0) - (Number(left?.likes) || 0));
  if (sorted.length <= limit) return sorted;

  const highEnd = Math.max(1, Math.ceil(sorted.length * 0.2));
  const midEnd = Math.max(highEnd + 1, Math.ceil(sorted.length * 0.5));
  const zones = [
    {items: sorted.slice(0, highEnd), count: Math.ceil(limit * 0.5)},
    {items: sorted.slice(highEnd, midEnd), count: Math.ceil(limit * 0.3)},
    {items: sorted.slice(midEnd), count: Math.max(1, Math.floor(limit * 0.2))},
  ];
  const selected = [];
  const seen = new Set();
  const pick = (item) => {
    const key = normalizeText(item?.id || item?.url, 1_000);
    if (!key || seen.has(key) || selected.length >= limit) return;
    seen.add(key);
    selected.push(item);
  };
  for (const zone of zones) {
    const count = Math.min(zone.count, zone.items.length);
    for (let index = 0; index < count; index += 1) {
      const position =
        count === 1
          ? 0
          : Math.round((index * (zone.items.length - 1)) / (count - 1));
      pick(zone.items[position]);
    }
  }
  for (const item of sorted) pick(item);
  return selected.slice(0, limit);
}

function findStrategyPreparation(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return null;
  if (
    "appliedSort" in value ||
    "appliedRecency" in value ||
    "appliedNoteType" in value
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findStrategyPreparation(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function buildKeywordCaptureOptions(input = {}, defaults = {}) {
  const platform = normalizePlatform(input.platform ?? defaults.platform);
  const timeRange = normalizeKeywordTimeRange(
    input.timeRange ?? defaults.timeRange ?? "any",
  );
  const sortBy = normalizeKeywordSortBy(
    input.sortBy ?? defaults.sortBy ?? "default",
  );
  const contentType = normalizeKeywordContentType(
    input.contentType ?? defaults.contentType ?? "all",
  );
  const videoDuration = normalizeKeywordVideoDuration(
    input.videoDuration ?? defaults.videoDuration ?? "all",
  );
  const searchScope = normalizeKeywordSearchScope(
    input.searchScope ?? defaults.searchScope ?? "all",
  );
  const locationScope = normalizeKeywordLocationScope(
    input.locationScope ?? defaults.locationScope ?? "all",
  );
  const requestedFilters = {
    timeRange,
    sortBy,
    contentType,
    videoDuration,
    searchScope,
    locationScope,
  };
  for (const [dimension, value] of Object.entries(requestedFilters)) {
    assertPlatformSearchFilterSupported(platform, dimension, value);
  }
  return {
    platform,
    timeRange,
    sortBy,
    contentType,
    videoDuration,
    searchScope,
    locationScope,
    prepareKeywordStrategy:
      input.prepareKeywordStrategy !== false &&
      defaults.prepareKeywordStrategy !== false,
    strictFilters: true,
    filterCapabilities: SEARCH_FILTER_CAPABILITIES[platform],
    sortDimension: keywordSortDimension(sortBy),
  };
}

function addChildTask(parent, child) {
  parent.childTaskIds.push(child.taskId);
  updateTask(parent, {currentChildTaskId: child.taskId});
  return child;
}

async function runKeywordTopicResearch(parent, input = {}) {
  if (!extensionPeer) {
    finishTask(parent, {
      status: "failed",
      error: {
        code: "EXTENSION_NOT_CONNECTED",
        message: "MediaClaw 插件尚未连接",
      },
    });
    return;
  }
  const keyword = normalizeText(input.keyword, 200);
  const platform = normalizePlatform(input.platform);
  const limit = normalizeLimit(input.limit, DEFAULT_SCAN_LIMIT);
  const captureOptions = buildKeywordCaptureOptions(input, {
    timeRange: "6m",
    sortBy: "likes",
    contentType: "all",
    prepareKeywordStrategy: true,
  });
  updateTask(parent, {
    status: "running",
    message: `正在采集“${keyword}”的选题趋势样本`,
  });
  const scan = addChildTask(
    parent,
    startSingleCapture("search_results", {
      keyword,
      platform,
      limit,
      options: captureOptions,
    }),
  );
  await scan.completion;
  if (scan.status !== "succeeded") {
    finishTask(parent, {
      status: "failed",
      error: scan.error || {
        code: "KEYWORD_SCAN_FAILED",
        message: "关键词扫描失败",
      },
    });
    return;
  }

  const records = collectAnalysisRecordsFromTaskResult(scan.result);
  const representativeSamples = [];
  const detailFailures = [];

  const preparation = findStrategyPreparation(scan.result?.diagnostics);
  const limitations = [];
  if (records.length < Math.min(limit, 10)) {
    limitations.push(`有效搜索结果仅 ${records.length} 条，趋势判断有限`);
  } else if (records.length < limit) {
    limitations.push(`计划采集 ${limit} 条，实际获得 ${records.length} 条`);
  }
  if (preparation && preparation.appliedSort === false) {
    limitations.push(`未确认已成功应用“${captureOptions.sortBy}”排序`);
  }
  if (preparation && preparation.appliedRecency === false) {
    limitations.push(`未确认已成功应用“${captureOptions.timeRange}”时间筛选`);
  }
  if (preparation && preparation.appliedNoteType === false) {
    limitations.push(
      `未确认已成功应用“${captureOptions.contentType}”内容类型筛选`,
    );
  }
  if (!preparation && captureOptions.prepareKeywordStrategy) {
    limitations.push("没有收到页面筛选条件的确认结果");
  }
  if (detailFailures.length > 0) {
    limitations.push(`${detailFailures.length} 条代表样本详情补采失败`);
  }

  finishTask(parent, {
    status: records.length > 0 ? "succeeded" : "failed",
    result: {
      ok: records.length > 0,
      researchType: "keyword_topic_trends",
      accessLevel: "basic_list",
      ...recommendedMethod(KEYWORD_TOPIC_METHOD_ID),
      datasetId: parent.taskId,
      upgrade: AGENT_DEEP_CAPTURE_UPGRADE,
      coverage: {
        keyword,
        platform,
        requestedCount: limit,
        actualCount: records.length,
        requestedFilters: captureOptions,
        appliedFilters: preparation,
        requestedDetailSampleCount: 0,
        actualDetailSampleCount: representativeSamples.length,
      },
      computedMetrics: buildKeywordResearchMetrics(records),
      representativeSamples,
      detailFailures,
      records,
      limitations,
    },
    error:
      records.length > 0
        ? null
        : {code: "NO_RESULTS", message: "没有采集到可分析的关键词结果"},
    message: `已准备 ${records.length} 条选题趋势基础列表数据`,
  });
}

function startKeywordTopicResearch(input = {}) {
  const task = createTask({kind: "workflow", input});
  void runKeywordTopicResearch(task, input);
  return task;
}

async function runLongtailResearch(parent, input = {}) {
  if (!extensionPeer) {
    finishTask(parent, {
      status: "failed",
      error: {
        code: "EXTENSION_NOT_CONNECTED",
        message: "MediaClaw 插件尚未连接",
      },
    });
    return;
  }
  const seedKeyword = normalizeText(input.seedKeyword || input.keyword, 200);
  const platform = normalizePlatform(input.platform);
  updateTask(parent, {
    status: "running",
    message: `正在扩展“${seedKeyword}”的长尾搜索词`,
  });
  const expansion = addChildTask(
    parent,
    startSingleCapture("search_results", {
      keyword: seedKeyword,
      platform,
      limit: keywordExpansionQueryLimit(input.suffixLetters),
      options: {
        operation: "expand_keywords",
        delayBetweenMs: input.delayBetweenMs,
        suffixLetters: input.suffixLetters,
      },
    }),
  );
  await expansion.completion;
  const expandedKeywords = Array.isArray(expansion.result?.expandedKeywords)
    ? expansion.result.expandedKeywords
    : [];
  const ok = expansion.status === "succeeded" && expandedKeywords.length > 0;
  finishTask(parent, {
    status: ok ? "succeeded" : "failed",
    result: {
      ok,
      researchType: "keyword_longtail_demand",
      ...recommendedMethod(KEYWORD_LONGTAIL_METHOD_ID),
      datasetId: parent.taskId,
      coverage: {
        seedKeyword,
        platform,
        totalFound:
          Number(expansion.result?.stats?.totalFound) || expandedKeywords.length,
        uniqueCount: expandedKeywords.length,
        duplicatesRemoved:
          Number(expansion.result?.stats?.duplicatesRemoved) || 0,
      },
      expandedKeywords,
      records: expandedKeywords.map((keyword) => ({keyword})),
      limitations: [
        "联想词反映平台搜索表达，不等于真实搜索量",
        "尚未对各长尾词的内容供给和表现做采样验证",
      ],
    },
    error: ok
      ? null
      : expansion.error || {
          code: "KEYWORD_EXPANSION_EMPTY",
          message: "没有获得可用的扩展词",
        },
    message: ok
      ? `已获得 ${expandedKeywords.length} 个去重后的长尾词`
      : "长尾词扩展未获得结果",
  });
}

function startLongtailResearch(input = {}) {
  const task = createTask({kind: "workflow", input});
  void runLongtailResearch(task, input);
  return task;
}

function profileCollectionRecordEntries(result = {}, plan = {}) {
  const storedRecords = Array.isArray(result.records) ? result.records : [];
  const fallbackRecordIds = Array.isArray(result.recordIds)
    ? result.recordIds
    : [];
  const entries = storedRecords.map((record, index) => {
    const recordType = normalizeText(record?.recordType || record?.type, 120);
    if (recordType === "blogger_profile") return null;
    const payload =
      record?.normalizedPayload && typeof record.normalizedPayload === "object"
        ? record.normalizedPayload
        : record?.payload && typeof record.payload === "object"
          ? record.payload
          : record?.rawPayload && typeof record.rawPayload === "object"
            ? record.rawPayload
            : {};
    const item =
      Array.isArray(payload.items) && payload.items[0] &&
      typeof payload.items[0] === "object"
        ? payload.items[0]
        : payload;
    const basic = pickBasicItem(item);
    return {
      recordId: normalizeText(record?.id || fallbackRecordIds[index], 160),
      record,
      basic,
      noteType: normalizeText(
        item.noteType || item.contentType || item.type || basic.contentType,
        80,
      ).toLowerCase(),
    };
  }).filter(Boolean);
  if (entries.length === 0) {
    const basicRecords = collectAnalysisRecordsFromTaskResult(result);
    entries.push(
      ...basicRecords.map((basic, index) => ({
        recordId: normalizeText(fallbackRecordIds[index], 160),
        record: null,
        basic,
        noteType: normalizeText(basic.contentType, 80).toLowerCase(),
      })),
    );
  }
  const contentType = plan.intent?.contentType || "all";
  return entries.filter((entry) => {
    if (contentType === "all") return true;
    const isVideo = isProfileCollectionVideoEntry(
      entry,
      plan.intent?.platform,
    );
    return contentType === "video" ? isVideo : !isVideo;
  });
}

function profileCollectionEntryKey(entry = {}) {
  return normalizeText(
    entry.recordId || entry.basic?.id || entry.basic?.url,
    1000,
  );
}

function mergeProfileCollectionEntries(target, entries = []) {
  let addedCount = 0;
  for (const entry of entries) {
    const key = profileCollectionEntryKey(entry);
    if (!key || target.has(key)) continue;
    target.set(key, entry);
    addedCount += 1;
  }
  return addedCount;
}

function profileCollectionEntryLikes(entry = {}) {
  const likes = Number(entry.basic?.likes);
  return Number.isFinite(likes) && likes >= 0 ? likes : 0;
}

function selectAccountAnalysisDetailEntries(
  entries = [],
  limit = ACCOUNT_ANALYSIS_DETAIL_TARGET,
) {
  const eligible = entries.filter((entry) => entry.recordId);
  const target = Math.min(
    Math.max(1, Math.floor(Number(limit) || ACCOUNT_ANALYSIS_DETAIL_TARGET)),
    eligible.length,
  );
  if (eligible.length <= target) return eligible;

  const ranked = [...eligible].sort(
    (left, right) =>
      profileCollectionEntryLikes(right) - profileCollectionEntryLikes(left),
  );
  const likes = ranked.map(profileCollectionEntryLikes).sort((a, b) => a - b);
  const medianLikes = percentile(likes, 0.5);
  const tierSize = Math.min(
    10,
    Math.max(1, Math.ceil(eligible.length * 0.2)),
  );
  const high = ranked.slice(0, tierSize);
  const low = ranked.slice(-tierSize).reverse();
  const highKeys = new Set(high.map(profileCollectionEntryKey));
  const lowKeys = new Set(low.map(profileCollectionEntryKey));
  const typical = eligible
    .filter((entry) => {
      const key = profileCollectionEntryKey(entry);
      return !highKeys.has(key) && !lowKeys.has(key);
    })
    .sort(
      (left, right) =>
        Math.abs(profileCollectionEntryLikes(left) - medianLikes) -
        Math.abs(profileCollectionEntryLikes(right) - medianLikes),
    );
  const selected = [];
  const seen = new Set();
  const take = (group, count) => {
    for (const entry of group) {
      if (count <= 0 || selected.length >= target) break;
      const key = profileCollectionEntryKey(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      selected.push(entry);
      count -= 1;
    }
  };
  take(high, 5);
  take(typical, 6);
  take(low, 4);
  take(eligible, target);
  return selected.slice(0, target);
}

function selectAccountAnalysisTranscriptEntries(
  entries = [],
  platform = "",
  limit = ACCOUNT_ANALYSIS_TRANSCRIPT_TARGET,
) {
  const eligible = entries
    .filter((entry) => isProfileCollectionVideoEntry(entry, platform))
    .sort(
      (left, right) =>
        profileCollectionEntryLikes(right) - profileCollectionEntryLikes(left),
    );
  const target = Math.min(
    Math.max(1, Math.floor(Number(limit) || ACCOUNT_ANALYSIS_TRANSCRIPT_TARGET)),
    eligible.length,
  );
  if (eligible.length <= target) return eligible;
  const middleStart = Math.max(
    4,
    Math.floor((eligible.length - 2 + 4) / 2) - 1,
  );
  const groups = [
    eligible.slice(0, 4),
    eligible.slice(middleStart, middleStart + 2),
    eligible.slice(-2),
    eligible,
  ];
  const selected = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of group) {
      const key = profileCollectionEntryKey(entry);
      if (!key || seen.has(key) || selected.length >= target) continue;
      seen.add(key);
      selected.push(entry);
    }
  }
  return selected.slice(0, target);
}

function profileCollectionPreviewLayers(record = {}) {
  const layers = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 3) {
      return;
    }
    seen.add(value);
    if (value.detailPayload && typeof value.detailPayload === "object") {
      visit(value.detailPayload, depth + 1);
    }
    if (Array.isArray(value.items) && value.items[0]) {
      visit(value.items[0], depth + 1);
    }
    layers.push(value);
    for (const key of ["normalizedPayload", "payload", "rawPayload"]) {
      if (value[key] && typeof value[key] === "object") {
        visit(value[key], depth + 1);
      }
    }
  };
  visit(record);
  return layers;
}

function firstProfileCollectionPreviewValue(layers, keys) {
  for (const layer of layers) {
    for (const key of keys) {
      const value = layer?.[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return null;
}

function countProfileCollectionMedia(layers, keys) {
  const values = new Set();
  const append = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    if (typeof value === "object") {
      append(value.url || value.src || value.imageUrl || value.videoUrl || value.audioUrl);
      return;
    }
    const normalized = String(value || "").trim();
    if (normalized) values.add(normalized);
  };
  for (const layer of layers) {
    for (const key of keys) append(layer?.[key]);
  }
  return values.size;
}

function summarizeProfileCollectionRecord(record = {}) {
  const layers = profileCollectionPreviewLayers(record);
  const id = normalizeText(record.id, 160);
  const numeric = (keys) => {
    const value = Number(firstProfileCollectionPreviewValue(layers, keys));
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    previewOnly: true,
    assetId: id
      ? `local.data_pool|capture_record|${encodeURIComponent(id)}`
      : "",
    id,
    platform: normalizeText(record.platform, 80),
    recordType: normalizeText(record.recordType || record.type, 120),
    title: normalizeText(
      firstProfileCollectionPreviewValue(layers, ["title", "noteTitle"]),
      300,
    ),
    contentPreview: normalizeText(
      firstProfileCollectionPreviewValue(layers, [
        "content",
        "noteContent",
        "description",
      ]),
      600,
    ),
    url: normalizeText(
      firstProfileCollectionPreviewValue(layers, [
        "url",
        "noteUrl",
        "detailPageUrl",
      ]),
      1000,
    ),
    author: normalizeText(
      firstProfileCollectionPreviewValue(layers, [
        "author",
        "authorName",
        "bloggerName",
      ]),
      240,
    ),
    contentType: normalizeText(
      firstProfileCollectionPreviewValue(layers, [
        "noteType",
        "contentType",
        "type",
      ]),
      80,
    ),
    publishedAt: firstProfileCollectionPreviewValue(layers, [
      "publishTimestamp",
      "publishTime",
      "publishDate",
      "lastEditedAt",
    ]),
    metrics: {
      likes: numeric(["likes", "likeCount", "diggCount"]),
      collects: numeric(["collects", "collectCount", "favoriteCount"]),
      comments: numeric(["comments", "commentCount", "commentTotal"]),
      shares: numeric(["shares", "shareCount"]),
    },
    mediaCounts: {
      images: countProfileCollectionMedia(layers, [
        "imageUrl",
        "imageUrls",
        "images",
      ]),
      videos: countProfileCollectionMedia(layers, [
        "videoUrl",
        "videoUrls",
        "playUrl",
      ]),
      audios: countProfileCollectionMedia(layers, [
        "audioUrl",
        "audioUrls",
        "musicUrl",
        "musicUrls",
      ]),
    },
    detailCaptureStatus: normalizeText(
      firstProfileCollectionPreviewValue(layers, ["detailCaptureStatus"]),
      80,
    ),
  };
}

function profileCollectionRiskAuthorization(
  plan,
  category,
  batchIndex,
  authorizedUnits,
  batchGroup = category,
) {
  return {
    source: "mediaclaw_confirm_profile_collection",
    decision: "continue_after_risk_warning",
    planId: plan.planId,
    batchId: `${batchGroup}-${batchIndex + 1}`,
    category,
    authorizedUnits,
    confirmedAt: plan.usedAt,
  };
}

function classifyProfileCollectionFailure(error = {}) {
  const code =
    normalizeText(
      error?.code || error?.reason || error?.category || error?.status,
      160,
    ) || "CAPTURE_FAILED";
  const message = normalizeText(error?.message || error?.detail, 1000);
  const signature = `${code} ${message}`;
  if (/AGENT_CAPTURE_RISK_CONFIRMATION_REQUIRED|RISK_CONFIRMATION/i.test(signature)) {
    return "risk_confirmation_required";
  }
  if (/AGENT_CAPTURE_BATCH_LIMIT_EXCEEDED|BATCH_LIMIT|BATCH_PLANNING/i.test(signature)) {
    return "batch_planning_error";
  }
  if (/CONTINUOUS_LIMIT|RATE_LIMIT|TOO_MANY_REQUESTS|FREQUENCY|COOLDOWN/i.test(signature)) {
    return "platform_cooldown";
  }
  if (/PAYWALL|ACCESS_REQUIRED|CREDENTIAL|MEMBERSHIP|SUBSCRIPTION/i.test(signature)) {
    return "access_required";
  }
  if (/EXTENSION_NOT_CONNECTED|PAIRING_REQUIRED|CONNECTION_LOST|SOCKET_CLOSED/i.test(signature)) {
    return "connection_required";
  }
  if (/CANCELLED|CANCELED|USER_CANCEL/i.test(signature)) {
    return "cancelled";
  }
  if (/CAPTCHA|VERIFICATION|LOGIN|UNAUTHORIZED|AUTH_REQUIRED|USER_ACTION/i.test(signature)) {
    return "user_action_required";
  }
  if (/INVALID_(URL|RECORD|LINK)|RECORD_NOT_FOUND|URL_MISSING|LINK_MISSING/i.test(signature)) {
    return "invalid_record";
  }
  return "page_load_or_parse_failure";
}

function isRetryableProfileCollectionFailure(classification) {
  return classification === "page_load_or_parse_failure";
}

function profileCollectionExecutionInterruption(error = {}, context = {}) {
  const classification = classifyProfileCollectionFailure(error);
  if (
    !["platform_cooldown", "user_action_required"].includes(classification)
  ) {
    return null;
  }
  const signature = `${normalizeText(error?.code || error?.reason, 160)} ${normalizeText(error?.message, 1000)}`;
  const isVerification = /CAPTCHA|VERIFICATION/i.test(signature);
  const nextAllowedAt =
    error?.risk?.nextAllowedAt || error?.nextAllowedAt || null;
  return {
    status: "input_required",
    classification,
    stage: context.stage || "profile_collection",
    batchIndex: context.batchIndex || null,
    recordId: context.recordId || "",
    reason:
      classification === "platform_cooldown"
        ? "platform_cooldown"
        : isVerification
          ? "verification_required"
          : "login_required",
    title:
      classification === "platform_cooldown"
        ? "平台采集冷却中"
        : isVerification
          ? "需要在浏览器完成验证码"
          : "需要在浏览器恢复登录",
    message:
      classification === "platform_cooldown"
        ? "采集已暂停以避免继续触发平台限制；这不表示插件做不了。请等待冷却时间结束后，让 Agent 按原目标继续剩余范围。"
        : isVerification
          ? "采集已暂停；请在 MediaClaw 使用的浏览器页面完成验证码。已保存结果不会丢失，处理后可继续剩余范围。"
          : "采集已暂停；请在 MediaClaw 使用的浏览器页面恢复账号登录。已保存结果不会丢失，处理后可继续剩余范围。",
    nextAllowedAt,
    preservesCompletedRecords: true,
    continuation:
      "处理完成后重新制定同一账号的剩余范围方案；数据池会保留已完成记录并跳过重复内容。",
    doesNotMeanUnsupported: true,
    error,
  };
}

function profileCollectionDetailEntryError(entry = {}) {
  if (entry.error && typeof entry.error === "object") return entry.error;
  return {
    code: normalizeText(
      entry.reason || entry.code || entry.category,
      160,
    ) || "DETAIL_CAPTURE_FAILED",
    message:
      normalizeText(entry.message || entry.detail, 1000) ||
      "作品详情采集未完成",
    stage: normalizeText(entry.stage, 120) || undefined,
  };
}

function combineProfileCollectionDetailResults(batchResults = []) {
  const recordMap = new Map();
  const results = [];
  const recordStates = new Map();
  const ensureState = (recordId) => {
    const normalizedRecordId = normalizeText(recordId, 160);
    if (!normalizedRecordId) return null;
    if (!recordStates.has(normalizedRecordId)) {
      recordStates.set(normalizedRecordId, {
        recordId: normalizedRecordId,
        ok: false,
        attempts: 0,
        hadFailure: false,
        classification: "page_load_or_parse_failure",
        error: null,
        batchIndex: null,
        phase: "primary",
        retryPass: 0,
      });
    }
    return recordStates.get(normalizedRecordId);
  };
  for (const item of batchResults) {
    const result = item.result && typeof item.result === "object"
      ? item.result
      : {};
    const expectedRecordIds = Array.isArray(item.recordIds)
      ? item.recordIds.map((recordId) => normalizeText(recordId, 160)).filter(Boolean)
      : [];
    const successfulRecordIds = new Set(
      item.status === "succeeded" &&
      result.ok !== false &&
      Array.isArray(result.recordIds)
        ? result.recordIds.map((recordId) => normalizeText(recordId, 160)).filter(Boolean)
        : [],
    );
    for (const record of Array.isArray(result.records) ? result.records : []) {
      const recordId = normalizeText(record?.id || record?.recordId, 160);
      if (recordId) recordMap.set(recordId, record);
    }
    const resultEntries = Array.isArray(result.results) ? result.results : [];
    results.push(
      ...resultEntries.map((entry) => ({
        ...entry,
        phase: item.phase || "primary",
        retryPass: Number(item.retryPass || 0),
      })),
    );
    const handledRecordIds = new Set();
    for (const entry of resultEntries) {
      const recordId = normalizeText(entry?.recordId || entry?.id, 160);
      const state = ensureState(recordId);
      if (!state) continue;
      handledRecordIds.add(recordId);
      state.attempts += 1;
      state.batchIndex = item.batchIndex;
      state.phase = item.phase || "primary";
      state.retryPass = Number(item.retryPass || 0);
      if (entry?.ok !== false) {
        state.ok = true;
        state.error = null;
        state.classification = null;
        successfulRecordIds.add(recordId);
        continue;
      }
      state.hadFailure = true;
      if (!state.ok) {
        const entryError = profileCollectionDetailEntryError(entry);
        state.error = entryError;
        state.classification = classifyProfileCollectionFailure(entryError);
      }
    }
    for (const recordId of expectedRecordIds) {
      const state = ensureState(recordId);
      if (!state || handledRecordIds.has(recordId)) continue;
      state.attempts += 1;
      state.batchIndex = item.batchIndex;
      state.phase = item.phase || "primary";
      state.retryPass = Number(item.retryPass || 0);
      const inferredSuccess =
        successfulRecordIds.has(recordId) ||
        (item.status === "succeeded" &&
          Number(result.failedCount || 0) === 0 &&
          (Number(result.successCount || 0) >= expectedRecordIds.length ||
            resultEntries.length === 0));
      if (inferredSuccess) {
        state.ok = true;
        state.error = null;
        state.classification = null;
        continue;
      }
      state.hadFailure = true;
      if (!state.ok) {
        const fallbackError = item.error || result.error || {
          code: "DETAIL_RESULT_MISSING",
          message: "详情批次未返回这条记录的完成结果",
        };
        state.error = fallbackError;
        state.classification = classifyProfileCollectionFailure(fallbackError);
      }
    }
  }
  const successfulStates = [...recordStates.values()].filter((state) => state.ok);
  const failedStates = [...recordStates.values()].filter((state) => !state.ok);
  const unresolvedRecordIds = new Set(
    failedStates.map((state) => state.recordId),
  );
  const itemFailures = failedStates.map((state) => ({
    batchIndex: state.batchIndex,
    phase: state.phase,
    retryPass: state.retryPass,
    recordId: state.recordId,
    classification: state.classification,
    error: state.error,
  }));
  const failedBatches = batchResults
    .filter((item) => {
      const expectedRecordIds = Array.isArray(item.recordIds)
        ? item.recordIds.map((recordId) => normalizeText(recordId, 160))
        : [];
      return (
        item.status !== "succeeded" &&
        (expectedRecordIds.length === 0 ||
          expectedRecordIds.some((recordId) => unresolvedRecordIds.has(recordId)))
      );
    })
    .map((item) => ({
      batchIndex: item.batchIndex,
      phase: item.phase || "primary",
      retryPass: Number(item.retryPass || 0),
      requestedCount: item.requestedCount,
      classification: classifyProfileCollectionFailure(item.error),
      error: item.error || null,
    }));
  return {
    ok: failedStates.length === 0,
    successCount: successfulStates.length,
    failedCount: failedStates.length,
    records: [...recordMap.values()],
    recordIds: successfulStates.map((state) => state.recordId),
    results,
    itemFailures,
    unclassifiedFailedCount: 0,
    batchCount: batchResults.length,
    primaryBatchCount: batchResults.filter(
      (item) => (item.phase || "primary") === "primary",
    ).length,
    retryBatchCount: batchResults.filter((item) => item.phase === "retry").length,
    retryPassesAttempted: new Set(
      batchResults
        .filter((item) => item.phase === "retry")
        .map((item) => Number(item.retryPass || 0)),
    ).size,
    recoveredCount: successfulStates.filter((state) => state.hadFailure).length,
    failedBatches,
  };
}

function profileCollectionStage(parent, executionLog, plan, stageId, patch = {}) {
  const plannedStage = plan.solution.steps.find((step) => step.id === stageId);
  const current = executionLog.find((item) => item.id === stageId);
  const next = current || {
    id: stageId,
    label: plannedStage?.label || stageId,
    capability: plannedStage?.capability || "local_read",
    status: "running",
    startedAt: nowIso(),
  };
  Object.assign(next, patch);
  if (!current) executionLog.push(next);
  const stepIndex = Math.max(
    0,
    plan.solution.steps.findIndex((step) => step.id === stageId),
  );
  updateTask(parent, {
    message: patch.message || next.label,
    progress: {
      stage: stageId,
      stepIndex: stepIndex + 1,
      totalSteps: plan.solution.steps.length,
      processedCount: Number(patch.processedCount || 0),
      totalCount: Number(patch.totalCount || 0),
      currentUrl: patch.currentUrl || "",
    },
  });
  return next;
}

async function runProfileCollectionWorkflow(parent, plan) {
  if (!extensionPeer) {
    finishTask(parent, {
      status: "failed",
      error: {
        code: "EXTENSION_NOT_CONNECTED",
        message: "MediaClaw 插件尚未连接",
      },
    });
    return;
  }
  const executionLog = [];
  const limitations = [...plan.limitations];
  const profileUrl = plan.intent.profileUrl;
  const platform = plan.intent.platform;
  const archiveEnabled = plan.archive?.enabled === true;
  let profile = null;
  let profileFailure = null;
  let detailResult = null;
  let transcriptQuote = null;
  let executionInterruption = null;
  const detailAttemptedRecordIds = new Set();

  updateTask(parent, {
    status: "running",
    message: "已按用户确认的方案开始采集账号数据",
  });

  if (plan.execution.includeProfile) {
    const stage = profileCollectionStage(
      parent,
      executionLog,
      plan,
      "profile_info",
      {message: "正在读取账号主页信息", currentUrl: profileUrl},
    );
    const profileTask = addChildTask(
      parent,
      startSingleCapture("profile_info", {
        profileUrl,
        platform,
        featureKey: "capture.blogger",
      }),
    );
    await profileTask.completion;
    if (parent.status === "cancelled") return;
    profile = profileTask.result?.profile || null;
    Object.assign(stage, {
      status: profileTask.status === "succeeded" ? "completed" : "failed",
      finishedAt: nowIso(),
      actualCount: profile ? 1 : 0,
      error: profileTask.error || null,
    });
    if (profileTask.status !== "succeeded") {
      profileFailure = profileTask.error || {
        code: "PROFILE_INFO_FAILED",
        message: "账号主页信息读取失败",
      };
      executionInterruption = profileCollectionExecutionInterruption(
        profileFailure,
        {stage: "profile_info"},
      );
      if (executionInterruption) stage.status = "paused";
      limitations.push(
        executionInterruption
          ? executionInterruption.message
          : "账号主页信息读取失败，作品采集仍继续执行",
      );
    }
  }

  const inventoryStage = profileCollectionStage(
    parent,
    executionLog,
    plan,
    "profile_inventory",
    {
      message: `正在扫描账号${profileCollectionContentLabel(plan.intent.contentType)}`,
      totalCount: plan.execution.scanLimit,
      currentUrl: profileUrl,
    },
  );
  const allEntryMap = new Map();
  const matchingEntryMap = new Map();
  const scanBatchLog = [];
  for (
    let batchIndex = 0;
    batchIndex < plan.execution.scanBatches.length && !executionInterruption;
    batchIndex += 1
  ) {
    if (parent.status === "cancelled") return;
    const batchLimit = plan.execution.scanBatches[batchIndex];
    const attempts = [];
    let scanTask = null;
    for (
      let attemptIndex = 0;
      attemptIndex <= plan.execution.failureRetryPasses;
      attemptIndex += 1
    ) {
      const isRetry = attemptIndex > 0;
      profileCollectionStage(parent, executionLog, plan, "profile_inventory", {
        message: isRetry
          ? `正在重试账号作品清单第 ${batchIndex + 1} 批（第 ${attemptIndex}/${plan.execution.failureRetryPasses} 轮）`
          : `正在扫描账号作品清单（第 ${batchIndex + 1}/${plan.execution.scanBatches.length} 批，最多 ${batchLimit} 条）`,
        processedCount: allEntryMap.size,
        totalCount: plan.execution.scanLimit,
        currentUrl: profileUrl,
      });
      scanTask = addChildTask(
        parent,
        startSingleCapture("profile_posts", {
          profileUrl,
          platform,
          featureKey: "capture.blogger",
          limit: batchLimit,
          options: {
            detailCapture: false,
            riskAuthorization: profileCollectionRiskAuthorization(
              plan,
              "list",
              batchIndex,
              batchLimit,
              isRetry ? `list-retry-${attemptIndex}` : "list",
            ),
          },
        }),
      );
      await scanTask.completion;
      if (parent.status === "cancelled") return;
      const attemptError = scanTask.error || scanTask.result?.error || null;
      const classification =
        scanTask.status === "succeeded"
          ? null
          : classifyProfileCollectionFailure(attemptError);
      attempts.push({
        attempt: attemptIndex + 1,
        retryPass: attemptIndex,
        status: scanTask.status === "succeeded" ? "completed" : "failed",
        classification,
        error: attemptError,
      });
      if (
        scanTask.status === "succeeded" ||
        !isRetryableProfileCollectionFailure(classification)
      ) {
        break;
      }
    }
    const batchResult = scanTask?.result;
    const batchError = scanTask?.error || scanTask?.result?.error || null;
    const batchFailureClassification =
      scanTask?.status === "succeeded"
        ? null
        : classifyProfileCollectionFailure(batchError);
    const batchLog = {
      batchIndex: batchIndex + 1,
      requestedCount: batchLimit,
      status: scanTask?.status === "succeeded" ? "completed" : "failed",
      actualCount: 0,
      newCount: 0,
      attempts,
      retryPassesAttempted: Math.max(0, attempts.length - 1),
      recoveredAfterRetry:
        attempts.length > 1 && scanTask?.status === "succeeded",
      error: batchError,
      failureClassification: batchFailureClassification,
    };
    scanBatchLog.push(batchLog);
    if (scanTask?.status !== "succeeded") {
      const scanInterruption = profileCollectionExecutionInterruption(
        batchError,
        {
          stage: "profile_inventory",
          batchIndex: batchIndex + 1,
        },
      );
      if (scanInterruption) {
        executionInterruption = scanInterruption;
      }
      limitations.push(
        scanInterruption
          ? scanInterruption.message
          : `基础列表第 ${batchIndex + 1} 批失败（${batchLog.failureClassification}），这不属于数量上限；已保留前面批次结果`,
      );
      if (!scanInterruption && allEntryMap.size === 0) {
        Object.assign(inventoryStage, {
          status: "failed",
          finishedAt: nowIso(),
          batches: scanBatchLog,
          error: batchError,
        });
        finishTask(parent, {
          status: "failed",
          result: {
            ok: false,
            workflow: "profile_collection",
            planId: plan.planId,
            userGoal: plan.userGoal,
            executionLog,
            limitations,
            failureClassification: batchLog.failureClassification,
          },
          error: batchError || {
            code: "PROFILE_COLLECTION_SCAN_FAILED",
            message: "账号作品清单扫描失败",
          },
        });
        return;
      }
      break;
    }
    const allBatchEntries = profileCollectionRecordEntries(batchResult, {
      ...plan,
      intent: {...plan.intent, contentType: "all"},
    });
    const matchingBatchEntries = profileCollectionRecordEntries(
      batchResult,
      plan,
    );
    batchLog.actualCount = allBatchEntries.length;
    batchLog.newCount = mergeProfileCollectionEntries(
      allEntryMap,
      allBatchEntries,
    );
    mergeProfileCollectionEntries(matchingEntryMap, matchingBatchEntries);
    if (
      allEntryMap.size >= plan.execution.scanLimit ||
      batchLog.newCount === 0
    ) {
      batchLog.endReason =
        allEntryMap.size >= plan.execution.scanLimit
          ? "requested_scope_reached"
          : "no_new_records";
      break;
    }
  }

  const allEntries = [...allEntryMap.values()].slice(
    0,
    plan.execution.scanLimit,
  );
  const matchingEntries = [...matchingEntryMap.values()];
  const eligibleEntries = matchingEntries.filter((entry) => entry.recordId);
  const selectedEntries =
    plan.intent.purpose === "account_analysis" &&
    plan.execution.requiresDetail
      ? selectAccountAnalysisDetailEntries(
          eligibleEntries,
          plan.execution.detailTargetLimit,
        )
      : eligibleEntries.slice(0, plan.execution.executionItemLimit);
  Object.assign(inventoryStage, {
    status: executionInterruption
      ? "paused"
      : scanBatchLog.some((item) => item.status === "failed")
        ? "partial"
        : "completed",
    finishedAt: nowIso(),
    actualCount: allEntries.length,
    requestedCount: plan.execution.scanLimit,
    batches: scanBatchLog,
  });
  if (
    allEntries.length < plan.execution.scanLimit &&
    !scanBatchLog.some((item) => item.status === "failed") &&
    !executionInterruption
  ) {
    limitations.push(
      `计划上限为 ${plan.execution.scanLimit} 条，主页本次实际返回 ${allEntries.length} 条；这表示主页已到末尾、去重后无新记录或页面未完全加载，不表示触发数量上限`,
    );
  }

  if (plan.intent.contentType !== "all" && !executionInterruption) {
    const filterStage = profileCollectionStage(
      parent,
      executionLog,
      plan,
      "content_filter",
      {message: `正在筛选${profileCollectionContentLabel(plan.intent.contentType)}`},
    );
    Object.assign(filterStage, {
      status: "completed",
      finishedAt: nowIso(),
      inputCount: allEntries.length,
      actualCount: matchingEntries.length,
    });
  }
  if (matchingEntries.length > selectedEntries.length) {
    limitations.push(
      `匹配到 ${matchingEntries.length} 条${profileCollectionContentLabel(plan.intent.contentType)}，本方案按确认边界处理前 ${selectedEntries.length} 条`,
    );
  }

  if (
    plan.execution.requiresDetail &&
    selectedEntries.length > 0 &&
    !executionInterruption
  ) {
    const detailStage = profileCollectionStage(
      parent,
      executionLog,
      plan,
      "detail_enhancement",
      {
        message: `正在补采 ${selectedEntries.length} 条作品详情`,
        totalCount: selectedEntries.length,
      },
    );
    const recordIds = selectedEntries.map((entry) => entry.recordId);
    const detailBatchResults = [];
    const detailBatchCount = Math.ceil(
      recordIds.length / MAX_DEEP_COLLECT_LIMIT,
    );
    const runDetailBatch = async ({
      batchRecordIds,
      batchIndex,
      totalBatches,
      phase = "primary",
      retryPass = 0,
    }) => {
      const isRetry = phase === "retry";
      for (const recordId of batchRecordIds) {
        detailAttemptedRecordIds.add(recordId);
      }
      profileCollectionStage(parent, executionLog, plan, "detail_enhancement", {
        message: isRetry
          ? `正在重试详情失败项（第 ${retryPass}/${plan.execution.failureRetryPasses} 轮，第 ${batchIndex + 1}/${totalBatches} 批，${batchRecordIds.length} 条）`
          : `正在补采作品详情（第 ${batchIndex + 1}/${totalBatches} 批，${batchRecordIds.length} 条）`,
        processedCount: Number(detailResult?.successCount || 0),
        totalCount: selectedEntries.length,
      });
      const detailTask = addChildTask(
        parent,
        startSingleCapture("enhance_records", {
          platform,
          featureKey: "capture.enhancement",
          limit: batchRecordIds.length,
          options: {
            recordIds: batchRecordIds,
            includeComments: plan.execution.includeComments,
            commentsMaxDetectedItems: plan.execution.commentsPerItemLimit,
            includeBloggerMetrics: plan.execution.includeBloggerMetrics,
            confirmation: {
              confirmed: true,
              source: "mediaclaw_confirm_profile_collection",
              planId: plan.planId,
            },
            riskAuthorization: profileCollectionRiskAuthorization(
              plan,
              "enhancement",
              batchIndex,
              batchRecordIds.length,
              isRetry
                ? `enhancement-retry-${retryPass}`
                : "enhancement",
            ),
          },
        }),
      );
      await detailTask.completion;
      if (parent.status === "cancelled") return false;
      detailBatchResults.push({
        batchIndex: batchIndex + 1,
        requestedCount: batchRecordIds.length,
        recordIds: batchRecordIds,
        phase,
        retryPass,
        status: detailTask.status,
        result: detailTask.result,
        error: detailTask.error || detailTask.result?.error || null,
      });
      detailResult = combineProfileCollectionDetailResults(detailBatchResults);
      const taskInterruption = profileCollectionExecutionInterruption(
        detailTask.error || detailTask.result?.error || {},
        {
          stage: "detail_enhancement",
          batchIndex: batchIndex + 1,
          recordId: batchRecordIds[0] || "",
        },
      );
      const itemInterruption = (detailResult.itemFailures || [])
        .filter((item) => batchRecordIds.includes(item.recordId))
        .map((item) =>
          profileCollectionExecutionInterruption(item.error, {
            stage: "detail_enhancement",
            batchIndex: batchIndex + 1,
            recordId: item.recordId,
          }),
        )
        .find(Boolean);
      executionInterruption =
        executionInterruption || taskInterruption || itemInterruption || null;
      if (executionInterruption) {
        limitations.push(executionInterruption.message);
      }
      return true;
    };
    for (
      let batchIndex = 0;
      batchIndex < detailBatchCount;
      batchIndex += 1
    ) {
      if (parent.status === "cancelled") return;
      const batchRecordIds = recordIds.slice(
        batchIndex * MAX_DEEP_COLLECT_LIMIT,
        (batchIndex + 1) * MAX_DEEP_COLLECT_LIMIT,
      );
      const completed = await runDetailBatch({
        batchRecordIds,
        batchIndex,
        totalBatches: detailBatchCount,
      });
      if (!completed) return;
      if (executionInterruption) break;
    }
    for (
      let retryPass = 1;
      retryPass <= plan.execution.failureRetryPasses && !executionInterruption;
      retryPass += 1
    ) {
      const retryRecordIds = (detailResult?.itemFailures || [])
        .filter((item) =>
          isRetryableProfileCollectionFailure(item.classification),
        )
        .map((item) => item.recordId)
        .filter(Boolean);
      if (retryRecordIds.length === 0) break;
      const retryBatchCount = Math.ceil(
        retryRecordIds.length / MAX_DEEP_COLLECT_LIMIT,
      );
      for (
        let batchIndex = 0;
        batchIndex < retryBatchCount;
        batchIndex += 1
      ) {
        if (parent.status === "cancelled") return;
        const batchRecordIds = retryRecordIds.slice(
          batchIndex * MAX_DEEP_COLLECT_LIMIT,
          (batchIndex + 1) * MAX_DEEP_COLLECT_LIMIT,
        );
        const completed = await runDetailBatch({
          batchRecordIds,
          batchIndex,
          totalBatches: retryBatchCount,
          phase: "retry",
          retryPass,
        });
        if (!completed) return;
        if (executionInterruption) break;
      }
    }
    if (detailResult.failedBatches.length > 0) {
      limitations.push(
        `${detailResult.failedBatches.length} 个详情批次未完成；已按页面加载/解析、权限或风险确认分别标注，不会归因于作品总量上限`,
      );
    }
    if (detailResult.failedCount > 0) {
      limitations.push(
        `${detailResult.failedCount} 条详情记录未完成；单条页面加载或解析失败不属于数量上限，失败项已单独保留`,
      );
    }
    Object.assign(detailStage, {
      status: executionInterruption
        ? "paused"
        : detailResult.failedBatches.length === 0 &&
            detailResult.failedCount === 0
          ? "completed"
          : detailResult.successCount > 0
            ? "partial"
            : "failed",
      finishedAt: nowIso(),
      requestedCount: selectedEntries.length,
      actualCount: Number(detailResult?.successCount || 0),
      failedCount: Number(detailResult?.failedCount || 0),
      retrySummary: {
        configuredPasses: plan.execution.failureRetryPasses,
        attemptedPasses: Number(detailResult?.retryPassesAttempted || 0),
        retryBatchCount: Number(detailResult?.retryBatchCount || 0),
        recoveredCount: Number(detailResult?.recoveredCount || 0),
        unresolvedCount: Number(detailResult?.failedCount || 0),
      },
      batches: detailBatchResults.map((item) => ({
        batchIndex: item.batchIndex,
        phase: item.phase,
        retryPass: item.retryPass,
        requestedCount: item.requestedCount,
        status:
          item.status !== "succeeded"
            ? "failed"
            : Number(item.result?.failedCount || 0) > 0
              ? "partial"
              : "completed",
        actualCount: Number(item.result?.successCount || 0),
        failedCount: Number(item.result?.failedCount || 0),
        failureClassification:
          item.status !== "succeeded"
            ? classifyProfileCollectionFailure(item.error)
            : Number(item.result?.failedCount || 0) > 0
              ? classifyProfileCollectionFailure(
                  profileCollectionDetailEntryError(
                    item.result?.results?.find(
                      (entry) => entry?.ok === false,
                    ),
                  ),
                )
              : null,
        error: item.error,
      })),
      error: detailResult.failedBatches[0]?.error || null,
    });
  }

  const transcriptCandidates =
    plan.intent.purpose === "account_analysis"
      ? selectAccountAnalysisTranscriptEntries(
          selectedEntries,
          platform,
          plan.execution.transcriptQuoteLimit,
        )
      : selectedEntries.filter((entry) =>
          isProfileCollectionVideoEntry(entry, platform),
        );
  const transcriptRecordIds = (
    transcriptCandidates
      .map((entry) => entry.recordId)
      .filter((recordId) =>
        !plan.execution.requiresDetail ||
        !detailResult ||
        detailResult.recordIds.includes(recordId),
      )
  ).slice(0, plan.execution.transcriptQuoteLimit);
  if (
    plan.execution.requestsTranscript &&
    transcriptRecordIds.length > 0 &&
    !executionInterruption
  ) {
    const quoteStage = profileCollectionStage(
      parent,
      executionLog,
      plan,
      "transcript_quote",
      {
        message: `正在为 ${transcriptRecordIds.length} 条视频生成逐字稿报价`,
        totalCount: transcriptRecordIds.length,
      },
    );
    const quoteTask = addChildTask(
      parent,
      startSingleCapture("extract_video_transcript", {
        platform,
        featureKey: "extract.video_transcript",
        options: {
          meteredAction: "quote",
          recordIds: transcriptRecordIds,
        },
      }),
    );
    await quoteTask.completion;
    if (parent.status === "cancelled") return;
    transcriptQuote = quoteTask.result;
    Object.assign(quoteStage, {
      status: quoteTask.status === "succeeded" ? "completed" : "failed",
      finishedAt: nowIso(),
      actualCount: Array.isArray(transcriptQuote?.recordIds)
        ? transcriptQuote.recordIds.length
        : Array.isArray(transcriptQuote?.items)
          ? transcriptQuote.items.length
          : 0,
      error: quoteTask.error || transcriptQuote?.error || null,
    });
  }

  const auditStage = profileCollectionStage(
    parent,
    executionLog,
    plan,
    "coverage_audit",
    {message: "正在核对计划与实际采集覆盖"},
  );
  const detailRequestedCount = plan.execution.requiresDetail
    ? Math.min(
        matchingEntries.length,
        plan.execution.executionItemLimit,
      )
    : 0;
  const detailAttemptedCount = plan.execution.requiresDetail
    ? detailAttemptedRecordIds.size
    : 0;
  const detailSuccessCount = plan.execution.requiresDetail
    ? Number(detailResult?.successCount || 0)
    : 0;
  const detailIncomplete =
    plan.execution.requiresDetail &&
    detailRequestedCount > 0 &&
    detailSuccessCount < detailRequestedCount;
  const scanIncomplete = scanBatchLog.some(
    (item) => item.status === "failed",
  );
  const transcriptQuoteFailed =
    plan.execution.requestsTranscript &&
    transcriptRecordIds.length > 0 &&
    !transcriptQuote?.quoteId;
  const transcriptQuoteItems = Array.isArray(transcriptQuote?.items)
    ? transcriptQuote.items
    : [];
  const transcriptConfirmationRequired = Boolean(
    transcriptQuote?.quoteId &&
      (transcriptQuoteItems.length === 0 ||
        transcriptQuoteItems.some((item) => item?.alreadyExtracted !== true)),
  );
  const profileIncomplete = plan.execution.includeProfile && !profile;
  Object.assign(auditStage, {
    status: executionInterruption ? "paused" : "completed",
    finishedAt: nowIso(),
    actualCount: matchingEntries.length,
  });

  const resultRecords =
    Array.isArray(detailResult?.records) && detailResult.records.length > 0
      ? detailResult.records
      : selectedEntries.map((entry) => entry.record).filter(Boolean);
  const workflowPartial =
    Boolean(executionInterruption) ||
    profileIncomplete ||
    scanIncomplete ||
    detailIncomplete ||
    transcriptQuoteFailed;
  const goalStatus = executionInterruption
    ? "paused_for_user_action"
    : workflowPartial
      ? "partial"
      : transcriptConfirmationRequired
        ? "awaiting_transcript_confirmation"
        : "completed";
  const targetRecordIds = selectedEntries
    .map((entry) => entry.recordId)
    .filter(Boolean);
  const deliveredRecords = archiveEnabled
    ? resultRecords
        .slice(0, MAX_PROFILE_ARCHIVE_RESULT_PREVIEW)
        .map((record) => summarizeProfileCollectionRecord(record))
    : resultRecords;
  const retrySummary = {
    configuredPasses: plan.execution.failureRetryPasses,
    scan: {
      attemptedPasses: scanBatchLog.reduce(
        (sum, item) => sum + Number(item.retryPassesAttempted || 0),
        0,
      ),
      recoveredBatchCount: scanBatchLog.filter(
        (item) => item.recoveredAfterRetry,
      ).length,
      unresolvedBatchCount: scanBatchLog.filter(
        (item) => item.status === "failed",
      ).length,
    },
    detail: {
      attemptedPasses: Number(detailResult?.retryPassesAttempted || 0),
      retryBatchCount: Number(detailResult?.retryBatchCount || 0),
      recoveredRecordCount: Number(detailResult?.recoveredCount || 0),
      unresolvedRecordCount: Number(detailResult?.failedCount || 0),
    },
  };
  const archive = archiveEnabled
    ? {
        archiveJobId: parent.taskId,
        status: goalStatus,
        storage: plan.archive.storage,
        taskRetentionDays: plan.archive.taskRetentionDays,
        recordsStoredInDataPool: true,
        storedRecordCount: targetRecordIds.length,
        detailCompleteCount: detailSuccessCount,
        detailIncompleteCount: Math.max(
          0,
          detailRequestedCount - detailSuccessCount,
        ),
        recordIdPreview: targetRecordIds.slice(
          0,
          MAX_PROFILE_ARCHIVE_RESULT_PREVIEW,
        ),
        resultDelivery: plan.archive.resultDelivery,
        previewCount: deliveredRecords.length,
        fullRecordQuery: plan.archive.fullRecordQuery,
        fullRecordRead: plan.archive.fullRecordRead,
        taskStatusQuery: {
          tool: "mediaclaw_task_status",
          arguments: {taskId: parent.taskId},
        },
        retrySummary,
      }
    : null;
  finishTask(parent, {
    status: executionInterruption ? "input_required" : "succeeded",
    result: {
      ok: !workflowPartial,
      workflow: "profile_collection",
      planId: plan.planId,
      userGoal: plan.userGoal,
      goalStatus,
      archiveJobId: archiveEnabled ? parent.taskId : null,
      intent: plan.intent,
      requestedData: plan.requestedData,
      coverage: {
        profileRequested: plan.execution.includeProfile,
        profileCaptured: Boolean(profile),
        requestedScanCount: plan.execution.scanLimit,
        actualScannedCount: allEntries.length,
        scanBatchCount: scanBatchLog.length,
        scanFailedBatchCount: scanBatchLog.filter(
          (item) => item.status === "failed",
        ).length,
        matchedCount: matchingEntries.length,
        selectedCount: selectedEntries.length,
        detailRequestedCount,
        detailAttemptedCount,
        detailSuccessCount,
        detailFailedCount: Number(detailResult?.failedCount || 0),
        detailUnattemptedCount: Math.max(
          0,
          detailRequestedCount - detailAttemptedCount,
        ),
        detailBatchCount: Number(detailResult?.batchCount || 0),
        detailPrimaryBatchCount: Number(
          detailResult?.primaryBatchCount || 0,
        ),
        detailRetryBatchCount: Number(detailResult?.retryBatchCount || 0),
        transcriptCandidateCount: transcriptRecordIds.length,
        transcriptQuoteItemCount: transcriptQuoteItems.length,
        transcriptAlreadyAvailableCount: transcriptQuoteItems.filter(
          (item) => item?.alreadyExtracted === true,
        ).length,
        transcriptMissingCount: transcriptQuoteItems.filter(
          (item) => item?.alreadyExtracted !== true,
        ).length,
        transcriptConfirmationRequired,
      },
      analysisPerformed: archiveEnabled
        ? [
            "按已确认的数据目标归档账号作品",
            "核对计划范围、数据池记录和详情覆盖",
            "分类重试可恢复故障并保留最终失败项",
          ]
        : [
            "按已确认的数据目标筛选内容类型",
            "核对计划范围与实际匹配数量",
            "汇总详情成功、失败和未执行范围",
            ...(plan.intent.purpose === "account_analysis"
              ? ["按工作台样本规则选择代表详情和视频，并只为缺失逐字稿生成报价"]
              : []),
          ],
      retrySummary,
      executionLog,
      failureSummary: {
        profile: profileFailure
          ? {
              classification: classifyProfileCollectionFailure(profileFailure),
              error: profileFailure,
            }
          : null,
        scanBatches: scanBatchLog
          .filter((item) => item.status === "failed")
          .map((item) => ({
            batchIndex: item.batchIndex,
            classification: item.failureClassification,
            error: item.error,
          })),
        detailBatches: detailResult?.failedBatches || [],
        detailItems: detailResult?.itemFailures || [],
        unclassifiedDetailFailureCount:
          Number(detailResult?.unclassifiedFailedCount || 0),
        quantityLimitFailureCount: [
          ...scanBatchLog
            .filter((item) => item.status === "failed")
            .map((item) => item.failureClassification),
          ...(detailResult?.failedBatches || []).map(
            (item) => item.classification,
          ),
          ...(detailResult?.itemFailures || []).map(
            (item) => item.classification,
          ),
        ].filter((classification) => classification === "batch_planning_error")
          .length,
      },
      profile,
      records: deliveredRecords,
      archive,
      transcriptQuote,
      executionInterruption,
      nextAction: executionInterruption
        ? {
            required: true,
            action:
              executionInterruption.reason === "platform_cooldown"
                ? "wait_for_platform_cooldown"
                : executionInterruption.reason === "verification_required"
                  ? "complete_browser_verification"
                  : "restore_browser_login",
            title: executionInterruption.title,
            message: executionInterruption.message,
            nextAllowedAt: executionInterruption.nextAllowedAt,
            continuation: executionInterruption.continuation,
            preservesCompletedRecords:
              executionInterruption.preservesCompletedRecords,
            doesNotMeanUnsupported:
              executionInterruption.doesNotMeanUnsupported,
          }
        : null,
      nextConfirmation:
        transcriptConfirmationRequired
          ? {
              required: true,
              action: "confirm_video_transcript",
              quoteId: transcriptQuote.quoteId,
              message: "只对尚未提取的逐字稿收费；请先向用户展示逐条积分、总积分、余额和有效期，取得明确同意后再确认",
            }
          : null,
      limitations,
    },
    error: null,
    message:
      executionInterruption
        ? executionInterruption.message
        : goalStatus === "awaiting_transcript_confirmation"
        ? `已完成 ${matchingEntries.length} 条匹配记录的采集准备，逐字稿等待报价确认`
        : goalStatus === "partial"
          ? `已保留部分结果：扫描 ${allEntries.length}/${plan.execution.scanLimit} 条，匹配 ${matchingEntries.length} 条，详情成功 ${detailSuccessCount}/${detailRequestedCount} 条；失败原因已单独分类`
        : `已扫描 ${allEntries.length} 条作品，匹配 ${matchingEntries.length} 条，完成 ${detailSuccessCount || selectedEntries.length} 条目标记录`,
  });
}

function startProfileCollectionWorkflow(plan) {
  const archiveEnabled = plan.archive?.enabled === true;
  const task = createTask({
    kind: "workflow",
    taskId: archiveEnabled ? createId("archive") : "",
    input: {
      planId: plan.planId,
      userGoal: plan.userGoal,
      operationMode: plan.intent.operationMode,
      profileUrl: plan.intent.profileUrl,
      platform: plan.intent.platform,
    },
    ttlMs: archiveEnabled ? PROFILE_ARCHIVE_JOB_TTL_MS : TASK_TTL_MS,
  });
  plan.usedAt = nowIso();
  void runProfileCollectionWorkflow(task, plan);
  return task;
}

async function runAccountHitsResearch(parent, input = {}) {
  if (!extensionPeer) {
    finishTask(parent, {
      status: "failed",
      error: {
        code: "EXTENSION_NOT_CONNECTED",
        message: "MediaClaw 插件尚未连接",
      },
    });
    return;
  }
  const profileUrl = normalizeText(input.profileUrl || input.url);
  const platform = normalizePlatform(input.platform);
  const scanLimit = normalizeLimit(input.scanLimit || input.limit, DEFAULT_SCAN_LIMIT);
  const recentPostLimit = Math.min(
    scanLimit,
    Math.max(5, Math.floor(Number(input.recentPostLimit) || 30)),
  );
  const resultLimit = Math.min(
    recentPostLimit,
    Math.max(1, Math.floor(Number(input.resultLimit) || 10)),
  );

  updateTask(parent, {
    status: "running",
    message: "正在采集账号近期作品并筛选高表现内容",
  });
  const scan = addChildTask(
    parent,
    startSingleCapture("profile_posts", {
      profileUrl,
      platform,
      limit: scanLimit,
      options: {
        detailCapture: false,
        minLikes: Math.max(0, Number(input.minLikes) || 0),
      },
    }),
  );
  await scan.completion;
  if (scan.status !== "succeeded") {
    finishTask(parent, {
      status: "failed",
      error: scan.error || {
        code: "ACCOUNT_SCAN_FAILED",
        message: "账号作品扫描失败",
      },
    });
    return;
  }

  const records = collectAnalysisRecordsFromTaskResult(scan.result);
  const datedCount = records.filter((item) =>
    Number.isFinite(Date.parse(String(item?.publishTime || ""))),
  ).length;
  const canUsePublishTime = records.length > 0 && datedCount >= records.length * 0.8;
  const recencyOrdered = canUsePublishTime
    ? [...records].sort(
        (left, right) =>
          (Date.parse(String(right?.publishTime || "")) || 0) -
          (Date.parse(String(left?.publishTime || "")) || 0),
      )
    : [...records];
  const recentPool = recencyOrdered
    .slice(0, recentPostLimit)
    .map((item, index) => ({...item, recentRank: index + 1}));
  const recentLikes = recentPool.map((item) => Number(item?.likes) || 0);
  const medianLikes = percentile(recentLikes, 0.5);
  const topPosts = [...recentPool]
    .sort((left, right) => {
      const likeDiff = (Number(right?.likes) || 0) - (Number(left?.likes) || 0);
      if (likeDiff !== 0) return likeDiff;
      const collectDiff =
        (Number(right?.collects) || 0) - (Number(left?.collects) || 0);
      if (collectDiff !== 0) return collectDiff;
      return (Number(right?.comments) || 0) - (Number(left?.comments) || 0);
    })
    .slice(0, resultLimit)
    .map((item, index) => ({
      ...item,
      hitRank: index + 1,
      recentMedianMultiple:
        medianLikes > 0
          ? Number(((Number(item.likes) || 0) / medianLikes).toFixed(2))
          : null,
    }));
  const limitations = [];
  if (!canUsePublishTime) {
    limitations.push(
      "账号作品列表未提供足够可靠的发布时间，近期范围按主页作品展示顺序截取",
    );
  }
  if (records.length < scanLimit) {
    limitations.push(`计划扫描 ${scanLimit} 条，实际获得 ${records.length} 条`);
  }
  if (recentPool.length < recentPostLimit) {
    limitations.push(
      `计划比较最近 ${recentPostLimit} 条，实际可比较 ${recentPool.length} 条`,
    );
  }

  finishTask(parent, {
    status: topPosts.length > 0 ? "succeeded" : "failed",
    result: {
      ok: topPosts.length > 0,
      researchType: "account_recent_hits",
      ...recommendedMethod(ACCOUNT_HITS_METHOD_ID),
      datasetId: parent.taskId,
      coverage: {
        profileUrl,
        platform,
        requestedScanCount: scanLimit,
        actualScanCount: records.length,
        requestedRecentPostCount: recentPostLimit,
        actualRecentPostCount: recentPool.length,
        resultCount: topPosts.length,
        recencyBasis: canUsePublishTime
          ? "publish_time"
          : "profile_page_order",
        datedRecordCount: datedCount,
      },
      computedMetrics: {
        recentMedianLikes: medianLikes,
        recentMaxLikes: Math.max(0, ...recentLikes),
        recentAverageLikes: Math.round(average(recentLikes)),
      },
      topPosts,
      records,
      limitations,
    },
    error:
      topPosts.length > 0
        ? null
        : {code: "NO_RESULTS", message: "没有采集到可排序的账号作品"},
    message: `已从最近 ${recentPool.length} 条作品中筛出 ${topPosts.length} 条高表现内容`,
  });
}

function startAccountHitsResearch(input = {}) {
  const task = createTask({kind: "workflow", input});
  void runAccountHitsResearch(task, input);
  return task;
}

function aggregateBenchmarkCandidates(records = []) {
  const groups = new Map();
  for (const record of records) {
    const authorUrl = normalizeText(record?.authorUrl);
    const author = normalizeText(record?.author, 240);
    if (!authorUrl && !author) continue;
    const key = authorUrl || `name:${author.toLowerCase()}`;
    const current = groups.get(key) || {
      author,
      authorUrl,
      postCount: 0,
      totalLikes: 0,
      totalCollects: 0,
      totalComments: 0,
      maxLikes: 0,
      representativePosts: [],
    };
    current.postCount += 1;
    current.totalLikes += Number(record?.likes) || 0;
    current.totalCollects += Number(record?.collects) || 0;
    current.totalComments += Number(record?.comments) || 0;
    current.maxLikes = Math.max(current.maxLikes, Number(record?.likes) || 0);
    current.representativePosts.push(record);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((candidate) => ({
      ...candidate,
      averageLikes: Math.round(candidate.totalLikes / candidate.postCount),
      averageCollects: Math.round(
        candidate.totalCollects / candidate.postCount,
      ),
      averageComments: Math.round(
        candidate.totalComments / candidate.postCount,
      ),
      representativePosts: candidate.representativePosts
        .sort((left, right) => (Number(right.likes) || 0) - (Number(left.likes) || 0))
        .slice(0, 3),
    }))
    .sort((left, right) => {
      const maxDiff = right.maxLikes - left.maxLikes;
      if (maxDiff !== 0) return maxDiff;
      const avgDiff = right.averageLikes - left.averageLikes;
      if (avgDiff !== 0) return avgDiff;
      return right.postCount - left.postCount;
    });
}

async function runBenchmarkAccountResearch(parent, input = {}) {
  if (!extensionPeer) {
    finishTask(parent, {
      status: "failed",
      error: {
        code: "EXTENSION_NOT_CONNECTED",
        message: "MediaClaw 插件尚未连接",
      },
    });
    return;
  }
  const keyword = normalizeText(input.keyword, 200);
  const platform = normalizePlatform(input.platform);
  const scanLimit = normalizeLimit(input.scanLimit || input.limit, 80);
  const candidateLimit = Math.min(
    20,
    Math.max(1, Math.floor(Number(input.candidateLimit) || 8)),
  );
  updateTask(parent, {
    status: "running",
    message: `正在从“${keyword}”高表现内容中发现对标账号`,
  });
  const scan = addChildTask(
    parent,
    startSingleCapture("search_results", {
      keyword,
      platform,
      limit: scanLimit,
      options: buildKeywordCaptureOptions(input, {
        timeRange: "any",
        sortBy: "likes",
        contentType: "all",
        prepareKeywordStrategy: true,
      }),
    }),
  );
  await scan.completion;
  if (scan.status !== "succeeded") {
    finishTask(parent, {
      status: "failed",
      error: scan.error || {
        code: "BENCHMARK_SCAN_FAILED",
        message: "对标账号候选采集失败",
      },
    });
    return;
  }

  const records = collectAnalysisRecordsFromTaskResult(scan.result);
  const candidates = aggregateBenchmarkCandidates(records).slice(
    0,
    candidateLimit,
  );
  let missingProfileUrlCount = 0;
  let failedProfileCount = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    if (parent.status === "cancelled") return;
    const candidate = candidates[index];
    if (!candidate.authorUrl) {
      missingProfileUrlCount += 1;
      continue;
    }
    updateTask(parent, {
      progress: {
        phase: "profile_enrichment",
        processedCount: index,
        totalCount: candidates.length,
        currentProfileUrl: candidate.authorUrl,
      },
      message: `正在补采候选账号 ${index + 1}/${candidates.length}`,
    });
    const profileTask = addChildTask(
      parent,
      startSingleCapture("profile_info", {
        profileUrl: candidate.authorUrl,
        platform,
      }),
    );
    await profileTask.completion;
    if (profileTask.status === "succeeded" && profileTask.result?.profile) {
      candidate.profile = profileTask.result.profile;
    } else {
      failedProfileCount += 1;
    }
  }

  const preparation = findStrategyPreparation(scan.result?.diagnostics);
  const limitations = [];
  if (records.length < scanLimit) {
    limitations.push(`计划采集 ${scanLimit} 条，实际获得 ${records.length} 条`);
  }
  if (missingProfileUrlCount > 0) {
    limitations.push(
      `${missingProfileUrlCount} 个候选缺少主页链接，未补采账号画像`,
    );
  }
  if (failedProfileCount > 0) {
    limitations.push(`${failedProfileCount} 个候选账号画像补采失败`);
  }
  if (preparation && preparation.appliedSort === false) {
    limitations.push("未确认平台已成功切换到点赞排序");
  }

  finishTask(parent, {
    status: candidates.length > 0 ? "succeeded" : "failed",
    result: {
      ok: candidates.length > 0,
      researchType: "benchmark_account_discovery",
      ...recommendedMethod(BENCHMARK_ACCOUNT_METHOD_ID),
      datasetId: parent.taskId,
      coverage: {
        keyword,
        platform,
        requestedScanCount: scanLimit,
        actualScanCount: records.length,
        requestedCandidateCount: candidateLimit,
        actualCandidateCount: candidates.length,
        enrichedProfileCount: candidates.filter((item) => item.profile).length,
        requestedFilters: {
          timeRange: normalizeKeywordTimeRange(input.timeRange || "any"),
          sortBy: normalizeKeywordSortBy(input.sortBy || "likes"),
          contentType: normalizeKeywordContentType(input.contentType || "all"),
          videoDuration: normalizeKeywordVideoDuration(
            input.videoDuration || "all",
          ),
          searchScope: normalizeKeywordSearchScope(input.searchScope || "all"),
          locationScope: normalizeKeywordLocationScope(
            input.locationScope || "all",
          ),
        },
        appliedFilters: preparation,
      },
      candidates: candidates.map((candidate, index) => ({
        rank: index + 1,
        ...candidate,
      })),
      records,
      limitations,
    },
    error:
      candidates.length > 0
        ? null
        : {
            code: "NO_BENCHMARK_CANDIDATES",
            message: "搜索结果中没有可识别的账号候选",
          },
    message: `已从 ${records.length} 条内容中整理 ${candidates.length} 个对标账号候选`,
  });
}

function startBenchmarkAccountResearch(input = {}) {
  const task = createTask({kind: "workflow", input});
  void runBenchmarkAccountResearch(task, input);
  return task;
}

async function runSingleNoteResearch(parent, input = {}) {
  if (!extensionPeer) {
    finishTask(parent, {
      status: "failed",
      error: {
        code: "EXTENSION_NOT_CONNECTED",
        message: "MediaClaw 插件尚未连接",
      },
    });
    return;
  }
  const url = normalizeText(input.url);
  const platform = normalizePlatform(input.platform);
  const analysisTranscriptDecision = normalizeEnum(
    input.analysisTranscriptDecision,
    ["user_requested", "recommend", "not_needed"],
    "",
  );
  const analysisTranscriptReason = normalizeText(
    input.analysisTranscriptReason,
    800,
  );
  if (!analysisTranscriptDecision) {
    finishTask(parent, {
      status: "failed",
      error: {
        code: "TRANSCRIPT_DECISION_REQUIRED",
        message:
          "单篇分析必须先判断逐字稿是否会显著提升当前任务：请设置 analysisTranscriptDecision=user_requested、recommend 或 not_needed",
      },
    });
    return;
  }
  if (
    ["recommend", "not_needed"].includes(analysisTranscriptDecision) &&
    !analysisTranscriptReason
  ) {
    finishTask(parent, {
      status: "failed",
      error: {
        code: "TRANSCRIPT_DECISION_REASON_REQUIRED",
        message: "单篇分析必须说明逐字稿必要性判断理由，不能机械提取或机械跳过",
      },
    });
    return;
  }
  updateTask(parent, {
    status: "running",
    message: "正在采集单篇内容详情",
  });
  const detail = addChildTask(
    parent,
    startSingleCapture("current_note", {
      url,
      platform,
      featureKey: "capture.detail_preview",
      options: {
        includeComments: false,
        includeBloggerMetrics: false,
      },
    }),
  );
  await detail.completion;
  const detailItems = collectDetailItemsFromTaskResult(detail.result);
  if (detail.status !== "succeeded" || !detailItems[0]) {
    finishTask(parent, {
      status: "failed",
      error: detail.error || {
        code: "SINGLE_NOTE_CAPTURE_FAILED",
        message: "单篇内容详情采集失败",
      },
    });
    return;
  }

  const source = detailItems[0];
  const recordId = detail.result.recordIds?.[0] || "";
  let comments = [];
  const limitations = [];
  if (input.includeComments !== false) {
    updateTask(parent, {
      message: "正在补采评论样本",
    });
    const commentTask = addChildTask(
      parent,
      startSingleCapture("comments", {
        url,
        platform,
        featureKey: "capture.comments",
        limit: Math.min(
          500,
          Math.max(1, Math.floor(Number(input.commentLimit) || 30)),
        ),
      }),
    );
    await commentTask.completion;
    if (commentTask.status === "succeeded") {
      comments = Array.isArray(commentTask.result?.comments)
        ? commentTask.result.comments
        : [];
    } else {
      limitations.push("评论采集失败，当前结果只包含内容本身");
    }
  }

  let mediaText = null;
  let mediaPaywall = null;
  const contentType = String(source.contentType || "").toLowerCase();
  const isVideo = contentType.includes("video") || Boolean(source.videoUrl);
  const hasImages =
    Array.isArray(source.imageUrls) && source.imageUrls.length > 0;
  const shouldPrepareTranscript =
    isVideo &&
    ["user_requested", "recommend"].includes(analysisTranscriptDecision);
  if (
    recordId &&
    (shouldPrepareTranscript ||
      (input.includeMediaText !== false && hasImages && !isVideo))
  ) {
    if (shouldPrepareTranscript) {
      updateTask(parent, {
        message: "正在生成这条视频的逐字稿报价",
      });
      const quoteTask = addChildTask(
        parent,
        startSingleCapture("extract_video_transcript", {
          platform,
          featureKey: "extract.video_transcript",
          options: {
            meteredAction: "quote",
            recordIds: [recordId],
          },
        }),
      );
      await quoteTask.completion;
      const transcriptQuote = quoteTask.result || null;
      const quoteItems = Array.isArray(transcriptQuote?.items)
        ? transcriptQuote.items
        : [];
      const transcriptAlreadyAvailable =
        quoteTask.status === "succeeded" &&
        quoteItems.length > 0 &&
        quoteItems.every((item) => item?.alreadyExtracted === true);
      if (transcriptAlreadyAvailable) {
        const transcriptTask = addChildTask(
          parent,
          startSingleCapture("data_pool_query", {
            platform,
            options: {
              operation: "transcript",
              recordId,
              format: "plain",
              offset: 0,
              limit: 12_000,
            },
          }),
        );
        await transcriptTask.completion;
        mediaText =
          transcriptTask.status === "succeeded"
            ? {
                ...(transcriptTask.result || {}),
                status: "already_available",
                recordId,
                chargedCredits: 0,
              }
            : {
                ok: true,
                status: "already_available_read_failed",
                recordId,
                chargedCredits: 0,
                quote: transcriptQuote,
              };
        if (transcriptTask.status !== "succeeded") {
          limitations.push("逐字稿已存在且无需积分，但本次精确读取失败");
        }
      } else if (quoteTask.status === "succeeded" && transcriptQuote?.quoteId) {
        mediaText = {
          ...transcriptQuote,
          status: transcriptQuote.status || "quoted",
          recordId,
          nextConfirmation: {
            required: true,
            action: "confirm_video_transcript",
            quoteId: transcriptQuote.quoteId,
            message: "请先向用户展示逐条积分、总积分、余额和有效期，取得明确同意后再确认",
          },
        };
        limitations.push("视频逐字稿已经报价，用户确认 quoteId 后才会提取和扣积分");
      } else {
        mediaText = {
          ok: false,
          status: "quote_failed",
          recordId,
          error: quoteTask.error || transcriptQuote?.error || null,
        };
        limitations.push("视频逐字稿报价失败，当前只能基于标题、正文和互动数据分析");
      }
    } else {
      updateTask(parent, {
        message: "正在提取图片文字",
      });
      const extractionTask = addChildTask(
        parent,
        startSingleCapture("extract_image_text", {
          platform,
          options: {
            recordId,
            force: input.forceMediaExtraction === true,
          },
          }),
      );
      await extractionTask.completion;
      mediaText = extractionTask.result || null;
      if (extractionTask.status !== "succeeded") {
        mediaPaywall = extractionTask.error?.paywall || null;
        if (mediaPaywall) {
          mediaText = {
            ok: false,
            status: "paywall_required",
            paywall: mediaPaywall,
          };
          limitations.push(
            "图片文字尚未提取；仍可基于标题、正文和互动数据完成基础分析",
          );
        } else {
          limitations.push("图片文字提取失败");
        }
      }
    }
  } else if (isVideo && !shouldPrepareTranscript) {
    mediaText = {
      ok: true,
      status: "not_needed",
      decision: analysisTranscriptDecision,
      reason: analysisTranscriptReason,
      chargedCredits: 0,
    };
  } else if (
    !recordId &&
    (shouldPrepareTranscript ||
      (input.includeMediaText !== false && hasImages && !isVideo))
  ) {
    limitations.push("详情已采集，但没有拿到数据池记录 ID，未执行媒体文字提取");
  }

  finishTask(parent, {
    status: "succeeded",
    result: {
      ok: true,
      researchType: "single_note_breakdown",
      ...recommendedMethod(SINGLE_NOTE_METHOD_ID),
      datasetId: parent.taskId,
      coverage: {
        url,
        platform,
        recordId: recordId || null,
        commentCount: comments.length,
        mediaTextStatus: mediaText?.status || "not_requested",
        transcriptConfirmationRequired:
          mediaText?.nextConfirmation?.required === true,
        transcriptEstimatedCredits:
          Number(mediaText?.totalEstimatedCredits ?? mediaText?.estimatedCredits) || 0,
        transcriptRemainingCredits:
          Number.isFinite(
            Number(mediaText?.remainingCredits ?? mediaText?.balance),
          )
            ? Number(mediaText?.remainingCredits ?? mediaText?.balance)
            : null,
        transcriptDecision: analysisTranscriptDecision,
        transcriptDecisionReason: analysisTranscriptReason || null,
      },
      source,
      mediaText,
      ...(mediaPaywall ? {paywall: mediaPaywall} : {}),
      comments,
      computedMetrics: {
        likes: Number(source.likes) || 0,
        collects: Number(source.collects) || 0,
        comments: Number(source.comments) || comments.length,
        collectedCommentCount: comments.length,
      },
      records: [source],
      limitations,
    },
    message: `单篇内容数据已准备完成，包含 ${comments.length} 条评论样本`,
  });
}

function startSingleNoteResearch(input = {}) {
  const task = createTask({kind: "workflow", input});
  void runSingleNoteResearch(task, input);
  return task;
}


function collectDatasetRecords(task) {
  const result = task?.result;
  if (!result || typeof result !== "object") return [];
  if (Array.isArray(result.records)) return result.records;
  if (Array.isArray(result.expandedKeywords)) {
    return result.expandedKeywords.map((keyword) => ({keyword}));
  }
  if (Array.isArray(result.results)) {
    return result.results.flatMap((item) =>
      Array.isArray(item?.records) ? item.records : [],
    );
  }
  return [];
}

function queryDataset(task, input = {}) {
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 50)));
  const sortBy = normalizeEnum(
    input.sortBy,
    ["original", "likes", "collects", "comments", "publish_time"],
    "original",
  );
  const contentType = normalizeKeywordContentType(input.contentType);
  let records = collectDatasetRecords(task);
  if (contentType !== "all") {
    records = records.filter((item) => {
      const type = String(item?.contentType || "").toLowerCase();
      return contentType === "video"
        ? type.includes("video") || type.includes("视频")
        : type.includes("image") ||
            type.includes("图文") ||
            type.includes("图片");
    });
  }
  if (sortBy !== "original") {
    const field = sortBy === "publish_time" ? "publishTime" : sortBy;
    records = [...records].sort((left, right) => {
      if (field === "publishTime") {
        return (
          (Date.parse(String(right?.[field] || "")) || 0) -
          (Date.parse(String(left?.[field] || "")) || 0)
        );
      }
      return (Number(right?.[field]) || 0) - (Number(left?.[field]) || 0);
    });
  }
  return {
    ok: true,
    datasetId: task.taskId,
    totalCount: records.length,
    offset,
    limit,
    nextOffset: offset + limit < records.length ? offset + limit : null,
    records: records.slice(offset, offset + limit),
  };
}

async function cancelTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) {
    return {ok: false, error: {code: "TASK_NOT_FOUND", message: "任务不存在"}};
  }
  if (
    ["succeeded", "failed", "cancelled", "input_required"].includes(
      task.status,
    )
  ) {
    return {ok: true, canceled: false, task: taskSnapshot(task)};
  }
  if (
    (task.kind === "batch" || task.kind === "workflow") &&
    task.currentChildTaskId
  ) {
    const childResult = await cancelTask(task.currentChildTaskId);
    if (!childResult.canceled) return childResult;
  }
  if (task.status === "queued" && activeExtensionTaskId !== task.taskId) {
    updateTask(task, {status: "cancelled", message: "等待中的任务已取消"});
    task.resolveCompletion(task);
    pumpQueue();
    return {ok: true, canceled: true, task: taskSnapshot(task)};
  }
  if (!extensionPeer) {
    return {
      ok: false,
      canceled: false,
      error: {code: "EXTENSION_DISCONNECTED", message: "浏览器插件未连接，无法确认取消"},
      task: taskSnapshot(task),
    };
  }
  if (pendingTaskCancellations.has(taskId)) {
    return await pendingTaskCancellations.get(taskId).promise;
  }

  const previousStatus = task.status;
  updateTask(task, {status: "cancel_pending", message: "正在等待浏览器确认取消"});
  let settle;
  const responsePromise = new Promise((resolve) => {
    settle = resolve;
  });
  let timer;
  const promise = (async () => {
    const response = await Promise.race([
      responsePromise,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ok: false, canceled: false, reason: "timeout"}),
          TASK_CANCEL_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(timer);
    pendingTaskCancellations.delete(taskId);
    if (response?.ok === true && response?.canceled === true) {
      updateTask(task, {status: "cancelled", message: "浏览器已确认任务取消"});
      if (activeExtensionTaskId === taskId) activeExtensionTaskId = "";
      task.resolveCompletion(task);
      pumpQueue();
      return {ok: true, canceled: true, task: taskSnapshot(task)};
    }
    if (
      ["succeeded", "failed", "cancelled", "input_required"].includes(
        task.status,
      )
    ) {
      return {
        ok: task.status === "cancelled",
        canceled: task.status === "cancelled",
        error:
          task.status === "cancelled"
            ? undefined
            : {code: "CANCEL_TOO_LATE", message: "任务已在取消确认前结束"},
        task: taskSnapshot(task),
      };
    }
    updateTask(task, {
      status:
        extensionPeer && activeExtensionTaskId === taskId
          ? previousStatus === "waiting_for_extension" ? "waiting_for_extension" : "running"
          : "waiting_for_extension",
      message:
        response?.reason === "timeout"
          ? "取消确认超时，任务未标记为已取消"
          : "浏览器未确认取消，任务保持可恢复",
    });
    const code =
      response?.reason === "timeout"
        ? "CANCEL_TIMEOUT"
        : response?.reason === "extension_disconnected"
          ? "EXTENSION_DISCONNECTED"
          : "CANCEL_REJECTED";
    return {
      ok: false,
      canceled: false,
      error: {
        code,
        message:
          response?.message ||
          response?.error?.message ||
          (code === "CANCEL_TIMEOUT"
            ? "等待浏览器确认取消超时"
            : "浏览器未确认任务取消"),
      },
      task: taskSnapshot(task),
    };
  })();
  pendingTaskCancellations.set(taskId, {resolve: settle, promise});
  extensionPeer.send({
    type: "task.cancel",
    taskId: task.taskId,
    deviceId: task.owner?.deviceId || "",
    sessionId: deviceSessions.get(task.owner?.deviceId)?.sessionId || "",
  });
  return await promise;
}

// Keep the portable async:true + task_status contract as the advertised path.
// Some MCP clients still reject native task responses even when they request
// them, so exposing execution.taskSupport currently makes otherwise valid
// tool calls fail before the task handle reaches the Agent.
const SEARCH_FILTER_SCHEMA_PROPERTIES = Object.freeze({
  timeRange: Object.freeze({
    type: "string",
    enum: ["any", "1d", "7d", "6m"],
    default: "any",
    description:
      "发布时间：不限/一天内/一周内/半年内。两平台均支持；不存在 30d 或 1y。",
  }),
  sortBy: Object.freeze({
    type: "string",
    enum: ["default", "latest", "likes", "comments", "collects"],
    default: "default",
    description:
      "排序。小红书支持全部值；抖音仅支持 default/latest/likes，其他值会被拒绝。",
  }),
  contentType: Object.freeze({
    type: "string",
    enum: ["all", "video", "image"],
    default: "all",
    description: "小红书笔记类型；抖音仅允许中性值 all。",
  }),
  videoDuration: Object.freeze({
    type: "string",
    enum: ["all", "under_1m", "between_1m_5m", "over_5m"],
    default: "all",
    description: "抖音视频时长；小红书仅允许中性值 all。",
  }),
  searchScope: Object.freeze({
    type: "string",
    enum: ["all", "seen", "unseen", "followed"],
    default: "all",
    description: "搜索范围：不限/看过/未看过/已关注。",
  }),
  locationScope: Object.freeze({
    type: "string",
    enum: ["all", "city", "nearby"],
    default: "all",
    description: "小红书位置距离；抖音仅允许中性值 all。",
  }),
});

const captureExecution = undefined;
const tools = [
  {
    name: "mediaclaw_connection_status",
    description:
      "检查 MediaClaw 浏览器插件是否已开启并连接。开始采集前先调用。",
    inputSchema: {type: "object", properties: {}, additionalProperties: false},
  },
  {
    name: "mediaclaw_list_paired_devices",
    description: "列出当前插件已批准且未撤销的本机 Agent 设备。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {async: {type: "boolean", default: false}},
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_list_assets",
    description:
      "统一列出 MediaClaw 资产。用户说‘分析这个账号’时，必须依次查询 local.studio、remote.workbench 的 account_analysis；都没有时再查询 local.data_pool 的 capture_record，只有原始数据也没有或证据覆盖不足时才制定补采方案。用户说‘分析这篇’时对 note_breakdown 与对应 capture_record 执行同样顺序。已有分析默认直接复用，不重复分析；只有用户明确要求重新分析、更新或旧报告不能回答当前问题时才读取原始证据重算。模仿或仿写则先查 local.studio 的 style_profile，本地未命中再查 remote.workbench。全量账号归档使用 local.data_pool + capture_record，并按返回方案的 profileUrl、platform、recordType、contentType filters 与 cursor 分页。返回稳定 assetId，随后必须读取完整对象。浏览器本地数据池和本地 Studio 数据无限读取；remote.workbench 需要有效会员。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["local.data_pool", "local.studio", "remote.workbench"],
        },
        type: {
          type: "string",
          enum: [
            "capture_record",
            "note_breakdown",
            "account_analysis",
            "style_profile",
            "topic",
            "generated_content",
          ],
        },
        filters: {type: "object", additionalProperties: true},
        cursor: {type: "string"},
        limit: {type: "integer", minimum: 1, maximum: 100, default: 50},
        async: {type: "boolean", default: false},
      },
      required: ["source", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_get_asset",
    description:
      "按 mediaclaw_list_assets 返回的稳定 assetId 读取资产。local.data_pool 与 remote.workbench 的账号分析默认只返回 manifest 和 identity，避免完整评论、逐字稿、工作台报告或原始样本一次性堵塞 Agent 上下文；再按任务选择语义分区，并沿 page.nextCursor 读取大型数组。工作台账号报告可读取 reportOverview/reportStrategy/reportExpression/reportFrameworks/reportIdeation/stylePack/evidence/sampleAnalyses/samples/coverage，其中 samples 是后端保存的原始分析样本。读取不会重新采集、打开作品页或扣积分；只有无损调试才使用 view=raw。读取失败或超时不代表本地未命中，禁止自动改用采集工具。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        assetId: {type: "string"},
        view: {
          type: "string",
          enum: ["sections", "raw"],
          default: "sections",
          description: "sections 为 Agent 默认读取视图；raw 仅用于无损调试。",
        },
        sections: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "identity",
              "content",
              "creator",
              "metrics",
              "media",
              "comments",
              "extractedContent",
              "context",
              "reportOverview",
              "reportStrategy",
              "reportExpression",
              "reportFrameworks",
              "reportIdeation",
              "stylePack",
              "evidence",
              "sampleAnalyses",
              "samples",
              "coverage",
            ],
          },
          uniqueItems: true,
          description: "需要读取的资产语义分区；省略时返回 identity 和完整 manifest。",
        },
        page: {
          type: "object",
          properties: {
            path: {
              type: "string",
              enum: [
                "media.imageUrls",
                "media.videoUrls",
                "media.audioUrls",
                "comments.items",
                "comments.mergedText",
                "comments.leads",
                "extractedContent.imageText.text",
                "extractedContent.imageText.pages",
                "extractedContent.transcript.text",
                "extractedContent.transcript.sentenceText",
                "extractedContent.transcript.sentences",
                "context.items",
                "report.contentPillars",
                "report.topicPatterns",
                "report.viralPatterns",
                "report.contentFrameworks",
                "report.scriptArchetypes",
                "report.topicPlaybooks",
                "report.ideaBank",
                "report.audienceInsights",
                "report.topicDirections",
                "report.learnable",
                "report.avoid",
                "stylePack.contentPillars",
                "stylePack.topicRules",
                "stylePack.titleRules",
                "stylePack.angleRules",
                "stylePack.viewpointRules",
                "stylePack.contentFrameworks",
                "stylePack.diagnosisRubric",
                "stylePack.avoidRules",
                "evidenceIndex",
                "evidenceSamples",
                "sampleAnalyses",
                "samples",
              ],
            },
            cursor: {type: "string", default: "0"},
            limit: {type: "integer", minimum: 1, maximum: 50000},
          },
          required: ["path"],
          additionalProperties: false,
          description: "大型数组或长文本的通用分页参数。数据池数组单页最多 500 项、文本最多 50000 字符；工作台报告数组和原始样本单页最多 100 项。",
        },
        async: {type: "boolean", default: false},
      },
      required: ["assetId"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_capture_note",
    description:
      "仅在 local.studio、remote.workbench 都没有匹配 note_breakdown，且 local.data_pool 也没有匹配 capture_record 或证据确有缺口时，调用插件现有的单条笔记完整采集能力。单条路径可按插件现状附带评论和博主指标，不增加 Agent 专属限制。分析必须采用工作台单篇契约，不得另写精简版框架。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        url: {type: "string"},
        platform: {type: "string", enum: ["xiaohongshu", "douyin"]},
        includeComments: {type: "boolean", default: false},
        commentsPerItemLimit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 30,
        },
        includeBloggerMetrics: {type: "boolean", default: false},
        idempotencyKey: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_capture_search_basic",
    description:
      "调用插件的搜索页基础列表采集，明确禁止隐式打开详情页。Agent 应把自然语言意图转成标准筛选参数：‘最近’通常为 7d，‘最新’使用 latest 排序，‘趋势’通常为 6m；用户明确范围时严格照办。插件会按平台校验并真实点击全部筛选维度，包括中性值，以清除页面遗留筛选；任何请求条件未确认应用时停止采集。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        keyword: {type: "string"},
        platform: {type: "string", enum: ["xiaohongshu", "douyin"]},
        limit: {type: "integer", minimum: 1, maximum: 300, default: 80},
        ...SEARCH_FILTER_SCHEMA_PROPERTIES,
        idempotencyKey: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_capture_profile_basic",
    description:
      "调用插件的账号作品基础列表采集，明确禁止隐式打开详情页。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        profileUrl: {type: "string"},
        platform: {type: "string", enum: ["xiaohongshu", "douyin"]},
        limit: {type: "integer", minimum: 1, maximum: 300, default: 80},
        idempotencyKey: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["profileUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_prepare_profile_collection",
    description:
      "仅在账号分析报告与已采集账号作品都无法满足当前分析时，根据已经澄清的用户用途和数据缺口制定账号采集方案；不启动浏览器、不采集数据。purpose=account_analysis 会自动补齐工作台同构的基础作品、15 条高/典型/低表现代表详情和最多 12 个封面证据；逐字稿不是机械默认项。若用户没有主动要求逐字稿，Agent 必须先用 analysisTranscriptDecision 和 analysisTranscriptReason 判断它是否会显著提升当前问题：默认优先 not_needed；只有分析口播、叙事、语言、节奏或视频内容机制等必须依赖真实口播时才 recommend，并对最多 8 条最小代表样本报价。用户也可以主动要求逐字稿，或用‘视频文案／口播文字／视频说了什么／字幕文字版’等同义表达触发。逐字稿只生成报价，必须展示逐条积分、总积分、余额和有效期并取得明确确认后才提取。detailMaxItems 与 transcriptMaxItems 可覆盖代表层数量，但不会把 50 条基础作品误变成 50 个详情页。‘全部采下来／完整导出／爬这个账号／每篇详情都要’必须映射为 full_collection，不套用研究建议终点。工具会保留用户明确要求的总量，把超过单批或连续建议额度的目标拆成可审计批次，并返回普通／黄色／红色三级确认。风险提示不会静默缩小用户范围。",
    inputSchema: {
      type: "object",
      properties: {
        userGoal: {
          type: "string",
          description: "保留用户已经确认的数据目标，用于执行审计和防止目标被默认能力降级。",
        },
        profileUrl: {type: "string", description: "账号主页链接"},
        platform: {type: "string", enum: ["xiaohongshu", "douyin"]},
        purpose: {
          type: "string",
          enum: [
            "full_collection",
            "inventory_export",
            "account_analysis",
            "representative_research",
          ],
          description:
            "用户用途：完整归档、清单导出、账号分析或代表作品机制研究。用途决定建议量，但不会覆盖用户明确选择的范围。",
        },
        contentType: {
          type: "string",
          enum: ["all", "video", "image"],
          description: "用户要全部作品、视频作品还是图文作品。",
        },
        coverage: {
          type: "string",
          enum: ["all_available", "latest"],
          description: "采集主页当前可加载范围，或只采最近指定数量。",
        },
        maxItems: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PROFILE_COLLECTION_PLAN_ITEMS,
          description:
            "本次确认的总量上限，不是单批数量。工具会自动拆成基础列表每批最多 300、详情增强每批最多 100；完整采集必须提供已知总量或明确授权上限。",
        },
        detailMaxItems: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DEEP_COLLECT_LIMIT,
          description:
            "详情代表样本上限。账号分析默认 15，代表作品研究默认 20；只有用户明确要求更大详情范围时才提高。",
        },
        transcriptMaxItems: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TRANSCRIPT_QUOTE_ITEMS,
          description:
            "进入逐字稿报价的代表视频上限。账号分析默认 8；仍需用户对报价另行确认。",
        },
        analysisTranscriptDecision: {
          type: "string",
          enum: ["recommend", "not_needed"],
          description:
            "仅用于账号分析且用户未主动要求逐字稿时。所有分析都必须先评估逐字稿的增量价值；默认优先 not_needed，只有没有真实口播就无法可靠回答当前问题时才 recommend。",
        },
        analysisTranscriptReason: {
          type: "string",
          description:
            "账号分析对逐字稿必要性的具体判断理由。recommend 和 not_needed 都必须说明，防止机械提取或机械跳过。",
        },
        failureRetryPasses: {
          type: "integer",
          minimum: 0,
          maximum: MAX_PROFILE_ARCHIVE_RETRY_PASSES,
          description:
            "页面加载或解析失败后的整项任务重试轮数；完整归档默认 1，最多 2。无效链接、权限、验证码和用户取消不重试。",
        },
        commentsPerItemLimit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description:
            "仅在 requestedFields 包含 comments 时生效；默认每篇 30 条，最高每篇 500 条。",
        },
        requestedFields: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "string",
            enum: [
              "account_profile",
              "title",
              "post_page_url",
              "cover",
              "publish_time",
              "engagement_metrics",
              "content_text",
              "media_urls",
              "comments",
              "blogger_metrics",
              "video_transcript",
            ],
          },
          description:
            "用户主动要求的数据。purpose=account_analysis 时可以省略，工具会自动加入基础作品、代表详情和封面；只有用户主动要求，或 analysisTranscriptDecision=recommend 时才加入最多 8 条代表视频逐字稿报价。直接归档或导出时，评论、博主指标和逐字稿仍按用户明确需求加入。",
        },
      },
      required: [
        "userGoal",
        "profileUrl",
        "purpose",
        "contentType",
        "coverage",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_confirm_profile_collection",
    description:
      "只在用户已经看到 mediaclaw_prepare_profile_collection 返回的完整方案和范围并明确同意后调用。仅接受未过期、当前设备拥有且未使用的一次性 planId；执行时不能修改目标、字段或数量。一次确认覆盖已展示的分批和页面加载／解析类故障重试。完整归档返回 archiveJobId、最多 20 条预览和本地数据池分页读取方案；单条失败不阻断其余记录。登录、验证码或平台冷却不自动重试，也不包装成‘插件做不了’，而是返回 input_required、已完成覆盖和恢复动作。所有模式都返回逐阶段进度、实际覆盖、执行日志、失败项和后续确认事项，避免黑盒采集。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        planId: {type: "string"},
        async: {
          type: "boolean",
          default: false,
          description: "长任务可设为 true，立即返回任务句柄并用 task_status 查看进度。",
        },
      },
      required: ["planId"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_enhance_records",
    description:
      "会员能力：调用插件现有批量详情补采 owner，对数据池 recordIds 补采正文、媒体及可选评论/博主指标。执行前必须由用户明确确认范围。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        recordIds: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {type: "string"},
        },
        includeComments: {type: "boolean", default: false},
        includeBloggerMetrics: {type: "boolean", default: false},
        confirmed: {
          type: "boolean",
          description: "仅在用户已经确认本次批量范围后传 true",
        },
        idempotencyKey: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["recordIds", "confirmed"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_scan_keyword",
    description:
      "按关键词快速扫描内容。默认 80 条，只采封面、链接、作者、点赞等基础字段，不逐篇打开详情。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        keyword: {type: "string", description: "搜索关键词"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        limit: {type: "integer", minimum: 1, maximum: 300, default: 80},
        ...SEARCH_FILTER_SCHEMA_PROPERTIES,
        async: {
          type: "boolean",
          default: false,
          description: "旧版 MCP 客户端可设为 true，立即返回任务句柄",
        },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_expand_keywords",
    description:
      "从小红书或抖音搜索页获取一个种子词的联想扩展词。只采集和去重，不调用后端 AI。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        seedKeyword: {type: "string", description: "种子关键词"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        async: {type: "boolean", default: false},
      },
      required: ["seedKeyword"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_research_keyword_topics",
    description:
      "为选题趋势分析准备基础列表数据：默认采集最近半年按点赞排序的 80 条结果，不隐式打开详情页。返回客观指标和按需增强建议，最终分析由 Agent 完成。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        keyword: {type: "string"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        limit: {type: "integer", minimum: 10, maximum: 300, default: 80},
        ...SEARCH_FILTER_SCHEMA_PROPERTIES,
        timeRange: {
          ...SEARCH_FILTER_SCHEMA_PROPERTIES.timeRange,
          default: "6m",
        },
        sortBy: {
          ...SEARCH_FILTER_SCHEMA_PROPERTIES.sortBy,
          default: "likes",
        },
        async: {type: "boolean", default: false},
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_research_longtail_keywords",
    description:
      "为长尾需求分析准备扩展词数据，返回去重结果、覆盖信息和默认方法 ID；不调用后端 AI。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        seedKeyword: {type: "string"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        async: {type: "boolean", default: false},
      },
      required: ["seedKeyword"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_scan_account",
    description:
      "快速扫描一个账号的作品列表，默认 80 条基础字段。它只采集作品，不读取已保存的账号风格分析。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        profileUrl: {type: "string"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        limit: {type: "integer", minimum: 1, maximum: 300, default: 80},
        async: {type: "boolean", default: false},
      },
      required: ["profileUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_capture_account_profile",
    description:
      "采集一个账号的主页画像原子数据，包括账号名、简介、粉丝、获赞收藏和主页链接；不分析账号风格。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        profileUrl: {type: "string", description: "博主主页链接"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        async: {type: "boolean", default: false},
      },
      required: ["profileUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_research_account_hits",
    description:
      "查找某个博主近期作品中的高表现内容。先按发布时间或主页展示顺序确定近期样本，再按互动表现排序；不执行账号风格分析。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        profileUrl: {type: "string", description: "博主主页链接"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        scanLimit: {
          type: "integer",
          minimum: 5,
          maximum: 300,
          default: 80,
        },
        recentPostLimit: {
          type: "integer",
          minimum: 5,
          maximum: 100,
          default: 30,
          description: "从最近多少篇作品中比较",
        },
        resultLimit: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          default: 10,
        },
        minLikes: {type: "integer", minimum: 0, default: 0},
        async: {type: "boolean", default: false},
      },
      required: ["profileUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_research_benchmark_accounts",
    description:
      "从关键词高表现内容中聚合作者，补采候选主页画像，返回对标账号候选、客观指标和分析方法 ID；不调用后端 AI。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        keyword: {type: "string", description: "赛道或内容关键词"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        scanLimit: {
          type: "integer",
          minimum: 10,
          maximum: 300,
          default: 80,
        },
        candidateLimit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 8,
        },
        ...SEARCH_FILTER_SCHEMA_PROPERTIES,
        sortBy: {
          ...SEARCH_FILTER_SCHEMA_PROPERTIES.sortBy,
          default: "likes",
        },
        async: {type: "boolean", default: false},
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_list_style_profiles",
    description:
      "列出 MediaClaw 工作台中已经分析并保存的账号风格档案，返回账号名、profileId、样本量和更新时间等摘要。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          description: "可选；只列出指定平台",
        },
        async: {type: "boolean", default: false},
      },
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_get_style_profile",
    description:
      "兼容旧流程：按账号标识读取已保存的完整风格分析。新流程遇到“模仿/仿写/按某人风格”时，应先用 mediaclaw_list_assets 查询 local.studio，未命中再查 remote.workbench，并用 mediaclaw_get_asset 读取完整档案。找不到或重名时禁止猜测风格。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "账号名、profileId、平台博主 ID 或主页链接",
        },
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          description: "可选；用于消除跨平台重名",
        },
        async: {type: "boolean", default: false},
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_capture_content",
    description:
      "采集一篇具体内容的详情。仅在用户给出链接或快速扫描后决定深挖时使用。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        url: {type: "string"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        includeComments: {type: "boolean", default: false},
        includeBloggerMetrics: {type: "boolean", default: false},
        async: {type: "boolean", default: false},
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_research_single_note",
    description:
      "为单篇分析准备完整详情和可选评论；图片 OCR 复用插件能力。调用前必须判断逐字稿是否会显著提升任务，并传入 analysisTranscriptDecision：默认优先 not_needed；用户主动索要原视频的逐字稿／视频文案／口播文字／视频说了什么／字幕文字版时用 user_requested；只有口播、叙事、语言、论证、节奏或脚本机制分析确需原文时才 recommend。user_requested 或 recommend 会先检查已有逐字稿：已有时直接读取且不收费，缺失时返回真实报价与 quoteId，仍需用户明确确认；not_needed 不报价、不提取。‘帮我写视频文案’属于生成请求，不得误判为提取。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        url: {type: "string"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        includeComments: {type: "boolean", default: true},
        commentLimit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 30,
          description: "单轮安全上限 500；超过后需要分批并遵循插件连续采集保护。",
        },
        includeMediaText: {
          type: "boolean",
          default: true,
          description: "是否提取图片 OCR；视频逐字稿由 analysisTranscriptDecision 单独控制。",
        },
        analysisTranscriptDecision: {
          type: "string",
          enum: ["user_requested", "recommend", "not_needed"],
          description:
            "所有单篇分析都必须给出。默认优先 not_needed；用户主动索要原视频文字时为 user_requested；只有逐字稿会显著提升当前分析时才 recommend。",
        },
        analysisTranscriptReason: {
          type: "string",
          description:
            "recommend 或 not_needed 时必须说明任务相关理由；不得用‘更完整’作为机械提取理由。",
        },
        forceMediaExtraction: {type: "boolean", default: false},
        async: {type: "boolean", default: false},
      },
      required: ["url", "analysisTranscriptDecision"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_deep_collect",
    description:
      "套餐能力：按顺序深采 15～20 条代表内容的完整详情，可附加评论和博主指标。未激活、过期或冻结时会返回结构化付费墙。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {type: "string"},
        },
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        includeComments: {type: "boolean", default: false},
        includeBloggerMetrics: {type: "boolean", default: false},
        async: {type: "boolean", default: false},
      },
      required: ["urls"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_capture_comments",
    description: "调用插件现有的单篇评论采集能力。单篇不设会员数量权益墙；为降低账号风控风险，单轮安全上限为 500 条，连续任务还会受插件累计预算和冷却保护。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        url: {type: "string"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        limit: {type: "integer", minimum: 1, maximum: 500, default: 30},
        idempotencyKey: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_capture_comments_full",
    description:
      "兼容旧调用的单篇评论采集别名；不再单独要求会员，建议新调用使用 mediaclaw_capture_comments。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        url: {type: "string"},
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
          default: "xiaohongshu",
        },
        limit: {type: "integer", minimum: 1, maximum: 500, default: 60},
        async: {type: "boolean", default: false},
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_query_data_pool",
    description:
      "分页查询浏览器插件中长期保存的 MediaClaw 数据池，只返回记录摘要。它不同于 mediaclaw_query_dataset，后者只查当前 MCP 进程任务。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["xiaohongshu", "douyin"],
        },
        recordType: {
          type: "string",
          description: "如 single_note、keyword_notes、blogger_notes、comments",
        },
        status: {type: "string"},
        profileUrl: {
          type: "string",
          description: "只返回归属于该账号主页的作品记录，用于全量归档分页读取。",
        },
        contentType: {
          type: "string",
          enum: ["all", "video", "image"],
          default: "all",
          description: "按全部作品、视频作品或图文作品筛选归档记录。",
        },
        keyword: {type: "string", description: "匹配标题、正文、作者或链接"},
        offset: {type: "integer", minimum: 0, default: 0},
        limit: {type: "integer", minimum: 1, maximum: 100, default: 50},
        async: {type: "boolean", default: false},
      },
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_preview_clear_data",
    description:
      "预览清空插件采集数据的影响，返回记录、评论、逐字稿数量、预计释放空间和一次性 confirmationToken；只预览，不删除。必须先向用户展示结果并取得明确确认。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        async: {type: "boolean", default: false},
      },
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_confirm_clear_data",
    description:
      "使用 mediaclaw_preview_clear_data 返回的未过期 confirmationToken 清空插件采集数据和采集进度。仅在用户看到预览并明确确认后调用；保留登录、设置、同步目标和 Studio 数据。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        confirmationToken: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["confirmationToken"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_get_data_pool_record",
    description:
      "按 recordId 读取 MediaClaw 数据池中的一条完整记录，供后续 OCR、逐字稿或自定义分析使用。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        recordId: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["recordId"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_get_video_transcript",
    description:
      "按 recordId 轻量读取插件已经保存的视频逐字稿，不重新提取、不重复扣积分。默认返回 12000 字符；hasMore=true 时必须继续使用 nextOffset 读取，直到完整取回。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        recordId: {type: "string"},
        format: {
          type: "string",
          enum: ["plain", "sentence"],
          default: "plain",
          description: "plain 为完整逐字稿，sentence 为带时间码的分句节奏稿",
        },
        offset: {type: "integer", minimum: 0, default: 0},
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50000,
          default: 12000,
        },
        async: {type: "boolean", default: false},
      },
      required: ["recordId"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_extract_image_text",
    description:
      "对数据池记录中的配图执行 OCR，并把结果写回原记录。重复调用默认复用已有结果。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        recordId: {type: "string"},
        force: {type: "boolean", default: false},
        async: {type: "boolean", default: false},
      },
      required: ["recordId"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_quote_video_transcript",
    description:
      "为 1～20 条数据池视频记录生成逐字稿积分报价。返回逐条预计积分、总额、余额、quoteId 和有效期，不扣积分。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        recordIds: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {type: "string"},
        },
        idempotencyKey: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["recordIds"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_confirm_video_transcript",
    description:
      "使用未过期且未使用的 quoteId 确认逐字稿。只有用户明确同意报价后才能调用；quoteId 不可复用。",
    execution: captureExecution,
    inputSchema: {
      type: "object",
      properties: {
        quoteId: {type: "string"},
        idempotencyKey: {type: "string"},
        async: {type: "boolean", default: false},
      },
      required: ["quoteId"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_query_dataset",
    description:
      "分页读取当前桥接进程内已完成采集或研究任务的数据，可按互动量或时间排序。",
    inputSchema: {
      type: "object",
      properties: {
        datasetId: {type: "string"},
        offset: {type: "integer", minimum: 0, default: 0},
        limit: {type: "integer", minimum: 1, maximum: 100, default: 50},
        sortBy: {
          type: "string",
          enum: [
            "original",
            "likes",
            "collects",
            "comments",
            "publish_time",
          ],
          default: "original",
        },
        contentType: {
          type: "string",
          enum: ["all", "image", "video"],
          default: "all",
        },
      },
      required: ["datasetId"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_task_status",
    description: "读取异步 MediaClaw 任务（包括本地资产读取、提取和采集）的进度与结果。",
    inputSchema: {
      type: "object",
      properties: {taskId: {type: "string"}},
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "mediaclaw_cancel_task",
    description: "取消仍在运行或等待中的采集任务。",
    inputSchema: {
      type: "object",
      properties: {taskId: {type: "string"}},
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

async function executeCaptureTool(name, args) {
  if (name === "mediaclaw_list_paired_devices") {
    return startSingleCapture("paired_devices", {...args, limit: 8});
  }
  if (name === "mediaclaw_list_assets") {
    const mode =
      args.source === "local.data_pool"
        ? "data_pool_assets"
        : args.source === "local.studio"
          ? "studio_assets"
          : "workbench_assets";
    return startSingleCapture(mode, {
      ...args,
      limit: args.limit || 50,
      options: {
        operation: "list",
        source: args.source,
        type: args.type,
        filters: args.filters || {},
        cursor: args.cursor || "",
      },
    });
  }
  if (name === "mediaclaw_get_asset") {
    const source = String(args.assetId || "").split("|")[0];
    const mode =
      source === "local.data_pool"
        ? "data_pool_assets"
        : source === "local.studio"
          ? "studio_assets"
          : "workbench_assets";
    return startSingleCapture(mode, {
      ...args,
      limit: 1,
      options: {
        operation: "get",
        assetId: args.assetId,
        view: args.view || "sections",
        sections: Array.isArray(args.sections) ? args.sections : [],
        page:
          args.page && typeof args.page === "object"
            ? args.page
            : {},
      },
    });
  }
  if (name === "mediaclaw_capture_note") {
    return startSingleCapture("current_note", {
      ...args,
      featureKey: "capture.single_note",
      options: {
        includeComments: args.includeComments === true,
        commentsMaxDetectedItems: Math.min(
          500,
          Math.max(1, Math.floor(Number(args.commentsPerItemLimit) || 30)),
        ),
        includeBloggerMetrics: args.includeBloggerMetrics === true,
      },
    });
  }
  if (name === "mediaclaw_capture_search_basic") {
    return startSingleCapture("search_results", {
      ...args,
      featureKey: "capture.search",
      options: {
        ...buildKeywordCaptureOptions(args),
        detailCapture: false,
      },
    });
  }
  if (name === "mediaclaw_capture_profile_basic") {
    return startSingleCapture("profile_posts", {
      ...args,
      featureKey: "capture.blogger",
      options: {detailCapture: false},
    });
  }
  if (name === "mediaclaw_enhance_records") {
    return startSingleCapture("enhance_records", {
      ...args,
      featureKey: "capture.enhancement",
      limit: Array.isArray(args.recordIds) ? args.recordIds.length : 1,
      options: {
        recordIds: args.recordIds,
        includeComments: args.includeComments === true,
        commentsMaxDetectedItems: Math.min(
          500,
          Math.max(1, Math.floor(Number(args.commentsPerItemLimit) || 30)),
        ),
        includeBloggerMetrics: args.includeBloggerMetrics === true,
        confirmation: {confirmed: args.confirmed === true},
      },
    });
  }
  if (name === "mediaclaw_scan_keyword") {
    return startSingleCapture("search_results", {
      ...args,
      options: buildKeywordCaptureOptions(args),
    });
  }
  if (name === "mediaclaw_expand_keywords") {
    return startSingleCapture("search_results", {
      keyword: args.seedKeyword,
      platform: args.platform,
      limit: DEFAULT_KEYWORD_EXPANSION_QUERY_LIMIT,
      options: {operation: "expand_keywords"},
    });
  }
  if (name === "mediaclaw_research_keyword_topics") {
    return startKeywordTopicResearch(args);
  }
  if (name === "mediaclaw_research_longtail_keywords") {
    return startLongtailResearch(args);
  }
  if (name === "mediaclaw_scan_account") {
    return startSingleCapture("profile_posts", args);
  }
  if (name === "mediaclaw_capture_account_profile") {
    return startSingleCapture("profile_info", args);
  }
  if (name === "mediaclaw_research_account_hits") {
    return startAccountHitsResearch(args);
  }
  if (name === "mediaclaw_research_benchmark_accounts") {
    return startBenchmarkAccountResearch(args);
  }
  if (name === "mediaclaw_list_style_profiles") {
    return startSingleCapture("stored_style_profiles", {
      ...args,
      options: {
        operation: "list",
        platformFilter: args.platform || "",
      },
    });
  }
  if (name === "mediaclaw_get_style_profile") {
    return startSingleCapture("stored_style_profiles", {
      ...args,
      options: {
        operation: "get",
        profileId: args.query,
        platformBloggerId: args.query,
        bloggerName: args.query,
        bloggerUrl: args.query,
        platformFilter: args.platform || "",
      },
    });
  }
  if (name === "mediaclaw_capture_content") {
    return startSingleCapture("current_note", {
      ...args,
      featureKey: "capture.single_note",
      options: {
        includeComments: args.includeComments === true,
        includeBloggerMetrics: args.includeBloggerMetrics === true,
      },
    });
  }
  if (name === "mediaclaw_research_single_note") {
    return startSingleNoteResearch(args);
  }
  if (name === "mediaclaw_capture_comments") {
    return startSingleCapture("comments", {
      ...args,
      featureKey: "capture.comments",
      limit: Math.min(500, Math.max(1, Math.floor(Number(args.limit) || 30))),
    });
  }
  if (name === "mediaclaw_capture_comments_full") {
    return startSingleCapture("comments", {
      ...args,
      featureKey: "capture.comments",
      limit: Math.min(
        500,
        Math.max(1, Math.floor(Number(args.limit) || 60)),
      ),
    });
  }
  if (name === "mediaclaw_query_data_pool") {
    return startSingleCapture("data_pool_query", {
      ...args,
      options: {
        operation: "query",
        platform: args.platform || "",
        recordType: args.recordType || "",
        status: args.status || "",
        profileUrl: args.profileUrl || "",
        contentType: args.contentType || "all",
        keyword: args.keyword || "",
        offset: args.offset,
        limit: args.limit,
      },
    });
  }
  if (name === "mediaclaw_preview_clear_data") {
    return startSingleCapture("data_pool_maintenance", {
      ...args,
      options: {action: "preview_clear"},
    });
  }
  if (name === "mediaclaw_confirm_clear_data") {
    return startSingleCapture("data_pool_maintenance", {
      ...args,
      options: {
        action: "confirm_clear",
        confirmationToken: args.confirmationToken,
      },
    });
  }
  if (name === "mediaclaw_get_data_pool_record") {
    return startSingleCapture("data_pool_query", {
      ...args,
      options: {
        operation: "get",
        recordId: args.recordId,
      },
    });
  }
  if (name === "mediaclaw_get_video_transcript") {
    return startSingleCapture("data_pool_query", {
      ...args,
      options: {
        operation: "transcript",
        recordId: args.recordId,
        format: args.format || "plain",
        offset: args.offset || 0,
        limit: args.limit || 12_000,
      },
    });
  }
  if (name === "mediaclaw_extract_image_text") {
    return startSingleCapture("extract_image_text", {
      ...args,
      options: {
        recordId: args.recordId,
        force: args.force === true,
      },
    });
  }
  if (name === "mediaclaw_quote_video_transcript") {
    return startSingleCapture("extract_video_transcript", {
      ...args,
      featureKey: "extract.video_transcript",
      options: {
        meteredAction: "quote",
        recordIds: args.recordIds,
      },
    });
  }
  if (name === "mediaclaw_confirm_video_transcript") {
    return startSingleCapture("extract_video_transcript", {
      ...args,
      featureKey: "extract.video_transcript",
      options: {
        meteredAction: "confirm",
        quoteId: args.quoteId,
      },
    });
  }
  if (name === "mediaclaw_deep_collect") {
    return startDeepBatch(args);
  }
  return null;
}

function currentAdapter() {
  return requestContext.getStore()?.adapter || null;
}

function adapterOwnsTask(adapter, task) {
  return Boolean(
    adapter && task?.owner?.deviceId === adapter.identity.deviceId,
  );
}

async function handleToolCall(params = {}) {
  const adapter = currentAdapter();
  const name = String(params.name || "");
  const args = params.arguments || {};

  if (name === "mediaclaw_connection_status") {
    const session = adapterSession(adapter);
    const connected = Boolean(extensionPeer && session);
    const awaitingPairing = Boolean(
      extensionPeers.size > 0 && adapter && !session,
    );
    const message = !bridgeStatus.listening
      ? `MediaClaw 本地桥接启动失败：${bridgeStatus.error || "未知错误"}`
      : connected
        ? "MediaClaw 插件已连接，可以开始采集"
        : awaitingPairing
          ? "设备已发现，等待用户在 MediaClaw 插件中批准配对"
        : "尚未连接。请在 MediaClaw 插件设置中开启“允许本机 Agent 调用”";
    return toolResult({
      ok: connected,
      connected,
      awaitingPairing,
      device: adapter ? publicDevice(adapter) : null,
      extension: session,
      onboarding: buildConnectionOnboarding({connected, awaitingPairing}),
      bridge: {...bridgeStatus},
      recoveredTaskIds: [...recoveredTaskIds],
      waitingTaskCount: [...tasks.values()].filter((task) =>
        adapterOwnsTask(adapter, task) &&
        ["queued", "waiting_for_extension", "running", "cancel_pending"].includes(
          task.status,
        ),
      ).length,
      message,
    });
  }
  if (name === "mediaclaw_prepare_profile_collection") {
    try {
      const plan = createProfileCollectionPlan(args, adapter);
      return toolResult({
        ok: true,
        status: "confirmation_required",
        collectionStarted: false,
        plan,
      });
    } catch (error) {
      return toolResult(
        {
          ok: false,
          error: {
            code: "INVALID_PROFILE_COLLECTION_INTENT",
            message: error instanceof Error ? error.message : "账号采集目标无效",
          },
        },
        {isError: true},
      );
    }
  }
  if (name === "mediaclaw_confirm_profile_collection") {
    const resolved = resolveProfileCollectionPlan(args.planId, adapter);
    if (!resolved.ok) {
      return toolResult(resolved, {isError: true});
    }
    if (!extensionPeer || !adapterSession(adapter)) {
      return toolResult(
        {
          ok: false,
          error: {
            code: extensionPeer ? "PAIRING_REQUIRED" : "EXTENSION_NOT_CONNECTED",
            message: extensionPeer
              ? "设备尚未获用户批准。采集方案尚未使用，完成配对后可继续确认。"
              : "MediaClaw 插件尚未连接。采集方案尚未使用，连接后可继续确认。",
          },
        },
        {isError: true},
      );
    }
    const task = startProfileCollectionWorkflow(resolved.plan);
    if (args?.async === true) {
      return toolResult({
        ok: true,
        planId: resolved.plan.planId,
        taskId: task.taskId,
        archiveJobId:
          resolved.plan.archive?.enabled === true ? task.taskId : null,
        task: taskSnapshot(task),
      });
    }
    if (params?.task) {
      return {task: taskSnapshot(task)};
    }
    await waitForTask(task);
    return toolResult(getTaskPublicResult(task), {
      isError: task.status === "failed",
    });
  }
  if (name === "mediaclaw_task_status") {
    const task = tasks.get(String(args.taskId || ""));
    return task && adapterOwnsTask(adapter, task)
      ? toolResult(getTaskPublicResult(task))
      : toolResult(
          {ok: false, error: {code: "TASK_NOT_FOUND", message: "任务不存在"}},
          {isError: true},
        );
  }
  if (name === "mediaclaw_cancel_task") {
    const task = tasks.get(String(args.taskId || ""));
    if (!task || !adapterOwnsTask(adapter, task)) {
      return toolResult(
        {ok: false, error: {code: "TASK_NOT_FOUND", message: "任务不存在"}},
        {isError: true},
      );
    }
    const result = await cancelTask(String(args.taskId || ""));
    return toolResult(result, {isError: result.ok === false});
  }
  if (name === "mediaclaw_query_dataset") {
    const task = tasks.get(String(args.datasetId || ""));
    if (!task || !adapterOwnsTask(adapter, task)) {
      return toolResult(
        {ok: false, error: {code: "DATASET_NOT_FOUND", message: "数据集不存在"}},
        {isError: true},
      );
    }
    if (!["succeeded", "failed"].includes(task.status)) {
      return toolResult(
        {
          ok: false,
          error: {code: "DATASET_NOT_READY", message: "数据集尚未完成"},
          task: taskSnapshot(task),
        },
        {isError: true},
      );
    }
    return toolResult(queryDataset(task, args));
  }

  const task = await executeCaptureTool(name, args);
  if (!task) {
    return toolResult(
      {ok: false, error: {code: "UNKNOWN_TOOL", message: `未知工具：${name}`}},
      {isError: true},
    );
  }
  if (args?.async === true) {
    return toolResult({
      ok: true,
      taskId: task.taskId,
      task: taskSnapshot(task),
    });
  }
  if (params?.task) {
    return {task: taskSnapshot(task)};
  }
  if (!extensionPeer || !adapterSession(adapter)) {
    await cancelTask(task.taskId);
    return toolResult(
      {
        ok: false,
        error: {
          code: extensionPeer ? "PAIRING_REQUIRED" : "EXTENSION_NOT_CONNECTED",
          message: extensionPeer
            ? "设备尚未获用户批准。请先在 MediaClaw 插件中完成配对。"
            : "MediaClaw 插件尚未连接。请先在插件设置中开启“允许本机 Agent 调用”。",
        },
      },
      {isError: true},
    );
  }
  await waitForTask(task);
  return toolResult(getTaskPublicResult(task), {
    isError: task.status === "failed",
  });
}

async function readJsonRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > BRIDGE_RPC_BODY_LIMIT_BYTES) {
      throw new Error("bridge RPC request body is too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {"content-type": "application/json"});
  response.end(JSON.stringify(payload));
}

function resolveAdapterToken(payload = {}) {
  const token = normalizeText(payload.token, 240);
  const tokenState = adapterTokens.get(token);
  if (!tokenState) return null;
  const adapter = adapters.get(tokenState.hostKey);
  const instance = adapter?.instances.get(tokenState.instanceId);
  if (!adapter || !instance || instance.token !== token) return null;
  instance.lastSeenAt = Date.now();
  adapter.lastSeenAt = Date.now();
  return adapter;
}

async function registerAdapter(payload = {}) {
  const hostKey = normalizeHostKey(payload.hostKey || payload.host);
  const instanceId = normalizeText(payload.instanceId, 160) || createId("adapter");
  const adapterVersion = normalizeText(payload.adapterVersion, 80);
  if (compareVersions(adapterVersion, SERVER_VERSION) === 1) {
    scheduleBrokerUpgrade(adapterVersion);
    return {
      ok: false,
      restartRequired: true,
      error: {
        code: "BROKER_RESTART_REQUIRED",
        message: `MediaClaw Broker ${SERVER_VERSION} 正在切换到 ${adapterVersion}`,
      },
      brokerVersion: SERVER_VERSION,
      adapterVersion,
    };
  }
  const adapter = await ensureAdapterIdentity({
    hostKey,
    displayName: normalizeText(payload.displayName, 160),
    adapterVersion,
    agentChannel: normalizeText(payload.agentChannel, 40),
  });
  const previous = adapter.instances.get(instanceId);
  if (previous?.token) adapterTokens.delete(previous.token);
  const token = crypto.randomBytes(32).toString("base64url");
  adapter.instances.set(instanceId, {
    instanceId,
    token,
    registeredAt: Date.now(),
    lastSeenAt: Date.now(),
  });
  adapterTokens.set(token, {hostKey, instanceId});
  announceAdapter(adapter);
  return {
    ok: true,
    token,
    instanceId,
    brokerVersion: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    device: publicDevice(adapter),
  };
}

function scheduleBrokerUpgrade(adapterVersion) {
  if (brokerUpgradeScheduled) return;
  brokerUpgradeScheduled = true;
  process.stderr.write(
    `[mediaclaw] newer Adapter ${adapterVersion} requested Broker ${SERVER_VERSION} restart\n`,
  );
  const timer = setTimeout(() => {
    for (const peer of extensionPeers) {
      peer.close(1012, "MediaClaw Agent is loading a newer Broker");
    }
    void websocketServer.close().finally(() => process.exit(0));
  }, 100);
  timer.unref?.();
}

function unregisterAdapter(payload = {}) {
  const token = normalizeText(payload.token, 240);
  const tokenState = adapterTokens.get(token);
  if (!tokenState) return {ok: true, unregistered: false};
  const adapter = adapters.get(tokenState.hostKey);
  adapter?.instances.delete(tokenState.instanceId);
  adapterTokens.delete(token);
  return {ok: true, unregistered: true};
}

async function handleBrokerMcp(adapter, payload = {}) {
  const method = String(payload.method || "");
  const params = payload.params || {};
  if (method === "tools/list") return {tools};
  if (method === "tools/call") return await handleToolCall(params);
  if (method === "tasks/list") {
    return {
      tasks: [...tasks.values()]
        .filter((task) => adapterOwnsTask(adapter, task))
        .map(taskSnapshot),
      nextCursor: null,
    };
  }
  const taskId = String(params.taskId || "");
  const task = tasks.get(taskId);
  if (!task || !adapterOwnsTask(adapter, task)) {
    return {error: {code: -32001, message: "Task not found"}};
  }
  if (method === "tasks/get") return {task: taskSnapshot(task)};
  if (method === "tasks/cancel") {
    const result = await cancelTask(taskId);
    return result.ok
      ? {task: result.task}
      : {error: {code: -32001, message: result.error.message}};
  }
  if (method === "tasks/result") {
    if (
      !["succeeded", "failed", "cancelled", "input_required"].includes(
        task.status,
      )
    ) {
      return {error: {code: -32002, message: "Task is not complete"}};
    }
    return toolResult(getTaskPublicResult(task), {
      isError: task.status === "failed",
    });
  }
  return {error: {code: -32601, message: `Method not found: ${method}`}};
}

async function handleBridgeHttpRequest(request, response) {
  if (request.method !== "POST") {
    return false;
  }
  const payload = await readJsonRequest(request);
  if (request.url === "/v1/adapters/register") {
    const registration = await registerAdapter(payload);
    sendJson(response, registration.restartRequired ? 409 : 200, registration);
    return true;
  }
  if (request.url === "/v1/adapters/unregister") {
    sendJson(response, 200, unregisterAdapter(payload));
    return true;
  }
  const adapter = resolveAdapterToken(payload);
  if (!adapter) {
    sendJson(response, 401, {
      ok: false,
      error: {code: "ADAPTER_AUTH_REQUIRED", message: "Adapter registration required"},
    });
    return true;
  }
  if (request.url === "/v1/adapters/heartbeat") {
    sendJson(response, 200, {ok: true, brokerVersion: SERVER_VERSION});
    return true;
  }
  if (request.url === "/v1/mcp") {
    let result;
    try {
      result = await requestContext.run(
        {adapter},
        () => handleBrokerMcp(adapter, payload),
      );
    } catch (error) {
      result = {
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    await scheduleTaskStatePersist();
    sendJson(response, 200, result);
    return true;
  }
  return false;
}

await restoreTaskState();

const websocketServer = createLoopbackWebSocketServer({
  port: DEFAULT_PORT,
  serviceName: SERVER_NAME,
  onHttpRequest: handleBridgeHttpRequest,
  onConnection(peer) {
    extensionPeers.add(peer);
    peer.send({
      type: "broker.hello",
      serverName: "MediaClaw Agent Broker",
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      devices: [...adapters.values()]
        .filter((adapter) => adapter.instances.size > 0)
        .map(publicDevice),
    });
  },
  onMessage: handleExtensionMessage,
  onClose: handleExtensionClose,
});

try {
  await websocketServer.listen();
  bridgeStatus = {
    listening: true,
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    error: null,
  };
  process.stderr.write(
    `[mediaclaw] shared Agent Broker listening on 127.0.0.1:${DEFAULT_PORT}\n`,
  );
} catch (error) {
  bridgeStatus = {
    listening: false,
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    error: error instanceof Error ? error.message : String(error),
  };
  process.stderr.write(
    `[mediaclaw] cannot start shared Agent Broker: ${bridgeStatus.error}\n`,
  );
  process.exitCode = 1;
}

const adapterSweepTimer = setInterval(() => {
  const staleBefore = Date.now() - ADAPTER_TTL_MS;
  for (const adapter of adapters.values()) {
    for (const [instanceId, instance] of adapter.instances) {
      if (instance.lastSeenAt >= staleBefore) continue;
      adapter.instances.delete(instanceId);
      adapterTokens.delete(instance.token);
    }
    if (adapter.instances.size > 0) continue;
    const deviceId = adapter.identity.deviceId;
    deviceSessions.delete(deviceId);
    for (const peer of extensionPeers) {
      peer.send({type: "device.offline", deviceId});
    }
  }
  const hasActiveAdapter = [...adapters.values()].some(
    (adapter) => adapter.instances.size > 0,
  );
  const mostRecentAdapterAt = Math.max(
    0,
    ...[...adapters.values()].map((adapter) => adapter.lastSeenAt || 0),
  );
  if (
    !hasActiveAdapter &&
    extensionPeers.size === 0 &&
    mostRecentAdapterAt > 0 &&
    Date.now() - mostRecentAdapterAt >= BROKER_IDLE_TIMEOUT_MS
  ) {
    void websocketServer.close().finally(() => process.exit(0));
  }
}, ADAPTER_SWEEP_INTERVAL_MS);
adapterSweepTimer.unref?.();

const taskWatchdogTimer = setInterval(() => {
  expireStaleLocalAssetQueries();
  expireUnacknowledgedCaptureTask();
}, TASK_WATCHDOG_INTERVAL_MS);
taskWatchdogTimer.unref?.();
