// Pure helpers for the Termic-style Git panel (mods/wf-changes):
//   - Termic's Sublime/fzf-style multi-term fuzzy matcher (ported from src/lib/fuzzy.tsx)
//   - Porcelain v1 (-z) staged/unstaged split parser & numstat/name-status parsers
//   - Tree & flat list builder with single-child folder compaction and viewed-count rollups
//   - Commit log & ref-chip parser
//   - Diff content search across added/removed lines
//   - GitHub blob/tree/commit URL builder

/**
 * Single-term match: substring-first with basename & word-boundary boosts,
 * falling back to subsequence scan for typos / abbreviated tokens.
 */
function matchTerm(s, lower, term, slash) {
  const t = term.toLowerCase();
  let bestSubstr = null;
  for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
    let sc = 100 + t.length * 9;
    const prev = i > 0 ? s[i - 1] : "/";
    if (prev === "/" || prev === "-" || prev === "_" || prev === ".") sc += 10;
    if (i > slash) sc += 8;
    sc -= i * 0.05;
    if (!bestSubstr || sc > bestSubstr.score) bestSubstr = { idx: i, score: sc };
  }
  if (bestSubstr) {
    const matches = [];
    for (let i = 0; i < t.length; i++) matches.push(bestSubstr.idx + i);
    return { score: bestSubstr.score, matches };
  }
  const matches = [];
  let qi = 0;
  let prevMatch = -2;
  let score = 0;
  for (let i = 0; i < lower.length && qi < t.length; i++) {
    if (lower[i] !== t[qi]) continue;
    matches.push(i);
    let bonus = 1;
    if (i === prevMatch + 1) bonus += 8;
    const prev = i > 0 ? s[i - 1] : "/";
    if (prev === "/" || prev === "-" || prev === "_" || prev === ".") bonus += 4;
    if (i > slash) bonus += 2;
    if (s[i] === term[qi]) bonus += 1;
    score += bonus;
    prevMatch = i;
    qi++;
  }
  if (qi < t.length) return null;
  return { score, matches };
}

/**
 * Multi-term AND fuzzy matcher (Sublime/fzf convention):
 * whitespace-separated tokens must all match; returns { score, matches } or null.
 */
export function fuzzyMatch(s, query) {
  if (!query || !String(query).trim()) return { score: 0, matches: [] };
  const terms = String(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, matches: [] };
  const str = String(s ?? "");
  const lower = str.toLowerCase();
  const slash = str.lastIndexOf("/");
  const allMatches = new Set();
  let total = 0;
  for (const t of terms) {
    const r = matchTerm(str, lower, t, slash);
    if (!r) return null;
    total += r.score;
    for (const m of r.matches) allMatches.add(m);
  }
  total -= str.length * 0.01;
  return { score: total, matches: [...allMatches].sort((a, b) => a - b) };
}

/** Filters and ranks an array by fuzzyMatch on `getText(item)`. Preserves order on empty query. */
export function filterFuzzy(items, query, getText = x => x.path) {
  const q = String(query ?? "").trim();
  if (!q) return items.map(item => ({ item, score: 0, matches: [] }));
  const hits = [];
  for (const item of items) {
    const m = fuzzyMatch(getText(item), q);
    if (m) hits.push({ item, score: m.score, matches: m.matches });
  }
  hits.sort((a, b) => b.score - a.score || getText(a.item).localeCompare(getText(b.item)));
  return hits;
}

