import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const TARGETS = {
  "darwin-arm64": "mediaclaw-agent-darwin-arm64",
  "darwin-x64": "mediaclaw-agent-darwin-x64",
  "linux-arm64": "mediaclaw-agent-linux-arm64",
  "linux-arm64-musl": "mediaclaw-agent-linux-arm64-musl",
  "linux-x64": "mediaclaw-agent-linux-x64",
  "linux-x64-musl": "mediaclaw-agent-linux-x64-musl",
  "windows-arm64": "mediaclaw-agent-windows-arm64.exe",
  "windows-x64": "mediaclaw-agent-windows-x64.exe",
};

export function createRuntimeManifest({version, checksums}) {
  const checksumByAsset = new Map(
    String(checksums || "")
      .split(/\r?\n/)
      .map((line) => /^(\S+)\s+\*?(.+)$/.exec(line.trim()))
      .filter(Boolean)
      .map((match) => [match[2], match[1].toLowerCase()]),
  );
  const platforms = {};
  for (const [platform, asset] of Object.entries(TARGETS)) {
    const sha256 = checksumByAsset.get(asset);
    if (!sha256) throw new Error(`missing checksum for ${asset}`);
    platforms[platform] = {asset, sha256};
  }
  return {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    platforms,
  };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputPath = path.resolve(process.argv[2] || path.join(root, "dist", "runtime-manifest.json"));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const checksums = await fs.readFile(path.join(path.dirname(outputPath), "checksums.txt"), "utf8");
  const manifest = createRuntimeManifest({version: packageJson.version, checksums});
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
