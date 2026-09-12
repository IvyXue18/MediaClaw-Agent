import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import net from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
import MCP_CONTRACT from "../plugins/mediaclaw/contracts/mcp-v1.json" with {type: "json"};

// This fixture only speaks to a fresh Broker and a fake extension on loopback.
// Public confirm calls only request approval. Successful fixtures separately
// simulate a host user response over the internal Adapter response lane.
const NOTE_URL = "https://www.xiaohongshu.com/explore/consent-fixture";
const PROFILE_URL = "https://www.xiaohongshu.com/user/profile/consent-fixture";
const RAW_COLLECTIONS = [
  ["mediaclaw_capture_note", {url: NOTE_URL}],
  ["mediaclaw_capture_search_basic", {keyword: "测试主题"}],
  ["mediaclaw_capture_profile_basic", {profileUrl: PROFILE_URL}],
  ["mediaclaw_enhance_records", {recordIds: ["record-a"], confirmed: true}],
  ["mediaclaw_scan_keyword", {keyword: "测试主题"}],
  ["mediaclaw_expand_keywords", {seedKeyword: "测试主题"}],
  ["mediaclaw_research_keyword_topics", {keyword: "测试主题"}],
  ["mediaclaw_research_longtail_keywords", {seedKeyword: "测试主题"}],
  ["mediaclaw_scan_account", {profileUrl: PROFILE_URL}],
  ["mediaclaw_capture_account_profile", {profileUrl: PROFILE_URL}],
  ["mediaclaw_research_account_hits", {profileUrl: PROFILE_URL}],
  ["mediaclaw_research_benchmark_accounts", {keyword: "测试主题"}],
  ["mediaclaw_capture_content", {url: NOTE_URL}],
  ["mediaclaw_research_single_note", {
    url: NOTE_URL,
    analysisTranscriptDecision: "not_needed",
    analysisTranscriptReason: "图文样本不需要视频口播",
  }],
  ["mediaclaw_deep_collect", {urls: [NOTE_URL]}],
  ["mediaclaw_capture_comments", {url: NOTE_URL}],
  ["mediaclaw_capture_comments_full", {url: NOTE_URL}],
  ["mediaclaw_extract_image_text", {recordId: "record-a"}],
];

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitUntil(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(10);
  }
  assert.fail(message);
}

async function fixture(t, {ttlMs = 60_000, respond, responseFor, responseDelayMs = () => 5} = {}) {
  const port = await availablePort();
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "mediaclaw-consent-"));
  const broker = spawn(process.execPath, [path.resolve("plugins/mediaclaw/scripts/broker-server.mjs")], {
    env: {
      ...process.env,
      MEDIACLAW_AGENT_PORT: String(port),
      MEDIACLAW_AGENT_STATE_DIR: stateDirectory,
      MEDIACLAW_COLLECTION_PLAN_TTL_MS: String(ttlMs),
      MEDIACLAW_AGENT_CHANNEL: "local",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  let socket;
  t.after(async () => {
    socket?.close();
    if (broker.exitCode === null) {
      const exited = new Promise((resolve) => broker.once("exit", resolve));
      broker.kill("SIGTERM");
      await exited;
    }
    await rm(stateDirectory, {recursive: true, force: true});
  });
  await waitUntil(() => /shared Agent Broker listening/.test(stderr), "Broker did not start");
  async function post(endpoint, payload) {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(payload),
    });
    return response.json();
  }
  async function register(hostKey = "codex") {
    const registered = await post("/v1/adapters/register", {
      hostKey,
      displayName: "Isolated Consent Fixture",
      adapterVersion: MCP_CONTRACT.serverVersion,
      agentChannel: "local",
      collectionApprovalTransport: "mcp-elicitation-v1",
      instanceId: `consent-${crypto.randomUUID()}`,
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    return registered;
  }
  const owner = await register();
  async function request(method, params, identity = owner) {
    return post("/v1/mcp", {token: identity.token, method, params});
  }
  const call = (name, args = {}, identity = owner, extraParams = {}) =>
    request("tools/call", {name, arguments: args, ...extraParams}, identity);
  const starts = [];
  const cancelledTaskIds = new Set();
  socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "task.cancel") {
      cancelledTaskIds.add(message.taskId);
      socket.send(JSON.stringify({type: "task.cancel.result", taskId: message.taskId, deviceId: message.deviceId, response: {ok: true, canceled: true}}));
      return;
    }
    if (message.type !== "task.start") return;
    starts.push(message);
    setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN || cancelledTaskIds.has(message.taskId)) return;
      socket.send(JSON.stringify({
        type: "task.result",
        taskId: message.taskId,
        deviceId: message.deviceId,
        response: responseFor?.(message) || {ok: true, data: respond?.(message) || {captureResult: {records: []}}},
      }));
    }, responseDelayMs(message));
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
  socket.send(JSON.stringify({
    type: "extension.hello",
    protocolVersion: "3",
    deviceId: owner.device.deviceId,
    sessionId: "isolated-consent-session",
    extensionId: "isolated-consent-extension",
    extensionVersion: "0.3.1",
    collectionApprovalSupported: true,
  }));
  await waitUntil(async () => (await call("mediaclaw_connection_status")).structuredContent?.connected, "Fake extension did not connect");
  const respondApproval = (requestId, decision = "approve", identity = owner) =>
    post("/v1/collection-approvals/respond", {token: identity.token, requestId, decision});
  const approve = async (name, args = {}, identity = owner) => {
    const pending = await call(name, args, identity);
    if (pending.structuredContent?.status !== "user_approval_required") return pending;
    return respondApproval(pending.structuredContent.approvalRequest.requestId, "approve", identity);
  };
  return {
    call, approve, respondApproval, post, socket, request, register, owner, starts,
    async prepare(toolName, args, extra = {}) {
      return pendingPlan(await call("mediaclaw_prepare_collection", {
        userGoal: "先展示方案，等待我的明确确认",
        toolName,
        arguments: args,
        ...extra,
      }));
    },
    confirm(planId, extra = {}, identity = owner) {
      return approve("mediaclaw_confirm_collection", {planId, decision: "approve", ...extra}, identity);
    },
    async persistedTasks() {
      return waitUntil(async () => {
        try {
          const parsed = JSON.parse(await readFile(path.join(stateDirectory, "tasks-v1.json"), "utf8"));
          return parsed.tasks;
        } catch { return null; }
      }, "Broker did not persist tasks");
    },
  };
}