/** Parses `git diff --numstat -z` output into { [path]: { added, removed, binary } }. */
export function parseNumstatZ(raw) {
  const stats = {};
  if (!raw) return stats;
  const parts = String(raw).split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const cols = entry.split("\t");
    if (cols.length < 3) continue;
    const [a, d] = cols;
    let p = cols.slice(2).join("\t");
    // Rename format with -z: "a\td\t\0old\0new"
    if (p === "" && i + 2 < parts.length) {
      p = parts[i + 2];
      i += 2;
    }
    if (!p) continue;
    const prev = stats[p] ?? { added: 0, removed: 0, binary: false };
    const binary = a === "-" || d === "-";
    stats[p] = {
      added: prev.added + (binary ? 0 : (Number(a) || 0)),
      removed: prev.removed + (binary ? 0 : (Number(d) || 0)),
      binary: prev.binary || binary,
    };
  }
  return stats;
}

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=all` into separate
 * `{ staged, unstaged }` lists, preserving partially-staged files in both panes.
 */
export function parsePorcelainSplit(raw, stagedStats = {}, unstagedStats = {}) {
  const staged = [];
  const unstaged = [];
  if (!raw) return { staged, unstaged };
  const parts = String(raw).split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    let oldPath = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      oldPath = parts[i + 1] || null;
      i++;
    }
    if (x === "?" && y === "?") {
      const st = unstagedStats[path] ?? { added: 0, removed: 0, binary: false };
      unstaged.push({
        path, status: "?", fresh: true,
        added: st.added, removed: st.removed, binary: st.binary,
        fp: `?:${st.added}:${st.removed}`,
      });
      continue;
    }
    const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (conflict) {
      const st = unstagedStats[path] ?? { added: 0, removed: 0, binary: false };
      unstaged.push({
        path, status: "U", fresh: false,
        added: st.added, removed: st.removed, binary: st.binary,
        fp: `U:${st.added}:${st.removed}`,
      });
      continue;
    }
    if (x !== " " && x !== "?") {
      const st = stagedStats[path] ?? { added: 0, removed: 0, binary: false };
      staged.push({
        path, oldPath, status: x, fresh: x === "A",
        added: st.added, removed: st.removed, binary: st.binary,
        fp: x === "D" ? "" : `S:${x}:${st.added}:${st.removed}`,
      });
    }
    if (y !== " " && y !== "?") {
      const st = unstagedStats[path] ?? { added: 0, removed: 0, binary: false };
      unstaged.push({
        path, oldPath, status: y, fresh: false,
        added: st.added, removed: st.removed, binary: st.binary,
        fp: y === "D" ? "" : `U:${y}:${st.added}:${st.removed}`,
      });
    }
  }
  return { staged, unstaged };
}

/**
 * Parses `git diff --name-status -z -M` output into normalized file entries
 * merged with `numstat` counts.
 */
export function parseNameStatusZ(raw, stats = {}) {
  const out = [];
  if (!raw) return out;
  const parts = String(raw).split("\0");
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const ch = code[0];
    if (ch === "R" || ch === "C") {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      i += 2;
      if (!newPath) continue;
      const st = stats[newPath] ?? { added: 0, removed: 0, binary: false };
      out.push({
        path: newPath, oldPath, status: ch, fresh: false,
        added: st.added, removed: st.removed, binary: st.binary,
        fp: `${ch}:${st.added}:${st.removed}`,
      });
    } else {
      const p = parts[i + 1];
      i += 1;
      if (!p) continue;
      const st = stats[p] ?? { added: 0, removed: 0, binary: false };
      out.push({
        path: p, status: ch, fresh: ch === "A",
        added: st.added, removed: st.removed, binary: st.binary,
        fp: ch === "D" ? "" : `${ch}:${st.added}:${st.removed}`,
      });
    }
  }
  return out;
}

/**
 * Builds flat render rows for either "tree" (compacting single-child directory chains)
 * or "list" view, carrying folder file lists so right-click "Mark folder as viewed"
 * and "Stage/Unstage folder" work cleanly.
 */
export function buildFileRows(files, { viewMode = "tree", collapsed = new Set(), prefix = "", isViewed = null } = {}) {
  if (viewMode === "list") {
    return files.map(file => ({
      kind: "file",
      file,
      label: file.path.split("/").pop() || file.path,
      dirLabel: file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "",
      depth: 0,
    }));
  }

  const root = { name: "", dirPath: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const segs = file.path.split("/");
    const name = segs.pop();
    let node = root;
    let acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, dirPath: acc, dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    node.files.push({ file, label: name || file.path });
  }

  const collectFiles = (node) => {
    const all = node.files.map(x => x.file);
    for (const child of node.dirs.values()) all.push(...collectFiles(child));
    return all;
  };

  const rows = [];
  const walk = (node, depth) => {
    const dirList = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (let d of dirList) {
      let label = d.name;
      while (d.files.length === 0 && d.dirs.size === 1) {
        const next = [...d.dirs.values()][0];
        label = `${label}/${next.name}`;
        d = next;
      }
      const key = `${prefix}\0${d.dirPath}`;
      const isCollapsed = collapsed.has(key);
      const subFiles = collectFiles(d);
      const viewedCount = isViewed ? subFiles.filter(f => isViewed(f)).length : 0;
      rows.push({
        kind: "dir",
        name: label,
        dirPath: d.dirPath,
        key,
        depth,
        isCollapsed,
        files: subFiles,
        fileCount: subFiles.length,
        viewedCount,
      });
      if (!isCollapsed) walk(d, depth + 1);
    }
    const fileList = [...node.files].sort((a, b) => a.label.localeCompare(b.label));
    for (const item of fileList) {
      rows.push({ kind: "file", file: item.file, label: item.label, dirLabel: "", depth });
    }
  };
  walk(root, 0);
  return rows;
}

/** Splits git's `%D` decoration string into typed ref chips (HEAD first, then branches, tags, remotes). */
export function parseRefChips(raw) {
  if (!raw || !String(raw).trim()) return [];
  const out = [];
  for (const part of String(raw).split(",")) {
    const r = part.trim();
    if (!r) continue;
    if (r.startsWith("tag: ")) { out.push({ label: r.slice(5), kind: "tag" }); continue; }
    if (r.startsWith("HEAD -> ")) { out.push({ label: r.slice(8), kind: "head" }); continue; }
    if (r === "HEAD") { out.push({ label: "HEAD", kind: "head" }); continue; }
    out.push({ label: r, kind: r.includes("/") ? "remote" : "branch" });
  }
  const rank = { head: 0, branch: 1, tag: 2, remote: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** Parses `git log --format=%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%cr%x1f%s%x1f%ct%x1e` output. */
export function parseCommitLog(raw) {
  if (!raw) return [];
  const commits = [];
  for (const rec of String(raw).split("\x1e")) {
    const trimmed = rec.replace(/^\r?\n/, "");
    if (!trimmed) continue;
    const [sha, short, parents, refs, author, age, subject, tsRaw] = trimmed.split("\x1f");
    if (!sha) continue;
    const ts = tsRaw ? Number(tsRaw.trim()) : null;
    commits.push({
      sha: sha.trim(),
      short: (short || sha.slice(0, 7)).trim(),
      parents: parents ? parents.trim().split(/\s+/).filter(Boolean) : [],
      refs: parseRefChips(refs),
      author: (author || "").trim(),
      age: (age || "").trim(),
      subject: (subject || "").trim(),
      timestamp: Number.isFinite(ts) ? ts : null,
    });
  }
  return commits;
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact Termic-style commit age: "now", "12m", "5h", "3d", or "Nov 9" beyond 6 days. */
export function formatCommitAge(unixSec, nowMs = Date.now()) {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return "";
  const diffSec = Math.max(0, Math.floor(nowMs / 1000 - unixSec));
  if (diffSec < 90) return "now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h`;
  const days = Math.floor(diffSec / 86400);
  if (days < 7) return `${days}d`;
  const d = new Date(unixSec * 1000);
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Port of Termic's active-lanes git commit graph layout (`src/lib/gitGraph.ts`).
 * Given commits in `--topo-order` (newest first), assigns each commit a column (`lane`),
 * palette index (`color`), and per-row line segments (`through`, `in`, `out`) plus `width`.
 */
