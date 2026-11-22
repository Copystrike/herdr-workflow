// ForgeSource, first implementation: GitHub through `gh`. One call per repository.
// Without gh, offline or rate-limited, prList resolves to null and the PR slots stay hidden.

export const PR_FIELDS = "number,headRefName,state,isDraft,mergeable,reviewDecision,latestReviews,statusCheckRollup,baseRefName,url,updatedAt";
const LEAN_FIELDS = "number,headRefName,state,isDraft,baseRefName,url,updatedAt";

async function ghJson(exec, cwd, args) {
  let r;
  try { r = await exec("gh", args, { cwd }); } catch { return null; }
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// Open PRs with checks, plus recent history without them: asking checks for every closed PR
// costs ~10 s on a busy repo, the split ~1.5 s. Open PRs win over their lean copies.
export async function prList(exec, cwd, slug) {
  const repo = slug ? ["--repo", slug] : [];
  const [open, all] = await Promise.all([
    ghJson(exec, cwd, ["pr", "list", "--state", "open", "--limit", "100", "--json", PR_FIELDS, ...repo]),
    ghJson(exec, cwd, ["pr", "list", "--state", "all", "--limit", "100", "--json", LEAN_FIELDS, ...repo]),
  ]);
  if (!open && !all) return null;
  const seen = new Set((open ?? []).map(p => p.number));
  return [...(open ?? []), ...(all ?? []).filter(p => !seen.has(p.number))];
}

// head branch -> its PR: the open one, else the most recently updated.
export function prsByBranch(list) {
  const out = {};
  for (const pr of list ?? []) {
    const cur = out[pr.headRefName];
    const better = !cur || (pr.state === "OPEN" && cur.state !== "OPEN") ||
      (pr.state === cur.state && String(pr.updatedAt) > String(cur.updatedAt));
    if (better) out[pr.headRefName] = pr;
  }
  return out;
}

const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const RUNNING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);

// Two slots: blocker (conflict > red CI > changes requested) and progress (CI running).
export function prSignals(pr) {
  if (!pr || pr.state !== "OPEN") return { blocker: null, progress: null };
  const checks = pr.statusCheckRollup ?? [];
  const state = c => c.conclusion || c.state || c.status;
  const failed = checks.some(c => FAIL.has(String(state(c)).toUpperCase()));
  const running = checks.some(c => RUNNING.has(String(c.status || c.state).toUpperCase()) && !c.conclusion);
  let blocker = null;
  if (pr.mergeable === "CONFLICTING") blocker = "conflict";
  else if (failed) blocker = "ci";
  else if (pr.reviewDecision === "CHANGES_REQUESTED") blocker = "changes";
  return { blocker, progress: running ? "ci" : null };
}

