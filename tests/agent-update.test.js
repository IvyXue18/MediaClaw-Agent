import assert from "node:assert/strict";
import test from "node:test";
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  createAgentUpdateChecker,
  createAgentUpdateOrchestrator,
  parseInstalledAgentVersion,
} from "../plugins/mediaclaw/scripts/agent-update.mjs";

function manifestFetch(version) {
  return async () => ({
    ok: true,
    json: async () => [
      {tag_name: `v${version}`, draft: false, prerelease: false},
    ],
  });
}

test("version comparison orders prereleases and stable releases", () => {
  assert.equal(compareVersions("0.3.0-alpha.1", "0.3.0-rc.1"), -1);
  assert.equal(compareVersions("0.3.0-rc.1", "0.3.0"), -1);
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.4.0", "0.3.9"), 1);
  assert.equal(compareVersions("invalid", "0.3.9"), null);
});

test("stable installations ignore newer prerelease channels", async () => {
  const result = await createAgentUpdateChecker({
    currentVersion: "0.3.0",
    hostKey: "codex",
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        {tag_name: "v0.4.0-rc.1", draft: false, prerelease: true},
        {tag_name: "v0.3.0", draft: false, prerelease: false},
      ],
    }),
  }).check();

  assert.equal(result.status, "up_to_date");
  assert.equal(result.latestVersion, "0.3.0");
});

test("Codex update plan requires approval and a host restart without user commands", async () => {
  const checker = createAgentUpdateChecker({
    currentVersion: "0.3.0-rc.1",
    hostKey: "codex",
    fetchImpl: manifestFetch("0.3.1"),
  });
  const result = await checker.check();
  assert.equal(result.status, "update_available");
  assert.equal(result.approvalRequired, true);
  assert.equal(result.execution.type, "adapter_orchestrated");
  assert.equal(result.execution.tool, "mediaclaw_manage_agent_update");
  assert.equal(result.execution.userRunsCommands, false);
  assert.equal(result.continuation.createNewTask, false);
  assert.equal(result.continuation.restartHostRequired, true);
  assert.equal(result.continuation.projectless, true);
  assert.equal(result.userGuidance.suggestedReply, "升级 Agent");
  assert.equal(result.userGuidance.hostDisplayName, "Codex");
  assert.match(result.message, /0\.3\.0-rc\.1/);
  assert.match(result.message, /0\.3\.1/);
});

test("WorkBuddy refreshes the marketplace and installed plugin", async () => {
  const checker = createAgentUpdateChecker({
    currentVersion: "0.3.0-rc.1",
    hostKey: "workbuddy",
    fetchImpl: manifestFetch("0.3.1"),
  });
  const result = await checker.check();
  assert.equal(result.execution.host, "workbuddy");
  assert.equal(result.execution.userRunsCommands, false);
});

test("Doubao Work reports a non-blocking local reinstall instead of borrowing another host updater", async () => {
  const result = await createAgentUpdateChecker({
    currentVersion: "0.3.0",
    hostKey: "doubao-work",
    fetchImpl: manifestFetch("0.3.1"),
  }).check();
  assert.equal(result.status, "manual_update_available");
  assert.equal(result.blocking, false);
  assert.equal(result.approvalRequired, false);
  assert.equal(result.userGuidance.hostDisplayName, "豆包工作");
  assert.match(result.message, /本地接入包/);
  assert.equal(result.execution, undefined);
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

test("installed version parser accepts Codex tables and WorkBuddy JSON only for MediaClaw", () => {
  assert.equal(
    parseInstalledAgentVersion(
      "mediaclaw@mediaclaw-agent  installed, enabled  0.3.1  /tmp/plugin",
    ),
    "0.3.1",
  );
  assert.equal(
    parseInstalledAgentVersion(
      JSON.stringify({plugins: [{name: "mediaclaw", version: "0.3.2-rc.1"}]}),
    ),
    "0.3.2-rc.1",
  );
  assert.equal(
    parseInstalledAgentVersion("other-plugin installed 9.9.9"),
    null,
  );
});

function memoryStateStore(initialValue = null) {
  let value = initialValue;
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = {...next, schemaVersion: 1};
    },
    async clear() {
      value = null;
    },
    current() {
      return value;
    },
  };
}

function updateOrchestrator({
  commandRunner,
  hostKey = "codex",
  currentVersion = "0.3.0-rc.1",
  stateStore = memoryStateStore(),
  packageRoot = "",
} = {}) {
  const checker = createAgentUpdateChecker({
    currentVersion,
    hostKey,
    fetchImpl: manifestFetch("0.3.1"),
    packageRoot,
  });
  return createAgentUpdateOrchestrator({
    checker,
    currentVersion,
    hostKey,
    commandRunner,
    approvalIdFactory: () => "approval-test",
    stateStore,
    packageRoot,
  });
}