export function layoutGraph(commits) {
  const rows = [];
  const lanes = [];
  let nextColor = 0;

  const firstFree = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  const trim = arr => { while (arr.length && arr[arr.length - 1] === null) arr.pop(); };

  for (const commit of commits ?? []) {
    const waiting = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.sha === commit.sha) waiting.push(i);
    }

    const before = lanes.slice();
    const lane = waiting.length ? waiting[0] : firstFree();
    const color = waiting.length ? lanes[lane].color : nextColor++;

    const after = lanes.slice();
    for (const i of waiting) after[i] = null;
    after[lane] = null;
    while (after.length <= lane) after.push(null);

    const links = [];
    const parents = commit.parents ?? [];
    parents.forEach((parent, k) => {
      const existing = after.findIndex(l => l?.sha === parent);
      if (existing >= 0) {
        links.push({ fromLane: lane, toLane: existing, color: after[existing].color, kind: "out" });
        return;
      }
      const target = k === 0 ? lane : (after.indexOf(null) === -1 ? after.length : after.indexOf(null));
      while (after.length <= target) after.push(null);
      const c = k === 0 ? color : nextColor++;
      after[target] = { sha: parent, color: c };
      links.push({ fromLane: lane, toLane: target, color: c, kind: "out" });
    });

    for (let i = 0; i < before.length; i++) {
      const l = before[i];
      if (!l) continue;
      if (l.sha === commit.sha) {
        links.push({ fromLane: i, toLane: lane, color: l.color, kind: "in" });
      } else {
        links.push({ fromLane: i, toLane: i, color: l.color, kind: "through" });
      }
    }

    trim(after);
    rows.push({
      sha: commit.sha,
      lane,
      color,
      links,
      afterLanes: after.map((l, idx) => (l ? { lane: idx, color: l.color } : null)).filter(Boolean),
      width: Math.max(before.length, after.length, lane + 1),
    });
    lanes.length = 0;
    lanes.push(...after);
  }
  return rows;
}

