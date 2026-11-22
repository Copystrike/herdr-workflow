// F4 on disk: Claude Code transcripts for the wf CLI. Lists a folder's sessions with counts kept
// in a cache (counts, titles and read offsets only, never prompt text), reads Claude's last
// answer from the tail of a transcript, and copies a session into another folder so it can be
// resumed there (Claude only finds a session under the project folder of its cwd).
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as wf from "../wf-lib/index.js";

const HEAD_BYTES = 256 * 1024; // the first prompt is almost always in here
const HEAD_MAX = 4 * 1024 * 1024; // a long skill body can push it further
const TAIL_BYTES = 512 * 1024;
const TAIL_MAX = 16 * 1024 * 1024;
const ANSWER_SHOWN = 4000;

// bin/claude keeps CLAUDE_CONFIG_DIR, so the Claudes wf starts use it when it is set.
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
const appHome = () => process.env.HERDR_APP_HOME || `${homedir()}/.config/herdr-app`;
const cachePath = () => `${appHome()}/data/wf/sessions-cache.json`;

function readRange(file, start, length) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}

const resolved = p => { try { return realpathSync(p); } catch { return p; } };

// Transcript folders of a cwd: the stored path and, when a symlink, the resolved one.
export const projectDirsOf = path => wf.claudeProjectDirs(claudeConfigDir(), path, resolved(path)).filter(existsSync);
export const projectDirOf = path => wf.claudeProjectDirs(claudeConfigDir(), resolved(path))[0];

function loadCache() {
  try {
    const c = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (c?.v === 1 && c.files) return c;
  } catch { /* first run or unreadable: start over */ }
  return { v: 1, files: {} };
}

function saveCache(cache) {
  const p = cachePath();
  mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true });
  // Per-PID temp file prevents ENOENT when two `wf sessions` processes save concurrently.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
  renameSync(tmp, p);
}

// Counts for one transcript, reading only what was added since the cached offset.
function countsOf(cache, file, st) {
  let c = cache.files[file];
  if (!c || st.size < c.offset) c = wf.emptyCounts();
  if (c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
    while (c.offset < st.size) {
      const chunk = readRange(file, c.offset, Math.min(st.size - c.offset, 32 * 1024 * 1024));
      const used = wf.addLines(c, chunk);
      if (!used) break;
      c.offset += Buffer.byteLength(chunk.slice(0, used));
    }
    c.size = st.size; c.mtimeMs = st.mtimeMs;
  }
  cache.files[file] = c;
  return c;
}

function firstPromptOf(file, size) {
  for (let n = HEAD_BYTES; ; n *= 4) {
    const head = readRange(file, 0, Math.min(n, size));
    const p = wf.firstPrompt(head.slice(0, head.lastIndexOf("\n") + 1));
    if (p || n >= size || n >= HEAD_MAX) return p;
  }
}

// Sessions in the given transcript folders, newest first. `limit` keeps the head read cheap
// for a repository with hundreds of sessions; counts for the rest stay cached.
export function listSessions(dirs, { limit = Infinity } = {}) {
  const cache = loadCache();
  const found = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = `${dir}/${name}`;
      const st = statSync(file);
      if (st.size) found.push({ file, dir, id: name.slice(0, -6), st });
    }
  }
  found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const sessions = found.slice(0, limit).map(({ file, dir, id, st }) => {
    const c = countsOf(cache, file, st);
    const prompt = firstPromptOf(file, st.size);
    return {
      id, file, dir, cwd: c.cwd, title: wf.sessionTitle(c, prompt), prompt: wf.shortPrompt(prompt),
      prompts: c.prompts, compactions: c.compactions, last: Math.round(st.mtimeMs), size: st.size,
    };
  });
  for (const f of Object.keys(cache.files)) if (!existsSync(f)) delete cache.files[f];
  saveCache(cache);
  return { sessions, total: found.length };
}

