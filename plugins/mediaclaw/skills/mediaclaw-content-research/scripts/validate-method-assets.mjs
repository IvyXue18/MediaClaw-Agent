#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");
const pluginDir = path.resolve(skillDir, "../..");
const registryPath = path.join(pluginDir, "contracts", "methods-v1.json");
const mcpContractPath = path.join(pluginDir, "contracts", "mcp-v1.json");
const skillPath = path.join(skillDir, "SKILL.md");

const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const mcpContract = JSON.parse(fs.readFileSync(mcpContractPath, "utf8"));
const skill = fs.readFileSync(skillPath, "utf8");
const entries = [
  registry.framework,
  registry.qualityGate,
  ...registry.methods,
];
const errors = [];
const seenIds = new Set();

for (const entry of entries) {
  if (!entry?.id || !entry?.version || !entry?.reference) {
    errors.push(`incomplete registry entry: ${JSON.stringify(entry)}`);
    continue;
  }
  if (seenIds.has(entry.id)) {
    errors.push(`duplicate method id: ${entry.id}`);
  }
  seenIds.add(entry.id);
  if (!/^\d+\.\d+\.\d+$/u.test(entry.version)) {
    errors.push(`invalid method version for ${entry.id}: ${entry.version}`);
  }

  const referencePath = path.join(skillDir, entry.reference);
  if (!fs.existsSync(referencePath)) {
    errors.push(`missing reference for ${entry.id}: ${entry.reference}`);
    continue;
  }
  const reference = fs.readFileSync(referencePath, "utf8");
  if (!reference.includes(`Method ID: \`${entry.id}\``)) {
    errors.push(`reference does not declare method id ${entry.id}`);
  }
  if (!reference.includes(`Version: \`${entry.version}\``)) {
    errors.push(
      `reference ${entry.reference} does not declare version ${entry.version}`,
    );
  }
  if (!skill.includes(`(${entry.reference})`)) {
    errors.push(`SKILL.md does not link directly to ${entry.reference}`);
  }
}

const registryMethods = new Map(
  registry.methods.map((method) => [method.id, method]),
);
for (const tool of mcpContract.tools || []) {
  if (!tool.methodId) continue;
  const method = registryMethods.get(tool.methodId);
  if (!method) {
    errors.push(
      `MCP tool ${tool.name} references unknown method ${tool.methodId}`,
    );
    continue;
  }
  if (tool.methodVersion !== method.version) {
    errors.push(
      `MCP tool ${tool.name} uses ${tool.methodVersion || "no version"}; ` +
        `registry requires ${method.version}`,
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`[method-assets] ${error}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `[method-assets] ok: ${entries.length} versioned assets validated\n`,
  );
}