function pendingPlan(result) {
  const data = result.structuredContent;
  assert.equal(data?.ok, true, JSON.stringify(result));
  assert.equal(data.status, "confirmation_required");
  assert.equal(data.collectionStarted, false);
  assert.equal(data.taskId, undefined);
  assert.equal(data.task, undefined);
  assert.equal(result.task, undefined);
  assert.equal(data.plan.status, "awaiting_confirmation");
  assert.ok(data.plan.planId);
  return data.plan;
}

function failsWith(result, expected) {
  assert.equal(result.structuredContent?.ok, false, JSON.stringify(result));
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error.code, expected);
  assert.equal(result.structuredContent.taskId, undefined);
  assert.equal(result.task, undefined);
}

function completed(result) {
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.task.status, "completed");
  assert.equal(result.structuredContent.result.ok, true);
  return result.structuredContent;
}

test("a model's approve only opens user confirmation, and only the matching host response starts capture", async (t) => {
  const f = await fixture(t);
  const plan = await f.prepare("mediaclaw_capture_search_basic", {keyword: "营养测评", limit: 20});
  const pending = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve"});
  assert.equal(pending.structuredContent.status, "user_approval_required");
  assert.equal(pending.structuredContent.collectionStarted, false);
  const id = pending.structuredContent.approvalRequest.requestId;
  assert.match(pending.structuredContent.approvalRequest.message, /营养测评/);
  await delay(30);
  assert.equal(f.starts.length, 0);
  const repeated = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve"});
  assert.equal(repeated.structuredContent.approvalRequest.requestId, id);
  for (const extra of [{userConfirmed: true}, {approvalSource: "mcp-elicitation-v1"}, {receipt: {version: 2}}]) {
    failsWith(await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve", ...extra}), /INVALID_COLLECTION_CONFIRMATION/);
  }
  const spoofedMeta = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve"}, f.owner,
    {_meta: {userApproved: true, collectionConsent: {version: 2, source: "mcp-elicitation-v1"}}});
  assert.equal(spoofedMeta.structuredContent.collectionStarted, false);
  const anotherSession = await f.register();
  failsWith(await f.respondApproval(id, "approve", anotherSession), /COLLECTION_APPROVAL_OWNER_MISMATCH/);
  failsWith(await f.respondApproval("forged-request", "approve"), /COLLECTION_APPROVAL_OWNER_MISMATCH/);
  assert.equal(f.starts.length, 0);
  completed(await f.respondApproval(id));
  assert.equal(f.starts.length, 1);
  failsWith(await f.respondApproval(id), /COLLECTION_APPROVAL_ALREADY_CLOSED/);
  const saved = await f.persistedTasks();
  const receipt = saved.find((task) => task.taskId === f.starts[0].taskId).collectionConsent;
  assert.equal(receipt.version, 2);
  assert.equal(receipt.source, "mcp-elicitation-v1");
  assert.equal(receipt.requestId, id);
});

test("cancel, rejection, replacement and expiry invalidate pending user approvals", async (t) => {
  const f = await fixture(t, {ttlMs: 200});
  for (const decision of ["cancel", "reject"]) {
    const plan = await f.prepare("mediaclaw_capture_search_basic", {keyword: decision, limit: 1});
    const pending = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve"});
    const id = pending.structuredContent.approvalRequest.requestId;
    assert.equal((await f.respondApproval(id, decision)).structuredContent.collectionStarted, false);
    failsWith(await f.respondApproval(id), /COLLECTION_APPROVAL_ALREADY_CLOSED/);
    if (decision === "cancel") {
      const again = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve"});
      assert.notEqual(again.structuredContent.approvalRequest.requestId, id);
      await f.respondApproval(again.structuredContent.approvalRequest.requestId, "cancel");
    }
  }
  const plan = await f.prepare("mediaclaw_capture_search_basic", {keyword: "replace", limit: 1});
  const pending = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve"});
  await f.prepare("mediaclaw_capture_search_basic", {keyword: "replace", limit: 2}, {replacesPlanId: plan.planId});
  failsWith(await f.respondApproval(pending.structuredContent.approvalRequest.requestId), /COLLECTION_APPROVAL_ALREADY_CLOSED/);
  const expiring = await f.prepare("mediaclaw_capture_search_basic", {keyword: "expire", limit: 1});
  const expiry = await f.call("mediaclaw_confirm_collection", {planId: expiring.planId, decision: "approve"});
  await delay(220);
  failsWith(await f.respondApproval(expiry.structuredContent.approvalRequest.requestId), /COLLECTION_APPROVAL_EXPIRED|COLLECTION_APPROVAL_ALREADY_CLOSED/);
  assert.equal(f.starts.length, 0);
});

test("profile approval and cancelling a pending confirmation task cannot bypass the user", async (t) => {
  const f = await fixture(t);
  const plan = (await f.call("mediaclaw_prepare_profile_collection", {
    userGoal: "查看账号链接", profileUrl: PROFILE_URL, purpose: "inventory_export",
    contentType: "all", coverage: "recent", maxItems: 1, requestedFields: ["post_page_url"],
  })).structuredContent.plan;
  const pending = await f.call("mediaclaw_confirm_profile_collection", {planId: plan.planId});
  assert.equal(pending.structuredContent.status, "user_approval_required");
  assert.equal(f.starts.length, 0);
  await f.call("mediaclaw_cancel_task", {taskId: pending.structuredContent.taskId});
  failsWith(await f.respondApproval(pending.structuredContent.approvalRequest.requestId), /COLLECTION_APPROVAL_ALREADY_CLOSED/);
  assert.equal(f.starts.length, 0);
});

