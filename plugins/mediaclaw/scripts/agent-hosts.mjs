const AGENT_HOST_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "codex",
    aliases: Object.freeze(["codex"]),
    displayName: "Codex",
    deviceDisplayName: "MediaClaw Agent (Codex)",
    automaticUpdate: true,
  }),
  Object.freeze({
    key: "workbuddy",
    aliases: Object.freeze(["workbuddy", "codebuddy"]),
    displayName: "WorkBuddy",
    deviceDisplayName: "MediaClaw Agent (WorkBuddy)",
    automaticUpdate: true,
  }),
  Object.freeze({
    key: "doubao-work",
    aliases: Object.freeze([
      "doubao-work",
      "doubao_work",
      "doubaowork",
      "doubao",
    ]),
    displayName: "豆包工作",
    deviceDisplayName: "MediaClaw Agent (豆包工作)",
    automaticUpdate: false,
  }),
  // One host for every Claude surface: they share one device identity and one approval.
  // The connector's MEDIACLAW_AGENT_DEVICE_NAME tells the user which surface is connected.
  Object.freeze({
    key: "claude",
    aliases: Object.freeze([
      "claude",
      "claude-code",
      "claude_code",
      "claude-desktop",
      "claude_desktop",
      "claude-cowork",
      "claude_cowork",
    ]),
    displayName: "Claude Code",
    deviceDisplayName: "MediaClaw Agent (Claude Code)",
    automaticUpdate: true,
  }),
  // Grok Build has no plugin marketplace: the connector runs the launcher from a cloned official repository.
  Object.freeze({
    key: "grok-build",
    aliases: Object.freeze(["grok-build", "grok_build", "grokbuild", "grok"]),
    displayName: "Grok Build",
    deviceDisplayName: "MediaClaw Agent (Grok Build)",
    automaticUpdate: true,
    updateSource: "git_checkout",
  }),
  // Grok Bot runs the Agent and the browser extension together on its cloud computer.
  Object.freeze({
    key: "grok-bot",
    aliases: Object.freeze(["grok-bot", "grok_bot", "grokbot"]),
    displayName: "Grok Bot",
    deviceDisplayName: "MediaClaw Agent (Grok Bot 云电脑)",
    automaticUpdate: true,
    updateSource: "git_checkout",
  }),
  // DeepSeek Harness loads the cloned launcher from a profile patch entry.
  Object.freeze({
    key: "deepseek-harness",
    aliases: Object.freeze([
      "deepseek-harness",
      "deepseek_harness",
      "deepseekharness",
      "dsh",
    ]),
    displayName: "DeepSeek Harness",
    deviceDisplayName: "MediaClaw Agent (DeepSeek Harness)",
    automaticUpdate: true,
    updateSource: "git_checkout",
  }),
  // The Cursor IDE and cursor-agent CLI share ~/.cursor/mcp.json, so they share one device identity.
  Object.freeze({
    key: "cursor",
    aliases: Object.freeze(["cursor", "cursor-agent", "cursor_agent", "cursor-cli", "cursor_cli"]),
    displayName: "Cursor",
    deviceDisplayName: "MediaClaw Agent (Cursor)",
    automaticUpdate: true,
    updateSource: "git_checkout",
  }),
]);

const AGENT_HOST_BY_KEY = new Map(
  AGENT_HOST_DEFINITIONS.map((definition) => [definition.key, definition]),
);
const AGENT_HOST_ALIAS_TO_KEY = new Map(
  AGENT_HOST_DEFINITIONS.flatMap((definition) =>
    definition.aliases.map((alias) => [alias, definition.key]),
  ),
);
function sanitizeHostKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function normalizeAgentHostKey(value) {
  const normalized = sanitizeHostKey(value);
  return AGENT_HOST_ALIAS_TO_KEY.get(normalized) || normalized;
}

export function getAgentHostDefinition(value) {
  return AGENT_HOST_BY_KEY.get(normalizeAgentHostKey(value)) || null;
}

export function isSupportedAgentHost(value) {
  return Boolean(getAgentHostDefinition(value));
}

export function agentHostDisplayName(value) {
  const definition = getAgentHostDefinition(value);
  return definition?.displayName || normalizeAgentHostKey(value) || "Agent";
}

export function agentHostDeviceDisplayName(value) {
  const definition = getAgentHostDefinition(value);
  const normalized = normalizeAgentHostKey(value);
  return definition?.deviceDisplayName || `MediaClaw Agent (${normalized || "agent"})`;
}

export function agentHostSupportsAutomaticUpdate(value) {
  return getAgentHostDefinition(value)?.automaticUpdate === true;
}

// "git_checkout" hosts update by pulling the cloned official repository the launcher runs from.
export function agentHostUpdateSource(value) {
  return getAgentHostDefinition(value)?.updateSource || "marketplace";
}

export function detectAgentHostKey(env = process.env) {
  const explicit = normalizeAgentHostKey(env.MEDIACLAW_AGENT_HOST);
  if (explicit) return explicit;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (
    env.WORKBUDDY_HOME ||
    env.WORKBUDDY_HOST ||
    env.CODEBUDDY_PLUGIN_ROOT ||
    env.CODEBUDDY_CONFIG_DIR
  ) {
    return "workbuddy";
  }
  return "codex";
}

export const SUPPORTED_AGENT_HOST_KEYS = Object.freeze(
  AGENT_HOST_DEFINITIONS.map((definition) => definition.key),
);
