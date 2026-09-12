#!/usr/bin/env node

import crypto from "node:crypto";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import MCP_CONTRACT from "../contracts/mcp-v1.json" with {type: "json"};
import {
  AGENT_UPDATE_TOOL,
  createAgentUpdateChecker,
  createAgentUpdateOrchestrator,
} from "./agent-update.mjs";
import {
  agentHostDeviceDisplayName,
  detectAgentHostKey,
  isSupportedAgentHost,
  normalizeAgentHostKey,
  SUPPORTED_AGENT_HOST_KEYS,
} from "./agent-hosts.mjs";

const SERVER_NAME = "mediaclaw-agent-adapter";
const configuredRuntimeVersion = String(
  process.env.MEDIACLAW_AGENT_RUNTIME_VERSION || "",
).trim();
const SERVER_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(
  configuredRuntimeVersion,
)
  ? configuredRuntimeVersion
  : MCP_CONTRACT.serverVersion;
const logoPath = globalThis.Bun
  ? (await import("../assets/logo.png", {with: {type: "file"}})).default
  : fileURLToPath(new URL("../assets/logo.png", import.meta.url));
const SERVER_ICONS = [
  {
    src: `data:image/png;base64,${readFileSync(logoPath).toString("base64")}`,
    mimeType: "image/png",
    sizes: ["128x128"],
  },
];
const PROTOCOL_VERSION = MCP_CONTRACT.protocolVersion;
const COLLECTION_PLAN_TOOL_NAMES = new Set(
  MCP_CONTRACT.tools.filter((tool) => tool.requiresCollectionPlan === true).map((tool) => tool.name),
);
const BROKER_PORT = Number(process.env.MEDIACLAW_AGENT_PORT || 17373);
const BROKER_ORIGIN = `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_START_TIMEOUT_MS = 10_000;
const BROKER_CALL_TIMEOUT_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const COLLECTION_ELICITATION_TIMEOUT_MS = Math.min(
  5 * 60 * 1000,
  Math.max(1, Number(process.env.MEDIACLAW_COLLECTION_ELICITATION_TIMEOUT_MS) || 5 * 60 * 1000),
);
const instanceId = `adapter_${crypto.randomUUID()}`;
const brokerPath = fileURLToPath(new URL("./broker-server.mjs", import.meta.url));
const standaloneRuntime = process.env.MEDIACLAW_AGENT_STANDALONE === "1";

function detectHostKey() {
  return detectAgentHostKey(process.env);
}

function detectAgentChannel() {
  const explicit = String(
    process.env.MEDIACLAW_AGENT_CHANNEL || "",
  ).trim().toLowerCase();
  if (["local", "release"].includes(explicit)) return explicit;
  return /(?:^|[/\\])mediaclaw-local(?:[/\\]|$)/i.test(process.cwd())
    ? "local"
    : "release";
}

function hostDisplayName(hostKey) {
  const explicit = String(process.env.MEDIACLAW_AGENT_DEVICE_NAME || "").trim();
  if (explicit) return explicit;
  return agentHostDeviceDisplayName(hostKey);
}

const hostKey = normalizeAgentHostKey(detectHostKey());
const agentChannel = detectAgentChannel();
if (!isSupportedAgentHost(hostKey)) {
  throw new Error(
    `MediaClaw Agent only supports: ${SUPPORTED_AGENT_HOST_KEYS.join(", ")}`,
  );
}
const displayName = hostDisplayName(hostKey);
const agentUpdateChecker = createAgentUpdateChecker({
  currentVersion: SERVER_VERSION,
  hostKey,
});
const agentUpdateOrchestrator = createAgentUpdateOrchestrator({
  checker: agentUpdateChecker,
  currentVersion: SERVER_VERSION,
  hostKey,
});
let adapterToken = "";
let registration = null;
let registrationPromise = null;
let heartbeatTimer = null;
let stopping = false;
let lastRegistrationError = "";
let clientProtocolVersion = "";
let clientSupportsFormElicitation = false;
let clientInitializationPromise = null;
const pendingServerRequests = new Map();
const collectionApprovalFlows = new Map();
const activeClientRequests = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(pathname, payload, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BROKER_ORIGIN}${pathname}`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        body?.error?.message || `Broker returned HTTP ${response.status}`,
      );
      error.code = body?.error?.code || "BROKER_HTTP_ERROR";
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function brokerHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${BROKER_ORIGIN}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === "mediaclaw-agent-broker";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureBroker() {
  if (await brokerHealth()) return;
  const child = spawn(
    process.execPath,
    standaloneRuntime ? ["--broker"] : [brokerPath],
    {
    detached: true,
    stdio: "ignore",
    env: {...process.env},
    },
  );
  child.unref();
  const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await brokerHealth()) return;
    await delay(100);
  }
  throw new Error("MediaClaw Broker 启动超时，请检查本机端口 17373");
}