test("extension fallback requires the paired UI response and cannot be approved by the MCP response lane", async (t) => {
  const f = await fixture(t);
  await f.post("/v1/collection-approvals/capability", {token: f.owner.token, transport: "extension-ui-v1"});
  const messages = [];
  f.socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  const plan = await f.prepare("mediaclaw_capture_search_basic", {keyword: "插件确认", limit: 1});
  const pending = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve", async: true});
  const request = await waitUntil(() => messages.find((m) => m.type === "collection.approval.request"), "Approval card not sent");
  failsWith(await f.respondApproval(request.requestId), /COLLECTION_APPROVAL_OWNER_MISMATCH/);
  f.socket.send(JSON.stringify({type: "collection.approval.response", requestId: request.requestId,
    deviceId: request.deviceId, sessionId: "wrong-session", decision: "approve"}));
  await delay(20);
  assert.equal(f.starts.length, 0);
  f.socket.send(JSON.stringify({type: "collection.approval.response", requestId: request.requestId,
    deviceId: request.deviceId, sessionId: request.sessionId, decision: "approve"}));
  await waitUntil(() => f.starts.length === 1, "User-approved capture not started");
  await waitUntil(async () => (await f.call("mediaclaw_task_status", {taskId: pending.structuredContent.taskId})).structuredContent.task.status === "completed", "Approval task did not mirror result");
  assert.equal(f.starts.length, 1);
});

test("changing confirmation transport or closing the owning session invalidates old requests", async (t) => {
  const f = await fixture(t);
  const plan = await f.prepare("mediaclaw_capture_search_basic", {keyword: "切换确认入口", limit: 1});
  const original = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve"});
  await f.post("/v1/collection-approvals/capability", {token: f.owner.token, transport: "extension-ui-v1"});
  const replacement = await f.call("mediaclaw_confirm_collection", {planId: plan.planId, decision: "approve"});
  assert.notEqual(replacement.structuredContent.approvalRequest.requestId, original.structuredContent.approvalRequest.requestId);
  assert.equal(replacement.structuredContent.approvalRequest.transport, "extension-ui-v1");
  failsWith(await f.respondApproval(original.structuredContent.approvalRequest.requestId), /COLLECTION_APPROVAL_OWNER_MISMATCH|COLLECTION_APPROVAL_ALREADY_CLOSED/);
  await f.post("/v1/adapters/unregister", {token: f.owner.token});
  f.socket.send(JSON.stringify({type: "collection.approval.response", requestId: replacement.structuredContent.approvalRequest.requestId,
    deviceId: f.owner.device.deviceId, sessionId: "isolated-consent-session", decision: "approve"}));
  await delay(30);
  assert.equal(f.starts.length, 0);
});

test("all 18 raw collection entry points and aliases only propose, including async and MCP Tasks", async (t) => {
  const f = await fixture(t);
  assert.equal(RAW_COLLECTIONS.length, 18);
  for (const [name, args] of RAW_COLLECTIONS) {
    await t.test(name, async () => {
      for (const params of [{}, {task: {ttl: 60_000}}]) {
        const plan = pendingPlan(await f.call(name, {...args, async: true}, f.owner, params));
        assert.equal(plan.toolName, name);
        assert.equal(plan.arguments.async, undefined);
        assert.equal(plan.arguments.confirmed, undefined);
        assert.equal(plan.confirmation.startsCollection, false);
      }
      assert.equal(f.starts.length, 0, `${name} must not dispatch browser work`);
    });
  }
  // A fake approval boolean is not part of the comments API and fails closed.
  for (const name of ["mediaclaw_capture_comments", "mediaclaw_capture_comments_full"]) {
    failsWith(await f.call(name, {url: NOTE_URL, confirmed: true, async: true}), /INVALID_COLLECTION_PLAN/);
  }
  await delay(30);
  assert.equal(f.starts.length, 0);
});

test("prepare freezes defaults and exposes search, workflow, comments and OCR scope without work", async (t) => {
  const f = await fixture(t);
  const basic = await f.prepare("mediaclaw_capture_search_basic", {keyword: "  测试主题  "});
  assert.equal(basic.arguments.keyword, "测试主题");
  assert.equal(basic.arguments.platform, "xiaohongshu");
  assert.equal(basic.arguments.limit, 80);
  assert.deepEqual(basic.scope.filters, {
    timeRange: "any", sortBy: "default", contentType: "all",
    videoDuration: "all", searchScope: "all", locationScope: "all",
  });
  assert.equal(basic.scope.basicItemLimit, 80);
  assert.equal(basic.scope.detailPageLimit, 0);
  assert.equal(basic.scope.commentItemLimit, 0);
  assert.deepEqual(basic.confirmation.confirmationArgument, {planId: basic.planId, decision: "approve"});
  const trend = await f.prepare("mediaclaw_research_keyword_topics", {keyword: "测试主题"});
  assert.equal(trend.scope.filters.timeRange, "6m");
  assert.equal(trend.scope.filters.sortBy, "likes");
  const benchmark = await f.prepare("mediaclaw_research_benchmark_accounts", {keyword: "测试主题", candidateLimit: 2});
  assert.equal(benchmark.scope.profilePageLimit, 2);
  assert.match(benchmark.scope.browserActions.join(" "), /2 个候选账号主页/);
  const note = await f.prepare("mediaclaw_research_single_note", {
    url: NOTE_URL, includeComments: true, commentLimit: 4, includeMediaText: true,
    analysisTranscriptDecision: "not_needed", analysisTranscriptReason: "仅分析图文",
  });
  assert.equal(note.scope.detailPageLimit, 1);
  assert.equal(note.scope.commentItemLimit, 4);
  assert.equal(note.scope.imageText, true);
  assert.equal(note.scope.transcript, "不新增提取");
  const ocr = await f.prepare("mediaclaw_extract_image_text", {recordId: "record-a"});
  assert.deepEqual(ocr.scope.targets, ["record-a"]);
  assert.equal(ocr.scope.imageText, true);
  assert.equal(f.starts.length, 0);
});