export function graphWidth(rows) {
  return (rows ?? []).reduce((m, r) => Math.max(m, r.width), 0);
}

/**
 * Searches unified diff text for matching added (`+`), removed (`-`), or both (`both`) lines.
 * Supports case sensitivity, whole-word (`ab`), regex (`.*`), and commit-by-commit (`git log -p`) diffs.
 */
export function searchUnifiedDiff(diffText, query, { side = "both", caseSensitive = false, wholeWord = false, regex = false, maxHits = 250 } = {}) {
  const q = String(query ?? "").trim();
  if (!q || !diffText) return [];
  let matcher;
  try {
    if (regex) {
      const re = new RegExp(q, caseSensitive ? "" : "i");
      matcher = s => re.test(s);
    } else if (wholeWord) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${esc}\\b`, caseSensitive ? "" : "i");
      matcher = s => re.test(s);
    } else {
      const needle = caseSensitive ? q : q.toLowerCase();
      matcher = s => (caseSensitive ? s : s.toLowerCase()).includes(needle);
    }
  } catch {
    return [];
  }

  const hits = [];
  let curPath = null;
  let curCommit = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of String(diffText).split("\n")) {
    if (rawLine.startsWith("commit ")) {
      const m = /^commit ([0-9a-f]{7,40})/.exec(rawLine);
      if (m) curCommit = m[1];
      continue;
    }
    if (rawLine.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
      curPath = m ? m[2] : null;
      continue;
    }
    if (rawLine.startsWith("+++ b/")) {
      curPath = rawLine.slice(6);
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(rawLine);
      if (m) { oldLine = Number(m[1]); newLine = Number(m[2]); }
      continue;
    }
    if (!curPath || rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) continue;
    const ch = rawLine[0];
    if (ch === "+") {
      const text = rawLine.slice(1);
      if (side !== "removed" && matcher(text)) {
        hits.push({ path: curPath, line: newLine, sign: "+", text: text.trim().slice(0, 140), ...(curCommit ? { commit: curCommit } : {}) });
        if (hits.length >= maxHits) break;
      }
      newLine++;
    } else if (ch === "-") {
      const text = rawLine.slice(1);
      if (side !== "added" && matcher(text)) {
        hits.push({ path: curPath, line: oldLine, sign: "-", text: text.trim().slice(0, 140), ...(curCommit ? { commit: curCommit } : {}) });
        if (hits.length >= maxHits) break;
      }
      oldLine++;
    } else if (ch === " ") {
      oldLine++;
      newLine++;
    }
  }
  return hits;
}

/**
 * Parses unified diff text into aligned side-by-side split rows AND unified rows,
 * emitting `{ kind: "gap", count, header }` rows between hunks (matching Termic's DiffPane).
 */
export function parseSplitDiff(unifiedText) {
  const split = [];
  const unified = [];
  if (!unifiedText) return { split, unified };
  const rawLines = String(unifiedText).replace(/\r?\n$/, "").split("\n");
  const untab = s => s.replace(/[^\t]*\t/g, m => m.slice(0, -1).padEnd((m.length - 1) - (m.length - 1) % 4 + 4));

  let i = rawLines.findIndex(l => l.startsWith("@@ "));
  if (i < 0) {
    const msg = rawLines.find(l => l.trim()) || "No text diff available";
    return {
      split: [{ kind: "note", text: msg }],
      unified: [{ kind: "note", text: msg }],
    };
  }

  let prevNewEnd = 1;
  let oldNum = 0;
  let newNum = 0;
  let delBuf = [];
  let addBuf = [];

  const flushChanges = () => {
    const n = Math.max(delBuf.length, addBuf.length);
    for (let k = 0; k < n; k++) {
      const l = delBuf[k] ?? null;
      const r = addBuf[k] ?? null;
      split.push({ kind: "pair", left: l, right: r });
    }
    for (const l of delBuf) unified.push({ kind: "-", oldNum: l.num, newNum: null, text: l.text });
    for (const r of addBuf) unified.push({ kind: "+", oldNum: null, newNum: r.num, text: r.text });
    delBuf = [];
    addBuf = [];
  };

  for (; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.startsWith("@@ ")) {
      flushChanges();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (m) {
        oldNum = Number(m[1]);
        newNum = Number(m[3]);
        const skipped = Math.max(0, newNum - prevNewEnd);
        const ctxHint = (m[5] || "").trim();
        const label = skipped > 0
          ? `${skipped} unchanged ${skipped === 1 ? "line" : "lines"}${ctxHint ? `  ·  ${ctxHint}` : ""}`
          : (ctxHint || line);
        const gapRow = { kind: "gap", count: skipped, header: line, label };
        split.push(gapRow);
        unified.push(gapRow);
      }
      continue;
    }
    if (line.startsWith("\\ No newline")) continue;
    const ch = line[0];
    if (ch === "-") {
      delBuf.push({ num: oldNum++, text: untab(line.slice(1)), kind: "-" });
    } else if (ch === "+") {
      addBuf.push({ num: newNum++, text: untab(line.slice(1)), kind: "+" });
      prevNewEnd = newNum;
    } else if (ch === " ") {
      flushChanges();
      const txt = untab(line.slice(1));
      split.push({ kind: "ctx", left: { num: oldNum, text: txt, kind: " " }, right: { num: newNum, text: txt, kind: " " } });
      unified.push({ kind: " ", oldNum, newNum, text: txt });
      oldNum++;
      newNum++;
      prevNewEnd = newNum;
    }
  }
  flushChanges();
  return { split, unified };
}

/** Builds a GitHub URL for a file, directory, or commit. */
export function githubUrlFor({ slug, ref = "main", path = "", isDir = false, commit = null }) {
  if (!slug) return null;
  const cleanSlug = String(slug).replace(/^\/+|\/+$/g, "");
  if (commit && !path) return `https://github.com/${cleanSlug}/commit/${encodeURIComponent(commit)}`;
  const targetRef = commit || ref || "main";
  const encodedPath = String(path)
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const kind = isDir ? "tree" : "blob";
  return `https://github.com/${cleanSlug}/${kind}/${encodeURIComponent(targetRef)}${encodedPath ? `/${encodedPath}` : ""}`;
}
