import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The .cmd launchers are sh/cmd polyglots. The kernel needs an LF-terminated shebang, and
// cmd.exe mis-jumps after `goto windows` in an LF-only file (it resumed mid-line at
// "ON=v0.4.2" on a Windows user's machine). Git must not convert them: the domestic mirror
// zip comes from `git archive` and Windows CI checkouts must test the published bytes.
const scripts = path.resolve("plugins/mediaclaw/scripts");
const launchers = ["launch-agent.cmd", "launch-agent-local.cmd"];

function assertPolyglotLayout(bytes, name) {
  const text = bytes.toString("utf8");
  assert.ok(text.startsWith("#!/bin/sh\n"), `${name}: shebang must end in a bare LF`);
  const rest = text.slice("#!/bin/sh\n".length);
  assert.ok(rest.endsWith("\r\n"), `${name}: must end in CRLF`);
  const lines = rest.slice(0, -2).split("\r\n");
  for (const line of lines) {
    assert.ok(!line.includes("\n") && !line.includes("\r"), `${name}: every line after the shebang ends in CRLF`);
  }
  const label = lines.indexOf(":windows");
  assert.ok(label > 0, `${name}: has a :windows label`);
  for (const line of lines.slice(0, label)) {
    assert.match(line, /(^|\s)#$/, `${name}: sh line must end in a comment so the CR is ignored: ${line}`);
  }
}

test("polyglot launchers keep an LF shebang and CRLF everywhere else", () => {
  for (const name of launchers) {
    assertPolyglotLayout(fs.readFileSync(path.join(scripts, name)), name);
  }
});

test("git stores and exports the launchers byte for byte", () => {
  for (const name of launchers) {
    const file = path.join("plugins/mediaclaw/scripts", name);
    const attr = execFileSync("git", ["check-attr", "text", "--", file], {encoding: "utf8"});
    assert.match(attr, /: text: unset$/m, `${name} must be marked -text in .gitattributes`);
    // Store the file the way a commit would, then read it back through the same filters
    // `git archive` and a Windows checkout apply.
    const blob = execFileSync("git", ["hash-object", "-w", `--path=${file}`, file], {encoding: "utf8"}).trim();
    const exported = execFileSync("git", ["-c", "core.autocrlf=true", "cat-file", "--filters", `--path=${file}`, blob]);
    assertPolyglotLayout(exported, `${name} (exported)`);
  }
});