test("OCR plans distinguish reuse from forced extraction and saved-record enhancements explain their platform", async (t) => {
  const f = await fixture(t);
  const reusable = await f.prepare("mediaclaw_extract_image_text", {recordId: "record-a"});
  assert.equal(reusable.scope.imageTextMode, "reuse_or_extract");
  assert.match(reusable.scope.browserActions.join(" "), /复用/);
  const forced = await f.prepare("mediaclaw_extract_image_text", {recordId: "record-a", force: true});
  assert.equal(forced.scope.imageTextMode, "force");
  assert.match(forced.scope.browserActions.join(" "), /重新提取/);
  assert.match(forced.scope.browserActions.join(" "), /不复用/);
  const forcedNote = await f.prepare("mediaclaw_research_single_note", {
    url: NOTE_URL, forceMediaExtraction: true, includeMediaText: true,
    analysisTranscriptDecision: "not_needed", analysisTranscriptReason: "需要重新识别配图文字",
  });
  assert.equal(forcedNote.scope.imageTextMode, "force");
  const enhancement = await f.prepare("mediaclaw_enhance_records", {
    recordIds: ["record-a", "record-b"], includeBloggerMetrics: true,
    includeComments: true, commentsPerItemLimit: 4,
  });
  assert.equal(enhancement.scope.platform, "已保存记录所属平台");
  assert.doesNotMatch(enhancement.confirmation.prompt, /undefined/);
  assert.equal(enhancement.scope.profilePageLimit, 2);
  assert.equal(enhancement.arguments.commentsPerItemLimit, 4);
  assert.equal(enhancement.scope.commentsPerItemLimit, 4);
  assert.equal(enhancement.scope.commentItemLimit, 8);
  const deep = await f.prepare("mediaclaw_deep_collect", {
    urls: [NOTE_URL, `${NOTE_URL}-b`], includeBloggerMetrics: true,
  });
  assert.equal(deep.scope.profilePageLimit, 2);
  assert.equal(f.starts.length, 0);
});

test("known URL platform conflicts and mixed-platform batches fail before creating browser work", async (t) => {
  const f = await fixture(t);
  const conflicts = [
    ["mediaclaw_capture_note", {url: NOTE_URL, platform: "douyin"}],
    ["mediaclaw_capture_content", {url: "https://www.douyin.com/video/123456", platform: "xiaohongshu"}],
    ["mediaclaw_capture_profile_basic", {profileUrl: PROFILE_URL, platform: "douyin"}],
    ["mediaclaw_capture_comments", {url: "https://v.douyin.com/consent-fixture/", platform: "xiaohongshu"}],
    ["mediaclaw_deep_collect", {urls: [NOTE_URL, "https://www.douyin.com/video/123456"]}],
    ["mediaclaw_capture_note", {url: `${NOTE_URL}?token=${"a".repeat(1000)}`}],
  ];
  for (const [toolName, args] of conflicts) {
    failsWith(await f.call(toolName, {...args, async: true}), /INVALID_COLLECTION_PLAN|PLATFORM/);
    failsWith(await f.call("mediaclaw_prepare_collection", {
      userGoal: "平台必须与目标一致", toolName, arguments: args,
    }), /INVALID_COLLECTION_PLAN|PLATFORM/);
  }
  const profileArgs = {
    userGoal: "平台必须与账号一致", profileUrl: PROFILE_URL, platform: "douyin",
    purpose: "inventory_export", contentType: "all", coverage: "latest",
    maxItems: 2, requestedFields: ["title", "post_page_url"],
  };
  failsWith(await f.call("mediaclaw_prepare_profile_collection", profileArgs), /INVALID_PROFILE_COLLECTION_INTENT|PLATFORM/);
  failsWith(await f.call("mediaclaw_prepare_collection", {
    userGoal: "平台必须与账号一致", toolName: "mediaclaw_prepare_profile_collection", arguments: profileArgs,
  }), /INVALID_COLLECTION_PLAN|PLATFORM/);
  assert.equal(f.starts.length, 0);
});

test("platform inference uses URL hostnames rather than lookalike domains or path text", async (t) => {
  const f = await fixture(t);
  for (const [toolName, args] of [
    ["mediaclaw_capture_note", {url: "https://www.douyin.com/video/123456"}],
    ["mediaclaw_capture_comments", {url: "https://v.douyin.com/consent-fixture/"}],
    ["mediaclaw_capture_profile_basic", {profileUrl: "https://www.douyin.com/user/consent-fixture"}],
    ["mediaclaw_deep_collect", {urls: ["https://www.douyin.com/video/123456", "https://www.douyin.com/video/654321"]}],
  ]) {
    const plan = await f.prepare(toolName, args);
    assert.equal(plan.arguments.platform, "douyin");
    assert.equal(plan.scope.platform, "douyin");
  }
  for (const url of [
    "https://douyin.com.attacker.test/video/123456",
    "https://example.invalid/path/douyin.com/video/123456",
    "https://douyin.com@example.invalid/video/123456",
  ]) {
    const result = await f.call("mediaclaw_capture_note", {url});
    if (result.structuredContent.ok) {
      const plan = pendingPlan(result);
      assert.notEqual(plan.arguments.platform, "douyin", url);
      assert.notEqual(plan.scope.platform, "douyin", url);
    } else {
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.collectionStarted, false);
    }
  }
  const profileArgs = {
    userGoal: "识别链接里的抖音账号", profileUrl: "https://www.douyin.com/user/consent-fixture",
    purpose: "inventory_export", contentType: "all", coverage: "latest",
    maxItems: 2, requestedFields: ["title", "post_page_url"],
  };
  const directProfile = pendingPlan(await f.call("mediaclaw_prepare_profile_collection", profileArgs));
  const genericProfile = await f.prepare("mediaclaw_prepare_profile_collection", profileArgs);
  assert.equal(directProfile.intent.platform, "douyin");
  assert.equal(directProfile.collectionScope.platform, "douyin");
  assert.equal(genericProfile.intent.platform, "douyin");
  assert.equal(genericProfile.collectionScope.platform, "douyin");
  assert.equal(f.starts.length, 0);
});

test("rejection and scope replacement invalidate the old plan and never dispatch it", async (t) => {
  const f = await fixture(t);
  const rejected = await f.prepare("mediaclaw_capture_search_basic", {keyword: "拒绝项"});
  const rejection = await f.confirm(rejected.planId, {decision: "reject"});
  assert.equal(rejection.structuredContent.status, "rejected");
  assert.equal(rejection.structuredContent.collectionStarted, false);
  failsWith(await f.confirm(rejected.planId), /COLLECTION_PLAN_REJECTED/);
  const original = await f.prepare("mediaclaw_capture_search_basic", {keyword: "当前", timeRange: "7d", limit: 3});
  failsWith(await f.call("mediaclaw_prepare_collection", {
    userGoal: "无效修改不能作废原方案", toolName: "mediaclaw_capture_search_basic",
    arguments: {keyword: "当前", limit: 999}, replacesPlanId: original.planId,
  }), /INVALID_COLLECTION_PLAN/);
  const changed = await f.prepare("mediaclaw_capture_search_basic", {keyword: "当前", timeRange: "6m", limit: 5}, {replacesPlanId: original.planId});
  assert.notEqual(changed.planId, original.planId);
  failsWith(await f.confirm(original.planId), /COLLECTION_PLAN_REPLACED/);
  assert.equal(f.starts.length, 0);
  const approved = await f.confirm(changed.planId);
  completed(approved);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].task.limit, 5);
  assert.equal(f.starts[0].task.options.timeRange, "6m");
});