async function registerAdapter() {
  if (adapterToken && registration) return registration;
  if (registrationPromise) return registrationPromise;
  registrationPromise = (async () => {
    await ensureBroker();
    const registrationPayload = {
      hostKey,
      displayName,
      adapterVersion: SERVER_VERSION,
      agentChannel,
      instanceId,
      collectionApprovalTransport: clientSupportsFormElicitation ? "mcp-elicitation-v1" : "conversation-v1",
    };
    try {
      registration = await fetchJson(
        "/v1/adapters/register",
        registrationPayload,
      );
    } catch (error) {
      if (error?.code !== "BROKER_RESTART_REQUIRED") throw error;
      const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
      while (Date.now() < deadline && (await brokerHealth())) {
        await delay(100);
      }
      await ensureBroker();
      registration = await fetchJson(
        "/v1/adapters/register",
        registrationPayload,
      );
    }
    adapterToken = String(registration.token || "");
    if (!adapterToken) throw new Error("MediaClaw Broker 未返回 Adapter 会话");
    lastRegistrationError = "";
    return registration;
  })();
  try {
    return await registrationPromise;
  } finally {
    registrationPromise = null;
  }
}

function reportRegistrationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === lastRegistrationError) return;
  lastRegistrationError = message;
  process.stderr.write(
    `[mediaclaw] ${hostKey} 等待连接本机 Broker：${message}\n`,
  );
}

async function callBroker(method, params = {}) {
  if (!adapterToken) await registerAdapter();
  const requiresApprovalRuntime = method === "tools/call" && (
    COLLECTION_PLAN_TOOL_NAMES.has(params.name) ||
    (["mediaclaw_confirm_collection", "mediaclaw_confirm_profile_collection", "mediaclaw_confirm_comment_outreach", "mediaclaw_set_comment_outreach_enabled"].includes(params.name) && params.arguments?.decision !== "reject")
  );
  const forward = () => {
    if (requiresApprovalRuntime && registration?.collectionApprovalVersion !== 3) {
      return adapterToolResult({ok: false, collectionStarted: false, error: {
        code: "COLLECTION_APPROVAL_RUNTIME_UPGRADE_REQUIRED",
        message: "当前接入运行时尚不支持这版对话授权流程，操作未执行。请更新 MediaClaw Agent 并完全退出、重新打开当前宿主后继续。",
      }}, {isError: true});
    }
    return fetchJson("/v1/mcp", {token: adapterToken, method, params},
      method === "tools/call" ? BROKER_CALL_TIMEOUT_MS : 30_000);
  };
  try {
    return await forward();
  } catch (error) {
    if (error?.code !== "ADAPTER_AUTH_REQUIRED") throw error;
    adapterToken = "";
    registration = null;
    await registerAdapter();
    // Recheck the newly registered Broker before retrying: an unchanged release
    // version alone cannot establish that the trusted approval path exists.
    return await forward();
  }
}

function writeMessage(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeResult(id, result) {
  writeMessage({jsonrpc: "2.0", id, result});
}

function writeError(id, code, message, data = undefined) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {code, message, ...(data === undefined ? {} : {data})},
  });
}

function isConnectionStatusCall(message) {
  return (
    message?.method === "tools/call" &&
    message?.params?.name === "mediaclaw_connection_status"
  );
}