// Detailed CI/CD & review summary for sidebar PR badges (Termic two-slot model + check counts):
// shows failing/running/passing CI and passed/total check progress so a developer can glance at
// the sidebar while a long CI pipeline runs on another branch.
export function prCiSummary(pr) {
  if (!pr || pr.state !== "OPEN") return null;
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  let passed = 0, failed = 0, running = 0;
  const failedNames = [], runningNames = [];
  for (const c of checks) {
    const raw = String(c.conclusion || c.state || c.status || "").toUpperCase();
    const status = String(c.status || c.state || "").toUpperCase();
    const label = c.name || c.context || "check";
    if (FAIL.has(raw)) { failed++; failedNames.push(label); }
    else if (RUNNING.has(status) && !c.conclusion) { running++; runningNames.push(label); }
    else if (raw === "SUCCESS" || raw === "NEUTRAL" || raw === "SKIPPED") { passed++; }
    else { running++; runningNames.push(label); }
  }
  const total = checks.length;
  const ci = failed > 0 ? "failing" : running > 0 ? "running" : total > 0 ? "passing" : "none";
  const conflict = pr.mergeable === "CONFLICTING";
  const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";
  const latestReviews = Array.isArray(pr.latestReviews) ? pr.latestReviews : [];
  const approvers = latestReviews.filter(r => String(r?.state).toUpperCase() === "APPROVED");
  const approvals = approvers.length || (pr.reviewDecision === "APPROVED" ? 1 : 0);
  const approved = pr.reviewDecision === "APPROVED" || approvals > 0;
  const parts = [`PR #${pr.number}${pr.isDraft ? " (draft)" : ""}`];
  if (conflict) parts.push("merge conflict");
  if (failed > 0) parts.push(`CI failed (${failed}/${total}): ${failedNames.slice(0, 3).join(", ")}`);
  else if (running > 0) parts.push(`CI running (${passed}/${total} done): ${runningNames.slice(0, 3).join(", ")}`);
  else if (total > 0) parts.push(`CI passing (${passed}/${total})`);
  if (changesRequested) parts.push("changes requested");
  else if (approved) {
    const names = approvers.map(r => r.author?.login).filter(Boolean).slice(0, 3);
    parts.push(`approved (${approvals}${names.length ? `: ${names.join(", ")}` : ""})`);
  }
  return {
    ci, passed, failed, running, total,
    conflict, changesRequested, approved, approvals, draft: Boolean(pr.isDraft),
    tooltip: parts.join(" · "),
    checks: prCheckBars(pr),
  };
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m`;
}

// Per-PR check bars (Sakura style): one vertical bar per non-skipped check, height proportional
// to check duration relative to the slowest check on the PR, color by state (green=pass, red=fail,
// dark-green=queued/running, grey=cancelled).
export function prCheckBars(pr, now = Date.now()) {
  if (!pr || pr.state !== "OPEN") return [];
  const raw = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const items = [];
  for (const c of raw) {
    const concl = String(c.conclusion || "").toUpperCase();
    const st = String(c.status || c.state || "").toUpperCase();
    if (concl === "SKIPPED" || concl === "NEUTRAL") continue;
    const startMs = c.startedAt ? Date.parse(c.startedAt) : NaN;
    const endMs = c.completedAt ? Date.parse(c.completedAt) : (st === "COMPLETED" ? startMs : now);
    const durationSec = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(1, Math.round((endMs - startMs) / 1000)) : null;
    let state = "running";
    if (FAIL.has(concl) || FAIL.has(st)) state = "failed";
    else if (concl === "CANCELLED") state = "cancelled";
    else if (concl === "SUCCESS" || st === "SUCCESS") state = "passed";
    else if (st === "QUEUED" || st === "WAITING" || st === "PENDING") state = "queued";
    else state = "running";
    const name = c.name || c.context || "check";
    const wfName = c.workflowName || null;
    items.push({
      name, workflow: wfName, state, durationSec,
      url: c.detailsUrl || c.targetUrl || pr.url || null,
      tooltip: `${wfName ? `${wfName} / ` : ""}${name} · ${state}${durationSec ? ` · ${formatDuration(durationSec)}` : ""}`,
    });
  }
  const maxDur = Math.max(30, ...items.map(i => i.durationSec ?? 0));
  return items.map(i => ({
    ...i,
    ratio: i.state === "queued" ? 0.22 : Math.max(0.22, Math.min(1, (i.durationSec ?? maxDur * 0.35) / maxDur)),
  }));
}

// Default CI watch settings. An empty `workflows` array auto-discovers up to 4 active workflows
// per repository; custom workflow orders and short names can be configured in the wf-ci Settings tab.
export const DEFAULT_CI_SETTINGS = {
  workflows: [],
  shorts: {},        // global lowercase workflow name -> short label (applies across every repo)
  branch: "",        // "" = repo default branch (PR-only workflows fall back to pull_request runs)
  recencyDays: 7,    // runs older than this render dimmed and do not dominate status
  runsPerWorkflow: 10,
  overrides: {},     // { [slug]: { branch?: string, watch?: string[], shorts?: Record<string,string> } }
};

export function defaultShortName(name) {
  const s = String(name || "").trim();
  if (!s) return "CI";
  const words = s.split(/\s+/);
  if (words.length >= 2) {
    const a = words[0];
    const b = words[1];
    const head = a.toLowerCase() === "build" ? "Bd" : a.toLowerCase() === "release" ? "Re" : a.slice(0, 3);
    return `${head} ${b.slice(0, 4)}`;
  }
  return s.slice(0, 8);
}

export function mergeCiSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    workflows: Array.isArray(src.workflows) && src.workflows.length ? src.workflows : DEFAULT_CI_SETTINGS.workflows,
    shorts: src.shorts && typeof src.shorts === "object" ? src.shorts : {},
    branch: typeof src.branch === "string" ? src.branch.trim() : "",
    recencyDays: Number.isFinite(src.recencyDays) && src.recencyDays >= 1 ? Math.min(90, Math.round(src.recencyDays)) : DEFAULT_CI_SETTINGS.recencyDays,
    runsPerWorkflow: Number.isFinite(src.runsPerWorkflow) && src.runsPerWorkflow >= 3 ? Math.min(20, Math.round(src.runsPerWorkflow)) : DEFAULT_CI_SETTINGS.runsPerWorkflow,
    overrides: src.overrides && typeof src.overrides === "object" ? src.overrides : {},
  };
}

// Resolves which workflows to watch for a repository, keeping a stable order (never reordered by recency).
export function effectiveWorkflowDefs(allWorkflows, rawSettings, slug) {
  const cfg = mergeCiSettings(rawSettings);
  const active = (allWorkflows ?? []).filter(w => w?.name && (!w.state || w.state === "active"));
  const byKey = new Map(active.map(w => [w.name.toLowerCase(), w]));
  const ov = slug && cfg.overrides?.[slug] ? cfg.overrides[slug] : null;
  const shorts = {};
  for (const w of cfg.workflows) {
    if (w?.name && w?.short) shorts[w.name.toLowerCase()] = w.short;
  }
  for (const [k, v] of Object.entries(cfg.shorts ?? {})) {
    if (v) shorts[k.toLowerCase()] = v;
  }
  for (const [k, v] of Object.entries(ov?.shorts ?? {})) {
    if (v) shorts[k.toLowerCase()] = v;
  }

  const chosen = [];
  const seen = new Set();
  const pushIfMatch = (wfName) => {
    const k = String(wfName || "").toLowerCase();
    if (!k || seen.has(k)) return;
    const hit = byKey.get(k);
    if (!hit) return;
    seen.add(k);
    chosen.push({ id: hit.id, name: hit.name, path: hit.path || "", short: shorts[k] || defaultShortName(hit.name) });
  };

  if (Array.isArray(ov?.watch)) {
    for (const n of ov.watch) pushIfMatch(n);
  } else {
    for (const w of cfg.workflows) pushIfMatch(w.name);
    if (!chosen.length) {
      for (const w of active.slice(0, 4)) pushIfMatch(w.name);
    }
  }
  return chosen;
}

const repoMetaCache = new Map(); // slug -> { at, defaultBranch, workflows }
const workflowSourceCache = new Map(); // `${slug}:${wfId}:${branch}` -> { source: "branch"|"pr", at }
const META_TTL_MS = 10 * 60 * 1000;
const SOURCE_TTL_MS = 15 * 60 * 1000;

export async function repoWorkflowMeta(exec, cwd, slug, { force = false } = {}) {
  if (!slug) return null;
  const cached = repoMetaCache.get(slug);
  if (!force && cached && Date.now() - cached.at < META_TTL_MS) return cached;
  const [repoInfo, wfResp] = await Promise.all([
    ghJson(exec, cwd, ["api", `repos/${slug}`]),
    ghJson(exec, cwd, ["api", `repos/${slug}/actions/workflows?per_page=100`]),
  ]);
  const defaultBranch = repoInfo?.default_branch || "main";
  const workflows = Array.isArray(wfResp?.workflows)
    ? wfResp.workflows.filter(w => w?.state === "active" && w?.name).map(w => ({ id: w.id, name: w.name, path: w.path || "", state: w.state }))
    : [];
  const entry = { at: Date.now(), defaultBranch, workflows };
  repoMetaCache.set(slug, entry);
  return entry;
}

export async function workflowRuns(exec, cwd, slug) {
  if (!slug) return null;
  const r = await ghJson(exec, cwd, ["api", `repos/${slug}/actions/runs?per_page=40`]);
  return Array.isArray(r?.workflow_runs) ? r.workflow_runs : null;
}

// Fetches recent runs per watched workflow (default branch first, falling back to pull_request runs
// when a workflow only runs on PRs, matching Termic's ci-watch behavior).
export async function repoCiSnapshot(exec, cwd, slug, rawSettings = null, { forceMeta = false, now = Date.now() } = {}) {
  if (!slug) return null;
  const cfg = mergeCiSettings(rawSettings);
  const meta = await repoWorkflowMeta(exec, cwd, slug, { force: forceMeta });
  if (!meta) return null;
  const ov = cfg.overrides?.[slug] ?? null;
  const branch = (typeof ov?.branch === "string" && ov.branch.trim()) || cfg.branch || meta.defaultBranch;
  const defs = effectiveWorkflowDefs(meta.workflows, cfg, slug);
  const perPage = cfg.runsPerWorkflow;
  const cutoffMs = now - cfg.recencyDays * 86400 * 1000;

  const workflows = await Promise.all(defs.map(async def => {
    const srcKey = `${slug}:${def.id}:${branch}`;
    const cachedSrc = workflowSourceCache.get(srcKey);
    const preferPr = cachedSrc && Date.now() - cachedSrc.at < SOURCE_TTL_MS && cachedSrc.source === "pr";

    if (preferPr) {
      const prResp = await ghJson(exec, cwd, ["api", `repos/${slug}/actions/workflows/${def.id}/runs?event=pull_request&per_page=${perPage}`]);
      const prRuns = (Array.isArray(prResp?.workflow_runs) ? prResp.workflow_runs : [])
        .filter(r => !r.head_repository?.full_name || r.head_repository.full_name.toLowerCase() === slug.toLowerCase());
      if (prRuns.length) return { ...def, source: "pr", branch, runs: prRuns };
    }

    const brResp = await ghJson(exec, cwd, ["api", `repos/${slug}/actions/workflows/${def.id}/runs?branch=${encodeURIComponent(branch)}&per_page=${perPage}`]);
    const brRuns = Array.isArray(brResp?.workflow_runs) ? brResp.workflow_runs : [];
    const hasRecentBranch = brRuns.some(r => {
      const ts = Date.parse(r.run_started_at || r.created_at || "");
      return Number.isFinite(ts) && ts >= cutoffMs;
    });
    if (hasRecentBranch) {
      workflowSourceCache.set(srcKey, { source: "branch", at: Date.now() });
      return { ...def, source: "branch", branch, runs: brRuns };
    }
    const prResp = await ghJson(exec, cwd, ["api", `repos/${slug}/actions/workflows/${def.id}/runs?event=pull_request&per_page=${perPage}`]);
    const prRuns = (Array.isArray(prResp?.workflow_runs) ? prResp.workflow_runs : [])
      .filter(r => !r.head_repository?.full_name || r.head_repository.full_name.toLowerCase() === slug.toLowerCase());
    if (prRuns.length) {
      workflowSourceCache.set(srcKey, { source: "pr", at: Date.now() });
      return { ...def, source: "pr", branch, runs: prRuns };
    }
    return { ...def, source: "branch", branch, runs: brRuns };
  }));

  return { slug, defaultBranch: meta.defaultBranch, branch, allWorkflows: meta.workflows, workflows };
}

function normalizeRunBar(wfName, r, { now, cutoffMs }) {
  const st = String(r.status || "").toLowerCase();
  const concl = String(r.conclusion || "").toLowerCase();
  const startMs = Date.parse(r.run_started_at || r.created_at || "");
  const createdMs = Date.parse(r.created_at || r.run_started_at || "");
  const endMs = st === "completed" ? Date.parse(r.updated_at || "") : now;
  const durationSec = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(1, Math.round((endMs - startMs) / 1000)) : null;
  let state = "running";
  if (st === "queued" || st === "waiting" || st === "pending" || st === "action_required") state = "queued";
  else if (st === "in_progress") state = "running";
  else if (concl === "success") state = "passed";
  else if (concl === "failure" || concl === "timed_out" || concl === "startup_failure") state = "failed";
  else state = "cancelled";
  const stale = Number.isFinite(createdMs) && createdMs < cutoffMs && state !== "running" && state !== "queued";
  const title = r.display_title || r.head_commit?.message?.split("\n")[0] || "";
  const actor = r.actor?.login || r.triggering_actor?.login || "";
  return {
    id: r.id,
    runNumber: r.run_number ?? null,
    state,
    stale,
    durationSec,
    createdMs: Number.isFinite(createdMs) ? createdMs : null,
    branch: r.head_branch || "",
    event: r.event || "",
    title,
    actor,
    attempt: r.run_attempt ?? 1,
    sha: r.head_sha ? String(r.head_sha).slice(0, 7) : "",
    url: r.html_url || null,
    tooltip: `${wfName}${r.run_number ? ` #${r.run_number}` : ""} · ${state}${durationSec ? ` · ${formatDuration(durationSec)}` : ""}${r.head_branch ? ` · ${r.head_branch}` : ""}${title ? `\n${title}` : ""}`,
  };
}

// TeamCity Sakura style per-workflow trend strips: oldest left, newest right, bar height
// proportional to duration vs the workflow's own recent runs; queued/running sit on the far right.
// Accepts either a repoCiSnapshot() result or a raw workflow_runs[] array.
export function ciTrends(input, { limit = 6, recencyDays = 7, now = Date.now() } = {}) {
  const cutoffMs = now - recencyDays * 86400 * 1000;
  let chosen = [];

  if (input && typeof input === "object" && Array.isArray(input.workflows)) {
    chosen = input.workflows.map(w => ({
      id: w.id ?? null,
      name: w.name,
      short: w.short || defaultShortName(w.name),
      source: w.source || "branch",
      branch: w.branch || input.branch || "",
      runs: Array.isArray(w.runs) ? w.runs : [],
    }));
  } else if (Array.isArray(input) && input.length) {
    const byName = new Map();
    for (const r of input) {
      const name = r?.name;
      if (!name) continue;
      const k = name.toLowerCase();
      if (!byName.has(k)) byName.set(k, { name, runs: [] });
      byName.get(k).runs.push(r);
    }
    for (const def of DEFAULT_CI_SETTINGS.workflows) {
      const hit = byName.get(def.name.toLowerCase());
      if (hit) chosen.push({ ...hit, short: def.short, source: "branch", branch: "" });
    }
    if (!chosen.length) {
      for (const entry of [...byName.values()].slice(0, 4)) {
        chosen.push({ ...entry, short: defaultShortName(entry.name), source: "branch", branch: "" });
      }
    }
  } else {
    return [];
  }

  return chosen.map(wf => {
    const slice = wf.runs.slice(0, limit).reverse(); // oldest left, newest right
    const bars = slice.map(r => normalizeRunBar(wf.name, r, { now, cutoffMs }));
    const maxDur = Math.max(30, ...bars.map(b => b.durationSec ?? 0));
    const sized = bars.map(b => ({
      ...b,
      ratio: b.state === "queued" ? 0.25 : Math.max(0.22, Math.min(1, (b.durationSec ?? maxDur * 0.4) / maxDur)),
    }));
    const latest = [...sized].reverse().find(b => !b.stale) ?? sized[sized.length - 1] ?? null;
    return {
      id: wf.id ?? null,
      name: wf.name,
      short: wf.short,
      source: wf.source || "branch",
      branch: wf.branch || "",
      latest,
      bars: sized,
    };
  });
}

export function normalizeJobs(rawJobs, now = Date.now()) {
  const jobs = Array.isArray(rawJobs) ? rawJobs : [];
  return jobs.map(j => {
    const st = String(j.status || "").toLowerCase();
    const concl = String(j.conclusion || "").toLowerCase();
    let state = "running";
    if (st === "queued" || st === "waiting" || st === "pending") state = "queued";
    else if (st === "in_progress") state = "running";
    else if (concl === "success") state = "passed";
    else if (concl === "failure" || concl === "timed_out") state = "failed";
    else if (concl === "skipped") state = "skipped";
    else state = "cancelled";
    const startMs = Date.parse(j.started_at || "");
    const endMs = st === "completed" ? Date.parse(j.completed_at || "") : now;
    const durationSec = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(1, Math.round((endMs - startMs) / 1000)) : null;
    const steps = (j.steps ?? []).map(s => {
      const sst = String(s.status || "").toLowerCase();
      const scon = String(s.conclusion || "").toLowerCase();
      let sstate = "running";
      if (sst === "queued" || sst === "pending") sstate = "queued";
      else if (sst === "in_progress") sstate = "running";
      else if (scon === "success") sstate = "passed";
      else if (scon === "failure" || scon === "timed_out") sstate = "failed";
      else if (scon === "skipped") sstate = "skipped";
      else sstate = "cancelled";
      const ss = Date.parse(s.started_at || "");
      const se = sst === "completed" ? Date.parse(s.completed_at || "") : now;
      const sdur = Number.isFinite(ss) && Number.isFinite(se) ? Math.max(0, Math.round((se - ss) / 1000)) : null;
      return {
        number: s.number,
        name: s.name,
        state: sstate,
        durationSec: sdur,
        startedMs: Number.isFinite(ss) ? ss : null,
        completedMs: Number.isFinite(se) ? se : null,
      };
    });
    return { id: j.id, name: j.name, state, durationSec, url: j.html_url || null, steps };
  });
}

export async function runJobs(exec, cwd, slug, runId, { cache = null, cacheable = false, attempt = 1, force = false } = {}) {
  if (!slug || !runId) return [];
  if (cache && cacheable && !force) {
    const hit = await cache.getJobs(slug, runId, attempt);
    if (hit) return hit;
  }
  const r = await ghJson(exec, cwd, ["api", `repos/${slug}/actions/runs/${runId}/jobs?per_page=50`]);
  const parsed = normalizeJobs(r?.jobs);
  if (cache && cacheable && parsed.length && parsed.every(j => j.state !== "running" && j.state !== "queued")) {
    await cache.setJobs(slug, runId, attempt, parsed);
  }
  return parsed;
}

// Fetches lightweight GitHub check-run annotations (exact failure/warning messages + file/line)
// in ~300-400ms without downloading raw multi-MB build logs.
export async function jobAnnotations(exec, cwd, slug, jobId, { cache = null, cacheable = false, force = false } = {}) {
  if (!slug || !jobId) return [];
  if (cache && cacheable && !force) {
    const hit = await cache.getAnnotations(slug, jobId);
    if (hit) return hit;
  }
  const r = await ghJson(exec, cwd, ["api", `repos/${slug}/check-runs/${jobId}/annotations?per_page=30`]);
  const list = Array.isArray(r) ? r.map(a => ({
    level: String(a.annotation_level || "notice").toLowerCase(),
    path: a.path || "",
    line: a.start_line ?? null,
    title: a.title || "",
    message: String(a.message || "").trim(),
  })).filter(a => a.message) : [];
  if (cache && cacheable) {
    await cache.setAnnotations(slug, jobId, list);
  }
  return list;
}

// Fetches bounded build/job logs for in-Herdr viewing without risking huge buffer stalls.
// Uses two-tier cache when `cache` and `cacheable` are provided; single-job fetches use
// `gh api .../jobs/<id>/logs --allow-escape-sequences` (much faster than downloading all-jobs zip).
export async function runLog(exec, cwd, slug, {
  runId, jobId = null, failedOnly = false, maxLines = null,
  cache = null, cacheable = false, attempt = 1, force = false,
} = {}) {
  if (!slug || (!runId && !jobId)) return { text: "", truncated: false, cached: false, error: "missing run/job id" };
  const limit = maxLines ?? (jobId ? 20000 : 3000);
  const keyOpts = { slug, runId: runId || 0, jobId, failedOnly, attempt };
  if (cache && cacheable && !force) {
    const hit = await cache.getLog(keyOpts);
    if (hit) return hit;
  }

  let r;
  if (jobId) {
    r = await exec("gh", ["api", `repos/${slug}/actions/jobs/${jobId}/logs`, "--allow-escape-sequences"], { cwd, timeoutMs: 25000 });
    // Fallback for older gh versions that do not recognize --allow-escape-sequences
    if (r.code !== 0 && /unknown flag.*allow-escape-sequences/i.test(r.stderr || "")) {
      r = await exec("gh", ["run", "view", "--job", String(jobId), "--repo", slug, "--log"], { cwd, timeoutMs: 25000 });
    }
  } else {
    r = await exec("gh", ["run", "view", String(runId), "--repo", slug, failedOnly ? "--log-failed" : "--log"], { cwd, timeoutMs: 25000 });
  }

  if (r.code !== 0 && !r.stdout) {
    return { text: "", truncated: false, cached: false, error: (r.stderr || `gh exited ${r.code}`).trim() };
  }
  // Strip both real ANSI escapes and caret-encoded ANSI sequences (^[[90m) so logs read cleanly.
  const clean = String(r.stdout || "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\^\[\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r\n/g, "\n");
  const lines = clean.split("\n");
  const truncated = lines.length > limit;
  const shown = truncated ? [`... (${lines.length - limit} earlier lines omitted; showing last ${limit} lines) ...`, "", ...lines.slice(-limit)] : lines;
  const res = { text: shown.join("\n"), truncated, totalLines: lines.length, cached: false, error: null };
  if (cache && cacheable && res.text.trim()) {
    await cache.setLog(keyOpts, res);
  }
  return res;
}

const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/;

// Extracts all log lines belonging to a single GitHub Actions step using its UTC
// startedMs/completedMs window (with nextStep.startedMs clamping adjacent same-second steps).
// Also returns startLine (1-based) and UTF-16 startOffset/lineEndOffset in rawLog so the
// Full Editor can jump directly to where this step starts.
export function sliceStepLog(rawLog, step, nextStep = null, { maxLines = Infinity } = {}) {
  if (!rawLog || !step) return { text: "", totalLines: 0, truncated: false, startLine: null, startOffset: null, lineEndOffset: null };
  const startMs = step.startedMs;
  const rawEnd = step.completedMs ?? (nextStep?.startedMs ?? Infinity);
  const endMs = nextStep?.startedMs && nextStep.startedMs > startMs
    ? Math.min(rawEnd, nextStep.startedMs)
    : rawEnd;
  if (!Number.isFinite(startMs)) {
    return { text: "(Step timestamp unavailable — open full job log in Editor.)", totalLines: 0, truncated: false, startLine: null, startOffset: null, lineEndOffset: null };
  }
  const lo = startMs - 999; // GitHub step started_at is rounded to whole seconds while log lines have fractional ms
  const hi = Number.isFinite(endMs) ? endMs + 999 : Infinity;

  const matched = [];
  let inWindow = false;
  let startLine = null;
  let startOffset = null;
  let lineEndOffset = null;
  const rawStr = String(rawLog);
  const rawLines = rawStr.split("\n");
  let offset = 0;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];
    const lineLen = line.length;
    const m = LOG_TS_RE.exec(line);
    if (m) {
      const ts = Date.parse(m[1]);
      if (Number.isFinite(ts)) {
        if (ts >= lo && ts <= hi) {
          if (nextStep?.startedMs && ts >= nextStep.startedMs && nextStep.startedMs > startMs) {
            inWindow = false;
            offset += lineLen + 1;
            continue;
          }
          if (startLine === null) {
            startLine = idx + 1;
            startOffset = offset;
            lineEndOffset = offset + lineLen;
          }
          inWindow = true;
          matched.push(m[2]);
        } else {
          if (ts > hi) break;
          inWindow = false;
        }
        offset += lineLen + 1;
        continue;
      }
    }
    if (inWindow) matched.push(line);
    offset += lineLen + 1;
  }

  if (!matched.length) {
    return { text: "(No log output recorded for this step.)", totalLines: 0, truncated: false, startLine: null, startOffset: null, lineEndOffset: null };
  }
  const truncated = Number.isFinite(maxLines) && matched.length > maxLines;
  const shown = truncated
    ? [`... (${matched.length - maxLines} earlier lines in this step; open Full Editor for all ${matched.length} lines) ...`, ...matched.slice(-maxLines)]
    : matched;
  return { text: shown.join("\n"), totalLines: matched.length, truncated, startLine, startOffset, lineEndOffset };
}

export async function rerunWorkflow(exec, cwd, slug, runId, { failedOnly = true } = {}) {
  if (!slug || !runId) return { ok: false, error: "missing run id" };
  const args = ["run", "rerun", String(runId), "--repo", slug];
  if (failedOnly) args.push("--failed");
  const r = await exec("gh", args, { cwd, timeoutMs: 15000 });
  return r.code === 0 ? { ok: true, error: null } : { ok: false, error: (r.stderr || r.stdout || `gh exited ${r.code}`).trim() };
}
