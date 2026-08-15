import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  createAgentUpdateChecker,
} from "../plugins/mediaclaw/scripts/agent-update.mjs";

function manifestFetch(version) {
  return async () => ({
    ok: true,
    json: async () => [{tag_name: `v${version}`, draft: false}],
  });
}

test("version comparison orders prereleases and stable releases", () => {
  assert.equal(compareVersions("0.3.0-alpha.1", "0.3.0-rc.1"), -1);
  assert.equal(compareVersions("0.3.0-rc.1", "0.3.0"), -1);
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.4.0", "0.3.9"), 1);
  assert.equal(compareVersions("invalid", "0.3.9"), null);
});

test("Codex update plan requires approval and a new task", async () => {
  const checker = createAgentUpdateChecker({
    currentVersion: "0.3.0-rc.1",
    hostKey: "codex",
    fetchImpl: manifestFetch("0.3.1"),
  });
  const result = await checker.check();
  assert.equal(result.status, "update_available");
  assert.equal(result.approvalRequired, true);
  assert.deepEqual(result.execution.commands, [
    "codex plugin marketplace upgrade mediaclaw-agent",
  ]);
  assert.equal(result.continuation.createNewTask, true);
  assert.equal(result.continuation.projectless, true);
});

test("WorkBuddy refreshes the marketplace and installed plugin", async () => {
  const checker = createAgentUpdateChecker({
    currentVersion: "0.3.0-rc.1",
    hostKey: "workbuddy",
    fetchImpl: manifestFetch("0.3.1"),
  });
  const result = await checker.check();
  assert.deepEqual(result.execution.commands, [
    "codebuddy plugin marketplace update mediaclaw-agent",
    "codebuddy plugin update mediaclaw@mediaclaw-agent",
  ]);
  assert.equal(result.execution.verifyCommand, "codebuddy plugin list --json");
});

test("up-to-date and failed checks never block current use", async () => {
  const current = await createAgentUpdateChecker({
    currentVersion: "0.3.1",
    hostKey: "codex",
    fetchImpl: manifestFetch("0.3.1"),
  }).check();
  assert.equal(current.status, "up_to_date");
  assert.equal(current.blocking, false);

  const unavailable = await createAgentUpdateChecker({
    currentVersion: "0.3.1",
    hostKey: "codex",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  }).check();
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.blocking, false);
});