test("expired plans fail closed without browser work", async (t) => {
  const f = await fixture(t, {ttlMs: 100});
  const plan = await f.prepare("mediaclaw_capture_search_basic", {keyword: "过期方案"});
  await delay(Math.max(0, Date.parse(plan.expiresAt) - Date.now()) + 25);
  failsWith(await f.confirm(plan.planId), /COLLECTION_PLAN_EXPIRED/);
  assert.equal(f.starts.length, 0);
  // A new technical plan with the exact same scope can implement the existing
  // conversational approval. No collection has happened while refreshing it.
  const refreshed = await f.prepare(plan.toolName, plan.arguments);
  assert.deepEqual(refreshed.arguments, plan.arguments);
  assert.deepEqual(refreshed.scope, plan.scope);
  completed(await f.confirm(refreshed.planId));
  assert.equal(f.starts.length, 1);
});

test("one approval executes all six frozen groups even after later plans pass their pending expiry", async (t) => {
  const keywords = ["小红书运营", "小红书选题", "AI写作", "AI工具", "爆款拆解", "内容调研"];
  const f = await fixture(t, {
    ttlMs: 1000,
    responseDelayMs: (message) => message.task.keyword === keywords[0] ? 1100 : 5,
  });
  const plans = [];
  for (const keyword of keywords) plans.push(await f.prepare("mediaclaw_capture_search_basic", {
    keyword, platform: "xiaohongshu", timeRange: "6m", sortBy: "likes", limit: 50,
  }));
  assert.equal(f.starts.length, 0);
  const planIds = plans.map((plan) => plan.planId);
  const result = completed(await f.approve("mediaclaw_confirm_collection", {planIds, decision: "approve"}));
  assert.deepEqual(f.starts.map((message) => message.task.keyword), keywords);
  assert.ok(Date.now() > Date.parse(plans.at(-1).expiresAt));
  assert.ok(f.starts.every((message) => message.task.limit === 50 && message.task.options.timeRange === "6m" && message.task.options.sortBy === "likes"));
  assert.equal(result.result.completedCount, 6);
  assert.equal(result.childTaskIds.length, 6);
  assert.deepEqual(result.result.remainingPlanIds, []);
  const state = await waitUntil(async () => {
    const persisted = await f.persistedTasks();
    return persisted.filter((task) => result.childTaskIds.includes(task.taskId) && task.status === "succeeded").length === 6 ? persisted : null;
  }, "Completed group receipts did not persist");
  for (const [index, item] of result.result.results.entries()) {
    assert.equal(item.planId, planIds[index]);
    completed(await f.call("mediaclaw_task_status", {taskId: item.taskId}));
    const child = state.find((task) => task.taskId === item.taskId);
    assert.equal(child.collectionConsent.planId, planIds[index]);
    assert.equal(child.collectionConsent.ownerDeviceId, f.owner.device.deviceId);
  }
  failsWith(await f.approve("mediaclaw_confirm_collection", {planIds, decision: "approve"}), /COLLECTION_PLAN_ALREADY_USED/);
  assert.equal(f.starts.length, 6);
});

test("batch validation is atomic for unknown, foreign, rejected, replaced, consumed and duplicate plans", async (t) => {
  const f = await fixture(t);
  const valid = await f.prepare("mediaclaw_capture_search_basic", {keyword: "有效方案", limit: 2});
  const rejected = await f.prepare("mediaclaw_capture_search_basic", {keyword: "拒绝方案"});
  await f.confirm(rejected.planId, {decision: "reject"});
  const foreignPlans = [];
  for (const host of ["codex", "workbuddy", "doubao-work"]) {
    const other = await f.register(host);
    foreignPlans.push(pendingPlan(await f.call("mediaclaw_prepare_collection", {
      userGoal: "其他会话", toolName: "mediaclaw_capture_search_basic", arguments: {keyword: "其他会话"},
    }, other)));
  }
  const replaced = await f.prepare("mediaclaw_capture_search_basic", {keyword: "替换前"});
  await f.prepare("mediaclaw_capture_search_basic", {keyword: "替换后"}, {replacesPlanId: replaced.planId});
  const consumed = await f.prepare("mediaclaw_capture_search_basic", {keyword: "已执行", limit: 1});
  completed(await f.confirm(consumed.planId));
  for (const [badId, error] of [
    ["missing-plan", /COLLECTION_PLAN_NOT_FOUND/],
    [rejected.planId, /COLLECTION_PLAN_REJECTED/],
    ...foreignPlans.map((plan) => [plan.planId, /COLLECTION_PLAN_OWNER_MISMATCH/]),
    [replaced.planId, /COLLECTION_PLAN_REPLACED/],
    [consumed.planId, /COLLECTION_PLAN_ALREADY_USED/],
    [valid.planId, /INVALID_COLLECTION_CONFIRMATION/],
  ]) {
    for (const decision of ["approve", "reject"]) {
      failsWith(await f.approve("mediaclaw_confirm_collection", {planIds: [valid.planId, badId], decision}), error);
      assert.deepEqual(f.starts.map((message) => message.task.keyword), ["已执行"]);
    }
  }
  for (const args of [
    {decision: "approve"}, {planIds: [], decision: "approve"},
    {planId: valid.planId, planIds: [valid.planId], decision: "approve"},
    {planIds: [valid.planId], decision: "approve", limit: 300},
    {planIds: valid.planId, decision: "approve"},
    {planIds: [valid.planId, null], decision: "approve"},
    {planIds: [valid.planId, " "], decision: "approve"},
    {planIds: Array.from({length: 1001}, (_, index) => `${valid.planId}-${index}`), decision: "approve"},
    {planIds: [valid.planId]},
    {planIds: [valid.planId], decision: "yes"},
    {planIds: [valid.planId], decision: "approve", async: "true"},
  ]) failsWith(await f.approve("mediaclaw_confirm_collection", args), /INVALID_COLLECTION_CONFIRMATION/);
  assert.deepEqual(f.starts.map((message) => message.task.keyword), ["已执行"]);
  completed(await f.confirm(valid.planId));
  assert.deepEqual(f.starts.map((message) => message.task.keyword), ["已执行", "有效方案"], "an invalid batch must neither consume nor reject the valid plan");
});

