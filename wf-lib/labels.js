// The label schema: the contract that ties an hc terminal to a repo, a branch and a session.
// Every terminal the app starts carries these labels; F1, F3 and F4 join on them.
// Documented in docs/schema.md. Bump LABEL_SCHEMA_VERSION on any incompatible change.

export const LABEL_SCHEMA_VERSION = 1;

export const ROLES = ["task", "orchestrator", "server", "shell"];

// key -> what it holds. `wf.v` marks a terminal as labelled by this app, and with which schema.
export const LABEL_KEYS = {
  "wf.v": "schema version",
  repo: "repository name (the folder under repos/)",
  branch: "branch name, e.g. feat/portal-ordering",
  worktree: "absolute worktree path",
  session: "Claude Code session id",
  role: ROLES.join(" | "),
};

// hc reports labels as {k: v}; older shapes are ["k=v", ...]. Both become {k: v}.
export function labelMap(labels) {
  if (!labels) return {};
  if (Array.isArray(labels)) {
    const out = {};
    for (const l of labels) {
      const i = String(l).indexOf("=");
      if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
    }
    return out;
  }
  return { ...labels };
}

// The app's view of one terminal's labels, or null when the app didn't label it.
export function readLabels(labels) {
  const m = labelMap(labels);
  if (!m["wf.v"] && !m.repo && !m.worktree) return null;
  return {
    v: Number(m["wf.v"] ?? 0),
    repo: m.repo ?? null,
    branch: m.branch ?? null,
    worktree: m.worktree ?? null,
    session: m.session ?? null,
    role: ROLES.includes(m.role) ? m.role : null,
  };
}

// ["--label", "k=v", ...] for `hc run`. Refuses unknown roles and values with whitespace or "=" in keys.
export function labelArgs({ repo, branch, worktree, session, role }) {
  if (role && !ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  const pairs = { "wf.v": String(LABEL_SCHEMA_VERSION), repo, branch, worktree, session, role };
  const args = [];
  for (const [k, v] of Object.entries(pairs)) {
    if (v == null || v === "") continue;
    if (/[\s]/.test(String(v))) throw new Error(`label ${k} must not contain whitespace`);
    args.push("--label", `${k}=${v}`);
  }
  return args;
}

// True when `path` is `root` or inside it.
export const isWithin = (path, root) => !!path && !!root && (path === root || path.startsWith(root.endsWith("/") ? root : root + "/"));

// The live terminals that belong to a worktree: by `worktree` label first, else by cwd.
export function terminalsIn(terminals, worktree) {
  return (terminals ?? []).filter(t => {
    if (t.state && t.state !== "live") return false;
    const l = readLabels(t.labels);
    if (l?.worktree) return l.worktree === worktree;
    return isWithin(t.cwd, worktree);
  });
}

// Live terminals running directly at `dir` (not inside nested repo/worktree subdirectories).
// Used for the global "Everything" workspace section so repo sessions never leak into it.
export function terminalsAt(terminals, dir) {
  const norm = p => (p ? String(p).replace(/\/+$/, "") : "");
  const target = norm(dir);
  if (!target) return [];
  return (terminals ?? []).filter(t => {
    if (t.state && t.state !== "live") return false;
    const l = readLabels(t.labels);
    if (l?.worktree) return norm(l.worktree) === target;
    return norm(t.cwd) === target;
  });
}

// Agent status of a set of terminals, most urgent first (as herdr ranks it).
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
export function mostUrgent(terminals) {
  let best = null;
  for (const t of terminals) {
    const s = typeof t.status === "string" ? t.status : t.status?.status;
    if (s && RANK[s] && (!best || RANK[s] > RANK[best])) best = s;
  }
  return best;
}
