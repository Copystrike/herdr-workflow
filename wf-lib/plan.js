// PhaseSource: reads optional markdown plan files, fix batches, and review logs in a worktree
// into plain facts for derivePhase().
//
// `fs` is the subset herdr gives mods (and node:fs/promises has):
//   readFile(path, "utf8"), readdir(path, { withFileTypes: true }), and optionally exists(path).

import { parseFrontMatter, sections } from "./frontmatter.js";

const exists = async (fs, p) => {
  if (fs.exists) return fs.exists(p);
  try { await fs.readFile(p, "utf8"); return true; } catch { return false; }
};
const dirExists = async (fs, p) => {
  try { await fs.readdir(p); return true; } catch { return false; }
};
const read = async (fs, p) => {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
};

export const slugOf = branch => (branch ?? "").split("/").pop();

// Plan discovery can read a few hundred folders under docs/, and in a mod each read is a round
// trip to the host. One `find` lists docs/ instead; readdir and exists under it answer from that
// list, everything else goes to the real fs. Falls back to the real fs when find fails.
const SNAPSHOT_DEPTH = 8; // docs/ + 4 walked folders + features/<slug>/implementation-plan.md
export async function docsSnapshot(exec, fs, worktree) {
  const root = `${worktree}/docs`;
  const r = await exec("find", ["-L", root, "-maxdepth", String(SNAPSHOT_DEPTH), "-printf", "%y\t%P\n"]).catch(() => null);
  const missing = r && r.code !== 0 && /No such file/.test(r.stderr) && !r.stdout;
  if (!r || (r.code !== 0 && !missing)) return fs;
  const dirs = new Map(missing ? [] : [["", []]]);
  const files = new Set();
  for (const line of missing ? [] : r.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0 || !line.slice(tab + 1)) continue;
    const type = line.slice(0, tab), rel = line.slice(tab + 1);
    const cut = rel.lastIndexOf("/");
    const parent = cut < 0 ? "" : rel.slice(0, cut), name = rel.slice(cut + 1);
    if (type === "d") { if (!dirs.has(rel)) dirs.set(rel, []); } else files.add(rel);
    if (!dirs.has(parent)) dirs.set(parent, []);
    dirs.get(parent).push({ name, dir: type === "d" });
  }
  const under = p => (p === root ? "" : p.startsWith(root + "/") ? p.slice(root.length + 1).replace(/\/+$/, "") : null);
  const deep = rel => rel.split("/").length >= SNAPSHOT_DEPTH;
  const notFound = p => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return {
    ...fs,
    readFile: (...a) => fs.readFile(...a),
    async exists(p) {
      const rel = under(p);
      if (rel === null || (rel && deep(rel))) return fs.exists ? fs.exists(p) : exists(fs, p);
      return rel === "" ? dirs.has("") : dirs.has(rel) || files.has(rel);
    },
    async readdir(p, opts) {
      const rel = under(p);
      if (rel === null || (rel && deep(rel))) return fs.readdir(p, opts);
      const list = dirs.get(rel);
      if (!list) throw notFound(p);
      return opts?.withFileTypes ? list.map(e => ({ name: e.name, isDirectory: () => e.dir, isFile: () => !e.dir })) : list.map(e => e.name);
    },
  };
}

// Plan search order: docs/features/<slug>/implementation-plan.md, docs/<slug>-plan.md,
// then any docs/**/features/<slug>/implementation-plan.md up to 4 folders under docs/.
export async function findPlan(fs, worktree, slug) {
  for (const p of [`docs/features/${slug}/implementation-plan.md`, `docs/${slug}-plan.md`])
    if (await exists(fs, `${worktree}/${p}`)) return p;
  async function walk(dir, depth) {
    if (depth < 0) return null;
    let entries;
    try { entries = await fs.readdir(`${worktree}/${dir}`, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = `${dir}/${e.name}`;
      if (e.name === "features" && await exists(fs, `${worktree}/${p}/${slug}/implementation-plan.md`)) return `${p}/${slug}/implementation-plan.md`;
      const hit = await walk(p, depth - 1);
      if (hit) return hit;
    }
    return null;
  }
  return walk("docs", 4);
}

export async function findBatch(fs, worktree, slug) {
  const p = `docs/fixes/${slug}.md`;
  return (await exists(fs, `${worktree}/${p}`)) ? p : null;
}

// Where review logs can live: beside the plan, or under docs/reviews/<slug>/.
// Both are read; the newest log wins.
export function reviewDirs(plan, slug) {
  const dirs = [];
  if (plan?.endsWith("/implementation-plan.md")) dirs.push(`${plan.slice(0, -"/implementation-plan.md".length)}/reviews`);
  dirs.push(`docs/reviews/${slug}`);
  return [...new Set(dirs)];
}

const LOG = /^(\d{8})-(\d{4})\.md$/;
export async function listReviews(fs, worktree, dirs) {
  const out = [];
  for (const d of dirs) {
    let names;
    try { names = await fs.readdir(`${worktree}/${d}`); } catch { continue; }
    for (const n of names) {
      const name = typeof n === "string" ? n : n.name;
      if (LOG.test(name)) out.push({ path: `${d}/${name}`, stamp: name.slice(0, 13) });
    }
  }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp));
}

