const DEFAULT_RELEASES_URL =
  "https://api.github.com/repos/IvyXue18/MediaClaw-Agent/releases?per_page=5";
const MARKETPLACE_NAME = "mediaclaw-agent";
const PLUGIN_SELECTOR = "mediaclaw@mediaclaw-agent";
const UPDATE_CHECK_TIMEOUT_MS = 3_000;

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

function updateExecution(hostKey) {
  if (hostKey === "workbuddy") {
    return {
      type: "host_commands",
      commands: [
        `codebuddy plugin marketplace update ${MARKETPLACE_NAME}`,
        `codebuddy plugin update ${PLUGIN_SELECTOR}`,
      ],
      verifyCommand: "codebuddy plugin list --json",
    };
  }
  return {
    type: "host_commands",
    commands: [`codex plugin marketplace upgrade ${MARKETPLACE_NAME}`],
    verifyCommand: "codex plugin list",
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