test("an expired group rejects an entire batch without consuming the still-valid scope", async (t) => {
  const f = await fixture(t, {ttlMs: 1000});
  const expired = await f.prepare("mediaclaw_capture_search_basic", {keyword: "先准备的方案", limit: 1});
  await delay(500);
  const valid = await f.prepare("mediaclaw_capture_search_basic", {keyword: "仍有效的方案", limit: 2});
  await delay(Math.max(0, Date.parse(expired.expiresAt) - Date.now()) + 25);
  for (const decision of ["approve", "reject"]) {
    failsWith(await f.approve("mediaclaw_confirm_collection", {planIds: [valid.planId, expired.planId], decision}), /COLLECTION_PLAN_EXPIRED/);
  }
  assert.equal(f.starts.length, 0);
  completed(await f.confirm(valid.planId));
  assert.deepEqual(f.starts.map((message) => [message.task.keyword, message.task.limit]), [["仍有效的方案", 2]]);
});

test("a partial approval executes only selected plans and batch rejection executes none", async (t) => {
  const f = await fixture(t);
  const plans = [];
  for (const keyword of ["第一组", "第二组", "第三组"]) plans.push(await f.prepare("mediaclaw_capture_search_basic", {keyword, limit: 1}));
  completed(await f.approve("mediaclaw_confirm_collection", {planIds: [plans[0].planId], decision: "approve"}));
  const planIds = plans.slice(1).map((plan) => plan.planId);
  const rejected = await f.approve("mediaclaw_confirm_collection", {planIds, decision: "reject"});
  assert.equal(rejected.structuredContent.collectionStarted, false);
  assert.deepEqual(rejected.structuredContent.planIds, planIds);
  for (const id of planIds) failsWith(await f.confirm(id), /COLLECTION_PLAN_REJECTED/);
  assert.deepEqual(f.starts.map((message) => message.task.keyword), ["第一组"]);
});

test("a failed group preserves earlier results and stops unstarted groups", async (t) => {
  const f = await fixture(t, {responseFor(message) {
    if (message.task.keyword === "筛选失败") return {ok: false, error: {code: "FILTERS_NOT_APPLIED", message: "筛选未生效"}};
  }});
  const plans = [];
  for (const keyword of ["已完成", "筛选失败", "未开始"]) plans.push(await f.prepare("mediaclaw_capture_search_basic", {keyword, limit: 1}));
  const result = await f.approve("mediaclaw_confirm_collection", {planIds: plans.map((plan) => plan.planId), decision: "approve"});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.task.status, "failed");
  assert.equal(result.structuredContent.result.completedCount, 1);
  assert.deepEqual(result.structuredContent.result.remainingPlanIds, [plans[2].planId]);
  assert.deepEqual(f.starts.map((message) => message.task.keyword), ["已完成", "筛选失败"]);
  completed(await f.call("mediaclaw_task_status", {taskId: result.structuredContent.result.results[0].taskId}));
});

test("concurrent batch confirmations consume all plans once and expose an async task handle", async (t) => {
  const f = await fixture(t);
  const plans = [];
  for (const keyword of ["甲", "乙"]) plans.push(await f.prepare("mediaclaw_capture_search_basic", {keyword, limit: 1}));
  const args = {planIds: plans.map((plan) => plan.planId), decision: "approve", async: true};
  const responses = await Promise.all([f.approve("mediaclaw_confirm_collection", args), f.approve("mediaclaw_confirm_collection", args)]);
  assert.equal(responses.filter((response) => response.structuredContent.ok).length, 1);
  failsWith(responses.find((response) => !response.structuredContent.ok), /COLLECTION_PLAN_ALREADY_USED|COLLECTION_APPROVAL_ALREADY_CLOSED/);
  const accepted = responses.find((response) => response.structuredContent.ok).structuredContent;
  assert.deepEqual(accepted.planIds, args.planIds);
  const result = await waitUntil(async () => {
    const state = await f.call("mediaclaw_task_status", {taskId: accepted.taskId});
    return state.structuredContent.task.status === "completed" ? state : null;
  }, "Confirmed batch did not complete");
  completed(result);
  assert.deepEqual(f.starts.map((message) => message.task.keyword), ["甲", "乙"]);
});

test("cancelling an approved batch stops its current child and never starts the next group", async (t) => {
  const f = await fixture(t, {responseDelayMs: () => 250});
  const plans = [];
  for (const keyword of ["当前组", "后续组"]) plans.push(await f.prepare("mediaclaw_capture_search_basic", {keyword, limit: 1}));
  const accepted = await f.approve("mediaclaw_confirm_collection", {planIds: plans.map((plan) => plan.planId), decision: "approve", async: true});
  const taskId = accepted.structuredContent.taskId;
  await waitUntil(() => f.starts.length === 1, "First group did not start");
  const cancelled = await f.call("mediaclaw_cancel_task", {taskId});
  assert.equal(cancelled.structuredContent.canceled, true, JSON.stringify(cancelled));
  await delay(300);
  const state = await f.call("mediaclaw_task_status", {taskId});
  assert.equal(state.structuredContent.task.status, "cancelled");
  assert.deepEqual(f.starts.map((message) => message.task.keyword), ["当前组"]);
  for (const plan of plans) failsWith(await f.confirm(plan.planId), /COLLECTION_PLAN_ALREADY_USED/);
  assert.deepEqual(f.starts.map((message) => message.task.keyword), ["当前组"]);
});

test("a plan belongs to its device and exact adapter instance", async (t) => {
  const f = await fixture(t);
  const plan = await f.prepare("mediaclaw_capture_search_basic", {keyword: "专属方案", limit: 1});
  const anotherInstance = await f.register("codex");
  const otherDevice = await f.register("workbuddy");
  assert.equal(anotherInstance.device.deviceId, f.owner.device.deviceId);
  assert.notEqual(otherDevice.device.deviceId, f.owner.device.deviceId);
  for (const identity of [anotherInstance, otherDevice]) {
    failsWith(await f.confirm(plan.planId, {}, identity), /COLLECTION_PLAN_OWNER_MISMATCH/);
    failsWith(await f.confirm(plan.planId, {decision: "reject"}, identity), /COLLECTION_PLAN_OWNER_MISMATCH/);
  }
  assert.equal(f.starts.length, 0);
  completed(await f.confirm(plan.planId));
  assert.equal(f.starts.length, 1);
});

