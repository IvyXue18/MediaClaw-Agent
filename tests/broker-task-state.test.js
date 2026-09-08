import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskStateWriter,
  findBlockingTaskParent,
  pruneTaskHistory,
} from "../plugins/mediaclaw/scripts/broker-task-state.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-08T12:00:00Z");

function task(taskId, {age = 2 * DAY, ...options} = {}) {
  return {taskId, kind: "capture", status: "succeeded", updatedAt: new Date(NOW - age).toISOString(),
    ttlMs: DAY, childTaskIds: [], idempotencyKey: `device:${taskId}`, result: {records: [{id: taskId}]}, ...options};
}

test("retention expires only terminal tasks and clears only their matching idempotency entries", () => {
  const rows = [
    ...["queued", "running", "waiting_for_extension", "cancel_pending"].map((status) => task(status, {status, age: 20 * DAY})),
    ...["succeeded", "failed", "cancelled", "input_required"].map((status) => task(`old-${status}`, {status})),
    task("fresh", {age: DAY - 1}), task("boundary", {age: DAY}),
    task("archive", {age: 6 * DAY, ttlMs: 7 * DAY}),
    task("old-archive", {age: 7 * DAY, ttlMs: 7 * DAY}),
    task("result-transfer"),
  ];
  const tasks = new Map(rows.map((row) => [row.taskId, row]));
  const idempotentTaskIds = new Map(rows.map((row) => [row.idempotencyKey, row.taskId]));
  idempotentTaskIds.set("device:old-failed", "replacement-task");
  const removed = pruneTaskHistory({tasks, idempotentTaskIds, nowMs: NOW, protectedTaskIds: ["result-transfer"]});
  assert.deepEqual(removed.sort(), ["old-succeeded", "old-failed", "old-cancelled", "old-input_required", "boundary", "old-archive"].sort());
  assert.equal(idempotentTaskIds.has("device:old-succeeded"), false);
  assert.equal(idempotentTaskIds.get("device:old-failed"), "replacement-task");
  assert.ok(tasks.has("archive"));
  assert.ok(tasks.has("result-transfer"));
  for (const status of ["queued", "running", "waiting_for_extension", "cancel_pending"]) assert.ok(tasks.has(status));
});

test("retained workflows preserve completed descendant results and live children preserve their parents", () => {
  const rows = [
    task("parent", {kind: "workflow", age: 100, childTaskIds: ["nested"]}),
    task("nested", {kind: "workflow", childTaskIds: ["leaf"]}),
    task("leaf"),
    task("old-parent", {kind: "batch", childTaskIds: ["live-child"]}),
    task("live-child", {status: "running"}),
    task("cycle-a", {kind: "batch", childTaskIds: ["cycle-b"]}),
    task("cycle-b", {kind: "workflow", childTaskIds: ["cycle-a"]}),
  ];
  const tasks = new Map(rows.map((row) => [row.taskId, row]));
  const idempotentTaskIds = new Map(rows.map((row) => [row.idempotencyKey, row.taskId]));
  assert.deepEqual(pruneTaskHistory({tasks, idempotentTaskIds, nowMs: NOW}), ["cycle-a", "cycle-b"]);
  assert.deepEqual(tasks.get("leaf").result, {records: [{id: "leaf"}]});
  tasks.get("live-child").status = "succeeded";
  assert.deepEqual(pruneTaskHistory({tasks, idempotentTaskIds, nowMs: NOW + DAY}).sort(), ["parent", "nested", "leaf", "old-parent", "live-child"].sort());
  assert.equal(tasks.size, 0);
  assert.equal(idempotentTaskIds.size, 0);
});

test("dispatch detects stopped ancestors, including nested workflows and cancellation in progress", () => {
  for (const status of ["succeeded", "failed", "cancelled", "input_required", "cancel_pending"]) {
    const parent = task("parent", {kind: "workflow", status, childTaskIds: ["nested"]});
    const nested = task("nested", {kind: "batch", status: "running", currentChildTaskId: "child"});
    const tasks = new Map([["parent", parent], ["nested", nested], ["child", task("child", {status: "queued"})]]);
    assert.equal(findBlockingTaskParent(tasks, "child"), parent, status);
    parent.status = "running";
    assert.equal(findBlockingTaskParent(tasks, "child"), null);
  }
});

test("progress bursts are serialized once at flush, using the latest state", async () => {
  let progress = 0;
  let reads = 0;
  const writes = [];
  const writer = createTaskStateWriter({
    delayMs: 60_000,
    readSnapshot: () => { reads += 1; return JSON.stringify({progress}); },
    writeSnapshot: async (snapshot) => { writes.push(snapshot); },
  });
  const pending = [];
  for (progress = 1; progress <= 500; progress += 1) pending.push(writer.schedule());
  assert.equal(reads, 0);
  assert.equal(new Set(pending).size, 1);
  await writer.flush();
  assert.ok((await Promise.all(pending)).every(Boolean));
  assert.equal(reads, 1);
  assert.deepEqual(writes, [JSON.stringify({progress: 501})]);
  await writer.flush();
  assert.equal(writes.length, 1);
});

test("updates during slow I/O produce one newest follow-up snapshot and flush waits for it", async () => {
  let progress = 0;
  let releaseFirst;
  let releaseSecond;
  const writes = [];
  const writer = createTaskStateWriter({
    readSnapshot: () => progress,
    writeSnapshot: async (snapshot) => {
      writes.push(snapshot);
      await new Promise((resolve) => { if (writes.length === 1) releaseFirst = resolve; else releaseSecond = resolve; });
    },
  });
  void writer.schedule();
  const flushed = writer.flush();
  for (progress = 1; progress <= 500; progress += 1) void writer.schedule();
  assert.deepEqual(writes, [0]);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [0, 501]);
  let completed = false;
  void flushed.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  releaseSecond();
  assert.equal(await flushed, true);
});

test("failed snapshots remain dirty and explicit flush retries the latest state", async () => {
  let value = "first";
  let fail = true;
  const errors = [];
  const writes = [];
  const writer = createTaskStateWriter({
    readSnapshot: () => value,
    writeSnapshot: async (snapshot) => { if (fail) throw new Error("disk unavailable"); writes.push(snapshot); },
    onError: (error) => errors.push(error.message),
  });
  const scheduled = writer.schedule();
  assert.equal(await writer.flush(), false);
  assert.equal(await scheduled, false);
  assert.deepEqual(errors, ["disk unavailable"]);
  fail = false;
  value = "latest";
  assert.equal(await writer.flush(), true);
  assert.deepEqual(writes, ["latest"]);
});
