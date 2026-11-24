import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/release.yml", "utf8");

test("macOS runtimes are re-signed and strictly verified before smoke, attestation and upload", () => {
  const build = workflow.indexOf("name: Build standalone runtime");
  const resign = workflow.indexOf("name: Re-sign macOS runtime");
  const smoke = workflow.indexOf("name: Smoke test MCP and browser WebSocket transport");
  const attest = workflow.indexOf("name: Attest runtime provenance");
  assert.ok(build >= 0 && resign > build, "re-sign must follow the Bun build");
  assert.ok(smoke > resign && attest > resign, "re-sign must precede smoke tests and attestation");

  const step = workflow.slice(resign, smoke);
  assert.match(step, /if: \$\{\{ runner\.os == 'macOS' \}\}/);
  assert.match(step, /codesign --force --sign - dist\/\$\{\{ matrix\.asset \}\}/);
  assert.match(step, /codesign --verify --strict/);
});
