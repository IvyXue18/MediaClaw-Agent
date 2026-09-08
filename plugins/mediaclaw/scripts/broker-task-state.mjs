// Broker task history and snapshot I/O have a lifecycle separate from browser
// execution. Keep active work and all results referenced by retained workflows.
export const TERMINAL_TASK_STATUSES = new Set([
  "succeeded", "failed", "cancelled", "input_required",
]);

export function findBlockingTaskParent(tasks, taskId) {
  const pending = [taskId];
  const visited = new Set(pending);
  for (let index = 0; index < pending.length; index += 1) {
    for (const parent of tasks.values()) {
      if (!["workflow", "batch"].includes(parent.kind) ||
          (!parent.childTaskIds?.includes(pending[index]) && parent.currentChildTaskId !== pending[index])) continue;
      if (TERMINAL_TASK_STATUSES.has(parent.status) || parent.status === "cancel_pending") return parent;
      if (visited.has(parent.taskId)) continue;
      visited.add(parent.taskId);
      pending.push(parent.taskId);
    }
  }
  return null;
}

export function pruneTaskHistory({
  tasks,
  idempotentTaskIds,
  nowMs = Date.now(),
  defaultTtlMs = 24 * 60 * 60 * 1000,
  protectedTaskIds = [],
}) {
  const links = new Map();
  const retained = new Set(protectedTaskIds);
  for (const task of tasks.values()) {
    const updatedAtMs = Date.parse(String(task.updatedAt || ""));
    const ttlMs = Math.max(defaultTtlMs, Number(task.ttlMs) || defaultTtlMs);
    if (!TERMINAL_TASK_STATUSES.has(task.status) ||
        !Number.isFinite(updatedAtMs) || nowMs - updatedAtMs < ttlMs) {
      retained.add(task.taskId);
    }
    for (const childId of [...(task.childTaskIds || []), task.currentChildTaskId]) {
      if (!childId || !tasks.has(childId)) continue;
      if (!links.has(task.taskId)) links.set(task.taskId, new Set());
      if (!links.has(childId)) links.set(childId, new Set());
      links.get(task.taskId).add(childId);
      links.get(childId).add(task.taskId);
    }
  }
  const pending = [...retained];
  for (let index = 0; index < pending.length; index += 1) {
    for (const linkedId of links.get(pending[index]) || []) {
      if (retained.has(linkedId)) continue;
      retained.add(linkedId);
      pending.push(linkedId);
    }
  }
  const removed = [];
  for (const [taskId, task] of tasks) {
    if (retained.has(taskId)) continue;
    tasks.delete(taskId);
    if (idempotentTaskIds.get(task.idempotencyKey) === taskId) {
      idempotentTaskIds.delete(task.idempotencyKey);
    }
    removed.push(taskId);
  }
  return removed;
}

export function createTaskStateWriter({
  readSnapshot,
  writeSnapshot,
  onError = () => {},
  delayMs = 25,
}) {
  let dirty = false;
  let timer = null;
  let inFlight = null;
  let scheduled = null;

  function schedule() {
    dirty = true;
    if (inFlight) return inFlight;
    if (!scheduled) {
      let resolve;
      const promise = new Promise((settle) => { resolve = settle; });
      scheduled = {promise, resolve};
      timer = setTimeout(() => { void flush(); }, delayMs);
    }
    return scheduled.promise;
  }

  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (inFlight) return inFlight;
    if (!dirty) return Promise.resolve(true);
    const waiting = scheduled;
    scheduled = null;
    // Serialize only when writing, retaining at most the in-flight snapshot.
    // Any burst arriving during I/O becomes one fresh snapshot on the next loop.
    inFlight = (async () => {
      try {
        while (dirty) {
          dirty = false;
          await writeSnapshot(readSnapshot());
        }
        return true;
      } catch (error) {
        dirty = true;
        onError(error);
        return false;
      }
    })().then((ok) => {
      inFlight = null;
      waiting?.resolve(ok);
      // Cover a mutation between the final I/O continuation and this callback.
      // Failed writes retry on the next mutation or explicit flush, not a spin.
      if (dirty && ok) return schedule();
      return ok;
    });
    return inFlight;
  }

  return {schedule, flush};
}
