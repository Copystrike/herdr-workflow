// AgentSource, first implementation: Claude Code. How to start and resume it, how a branch's
// terminals map onto a herdr space, and which terminals need a resume after a reboot.

import { hash31 } from "./paths.js";
import { readLabels, isWithin } from "./labels.js";

// A Claude started from inside another Claude's terminal inherits markers that turn transcript
// saving off (CLAUDE_CODE_CHILD_SESSION) and point at the parent's session; a herdr-core started
// from a Claude terminal hands them to every terminal. `launcher` is bin/claude, which unsets
// them and runs claude (named claude, so herdr still shows the terminal as Claude).
export const inheritedClaudeVars = env => Object.keys(env ?? {}).filter(k => k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_"));

// The session's display name (Claude's /resume picker, its prompt box and the terminal title), as
// Termic names it: the worktree folder, lowercased, every other run of characters one "-". Also
// given on --resume <id>, so a resumed session keeps it.
export const sessionNameFor = worktree => (worktree ?? "").replace(/\/+$/, "").split("/").pop()
  .toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
const nameArgs = name => (name ? ["--name", name] : []);

export const claudeArgv = (sessionId, launcher = "claude", name = null) => [launcher, "--session-id", sessionId, ...nameArgs(name)];
export const resumeCommand = (sessionId, launcher = "claude", name = null) => [launcher, "--resume", sessionId, ...nameArgs(name)].join(" ");

// One herdr space per worktree, with an id derived from its path: the same branch always lands in
// the same space, and the app finds it again without storing anything.
export const spaceIdFor = path => `wfsp${Math.abs(hash31(path)).toString(36)}${Math.abs(hash31(path + "#")).toString(36)}`;

// The space showing a worktree's terminals: the derived id, else any space whose panes sit in it.
export function spaceForWorktree(spaces, panes, path) {
  const id = spaceIdFor(path);
  const own = spaces.find(s => s.id === id);
  if (own) return own;
  return spaces.find(s => s.tabs.some(t => panes.some(p => p.tab === t.id && isWithin(p.cwd, path)))) ?? null;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "xonsh", "pwsh"]);
const fgName = t => t.foreground?.name ?? (Array.isArray(t.foreground?.argv) ? t.foreground.argv[0].split("/").pop() : null);

// A Claude terminal whose program is gone and a shell sits in its place (herdr brings lost
// terminals back as shells after a reboot): resume its session there.
export function needsResume(t) {
  if (t.state && t.state !== "live") return false;
  const l = readLabels(t.labels);
  if (!l?.session || l.role !== "task") return false;
  const fg = fgName(t);
  return fg ? SHELLS.has(fg) : false;
}

// Statuses from `hc get --json` ({app, state}) and from herdr's terminals() (a word).
export const statusWord = s => (typeof s === "string" ? s : s?.state ?? null);
