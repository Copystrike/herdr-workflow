#!/usr/bin/env node
// wf: the workflow CLI (F9). The mods call it for anything that starts terminals or touches git;
// agents will call it the same way. Every command prints one JSON object.
//
//   wf open    --worktree <path> [--claude [--code-mode] | --shell | --agent <name> -- <argv...>]
//              [--repo <name>] [--branch <b>] [--role <role>] [--focus]
//              [--resume <session> [--file <transcript>]]
//   wf stop    --worktree <path> | --terminal <address>
//   wf remove-session [--terminal <address>] [--worktree <path>] [--session <id>] [--file <transcript>]
//   wf rename  (--terminal <address> [--tab <id>] | --file <transcript> --session <id>) --name <title>
//   wf resume  --worktree <path>
//   wf sessions --worktree <path> | --repo <dir>
//   wf answer  --file <transcript>
//   wf projects
//   wf list    [--repo <name|dir>] [--branch <b>] [--all]
//   wf status  [--terminal <address> | --worktree <path> | --repo <name|dir>]
//   wf new     --repo <name|dir> [--branch <name>] [--base <ref>] [--prompt <text> | --prompt-file <file>]
//              [--wait <s>] [--no-wait] [--dry-run] [--focus] [-- <pasted text>]
//   wf deliver --terminal <t> --repo <name|dir> --branch <b> --kind issue|pr|text|command [--wait <s>] -- <ref or text>
//   wf send    --terminal <address> (--prompt <text> | --prompt-file <file> | -- <text>) [--wait <s>] [--force]
//   wf logs    --terminal <address> [--lines <n>]
//   wf diff    --worktree <path> [--base <ref>] [--full]
//   wf result  --terminal <address> | --worktree <path>
//
// Prompts are built in memory and handed to `hc send`; nothing writes them to disk.
import { randomUUID } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { exec, fs } from "./node-adapter.mjs";
import * as wf from "../wf-lib/index.js";
import { listSessions, projectDirsOf, repoSessionDirs, insideRepo, lastAnswerOf, copySessionInto, claudeConfigDir, sessionTitleOf, setTranscriptTitle, removeSessionFiles } from "./sessions.mjs";
import { runExplain } from "./explain.mjs";

// Starts claude without a parent session's markers; see bin/claude.
const CLAUDE = fileURLToPath(new URL("./claude", import.meta.url));

const out = o => { process.stdout.write(JSON.stringify(o) + "\n"); };
const fail = (message, extra = {}) => { out({ error: message, ...extra }); process.exit(1); };

function parseArgs(argv) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const k = a.slice(2), next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[k] = true; else { opts[k] = next; i++; }
    } else rest.push(a);
  }
  return { opts, rest };
}

const run = async (cmd, args, o) => {
  const r = await exec(cmd, args, o);
  if (r.code !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  return r.stdout;
};
const json = async (cmd, args, o) => JSON.parse(await run(cmd, args, o));
// herdr-app is optional: without a window the terminals still run and show up when it opens.
const app = (name, args) => exec("herdr-app", ["do", name, JSON.stringify(args)]).then(r => r.code === 0, () => false);

function readLocalWfConfig() {
  const appHome = process.env.HERDR_APP_HOME || `${homedir()}/.config/herdr-app`;
  for (const file of [`${appHome}/wf/config.json`, `${appHome}/settings.json`]) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* try next */ }
  }
  return {};
}

function configuredWorkspaces() {
  const cfg = readLocalWfConfig();
  const ws = cfg["wf.workspaces"] ?? cfg.wf?.workspaces;
  if (Array.isArray(ws) && ws.length) return ws.map(p => String(p).replace(/^~(?=\/|$)/, homedir()));
  const defaults = [`${homedir()}/Projects`];
  return defaults.filter(d => existsSync(d));
}

async function discoverProjects() {
  const seen = new Set();
  const projects = [];
  for (const root of configuredWorkspaces()) {
    for (const r of await wf.listRepos(fs, root)) {
      if (seen.has(r.dir)) continue;
      seen.add(r.dir);
      const info = await wf.repoInfo(exec, r.dir).catch(() => null);
      const bare = (await exec("git", ["rev-parse", "--is-bare-repository"], { cwd: r.dir }).catch(() => ({ stdout: "" }))).stdout.trim() === "true";
      projects.push({
        name: r.name,
        dir: r.dir,
        workspace: root,
        slug: info ? wf.repoSlugFromUrl(info.remoteUrl) : null,
        base: info?.base ?? null,
        bare,
      });
    }
  }
  return projects;
}

