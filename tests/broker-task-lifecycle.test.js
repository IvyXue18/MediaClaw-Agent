import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";

function waitForText(stream, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}; output=${output}`));
    }, timeoutMs);
    function onData(chunk) {
      output += chunk.toString("utf8");
      if (!pattern.test(output)) return;
      cleanup();
      resolve(output);
    }
    function cleanup() {
      clearTimeout(timer);
      stream.off("data", onData);
    }
    stream.on("data", onData);
  });
}

async function startBroker({
  port,
  stateDirectory,
  cancelTimeoutMs = 1_000,
  captureStartAckTimeoutMs = 45_000,
  watchdogIntervalMs = 5_000,
}) {
  const child = spawn(
    process.execPath,
    [path.resolve("plugins/mediaclaw/scripts/broker-server.mjs")],
    {
      env: {
        ...process.env,
        MEDIACLAW_AGENT_PORT: String(port),
        MEDIACLAW_AGENT_STATE_DIR: stateDirectory,
        MEDIACLAW_AGENT_CANCEL_TIMEOUT_MS: String(cancelTimeoutMs),
        MEDIACLAW_CAPTURE_START_ACK_TIMEOUT_MS: String(
          captureStartAckTimeoutMs,
        ),
        MEDIACLAW_TASK_WATCHDOG_INTERVAL_MS: String(watchdogIntervalMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForText(child.stderr, /shared Agent Broker listening/);
  return child;
}

test("an unacknowledged extension task expires and releases the next task", async (t) => {
  const port = 20500 + Math.floor(Math.random() * 400);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "mediaclaw-start-ack-"));
  const broker = await startBroker({
    port,
    stateDirectory,
    captureStartAckTimeoutMs: 100,
    watchdogIntervalMs: 20,
  });
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });
  const registration = await registerAdapter(port);
  const extension = await connectExtension(port, registration.device.deviceId);
  t.after(() => extension.socket.close());

  const first = await callTool(
    port,
    registration.token,
    "mediaclaw_capture_search_basic",
    {keyword: "启动不确认", limit: 1, async: true},
  );
  const firstTaskId = first.structuredContent.taskId;
  await extension.waitFor(
    (message) => message.type === "task.start" && message.taskId === firstTaskId,
  );

  const second = await callTool(
    port,
    registration.token,
    "mediaclaw_capture_search_basic",
    {keyword: "队列继续", limit: 1, async: true},
  );
  const secondTaskId = second.structuredContent.taskId;
  const secondStart = await extension.waitFor(
    (message) => message.type === "task.start" && message.taskId === secondTaskId,
    3_000,
  );

  const expired = await callTool(
    port,
    registration.token,
    "mediaclaw_task_status",
    {taskId: firstTaskId},
  );
  assert.equal(expired.structuredContent.task.status, "failed");
  assert.equal(
    expired.structuredContent.error.code,
    "EXTENSION_TASK_START_TIMEOUT",
  );
  assert.match(expired.structuredContent.task.statusMessage, /自动终止.*释放队列/);

  extension.socket.send(JSON.stringify({
    type: "task.progress",
    taskId: secondTaskId,
    deviceId: secondStart.deviceId,
    progress: {
      status: "running",
      stage: "capture",
      message: "第二个任务已开始",
      updatedAt: new Date().toISOString(),
    },
  }));
  extension.socket.send(JSON.stringify({
    type: "task.result",
    taskId: secondTaskId,
    deviceId: secondStart.deviceId,
    response: {ok: true, data: {records: []}},
  }));
});

test("a restored workflow and its unfinished child terminate instead of blocking the queue", async (t) => {
  const port = 20900 + Math.floor(Math.random() * 80);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "mediaclaw-workflow-restart-"));
  const statePath = path.join(stateDirectory, "tasks-v1.json");
  const now = new Date().toISOString();
  await writeFile(statePath, JSON.stringify({
    version: 1,
    tasks: [
      {
        taskId: "research-stale-workflow",
        kind: "workflow",
        status: "running",
        message: "正在补采作品详情",
        input: {},
        captureTask: null,
        owner: null,
        progress: {stage: "detail_enhancement", processedCount: 0, totalCount: 56},
        result: null,
        error: null,
        childTaskIds: ["capture-stale-workflow-child"],
        currentChildTaskId: "capture-stale-workflow-child",
        createdAt: now,
        queuedAt: now,
        startedAt: "",
        updatedAt: now,
        ttlMs: 24 * 60 * 60 * 1000,
      },
      {
        taskId: "capture-stale-workflow-child",
        kind: "capture",
        status: "running",
        message: "浏览器正在执行采集",
        input: {},
        captureTask: {mode: "enhance_records", options: {recordIds: ["record-1"]}},
        owner: null,
        progress: null,
        result: null,
        error: null,
        childTaskIds: [],
        currentChildTaskId: "",
        createdAt: now,
        queuedAt: now,
        startedAt: now,
        updatedAt: now,
        ttlMs: 24 * 60 * 60 * 1000,
      },
    ],
  }), "utf8");
  const broker = await startBroker({port, stateDirectory});
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });

  const deadline = Date.now() + 3_000;
  let state;
  do {
    state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.tasks?.every((task) => task.status === "failed")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  const workflow = state.tasks.find((task) => task.taskId === "research-stale-workflow");
  const child = state.tasks.find((task) => task.taskId === "capture-stale-workflow-child");
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.error.code, "ORCHESTRATION_RESTARTED");
  assert.equal(child.status, "failed");
  assert.equal(child.error.code, "ORCHESTRATION_CHILD_RELEASED");
});

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function post(port, pathName, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(payload),
  });
  return await response.json();
}

async function registerAdapter(port, {agentChannel = "release"} = {}) {
  const registration = await post(port, "/v1/adapters/register", {
    hostKey: "codex",
    displayName: "Lifecycle Test Agent",
    adapterVersion: "0.3.0-rc.2",
    agentChannel,
    instanceId: `adapter-${Date.now()}-${Math.random()}`,
  });
  assert.equal(registration.ok, true);
  return registration;
}

async function callTool(port, token, name, args = {}) {
  return await post(port, "/v1/mcp", {
    token,
    method: "tools/call",
    params: {name, arguments: args},
  });
}

async function connectExtension(
  port,
  deviceId,
  {extensionId = "test-extension", extensionVersion = "0.3.0"} = {},
) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  const messages = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
  const inbox = {
    socket,
    waitFor(predicate, timeoutMs = 5_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {predicate, resolve, timer: null};
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for extension message; seen=${messages.map((item) => item.type).join(",")}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
  socket.send(JSON.stringify({
    type: "extension.hello",
    protocolVersion: "3",
    deviceId,
    sessionId: `session-${deviceId}`,
    extensionId,
    extensionVersion,
  }));
  return inbox;
}

test("a competing extension cannot replace the authenticated extension", async (t) => {
  const port = 20980 + Math.floor(Math.random() * 80);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "mediaclaw-extension-selection-"),
  );
  const broker = await startBroker({port, stateDirectory});
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });
  const registration = await registerAdapter(port, {agentChannel: "local"});
  const selected = await connectExtension(port, registration.device.deviceId, {
    extensionId: "local-extension",
  });
  t.after(() => selected.socket.close());

  const connected = await callTool(
    port,
    registration.token,
    "mediaclaw_connection_status",
  );
  assert.equal(connected.structuredContent.connected, true);
  assert.equal(
    connected.structuredContent.extension.extensionId,
    "local-extension",
  );

  const competing = await connectExtension(port, registration.device.deviceId, {
    extensionId: "ihclbgfnkclacfkbedkdnbpmkcdaccje",
  });
  t.after(() => competing.socket.close());
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stable = await callTool(
    port,
    registration.token,
    "mediaclaw_connection_status",
  );
  assert.equal(stable.structuredContent.connected, true);
  assert.equal(stable.structuredContent.awaitingPairing, false);
  assert.equal(
    stable.structuredContent.extension.extensionId,
    "local-extension",
  );
});

test("a local Agent candidate never reports the official store extension as connected", async (t) => {
  const port = 20900 + Math.floor(Math.random() * 80);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "mediaclaw-local-extension-selection-"),
  );
  const broker = await startBroker({port, stateDirectory});
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });
  const registration = await registerAdapter(port, {agentChannel: "local"});
  const official = await connectExtension(port, registration.device.deviceId, {
    extensionId: "ihclbgfnkclacfkbedkdnbpmkcdaccje",
  });
  t.after(() => official.socket.close());
  await new Promise((resolve) => setTimeout(resolve, 50));

  const beforeLocal = await callTool(
    port,
    registration.token,
    "mediaclaw_connection_status",
  );
  assert.equal(beforeLocal.structuredContent.connected, false);
  assert.equal(beforeLocal.structuredContent.extension, null);

  const local = await connectExtension(port, registration.device.deviceId, {
    extensionId: "local-extension",
  });
  t.after(() => local.socket.close());
  const afterLocal = await callTool(
    port,
    registration.token,
    "mediaclaw_connection_status",
  );
  assert.equal(afterLocal.structuredContent.connected, true);
  assert.equal(
    afterLocal.structuredContent.extension.extensionId,
    "local-extension",
  );
});

test("switching an Adapter to the local channel evicts an active store extension", async (t) => {
  const port = 20820 + Math.floor(Math.random() * 80);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "mediaclaw-local-channel-transition-"),
  );
  const broker = await startBroker({port, stateDirectory});
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });
  const releaseRegistration = await registerAdapter(port);
  const official = await connectExtension(
    port,
    releaseRegistration.device.deviceId,
    {extensionId: "ihclbgfnkclacfkbedkdnbpmkcdaccje"},
  );
  t.after(() => official.socket.close());
  const releaseStatus = await callTool(
    port,
    releaseRegistration.token,
    "mediaclaw_connection_status",
  );
  assert.equal(releaseStatus.structuredContent.connected, true);

  const localRegistration = await registerAdapter(port, {
    agentChannel: "local",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const transitioned = await callTool(
    port,
    localRegistration.token,
    "mediaclaw_connection_status",
  );
  assert.equal(transitioned.structuredContent.connected, false);
  assert.equal(transitioned.structuredContent.extension, null);

  const local = await connectExtension(port, localRegistration.device.deviceId, {
    extensionId: "local-extension",
  });
  t.after(() => local.socket.close());
  const localStatus = await callTool(
    port,
    localRegistration.token,
    "mediaclaw_connection_status",
  );
  assert.equal(localStatus.structuredContent.connected, true);
  assert.equal(
    localStatus.structuredContent.extension.extensionId,
    "local-extension",
  );
});

test("running cancellation stays working until the browser confirms success", async (t) => {
  const port = 21000 + Math.floor(Math.random() * 1000);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "mediaclaw-cancel-"));
  let broker = await startBroker({port, stateDirectory});
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });
  const registration = await registerAdapter(port);
  const extension = await connectExtension(port, registration.device.deviceId);
  t.after(() => extension.socket.close());

  const started = await callTool(
    port,
    registration.token,
    "mediaclaw_capture_search_basic",
    {keyword: "取消确认", limit: 2, async: true},
  );
  const taskId = started.structuredContent.taskId;
  await extension.waitFor((message) => message.type === "task.start" && message.taskId === taskId);

  const cancelRequest = callTool(
    port,
    registration.token,
    "mediaclaw_cancel_task",
    {taskId},
  );
  const cancelMessage = await extension.waitFor(
    (message) => message.type === "task.cancel" && message.taskId === taskId,
  );
  const pending = await callTool(
    port,
    registration.token,
    "mediaclaw_task_status",
    {taskId},
  );
  assert.equal(pending.structuredContent.task.status, "working");
  assert.match(pending.structuredContent.task.statusMessage, /等待浏览器确认取消/);

  extension.socket.send(JSON.stringify({
    type: "task.cancel.result",
    taskId,
    deviceId: cancelMessage.deviceId,
    response: {ok: true, canceled: true},
  }));
  const cancelled = await cancelRequest;
  assert.equal(cancelled.structuredContent.canceled, true);
  assert.equal(cancelled.structuredContent.task.status, "cancelled");
});

test("cancel rejection and timeout never create a false cancelled terminal state", async (t) => {
  const port = 22000 + Math.floor(Math.random() * 1000);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "mediaclaw-cancel-fail-"));
  let broker = await startBroker({port, stateDirectory, cancelTimeoutMs: 100});
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });
  const registration = await registerAdapter(port);
  const extension = await connectExtension(port, registration.device.deviceId);
  t.after(() => extension.socket.close());

  async function start(keyword) {
    const response = await callTool(
      port,
      registration.token,
      "mediaclaw_capture_search_basic",
      {keyword, limit: 1, async: true},
    );
    const taskId = response.structuredContent.taskId;
    await extension.waitFor((message) => message.type === "task.start" && message.taskId === taskId);
    return taskId;
  }

  const rejectedTaskId = await start("拒绝取消");
  const rejectedRequest = callTool(port, registration.token, "mediaclaw_cancel_task", {taskId: rejectedTaskId});
  const rejectedMessage = await extension.waitFor(
    (message) => message.type === "task.cancel" && message.taskId === rejectedTaskId,
  );
  extension.socket.send(JSON.stringify({
    type: "task.cancel.result",
    taskId: rejectedTaskId,
    deviceId: rejectedMessage.deviceId,
    response: {ok: false, canceled: false, reason: "capture_tab_not_found"},
  }));
  const rejected = await rejectedRequest;
  assert.equal(rejected.structuredContent.error.code, "CANCEL_REJECTED");
  assert.equal(rejected.structuredContent.task.status, "working");
  extension.socket.send(JSON.stringify({
    type: "task.result",
    taskId: rejectedTaskId,
    deviceId: rejectedMessage.deviceId,
    response: {ok: true, data: {records: []}},
  }));

  const timeoutTaskId = await start("取消超时");
  const timedOut = await callTool(port, registration.token, "mediaclaw_cancel_task", {taskId: timeoutTaskId});
  assert.equal(timedOut.structuredContent.error.code, "CANCEL_TIMEOUT");
  assert.equal(timedOut.structuredContent.task.status, "working");
});

test("an in-flight task survives a Broker process restart and resumes with the same task id", async (t) => {
  const port = 23000 + Math.floor(Math.random() * 1000);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "mediaclaw-task-recovery-"));
  let broker = await startBroker({port, stateDirectory});
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });
  const firstRegistration = await registerAdapter(port);
  const firstExtension = await connectExtension(port, firstRegistration.device.deviceId);
  const started = await callTool(
    port,
    firstRegistration.token,
    "mediaclaw_capture_search_basic",
    {keyword: "进程恢复", idempotencyKey: "restart-once", async: true},
  );
  const taskId = started.structuredContent.taskId;
  await firstExtension.waitFor((message) => message.type === "task.start" && message.taskId === taskId);

  firstExtension.socket.close();
  await stopChild(broker);
  broker = await startBroker({port, stateDirectory});
  const secondRegistration = await registerAdapter(port);
  assert.equal(secondRegistration.device.deviceId, firstRegistration.device.deviceId);

  const restoredBeforeReconnect = await callTool(
    port,
    secondRegistration.token,
    "mediaclaw_task_status",
    {taskId},
  );
  assert.equal(restoredBeforeReconnect.structuredContent.task.status, "working");
  assert.match(restoredBeforeReconnect.structuredContent.task.statusMessage, /持久状态恢复/);

  const secondExtension = await connectExtension(port, secondRegistration.device.deviceId);
  t.after(() => secondExtension.socket.close());
  const resumed = await secondExtension.waitFor(
    (message) => message.type === "task.start" && message.taskId === taskId,
  );
  secondExtension.socket.send(JSON.stringify({
    type: "task.result",
    taskId,
    deviceId: resumed.deviceId,
    task: resumed.task,
    response: {ok: true, data: {records: [{basic: {noteId: "one", title: "只完成一次"}}]}},
  }));

  const deadline = Date.now() + 3_000;
  let completed;
  do {
    completed = await callTool(port, secondRegistration.token, "mediaclaw_task_status", {taskId});
    if (completed.structuredContent.task.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(completed.structuredContent.task.status, "completed");
  assert.equal(completed.structuredContent.result.records.length, 1);

  const idempotent = await callTool(
    port,
    secondRegistration.token,
    "mediaclaw_capture_search_basic",
    {keyword: "进程恢复", idempotencyKey: "restart-once", async: true},
  );
  assert.equal(idempotent.structuredContent.taskId, taskId);
});

test("a restored in-flight task is never reported cancelled without browser confirmation", async (t) => {
  const port = 24000 + Math.floor(Math.random() * 1000);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "mediaclaw-restart-cancel-"));
  let broker = await startBroker({port, stateDirectory});
  t.after(async () => {
    await stopChild(broker);
    await rm(stateDirectory, {recursive: true, force: true});
  });
  const firstRegistration = await registerAdapter(port);
  const firstExtension = await connectExtension(port, firstRegistration.device.deviceId);
  const started = await callTool(
    port,
    firstRegistration.token,
    "mediaclaw_capture_search_basic",
    {keyword: "恢复后取消", idempotencyKey: "restart-cancel", async: true},
  );
  const taskId = started.structuredContent.taskId;
  await firstExtension.waitFor(
    (message) => message.type === "task.start" && message.taskId === taskId,
  );

  firstExtension.socket.close();
  await stopChild(broker);
  broker = await startBroker({port, stateDirectory});
  const secondRegistration = await registerAdapter(port);

  const disconnectedCancel = await callTool(
    port,
    secondRegistration.token,
    "mediaclaw_cancel_task",
    {taskId},
  );
  assert.equal(
    disconnectedCancel.structuredContent.error.code,
    "EXTENSION_DISCONNECTED",
  );
  assert.equal(disconnectedCancel.structuredContent.task.status, "working");

  const secondExtension = await connectExtension(
    port,
    secondRegistration.device.deviceId,
  );
  t.after(() => secondExtension.socket.close());
  await secondExtension.waitFor(
    (message) => message.type === "task.start" && message.taskId === taskId,
  );
  const cancelRequest = callTool(
    port,
    secondRegistration.token,
    "mediaclaw_cancel_task",
    {taskId},
  );
  const cancelMessage = await secondExtension.waitFor(
    (message) => message.type === "task.cancel" && message.taskId === taskId,
  );
  secondExtension.socket.send(JSON.stringify({
    type: "task.cancel.result",
    taskId,
    deviceId: cancelMessage.deviceId,
    response: {ok: true, canceled: true},
  }));
  const cancelled = await cancelRequest;
  assert.equal(cancelled.structuredContent.canceled, true);
  assert.equal(cancelled.structuredContent.task.status, "cancelled");
});
