// The F1 model of one repository: every worktree with its phase, PR and agents, the branches
// without a worktree, and the branchless sessions. Pure gathering over injected exec/fs.

import { repoInfo, phaseGitFacts, worktreeStatus, repoSlugFromUrl } from "./git.js";
import { readWorkflowFiles, prNumberOf, docsSnapshot } from "./plan.js";
import { derivePhase, statusLine, GROUP_OF } from "./phase.js";
import { prsByBranch, prSignals, prCiSummary } from "./forge.js";
import { terminalsIn, mostUrgent, readLabels, isWithin } from "./labels.js";

// Repositories of a workspace: <root>/repos/* holding a .bare or .git, or <root> itself.
export async function listRepos(fs, root) {
  const out = [];
  const isRepo = async dir => {
    for (const marker of [".bare", ".git"]) {
      try { await fs.readdir(`${dir}/${marker}`); return true; } catch {}
      try { await fs.readFile(`${dir}/${marker}`, "utf8"); return true; } catch {}
    }
    return false;
  };
  let names = [];
  try { names = await fs.readdir(`${root}/repos`, { withFileTypes: true }); } catch {}
  for (const e of names) if (e.isDirectory() && await isRepo(`${root}/repos/${e.name}`)) out.push({ name: e.name, dir: `${root}/repos/${e.name}` });
  if (!out.length && await isRepo(root)) out.push({ name: root.split("/").pop(), dir: root });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// One worktree's row. `pr` undefined = PR source not available.
export async function worktreeRow({ exec, fs, worktree, base, pr, terminals }) {
  const isBase = worktree.branch === base;
  const [status, files] = await Promise.all([
    worktreeStatus(exec, worktree.path),
    isBase || !worktree.branch ? null : docsSnapshot(exec, fs, worktree.path).then(snap => readWorkflowFiles(snap, worktree.path, worktree.branch)),
  ]);
  const gitFacts = files ? await phaseGitFacts(exec, worktree.path, files) : null;
  const phase = derivePhase({ isBase, files, git: gitFacts, pr, branch: worktree.branch });
  const terms = terminalsIn(terminals, worktree.path);
  return {
    path: worktree.path,
    branch: worktree.branch ?? `(detached ${String(worktree.head).slice(0, 7)})`,
    isBase,
    phase,
    group: GROUP_OF[phase.key],
    line: files ? statusLine(files, pr) : null,
    files: files && { plan: files.plan, batch: files.batch, newestReview: files.newestReview, notApplied: files.notApplied.length, slug: files.slug },
    planBase: files?.planFacts?.base ?? null,
    issue: files?.planFacts?.issue ?? null,
    pr: pr ? { number: pr.number, state: pr.state, isDraft: pr.isDraft, url: pr.url, base: pr.baseRefName } :
      pr === undefined && files?.planFacts?.pr ? { number: prNumberOf(files.planFacts.pr), state: null, url: String(files.planFacts.pr) } : null,
    signals: prSignals(pr),
    ci: prCiSummary(pr),
    ahead: status?.ahead ?? null,
    behind: status?.behind ?? null,
    dirty: status?.dirty ?? null,
    agent: mostUrgent(terms),
    terminals: terms.map(t => t.address),
  };
}

// opts: { exec, fs, repo: {name, dir}, terminals, prs: list|null|undefined, now }
// prs: a gh pr list result; null = gh failed (hide PRs); undefined = fetch here.
export async function gatherRepo({ exec, fs, repo, terminals, prs, fetchPrs }) {
  const t0 = Date.now();
  // The remote first (milliseconds), so the slow PR fetch runs beside the git work.
  const url = (await exec("git", ["remote", "get-url", "origin"], { cwd: repo.dir }).catch(() => null));
  const earlySlug = url?.code === 0 ? repoSlugFromUrl(url.stdout.trim()) : null;
  const prsPromise = prs !== undefined ? Promise.resolve(prs) : earlySlug && fetchPrs ? fetchPrs(earlySlug) : Promise.resolve(fetchPrs ? null : undefined);
  const info = await repoInfo(exec, repo.dir);
  if (!info) return { name: repo.name, dir: repo.dir, error: "not a git repository", rows: [], others: [], sessions: [] };
  const slug = repoSlugFromUrl(info.remoteUrl);
  const prList = await prsPromise;
  const byBranch = prList ? prsByBranch(prList) : null;

  const rows = await Promise.all(info.worktrees.map(w => worktreeRow({
    exec, fs, worktree: w, base: info.base, terminals,
    pr: byBranch ? (byBranch[w.branch] ?? null) : undefined,
  })));

  applyAgents(rows, terminals);

  // Stacks: a row whose base (plan front-matter, else PR base) is another worktree's branch.
  const byName = new Map(rows.map(r => [r.branch, r]));
  for (const r of rows) {
    const parent = r.planBase ?? r.pr?.base ?? null;
    if (parent && parent !== info.base && byName.has(parent) && parent !== r.branch) r.parent = parent;
  }

  const withWorktree = new Set(rows.map(r => r.branch));
  const seen = new Set();
  const others = [];
  for (const b of info.branches.local) if (!withWorktree.has(b.name)) { seen.add(b.name); others.push({ name: b.name, where: "local", time: b.time }); }
  for (const b of info.branches.remote) if (!withWorktree.has(b.name) && !seen.has(b.name)) { seen.add(b.name); others.push({ name: b.name, where: b.remote, time: b.time }); }
  others.sort((a, b) => b.time - a.time);

  // Branchless sessions: live terminals labelled orchestrator for this repo, or whose cwd is the
  // repository folder itself rather than one of its worktrees.
  const sessions = (terminals ?? []).filter(t => {
    if (t.state && t.state !== "live") return false;
    const l = readLabels(t.labels);
    if (l?.role === "orchestrator") return l.repo === repo.name;
    return isWithin(t.cwd, repo.dir) && !rows.some(r => isWithin(t.cwd, r.path)) && (t.agent || t.status);
  }).map(t => ({ address: t.address, status: typeof t.status === "string" ? t.status : null, cwd: t.cwd, agent: t.agent ?? null }));

  return {
    name: repo.name, dir: repo.dir, slug, base: info.base, hasRemote: !!info.remoteUrl,
    prs: byBranch ? "ok" : slug ? "unavailable" : "none",
    rows, others, sessions, ms: Date.now() - t0,
  };
}

// Agent status from live terminals onto rows (mods call this on every render, since
// terminals() is live while the gathered model is not). A blocked agent is a question waiting
// on the user whatever the phase; a working one is running.
export function applyAgents(rows, terminals) {
  for (const r of rows) {
    const terms = terminalsIn(terminals, r.path);
    r.agent = mostUrgent(terms);
    r.terminals = terms.map(t => t.address);
    r.group = r.agent === "blocked" ? "needs" : r.agent === "working" && GROUP_OF[r.phase.key] !== "needs" ? "running" : GROUP_OF[r.phase.key];
  }
  return rows;
}

export const GROUPS = [
  { key: "needs", title: "Needs you" },
  { key: "running", title: "Running" },
  { key: "review", title: "In review" },
  { key: "open", title: "Open" },
  { key: "done", title: "Merged / closed" },
];

// Rows per group, stacked children right under their parent (depth 1).
export function groupRows(model) {
  const out = [];
  for (const g of GROUPS) {
    const rows = model.rows.filter(r => r.group === g.key);
    if (!rows.length) continue;
    const top = rows.filter(r => !r.parent || !rows.some(p => p.branch === r.parent));
    const ordered = [];
    const order = (a, b) => (a.isBase ? -1 : b.isBase ? 1 : a.branch.localeCompare(b.branch));
    for (const r of top.sort(order)) {
      ordered.push({ row: r, depth: 0 });
      for (const c of rows.filter(c => c.parent === r.branch).sort(order)) ordered.push({ row: c, depth: 1 });
    }
    out.push({ ...g, items: ordered });
  }
  return out;
}

// Applies a persisted per-repo custom branch order (Spotify-playlist style).
// Known paths stay in the user's exact dragged order; brand-new worktrees appear at the top
// so newly started tasks aren't buried; deleted worktrees are ignored cleanly.
export function applyBranchOrder(items, savedPaths) {
  if (!Array.isArray(savedPaths) || !savedPaths.length) return items;
  const byPath = new Map(items.map(it => [it.row.path, it]));
  const ordered = [];
  const seen = new Set();
  for (const p of savedPaths) {
    const hit = byPath.get(p);
    if (hit && !seen.has(p)) {
      ordered.push(hit);
      seen.add(p);
    }
  }
  const fresh = items.filter(it => !seen.has(it.row.path));
  return [...fresh, ...ordered];
}

// Reorders `paths` by moving `fromPath` right before or right after `targetPath`.
export function reorderBranchList(paths, fromPath, targetPath, position = "before") {
  if (!Array.isArray(paths) || !fromPath || !targetPath || fromPath === targetPath) return [...(paths ?? [])];
  if (!paths.includes(fromPath) || !paths.includes(targetPath)) return [...paths];
  const without = paths.filter(p => p !== fromPath);
  const idx = without.indexOf(targetPath);
  if (idx < 0) return [...paths];
  const insertAt = position === "after" ? idx + 1 : idx;
  without.splice(insertAt, 0, fromPath);
  return without;
}

export const counts = model => ({
  needs: model.rows.filter(r => r.group === "needs").length,
  running: model.rows.filter(r => r.group === "running").length,
});