async function resolveRepoDir(repoArg) {
  if (!repoArg) fail("--repo is required");
  const expanded = String(repoArg).replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "");
  if (existsSync(expanded)) return expanded;
  for (const root of configuredWorkspaces()) {
    for (const cand of [`${root}/repos/${expanded}`, `${root}/${expanded}`]) {
      if (existsSync(cand)) return cand;
    }
  }
  const all = await discoverProjects();
  const hit = all.find(p => p.name === expanded || p.slug === expanded);
  if (hit) return hit.dir;
  fail("repository not found", { repo: repoArg });
}

function readPromptArg(opts, rest) {
  if (typeof opts["prompt-file"] === "string") {
    const p = opts["prompt-file"].replace(/^~(?=\/|$)/, homedir());
    if (!existsSync(p)) fail("no such prompt file", { file: p });
    return readFileSync(p, "utf8");
  }
  if (typeof opts.prompt === "string") return opts.prompt;
  if (rest?.length) return rest.join(" ");
  return null;
}

async function sendPromptToTerminal(terminal, prompt, { wait = 25, force = false } = {}) {
  if (force || Number(wait) <= 0) {
    const sent = await exec("hc", ["send", terminal, prompt]);
    if (sent.code !== 0) fail(`hc send failed: ${(sent.stderr || sent.stdout).trim()}`, { terminal });
    return { delivered: true, terminal, forced: true };
  }
  const until = Date.now() + Number(wait) * 1000;
  let status = null;
  while (Date.now() < until) {
    status = wf.statusWord((await json("hc", ["get", terminal, "--json"])).status);
    if (status === "idle") {
      const sent = await exec("hc", ["send", "--if", "idle", terminal, prompt]);
      if (sent.code === 0) return { delivered: true, terminal, status };
    }
    await new Promise(res => setTimeout(res, 1000));
  }
  return { delivered: false, terminal, status };
}

async function repoFacts(dir) {
  const info = await wf.repoInfo(exec, dir);
  if (!info) fail("not a git repository", { repo: dir });
  const bare = (await exec("git", ["rev-parse", "--is-bare-repository"], { cwd: dir })).stdout.trim() === "true";
  return { ...info, bare, slug: wf.repoSlugFromUrl(info.remoteUrl), name: dir.replace(/\/+$/, "").split("/").pop() };
}

// ------------------------------------------------------------------ open

// A transcript the CLI may read or copy: a .jsonl under Claude's projects folder.
const transcript = file => {
  if (typeof file !== "string" || !file.endsWith(".jsonl") || file.includes("/../") || !file.startsWith(`${claudeConfigDir()}/projects/`)) fail("not a Claude transcript", { file });
  if (!existsSync(file)) fail("no such transcript", { file });
  return file;
};

