// The wf-lib wiring inside a herdr mod: herdr's exec and fs, the shared settings, and track().
// Not exported from index.js: the node tests never import "herdr".
import { exec as herdrExec, readTextFile, writeTextFile, appHome, home, shared } from "herdr";
import * as fs from "fs/promises";
import { createTracker } from "./telemetry.js";

export { fs };
export const CI_CACHE_DIR = `${appHome()}/data/wf/ci-cache`;
export const WF_CONFIG_PATH = `${appHome()}/wf/config.json`;

// "git status", "gh pr": the program and its first plain-word argument, never a path or a value.
export function commandName(cmd, args) {
  const sub = args.find(a => !a.startsWith("-") && !a.includes("="));
  return /^[a-z][a-z-]{0,30}$/.test(sub ?? "") ? `${cmd.split("/").pop()} ${sub}` : cmd.split("/").pop();
}

// exec that records each call's program, subcommand, duration and exit (never its arguments).
let tracker = null;
export function exec(cmd, args = [], opts = {}) {
  const t0 = Date.now();
  return herdrExec(cmd, args, opts).then(r => {
    const ms = Date.now() - t0;
    if (r.code !== 0 || ms > 2000) track("exec", { cmd: commandName(cmd, args), ms, exit: r.code, bytes: r.stdout.length });
    return r;
  }, e => { track("exec", { cmd: commandName(cmd, args), ms: Date.now() - t0, exit: -1 }); throw e; });
}

// Optional per-machine overrides in ~/.config/herdr-app/wf/config.json (keeps personal workspace
// paths outside this repository while staying shared between the mods and the wf CLI).
let localConfig = {};
let localConfigLoaded = false;

export async function loadLocalConfig() {
  if (localConfigLoaded) return localConfig;
  localConfigLoaded = true;
  try {
    const raw = await readTextFile(WF_CONFIG_PATH);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (Array.isArray(parsed["wf.workspaces"])) {
          parsed["wf.workspaces"] = parsed["wf.workspaces"].map(p => String(p).replace(/^~(?=\/|$)/, home()));
        }
        localConfig = parsed;
      }
    }
  } catch { /* optional file */ }
  return localConfig;
}

// Settings live in shared state (or local wf/config.json) so every wf mod sees one value.
export const DEFAULTS = {
  // A workspace folder (its repos/* are listed) or a repository folder itself.
  "wf.workspaces": [`${home()}/Projects`],
  "wf.telemetry": true,
};
export const setting = k => shared(k) ?? localConfig[k] ?? DEFAULTS[k];

const TELEMETRY_DIR = `${appHome()}/data/wf/telemetry`;
let dirReady = false;
function getTracker() {
  if (!tracker) tracker = createTracker(TELEMETRY_DIR, {
    readTextFile: p => readTextFile(p),
    writeTextFile: async (p, text, expected) => {
      if (!dirReady) { await fs.mkdir(TELEMETRY_DIR, { recursive: true }).catch(() => {}); dirReady = true; }
      return writeTextFile(p, text, expected);
    },
    enabled: () => setting("wf.telemetry") !== false,
  });
  return tracker;
}
export const track = (event, fields) => getTracker().track(event, fields);
export const flushTelemetry = () => getTracker().flush().catch(() => 0);

// The wf CLI (bin/wf.mjs), installed beside the mods. Prints one JSON object; {error} on failure.
export const WF_CLI = `${appHome()}/wf/bin/wf.mjs`;
export async function wf(args) {
  const t0 = Date.now();
  const r = await herdrExec("node", [WF_CLI, ...args]);
  track("exec", { cmd: commandName("wf", args), ms: Date.now() - t0, exit: r.code });
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); }
  catch { return { error: (r.stderr || r.stdout || "wf failed").trim().split("\n").pop() }; }
}
