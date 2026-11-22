import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {access, chmod, copyFile, mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// `--download` starts from an empty runtime folder, so the launcher has to fetch and verify the
// published runtime itself; any other argument is a freshly built runtime to place there first.
const downloadMode = process.argv[2] === "--download";
const runtime = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "standalone runtime path or --download is required");

const pluginRoot = path.resolve("plugins/mediaclaw");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const targetKey = `${process.platform}-${process.arch}`;
const isMusl = process.platform === "linux" && (
  await readFile("/etc/alpine-release", "utf8").then(() => true).catch(() => false)
);
const assetByTarget = {
  "darwin-arm64": "mediaclaw-agent-darwin-arm64",
  "darwin-x64": "mediaclaw-agent-darwin-x64",
  "linux-arm64": "mediaclaw-agent-linux-arm64",
  "linux-x64": "mediaclaw-agent-linux-x64",
  "win32-arm64": "mediaclaw-agent-windows-arm64.exe",
  "win32-x64": "mediaclaw-agent-windows-x64.exe",
};
const asset = isMusl
  ? assetByTarget[targetKey]?.replace(/$/, "-musl")
  : assetByTarget[targetKey];
assert.ok(asset, `unsupported launcher smoke target: ${targetKey}`);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mediaclaw-launcher-"));
const pluginData = path.join(temporaryRoot, "plugin-data");
const stateDirectory = path.join(temporaryRoot, "state");
const runtimeDirectory = path.join(pluginData, "runtime", `v${packageJson.version}`);
const installedRuntime = path.join(runtimeDirectory, asset);
if (!downloadMode) {
  await mkdir(runtimeDirectory, {recursive: true});
  await copyFile(runtime, installedRuntime);
  if (process.platform !== "win32") await chmod(installedRuntime, 0o755);
}

const launcher = path.join(pluginRoot, "scripts", "launch-agent.cmd");
const port = 20_000 + Math.floor(Math.random() * 20_000);
const launcherCommand = process.platform === "win32"
  ? process.env.ComSpec || "cmd.exe"
  : launcher;
const launcherArgs = process.platform === "win32"
  ? ["/d", "/s", "/c", launcher]
  : [];
const child = spawn(launcherCommand, launcherArgs, {
  cwd: pluginRoot,
  env: {
    ...process.env,
    PLUGIN_DATA: pluginData,
    MEDIACLAW_AGENT_BROKER_IDLE_MS: "300",
    MEDIACLAW_AGENT_ADAPTER_SWEEP_MS: "100",
    MEDIACLAW_AGENT_ADAPTER_TTL_MS: "300",
    MEDIACLAW_AGENT_DISABLE_UPDATE_CHECK: "1",
    MEDIACLAW_AGENT_HOST: "codex",
    MEDIACLAW_AGENT_PORT: String(port),
    MEDIACLAW_AGENT_STATE_DIR: stateDirectory,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {protocolVersion: "2025-11-25"},
  })}\n`);
  const deadline = Date.now() + (downloadMode ? 10 * 60_000 : 15_000);
  let response = null;
  while (Date.now() < deadline && !response) {
    response = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .find((message) => message?.id === 1) || null;
    if (!response) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(response, `platform launcher did not initialize: ${stderr}`);
  assert.equal(response.result?.serverInfo?.version, packageJson.version);
  if (downloadMode) {
    await access(installedRuntime);
    await access(path.join(runtimeDirectory, "checksums.txt"));
    // The first source is the domestic mirror; a fallback to GitHub means the mirror is broken or incomplete.
    assert.doesNotMatch(stderr, /runtime source failed|无法从|校验失败|缺少/, `launcher fell back or failed: ${stderr}`);
  }
  console.log(`Platform launcher ${downloadMode ? "download " : ""}smoke passed for ${targetKey}.`);
} finally {
  child.stdin.end();
  if (process.platform === "win32" && child.pid) {
    const treeKill = spawn(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      {stdio: "ignore"},
    );
    await once(treeKill, "exit").catch(() => null);
  }
  if (child.exitCode === null) {
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (child.exitCode === null) child.kill("SIGTERM");
  let cleanupError = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await rm(temporaryRoot, {recursive: true, force: true});
      cleanupError = null;
      break;
    } catch (error) {
      cleanupError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (
    cleanupError &&
    !(process.platform === "win32" && cleanupError.code === "EPERM")
  ) {
    throw cleanupError;
  }
}