test("confirmation cannot alter scope or smuggle flags, and validation errors do not consume approval", async (t) => {
  const f = await fixture(t);
  const plan = await f.prepare("mediaclaw_capture_search_basic", {keyword: "固定范围", timeRange: "7d", limit: 2});
  for (const extra of [
    {keyword: "另一个词"}, {limit: 300}, {timeRange: "6m"},
    {arguments: {limit: 300}}, {confirmed: true}, {collectionConsent: {planId: plan.planId}},
    {decision: "yes"}, {async: "true"},
  ]) {
    failsWith(await f.confirm(plan.planId, extra), /INVALID_COLLECTION_CONFIRMATION/);
  }
  assert.equal(f.starts.length, 0);
  completed(await f.confirm(plan.planId));
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].task.keyword, "固定范围");
  assert.equal(f.starts[0].task.limit, 2);
  assert.equal(f.starts[0].task.options.timeRange, "7d");
});

test("concurrent and repeated approvals consume one exact plan only once", async (t) => {
  const f = await fixture(t);
  const plan = await f.prepare("mediaclaw_enhance_records", {recordIds: ["record-a"], confirmed: true});
  const results = await Promise.all([f.confirm(plan.planId, {async: true}), f.confirm(plan.planId, {async: true})]);
  assert.equal(results.filter((item) => item.structuredContent.ok).length, 1);
  failsWith(results.find((item) => !item.structuredContent.ok), /COLLECTION_PLAN_ALREADY_USED|COLLECTION_APPROVAL_ALREADY_CLOSED/);
  await waitUntil(() => f.starts.length === 1, "Confirmed enhancement did not start");
  assert.deepEqual(f.starts[0].task.options.recordIds, ["record-a"]);
  assert.equal(f.starts[0].task.options.confirmation.confirmed, true);
  failsWith(await f.confirm(plan.planId), /COLLECTION_PLAN_ALREADY_USED/);
  await delay(20);
  assert.equal(f.starts.length, 1);
});

test("paid, outreach, read-only and arbitrary tools cannot be hidden inside a collection plan", async (t) => {
  const f = await fixture(t);
  for (const toolName of [
    "mediaclaw_quote_video_transcript", "mediaclaw_confirm_video_transcript",
    "mediaclaw_prepare_comment_outreach", "mediaclaw_get_comment_outreach_status",
    "mediaclaw_list_assets", "mediaclaw_confirm_clear_data", "arbitrary_tool",
  ]) {
    failsWith(await f.call("mediaclaw_prepare_collection", {
      userGoal: "未经授权的嵌套动作", toolName, arguments: {},
    }), /INVALID_COLLECTION_PLAN/);
  }
  failsWith(await f.call("mediaclaw_prepare_collection", {
    userGoal: "禁止嵌套执行", toolName: "mediaclaw_capture_search_basic",
    arguments: {keyword: "固定范围", confirmed: true},
  }), /INVALID_COLLECTION_PLAN/);
  assert.equal(f.starts.length, 0);
});

test("read-only assets, dataset queries and status retain their ungated path", async (t) => {
  const f = await fixture(t);
  const listing = await f.call("mediaclaw_list_assets", {source: "local.data_pool", type: "capture_record"});
  completed(listing);
  assert.notEqual(listing.structuredContent.status, "confirmation_required");
  const asset = await f.call("mediaclaw_get_asset", {assetId: "local.data_pool|capture_record|record-a"});
  completed(asset);
  const query = await f.call("mediaclaw_query_dataset", {datasetId: listing.structuredContent.task.taskId});
  assert.equal(query.structuredContent.ok, true, JSON.stringify(query));
  assert.notEqual(query.structuredContent.status, "confirmation_required");
  const status = await f.call("mediaclaw_task_status", {taskId: listing.structuredContent.task.taskId});
  completed(status);
  assert.equal(f.starts.length, 2);
  assert.ok(f.starts.every((message) => message.task.mode === "data_pool_assets"));
  const state = await f.persistedTasks();
  assert.ok(state.every((task) => task.collectionConsent === null));
});

test("generic confirmation accepts profile plans while profile rejection and replacement remain binding", async (t) => {
  const f = await fixture(t);
  const args = {
    userGoal: "先看账号清单方案",
    profileUrl: PROFILE_URL, purpose: "inventory_export", contentType: "all",
    coverage: "recent", maxItems: 2, requestedFields: ["title", "post_page_url"],
  };
  const rejected = pendingPlan(await f.call("mediaclaw_prepare_profile_collection", args));
  assert.equal((await f.call("mediaclaw_confirm_profile_collection", {planId: rejected.planId, decision: "reject"})).structuredContent.status, "rejected");
  failsWith(await f.confirm(rejected.planId), /COLLECTION_PLAN_REJECTED/);
  const original = pendingPlan(await f.call("mediaclaw_prepare_profile_collection", args));
  const revised = pendingPlan(await f.call("mediaclaw_prepare_profile_collection", {...args, maxItems: 3, replacesPlanId: original.planId}));
  failsWith(await f.confirm(original.planId), /COLLECTION_PLAN_REPLACED/);
  assert.equal(f.starts.length, 0);
  const accepted = await f.confirm(revised.planId, {async: true});
  assert.equal(accepted.structuredContent.ok, true, JSON.stringify(accepted));
  await waitUntil(() => f.starts.length > 0, "Approved profile plan did not execute");
  assert.ok(f.starts.every((message) => message.task.mode === "profile_posts"));
  failsWith(await f.confirm(revised.planId), /COLLECTION_PLAN_ALREADY_USED/);
});

