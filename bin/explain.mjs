// Local Change Stack / AI Explain runner for `wf explain`.
// Computes per-file SHA-256 patch hashes, skips unchanged files on incremental updates,
// invokes the configured local AI CLI (first-class Claude, plus Codex & Gemini), and
// persists the structured review in ~/.config/herdr-app/data/wf/explain/.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { exec } from "./node-adapter.mjs";
import {
  EXPLAIN_JSON_SCHEMA,
  BUG_HUNT_JSON_SCHEMA,
  ASK_JSON_SCHEMA,
  normalizeExplainConfig,
  diffPatchState,
  filterBugHuntFiles,
  buildExplainPrompt,
  buildBugHuntPrompt,
  buildAskPrompt,
  extractAiJson,
  mergeExplainResult,
  stableHash,
  branchStateHash,
  parseNumstatZ,
  parseNameStatusZ,
} from "../wf-lib/index.js";

const CLAUDE_BIN = fileURLToPath(new URL("./claude", import.meta.url));
const WF_BIN = fileURLToPath(new URL("./wf.mjs", import.meta.url));
const READ_GIT = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const sha256 = text => createHash("sha256").update(String(text || ""), "utf8").digest("hex");

function appHomeDir() {
  return process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
}

function readExplainConfig(overrides = {}) {
  let fileCfg = {};
  for (const file of [join(appHomeDir(), "wf/config.json"), join(appHomeDir(), "settings.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        fileCfg = parsed["wf.explain"] || parsed.wf?.explain || {};
        if (Object.keys(fileCfg).length) break;
      }
    } catch {}
  }
  const merged = { ...fileCfg };
  if (overrides.engine) merged.engine = overrides.engine;
  if (overrides.model !== undefined && overrides.model !== null) merged.model = overrides.model;
  if (overrides.effort) merged.effort = overrides.effort;
  if (overrides.language) merged.language = overrides.language;
  if (overrides.bugHuntMinFiles !== undefined && overrides.bugHuntMinFiles !== null && overrides.bugHuntMinFiles !== "") {
    merged.bugHuntMinFiles = overrides.bugHuntMinFiles;
  }
  return normalizeExplainConfig(merged);
}

export function cachePathFor(root, branch) {
  const repoKey = sha256(root).slice(0, 16);
  const branchKey = String(branch || "HEAD").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "HEAD";
  return join(appHomeDir(), "data/wf/explain", repoKey, `${branchKey}.json`);
}

