import {readFileSync} from "node:fs";
import {fileURLToPath, pathToFileURL} from "node:url";
import {
  SUPPORTED_AGENT_HOST_KEYS,
  agentHostDeviceDisplayName,
} from "../plugins/mediaclaw/scripts/agent-hosts.mjs";

export const INSTALL_PROMPT_PURPOSES = Object.freeze(["install", "repair", "upgrade"]);
export const INSTALL_PROMPT_MAX_BYTES = 512 * 1024;
export const INSTALL_PROMPT_PATH = fileURLToPath(
  new URL("../plugins/mediaclaw/contracts/install-prompts.json", import.meta.url),
);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stableVersion = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const boundedText = (value, maxLength) => typeof value === "string" &&
  value.trim().length > 0 && value.length <= maxLength && !value.includes("\u0000");
const compareVersions = (left, right) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

export function validateInstallPrompts(catalog, {expectedAgentVersion, sourceText} = {}) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  const exactKeys = (value, keys, label) => require(
    isRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","),
    `${label}: expected keys ${keys.join(", ")}`,
  );
  if (!isRecord(catalog)) return ["catalog must be an object"];
  require(Buffer.byteLength(sourceText ?? `${JSON.stringify(catalog, null, 2)}\n`) <= INSTALL_PROMPT_MAX_BYTES, "catalog JSON exceeds 512 KiB");
  exactKeys(catalog, ["schemaVersion", "revision", "publishedAt", "agentVersion", "extensionCompatibility", "documentationUrl", "hosts"], "catalog");
  require(catalog.schemaVersion === 1, "schemaVersion must be 1");
  require(boundedText(catalog.revision, 80) && /^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/.test(catalog.revision), "revision must use YYYY-MM-DD.sequence within 80 characters");
  require(typeof catalog.publishedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(catalog.publishedAt) && Number.isFinite(Date.parse(catalog.publishedAt)), "publishedAt must be an ISO UTC timestamp");
  require(typeof catalog.agentVersion === "string" && stableVersion.test(catalog.agentVersion), "agentVersion must be a stable version");
  if (expectedAgentVersion) require(catalog.agentVersion === expectedAgentVersion, "agentVersion must match the released contract version");
  const compatibility = catalog.extensionCompatibility;
  exactKeys(compatibility, ["minVersion", "maxVersion"], "extensionCompatibility");
  require(typeof compatibility?.minVersion === "string" && stableVersion.test(compatibility.minVersion), "extensionCompatibility.minVersion must be a stable version");
  require(compatibility?.maxVersion === null || (typeof compatibility?.maxVersion === "string" && stableVersion.test(compatibility.maxVersion)), "extensionCompatibility.maxVersion must be null or a stable version");
  if (stableVersion.test(compatibility?.minVersion || "") && stableVersion.test(compatibility?.maxVersion || "")) {
    require(compareVersions(compatibility.maxVersion, compatibility.minVersion) >= 0, "extensionCompatibility range is inverted");
  }
  require(catalog.documentationUrl === "https://mediaclaw.app/docs/agent/setup", "documentationUrl must be the official setup guide");
  exactKeys(catalog.hosts, SUPPORTED_AGENT_HOST_KEYS, "hosts");
  for (const host of SUPPORTED_AGENT_HOST_KEYS) {
    const entry = catalog.hosts?.[host];
    exactKeys(entry, ["displayName", ...INSTALL_PROMPT_PURPOSES], `hosts.${host}`);
    require(boundedText(entry?.displayName, 80), `hosts.${host}.displayName must contain 1–80 characters without NUL`);
    for (const purpose of INSTALL_PROMPT_PURPOSES) {
      const prompt = entry?.[purpose];
      const label = `hosts.${host}.${purpose}`;
      if (typeof prompt !== "string" || prompt.trim().length < 100) {
        errors.push(`${label}: a complete prompt is required`);
        continue;
      }
      require(boundedText(prompt, 30_000), `${label}: prompt must not exceed 30000 characters or contain NUL`);
      const requirements = [
        ["IvyXue18/MediaClaw-Agent", "official source"],
        [`MEDIACLAW_AGENT_HOST=${host}`, "host identity"],
        [`MEDIACLAW_AGENT_DEVICE_NAME=${agentHostDeviceDisplayName(host)}`, "device identity"],
        ["plugins/mediaclaw/scripts/launch-agent.cmd", "official launcher"],
        ["SHA-256", "verified runtime"],
        [`实际运行版本为 ${catalog.agentVersion}`, "actual runtime version"],
        ["device.agentChannel=release", "release channel"],
        ["保留设备身份、已批准配对和持久数据", "identity preservation"],
        ["MEDIACLAW_AGENT_RUNTIME_VERSION", "legacy version override cleanup"],
        ["connected=true", "real browser connection"],
        ["onboarding.welcome.fixedCopy", "welcome from runtime"],
      ];
      for (const [text, reason] of requirements) require(prompt.includes(text), `${label}: missing ${reason}`);
      require(!/launch-agent-local|\.mcp\.[\w-]+\.local\.json|MEDIACLAW_AGENT_CHANNEL\s*=\s*["']?local/i.test(prompt), `${label}: developer launch instructions are forbidden`);
      require(!/已经能调用 mediaclaw_connection_status，跳过安装/.test(prompt), `${label}: tools presence cannot bypass verification`);
      require(!/你不需要研究该采什么数据，也不用记任何命令/.test(prompt), `${label}: business welcome copy belongs to the runtime`);
      if (purpose !== "install") require(prompt.includes("即使工具已经存在或 connected=true，也必须核对实际运行版本、正式渠道、官方来源及启动路径"), `${label}: repair and upgrade must verify existing installations`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceText = readFileSync(INSTALL_PROMPT_PATH, "utf8");
  const catalog = JSON.parse(sourceText);
  const contract = JSON.parse(readFileSync(new URL("../plugins/mediaclaw/contracts/mcp-v1.json", import.meta.url), "utf8"));
  const errors = validateInstallPrompts(catalog, {expectedAgentVersion: contract.serverVersion, sourceText});
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Install prompts ${catalog.revision}: ${SUPPORTED_AGENT_HOST_KEYS.length} hosts × ${INSTALL_PROMPT_PURPOSES.length} purposes validated`);
  }
}
