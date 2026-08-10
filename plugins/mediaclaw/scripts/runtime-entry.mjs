#!/usr/bin/env node

if (process.argv.includes("--broker")) {
  await import("./broker-server.mjs");
} else {
  await import("./mcp-server.mjs");
}