function isAgentUpdateCall(message) {
  return (
    message?.method === "tools/call" &&
    message?.params?.name === AGENT_UPDATE_TOOL.name
  );
}

function adapterToolResult(payload, {isError = false} = {}) {
  return {
    content: [{type: "text", text: JSON.stringify(payload, null, 2)}],
    structuredContent: payload,
    ...(isError ? {isError: true} : {}),
  };
}

function supportsFormElicitation(params = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion || "") ||
      params.protocolVersion < "2025-06-18") return false;
  const capability = params.capabilities?.elicitation;
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) return false;
  return Object.keys(capability).length === 0 ||
    Boolean(capability.form && typeof capability.form === "object" && !Array.isArray(capability.form));
}

function pendingCollectionApproval(result, message, uncertain = false) {
  return adapterToolResult({
    ...result.structuredContent,
    ...(uncertain ? {status: "approval_result_unknown", collectionStarted: null} : {collectionStarted: false}),
    message,
  });
}

function settleServerResponse(message) {
  const pending = pendingServerRequests.get(message.id);
  if (!pending) return;
  const validResult = message.jsonrpc === "2.0" && !Object.hasOwn(message, "error") &&
    message.result && typeof message.result === "object" && !Array.isArray(message.result);
  pending.settle(validResult ? message.result : {action: "cancel"});
}

function requestCollectionApproval(approvalRequest, state) {
  const id = `mediaclaw_elicitation_${crypto.randomUUID()}`;
  const expiresAtMs = Date.parse(String(approvalRequest.expiresAt || ""));
  const timeoutMs = Number.isFinite(expiresAtMs)
    ? Math.min(COLLECTION_ELICITATION_TIMEOUT_MS, expiresAtMs - Date.now())
    : COLLECTION_ELICITATION_TIMEOUT_MS;
  if (timeoutMs <= 0 || stopping) return Promise.resolve({action: "cancel"});
  return new Promise((resolve) => {
    const settle = (response, notifyClient = false) => {
      if (!pendingServerRequests.delete(id)) return;
      clearTimeout(timer);
      state.cancel = null;
      if (notifyClient && !stopping) writeMessage({jsonrpc: "2.0", method: "notifications/cancelled", params: {requestId: id, reason: "采集确认已取消或过期"}});
      resolve(response);
    };
    const timer = setTimeout(() => settle({action: "cancel"}, true), timeoutMs);
    state.cancel = () => settle({action: "cancel"}, true);
    pendingServerRequests.set(id, {settle});
    writeMessage({
      jsonrpc: "2.0", id, method: "elicitation/create",
      params: {
        ...(clientProtocolVersion >= "2025-11-25" ? {mode: "form"} : {}),
        message: approvalRequest.message,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {type: "boolean", title: "按以上范围开始采集"},
            changes: {type: "string", title: "修改方案", description: "需要调整时填写意见；填写后先修改方案，本次不会执行。", maxLength: 2000},
          },
        },
      },
    });
  });
}

