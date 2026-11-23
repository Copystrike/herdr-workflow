#!/usr/bin/env node
// Claude Code statusLine hook for herdr-workflow:
//   - Captures live context_window, 5h/7d rate_limits, and cost into ~/.config/herdr-app/data/wf/usage.json
//   - Preserves Termic compatibility by forwarding the raw stdin payload to ~/.claude/termic-hooks/usage.sh
//     whenever TERMIC_TASK_ID is set.
//   - Prints NOTHING to stdout and always exits 0 so it never clutters or stalls Claude.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseClaudeStatusPayload, mergeUsageStore } from "../wf-lib/usage.js";

function readAllStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

const raw = readAllStdin();

try {
  const sample = parseClaudeStatusPayload(raw);
  if (sample) {
    const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
    const storePath = join(appHome, "data/wf/usage.json");
    let prev = null;
    try {
      if (existsSync(storePath)) prev = JSON.parse(readFileSync(storePath, "utf8"));
    } catch {}
    const next = mergeUsageStore(prev, sample, Date.now());
    mkdirSync(dirname(storePath), { recursive: true });
    const tmp = `${storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    renameSync(tmp, storePath);
  }
} catch {
  // Never fail a statusLine hook.
}

// Forward to Termic's usage hook when running inside a Termic PTY so both apps work seamlessly.
try {
  if (process.env.TERMIC_TASK_ID) {
    const termicHook = join(homedir(), ".claude/termic-hooks/usage.sh");
    if (existsSync(termicHook)) {
      spawnSync(termicHook, [], { input: raw, stdio: ["pipe", "ignore", "ignore"], timeout: 2000 });
    }
  }
} catch {}

process.exit(0);
