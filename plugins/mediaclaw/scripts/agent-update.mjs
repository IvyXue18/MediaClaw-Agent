import crypto from "node:crypto";
import {spawn} from "node:child_process";

const DEFAULT_RELEASES_URL =
  "https://api.github.com/repos/IvyXue18/MediaClaw-Agent/releases?per_page=5";
const MARKETPLACE_NAME = "mediaclaw-agent";
const PLUGIN_SELECTOR = "mediaclaw@mediaclaw-agent";
const UPDATE_CHECK_TIMEOUT_MS = 3_000;
const UPDATE_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const UPDATE_OUTPUT_LIMIT = 64 * 1024;

export const AGENT_UPDATE_TOOL = {
  name: "mediaclaw_manage_agent_update",
  description:
    "仅在用户已经明确同意或拒绝当前 agentUpdate 后调用。拒绝不会改动安装；同意后由 Adapter 执行固定升级命令、验证实际版本，并锁定当前旧会话等待宿主创建新版续接任务。",
  inputSchema: {
    type: "object",
    properties: {
      decision: {type: "string", enum: ["approve", "reject"]},
      approvalId: {type: "string", minLength: 1},
      originalGoal: {
        type: "string",
        description: "同意升级时必填：用户尚未完成的原始目标。",
      },
    },
    required: ["decision", "approvalId"],
    additionalProperties: false,
  },
};

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    String(value || "").trim(),
  );
  if (!match) return null;
  return {
    raw: String(value).trim().replace(/^v/, ""),
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return Math.sign(difference);
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const difference = left[index].localeCompare(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function updateCommandPlan(hostKey) {
  if (hostKey === "workbuddy") {
    return {
      commands: [
        {
          file: "codebuddy",
          args: ["plugin", "marketplace", "update", MARKETPLACE_NAME],
        },
        {
          file: "codebuddy",
          args: ["plugin", "update", PLUGIN_SELECTOR],
        },
      ],
      verify: {file: "codebuddy", args: ["plugin", "list", "--json"]},
    };
  }
  return {
    commands: [
      {
        file: "codex",
        args: ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME],
      },
    ],
    verify: {file: "codex", args: ["plugin", "list"]},
  };
}

function commandDisplay(command) {
  return [command.file, ...command.args].join(" ");
}

function updateExecution(hostKey) {
  const plan = updateCommandPlan(hostKey);
  return {
    type: "adapter_orchestrated",
    tool: AGENT_UPDATE_TOOL.name,
    commands: plan.commands.map(commandDisplay),
    verifyCommand: commandDisplay(plan.verify),
  };
}

function buildUpdateState({currentVersion, latestVersion, hostKey, checkedAt}) {
  const comparison = compareVersions(currentVersion, latestVersion);
  if (comparison === null) {
    return {
      status: "unavailable",
      currentVersion,
      latestVersion: null,
      checkedAt,
      blocking: false,
      message: "无法识别官方版本信息，本次继续使用当前版本。",
    };
  }
  if (comparison >= 0) {
    return {
      status: comparison === 0 ? "up_to_date" : "ahead",
      currentVersion,
      latestVersion,
      checkedAt,
      blocking: false,
    };
  }
  return {
    status: "update_available",
    currentVersion,
    latestVersion,
    checkedAt,
    blocking: true,
    approvalRequired: true,
    message: `发现 MediaClaw Agent 新版本 ${latestVersion}。升级会更新本机 Agent 接入包，并需要在新任务中继续。`,
    releaseUrl: `https://github.com/IvyXue18/MediaClaw-Agent/releases/tag/v${latestVersion}`,
    execution: updateExecution(hostKey),
    continuation: {
      required: true,
      createNewTask: true,
      projectless: true,
      openWhenSupported: true,
      reason: "当前任务已经加载旧版 Skill 和 MCP，不能热切换到刚升级的版本。",
      prompt: `MediaClaw Agent 已升级到 ${latestVersion}。请先调用 mediaclaw_connection_status 验证 agentUpdate.currentVersion=${latestVersion}，然后继续用户升级前尚未完成的 MediaClaw 请求。不要要求用户重复描述需求。`,
    },
  };
}

function latestPublishedVersion(payload) {
  if (Array.isArray(payload)) {
    const release = payload.find((item) => item?.draft !== true);
    return parseVersion(release?.tag_name)?.raw || null;
  }
  return parseVersion(payload?.version || payload?.tag_name)?.raw || null;
}

export function createAgentUpdateChecker({
  currentVersion,
  hostKey,
  manifestUrl =
    process.env.MEDIACLAW_AGENT_UPDATE_MANIFEST_URL || DEFAULT_RELEASES_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  let pendingCheck = null;

  async function check() {
    if (pendingCheck) return pendingCheck;
    pendingCheck = (async () => {
      const checkedAt = new Date().toISOString();
      if (process.env.MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK === "1") {
        return {
          status: "disabled",
          currentVersion,
          latestVersion: null,
          checkedAt,
          blocking: false,
        };
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
      try {
        const response = await fetchImpl(manifestUrl, {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json();
        const latestVersion = latestPublishedVersion(manifest);
        return buildUpdateState({
          currentVersion,
          latestVersion,
          hostKey,
          checkedAt,
        });
      } catch (error) {
        return {
          status: "unavailable",
          currentVersion,
          latestVersion: null,
          checkedAt,
          blocking: false,
          message: "暂时无法检查 MediaClaw Agent 更新，本次继续使用当前版本。",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timeout);
      }
    })();
    return pendingCheck;
  }

  return {check};
}

function appendLimited(current, chunk) {
  const next = `${current}${String(chunk || "")}`;
  return next.length <= UPDATE_OUTPUT_LIMIT
    ? next
    : next.slice(next.length - UPDATE_OUTPUT_LIMIT);
}

export function runAgentUpdateCommand(
  command,
  {
    spawnImpl = spawn,
    timeoutMs = UPDATE_COMMAND_TIMEOUT_MS,
    env = process.env,
  } = {},
) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({...result, stdout, stderr});
    };
    const timer = setTimeout(() => {
      child?.kill?.("SIGTERM");
      finish({code: null, timedOut: true});
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawnImpl(command.file, command.args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      child.stdout?.on("data", (chunk) => {
        stdout = appendLimited(stdout, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = appendLimited(stderr, chunk);
      });
      child.on("error", (error) => {
        finish({code: null, error: error.message, timedOut: false});
      });
      child.on("close", (code, signal) => {
        finish({code, signal: signal || null, timedOut: false});
      });
    } catch (error) {
      finish({
        code: null,
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
    }
  });
}

function findVersionInJson(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVersionInJson(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const identity = [value.name, value.id, value.plugin, value.selector]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
  if (identity.includes("mediaclaw")) {
    const version = parseVersion(value.version || value.installedVersion)?.raw;
    if (version) return version;
  }
  for (const item of Object.values(value)) {
    const found = findVersionInJson(item);
    if (found) return found;
  }
  return null;
}

export function parseInstalledAgentVersion(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const version = findVersionInJson(parsed);
    if (version) return version;
  } catch {
    // Codex currently returns a human-readable table.
  }
  for (const line of text.split(/\r?\n/)) {
    if (!/mediaclaw(?:@mediaclaw-agent|-agent)/i.test(line)) continue;
    const versions = line.match(/\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g) || [];
    for (const version of versions) {
      const parsed = parseVersion(version)?.raw;
      if (parsed) return parsed;
    }
  }
  return null;
}

function normalizeCommandResult(result) {
  if (!result || typeof result !== "object") {
    return {code: null, stdout: "", stderr: "", error: "命令未返回结果"};
  }
  return {
    code: Number.isInteger(result.code) ? result.code : null,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: String(result.error || ""),
    timedOut: result.timedOut === true,
  };
}

function failureMessage(result) {
  if (result.timedOut) return "命令执行超时";
  if (result.error) return result.error;
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? detail.slice(0, 2_000) : `命令退出码 ${result.code}`;
}

export function createAgentUpdateOrchestrator({
  checker,
  hostKey,
  currentVersion,
  commandRunner = runAgentUpdateCommand,
  approvalIdFactory = () => `update_${crypto.randomUUID()}`,
} = {}) {
  if (!checker || typeof checker.check !== "function") {
    throw new TypeError("agent update checker is required");
  }
  let baseStatePromise = null;
  let approvalId = "";
  let dismissed = false;
  let fencedState = null;
  let pendingApply = null;

  async function baseState() {
    if (!baseStatePromise) baseStatePromise = checker.check();
    const state = await baseStatePromise;
    if (state.status === "update_available" && !approvalId) {
      approvalId = approvalIdFactory();
    }
    return state;
  }

  async function status() {
    const state = await baseState();
    if (fencedState) return fencedState;
    if (dismissed && state.status === "update_available") {
      return {
        status: "dismissed",
        currentVersion: state.currentVersion,
        latestVersion: state.latestVersion,
        checkedAt: state.checkedAt,
        blocking: false,
        approvalRequired: false,
        message: "用户已暂不升级；本会话不会再次提示。",
      };
    }
    return state.status === "update_available"
      ? {...state, approvalId}
      : state;
  }

  async function decide({decision, approvalId: suppliedApprovalId, originalGoal} = {}) {
    const state = await baseState();
    if (state.status !== "update_available") {
      return {
        ok: false,
        error: {code: "UPDATE_NOT_AVAILABLE", message: "当前没有可执行的 Agent 更新"},
      };
    }
    if (!approvalId || suppliedApprovalId !== approvalId) {
      return {
        ok: false,
        error: {code: "UPDATE_APPROVAL_INVALID", message: "升级授权已失效，请重新检查版本"},
      };
    }
    if (decision === "reject") {
      if (fencedState) {
        return {
          ok: false,
          error: {code: "OLD_SESSION_FENCED", message: "旧会话已在升级后锁定"},
        };
      }
      dismissed = true;
      return {ok: true, agentUpdate: await status(), changedInstallation: false};
    }
    if (decision !== "approve") {
      return {
        ok: false,
        error: {code: "UPDATE_DECISION_INVALID", message: "decision 必须是 approve 或 reject"},
      };
    }
    const goal = String(originalGoal || "").trim();
    if (!goal) {
      return {
        ok: false,
        error: {code: "UPDATE_GOAL_REQUIRED", message: "升级前必须保留用户尚未完成的原始目标"},
      };
    }
    if (fencedState) {
      return {ok: true, agentUpdate: fencedState, continuation: fencedState.continuation};
    }
    if (pendingApply) return await pendingApply;
    pendingApply = (async () => {
      dismissed = false;
      const plan = updateCommandPlan(hostKey);
      const completedCommands = [];
      for (let index = 0; index < plan.commands.length; index += 1) {
        const command = plan.commands[index];
        const result = normalizeCommandResult(await commandRunner(command));
        if (result.code !== 0) {
          return {
            ok: false,
            agentUpdate: {
              ...state,
              status: "failed",
              blocking: true,
              approvalRequired: true,
              approvalId,
              failedStage: `install_${index + 1}`,
              message: failureMessage(result),
            },
          };
        }
        completedCommands.push(commandDisplay(command));
      }
      const verifyResult = normalizeCommandResult(await commandRunner(plan.verify));
      if (verifyResult.code !== 0) {
        return {
          ok: false,
          agentUpdate: {
            ...state,
            status: "failed",
            blocking: true,
            approvalRequired: true,
            approvalId,
            failedStage: "verify_command",
            message: failureMessage(verifyResult),
          },
        };
      }
      const installedVersion = parseInstalledAgentVersion(verifyResult.stdout);
      if (compareVersions(installedVersion, state.latestVersion) !== 0) {
        return {
          ok: false,
          agentUpdate: {
            ...state,
            status: "failed",
            blocking: true,
            approvalRequired: true,
            approvalId,
            failedStage: "verify_version",
            installedVersion,
            message: installedVersion
              ? `验版得到 ${installedVersion}，目标版本是 ${state.latestVersion}`
              : "验版输出中没有找到 mediaclaw@mediaclaw-agent 的安装版本",
          },
        };
      }
      const continuation = {
        ...state.continuation,
        originalGoal: goal.slice(0, 12_000),
        hostActionRequired: true,
        hostAction: "create_projectless_task",
      };
      fencedState = {
        status: "installed_restart_required",
        currentVersion,
        installedVersion,
        latestVersion: state.latestVersion,
        checkedAt: state.checkedAt,
        blocking: true,
        approvalRequired: false,
        oldSessionFenced: true,
        completedCommands,
        verifyCommand: commandDisplay(plan.verify),
        continuation,
        message: "新版已安装并验版成功；当前旧会话已锁定，必须由宿主创建新版任务续接。",
      };
      return {ok: true, agentUpdate: fencedState, continuation};
    })();
    try {
      return await pendingApply;
    } finally {
      pendingApply = null;
    }
  }

  return {
    status,
    decide,
    isSessionFenced: () => Boolean(fencedState),
  };
}