async function handleCollectionApproval(result, context, toolParams = {}) {
  const payload = result?.structuredContent;
  const approvalRequest = payload?.approvalRequest;
  if (payload?.status !== "user_approval_required" || payload.collectionStarted !== false ||
      typeof approvalRequest?.requestId !== "string" || !approvalRequest.requestId ||
      typeof approvalRequest.message !== "string" || !approvalRequest.message) return result;
  const existing = collectionApprovalFlows.get(approvalRequest.requestId);
  if (existing) {
    context.approval = existing;
    if (context.cancelled) existing.cancel?.();
    return existing.promise;
  }
  if ((!clientSupportsFormElicitation || (approvalRequest.transport && approvalRequest.transport !== "mcp-elicitation-v1")) &&
      !context.cancelled && !stopping) return result;
  // Completed requests remain cached to avoid another dialog or approval POST
  // when a client repeats the same tool call after losing its response.
  for (const [requestId, flow] of collectionApprovalFlows) {
    if (collectionApprovalFlows.size < 1000) break;
    if (flow.completed) collectionApprovalFlows.delete(requestId);
  }
  if (collectionApprovalFlows.size >= 1000) return result;
  const state = {cancel: null, completed: false, promise: null};
  context.approval = state;
  collectionApprovalFlows.set(approvalRequest.requestId, state);
  // Capture the authenticated session that owns the Broker challenge. Never
  // refresh registration or copy public tools/call arguments into this channel.
  const approvalToken = adapterToken;
  state.promise = (async () => {
    const response = context.cancelled || stopping
      ? {action: "cancel"}
      : await requestCollectionApproval(approvalRequest, state);
    const requestedChanges = response.action === "accept" && typeof response.content?.changes === "string" &&
      !context.cancelled && !stopping ? response.content.changes.trim() : "";
    const invalidChanges = response.content && Object.hasOwn(response.content, "changes") && typeof response.content.changes !== "string";
    const decision = requestedChanges || invalidChanges ? "cancel" : response.action === "decline" ? "reject"
      : response.action === "accept" && response.content?.approve === true &&
        !context.cancelled && !stopping ? "approve" : "cancel";
    const revisionResult = (cancellationConfirmed) => {
      const args = toolParams.arguments || {};
      const planIds = approvalRequest.planIds || payload.planIds || args.planIds;
      const planId = approvalRequest.planId || payload.planId || args.planId;
      return adapterToolResult({
        ok: true, status: "revision_requested", collectionStarted: false, requestedChanges,
        ...(Array.isArray(planIds) ? {planIds} : planId ? {planId, replacesPlanId: planId} : {}),
        taskId: payload.taskId,
        cancellationConfirmed,
        nextTool: cancellationConfirmed
          ? toolParams.name === "mediaclaw_confirm_profile_collection" ? "mediaclaw_prepare_profile_collection" : "mediaclaw_prepare_collection"
          : "mediaclaw_task_status",
        message: cancellationConfirmed
          ? "已取消本次执行确认。请按用户修改意见重新制定方案，使用 replacesPlanId 替换原方案；多组方案逐组替换。"
          : "已收到修改意见，未批准执行。取消确认的结果暂时无法读取，请先查原任务状态，再按修改意见替换方案。",
      });
    };
    try {
      const resolution = await fetchJson("/v1/collection-approvals/respond", {
        token: approvalToken, requestId: approvalRequest.requestId, decision,
      }, decision === "approve" ? BROKER_CALL_TIMEOUT_MS : 1_000);
      return requestedChanges ? revisionResult(resolution?.structuredContent?.ok === true) : resolution;
    } catch {
      if (requestedChanges) return revisionResult(false);
      // A lost execution response is not permission to send approval again.
      return pendingCollectionApproval(result, decision === "approve"
        ? "确认结果暂时无法读取，请先查询原任务状态；不要重复确认或重新采集。"
        : "尚未完成用户确认。请在当前对话中继续确认或调整方案；不会自动开始采集。", decision === "approve");
    } finally {
      state.completed = true;
    }
  })();
  return state.promise;
}

function attachAgentUpdateTool(result) {
  if (!Array.isArray(result?.tools)) return result;
  if (result.tools.some((tool) => tool?.name === AGENT_UPDATE_TOOL.name)) {
    return result;
  }
  return {...result, tools: [AGENT_UPDATE_TOOL, ...result.tools]};
}

async function attachAgentUpdate(result) {
  if (!result?.structuredContent) return result;
  const structuredContent = {
    ...result.structuredContent,
    agentUpdate: await agentUpdateOrchestrator.status(),
  };
  return {
    ...result,
    structuredContent,
    content: Array.isArray(result.content)
      ? result.content.map((item) =>
          item?.type === "text"
            ? {...item, text: JSON.stringify(structuredContent, null, 2)}
            : item,
        )
      : result.content,
  };
}

function oldSessionFencedResult() {
  const payload = {
    ok: false,
    error: {
      code: "OLD_SESSION_FENCED",
      message: "MediaClaw Agent 已升级；当前旧任务已锁定，不能继续调用。请在新版续接任务中继续。",
    },
  };
  return adapterToolResult(payload, {isError: true});
}