function loadCache(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function saveCache(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function jobPathFor(cacheFile, suffix = "job") {
  return `${cacheFile}.${suffix}.json`;
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readJob(cacheFile, suffix = "job") {
  const path = jobPathFor(cacheFile, suffix);
  try {
    if (!existsSync(path)) return null;
    const job = JSON.parse(readFileSync(path, "utf8"));
    if (!job || typeof job !== "object") return null;
    if (job.state === "running") {
      if (!isPidAlive(job.pid)) {
        const dead = { ...job, state: "error", finishedAt: Date.now(), error: "Background explain worker exited unexpectedly" };
        saveCache(path, dead);
        return dead;
      }
      return { ...job, elapsedSec: Math.max(0, Math.floor((Date.now() - (job.startedAt || Date.now())) / 1000)) };
    }
    return job;
  } catch {
    return null;
  }
}

function writeJob(cacheFile, job, suffix = "job") {
  saveCache(jobPathFor(cacheFile, suffix), job);
}

// Best-effort PR + linked issue context via gh CLI (never blocks or fails the explain run if offline/no PR).
async function collectIntentContext(worktree, branch) {
  if (!branch || branch === "HEAD") return null;
  const trim = (s, max = 2400) => String(s || "").trim().slice(0, max);
  let pr = null;
  const issueNums = new Set();

  try {
    const r = await exec("gh", [
      "pr", "list", "--head", branch, "--state", "all", "--limit", "1",
      "--json", "number,title,body,url,state,closingIssuesReferences",
    ], { cwd: worktree });
    if (r.code === 0 && r.stdout.trim()) {
      const list = JSON.parse(r.stdout);
      const hit = Array.isArray(list) ? list[0] : null;
      if (hit?.number) {
        pr = {
          number: hit.number,
          title: trim(hit.title, 200),
          body: trim(hit.body, 2400),
          url: String(hit.url || ""),
          state: String(hit.state || ""),
        };
        for (const ref of hit.closingIssuesReferences || []) {
          if (ref?.number) issueNums.add(Number(ref.number));
        }
        const re = /(?:fixes|closes|resolves|refs?)\s+#(\d+)/gi;
        let m;
        while ((m = re.exec(hit.body || "")) !== null) issueNums.add(Number(m[1]));
      }
    }
  } catch {}

  // Also check branch name for an issue number like feat/123-foo or fix/456
  const bm = /(?:^|[\/_-])(\d{2,6})(?:[_-]|$)/.exec(branch);
  if (bm && (!pr || Number(bm[1]) !== pr.number)) issueNums.add(Number(bm[1]));

  const issues = [];
  for (const num of [...issueNums].slice(0, 2)) {
    try {
      const r = await exec("gh", ["issue", "view", String(num), "--json", "number,title,body,url,state"], { cwd: worktree });
      if (r.code === 0 && r.stdout.trim()) {
        const iss = JSON.parse(r.stdout);
        if (iss?.number) {
          issues.push({
            number: iss.number,
            title: trim(iss.title, 200),
            body: trim(iss.body, 2200),
            url: String(iss.url || ""),
            state: String(iss.state || ""),
          });
        }
      }
    } catch {}
  }

  if (!pr && !issues.length) return null;
  return { pr, issues };
}

async function resolveBase(worktree, baseOverride) {
  let baseRef = baseOverride || "";
  if (!baseRef) {
    const sym = await exec("git", [...READ_GIT, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: worktree });
    if (sym.code === 0 && sym.stdout.trim()) baseRef = sym.stdout.trim();
  }
  if (!baseRef) {
    for (const cand of ["origin/main", "origin/master", "origin/develop", "main", "master", "develop"]) {
      const ok = await exec("git", [...READ_GIT, "rev-parse", "--verify", "--quiet", cand], { cwd: worktree });
      if (ok.code === 0 && ok.stdout.trim()) { baseRef = cand; break; }
    }
  }
  if (!baseRef) baseRef = "HEAD";

  let baseSha = "";
  const mb = await exec("git", [...READ_GIT, "merge-base", baseRef, "HEAD"], { cwd: worktree });
  if (mb.code === 0 && mb.stdout.trim()) baseSha = mb.stdout.trim();
  if (!baseSha) {
    const rp = await exec("git", [...READ_GIT, "rev-parse", "--verify", baseRef], { cwd: worktree });
    if (rp.code !== 0) throw new Error(`Could not resolve base ref "${baseRef}"`);
    baseSha = rp.stdout.trim();
  }
  return { baseRef, baseSha };
}

async function collectBranchFiles(worktree, baseSha) {
  const [branchRes, nsRes, numRes, untrackedRes] = await Promise.all([
    exec("git", [...READ_GIT, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree }),
    exec("git", [...READ_GIT, "diff", "--name-status", "-z", "-M", baseSha], { cwd: worktree }),
    exec("git", [...READ_GIT, "diff", "--numstat", "-z", "-M", baseSha], { cwd: worktree }),
    exec("git", [...READ_GIT, "ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktree }),
  ]);

  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : "HEAD";
  const stats = numRes.code === 0 ? parseNumstatZ(numRes.stdout) : {};
  const files = nsRes.code === 0 ? parseNameStatusZ(nsRes.stdout, stats) : [];
  const seen = new Set(files.map(f => f.path));

  if (untrackedRes.code === 0) {
    for (const p of untrackedRes.stdout.split("\0").filter(Boolean)) {
      if (seen.has(p)) continue;
      seen.add(p);
      files.push({ path: p, status: "?", fresh: true, added: 0, removed: 0, binary: false });
    }
  }

  // Compute exact per-file patches & SHA-256 patch hashes in small parallel batches.
  const enriched = [];
  const BATCH = 12;
  for (let i = 0; i < files.length; i += BATCH) {
    const slice = files.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async f => {
      if (f.binary) {
        return { ...f, patch: "(binary file)", patchHash: sha256(`bin:${f.status}:${f.path}`) };
      }
      if (f.fresh || f.status === "?") {
        try {
          const text = readFileSync(join(worktree, f.path), "utf8");
          if (text.includes("\0")) {
            return { ...f, binary: true, patch: "(binary file)", patchHash: sha256(`bin:?:${f.path}`) };
          }
          const lines = text.replace(/\n$/, "").split("\n");
          const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.slice(0, 1200).map(l => `+${l}`).join("\n")}`;
          return { ...f, added: lines.length, removed: 0, patch, patchHash: sha256(`?:${text}`) };
        } catch {
          return { ...f, patch: "", patchHash: sha256(`?:err:${f.path}`) };
        }
      }
      const d = await exec("git", [...READ_GIT, "diff", baseSha, "-U3", "--no-ext-diff", "--no-textconv", "--no-color", "--", f.path], { cwd: worktree });
      const patch = d.code === 0 ? d.stdout : "";
      return { ...f, patch, patchHash: sha256(`${f.status}:${patch}`) };
    }));
    enriched.push(...results);
  }

  return { branch, files: enriched };
}

function spawnWithStdin(cmd, args, stdinText, { cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(stdinText, "utf8");
  });
}

async function invokeAiEngine(cfg, prompt, worktree, schema = EXPLAIN_JSON_SCHEMA) {
  const schemaStr = JSON.stringify(schema);

  if (cfg.engine === "claude") {
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", schemaStr,
      "--no-session-persistence",
      "--tools", "Read,Grep,Glob",
      "--allowedTools", "Read,Grep,Glob",
      "--permission-mode", "dontAsk",
      "--effort", cfg.effort || "medium",
    ];
    if (cfg.model) args.push("--model", cfg.model);
    const r = await spawnWithStdin(CLAUDE_BIN, args, prompt, { cwd: worktree });
    if (r.code !== 0) {
      throw new Error((r.stderr || r.stdout || `claude exited with code ${r.code}`).trim().slice(0, 400));
    }
    return extractAiJson(r.stdout);
  }

  if (cfg.engine === "codex") {
    const args = ["exec", "--skip-git-repo-check"];
    if (cfg.model) args.push("-m", cfg.model);
    args.push("-");
    const fullPrompt = `${prompt}\n\nJSON SCHEMA:\n${schemaStr}`;
    const r = await spawnWithStdin("codex", args, fullPrompt, { cwd: worktree });
    if (r.code !== 0) {
      throw new Error((r.stderr || r.stdout || `codex exited with code ${r.code}`).trim().slice(0, 400));
    }
    return extractAiJson(r.stdout);
  }

  if (cfg.engine === "gemini") {
    const args = [];
    if (cfg.model) args.push("-m", cfg.model);
    const fullPrompt = `${prompt}\n\nJSON SCHEMA:\n${schemaStr}`;
    const r = await spawnWithStdin("gemini", args, fullPrompt, { cwd: worktree });
    if (r.code !== 0) {
      throw new Error((r.stderr || r.stdout || `gemini exited with code ${r.code}`).trim().slice(0, 400));
    }
    return extractAiJson(r.stdout);
  }

  throw new Error(`Unsupported explain engine: ${cfg.engine}`);
}

export async function runExplain(opts = {}) {
  const worktree = opts.worktree;
  if (!worktree) throw new Error("--worktree is required");

  const { baseRef, baseSha } = await resolveBase(worktree, opts.base || null);
  const { branch, files } = await collectBranchFiles(worktree, baseSha);
  const currentBranchHash = branchStateHash(files);
  const cacheFile = cachePathFor(worktree, branch);
  const cached = loadCache(cacheFile);
  const sameBase = Boolean(cached && cached.baseSha === baseSha);
  const effectiveCache = sameBase ? cached : null;
  const cfg = readExplainConfig({
    engine: opts.engine,
    model: opts.model,
    effort: opts.effort,
    language: opts.lang || opts.language,
    bugHuntMinFiles: opts.bugHuntMin,
  });

  // Read-only follow-up Q&A on the branch, a layer, a file, or a finding (supports --bg for >30s safety)
  if (opts.ask && String(opts.ask).trim()) {
    const question = String(opts.ask).trim();
    const scopeType = opts.scopeType || "branch";
    const scopeId = opts.scopeId || "";
    const scopeLabel = opts.scopeLabel || (scopeType === "branch" ? branch : scopeId);

    if (opts.bg) {
      const existingAsk = readJob(cacheFile, "ask.job");
      if (existingAsk?.state === "running" && isPidAlive(existingAsk.pid)) {
        return { ok: true, started: false, alreadyRunning: true, askJob: existingAsk };
      }
      const workerArgs = [
        WF_BIN, "explain", "--worktree", worktree, "--engine", cfg.engine, "--lang", cfg.language,
        "--ask", question, "--scope-type", scopeType, "--scope-id", scopeId, "--scope-label", scopeLabel,
        "--job-worker",
      ];
      if (opts.base) workerArgs.push("--base", opts.base);
      if (cfg.model) workerArgs.push("--model", cfg.model);
      if (cfg.effort) workerArgs.push("--effort", cfg.effort);
      const child = spawn(process.execPath, workerArgs, { cwd: worktree, detached: true, stdio: "ignore" });
      child.unref();
      const askJob = {
        state: "running",
        pid: child.pid,
        engine: cfg.engine,
        question,
        scopeType,
        scopeId,
        scopeLabel,
        startedAt: Date.now(),
        elapsedSec: 0,
      };
      writeJob(cacheFile, askJob, "ask.job");
      return { ok: true, started: true, askJob };
    }

    const finishAsk = (state, extra = {}) => {
      if (!opts.jobWorker) return;
      const prev = readJob(cacheFile, "ask.job") || {};
      writeJob(cacheFile, { ...prev, state, finishedAt: Date.now(), ...extra }, "ask.job");
    };

    try {
      const rev = cached || effectiveCache;
      const scope = { type: scopeType, id: scopeId, label: scopeLabel };
      if (scopeType === "layer" && rev) scope.layer = (rev.layers || []).find(l => l.id === scopeId) || null;
      if (scopeType === "finding" && rev) scope.finding = (rev.findings || []).find(f => f.id === scopeId) || null;
      if (scopeType === "file") scope.file = scopeId;

      const askPrompt = buildAskPrompt({ question, scope, review: rev, currentBranchHash, language: cfg.language });
      const aiRes = await invokeAiEngine(cfg, askPrompt, worktree, ASK_JSON_SCHEMA);
      const tldr = String(aiRes?.tldr || aiRes?.answer || "").trim() || "No answer returned.";
      const bullets = Array.isArray(aiRes?.bullets)
        ? aiRes.bullets.map(b => String(b || "").trim()).filter(Boolean).slice(0, 6)
        : [];
      const rootAbs = resolve(worktree);
      const snippets = [];
      for (const raw of Array.isArray(aiRes?.snippets) ? aiRes.snippets.slice(0, 3) : []) {
        const rel = String(raw?.file || "").trim().replace(/^\/+/, "");
        if (!rel || rel.includes("..")) continue;
        const abs = resolve(rootAbs, rel);
        if (!abs.startsWith(rootAbs + "/") || !existsSync(abs)) continue;
        try {
          const text = readFileSync(abs, "utf8");
          if (text.includes("\0")) continue;
          const allLines = text.replace(/\n$/, "").split("\n");
          const sLine = Math.max(1, Math.min(allLines.length, Math.floor(Number(raw.lineStart) || 1)));
          const eLine = Math.max(sLine, Math.min(allLines.length, Math.min(sLine + 13, Math.floor(Number(raw.lineEnd) || sLine))));
          const slice = [];
          for (let ln = sLine; ln <= eLine; ln++) {
            slice.push({ num: ln, text: allLines[ln - 1] ?? "" });
          }
          if (slice.length) {
            snippets.push({
              file: rel,
              lineStart: sLine,
              lineEnd: eLine,
              caption: String(raw.caption || "").trim(),
              lines: slice,
            });
          }
        } catch {}
      }
      const entry = {
        id: `qa-${stableHash(`${scopeType}|${scopeId}|${question}|${Date.now()}`)}`,
        scopeType,
        scopeId,
        scopeLabel,
        question,
        tldr,
        bullets,
        snippets,
        answer: tldr,
        branchHash: currentBranchHash,
        createdAt: Date.now(),
      };
      let updated = rev;
      if (rev) {
        const nextQa = [...(Array.isArray(rev.qa) ? rev.qa : []), entry].slice(-30);
        updated = { ...rev, qa: nextQa };
        saveCache(cacheFile, updated);
      }
      finishAsk("done", { entryId: entry.id });
      return { ok: true, qaEntry: entry, review: updated };
    } catch (e) {
      finishAsk("error", { error: String(e?.message ?? e) });
      throw e;
    }
  }

  // Fast resolve/unresolve toggle (0 AI calls)
  if (opts.resolve) {
    if (!cached) throw new Error("No cached explain review for this branch");
    const set = new Set(cached.resolvedIds || []);
    if (opts.unresolve) set.delete(opts.resolve);
    else set.add(opts.resolve);
    const updated = { ...cached, resolvedIds: [...set] };
    saveCache(cacheFile, updated);
    return { ok: true, review: updated };
  }

  // Fast Q&A dismiss / clear / clear-outdated (0 AI calls)
  if (opts.deleteQa || opts.clearQa || opts.clearOutdatedQa) {
    if (!cached) throw new Error("No cached explain review for this branch");
    const prevQa = Array.isArray(cached.qa) ? cached.qa : [];
    const nextQa = opts.clearQa
      ? []
      : opts.clearOutdatedQa
      ? prevQa.filter(q => !q.branchHash || q.branchHash === currentBranchHash)
      : prevQa.filter(q => q.id !== opts.deleteQa);
    const updated = { ...cached, qa: nextQa };
    saveCache(cacheFile, updated);
    return { ok: true, review: updated };
  }

  // Cancel a running background explain worker (kills worker + claude child cleanly)
  if (opts.cancel) {
    const job = readJob(cacheFile);
    let killed = false;
    if (job?.state === "running" && job.pid) {
      try { process.kill(-job.pid, "SIGTERM"); killed = true; }
      catch {
        try { process.kill(job.pid, "SIGTERM"); killed = true; } catch {}
      }
    }
    writeJob(cacheFile, { ...(job || {}), state: "cancelled", finishedAt: Date.now() });
    return { ok: true, cancelled: true, killed, pid: job?.pid || null };
  }

  const delta = diffPatchState(files, effectiveCache);

  // Detached background launch so herdr.exec()'s 30s timeout is never hit on large branches.
  if (opts.bg) {
    const existingJob = readJob(cacheFile);
    if (existingJob?.state === "running" && isPidAlive(existingJob.pid)) {
      return { ok: true, started: false, alreadyRunning: true, job: existingJob };
    }
    const workerArgs = [
      WF_BIN, "explain", "--worktree", worktree, "--engine", cfg.engine, "--lang", cfg.language,
      "--bug-hunt-min", String(cfg.bugHuntMinFiles), "--job-worker",
    ];
    if (opts.base) workerArgs.push("--base", opts.base);
    if (cfg.model) workerArgs.push("--model", cfg.model);
    if (cfg.effort) workerArgs.push("--effort", cfg.effort);
    if (opts.full) workerArgs.push("--full");
    const child = spawn(process.execPath, workerArgs, {
      cwd: worktree,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const isInc = Boolean(effectiveCache && !opts.full && delta.unchanged.length > 0);
    const job = {
      state: "running",
      phase: "explain",
      pid: child.pid,
      engine: cfg.engine,
      mode: isInc ? "incremental" : "full",
      targetFiles: isInc ? delta.changed.length : files.length,
      totalFiles: files.length,
      startedAt: Date.now(),
      elapsedSec: 0,
    };
    writeJob(cacheFile, job);
    return { ok: true, started: true, job };
  }

  // Fast status probe (0 AI calls)
  if (opts.status) {
    return {
      ok: true,
      root: worktree,
      branch,
      baseRef,
      baseSha,
      branchHash: currentBranchHash,
      engine: cfg.engine,
      model: cfg.model,
      bugHuntMinFiles: cfg.bugHuntMinFiles,
      cached: Boolean(effectiveCache),
      totalFiles: files.length,
      staleCount: effectiveCache ? delta.staleCount : files.length,
      addedCount: delta.added.length,
      modifiedCount: delta.modified.length,
      removedCount: delta.removed.length,
      unchangedCount: delta.unchanged.length,
      job: readJob(cacheFile),
      askJob: readJob(cacheFile, "ask.job"),
      review: effectiveCache,
    };
  }

  const finishJob = (state, extra = {}) => {
    if (!opts.jobWorker) return;
    const prev = readJob(cacheFile) || {};
    if (prev.state === "cancelled") return;
    writeJob(cacheFile, { ...prev, state, finishedAt: Date.now(), ...extra });
  };

  try {
    if (!files.length) {
      const empty = mergeExplainResult(null, {
        title: `No changes vs ${baseRef}`,
        summary: `Branch ${branch} has no file differences compared to ${baseRef}.`,
        layers: [],
        fileSummaries: [],
        findings: [],
      }, [], { root: worktree, branch, baseRef, baseSha, engine: cfg.engine, model: cfg.model, analyzedFiles: 0, reusedFiles: 0 });
      saveCache(cacheFile, empty);
      finishJob("done", { mode: "empty", analyzedFiles: 0, reusedFiles: 0, durationMs: 0 });
      return { ok: true, mode: "empty", analyzedFiles: 0, reusedFiles: 0, durationMs: 0, review: empty };
    }

    // Up-to-date cache hit unless --full was explicitly requested
    if (effectiveCache && !delta.hasChanges && !opts.full) {
      finishJob("done", { mode: "cached", analyzedFiles: 0, reusedFiles: files.length, durationMs: 0 });
      return {
        ok: true,
        mode: "cached",
        analyzedFiles: 0,
        reusedFiles: files.length,
        durationMs: 0,
        review: effectiveCache,
      };
    }

    // Only deleted/reverted files changed? Prune deterministically without even calling AI!
    if (effectiveCache && !opts.full && delta.changed.length === 0 && delta.removed.length > 0) {
      const pruned = mergeExplainResult(effectiveCache, {
        title: effectiveCache.title,
        summary: effectiveCache.summary,
        layers: effectiveCache.layers,
        fileSummaries: [],
        findings: [],
      }, files, {
        root: worktree,
        branch,
        baseRef,
        baseSha,
        engine: cfg.engine,
        model: cfg.model,
        isIncremental: true,
        changedPaths: [],
        analyzedFiles: 0,
        reusedFiles: files.length,
      });
      saveCache(cacheFile, pruned);
      finishJob("done", { mode: "incremental", analyzedFiles: 0, reusedFiles: files.length, durationMs: 0 });
      return {
        ok: true,
        mode: "incremental",
        analyzedFiles: 0,
        reusedFiles: files.length,
        durationMs: 0,
        review: pruned,
      };
    }

    const isIncremental = Boolean(effectiveCache && !opts.full && delta.unchanged.length > 0);
    const changedDiffs = isIncremental ? delta.changed : files;
    const intentContext = await collectIntentContext(worktree, branch);

    const prompt = buildExplainPrompt({
      branch,
      baseRef,
      changedDiffs,
      allFiles: files,
      existingReview: isIncremental ? effectiveCache : null,
      isIncremental,
      intentContext,
      language: cfg.language,
    });

    const t0 = Date.now();
    const aiOutput = await invokeAiEngine(cfg, prompt, worktree, EXPLAIN_JSON_SCHEMA);

    // Pass 2: dedicated adversarial bug-hunt pass on large PRs (excludes tests/docs/generated files)
    let bugHuntPass = { ran: false, threshold: cfg.bugHuntMinFiles, scannedFiles: 0, skippedFiles: 0, extraFindings: 0 };
    const bugHuntTargets = filterBugHuntFiles(changedDiffs);
    const shouldRunBugHunt = cfg.bugHuntMinFiles > 0 && changedDiffs.length >= cfg.bugHuntMinFiles && bugHuntTargets.length > 0;
    if (shouldRunBugHunt) {
      if (opts.jobWorker) {
        const prev = readJob(cacheFile) || {};
        if (prev.state === "cancelled") {
          return { ok: false, cancelled: true };
        }
        writeJob(cacheFile, {
          ...prev,
          phase: "bug-hunt",
          bugHuntFiles: bugHuntTargets.length,
          bugHuntSkipped: changedDiffs.length - bugHuntTargets.length,
        });
      }
      const pass2Prompt = buildBugHuntPrompt({
        branch,
        baseRef,
        targetDiffs: bugHuntTargets,
        skippedCount: changedDiffs.length - bugHuntTargets.length,
        existingFindings: Array.isArray(aiOutput?.findings) ? aiOutput.findings : [],
        intentContext,
        language: cfg.language,
      });
      try {
        const pass2Out = await invokeAiEngine(cfg, pass2Prompt, worktree, BUG_HUNT_JSON_SCHEMA);
        const extra = Array.isArray(pass2Out?.findings) ? pass2Out.findings : [];
        aiOutput.findings = [...(Array.isArray(aiOutput?.findings) ? aiOutput.findings : []), ...extra];
        bugHuntPass = {
          ran: true,
          threshold: cfg.bugHuntMinFiles,
          scannedFiles: bugHuntTargets.length,
          skippedFiles: changedDiffs.length - bugHuntTargets.length,
          extraFindings: extra.length,
        };
      } catch {
        // Keep Pass 1 review even if Pass 2 fails/times out
        bugHuntPass = {
          ran: false,
          threshold: cfg.bugHuntMinFiles,
          scannedFiles: bugHuntTargets.length,
          skippedFiles: changedDiffs.length - bugHuntTargets.length,
          extraFindings: 0,
        };
      }
    }

    const durationMs = Date.now() - t0;

    const intentMeta = intentContext ? {
      pr: intentContext.pr ? { number: intentContext.pr.number, title: intentContext.pr.title, url: intentContext.pr.url, state: intentContext.pr.state } : null,
      issues: (intentContext.issues || []).map(i => ({ number: i.number, title: i.title, url: i.url, state: i.state })),
    } : null;

    const review = mergeExplainResult(isIncremental ? effectiveCache : null, aiOutput, files, {
      root: worktree,
      branch,
      baseRef,
      baseSha,
      branchHash: currentBranchHash,
      engine: cfg.engine,
      model: cfg.model,
      language: cfg.language,
      intentContext: intentMeta,
      bugHuntPass,
      isIncremental,
      changedPaths: changedDiffs.map(f => f.path),
      analyzedFiles: changedDiffs.length,
      reusedFiles: isIncremental ? delta.unchanged.length : 0,
    });

    saveCache(cacheFile, review);
    finishJob("done", {
      mode: isIncremental ? "incremental" : "full",
      analyzedFiles: changedDiffs.length,
      reusedFiles: isIncremental ? delta.unchanged.length : 0,
      durationMs,
    });
    return {
      ok: true,
      mode: isIncremental ? "incremental" : "full",
      analyzedFiles: changedDiffs.length,
      reusedFiles: isIncremental ? delta.unchanged.length : 0,
      durationMs,
      review,
    };
  } catch (e) {
    finishJob("error", { error: String(e?.message ?? e) });
    throw e;
  }
}