// Detects whether a Claude transcript was started in experimental Code Mode
// (recorded as `{"type":"repl-mode","replMode":true,...}` near the top of the JSONL).
function isCodeModeTranscript(file) {
  if (!file || !existsSync(file)) return false;
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").includes('"replMode":true');
  } catch { return false; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

function findTranscript(worktree, sessionId) {
  if (!sessionId) return null;
  for (const dir of projectDirsOf(worktree)) {
    const p = `${dir}/${sessionId}.jsonl`;
    if (existsSync(p)) return p;
  }
  return null;
}

// With `resume`, the Claude resumes that session (copied here first when `file` lies in another
// project folder) instead of starting a new one; it keeps its id, so the label is right at once.
// Automatically enables Code Mode when resuming a session that was started with replMode:true.
// With `agent` + `agentArgv`, starts any installed AI CLI (Codex, Gemini, Antigravity, Pi, ...)
// in that worktree's space so it shows attached to the branch.
async function open({ worktree, kind, codeMode, agent, agentArgv, repo, branch, role, focus, resume, file }) {
  if (!existsSync(worktree)) fail("no such worktree", { worktree });
  const copied = resume && file ? copySessionInto(transcript(file), worktree) : false;
  const resumeFile = resume ? (file ? transcript(file) : findTranscript(worktree, resume)) : null;
  const existingTitle = resumeFile ? sessionTitleOf(resumeFile) : null;
  const useCodeMode = Boolean(codeMode || (resumeFile && isCodeModeTranscript(resumeFile)));
  const space = wf.spaceIdFor(worktree);
  const existed = (await exec("hc", ["ls", "--json", "--label", `herdr.space=${space}`])).stdout.trim().length > 2;
  const tab = `wft${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const session = kind === "claude" ? resume || randomUUID() : null;
  const fallbackName = wf.sessionNameFor(worktree);
  const displayName = existingTitle || fallbackName;
  let argv = [];
  if (kind === "claude") {
    // On resume, omit --name when the transcript already has a title so we never clobber a /rename.
    const raw = resume
      ? [CLAUDE, "--resume", session, ...(existingTitle ? [] : ["--name", fallbackName])]
      : wf.claudeArgv(session, CLAUDE, fallbackName);
    argv = useCodeMode ? [raw[0], "--wf-code-mode", ...raw.slice(1)] : raw;
  } else if (kind === "agent" && Array.isArray(agentArgv) && agentArgv.length) {
    argv = agentArgv;
  }
  const effectiveRole = role || (kind === "shell" ? "shell" : branch ? "task" : "orchestrator");
  const labels = wf.labelArgs({ repo, branch, worktree, session, role: effectiveRole });
  const started = await json("hc", ["run", "--json", "--bg", "--keep", "--no-parent", "--cwd", worktree,
    "--label", `herdr.space=${space}`, "--label", `herdr.tab=${tab}`, ...labels, ...(argv.length ? ["--", ...argv] : [])]);
  const tabTitle = kind === "claude" ? (displayName || "Claude") : kind === "agent" ? (agent || argv[0] || "Agent") : "Terminal";
  // The space and tab appear once herdr reads the labels; name them, then show them.
  for (let i = 0; i < 10; i++) {
    if (await app("tab.rename", { id: tab, name: tabTitle })) break;
    await new Promise(r => setTimeout(r, 150));
  }
  if (!existed && (branch || repo)) await app("space.rename", { id: space, name: branch || repo });
  if (focus) { await app("space.select", { id: space }); await app("tab.select", { id: tab }); }
  // Catch immediate startup failures (e.g. bad CLI flags or missing session) so the UI can report them.
  await new Promise(r => setTimeout(r, 400));
  const check = await exec("hc", ["get", started.address, "--json"]).then(r => r.code === 0 ? JSON.parse(r.stdout) : null, () => null);
  if (check && check.state === "finished" && check.exit_code && check.exit_code !== 0) {
    const screen = await exec("hc", ["read", started.address, "--lines", "12"]).then(r => r.stdout.trim(), () => "");
    const firstLine = screen.split("\n").map(l => l.trim()).find(Boolean) || `exited with code ${check.exit_code}`;
    fail(firstLine, { terminal: started.address, exit_code: check.exit_code });
  }
  return { space, tab, terminal: started.address, session, worktree, codeMode: useCodeMode, ...(resume ? { resumed: true, copied } : {}) };
}

// ------------------------------------------------------------------ stop

// Stops live hc terminal(s) and frees their memory without touching transcripts or worktrees:
// Claude sessions immediately return to the branch's resumable session list.
async function stop({ worktree, terminal }) {
  const targets = [];
  if (terminal) {
    targets.push(terminal);
  } else if (worktree) {
    const raw = (await exec("hc", ["ls", "--json"])).stdout || "[]";
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.terminals || parsed.items || []);
    for (const t of wf.terminalsIn(list, worktree)) targets.push(t.address);
  }
  const stopped = [];
  for (const addr of targets) {
    const k = await exec("hc", ["kill", addr]);
    if (k.code === 0) {
      stopped.push(addr);
      await exec("hc", ["rm", addr]).catch(() => {});
    }
  }
  return { stopped, worktree: worktree ?? null, terminal: terminal ?? null };
}

// ------------------------------------------------------------------ remove-session

// Removes a session from a branch: stops the live terminal (if active) and moves its Claude
// transcript (+ sidecar folder) out of Claude's project dir into `<appHome>/data/wf/removed-sessions/`.
async function removeSession({ terminal, worktree, session, file }) {
  let sid = session || null;
  let wt = worktree || null;
  if (terminal) {
    const info = await exec("hc", ["get", terminal, "--json"]).then(r => r.code === 0 ? JSON.parse(r.stdout) : null, () => null);
    const lbl = wf.readLabels(info?.labels);
    if (!sid && lbl?.session) sid = lbl.session;
    if (!wt && (lbl?.worktree || info?.cwd)) wt = lbl?.worktree || info?.cwd;
    await exec("hc", ["kill", terminal]);
    await exec("hc", ["rm", terminal]).catch(() => {});
  }
  const targetFile = file ? transcript(file) : (wt && sid ? findTranscript(wt, sid) : null);
  const res = targetFile ? removeSessionFiles(targetFile) : { removed: false };
  return { removed: Boolean(terminal || res.removed), terminal: terminal ?? null, session: sid, ...res };
}

// ------------------------------------------------------------------ rename

// Bi-directional rename from Herdr -> Claude Code CLI:
//   - Live Claude session: sends `/rename <name>` to the terminal via `hc send` and renames the tab.
//   - Inactive transcript: appends Claude's native `custom-title` record to the JSONL file.
async function renameSession({ terminal, tab, file, session, name }) {
  const clean = String(name ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!clean) fail("--name must not be empty");
  if (terminal) {
    const info = await exec("hc", ["get", terminal, "--json"]).then(r => r.code === 0 ? JSON.parse(r.stdout) : null, () => null);
    const isClaude = info?.status?.app === "claude-code"
      || info?.foreground?.name === "claude"
      || (Array.isArray(info?.argv) && info.argv.some(a => /(^|\/)claude$/.test(a)))
      || Boolean(wf.readLabels(info?.labels)?.session);
    if (isClaude) {
      const sent = await exec("hc", ["send", terminal, `/rename ${clean}`]);
      if (sent.code !== 0) fail(`hc send failed: ${(sent.stderr || sent.stdout).trim()}`);
    }
    const targetTab = tab || wf.labelMap(info?.labels)["herdr.tab"];
    if (targetTab) await app("tab.rename", { id: targetTab, name: clean });
    return { renamed: true, terminal, name: clean, sentCli: isClaude };
  }
  if (file && session) {
    setTranscriptTitle(transcript(file), session, clean);
    return { renamed: true, session, name: clean, file };
  }
  fail("--terminal or (--file and --session) is required");
}

// ------------------------------------------------------------------ resume

async function resume({ worktree }) {
  const list = JSON.parse((await exec("hc", ["ls", "--json", "--label", `worktree=${worktree}`])).stdout || "[]");
  const resumed = [];
  for (const t of Array.isArray(list) ? list : []) {
    const full = await json("hc", ["get", t.address, "--json"]);
    if (!wf.needsResume(full)) continue;
    const session = wf.readLabels(full.labels).session;
    const tFile = findTranscript(worktree, session);
    const cmd = isCodeModeTranscript(tFile)
      ? `${CLAUDE} --wf-code-mode --resume ${session} --name ${wf.sessionNameFor(worktree)}`
      : wf.resumeCommand(session, CLAUDE, wf.sessionNameFor(worktree));
    await run("hc", ["send", t.address, cmd]);
    resumed.push({ terminal: t.address, session });
  }
  return { worktree, resumed };
}

// ------------------------------------------------------------------ new

// Optional post-worktree hook (e.g. to copy gitignored .env files from the base worktree).
// Configured via WF_POST_WORKTREE_HOOK or ~/.config/herdr-app/wf/config.json `postWorktreeHook`.
function postWorktreeHook() {
  const raw = process.env.WF_POST_WORKTREE_HOOK || readLocalWfConfig().postWorktreeHook;
  if (!raw) return null;
  const resolved = String(raw).replace(/^~(?=\/|$)/, homedir());
  return existsSync(resolved) ? resolved : null;
}

async function propose(repoDir, text, branchOverride, baseOverride = null) {
  const r = await repoFacts(repoDir);
  const rawText = String(text ?? "").trim();
  const parsed = rawText ? wf.parseInput(rawText, r.slug) : (branchOverride ? { kind: "text", text: branchOverride } : { kind: "empty" });
  if (parsed.kind === "empty") fail("nothing pasted (pass pasted text, --branch, or --prompt)");
  if (parsed.kind === "issues") {
    const items = [];
    for (const i of parsed.issues) items.push(await propose(repoDir, i.url, null, baseOverride));
    return { kind: "issues", items };
  }
  const facts = {};
  if (parsed.kind === "issue") {
    if (parsed.issue.repo !== r.slug) fail(`issue is in ${parsed.issue.repo}, this repository is ${r.slug}`);
    facts.issue = await json("gh", ["issue", "view", String(parsed.issue.number), "--repo", r.slug, "--json", "number,title,labels,url,state"]);
  }
  if (parsed.kind === "pr") facts.pr = await json("gh", ["pr", "view", String(parsed.pr.number), "--repo", parsed.pr.repo, "--json", "number,title,headRefName,baseRefName,url,state"]);
  if (parsed.kind === "command") {
    const n = parsed.args.match(/(?:issues\/|#)(\d+)/)?.[1];
    if (n && r.slug) facts.issue = await json("gh", ["issue", "view", n, "--repo", r.slug, "--json", "number,title,labels,url,state"]).catch(() => null);
  }
  const branch = branchOverride || wf.proposeBranch(parsed, facts);
  if (!wf.validBranch(branch)) fail("could not make a branch name; pass --branch", { kind: parsed.kind });
  const path = wf.worktreePathFor(r.bare ? repoDir : r.worktrees[0]?.path ?? repoDir, r.bare, branch);
  const wt = r.worktrees.find(w => w.branch === branch);
  const exists = {
    worktree: wt?.path ?? null,
    local: r.branches.local.some(b => b.name === branch),
    remote: r.branches.remote.some(b => b.name === branch),
    folder: !wt && existsSync(path),
  };
  return {
    kind: parsed.kind, branch, base: baseOverride || r.base, worktree: wt?.path ?? path, repo: r.name, repoDir,
    title: facts.issue?.title ?? facts.pr?.title ?? null, ref: facts.issue?.url ?? facts.pr?.url ?? null,
    number: facts.issue?.number ?? facts.pr?.number ?? null,
    // Open the existing branch instead of making a twin. A PR's head is meant to exist remotely.
    existing: !!(exists.worktree || exists.local || exists.folder || (exists.remote && parsed.kind !== "pr")),
    exists,
  };
}

async function create(repoDir, p, { focus = false, baseOverride = null, prompt = null, wait = 25, noWait = false } = {}) {
  const r = await repoFacts(repoDir);
  if (p.exists.folder) fail("the folder exists but is not a worktree of this branch", { worktree: p.worktree });
  if (!p.exists.worktree) {
    if (p.kind === "pr") {
      await run("git", ["fetch", "-q", "origin", `+refs/heads/${p.branch}:refs/remotes/origin/${p.branch}`], { cwd: repoDir, timeout: 25000 });
      if (p.exists.local) await run("git", ["worktree", "add", "-q", p.worktree, p.branch], { cwd: repoDir });
      else await run("git", ["worktree", "add", "-q", "--track", "-b", p.branch, p.worktree, `origin/${p.branch}`], { cwd: repoDir });
    } else {
      if (p.existing) fail("branch exists; open it instead", { branch: p.branch, worktree: p.exists.worktree });
      // Cut from the remote's default branch (the local one is usually behind); no remote: the local one.
      const baseRef = baseOverride || (r.remoteUrl ? `origin/${r.base}` : r.base);
      const remoteBranch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : r.base;
      if (r.remoteUrl) await run("git", ["fetch", "-q", "origin", remoteBranch], { cwd: repoDir, timeout: 25000 });
      await run("git", ["worktree", "add", "-q", "--no-track", "-b", p.branch, p.worktree, baseRef], { cwd: repoDir });
    }
    // Run optional user-configured post-worktree hook (e.g. copying gitignored .env files).
    const hook = postWorktreeHook();
    const from = r.worktrees.find(w => w.branch === r.base)?.path;
    if (hook && from) await exec(hook.endsWith(".mjs") || hook.endsWith(".js") ? "node" : hook, hook.endsWith(".mjs") || hook.endsWith(".js") ? [hook, from, p.worktree] : [from, p.worktree], { timeout: 20000 });
  }
  const term = await open({ worktree: p.worktree, kind: "claude", repo: r.name, branch: p.branch, focus });
  let delivery = null;
  if (prompt && !noWait) {
    delivery = await sendPromptToTerminal(term.terminal, prompt, { wait });
  }
  return { ...p, created: !p.exists.worktree, ...term, ...(delivery ? { delivered: delivery.delivered, deliveryStatus: delivery.status ?? null } : {}) };
}

// ------------------------------------------------------------------ deliver

async function deliver({ terminal, repo, branch, kind, wait, payload }) {
  const repoDir = await resolveRepoDir(repo);
  const r = await repoFacts(repoDir);
  let prompt;
  if (kind === "issue") {
    const n = payload.match(/(\d+)\s*$/)?.[1];
    const issue = await json("gh", ["issue", "view", n, "--repo", r.slug, "--json", "number,title,url,body,comments"]);
    prompt = wf.issuePrompt({ issue, repo: r.slug, branch, base: r.base });
  } else if (kind === "pr") {
    const n = payload.match(/(\d+)\s*$/)?.[1];
    const pr = await json("gh", ["pr", "view", n, "--repo", r.slug, "--json", "number,title,url,baseRefName"]);
    prompt = wf.prPrompt({ pr, base: r.base });
  } else if (kind === "command") prompt = payload;
  else prompt = wf.textPrompt({ text: payload, branch, base: r.base });

  return sendPromptToTerminal(terminal, prompt, { wait: wait ?? 20 });
}

// ------------------------------------------------------------------ list / status / logs / diff / result

async function listLiveTasks({ repoFilter = null, branchFilter = null, includeAll = false } = {}) {
  const raw = (await exec("hc", ["ls", "--json"])).stdout || "[]";
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed.terminals || parsed.items || []);
  const workspaces = configuredWorkspaces();
  const projects = await discoverProjects();
  const baseBranches = new Set(["main", "master", "develop", "dev"]);
  const tasks = [];
  for (const t of list) {
    const live = !t.state || t.state === "live";
    if (!includeAll && !live) continue;
    const lbl = wf.readLabels(t.labels) ?? {};
    let worktree = (lbl.worktree || t.cwd || "").replace(/\/+$/, "") || null;
    let repo = lbl.repo || null;
    let branch = lbl.branch || null;
    // Infer repo & branch from cwd when the terminal was opened outside `wf open`.
    const matchedProj = worktree
      ? projects.find(p => worktree === p.dir || worktree.startsWith(p.dir + "/"))
      : null;
    if (!repo && matchedProj) repo = matchedProj.name;
    if (!branch && matchedProj && worktree && worktree !== matchedProj.dir && existsSync(worktree)) {
      const b = await wf.git(exec, worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
      if (b && b.trim() && b.trim() !== "HEAD") branch = b.trim();
    }
    const scope = branch ? "branch"
      : (worktree && workspaces.includes(worktree)) ? "workspace"
      : (matchedProj && worktree === matchedProj.dir) ? "repo"
      : (repo ? "repo" : "other");
    const item = {
      terminal: t.address,
      state: t.state || "live",
      status: wf.statusWord(t.status) || "idle",
      program: t.foreground?.name || t.status?.app || null,
      title: t.title || null,
      repo,
      branch,
      worktree,
      session: lbl.session || null,
      role: lbl.role || (branch ? "task" : "orchestrator"),
      scope,
      isBase: Boolean(branch && baseBranches.has(branch)),
    };
    if (repoFilter && item.repo !== repoFilter && item.worktree !== repoFilter && !String(item.worktree || "").startsWith(repoFilter + "/")) continue;
    if (branchFilter && item.branch !== branchFilter) continue;
    tasks.push(item);
  }
  return { count: tasks.length, tasks };
}

async function taskStatus({ terminal = null, worktree = null, repoFilter = null } = {}) {
  const listed = await listLiveTasks({ repoFilter });
  let items = listed.tasks;
  if (terminal) items = items.filter(x => x.terminal === terminal);
  if (worktree) items = items.filter(x => x.worktree === worktree);
  const enriched = await Promise.all(items.map(async item => {
    if (!item.worktree || !existsSync(item.worktree) || item.scope !== "branch") return item;
    const git = await wf.worktreeStatus(exec, item.worktree).catch(() => null);
    return { ...item, git };
  }));
  if (terminal || worktree) return enriched[0] ?? fail("no matching live task", { terminal, worktree });
  return { count: enriched.length, tasks: enriched };
}

async function readLogs({ terminal, lines = 80 }) {
  const n = Math.max(1, Math.min(2000, Number(lines) || 80));
  const text = await run("hc", ["read", terminal, "--lines", String(n)]);
  return { terminal, lines: n, text };
}

async function readDiff({ worktree, base = null, full = false }) {
  if (!existsSync(worktree)) fail("no such worktree", { worktree });
  const defaultBase = base || (await wf.git(exec, worktree, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then(s => s?.trim(), () => null)) || "origin/main";
  const status = (await exec("git", ["status", "--short"], { cwd: worktree })).stdout.trim();
  const stat = (await exec("git", ["diff", "--stat", `${defaultBase}...HEAD`], { cwd: worktree })).stdout.trim();
  const res = { worktree, base: defaultBase, status, stat };
  if (full) {
    res.patch = (await exec("git", ["diff", `${defaultBase}...HEAD`], { cwd: worktree })).stdout;
  }
  return res;
}

async function readResult({ terminal = null, worktree = null }) {
  let wt = worktree;
  let sid = null;
  if (terminal) {
    const info = await json("hc", ["get", terminal, "--json"]).catch(() => null);
    const lbl = wf.readLabels(info?.labels) ?? {};
    sid = lbl.session || null;
    wt = wt || lbl.worktree || info?.cwd || null;
  }
  if (!wt) fail("could not resolve worktree for result", { terminal });
  const file = sid ? findTranscript(wt, sid) : listSessions(projectDirsOf(wt), { limit: 1 }).sessions?.[0]?.file;
  if (!file) fail("no Claude transcript found", { terminal, worktree: wt, session: sid });
  return { terminal, worktree: wt, session: sid, file, title: sessionTitleOf(file), text: lastAnswerOf(file) };
}

// ------------------------------------------------------------------ main

const [command, ...argv] = process.argv.slice(2);
const { opts, rest } = parseArgs(argv);
//   wf ci-jobs --slug <owner/repo> --runs <id1,id2,...>
async function ciJobsBatch(slug, runIds) {
  const tok = (await run("gh", ["auth", "token"])).trim();
  const headers = {
    Authorization: `Bearer ${tok}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "herdr-wf",
  };
  const now = Date.now();
  const results = {};
  await Promise.all(runIds.map(async id => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const resp = await fetch(`https://api.github.com/repos/${slug}/actions/runs/${id}/jobs?per_page=50`, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) { results[id] = { error: `GitHub ${resp.status}`, jobs: [] }; return; }
      const body = await resp.json();
      results[id] = { error: null, jobs: wf.normalizeJobs(body?.jobs, now) };
    } catch (e) {
      results[id] = { error: String(e?.message ?? e), jobs: [] };
    }
  }));
  return { slug, runs: results };
}

