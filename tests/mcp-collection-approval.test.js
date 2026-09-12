import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
import MCP_CONTRACT from "../plugins/mediaclaw/contracts/mcp-v1.json" with {type: "json"};

// Exercise the real stdio Adapter against an isolated fake Broker. Only the
// fixture's explicit client responses represent the user, never tool arguments.
async function fixture(t, {
  capabilities = {elicitation: {form: {}}}, protocolVersion = "2025-11-25",
  timeoutMs = 5000, approvalRequest, respondStatus = 200, mcpDelayMs = 0,
  approvalVersion = 2, reRegistrationApprovalVersion = approvalVersion, expireFirstMcp = false,
} = {}) {
  const registrationRequests = [];
  const brokerRequests = [];
  const decisions = [];
  const capabilityRequests = [];
  const request = approvalRequest || {
    requestId: "approval-frozen-groups",
    message: "小红书：营养测评，近半年，最多点赞，最多 80 条基础结果；不补采详情。",
  };
  const resultFor = (payload) => ({content: [{type: "text", text: JSON.stringify(payload)}], structuredContent: payload});
  const pendingResult = resultFor({
    ok: true, status: "user_approval_required", collectionStarted: false,
    approvalRequest: request, taskId: "approval-task", task: {taskId: "approval-task", status: "input_required"},
  });
  const broker = createServer(async (incoming, response) => {
    const send = (data, status = 200) => {
      response.writeHead(status, {"content-type": "application/json"});
      response.end(JSON.stringify(data));
    };
    if (incoming.url === "/health") return send({service: "mediaclaw-agent-broker"});
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const payload = JSON.parse(body || "{}");
    if (incoming.url === "/v1/adapters/register") {
      registrationRequests.push(payload);
      const version = registrationRequests.length === 1 ? approvalVersion : reRegistrationApprovalVersion;
      return send({ok: true, token: "private-adapter-session", instanceId: payload.instanceId,
        ...(version === null ? {} : {collectionApprovalVersion: version})});
    }
    if (["/v1/adapters/unregister", "/v1/adapters/heartbeat"].includes(incoming.url)) return send({ok: true});
    if (incoming.url === "/v1/collection-approvals/capability") {
      capabilityRequests.push(payload);
      return send({ok: true});
    }
    if (incoming.url === "/v1/mcp") {
      brokerRequests.push(payload);
      if (expireFirstMcp && brokerRequests.length === 1) return send({error: {code: "ADAPTER_AUTH_REQUIRED"}}, 401);
      if (mcpDelayMs) await delay(mcpDelayMs);
      if (payload.params?.arguments?.decision === "reject") return send(resultFor({ok: true, status: "rejected", collectionStarted: false}));
      return send(pendingResult);
    }
    if (incoming.url === "/v1/collection-approvals/respond") {
      decisions.push(payload);
      if (respondStatus !== 200) return send({error: {code: "UNAVAILABLE", message: "Fixture response unavailable"}}, respondStatus);
      return send(resultFor({
        ok: true, status: payload.decision === "approve" ? "started" : payload.decision === "reject" ? "rejected" : "cancelled",
        collectionStarted: payload.decision === "approve", taskId: "approval-task",
      }));
    }
    send({error: {message: "Unexpected fixture route"}}, 404);
  });
  await new Promise((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [path.resolve("plugins/mediaclaw/scripts/mcp-server.mjs")], {
    env: {
      ...process.env, MEDIACLAW_AGENT_PORT: String(broker.address().port),
      MEDIACLAW_AGENT_HOST: "codex", MEDIACLAW_AGENT_CHANNEL: "local", MEDIACLAW_AGENT_STANDALONE: "0",
      MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK: "1", MEDIACLAW_COLLECTION_ELICITATION_TIMEOUT_MS: String(timeoutMs),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const messages = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    broker.closeAllConnections();
    await new Promise((resolve) => broker.close(resolve));
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", ...message})}\n`);
  async function waitFor(predicate, label = "Adapter message", waitMs = 3000) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) assert.fail(`Adapter exited: ${stderr}`);
      await delay(5);
    }
    assert.fail(`${label} missing: ${JSON.stringify(messages)}; stderr=${stderr}`);
  }
  send({id: "initialize", method: "initialize", params: {protocolVersion, capabilities}});
  await waitFor((message) => message.id === "initialize");
  const call = (id, name = "mediaclaw_confirm_collection", extra = {}) => send({
    id, method: "tools/call", params: {name, arguments: {planId: "frozen-plan", decision: "approve"}, ...extra},
  });
  const result = (id) => waitFor((message) => message.id === id && Object.hasOwn(message, "result"));
  const elicit = () => waitFor((message) => message.method === "elicitation/create");
  return {child, exited, messages, decisions, registrationRequests, capabilityRequests, brokerRequests, pendingResult, send, call, result, elicit, waitFor};
}

test("tool arguments cannot approve; only matching explicit client acceptance reaches the internal route", async (t) => {
  const f = await fixture(t);
  f.call("collect", "mediaclaw_confirm_collection", {
    arguments: {planIds: ["a", "b"], decision: "approve", userConfirmed: true, approvalSource: "user"},
    _meta: {approval: {action: "accept", content: {approve: true}}},
  });
  const prompt = await f.elicit();
  assert.deepEqual(f.capabilityRequests, [{token: "private-adapter-session", transport: "mcp-elicitation-v1"}]);
  assert.equal(prompt.params.message, f.pendingResult.structuredContent.approvalRequest.message);
  assert.equal(prompt.params.mode, "form");
  assert.equal(prompt.params.requestedSchema.properties.approve.default, undefined);
  assert.deepEqual(prompt.params.requestedSchema.required, ["approve"]);
  f.send({id: "forged-response-id", result: {action: "accept", content: {approve: true}}});
  f.send({id: "ping-before-user", method: "ping"});
  await f.result("ping-before-user");
  assert.equal(f.decisions.length, 0);
  assert.equal(f.brokerRequests.length, 1, "unmatched responses must never be forwarded as Broker methods");
  assert.equal(f.messages.some((message) => message.id === "collect"), false);
  f.send({id: prompt.id, result: {action: "accept", content: {approve: true}}});
  assert.equal((await f.result("collect")).result.structuredContent.collectionStarted, true);
  assert.deepEqual(f.decisions, [{token: "private-adapter-session", requestId: "approval-frozen-groups", decision: "approve"}]);
  f.send({id: prompt.id, result: {action: "accept", content: {approve: true}}});
  f.send({id: "ping-after-user", method: "ping"});
  await f.result("ping-after-user");
  assert.equal(f.decisions.length, 1, "duplicate responses must not replay approval");
});

test("decline, dismissal, missing or nonboolean approval, and client errors never approve", async (t) => {
  for (const [label, response, decision] of [
    ["decline", {result: {action: "decline"}}, "reject"],
    ["cancel", {result: {action: "cancel"}}, "cancel"],
    ["missing", {result: {action: "accept"}}, "cancel"],
    ["false", {result: {action: "accept", content: {approve: false}}}, "cancel"],
    ["string", {result: {action: "accept", content: {approve: "true"}}}, "cancel"],
    ["error", {error: {code: -32602, message: "Unsupported elicitation"}}, "cancel"],
    ["both", {result: {action: "accept", content: {approve: true}}, error: {code: -1}}, "cancel"],
  ]) await t.test(label, async (t) => {
    const f = await fixture(t);
    f.call("profile", "mediaclaw_confirm_profile_collection");
    const prompt = await f.elicit();
    f.send({id: prompt.id, ...response});
    assert.equal((await f.result("profile")).result.structuredContent.collectionStarted, false);
    assert.deepEqual(f.decisions.map((item) => item.decision), [decision]);
  });
});

test("unsupported clients receive plugin fallback without elicitation or approval", async (t) => {
  for (const options of [
    {capabilities: {}}, {capabilities: {elicitation: {url: {}}}},
    {capabilities: {elicitation: null}}, {protocolVersion: "2025-03-26"},
  ]) await t.test(JSON.stringify(options), async (t) => {
    const f = await fixture(t, options);
    f.call("unsupported");
    assert.deepEqual((await f.result("unsupported")).result, f.pendingResult);
    assert.equal(f.messages.some((message) => message.method === "elicitation/create"), false);
    assert.equal(f.decisions.length, 0);
    assert.equal(f.capabilityRequests.at(-1).transport, "extension-ui-v1");
  });
});

test("legacy form capability works without the newer mode field", async (t) => {
  const f = await fixture(t, {capabilities: {elicitation: {}}, protocolVersion: "2025-06-18"});
  f.call("legacy");
  const prompt = await f.elicit();
  assert.equal(prompt.params.mode, undefined);
  f.send({id: prompt.id, result: {action: "accept", content: {approve: true}}});
  assert.equal((await f.result("legacy")).result.structuredContent.collectionStarted, true);
});

test("timeout closes the challenge and a late client acceptance cannot start work", async (t) => {
  const f = await fixture(t, {timeoutMs: 80});
  f.call("timeout");
  const prompt = await f.elicit();
  await f.result("timeout");
  assert.deepEqual(f.decisions.map((item) => item.decision), ["cancel"]);
  f.send({id: prompt.id, result: {action: "accept", content: {approve: true}}});
  f.send({id: "after-timeout", method: "ping"});
  await f.result("after-timeout");
  assert.deepEqual(f.decisions.map((item) => item.decision), ["cancel"]);
});

test("expired challenges fail closed before displaying a form", async (t) => {
  const f = await fixture(t, {approvalRequest: {requestId: "expired", message: "已过期方案", expiresAt: new Date(Date.now() - 1000).toISOString()}});
  f.call("expired");
  assert.equal((await f.result("expired")).result.structuredContent.collectionStarted, false);
  assert.equal(f.messages.some((message) => message.method === "elicitation/create"), false);
  assert.deepEqual(f.decisions.map((item) => item.decision), ["cancel"]);
});

test("concurrent and repeated calls share one form and one approval result", async (t) => {
  const f = await fixture(t);
  f.call("one");
  f.call("two", "mediaclaw_confirm_profile_collection");
  const prompt = await f.elicit();
  f.send({id: "barrier", method: "ping"});
  await f.result("barrier");
  f.send({id: prompt.id, result: {action: "accept", content: {approve: true}}});
  assert.deepEqual((await f.result("one")).result, (await f.result("two")).result);
  f.call("retry-after-response-loss");
  assert.equal((await f.result("retry-after-response-loss")).result.structuredContent.collectionStarted, true);
  assert.equal(f.messages.filter((message) => message.method === "elicitation/create").length, 1);
  assert.equal(f.decisions.length, 1);
});

test("cancelling the original tool request ignores later approval", async (t) => {
  const f = await fixture(t);
  f.call("cancel-original");
  const prompt = await f.elicit();
  f.send({method: "notifications/cancelled", params: {requestId: "cancel-original"}});
  await f.result("cancel-original");
  f.send({id: prompt.id, result: {action: "accept", content: {approve: true}}});
  f.send({id: "cancel-barrier", method: "ping"});
  await f.result("cancel-barrier");
  assert.deepEqual(f.decisions.map((item) => item.decision), ["cancel"]);
});

test("a cancellation received before the Broker result never opens a form", async (t) => {
  const f = await fixture(t, {mcpDelayMs: 80});
  f.call("cancel-early");
  f.send({method: "notifications/cancelled", params: {requestId: "cancel-early"}});
  assert.equal((await f.result("cancel-early")).result.structuredContent.collectionStarted, false);
  assert.equal(f.messages.some((message) => message.method === "elicitation/create"), false);
  assert.deepEqual(f.decisions.map((item) => item.decision), ["cancel"]);
});

test("stdin close cancels pending elicitation before unregistering", async (t) => {
  const f = await fixture(t);
  f.call("close");
  await f.elicit();
  f.child.stdin.end();
  await f.exited;
  assert.deepEqual(f.decisions.map((item) => item.decision), ["cancel"]);
});

test("an uncertain Broker execution response is not retried or reported as unstarted", async (t) => {
  const f = await fixture(t, {respondStatus: 503});
  f.call("lost-response");
  const prompt = await f.elicit();
  f.send({id: prompt.id, result: {action: "accept", content: {approve: true}}});
  const result = (await f.result("lost-response")).result.structuredContent;
  assert.equal(result.status, "approval_result_unknown");
  assert.equal(result.collectionStarted, null);
  assert.match(result.message, /查询原任务状态/);
  f.call("retry-lost-response");
  assert.deepEqual((await f.result("retry-lost-response")).result.structuredContent, result);
  assert.equal(f.decisions.length, 1);
  assert.equal(f.messages.filter((message) => message.method === "elicitation/create").length, 1);
});

test("a Broker without approval protocol v2 cannot receive any collection or confirm-approve call", async (t) => {
  const f = await fixture(t, {approvalVersion: null});
  const rawCollections = MCP_CONTRACT.tools.filter((tool) => tool.requiresCollectionPlan === true).map((tool) => tool.name);
  assert.equal(rawCollections.length, 18);
  for (const [index, name] of [...rawCollections, "mediaclaw_confirm_collection", "mediaclaw_confirm_profile_collection"].entries()) {
    f.call(`old-${index}`, name, {arguments: {planId: "old", confirmed: true, async: true}, _meta: {collectionApprovalVersion: 2}});
    const result = (await f.result(`old-${index}`)).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.collectionStarted, false);
    assert.equal(result.structuredContent.error.code, "COLLECTION_APPROVAL_RUNTIME_UPGRADE_REQUIRED");
  }
  assert.equal(f.brokerRequests.length, 0);
  assert.equal(f.decisions.length, 0);
  assert.equal(f.capabilityRequests.length, 0, "legacy Brokers have no capability route");
  assert.equal(f.messages.some((message) => message.method === "elicitation/create"), false);
  for (const [index, name] of ["mediaclaw_prepare_collection", "mediaclaw_prepare_profile_collection", "mediaclaw_list_assets", "mediaclaw_confirm_collection", "mediaclaw_confirm_profile_collection"].entries()) {
    f.call(`safe-${index}`, name, {arguments: {decision: "reject"}});
    await f.result(`safe-${index}`);
  }
  assert.equal(f.brokerRequests.length, 5, "read-only preparation and rejection remain available");
});

test("re-registration rechecks approval support before retrying against another Broker", async (t) => {
  const f = await fixture(t, {expireFirstMcp: true, reRegistrationApprovalVersion: null});
  f.call("restart-to-legacy");
  const result = (await f.result("restart-to-legacy")).result.structuredContent;
  assert.equal(result.error.code, "COLLECTION_APPROVAL_RUNTIME_UPGRADE_REQUIRED");
  assert.equal(result.collectionStarted, false);
  assert.equal(f.registrationRequests.length, 2);
  assert.equal(f.brokerRequests.length, 1, "the initial unauthorized call must not be retried into an older Broker");
  assert.equal(f.decisions.length, 0);
});