test("rejecting an update changes no installation and suppresses this session", async () => {
  let commandCount = 0;
  const orchestrator = updateOrchestrator({
    commandRunner: async () => {
      commandCount += 1;
      return {code: 0};
    },
  });
  const offered = await orchestrator.status();
  assert.equal(offered.approvalId, "approval-test");

  const rejected = await orchestrator.decide({
    decision: "reject",
    approvalId: offered.approvalId,
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.changedInstallation, false);
  assert.equal(commandCount, 0);
  assert.equal((await orchestrator.status()).status, "dismissed");
  assert.equal(orchestrator.isSessionFenced(), false);
});

test("approved update runs fixed commands, verifies the version, and fences the old session", async () => {
  const commands = [];
  const stateStore = memoryStateStore();
  const orchestrator = updateOrchestrator({
    stateStore,
    commandRunner: async (command) => {
      commands.push([command.file, ...command.args]);
      if (command.args.at(-1) === "list") {
        return {
          code: 0,
          stdout:
            "mediaclaw@mediaclaw-agent  installed, enabled  0.3.1  /tmp/plugin",
        };
      }
      return {code: 0, stdout: "updated"};
    },
  });
  const offered = await orchestrator.status();
  const approved = await orchestrator.decide({
    decision: "approve",
    approvalId: offered.approvalId,
    originalGoal: "继续完成账号分析并生成选题",
  });

  assert.equal(approved.ok, true);
  assert.deepEqual(commands, [
    ["codex", "plugin", "marketplace", "upgrade", "mediaclaw-agent"],
    ["codex", "plugin", "list"],
  ]);
  assert.equal(approved.agentUpdate.installedVersion, "0.3.1");
  assert.equal(approved.agentUpdate.currentVersion, "0.3.0-rc.1");
  assert.equal(approved.agentUpdate.oldSessionFenced, true);
  assert.equal(approved.agentUpdate.restartHostRequired, true);
  assert.equal(approved.agentUpdate.userGuidance.hostDisplayName, "Codex");
  assert.equal(
    approved.agentUpdate.userGuidance.suggestedReplyAfterRestart,
    "继续",
  );
  assert.match(approved.agentUpdate.message, /已安装并通过验版/);
  assert.match(approved.agentUpdate.message, /Codex/);
  assert.equal(approved.continuation.createNewTask, false);
  assert.equal(approved.continuation.hostAction, "restart_host");
  assert.equal(approved.continuation.projectless, true);
  assert.equal(
    approved.continuation.originalGoal,
    "继续完成账号分析并生成选题",
  );
  assert.equal(orchestrator.isSessionFenced(), true);
  assert.equal((await orchestrator.status()).status, "installed_restart_required");
  assert.equal(stateStore.current().targetVersion, "0.3.1");

  await orchestrator.decide({
    decision: "approve",
    approvalId: offered.approvalId,
    originalGoal: "继续完成账号分析并生成选题",
  });
  assert.equal(commands.length, 2);
});

test("a restarted target-version Adapter activates the durable upgrade and resumes the goal", async () => {
  const stateStore = memoryStateStore({
    schemaVersion: 1,
    hostKey: "codex",
    status: "installed_restart_required",
    fromVersion: "0.3.0",
    targetVersion: "0.3.1",
    installedVersion: "0.3.1",
    originalGoal: "继续完成账号分析",
  });
  const orchestrator = updateOrchestrator({
    currentVersion: "0.3.1",
    stateStore,
    commandRunner: async () => ({code: 0}),
  });

  const status = await orchestrator.status();
  assert.equal(status.status, "activated");
  assert.equal(status.activeVersion, "0.3.1");
  assert.equal(status.blocking, false);
  assert.equal(status.continuation.resumeAutomatically, true);
  assert.equal(status.continuation.suggestedUserReply, "继续");
  assert.equal(status.userGuidance.activeVersion, "0.3.1");
  assert.match(status.message, /已升级并激活到 0\.3\.1/);
  assert.equal(status.continuation.originalGoal, "继续完成账号分析");
  assert.equal(stateStore.current(), null);
});

test("an old Adapter keeps reporting restart required from durable state", async () => {
  const stateStore = memoryStateStore({
    schemaVersion: 1,
    hostKey: "codex",
    status: "installed_restart_required",
    fromVersion: "0.3.0",
    targetVersion: "0.3.1",
    installedVersion: "0.3.1",
    originalGoal: "继续原任务",
  });
  const orchestrator = updateOrchestrator({
    currentVersion: "0.3.0",
    stateStore,
    commandRunner: async () => ({code: 0}),
  });

  const status = await orchestrator.status();
  assert.equal(status.status, "installed_restart_required");
  assert.equal(status.restartHostRequired, true);
  assert.equal(status.userGuidance.hostDisplayName, "Codex");
  assert.equal(status.userGuidance.suggestedReplyAfterRestart, "继续");
  assert.equal(status.continuation.createNewTask, false);
  assert.equal(status.continuation.originalGoal, "继续原任务");
});

test("WorkBuddy approval refreshes marketplace, updates plugin, then verifies JSON", async () => {
  const commands = [];
  const orchestrator = updateOrchestrator({
    hostKey: "workbuddy",
    commandRunner: async (command) => {
      commands.push([command.file, ...command.args]);
      return command.args.includes("--json")
        ? {
            code: 0,
            stdout: JSON.stringify({
              plugins: [{id: "mediaclaw@mediaclaw-agent", version: "0.3.1"}],
            }),
          }
        : {code: 0};
    },
  });
  const offered = await orchestrator.status();
  const result = await orchestrator.decide({
    decision: "approve",
    approvalId: offered.approvalId,
    originalGoal: "继续完成 WorkBuddy 原任务",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(commands, [
    ["codebuddy", "plugin", "marketplace", "update", "mediaclaw-agent"],
    ["codebuddy", "plugin", "update", "mediaclaw@mediaclaw-agent"],
    ["codebuddy", "plugin", "list", "--json"],
  ]);
  assert.equal(result.agentUpdate.oldSessionFenced, true);
  assert.equal(result.agentUpdate.userGuidance.hostDisplayName, "WorkBuddy");
  assert.match(result.agentUpdate.message, /WorkBuddy/);
});

test("upgrade stops before verification when installation fails", async () => {
  const commands = [];
  const orchestrator = updateOrchestrator({
    commandRunner: async (command) => {
      commands.push([command.file, ...command.args]);
      return {code: 1, stderr: "marketplace unavailable"};
    },
  });
  const offered = await orchestrator.status();
  const result = await orchestrator.decide({
    decision: "approve",
    approvalId: offered.approvalId,
    originalGoal: "继续原任务",
  });
  assert.equal(result.ok, false);
  assert.equal(result.agentUpdate.failedStage, "install_1");
  assert.equal(commands.length, 1);
  assert.equal(orchestrator.isSessionFenced(), false);
});

test("upgrade never fences the old session when the installed version is wrong", async () => {
  const orchestrator = updateOrchestrator({
    commandRunner: async (command) =>
      command.args.at(-1) === "list"
        ? {
            code: 0,
            stdout:
              "mediaclaw@mediaclaw-agent  installed, enabled  0.3.0-rc.1  /tmp/plugin",
          }
        : {code: 0},
  });
  const offered = await orchestrator.status();
  const result = await orchestrator.decide({
    decision: "approve",
    approvalId: offered.approvalId,
    originalGoal: "继续原任务",
  });
  assert.equal(result.ok, false);
  assert.equal(result.agentUpdate.failedStage, "verify_version");
  assert.equal(result.agentUpdate.installedVersion, "0.3.0-rc.1");
  assert.equal(orchestrator.isSessionFenced(), false);
});

test("approval id and original goal are mandatory before any update command", async () => {
  let commandCount = 0;
  const orchestrator = updateOrchestrator({
    commandRunner: async () => {
      commandCount += 1;
      return {code: 0};
    },
  });
  const wrongApproval = await orchestrator.decide({
    decision: "approve",
    approvalId: "wrong",
    originalGoal: "继续原任务",
  });
  assert.equal(wrongApproval.error.code, "UPDATE_APPROVAL_INVALID");

  const offered = await orchestrator.status();
  const missingGoal = await orchestrator.decide({
    decision: "approve",
    approvalId: offered.approvalId,
  });
  assert.equal(missingGoal.error.code, "UPDATE_GOAL_REQUIRED");
  assert.equal(commandCount, 0);
});


test("unsupported hosts cannot request another host updater or manual reinstall", () => {
  for (const hostKey of ["windsurf", "future-agent"]) {
    assert.throws(() => createAgentUpdateChecker({currentVersion: "0.3.0", hostKey, fetchImpl: manifestFetch("0.3.1")}), /Unsupported MediaClaw Agent host/);
  }
});

for (const hostKey of ["grok-build", "grok-bot", "deepseek-harness", "cursor"]) {
  test(`${hostKey} approval fast-forwards to the official stable release tag, then verifies the manifest`, async () => {
    const commands = [];
    const packageRoot = "/workspace/mediaclaw/MediaClaw-Agent";
    const orchestrator = updateOrchestrator({
      hostKey,
      packageRoot,
      commandRunner: async (command) => {
        commands.push([command.file, ...command.args]);
        return command.args.includes("show")
          ? {code: 0, stdout: JSON.stringify({name: "mediaclaw", version: "0.3.1"})}
          : {code: 0};
      },
    });
    const offered = await orchestrator.status();
    assert.equal(offered.status, "update_available");
    assert.equal(offered.execution.userRunsCommands, false);
    const result = await orchestrator.decide({
      decision: "approve",
      approvalId: offered.approvalId,
      originalGoal: "继续完成原任务",
    });
    assert.equal(result.ok, true);
    // Use the approved official tag; require a clean checkout and a fast-forward.
    assert.deepEqual(commands, [
      ["git", "-C", packageRoot, "status", "--porcelain"],
      ["git", "-C", packageRoot, "fetch", "--no-tags", "https://github.com/IvyXue18/MediaClaw-Agent.git", "refs/tags/v0.3.1"],
      ["git", "-C", packageRoot, "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"],
      ["git", "-C", packageRoot, "merge", "--ff-only", "FETCH_HEAD"],
      ["git", "-C", packageRoot, "show", "HEAD:plugins/mediaclaw/.codex-plugin/plugin.json"],
    ]);
    assert.equal(result.agentUpdate.oldSessionFenced, true);
    assert.equal(result.agentUpdate.installedVersion, "0.3.1");
  });

  test(`${hostKey} without a checkout falls back to the reinstall prompt`, async () => {
    const result = await createAgentUpdateChecker({
      currentVersion: "0.3.0",
      hostKey,
      fetchImpl: manifestFetch("0.3.1"),
      packageRoot: "",
    }).check();
    assert.equal(result.status, "manual_update_available");
    assert.equal(result.blocking, false);
    assert.equal(result.execution, undefined);
  });
}

test("a relative package root is ignored instead of pulling the working directory", async () => {
  const result = await createAgentUpdateChecker({
    currentVersion: "0.3.0",
    hostKey: "grok-build",
    fetchImpl: manifestFetch("0.3.1"),
    packageRoot: "relative/MediaClaw-Agent",
  }).check();
  assert.equal(result.status, "manual_update_available");
});

for (const scenario of ["stable-tag", "ahead", "dirty"]) {
  test(`git checkout update preserves the approved release boundary (${scenario})`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mediaclaw-update-"));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const official = path.join(root, "official");
    const checkout = path.join(root, "installed");
    const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
    fs.mkdirSync(official);
    git(official, "init", "--initial-branch=main");
    git(official, "config", "user.name", "Update Test");
    git(official, "config", "user.email", "update-test@example.invalid");
    const manifest = "plugins/mediaclaw/.codex-plugin/plugin.json";
    fs.mkdirSync(path.dirname(path.join(official, manifest)), {recursive: true});
    const commitVersion = (version, message) => {
      fs.writeFileSync(path.join(official, manifest), JSON.stringify({name: "mediaclaw", version}));
      git(official, "add", manifest);
      git(official, "commit", "-m", message);
      return git(official, "rev-parse", "HEAD");
    };
    const original = commitVersion("0.3.0", "installed release");
    git(root, "clone", official, checkout);
    const stable = commitVersion("0.3.1", "approved stable release");
    git(official, "tag", "v0.3.1");
    // The default branch contains an unreleased commit with the same manifest version.
    fs.writeFileSync(path.join(official, "unreleased.txt"), "must not install this\n");
    git(official, "add", "unreleased.txt");
    git(official, "commit", "-m", "unreleased change");
    if (scenario === "ahead") git(checkout, "pull", "--ff-only");
    if (scenario === "dirty") fs.writeFileSync(path.join(checkout, "local-note.txt"), "keep me\n");
    const before = git(checkout, "rev-parse", "HEAD");
    const commands = [];
    const orchestrator = updateOrchestrator({
      hostKey: "cursor",
      packageRoot: checkout,
      commandRunner: async (command) => {
        commands.push(command.args);
        const args = command.args.map((value) => value === "https://github.com/IvyXue18/MediaClaw-Agent.git" ? official : value);
        const result = spawnSync(command.file, args, {encoding: "utf8"});
        return {code: result.status, stdout: result.stdout, stderr: result.stderr};
      },
    });
    const offered = await orchestrator.status();
    const result = await orchestrator.decide({decision: "approve", approvalId: offered.approvalId, originalGoal: "继续测试"});
    if (scenario === "stable-tag") {
      assert.equal(result.ok, true);
      assert.equal(git(checkout, "rev-parse", "HEAD"), stable);
      assert.equal(fs.existsSync(path.join(checkout, "unreleased.txt")), false);
      assert.notEqual(stable, original);
    } else {
      assert.equal(result.ok, false);
      assert.equal(git(checkout, "rev-parse", "HEAD"), before);
      assert.equal(commands.some((args) => args.includes("merge")), false);
      if (scenario === "dirty") {
        assert.equal(commands.length, 1);
        assert.equal(fs.readFileSync(path.join(checkout, "local-note.txt"), "utf8"), "keep me\n");
      }
    }
  });
}