// "- missing: …", "- unasked: …" and plain items under "## Not applied".
export function notApplied(reviewText) {
  const s = sections(reviewText ?? "").find(x => /^not applied$/i.test(x.title));
  if (!s) return [];
  return s.text.split("\n").filter(l => /^- /.test(l)).map(l => {
    const text = l.slice(2).trim();
    const kind = text.match(/^(missing|unasked):/i)?.[1].toLowerCase() ?? "other";
    return { kind, text };
  });
}

// Active milestone statuses. Any other word (blocked, skipped, deferred, ...) marks a
// milestone deliberately not built: settled, so it neither keeps the run in implement nor reads
// as an interrupted one.
const ACTIVE_STATUSES = new Set(["todo", "in_progress", "done"]);
export const isSettledStatus = status => !ACTIVE_STATUSES.has(status);

// A milestone counts as done only with status done AND a commit (state-machine.md). A mismatch
// is an interrupted run; in_progress alone is still implementing.
export function milestoneFacts(list) {
  const ms = Array.isArray(list) ? list : [];
  const items = ms.map(m => ({
    id: m?.id ?? null, title: m?.title ?? "",
    status: String(m?.status ?? "todo").trim().toLowerCase(),
    commit: m?.commit == null ? null : String(m.commit),
  }));
  const done = items.filter(m => m.status === "done" && m.commit);
  const settled = items.filter(m => isSettledStatus(m.status));
  const byWord = new Map();
  for (const m of settled) byWord.set(m.status, (byWord.get(m.status) ?? 0) + 1);
  return {
    total: items.length,
    done: done.length,
    settled: settled.length,
    settledText: [...byWord].map(([w, n]) => `${n} ${w}`).join(", "),
    interrupted: items.some(m => !isSettledStatus(m.status) && (m.status === "done") !== Boolean(m.commit)),
    lastCommit: done.length ? done[done.length - 1].commit : null,
    items,
  };
}

// Fix batch: top-level "- [ ]" / "- [x]" items; an item with a "dropped:" line has left the batch,
// one with a "waiting:" line waits on someone.
export function batchFacts(text) {
  const items = [];
  let cur = null;
  for (const line of (text ?? "").split("\n")) {
    const m = line.match(/^- \[( |x|X)\]\s*(.*)$/);
    if (m) { cur = { done: m[1] !== " ", title: m[2].replace(/\*\*/g, "").split(" — ")[0].trim(), dropped: false, waiting: false }; items.push(cur); continue; }
    if (cur && /^\s+dropped:/.test(line)) cur.dropped = true;
    if (cur && /^\s+waiting:/.test(line)) cur.waiting = true;
  }
  const handover = (text ?? "").match(/^Handover:\s*(\S+)/m)?.[1] ?? null;
  const live = items.filter(i => !i.dropped);
  return {
    total: live.length,
    done: live.filter(i => i.done).length,
    dropped: items.length - live.length,
    waiting: live.filter(i => i.waiting && !i.done).length,
    handover,
    items,
  };
}

// The facts a worktree's files hold. Git facts (commit times) are added by the caller.
export async function readWorkflowFiles(fs, worktree, branch) {
  const slug = slugOf(branch);
  const plan = await findPlan(fs, worktree, slug);
  const batch = plan ? null : await findBatch(fs, worktree, slug);
  const dirs = reviewDirs(plan, slug);
  const reviews = await listReviews(fs, worktree, dirs);
  const newest = reviews.length ? reviews[reviews.length - 1] : null;
  const facts = { slug, plan, batch, reviewDirs: dirs, reviews, newestReview: newest?.path ?? null, notApplied: [] };
  if (newest) facts.notApplied = notApplied(await read(fs, `${worktree}/${newest.path}`));

  if (plan) {
    const text = await read(fs, `${worktree}/${plan}`);
    let parsed;
    try { parsed = parseFrontMatter(text ?? ""); } catch (e) { return { ...facts, error: `plan front-matter: ${e.message}` }; }
    const fm = parsed.data ?? {};
    const secs = sections(parsed.body);
    const sec = t => secs.find(s => s.title.toLowerCase() === t);
    const deviations = sec("deviations")?.text ?? "";
    const stopped = sec("stopped")?.text ?? null;
    facts.frontMatter = fm;
    facts.planFacts = {
      issue: fm.issue ?? null,
      approved: fm.approved === true,
      seeded: fm.seeded ?? null, // false | true | "removed" | null (absent: older plan)
      pr: fm.pr ?? null,
      base: fm.base ?? fm.stack?.base ?? null,
      artifacts: { plan: fm.artifacts?.plan ?? null, handover: fm.artifacts?.handover ?? null },
      milestones: milestoneFacts(fm.milestones),
      deviations: deviations.split("\n").filter(l => /^\s*[-*\d]/.test(l)).length,
      stopped: stopped && stopped.trim() ? stopped.trim() : null,
    };
  }
  if (batch) {
    const text = await read(fs, `${worktree}/${batch}`);
    facts.batchFacts = batchFacts(text);
    facts.batchFacts.stopped = sections(text ?? "").find(s => s.title.toLowerCase() === "stopped")?.text || null;
  }
  return facts;
}

// The front-matter's PR number, from a URL or a bare number.
export const prNumberOf = pr => {
  if (pr == null) return null;
  const m = String(pr).match(/(?:pull\/|#|^)(\d+)\s*$/);
  return m ? Number(m[1]) : null;
};
