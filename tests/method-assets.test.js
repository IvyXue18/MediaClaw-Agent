import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const validatorPath = path.join(
  projectRoot,
  "plugins",
  "mediaclaw",
  "skills",
  "mediaclaw-content-research",
  "scripts",
  "validate-method-assets.mjs",
);

test("MediaClaw method assets stay aligned with Skill routes and the MCP contract", () => {
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `${result.stdout || ""}${result.stderr || ""}`,
  );
  assert.match(result.stdout, /12 versioned assets validated/);
});