async function handleRequest(message) {
  if (!message || typeof message !== "object") return;
  if (!Object.hasOwn(message, "method")) {
    settleServerResponse(message);
    return;
  }
  if (message.method === "notifications/cancelled") {
    const context = activeClientRequests.get(message.params?.requestId);
    if (context) {
      context.cancelled = true;
      context.approval?.cancel?.();
    }
    pendingServerRequests.get(message.params?.requestId)?.settle({action: "cancel"});
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.id === undefined || message.id === null) return;
  const context = {cancelled: false, approval: null};
  activeClientRequests.set(message.id, context);
  try {
    if (message.method === "initialize") {
      clientProtocolVersion = message.params?.protocolVersion || "2025-11-25";
      clientSupportsFormElicitation = supportsFormElicitation(message.params);
      clientInitializationPromise = (async () => {
        await registerAdapter();
        if (registration?.collectionApprovalVersion !== 3) return;
        await fetchJson("/v1/collection-approvals/capability", {
          token: adapterToken,
          transport: clientSupportsFormElicitation ? "mcp-elicitation-v1" : "conversation-v1",
        });
      })();
      await clientInitializationPromise;
      writeResult(message.id, {
        protocolVersion: message.params?.protocolVersion || "2025-11-25",
        capabilities: {tools: {listChanged: false}},
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          icons: SERVER_ICONS,
        },
        instructions: [
          "每次新任务在检查连接后，先用 mediaclaw_get_capabilities 核查当前插件能力与本 Agent 实际入口，再读取已有数据和制定可调整方案。availableToAgent=false 或 missingAgentTools 非空时不得假称可以指挥；插件不支持能力发现时准确报告，不能凭版本号或源码推断当前运行能力。除首次批准设备配对外，所有操作、方案调整与确认都在 Agent 对话中完成，不引导用户去插件确认。私信触达可准备、用 replacesPlanId 修订、取消/停止和查状态；最终发送前在对话中展示完整收件人、发送账号和话术，并在用户明确回复后调用 mediaclaw_confirm_comment_outreach。清理使用最新 preview_clear_data 返回的 scopeVersion/clears/preserves 与原样 confirmationToken；旧预览不能授权扩大清理范围。",
          "新增采集先复用已有数据，用 mediaclaw_prepare_collection（账号也可用 prepare_profile_collection）冻结必要范围。是否需要新确认取决于风险与当前任务已有的具体授权，不是每次调用都询问或弹窗。普通规模的普通采集，用户已明确要求同一来源、时间/排序、总量与数据深度时，可通过 authorization:{type:user_request,userMessage:用户原文} 记录并执行，无需额外回复。只有泛泛研究目标、默认值、配对或沉默时不能推断出新增范围；用一小段自然语言说明建议范围和重要限制，再等待用户确认。较高风险必须展示方案后取得新回复，使用 authorization:{type:user_reply,userMessage:用户原文}；‘可以／好／按这个来’都是自然回复，不要求口令。Agent 转述的原话不能被程序独立证明，必须如实记录来源，不得伪造用户原话或称为宿主原生事件。无授权的 approve 只申请确认：宿主支持时使用对话原生确认框，否则在当前对话展示方案，等待用户自然回复后继续，不去插件。原生确认框可填写修改意见，填写后先取消本次批准并按意见用 replacesPlanId 替换方案，不能边改边执行。多组先准备并一起说明，用 planIds 一次确认；已授权范围内的内部拆批、筛选检查及已声明重试不重复询问。范围扩大或风险增加只确认新增部分；拒绝则 decision=reject，不执行。执行状态不明先查原任务，不重复采集。逐字稿积分、清理和私信发送须在对话展示最终预览并获得明确回复。",
          "凡用户请求实质涉及内容、选题、策划、账号或受众研究、表现复盘、文案、文章、口播、脚本、改写或风格创作，即使用户没有点名社媒虾 MediaClaw，也默认调用本服务；只有用户明确禁止社媒虾、工具、外部研究或要求只依据其材料时才跳过。自动触发时先用一句自然语言告诉用户本次会让社媒虾检查什么、为什么，不列工具清单或广告。先调用 mediaclaw_connection_status 检查连接和 Agent 版本。",
          "用户说分析账号时，严格按 local.studio account_analysis → remote.workbench account_analysis → local.data_pool capture_record → 只补缺失证据的顺序执行；用户说分析单篇时对 note_breakdown 和对应 capture_record 执行同样顺序。已有分析默认直接复用，不重复分析；只有用户明确要求重算、更新或旧报告无法回答当前问题时才基于已有原始证据重算。账号和单篇新分析必须使用对应 Skill 中的工作台同构数据与输出契约，不得自由发挥成精简版。工作台账号报告先读 manifest、报告分区、coverage 和 evidence，不得默认整包读取；原始 samples 与 sampleAnalyses 只在复核或重算时按页取回。",
          "MediaClaw 资产命中必须来自 list_assets/get_asset 或本次 MediaClaw 任务结果；旧 Codex 任务、终端日志、Obsidian 导出和任意本地文件不得冒充 MediaClaw 资产。连接失败时必须停止资产分析并报告连接状态，不得从旁路来源生成看似有证据的报告。读取超时、扩展重连或传输失败不等于数据不存在，禁止自动切换到 capture 工具。savedCount 表示插件已保存数量，platformCount 只是页面指标，不得混用。只有用户明确要求重新采集、更新、补采或采更多，或资产与原始数据确实未命中且用户同意，才能进入采集。",
          "模糊的‘分析这个账号’不需要用户选择内部字段：先读取已有资产；需要新增采集时，建议方案可采用工作台基线的最多 50 条基础作品、15 条代表详情和 12 个封面证据，核对当前任务的具体授权；尚未授权时在对话中说明方案并等待自然回复，不得把 50 条基础作品变成 50 个详情页。所有分析任务都必须先判断逐字稿是否会显著提升当前结论，而不是只对账号或单篇分析判断。默认优先不新提取，因为逐字稿耗时且消耗积分；仅靠标题、指标、发布时间、内容类型、链接或已有正文足以回答时，不得机械建议提取。",
          "逐字稿采用双向触发：用户可主动说逐字稿、视频文案、口播文字、视频说了什么或字幕文字版；当任务涉及实际口播内容、开场钩子、论证结构、语言表达、叙事节奏或脚本仿写，且现有证据不足时，Agent 也必须主动说明当前证据能回答什么、逐字稿会新增什么，并只为最少且足够的代表视频生成报价。已有逐字稿直接读取且不收费；新提取只对缺失项收费，必须展示逐条积分、总积分、余额和有效期，取得用户明确确认后才执行。用户拒绝或暂不提取时，应基于现有证据继续分析并清楚标注边界。‘帮我写视频文案’属于生成请求，不得仅凭这句话误判为提取；只有用户是在索要原视频所说内容时才视为主动提取请求。",
          "目标明确后先调用 mediaclaw_prepare_profile_collection，简要说明范围与实际风险。已有普通具体授权可用 user_request 原文衔接确认；较高风险或尚未明确的范围，在当前对话展示方案并取得 user_reply 后再执行，不逐批重复询问。单独 approve 不是授权；用户要求修改时先替换方案。只要用户提到模仿、仿写、像某人一样写或按某人/某账号风格创作，必须先查询 local.studio 的 style_profile，本地未命中再查 remote.workbench，并读取完整真实档案；不得根据账号名猜测。",
          "若状态查询称未连接而用户展示浏览器已显示当前宿主连接，先短暂自动复查。agentUpdate.status=update_available 时必须取得明确授权并通过 mediaclaw_manage_agent_update 自动安装；用户已经说‘升级 Agent／升级社媒虾／升级到最新版’时这句话就是授权，不得再次确认，也不得向用户展示命令。agentUpdate.status=manual_update_available 时只说明需要重新执行 MediaClaw 提供的本地安装提示，不得误用其他宿主的升级命令。返回 installed_restart_required 后必须报告 installedVersion，明确要求完全退出并重新打开状态中指定的宿主、回到原对话发送‘继续’；不得在旧进程中创建新任务。重开后只有状态为 activated 且 activeVersion 等于目标版本，才宣布升级完成并续接原任务。社媒虾浏览器插件负责真实读取与采集，当前 Agent 负责按 Skill 分析和生成。",
        ].join(""),
      });
      return;
    }
    if (message.method === "ping") {
      writeResult(message.id, {});
      return;
    }
    let result;
    if (clientInitializationPromise) await clientInitializationPromise;
    if (message.method === "tools/list") {
      result = attachAgentUpdateTool(
        await callBroker(message.method, message.params || {}),
      );
    } else if (isAgentUpdateCall(message)) {
      const payload = await agentUpdateOrchestrator.decide(
        message.params?.arguments || {},
      );
      result = adapterToolResult(payload, {isError: payload.ok === false});
    } else if (
      message.method === "tools/call" &&
      agentUpdateOrchestrator.isSessionFenced() &&
      !isConnectionStatusCall(message)
    ) {
      result = oldSessionFencedResult();
    } else {
      result = await callBroker(message.method, message.params || {});
    }
    if (message.method === "tools/call" &&
        ["mediaclaw_confirm_collection", "mediaclaw_confirm_profile_collection"].includes(message.params?.name)) {
      result = await handleCollectionApproval(result, context, message.params);
    }
    if (isConnectionStatusCall(message)) {
      result = await attachAgentUpdate(result);
    }
    if (result?.error && Number.isFinite(Number(result.error.code))) {
      writeError(
        message.id,
        Number(result.error.code),
        String(result.error.message || "MediaClaw Broker request failed"),
        result.error.data,
      );
      return;
    }
    writeResult(message.id, result);
  } catch (error) {
    writeError(
      message.id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (activeClientRequests.get(message.id) === context) activeClientRequests.delete(message.id);
  }
}