try {
  if (command === "open") {
    if (!opts.worktree) fail("--worktree is required");
    if (opts.resume && !/^[0-9a-f-]{36}$/.test(opts.resume)) fail("--resume takes a session id");
    const kind = opts.shell ? "shell" : opts.agent ? "agent" : "claude";
    if (kind === "agent" && !rest.length) fail("--agent requires the command after --");
    out(await open({
      worktree: opts.worktree, kind, codeMode: !!opts["code-mode"],
      agent: typeof opts.agent === "string" ? opts.agent : null, agentArgv: rest,
      repo: opts.repo, branch: opts.branch, role: typeof opts.role === "string" ? opts.role : null,
      focus: !!opts.focus, resume: opts.resume || null, file: opts.file || null,
    }));
  } else if (command === "stop") {
    if (!opts.worktree && !opts.terminal) fail("--worktree or --terminal is required");
    out(await stop({ worktree: opts.worktree || null, terminal: opts.terminal || null }));
  } else if (command === "remove-session") {
    if (!opts.terminal && !opts.file && !opts.session) fail("--terminal, --file, or --session is required");
    out(await removeSession({
      terminal: opts.terminal || null, worktree: opts.worktree || null,
      session: opts.session || null, file: opts.file || null,
    }));
  } else if (command === "rename") {
    if (!opts.name) fail("--name is required");
    out(await renameSession({
      terminal: opts.terminal || null, tab: opts.tab || null,
      file: opts.file || null, session: opts.session || null, name: opts.name,
    }));
  } else if (command === "resume") {
    if (!opts.worktree) fail("--worktree is required");
    out(await resume({ worktree: opts.worktree }));
  } else if (command === "sessions") {
    if (opts.worktree) out({ worktree: opts.worktree, ...listSessions(projectDirsOf(opts.worktree)) });
    else if (opts.repo) {
      const info = await wf.repoInfo(exec, opts.repo);
      if (!info) fail("not a git repository", { repo: opts.repo });
      const r = listSessions(repoSessionDirs(opts.repo, info.worktrees.map(w => w.path)), { limit: 60 });
      // home "repo": started in the repository folder, resumable there; "removed": its worktree
      // is gone, so it resumes in another worktree (copied there first).
      const sessions = r.sessions.filter(x => insideRepo(x.cwd, opts.repo))
        .map(x => ({ ...x, home: !x.cwd || x.cwd === opts.repo ? "repo" : "removed" }));
      out({ repo: opts.repo, sessions, total: r.total });
    } else fail("--worktree or --repo is required");
  } else if (command === "answer") {
    out({ text: lastAnswerOf(transcript(opts.file)) });
  } else if (command === "projects") {
    out({ projects: await discoverProjects() });
  } else if (command === "list") {
    out(await listLiveTasks({
      repoFilter: typeof opts.repo === "string" ? opts.repo : null,
      branchFilter: typeof opts.branch === "string" ? opts.branch : null,
      includeAll: !!opts.all,
    }));
  } else if (command === "status") {
    out(await taskStatus({
      terminal: typeof opts.terminal === "string" ? opts.terminal : null,
      worktree: typeof opts.worktree === "string" ? opts.worktree : null,
      repoFilter: typeof opts.repo === "string" ? opts.repo : null,
    }));
  } else if (command === "new") {
    const repoDir = await resolveRepoDir(opts.repo);
    const baseOverride = typeof opts.base === "string" ? opts.base : null;
    const prompt = readPromptArg(opts, null);
    const p = await propose(repoDir, rest.join(" "), typeof opts.branch === "string" ? opts.branch : null, baseOverride);
    if (opts["dry-run"]) out(p);
    else if (p.kind === "issues") {
      const made = [];
      for (const item of p.items) made.push(item.existing ? item : await create(repoDir, item, { focus: false, baseOverride, prompt, wait: opts.wait ?? 25, noWait: !!opts["no-wait"] }));
      out({ kind: "issues", items: made });
    } else out(await create(repoDir, p, { focus: !!opts.focus, baseOverride, prompt, wait: opts.wait ?? 25, noWait: !!opts["no-wait"] }));
  } else if (command === "deliver") {
    for (const k of ["terminal", "repo", "kind"]) if (!opts[k]) fail(`--${k} is required`);
    out(await deliver({ ...opts, payload: rest.join(" ") }));
  } else if (command === "send") {
    if (!opts.terminal) fail("--terminal is required");
    const prompt = readPromptArg(opts, rest);
    if (!prompt) fail("--prompt, --prompt-file, or text after -- is required");
    out(await sendPromptToTerminal(opts.terminal, prompt, { wait: opts.wait ?? 20, force: !!opts.force }));
  } else if (command === "logs") {
    if (!opts.terminal) fail("--terminal is required");
    out(await readLogs({ terminal: opts.terminal, lines: opts.lines ?? 80 }));
  } else if (command === "diff") {
    if (!opts.worktree) fail("--worktree is required");
    out(await readDiff({ worktree: opts.worktree, base: typeof opts.base === "string" ? opts.base : null, full: !!opts.full }));
  } else if (command === "result") {
    if (!opts.terminal && !opts.worktree) fail("--terminal or --worktree is required");
    out(await readResult({ terminal: opts.terminal || null, worktree: opts.worktree || null }));
  } else if (command === "ci-jobs") {
    if (!opts.slug || !opts.runs) fail("--slug and --runs are required");
    const ids = String(opts.runs).split(",").map(s => s.trim()).filter(Boolean).slice(0, 12);
    out(await ciJobsBatch(opts.slug, ids));
  } else if (command === "explain") {
    if (!opts.worktree) fail("--worktree is required");
    out(await runExplain({
      worktree: opts.worktree,
      base: typeof opts.base === "string" ? opts.base : null,
      engine: typeof opts.engine === "string" ? opts.engine : null,
      model: typeof opts.model === "string" ? opts.model : undefined,
      effort: typeof opts.effort === "string" ? opts.effort : null,
      lang: typeof opts.lang === "string" ? opts.lang : null,
      bugHuntMin: opts["bug-hunt-min"] !== undefined ? opts["bug-hunt-min"] : null,
      ask: typeof opts.ask === "string" ? opts.ask : null,
      scopeType: typeof opts["scope-type"] === "string" ? opts["scope-type"] : null,
      scopeId: typeof opts["scope-id"] === "string" ? opts["scope-id"] : null,
      scopeLabel: typeof opts["scope-label"] === "string" ? opts["scope-label"] : null,
      status: !!opts.status,
      full: !!opts.full,
      bg: !!opts.bg,
      cancel: !!opts.cancel,
      jobWorker: !!opts["job-worker"],
      resolve: typeof opts.resolve === "string" ? opts.resolve : null,
      unresolve: !!opts.unresolve,
      deleteQa: typeof opts["delete-qa"] === "string" ? opts["delete-qa"] : null,
      clearQa: !!opts["clear-qa"],
      clearOutdatedQa: !!opts["clear-outdated-qa"],
    }));
  } else {
    fail("usage: wf open|stop|remove-session|rename|resume|sessions|answer|projects|list|status|new|deliver|send|logs|diff|result|ci-jobs|explain");
  }
} catch (e) {
  fail(e.message);
}