// Transcript folders of a repository that belong to no current worktree: the repository folder
// itself (sessions started there) and worktrees since removed. Matched by folder name, then by
// the cwd the transcripts record, so a sibling repository sharing the prefix is left out.
export function repoSessionDirs(repoDir, worktrees) {
  const root = `${claudeConfigDir()}/projects`;
  if (!existsSync(root)) return [];
  const own = new Set(worktrees.flatMap(w => wf.claudeProjectDirs(claudeConfigDir(), w, resolved(w))).map(d => d.split("/").pop()));
  const prefix = wf.claudeProjectDirName(repoDir);
  return readdirSync(root)
    .filter(n => (n === prefix || n.startsWith(`${prefix}-`)) && !own.has(n))
    .map(n => `${root}/${n}`);
}

export const insideRepo = (cwd, repoDir) => !cwd || cwd === repoDir || cwd.startsWith(`${repoDir}/`);

// Claude's last answer in a transcript, read from its end.
export function lastAnswerOf(file) {
  const size = statSync(file).size;
  for (let n = TAIL_BYTES; ; n *= 4) {
    const start = Math.max(0, size - n);
    let tail = readRange(file, start, size - start);
    if (start > 0) tail = tail.slice(tail.indexOf("\n") + 1);
    const text = wf.lastAnswer(tail);
    if (text || start === 0 || n >= TAIL_MAX) return text && text.length > ANSWER_SHOWN ? `${text.slice(0, ANSWER_SHOWN - 1)}…` : text;
  }
}

// Reads the current display title of a single transcript (customTitle > aiTitle > firstPrompt).
export function sessionTitleOf(file) {
  if (!file || !existsSync(file)) return null;
  const st = statSync(file);
  if (!st.size) return null;
  const cache = loadCache();
  const c = countsOf(cache, file, st);
  saveCache(cache);
  if (c.title) return c.title;
  if (c.aiTitle) return c.aiTitle;
  const prompt = firstPromptOf(file, st.size);
  return wf.shortPrompt(prompt) || null;
}

// Appends Claude Code's native `custom-title` record to a transcript so renaming an inactive
// session in Herdr stays persisted and carries over when Claude resumes it.
export function setTranscriptTitle(file, sessionId, title) {
  const rec = JSON.stringify({ type: "custom-title", customTitle: title, sessionId });
  appendFileSync(file, `\n${rec}\n`, "utf8");
}

// Removes a Claude session transcript (and its sidecar folder, if any) from Claude's project
// folder by moving it into `<appHome>/data/wf/removed-sessions/` and purging it from the cache.
export function removeSessionFiles(file) {
  if (!file || !existsSync(file)) return { removed: false };
  const trashDir = `${appHome()}/data/wf/removed-sessions`;
  mkdirSync(trashDir, { recursive: true });
  const base = file.split("/").pop();
  const stamp = Date.now();
  const dest = `${trashDir}/${stamp}-${base}`;
  try { renameSync(file, dest); }
  catch { cpSync(file, dest); unlinkSyncSafe(file); }
  const sidecar = file.slice(0, -6);
  if (existsSync(sidecar)) {
    const sideDest = `${trashDir}/${stamp}-${base.slice(0, -6)}`;
    try { renameSync(sidecar, sideDest); }
    catch { cpSync(sidecar, sideDest, { recursive: true }); rmSyncSafe(sidecar); }
  }
  const cache = loadCache();
  if (cache.files[file]) { delete cache.files[file]; saveCache(cache); }
  return { removed: true, movedTo: dest };
}

const unlinkSyncSafe = p => { try { unlinkSync(p); } catch {} };
const rmSyncSafe = p => { try { rmSync(p, { recursive: true, force: true }); } catch {} };

// Makes a session resumable from `worktree`: copies its transcript and its sidecar folder
// (sub-agents, tool results) into the worktree's project folder. A session already there is
// left as it is. Returns whether it copied.
export function copySessionInto(file, worktree) {
  const target = projectDirOf(worktree);
  const name = file.split("/").pop();
  if (file.startsWith(`${target}/`) || existsSync(`${target}/${name}`)) return false;
  mkdirSync(target, { recursive: true });
  cpSync(file, `${target}/${name}`);
  const sidecar = file.slice(0, -6);
  if (existsSync(sidecar)) cpSync(sidecar, `${target}/${name.slice(0, -6)}`, { recursive: true });
  return true;
}
