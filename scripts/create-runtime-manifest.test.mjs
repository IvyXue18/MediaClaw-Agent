import assert from "node:assert/strict";
import test from "node:test";
import {createRuntimeManifest} from "./create-runtime-manifest.mjs";

const assets = [
  "mediaclaw-agent-darwin-arm64",
  "mediaclaw-agent-darwin-x64",
  "mediaclaw-agent-linux-arm64",
  "mediaclaw-agent-linux-arm64-musl",
  "mediaclaw-agent-linux-x64",
  "mediaclaw-agent-linux-x64-musl",
  "mediaclaw-agent-windows-arm64.exe",
  "mediaclaw-agent-windows-x64.exe",
];

test("runtime manifest maps every supported environment to a verified asset", () => {
  const checksums = assets
    .map((asset, index) => `${String(index + 1).padStart(64, "0")}  ${asset}`)
    .join("\n");
  const manifest = createRuntimeManifest({version: "0.3.1", checksums});
  assert.equal(manifest.version, "0.3.1");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-arm64-musl",
    "linux-x64",
    "linux-x64-musl",
    "windows-arm64",
    "windows-x64",
  ]);
  assert.equal(
    manifest.platforms["windows-x64"].asset,
    "mediaclaw-agent-windows-x64.exe",
  );
});

test("runtime manifest refuses an incomplete release", () => {
  assert.throws(
    () => createRuntimeManifest({version: "0.3.1", checksums: ""}),
    /missing checksum/,
  );
});
