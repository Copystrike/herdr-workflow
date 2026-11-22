// RepoLayout + git facts. `exec(cmd, args, { cwd })` resolves to { code, stdout, stderr }
// (herdr's exec; tests pass a node adapter). Nothing here writes to a repository.

const G = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

export async function git(exec, cwd, args) {
  const r = await exec("git", [...G, ...args], { cwd });
  return r.code === 0 ? r.stdout : null;
}

export function parseWorktrees(porcelain) {
  const out = [];
  for (const block of (porcelain ?? "").replace(/\r/g, "").split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length) continue;
    const w = { path: null, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
    for (const l of lines) {
      const [k, ...rest] = l.split(" ");
      const v = rest.join(" ");
      if (k === "worktree") w.path = v;
      else if (k === "HEAD") w.head = v;
      else if (k === "branch") w.branch = v.replace(/^refs\/heads\//, "");
      else if (k === "bare") w.bare = true;
      else if (k === "detached") w.detached = true;
      else if (k === "locked") w.locked = true;
      else if (k === "prunable") w.prunable = true;
    }
    if (w.path) out.push(w);
  }
  return out;
}

// for-each-ref with FORMAT below: local and remote branches, newest first.
export const REF_FORMAT = "%(refname)%00%(upstream:short)%00%(committerdate:unix)%00%(objectname:short)";
export function parseRefs(text) {
  const local = [], remote = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    const [ref, upstream, time, sha] = line.split("\0");
    if (ref.startsWith("refs/heads/")) local.push({ name: ref.slice(11), upstream: upstream || null, time: Number(time) || 0, sha });
    else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice(13);
      if (name.endsWith("/HEAD")) continue;
      const i = name.indexOf("/");
      remote.push({ remote: name.slice(0, i), name: name.slice(i + 1), full: name, time: Number(time) || 0, sha });
    }
  }
  const byTime = (a, b) => b.time - a.time;
  return { local: local.sort(byTime), remote: remote.sort(byTime) };
}

// `git status --porcelain=v2 --branch`: ahead/behind its upstream and counts of staged/unstaged/untracked paths.
export function parseStatus(text) {
  const s = { ahead: null, behind: null, dirty: 0, staged: 0, unstaged: 0, untracked: 0, upstream: null };
  for (const l of (text ?? "").split("\n")) {
    if (l.startsWith("# branch.upstream ")) s.upstream = l.slice(18);
    else if (l.startsWith("# branch.ab ")) {
      const m = l.match(/\+(\d+) -(\d+)/);
      if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
    } else if (l && !l.startsWith("#")) {
      s.dirty++;
      if (l.startsWith("? ")) {
        s.untracked++;
      } else if (l.startsWith("u ")) {
        s.staged++;
        s.unstaged++;
      } else if ((l.startsWith("1 ") || l.startsWith("2 ")) && l.length >= 4) {
        if (l[2] !== ".") s.staged++;
        if (l[3] !== ".") s.unstaged++;
      }
    }
  }
  return s;
}

// Returns a human-readable block reason when a worktree has uncommitted changes (staged,
// unstaged, or untracked) or when git status could not be verified; null when clean to archive.
export function archiveBlockReason(status) {
  if (!status) return "Could not verify git status. Commit or inspect changes before archiving.";
  if (!status.dirty) return null;
  const parts = [];
  if (status.staged) parts.push(`${status.staged} staged`);
  if (status.unstaged) parts.push(`${status.unstaged} unstaged`);
  if (status.untracked) parts.push(`${status.untracked} untracked`);
  const detail = parts.length ? parts.join(", ") : `${status.dirty} uncommitted`;
  return `Commit all changes before archiving (${detail}).`;
}

export async function repoInfo(exec, repoDir) {
  const [wt, refs, remoteUrl, head] = await Promise.all([
    git(exec, repoDir, ["worktree", "list", "--porcelain"]),
    git(exec, repoDir, ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"]),
    git(exec, repoDir, ["remote", "get-url", "origin"]),
    git(exec, repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
  ]);
  if (wt === null) return null;
  const branches = parseRefs(refs);
  let base = head ? head.trim().replace(/^origin\//, "") : null;
  if (!base) base = ["main", "master", "develop"].find(b => branches.local.some(l => l.name === b)) ?? null;
  return {
    worktrees: parseWorktrees(wt).filter(w => !w.bare),
    branches,
    remoteUrl: remoteUrl ? remoteUrl.trim() : null,
    base,
  };
}

// The git half of a phase: was the review logged after the last milestone, and was code
// committed after the newest review log (a Gate 2 fix round)?
export async function phaseGitFacts(exec, worktree, files) {
  const out = { reviewedAfterMilestones: null, codeAfterReview: null, reviewCommit: null };
  if (!files || (!files.planFacts && !files.batchFacts)) return out;
  const dirs = files.reviewDirs ?? [];
  if (!files.reviews?.length) { out.reviewedAfterMilestones = false; return out; }
  const log = await git(exec, worktree, ["log", "-1", "--format=%H %ct", "--", ...dirs]);
  const [reviewCommit, reviewTime] = (log ?? "").trim().split(" ");
  out.reviewCommit = reviewCommit || null;
  const last = files.planFacts?.milestones?.lastCommit;
  if (last && reviewTime) {
    const t = await git(exec, worktree, ["show", "-s", "--format=%ct", last]);
    // A squashed or rebased branch keeps the old milestone objects; compare times, not ancestry.
    out.reviewedAfterMilestones = t ? Number(reviewTime) >= Number(t.trim()) : true;
  } else out.reviewedAfterMilestones = true; // logs exist but are uncommitted, or no milestone sha
  if (out.reviewCommit) {
    // The branch's own commits only, the range pre-pr-review's `since` reads
    // (`git log --first-parent --no-merges <sha>..HEAD`): a merge of the base is not a fix round.
    const n = await git(exec, worktree, ["rev-list", "--count", "--first-parent", "--no-merges", `${out.reviewCommit}..HEAD`, "--", ".", ":(exclude)docs"]);
    out.codeAfterReview = n === null ? null : Number(n.trim()) > 0;
  }
  return out;
}

export async function worktreeStatus(exec, worktree) {
  const s = await git(exec, worktree, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  return s === null ? null : parseStatus(s);
}

// owner/name from a remote URL, including SSH host aliases.
export const repoSlugFromUrl = url => url?.match(/[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
