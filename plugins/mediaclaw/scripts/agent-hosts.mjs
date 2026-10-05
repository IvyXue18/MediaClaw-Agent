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