let inputBuffer = Buffer.alloc(0);

function consumeInput() {
  while (inputBuffer.length > 0) {
    const asText = inputBuffer.toString("utf8");
    if (/^content-length:/i.test(asText)) {
      const headerEnd = inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = inputBuffer.subarray(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        inputBuffer = inputBuffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (inputBuffer.length < end) return;
      const body = inputBuffer.subarray(start, end).toString("utf8");
      inputBuffer = inputBuffer.subarray(end);
      try {
        void handleRequest(JSON.parse(body));
      } catch {
        // Ignore malformed input.
      }
      continue;
    }
    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) return;
    const line = inputBuffer.subarray(0, newline).toString("utf8").trim();
    inputBuffer = inputBuffer.subarray(newline + 1);
    if (!line) continue;
    try {
      void handleRequest(JSON.parse(line));
    } catch {
      // Ignore malformed input.
    }
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const context of activeClientRequests.values()) context.cancelled = true;
  const cancelling = [...collectionApprovalFlows.values()].filter((state) => state.cancel);
  for (const state of cancelling) state.cancel();
  await Promise.allSettled(cancelling.map((state) => state.promise));
  if (adapterToken) {
    await fetchJson(
      "/v1/adapters/unregister",
      {token: adapterToken},
      1_000,
    ).catch(() => null);
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
  consumeInput();
});
process.stdin.on("end", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void stop().finally(() =>
    process.exit(process.env.MEDIACLAW_AGENT_SUPERVISED === "1" ? 143 : 0),
  );
});
process.on("SIGINT", () => {
  void stop().finally(() =>
    process.exit(process.env.MEDIACLAW_AGENT_SUPERVISED === "1" ? 130 : 0),
  );
});

await registerAdapter().catch(reportRegistrationError);
heartbeatTimer = setInterval(() => {
  if (!adapterToken) {
    void registerAdapter().catch(reportRegistrationError);
    return;
  }
  void fetchJson("/v1/adapters/heartbeat", {token: adapterToken}, 2_000).catch(
    (error) => {
      adapterToken = "";
      reportRegistrationError(error);
    },
  );
}, Math.min(HEARTBEAT_INTERVAL_MS, 5_000));
heartbeatTimer.unref?.();
if (adapterToken) {
  process.stderr.write(
    `[mediaclaw] ${hostKey} Adapter connected to shared Broker on 127.0.0.1:${BROKER_PORT}\n`,
  );
}
