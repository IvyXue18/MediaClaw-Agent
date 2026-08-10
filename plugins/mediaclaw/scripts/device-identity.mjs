import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveStateDirectory(env = process.env) {
  if (env.MEDIACLAW_AGENT_STATE_DIR) {
    return path.resolve(env.MEDIACLAW_AGENT_STATE_DIR);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "MediaClaw Agent");
  }
  if (process.platform === "win32" && env.APPDATA) {
    return path.join(env.APPDATA, "MediaClaw Agent");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "mediaclaw-agent");
}

function deviceIdFromPublicKey(publicKey) {
  return `device_${crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 24)}`;
}

function exportPublicKey(publicKey) {
  return publicKey.export({type: "spki", format: "der"}).toString("base64");
}

function normalizeStoredIdentity(value = {}) {
  const privateKeyPem = String(value.privateKeyPem || "").trim();
  const publicKey = String(value.publicKey || "").trim();
  if (!privateKeyPem || !publicKey) return null;
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const derivedPublicKey = exportPublicKey(crypto.createPublicKey(privateKey));
  if (derivedPublicKey !== publicKey) return null;
  return {
    deviceId: deviceIdFromPublicKey(publicKey),
    publicKey,
    privateKey,
    createdAt: String(value.createdAt || new Date().toISOString()),
  };
}

export function buildDeviceProofPayload({
  purpose,
  deviceId,
  challengeId,
  nonce,
  extensionId,
  protocolVersion = "3",
} = {}) {
  return [
    "mediaclaw-agent",
    String(purpose || "").trim(),
    String(deviceId || "").trim(),
    String(challengeId || "").trim(),
    String(nonce || "").trim(),
    String(extensionId || "").trim(),
    String(protocolVersion || "").trim(),
  ].join("\n");
}

export async function loadOrCreateDeviceIdentity({
  stateDirectory = resolveStateDirectory(),
  displayName = `MediaClaw Agent on ${os.hostname()}`,
  host = "codex",
} = {}) {
  const filePath = path.join(stateDirectory, "device-identity.json");
  await fs.mkdir(stateDirectory, {recursive: true, mode: 0o700});
  await fs.chmod(stateDirectory, 0o700).catch(() => {});
  let identity = null;
  try {
    identity = normalizeStoredIdentity(
      JSON.parse(await fs.readFile(filePath, "utf8")),
    );
  } catch {
    identity = null;
  }
  if (!identity) {
    const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519");
    const publicKeyBase64 = exportPublicKey(publicKey);
    const stored = {
      version: 1,
      publicKey: publicKeyBase64,
      privateKeyPem: privateKey.export({type: "pkcs8", format: "pem"}),
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    identity = normalizeStoredIdentity(stored);
  }
  await fs.chmod(filePath, 0o600).catch(() => {});
  const fingerprint = crypto
    .createHash("sha256")
    .update(Buffer.from(identity.publicKey, "base64"))
    .digest("hex")
    .slice(0, 32)
    .match(/.{1,4}/g)
    .join("-");
  return {
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    fingerprint,
    displayName,
    host,
    createdAt: identity.createdAt,
    sign(payload) {
      return crypto.sign(null, Buffer.from(String(payload), "utf8"), identity.privateKey).toString("base64");
    },
  };
}