test("confirmed single-note comments and OCR children share the original consent receipt", async (t) => {
  const f = await fixture(t, {respond(message) {
    if (message.task.mode === "current_note") return {captureResult: {
      recordIds: ["record-a"],
      records: [{recordType: "single_note", normalizedPayload: {
        noteId: "consent-fixture", title: "测试图文", url: NOTE_URL,
        content: "测试正文", noteType: "image", imageUrls: ["https://example.invalid/fixture.jpg"],
      }}],
    }};
    if (message.task.mode === "extract_image_text") return {rawCaptureResult: {
      ok: true, type: "image_text_extraction", data: {recordId: "record-a", text: "测试图片文字"},
    }};
    return {captureResult: {records: []}};
  }});
  const plan = await f.prepare("mediaclaw_research_single_note", {
    url: NOTE_URL, includeComments: true, commentLimit: 4, includeMediaText: true,
    analysisTranscriptDecision: "not_needed", analysisTranscriptReason: "仅分析图文",
  });
  assert.equal(f.starts.length, 0);
  const result = await f.confirm(plan.planId);
  completed(result);
  assert.deepEqual(f.starts.map((message) => message.task.mode), ["current_note", "comments", "extract_image_text"]);
  assert.equal(f.starts[1].task.limit, 4);
  const state = await waitUntil(async () => {
    const tasks = (await f.persistedTasks()).filter((task) => task.kind !== "confirmation");
    return tasks.length === 4 && tasks.every((task) => task.status === "succeeded") ? tasks : null;
  }, "Workflow and children did not persist their final state");
  for (const task of state) {
    assert.equal(task.collectionConsent.planId, plan.planId);
    assert.equal(task.collectionConsent.ownerDeviceId, f.owner.device.deviceId);
    assert.ok(task.collectionConsent.confirmedAt);
  }
  // A later detail-only plan cannot inherit the old plan's comments/OCR scope.
  const detailOnly = await f.prepare("mediaclaw_research_single_note", {
    url: NOTE_URL, includeComments: false, includeMediaText: false,
    analysisTranscriptDecision: "not_needed", analysisTranscriptReason: "已有评论与图片文字足够",
  });
  assert.equal(f.starts.length, 3);
  completed(await f.confirm(detailOnly.planId));
  assert.deepEqual(f.starts.slice(3).map((message) => message.task.mode), ["current_note"]);
});

test("capability discovery checks the connected plugin against actual Agent tools through a read-only query", async (t) => {
  const f = await fixture(t, {respond(message) {
    assert.equal(message.task.mode, "data_pool_query");
    assert.equal(message.task.options.operation, "capabilities");
    assert.deepEqual(message.task.resultSinks, ["local_agent"]);
    return {rawCaptureResult: {ok: true, data: {
      schemaVersion: 1, registryVersion: "0.3.2", extensionVersion: "0.3.2-local.1",
      capabilities: [
        {featureKey: "capture.search", status: "active", agentSupport: "direct", tools: ["mediaclaw_capture_search_basic"]},
        {featureKey: "sync.lark", status: "active", agentSupport: "plugin_only", tools: []},
        {featureKey: "future.capture", status: "active", agentSupport: "direct", tools: ["mediaclaw_future_tool"]},
        {featureKey: "future.scaffold", status: "scaffold", agentSupport: "direct", tools: ["mediaclaw_capture_note"]},
        {featureKey: "workflow.collection_plan", status: "active", agentSupport: "shared", tools: ["mediaclaw_prepare_collection", "mediaclaw_confirm_collection"]},
        {featureKey: "agent.update", status: "active", agentSupport: "direct", tools: ["mediaclaw_manage_agent_update"]},
      ],
    }}};
  }});
  const result = completed(await f.call("mediaclaw_get_capabilities")).result;
  assert.equal(result.extensionVersion, "0.3.2-local.1");
  assert.equal(result.registryVersion, "0.3.2");
  assert.equal(result.agentVersion, MCP_CONTRACT.serverVersion);
  assert.deepEqual(result.capabilities.map((item) => item.availableToAgent), [true, false, false, false, true, true]);
  assert.deepEqual(result.capabilities[2].missingAgentTools, ["mediaclaw_future_tool"]);
  assert.equal(f.starts.length, 1);
});

test("an older plugin cannot turn capability discovery into collection or a guessed capability list", async (t) => {
  const f = await fixture(t, {respond() {
    return {rawCaptureResult: {ok: true, data: {operation: "query", records: []}}};
  }});
  const result = await f.call("mediaclaw_get_capabilities");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "CAPABILITY_DISCOVERY_UNSUPPORTED");
  assert.equal(result.structuredContent.result.capabilities, undefined);
  assert.deepEqual(f.starts.map(({task}) => task.mode), ["data_pool_query"]);
});

test("cleanup previews and confirmations preserve full scope and never write their result back into the data pool", async (t) => {
  const f = await fixture(t, {respond(message) {
    assert.equal(message.task.mode, "data_pool_maintenance");
    assert.equal(message.task.featureKey, "asset.data_pool");
    assert.deepEqual(message.task.resultSinks, ["local_agent"]);
    const preview = message.task.options.action === "preview_clear";
    return {rawCaptureResult: {ok: true, data: preview ? {
      ok: true, action: "preview", scope: "local_data_and_execution_cache", scopeVersion: 3,
      requiresConfirmation: true, confirmationToken: "fixture-clear-token", recordCount: 2,
      clears: ["data_pool", "sync_history", "diagnostics", "monitor_execution_cache", "finished_outreach_history"],
      preserves: ["auth", "studio", "monitor_settings_and_backend_history", "outreach_settings_and_delivery_ledger"],
      monitorExecutionCacheCount: 3, finishedOutreachPlanCount: 4,
      estimatedReleaseScope: "data_pool_only",
    } : {
      ok: false, error: {code: "CLEAR_PREVIEW_STALE", message: "数据变化，请重新确认"},
    }}};
  }});
  const preview = completed(await f.call("mediaclaw_preview_clear_data")).result;
  assert.equal(preview.confirmationToken, "fixture-clear-token");
  assert.equal(preview.scopeVersion, 3);
  assert.equal(preview.scope, "local_data_and_execution_cache");
  assert.deepEqual(preview.clears, ["data_pool", "sync_history", "diagnostics", "monitor_execution_cache", "finished_outreach_history"]);
  assert.equal(preview.monitorExecutionCacheCount, 3);
  assert.equal(preview.finishedOutreachPlanCount, 4);
  assert.ok(preview.preserves.includes("monitor_settings_and_backend_history"));
  assert.ok(preview.preserves.includes("outreach_settings_and_delivery_ledger"));
  assert.equal(f.starts.length, 1, "preview cannot confirm itself");
  const stale = await f.call("mediaclaw_confirm_clear_data", {confirmationToken: preview.confirmationToken});
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, "CLEAR_PREVIEW_STALE");
  assert.equal(f.starts[1].task.options.confirmationToken, preview.confirmationToken);
});
