// Full Termic-style Git panel for Herdr's right sidebar (Commit / Compare / History):
//   - Top PR status strip (#num, state, CI, review decision, clickable GitHub link)
//   - Branch + sync strip (ahead/behind, Fetch, Pull, Push, Tree/List, Hide untracked)
//   - Top fuzzy Filter input (multi-term Termic fuzzyMatch across files / commits)
//   - Commit tab: full-height Unstaged & Staged sections, Stage/Unstage, Discard/Delete,
//     Mark as viewed, Amend toggle, Commit & Push footer
//   - Compare tab: base ref picker (local/remote + 3-dot/2-dot), summary (+a -d, viewed/total),
//     dedicated "Search changed lines" bar (±, Aa, ab whole-word, .* regex, Net/Commits),
//     per-row Open File + Eye viewed icons
//   - History tab: commit list with ref chips, --grep search, Load more, expand commit files
//   - Clicking any file opens it in the BIG center viewer tab (mods/wf-diff) instead of a tiny sidebar pane!
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  spaces, panes, focused, exec, watchFolder, theme, shared, setShared,
  openOverlay, run, notify, checking, nextCommand,
} from "herdr";
import {
  filterFuzzy, parseNumstatZ, parsePorcelainSplit, parseNameStatusZ,
  buildFileRows, parseCommitLog, formatCommitAge, layoutGraph, graphWidth,
  searchUnifiedDiff, githubUrlFor, repoSlugFromUrl, prCiSummary, spaceForWorktree,
} from "./lib/wf/index.js";

const LANE_COLORS = [
  "#60a5fa", // blue
  "#c084fc", // purple
  "#4ade80", // green
  "#fb923c", // orange
  "#f472b6", // pink
  "#2dd4bf", // teal
  "#facc15", // yellow
  "#f87171", // red
];
const LANE_W = 14;
const GRAPH_ROW_H = 26;
const MAX_LANES = 6;
const laneCol = idx => LANE_COLORS[idx % LANE_COLORS.length];
const clampLane = (lane, count) => Math.min(Math.max(lane, 0), Math.max(Math.min(count, MAX_LANES) - 1, 0));
const laneX = (lane, count) => clampLane(lane, count) * LANE_W + 7;

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const LS_TAB = "wf-changes.tab";
const LS_VIEW = "wf-changes.view";
const LS_HIDE_UNTRACKED = "wf-changes.hideUntracked";
const LS_VIEWED = "wf-changes.viewed";
const LS_MERGE_BASE = "wf-changes.mergeBase";
const HISTORY_PAGE = 60;

function location() {
  const picked = shared("wf.branch");
  if (picked?.path) return { cwd: picked.path, on: null, branch: picked.branch ?? null };
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, branch: null };
}

const locKey = () => {
  const l = location();
  return JSON.stringify({ cwd: l.cwd, on: l.on });
};

function loadJson(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function saveJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function statusColor(t, s) {
  if (s === "A" || s === "?") return t.ansi2;
  if (s === "D" || s === "U") return t.ansi1;
  if (s === "R" || s === "C") return t.accent;
  return t.blocked;
}
const statusGlyph = s => (s === "A" ? "+" : s);

function parentDirOf(absPath) {
  const idx = absPath.lastIndexOf("/");
  return idx > 0 ? absPath.slice(0, idx) : absPath;
}

export default class WorkflowChanges extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.context = null;
    this.root = null;
    this.on = null;
    this.slug = null;
    this.headBranch = null;
    this.hasHead = true;
    this.ahead = 0;
    this.behind = 0;
    this.pr = null;
    this.prCi = null;
    this.watched = null;
    this.loading = false;
    this.busy = false;
    this.syncBusy = null; // null | "fetch" | "pull" | "push"
    this.error = null;
    this.note = null;

    // Persisted preferences
    const savedTab = loadJson(LS_TAB, "commit");
    this.tab = ["commit", "compare", "history"].includes(savedTab) ? savedTab : "commit";
    this.viewMode = loadJson(LS_VIEW, "tree") === "list" ? "list" : "tree";
    this.hideUntracked = Boolean(loadJson(LS_HIDE_UNTRACKED, false));
    this.mergeBase = loadJson(LS_MERGE_BASE, true) !== false;
    this.viewedByRoot = loadJson(LS_VIEWED, {});
    if (!this.viewedByRoot || typeof this.viewedByRoot !== "object") this.viewedByRoot = {};
    setShared("wf.fileViewed", this.viewedByRoot);

    this.unstagedCollapsed = false;
    this.stagedCollapsed = false;
    this.collapsed = new Set();
    this.hoverKey = null;
    this.selectedFile = null; // { mode, path, sha? }

    // Commit tab state
    this.staged = [];
    this.unstaged = [];
    this.message = "";
    this.amend = false;
    this.typing = false;

    // Compare tab state
    this.refs = { local: [], remote: [] };
    this.baseByRoot = {};
    this.compareBase = "";
    this.compareBaseSha = null;
    this.compareFiles = [];
    this.compareLoading = false;
    this.compareError = null;

    // Dedicated Compare "Search changed lines" state
    this.diffQuery = "";
    this.diffSide = "both"; // "both" | "added" | "removed"
    this.diffCase = false;
    this.diffWholeWord = false;
    this.diffRegex = false;
    this.diffScope = "net"; // "net" | "commits"
    this.diffHits = [];
    this.diffBusy = false;
    this.diffSeq = 0;

    // History tab state
    this.commits = [];
    this.graphRows = [];
    this.graphLanes = 1;
    this.historyAllBranches = false;
    this.historyLimit = HISTORY_PAGE;
    this.historyLoading = false;
    this.historyHasMore = false;
    this.selectedCommit = null;
    this.commitFiles = {}; // sha -> { loading, files, error }

    this.lastActionTs = 0;
    this.pendingActionTs = 0;
    this.openingViewer = false;
    this.pendingContext = null;

    // ALL InputStates created ONLY in init() (never inside render!)
    this.searchQuery = "";
    this.searchInput = InputState.new({ value: "", placeholder: "Filter" });
    this.searchInput.on("change", (_e, cx) => {
      this.searchQuery = this.searchInput.value();
      if (this.tab === "history") this.loadHistory(cx);
      cx.notify();
    });

    this.diffSearchInput = InputState.new({ value: "", placeholder: "Search changed lines" });
    this.diffSearchInput.on("change", (_e, cx) => {
      this.diffQuery = this.diffSearchInput.value();
      this.runDiffSearch(cx);
      cx.notify();
    });

    this.commitInput = InputState.new({ value: "", placeholder: "Commit message" });
    this.commitInput.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.commitInput.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.commitInput.on("submit", (_e, cx) => this.commit(cx));
    this.commitInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.commitInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

    if (checking()) return;
    this.refresh(cx, { quiet: true });
    cx.timer.every(12000, cx => this.refresh(cx, { quiet: true }));
    cx.spawn(async cx => {
      for (;;) {
        const raw = await nextCommand();
        const [name, arg] = String(raw).split(/:(.*)/s);
        if (name === "tab" && ["commit", "compare", "history"].includes(arg)) this.setTab(arg, cx);
        else if (name === "refresh") this.refresh(cx);
        else if (name === "stage" && arg) this.stagePaths([arg], cx);
        else if (name === "unstage" && arg) this.unstagePaths([arg], cx);
        else if (name === "discard" && arg) {
          const hit = this.unstaged.find(f => f.path === arg);
          if (hit) this.discardFiles([hit], cx);
        }
      }
    });
  }

  // ------------------------------------------------------------------ git & viewed helpers

  git(args, root = this.root, on = this.on) {
    return exec("git", [...READ, ...args], { cwd: root, on });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async cx => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx, { quiet: true });
        }
      } catch {
        if (this.watched === root) this.watched = null;
      }
    });
  }

  setTab(next, cx) {
    if (this.tab === next) return;
    this.tab = next;
    saveJson(LS_TAB, next);
    if (next === "compare") this.loadCompare(cx);
    if (next === "history") this.loadHistory(cx);
    cx.notify();
  }

  toggleViewMode(cx) {
    this.viewMode = this.viewMode === "tree" ? "list" : "tree";
    saveJson(LS_VIEW, this.viewMode);
    cx.notify();
  }

  toggleHideUntracked(cx) {
    this.hideUntracked = !this.hideUntracked;
    saveJson(LS_HIDE_UNTRACKED, this.hideUntracked);
    cx.notify();
  }

  viewedMap() {
    const sh = shared("wf.fileViewed");
    if (sh && typeof sh === "object") this.viewedByRoot = sh;
    return this.viewedByRoot;
  }

  isFileViewed(file) {
    if (!this.root || !file?.fp) return false;
    return this.viewedMap()[this.root]?.[file.path] === file.fp;
  }

  setViewedEntries(entries, mark, cx) {
    if (!this.root) return;
    const prev = this.viewedMap();
    const cur = { ...(prev[this.root] ?? {}) };
    for (const e of entries) {
      if (!e?.path || !e?.fp) continue;
      if (mark) cur[e.path] = e.fp;
      else delete cur[e.path];
    }
    const next = { ...prev, [this.root]: cur };
    this.viewedByRoot = next;
    setShared("wf.fileViewed", next);
    saveJson(LS_VIEWED, next);
    cx.notify();
  }

  toggleFileViewed(file, cx) {
    if (!file?.fp) return;
    this.setViewedEntries([{ path: file.path, fp: file.fp }], !this.isFileViewed(file), cx);
  }

  // ------------------------------------------------------------------ open in big center viewer (wf-diff)

  openInBigViewer({ mode, path, fresh = false, fp = "", status = "", sha = null, line = null, fileList = null }, cx) {
    if (!this.root || !path) return;
    this.selectedFile = { mode, path, sha };
    const baseName = path.split("/").pop() || path;
    const tabTitle = mode === "file" ? baseName : `Δ ${baseName}`;
    const focusPayload = {
      root: this.root,
      on: this.on,
      slug: this.slug,
      branch: this.headBranch || location().branch || "HEAD",
      baseRef: this.compareBase || "origin/main",
      baseSha: this.compareBaseSha,
      mode,
      path,
      fresh: Boolean(fresh),
      fp: fp || "",
      status: status || "",
      sha: sha || null,
      line: line ?? null,
      fileList: Array.isArray(fileList) ? fileList.map(f => ({ path: f.path, fresh: Boolean(f.fresh), fp: f.fp ?? "", status: f.status ?? "" })) : null,
      ts: Date.now(),
    };
    setShared("wf.diffFocus", focusPayload);
    setShared("wf.fileViewed", this.viewedMap());

    const allSpaces = spaces() ?? [];
    const trackedTabId = shared("wf.diffTabId");
    // 1. Reuse existing wf-diff preview tab if it still exists in any space
    for (const sp of allSpaces) {
      const hit = (sp.tabs ?? []).find(tb => tb.id === trackedTabId || tb.name.startsWith("Δ "));
      if (hit) {
        setShared("wf.emptyView", null);
        setShared("wf.navTs", Date.now());
        run("layout.select", { stack: "main-stack", child: "active-tab" });
        if (!sp.active) run("space.select", { id: sp.id });
        run("tab.select", { id: hit.id });
        run("tab.rename", { id: hit.id, name: tabTitle });
        cx.notify();
        return;
      }
    }

    if (this.openingViewer) return;
    this.openingViewer = true;
    const worktreeSpace = spaceForWorktree(allSpaces, panes() ?? [], this.root);
    const activeSpace = !shared("wf.emptyView")?.on ? allSpaces.find(s => s.active) : null;
    const targetSpace = worktreeSpace || activeSpace;

    cx.spawn(async cx => {
      try {
        if (targetSpace) {
          const r = await exec("herdr-app", ["do", "tab.new", JSON.stringify({ space: targetSpace.id, name: tabTitle, mod: "wf-diff", focus: true })]);
          const created = r.code === 0 ? JSON.parse(r.stdout || "{}") : null;
          if (created?.tab) setShared("wf.diffTabId", created.tab);
          setShared("wf.emptyView", null);
          setShared("wf.navTs", Date.now());
          run("layout.select", { stack: "main-stack", child: "active-tab" });
          if (!targetSpace.active) run("space.select", { id: targetSpace.id });
        } else {
          // Zero spaces or currently on empty canvas: open wf-diff in its own clean space (auto-cleans on close!)
          const spRes = await exec("herdr-app", ["do", "space.new", JSON.stringify({ name: tabTitle, tab: "__wf_boot__", folder: this.root, focus: false })]);
          const sp = spRes.code === 0 ? JSON.parse(spRes.stdout || "{}") : null;
          if (!sp?.space) throw new Error((spRes.stderr || spRes.stdout || "space.new failed").trim());
          const tbRes = await exec("herdr-app", ["do", "tab.new", JSON.stringify({ space: sp.space, name: tabTitle, mod: "wf-diff", focus: true })]);
          const tb = tbRes.code === 0 ? JSON.parse(tbRes.stdout || "{}") : null;
          if (tb?.tab) setShared("wf.diffTabId", tb.tab);
          if (sp.tab) await exec("herdr-app", ["do", "tab.close", JSON.stringify({ id: sp.tab, confirmed: true })]);
          if (sp.terminal) {
            await exec("hc", ["kill", sp.terminal]).catch(() => {});
            await exec("hc", ["rm", sp.terminal]).catch(() => {});
          }
          setShared("wf.emptyView", null);
          setShared("wf.navTs", Date.now());
          run("layout.select", { stack: "main-stack", child: "active-tab" });
          run("space.select", { id: sp.space });
        }
      } catch (e) {
        notify({ title: "Could not open viewer", body: String(e?.message ?? e), level: "error" });
      } finally {
        this.openingViewer = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  // ------------------------------------------------------------------ data loaders

  refresh(cx, { quiet = false } = {}) {
    const { cwd, on } = location(), context = locKey();
    const changed = context !== this.context;
    if (changed) {
      this.context = context;
      this.root = null;
      this.on = on;
      this.slug = null;
      this.headBranch = null;
      this.ahead = 0;
      this.behind = 0;
      this.pr = null;
      this.prCi = null;
      this.staged = [];
      this.unstaged = [];
      this.refs = { local: [], remote: [] };
      this.compareBase = "";
      this.compareBaseSha = null;
      this.compareFiles = [];
      this.compareError = null;
      this.diffHits = [];
      this.commits = [];
      this.graphRows = [];
      this.graphLanes = 1;
      this.historyLimit = HISTORY_PAGE;
      this.selectedCommit = null;
      this.commitFiles = {};
      this.selectedFile = null;
      this.message = "";
      this.amend = false;
      this.commitInput.set_value("");
      this.error = null;
      this.note = null;
      this.watched = null;
      this.loading = false;
      this.compareLoading = false;
      this.historyLoading = false;
    }
    if ((this.loading && !changed) || this.busy || !cwd) return;
    this.loading = true;
    if (!quiet) cx.notify();

    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (locKey() !== context) return;
        if (top.code !== 0) {
          this.root = null;
          this.staged = [];
          this.unstaged = [];
          this.error = "Not a git repository";
          return;
        }
        const root = top.stdout.trim();
        this.root = root;
        this.on = on;
        this.error = null;

        const [statusRes, headRes, branchRes, remoteRes, cachedNumRes, unstagedNumRes, abRes] = await Promise.all([
          this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, on),
          this.git(["rev-parse", "--verify", "HEAD"], root, on),
          this.git(["rev-parse", "--abbrev-ref", "HEAD"], root, on),
          this.git(["remote", "get-url", "origin"], root, on).catch(() => ({ code: 1, stdout: "" })),
          this.git(["diff", "--cached", "--numstat", "-z", "-M"], root, on),
          this.git(["diff", "--numstat", "-z", "-M"], root, on),
          this.git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], root, on).catch(() => ({ code: 1, stdout: "" })),
        ]);
        if (locKey() !== context) return;
        if (statusRes.code !== 0) throw new Error(statusRes.stderr || "git status failed");

        this.hasHead = headRes.code === 0;
        const br = branchRes.code === 0 ? branchRes.stdout.trim() : "";
        this.headBranch = br && br !== "HEAD" ? br : null;
        this.slug = remoteRes.code === 0 ? repoSlugFromUrl(remoteRes.stdout.trim()) : null;
        if (abRes.code === 0) {
          const [b, a] = abRes.stdout.trim().split(/\s+/).map(Number);
          this.behind = Number.isFinite(b) ? b : 0;
          this.ahead = Number.isFinite(a) ? a : 0;
        } else {
          this.behind = 0;
          this.ahead = 0;
        }

        const stagedStats = cachedNumRes.code === 0 ? parseNumstatZ(cachedNumRes.stdout) : {};
        const unstagedStats = unstagedNumRes.code === 0 ? parseNumstatZ(unstagedNumRes.stdout) : {};
        const split = parsePorcelainSplit(statusRes.stdout, stagedStats, unstagedStats);
        this.staged = split.staged;
        this.unstaged = split.unstaged;
        this.watch(root, cx);

        if (changed && this.slug && this.headBranch) this.loadPr(root, this.slug, this.headBranch, context, cx);
        // Load Compare refs/files and active tab data so switching tabs is instant & never empty.
        await Promise.all([
          this.loadCompareAsync(context, cx),
          this.tab === "history" || !this.commits.length ? this.loadHistoryAsync(context) : Promise.resolve(),
        ]);
      } catch (e) {
        if (locKey() === context) this.error = String(e?.message ?? e);
      } finally {
        if (locKey() === context) this.loading = false;
        cx.notify();
      }
    });
  }

  loadPr(root, slug, branch, context, cx) {
    cx.spawn(async cx => {
      try {
        const r = await exec("gh", [
          "pr", "list", "-R", slug, "--head", branch, "--state", "all", "--limit", "1",
          "--json", "number,title,state,isDraft,url,reviewDecision,mergeable,statusCheckRollup,reviews",
        ], { cwd: root });
        if (locKey() !== context || r.code !== 0) return;
        const arr = JSON.parse(r.stdout || "[]");
        this.pr = Array.isArray(arr) && arr.length ? arr[0] : null;
        this.prCi = this.pr ? prCiSummary(this.pr) : null;
        cx.notify();
      } catch { /* gh optional */ }
    });
  }

  async ensureRefs(root, on) {
    if (this.refs.local.length + this.refs.remote.length > 0) return this.refs;
    const [locRes, remRes] = await Promise.all([
      this.git(["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads"], root, on),
      this.git(["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/remotes"], root, on),
    ]);
    const local = locRes.code === 0 ? locRes.stdout.split("\n").map(s => s.trim()).filter(Boolean) : [];
    const remote = remRes.code === 0
      ? remRes.stdout.split("\n").map(s => s.trim()).filter(s => s && !s.endsWith("/HEAD"))
      : [];
    this.refs = { local, remote };
    return this.refs;
  }

  pickDefaultBase(refs) {
    const saved = this.root ? this.baseByRoot[this.root] : null;
    const all = [...refs.remote, ...refs.local];
    if (saved && all.includes(saved)) return saved;
    for (const cand of ["origin/main", "origin/master", "origin/develop", "main", "master", "develop"]) {
      if (all.includes(cand)) return cand;
    }
    return refs.remote[0] || refs.local[0] || "";
  }

  loadCompare(cx) {
    if (!this.root) { this.refresh(cx); return; }
    if (this.compareLoading) return;
    const context = this.context;
    cx.spawn(async cx => {
      await this.loadCompareAsync(context, cx);
      cx.notify();
    });
  }

  async loadCompareAsync(context, cx) {
    const root = this.root, on = this.on;
    if (!root) return;
    this.compareLoading = true;
    this.compareError = null;
    try {
      const refs = await this.ensureRefs(root, on);
      if (locKey() !== context) return;
      if (!this.compareBase) this.compareBase = this.pickDefaultBase(refs);
      const baseRef = this.compareBase;
      if (!baseRef) { this.compareFiles = []; this.compareBaseSha = null; return; }

      let baseSha = null;
      if (this.mergeBase) {
        const mb = await this.git(["merge-base", baseRef, "HEAD"], root, on);
        if (mb.code === 0 && mb.stdout.trim()) baseSha = mb.stdout.trim();
      }
      if (!baseSha) {
        const rp = await this.git(["rev-parse", "--verify", baseRef], root, on);
        if (rp.code !== 0) throw new Error(`Unknown ref: ${baseRef}`);
        baseSha = rp.stdout.trim();
      }
      if (locKey() !== context) return;
      this.compareBaseSha = baseSha;

      const [nsRes, numRes, untrackedRes] = await Promise.all([
        this.git(["diff", "--name-status", "-z", "-M", baseSha], root, on),
        this.git(["diff", "--numstat", "-z", "-M", baseSha], root, on),
        this.git(["ls-files", "--others", "--exclude-standard", "-z"], root, on),
      ]);
      if (locKey() !== context) return;
      const stats = numRes.code === 0 ? parseNumstatZ(numRes.stdout) : {};
      const files = nsRes.code === 0 ? parseNameStatusZ(nsRes.stdout, stats) : [];
      const seen = new Set(files.map(f => f.path));
      if (untrackedRes.code === 0) {
        for (const p of untrackedRes.stdout.split("\0").filter(Boolean)) {
          if (seen.has(p)) continue;
          seen.add(p);
          files.push({ path: p, status: "?", fresh: true, added: 0, removed: 0, binary: false, fp: `?:${p}` });
        }
      }
      this.compareFiles = files;
      if (this.diffQuery.trim() && cx) this.runDiffSearch(cx);
    } catch (e) {
      if (locKey() === context) {
        this.compareError = String(e?.message ?? e);
        this.compareFiles = [];
      }
    } finally {
      if (locKey() === context) this.compareLoading = false;
    }
  }

  runDiffSearch(cx) {
    const seq = ++this.diffSeq;
    const q = this.diffQuery.trim();
    if (!q || !this.root || !this.compareBaseSha) {
      this.diffHits = [];
      this.diffBusy = false;
      return;
    }
    this.diffBusy = true;
    const root = this.root, on = this.on, baseSha = this.compareBaseSha;
    const side = this.diffSide, caseSensitive = this.diffCase, wholeWord = this.diffWholeWord, regex = this.diffRegex;
    const scope = this.diffScope;
    cx.spawn(async cx => {
      try {
        const args = scope === "commits"
          ? ["log", "-p", "--no-ext-diff", "--no-color", "-U0", "-M", `${baseSha}..HEAD`]
          : ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", "-M", baseSha];
        const res = await this.git(args, root, on);
        if (this.diffSeq !== seq) return;
        this.diffHits = res.code === 0
          ? searchUnifiedDiff(res.stdout, q, { side, caseSensitive, wholeWord, regex, maxHits: 250 })
          : [];
      } catch {
        if (this.diffSeq === seq) this.diffHits = [];
      } finally {
        if (this.diffSeq === seq) {
          this.diffBusy = false;
          cx.notify();
        }
      }
    });
  }

  loadHistory(cx) {
    if (!this.root) { this.refresh(cx); return; }
    const context = this.context;
    cx.spawn(async cx => {
      await this.loadHistoryAsync(context);
      cx.notify();
    });
  }

  async loadHistoryAsync(context) {
    const root = this.root, on = this.on;
    if (!root) return;
    this.historyLoading = true;
    try {
      const q = this.searchQuery.trim();
      const args = [
        "log", "--topo-order", "-n", String(this.historyLimit + 1),
        "--format=%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%cr%x1f%s%x1f%ct%x1e",
      ];
      if (this.historyAllBranches) args.push("--all");
      if (q) args.push("--fixed-strings", "--regexp-ignore-case", `--grep=${q}`);
      const res = await this.git(args, root, on);
      if (locKey() !== context) return;
      const parsed = res.code === 0 ? parseCommitLog(res.stdout) : [];
      this.historyHasMore = parsed.length > this.historyLimit;
      this.commits = parsed.slice(0, this.historyLimit);
      this.graphRows = layoutGraph(this.commits);
      this.graphLanes = Math.max(1, Math.min(MAX_LANES, graphWidth(this.graphRows)));
    } finally {
      if (locKey() === context) this.historyLoading = false;
    }
  }

  toggleCommit(commit, cx) {
    if (this.selectedCommit === commit.sha) { this.selectedCommit = null; cx.notify(); return; }
    this.selectedCommit = commit.sha;
    if (!this.commitFiles[commit.sha] && this.root) {
      const sha = commit.sha, root = this.root, on = this.on, context = this.context;
      this.commitFiles[sha] = { loading: true, files: [], error: null };
      cx.spawn(async cx => {
        try {
          const [nsRes, numRes] = await Promise.all([
            this.git(["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "-M", "--root", sha], root, on),
            this.git(["diff-tree", "--no-commit-id", "--numstat", "-r", "-z", "-M", "--root", sha], root, on),
          ]);
          if (locKey() !== context) return;
          const stats = numRes.code === 0 ? parseNumstatZ(numRes.stdout) : {};
          const files = nsRes.code === 0 ? parseNameStatusZ(nsRes.stdout, stats) : [];
          this.commitFiles[sha] = { loading: false, files, error: null };
        } catch (e) {
          if (locKey() === context) this.commitFiles[sha] = { loading: false, files: [], error: String(e) };
        }
        cx.notify();
      });
    }
    cx.notify();
  }

  // ------------------------------------------------------------------ git mutations & sync

  runGitMutation(label, fn, cx) {
    if (!this.root || this.busy) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true;
    this.note = null;
    try {
      cx.spawn(async cx => {
        cx.notify();
        try { await fn(root, on); }
        catch (e) {
          if (locKey() === context) {
            this.note = `${label} failed: ${e?.message ?? e}`;
            notify({ title: `${label} failed`, body: String(e?.message ?? e), level: "error" });
          }
        } finally {
          this.busy = false;
          this.refresh(cx, { quiet: true });
          cx.notify();
        }
      });
    } catch (e) {
      this.busy = false;
      this.note = `${label} failed: ${e?.message ?? e}`;
    }
  }

  runSync(kind, cx) {
    if (!this.root || this.syncBusy) return;
    const root = this.root, on = this.on;
    this.syncBusy = kind;
    this.note = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const args = kind === "fetch" ? ["fetch", "--prune"]
          : kind === "pull" ? ["pull", "--ff-only"]
          : ["push"];
        const r = await exec("git", args, { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${kind} failed`).trim());
        notify({ title: `git ${kind} complete`, body: this.headBranch || "", level: "success", timeout: 1800 });
      } catch (e) {
        this.note = `git ${kind}: ${e?.message ?? e}`;
        notify({ title: `git ${kind} failed`, body: String(e?.message ?? e), level: "error" });
      } finally {
        this.syncBusy = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  stagePaths(paths, cx) {
    if (!paths?.length) return;
    this.runGitMutation("Stage", async (root, on) => {
      const r = await exec("git", ["add", "--", ...paths], { cwd: root, on });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    }, cx);
  }

  unstagePaths(paths, cx) {
    if (!paths?.length) return;
    this.runGitMutation("Unstage", async (root, on) => {
      const args = this.hasHead ? ["reset", "HEAD", "--", ...paths] : ["rm", "--cached", "--", ...paths];
      const r = await exec("git", args, { cwd: root, on });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    }, cx);
  }

  discardFiles(files, cx) {
    if (!files?.length || !this.root) return;
    this.runGitMutation("Discard", async (root, on) => {
      const tracked = [];
      const untracked = [];
      for (const f of files) {
        const rel = String(f.path ?? "");
        if (!rel || rel.startsWith("/") || rel.includes("..")) continue;
        if (f.fresh || f.status === "?") untracked.push(rel);
        else tracked.push(rel);
      }
      if (tracked.length) {
        const r = await exec("git", ["checkout", "--", ...tracked], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      }
      if (untracked.length) {
        const absPaths = untracked.map(rel => `${root}/${rel}`);
        const r = await exec("rm", ["-rf", "--", ...absPaths], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      }
      notify({ title: "Discarded changes", body: `${tracked.length + untracked.length} file${tracked.length + untracked.length === 1 ? "" : "s"}`, level: "info", timeout: 1800 });
    }, cx);
  }

  commit(cx) {
    const msg = this.message.trim();
    const canAmendEmpty = this.amend && this.hasHead;
    if ((!msg && !canAmendEmpty) || !this.root || this.busy || this.loading || this.context !== locKey()) return;
    const useStagedOnly = this.staged.length > 0 || this.amend;
    const isAmend = this.amend;
    this.runGitMutation("Commit", async (root, on) => {
      if (!useStagedOnly) {
        const a = await exec("git", ["add", "-A"], { cwd: root, on });
        if (a.code !== 0) throw new Error((a.stderr || a.stdout).trim());
      }
      const args = ["commit"];
      if (isAmend) args.push("--amend");
      if (msg) args.push("-m", msg);
      else args.push("--no-edit");
      const c = await exec("git", args, { cwd: root, on });
      if (c.code !== 0) throw new Error((c.stderr || c.stdout).trim());
      this.message = "";
      this.amend = false;
      this.commitInput.set_value("");
      notify({ title: isAmend ? "Amended commit" : "Committed", body: msg ? msg.split("\n")[0] : "Updated HEAD", level: "success", timeout: 2000 });
    }, cx);
  }

  consumeGitAction(cx) {
    const act = shared("wf.gitAction");
    if (!act?.ts || act.ts <= this.lastActionTs) return;
    if (act.root && this.root && act.root !== this.root) return;
    this.lastActionTs = act.ts;
    setShared("wf.gitAction", null);
    if (act.type === "toggle-viewed") {
      this.setViewedEntries(act.files ?? [{ path: act.rel, fp: act.fp }], Boolean(act.mark), cx);
    } else if (act.type === "open-file" && act.rel) {
      this.openInBigViewer({ mode: "file", path: act.rel }, cx);
    } else if (act.type === "stage") {
      this.stagePaths(act.paths ?? [], cx);
    } else if (act.type === "unstage") {
      this.unstagePaths(act.paths ?? [], cx);
    } else if (act.type === "discard") {
      this.discardFiles(act.files ?? [], cx);
    } else if (act.type === "set-base" && act.base) {
      this.compareBase = act.base;
      if (this.root) this.baseByRoot[this.root] = act.base;
      this.loadCompare(cx);
    } else if (act.type === "toggle-merge-base") {
      this.mergeBase = !this.mergeBase;
      saveJson(LS_MERGE_BASE, this.mergeBase);
      this.loadCompare(cx);
    }
  }

  // ------------------------------------------------------------------ context menus

  openItemMenu({ isDir, rel, files = null, file = null, pane, commitSha = null }) {
    if (!this.root) return;
    const abs = `${this.root}/${rel}`;
    const openDir = isDir ? abs : parentDirOf(abs);
    const ref = commitSha || this.headBranch || "main";
    const githubUrl = githubUrlFor({ slug: this.slug, ref, path: rel, isDir, commit: commitSha });
    const viewableList = isDir ? (files ?? []).filter(f => f.fp) : (file?.fp ? [file] : []);
    const viewed = isDir
      ? (viewableList.length > 0 && viewableList.every(f => this.isFileViewed(f)))
      : Boolean(file && this.isFileViewed(file));
    openOverlay({
      mod: "wf-menu",
      kind: "popup",
      props: {
        mode: "git-item",
        root: this.root,
        isDir,
        rel,
        abs,
        openDir,
        pane,
        files: isDir ? (files ?? []) : null,
        fp: file?.fp ?? "",
        fresh: Boolean(file?.fresh),
        status: file?.status ?? "",
        canView: Boolean(file?.fp),
        viewed,
        githubUrl,
      },
    });
  }

  openCommitMenu(commit) {
    openOverlay({
      mod: "wf-menu",
      kind: "popup",
      props: {
        mode: "git-commit",
        root: this.root,
        sha: commit.sha,
        short: commit.short,
        subject: commit.subject,
        githubUrl: githubUrlFor({ slug: this.slug, commit: commit.sha }),
      },
    });
  }

  openRefPicker() {
    openOverlay({
      mod: "wf-menu",
      kind: "popup",
      width: 280,
      props: {
        mode: "git-ref",
        root: this.root,
        local: this.refs.local,
        remote: this.refs.remote,
        base: this.compareBase,
        mergeBase: this.mergeBase,
      },
    });
  }

  // ------------------------------------------------------------------ render helpers

  renderTreeRows(t, files, { pane, commitSha = null }) {
    const rows = buildFileRows(files, {
      viewMode: this.viewMode,
      collapsed: this.collapsed,
      prefix: `${pane}:${commitSha ?? ""}`,
      isViewed: f => this.isFileViewed(f),
    });

    return rows.map(row => {
      if (row.kind === "dir") {
        const hoverId = `gd:${row.key}`;
        const hovered = this.hoverKey === hoverId;
        const allViewed = row.fileCount > 0 && row.viewedCount === row.fileCount;
        return h_flex().id(`gd-${row.key}`).h(25).flex_none().pl(6 + row.depth * 12).pr(6).gap(5).items_center().rounded(5).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_hover((h, cx) => { this.hoverKey = h ? hoverId : this.hoverKey === hoverId ? null : this.hoverKey; cx.notify(); })
          .on_click((_e, cx) => {
            if (this.collapsed.has(row.key)) this.collapsed.delete(row.key);
            else this.collapsed.add(row.key);
            cx.notify();
          })
          .on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            this.openItemMenu({ isDir: true, rel: row.dirPath, files: row.files, pane, commitSha });
          })
          .child(svg(`mods/workspace-chrome/chevron-${row.isCollapsed ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim))
          .child(svg("mods/wf-files/folder.svg").size(13).flex_none().text_color(allViewed ? t.dim : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(11.8).text_color(allViewed ? t.dim : t.foreground).child(row.name))
          .when(row.viewedCount > 0, el => el.child(div().flex_none().text_size(10).text_color(allViewed ? t.accent : t.dim).child(`${row.viewedCount}/${row.fileCount}`)))
          .when(hovered && pane === "unstaged", el => el.child(div().id(`gds-${row.key}`).size(17).rounded(4).flex().items_center().justify_center()
            .text_color(t.ansi2).hover(s => s.bg(t.raised)).tooltip("Stage folder")
            .on_click((_e, cx) => { cx.stop_propagation(); this.stagePaths(row.files.map(f => f.path), cx); })
            .child(svg("mods/workspace-chrome/plus.svg").size(11))))
          .when(hovered && pane === "staged", el => el.child(div().id(`gdu-${row.key}`).size(17).rounded(4).flex().items_center().justify_center()
            .text_color(t.blocked).hover(s => s.bg(t.raised)).tooltip("Unstage folder")
            .on_click((_e, cx) => { cx.stop_propagation(); this.unstagePaths(row.files.map(f => f.path), cx); })
            .child(svg("mods/workspace-chrome/minus.svg").size(11))));
      }

      const f = row.file;
      const hoverId = `gf:${pane}:${commitSha ?? ""}:${f.path}`;
      const hovered = this.hoverKey === hoverId;
      const selected = Boolean(this.selectedFile && this.selectedFile.mode === pane && this.selectedFile.path === f.path && (this.selectedFile.sha ?? null) === (commitSha ?? null));
      const viewed = (pane === "unstaged" || pane === "staged" || pane === "compare") && this.isFileViewed(f);
      const canView = Boolean(f.fp) && (pane === "unstaged" || pane === "staged" || pane === "compare");
      const canOpenWhole = f.status !== "D" && pane !== "commit";
      const col = statusColor(t, f.status);

      return h_flex().id(`gf-${pane}-${commitSha ?? ""}-${f.path}`).h(25).flex_none()
        .pl(8 + row.depth * 12).pr(6).gap(5).items_center().rounded(5).cursor_pointer()
        .when(selected, el => el.bg(t.selected))
        .hover(s => s.bg(selected ? t.selected : t.hover))
        .tooltip(`${f.status} · ${f.path}\nClick to open diff in main viewer · Right-click for actions`)
        .on_hover((h, cx) => { this.hoverKey = h ? hoverId : this.hoverKey === hoverId ? null : this.hoverKey; cx.notify(); })
        .on_click((_e, cx) => this.openInBigViewer({ mode: pane, path: f.path, fresh: Boolean(f.fresh), fp: f.fp, status: f.status, sha: commitSha, fileList: files }, cx))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          this.openItemMenu({ isDir: false, rel: f.path, file: f, pane, commitSha });
        })
        .child(div().w(14).h(15).flex_none().rounded(3).bg(col + "22").flex().items_center().justify_center().text_size(9.8).font_semibold().text_color(col).child(statusGlyph(f.status)))
        .child(h_flex().flex_1().min_w(0).gap(0).items_center()
          .when(Boolean(row.dirLabel), el => el.child(div().truncate().text_size(11).text_color(t.dim).child(row.dirLabel)))
          .child(div().min_w(0).truncate().text_size(11.8)
            .text_color(viewed && !selected ? t.dim : t.foreground)
            .when(viewed && !selected, el => el.opacity(0.58))
            .child(row.label)))
        .when(!hovered && f.added > 0, el => el.child(div().flex_none().whitespace_nowrap().text_size(10).text_color(t.ansi2).child(`+${f.added}`)))
        .when(!hovered && f.removed > 0, el => el.child(div().flex_none().whitespace_nowrap().text_size(10).text_color(t.ansi1).child(`−${f.removed}`)))
        .when(hovered && pane === "unstaged", el => el.child(div().id(`gfs-${f.path}`).size(17).rounded(4).flex().items_center().justify_center()
          .text_color(t.ansi2).hover(s => s.bg(t.raised)).tooltip("Stage file")
          .on_click((_e, cx) => { cx.stop_propagation(); this.stagePaths([f.path], cx); })
          .child(svg("mods/workspace-chrome/plus.svg").size(11))))
        .when(hovered && pane === "staged", el => el.child(div().id(`gfu-${f.path}`).size(17).rounded(4).flex().items_center().justify_center()
          .text_color(t.blocked).hover(s => s.bg(t.raised)).tooltip("Unstage file")
          .on_click((_e, cx) => { cx.stop_propagation(); this.unstagePaths([f.path], cx); })
          .child(svg("mods/workspace-chrome/minus.svg").size(11))))
        .when(canOpenWhole && (hovered || selected), el => el.child(div().id(`gfo-${pane}-${f.path}`).size(17).rounded(4).flex().items_center().justify_center()
          .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.foreground)).tooltip("Open whole file")
          .on_click((_e, cx) => { cx.stop_propagation(); this.openInBigViewer({ mode: "file", path: f.path, fp: f.fp, status: f.status }, cx); })
          .child(svg("mods/workspace-chrome/file-text.svg").size(11))))
        .when(canView && (viewed || hovered || selected), el => el.child(div().id(`gfv-${pane}-${f.path}`).size(17).rounded(4).flex().items_center().justify_center()
          .text_color(viewed ? t.accent : t.dim).hover(s => s.bg(t.raised).text_color(t.foreground))
          .tooltip(viewed ? "Marked as viewed (click to unmark)" : "Mark as viewed")
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFileViewed(f, cx); })
          .child(svg("mods/wf-changes/icons/eye.svg").size(12))));
    });
  }

  renderPrStrip(t) {
    const pr = this.pr;
    if (!pr) return null;
    const ci = this.prCi;
    const stateLabel = pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.isDraft ? "Draft" : "Open";
    const stateCol = pr.state === "MERGED" ? t.ansi5 : pr.state === "CLOSED" ? t.ansi1 : pr.isDraft ? t.dim : t.ansi2;
    const ciLabel = ci?.ci === "passing" ? "CI" : ci?.ci === "failing" ? "CI red" : ci?.ci === "running" ? `CI ${ci.passed}/${ci.total}` : null;
    const ciCol = ci?.ci === "passing" ? t.ansi2 : ci?.ci === "failing" ? t.ansi1 : t.blocked;
    const revLabel = ci?.approved ? "Approved" : ci?.changesRequested ? "Changes requested" : null;
    const revCol = ci?.approved ? t.ansi2 : t.ansi1;

    return v_flex().id("git-pr-card").flex_none().px(10).py(6).gap(3).bg(t.raised + "55").border_b(1).border_color(t.border).cursor_pointer()
      .hover(s => s.bg(t.hover))
      .tooltip(`Open PR #${pr.number} on GitHub`)
      .on_click((_e, cx) => { if (pr.url) cx.open_url(pr.url); })
      .child(h_flex().gap(7).items_center()
        .child(h_flex().gap(3).items_center()
          .child(svg("mods/workspace-chrome/git-branch.svg").size(11).text_color(stateCol))
          .child(div().text_size(10.8).font_medium().text_color(stateCol).child(stateLabel)))
        .when(Boolean(ciLabel), el => el.child(div().text_size(10.5).text_color(ciCol).child(ciLabel)))
        .when(Boolean(revLabel), el => el.child(div().text_size(10.5).text_color(revCol).child(revLabel))))
      .child(div().truncate().text_size(11.2).text_color(t.muted).child(`#${pr.number} ${pr.title || ""}`));
  }

  renderCommitTab(t) {
    const q = this.searchQuery.trim();
    const rawUnstaged = this.hideUntracked ? this.unstaged.filter(f => f.status !== "?") : this.unstaged;
    const unstagedList = filterFuzzy(rawUnstaged, q, f => f.path).map(x => x.item);
    const stagedList = filterFuzzy(this.staged, q, f => f.path).map(x => x.item);
    const unstagedViewed = unstagedList.filter(f => this.isFileViewed(f)).length;
    const stagedViewed = stagedList.filter(f => this.isFileViewed(f)).length;
    const hasAny = this.staged.length + rawUnstaged.length > 0;
    const canCommit = Boolean((this.message.trim() || (this.amend && this.hasHead)) && this.root && (hasAny || this.amend) && !this.busy && !this.loading);
    const commitLabel = this.busy ? "Committing..."
      : this.amend ? "Amend"
      : this.staged.length > 0 ? `Commit (${this.staged.length})`
      : "Commit all";

    const sectionHdr = (id, title, count, viewed, collapsed, onToggle, actionId, actionLabel, actionCol, onAction) =>
      h_flex().id(id).h(26).flex_none().px(8).gap(5).items_center().bg(t.raised + "77").border_b(1).border_color(t.border).cursor_pointer()
        .hover(s => s.bg(t.hover))
        .on_click((_e, cx) => onToggle(cx))
        .child(svg(`mods/workspace-chrome/chevron-${collapsed ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(10.8).font_semibold().text_color(t.muted).child(`${title} (${count})`))
        .when(viewed > 0, el => el.child(div().flex_none().px(5).h(15).rounded(4).bg(t.background).text_size(9.5).text_color(t.accent).flex().items_center().child(`${viewed}/${count}`)))
        .when(count > 0 && Boolean(actionLabel), el => el.child(div().id(actionId).px(6).h(17).rounded(4).flex().items_center().text_size(10).text_color(actionCol).cursor_pointer()
          .hover(s => s.bg(t.selected))
          .on_click((_e, cx) => { cx.stop_propagation(); onAction(cx); })
          .child(actionLabel)));

    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("commit-lists").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(this.error), el => el.child(div().p(10).text_size(11.5).text_color(t.ansi1).child(this.error)))
        .when(!this.error && !hasAny, el => el.child(div().p(12).text_size(11.8).text_color(t.dim).child(this.loading ? "Loading changes..." : "Working tree clean")))
        .when(!this.error && hasAny, el => el
          .child(sectionHdr("sec-unstaged", "Unstaged", unstagedList.length, unstagedViewed, this.unstagedCollapsed,
            cx => { this.unstagedCollapsed = !this.unstagedCollapsed; cx.notify(); },
            "stage-all", "Stage all", t.ansi2, cx => this.stagePaths(unstagedList.map(f => f.path), cx)))
          .when(!this.unstagedCollapsed && unstagedList.length > 0, e => e.child(v_flex().p(4).gap(1).children(this.renderTreeRows(t, unstagedList, { pane: "unstaged" }))))
          .child(sectionHdr("sec-staged", "Staged", stagedList.length, stagedViewed, this.stagedCollapsed,
            cx => { this.stagedCollapsed = !this.stagedCollapsed; cx.notify(); },
            "unstage-all", "Unstage all", t.blocked, cx => this.unstagePaths(stagedList.map(f => f.path), cx)))
          .when(!this.stagedCollapsed && stagedList.length > 0, e => e.child(v_flex().p(4).gap(1).children(this.renderTreeRows(t, stagedList, { pane: "staged" }))))))
      .when(Boolean(this.note), el => el.child(div().px(10).py(4).text_size(11).text_color(t.ansi1).whitespace_normal().child(this.note)))
      .child(v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
        .child(div().id("commit-message").w_full().h(30).px(8).flex().items_center().rounded(7).border_1().border_color(this.typing ? t.accent : t.border).bg(t.raised + "44").cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.commitInput).h_full().text_size(11.8).text_color(t.foreground)))
        .child(h_flex().gap(6).items_center()
          .child(div().id("commit-amend").px(7).h(26).rounded(6).flex().items_center().text_size(10.8).cursor_pointer()
            .bg(this.amend ? t.accent + "26" : t.raised).border(1).border_color(this.amend ? t.accent : t.border)
            .text_color(this.amend ? t.accent : t.muted).tooltip("Amend previous commit")
            .on_click((_e, cx) => { this.amend = !this.amend; cx.notify(); }).child("Amend"))
          .child(div().flex_1())
          .child(div().id("commit-push").px(9).h(26).rounded(6).flex().items_center().text_size(11).cursor_pointer()
            .bg(t.raised).border(1).border_color(t.border).text_color(this.ahead > 0 ? t.foreground : t.muted)
            .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("git push")
            .on_click((_e, cx) => this.runSync("push", cx))
            .child(this.syncBusy === "push" ? "Pushing..." : (this.ahead > 0 ? `Push ↑${this.ahead}` : "Push")))
          .child(div().id("commit").px(12).h(26).rounded(6).flex().items_center().text_size(11.5)
            .bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim)
            .when(canCommit, e => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(commitLabel))));
  }

  renderCompareTab(t) {
    const q = this.searchQuery.trim();
    const raw = this.hideUntracked ? this.compareFiles.filter(f => f.status !== "?") : this.compareFiles;
    const files = filterFuzzy(raw, q, f => f.path).map(x => x.item);
    const added = files.reduce((n, f) => n + (f.added || 0), 0);
    const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
    const viewed = files.filter(f => this.isFileViewed(f)).length;
    const branchLabel = this.headBranch || location().branch || "HEAD";
    const sideLabel = this.diffSide === "added" ? "+" : this.diffSide === "removed" ? "−" : "±";
    const hasDiffQ = this.diffQuery.trim().length > 0;
    const filteredHits = q ? this.diffHits.filter(h => filterFuzzy([h], q, x => x.path).length > 0) : this.diffHits;

    const pillToggle = (id, on, lbl, tip, onClick) =>
      div().id(id).px(4).h(18).rounded(4).flex().items_center().justify_center().text_size(10).cursor_pointer().flex_none()
        .bg(on ? t.accent + "28" : "#00000000").text_color(on ? t.accent : t.dim)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
        .on_click((_e, cx) => onClick(cx)).child(lbl);

    return v_flex().flex_1().min_h(0)
      // Compare base -> branch bar
      .child(h_flex().flex_none().px(8).py(5).gap(5).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/git-compare.svg").size(12).flex_none().text_color(t.dim))
        .child(h_flex().id("cmp-base-btn").h(22).px(7).gap(4).min_w(0).items_center().rounded(5).border(1).border_color(t.border).bg(t.raised).cursor_pointer()
          .hover(s => s.border_color(t.accent)).tooltip("Choose base branch/ref to compare against")
          .on_click(() => this.openRefPicker())
          .child(div().max_w(135).truncate().text_size(11).text_color(t.foreground).child(this.compareBase || "Pick branch"))
          .child(svg("mods/workspace-chrome/chevron-down.svg").size(10).flex_none().text_color(t.dim)))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("→"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(branchLabel).child(branchLabel))
        .when(!this.mergeBase, el => el.child(div().flex_none().px(4).h(16).rounded(4).bg(t.raised).text_size(9.5).text_color(t.dim).flex().items_center().child("2-dot"))))
      // Summary strip (44 files +4132 -14 | 👁 viewed/total)
      .child(h_flex().h(25).flex_none().px(9).gap(7).items_center().bg(t.raised + "66").border_b(1).border_color(t.border)
        .child(div().flex_none().whitespace_nowrap().text_size(11).text_color(t.muted).child(`${files.length} ${files.length === 1 ? "file" : "files"}`))
        .child(div().flex_none().whitespace_nowrap().text_size(10.5).text_color(t.ansi2).child(`+${added}`))
        .child(div().flex_none().whitespace_nowrap().text_size(10.5).text_color(t.ansi1).child(`−${removed}`))
        .child(div().flex_1())
        .when(viewed > 0, el => el.child(h_flex().flex_none().px(5).h(16).gap(3).rounded(4).bg(t.accent + "22").items_center()
          .child(svg("mods/wf-changes/icons/eye.svg").size(10).text_color(t.accent))
          .child(div().text_size(9.8).text_color(t.accent).child(`${viewed}/${files.length}`)))))
      // Dedicated "Search changed lines" bar (Termic CompareSearch)
      .child(h_flex().flex_none().px(8).py(5).gap(3).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/search.svg").size(11).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).child(Input.new(this.diffSearchInput).h(22).px(5).items_center().rounded(5).border(1).border_color(hasDiffQ ? t.accent : t.border).bg(t.raised + "44").text_color(t.foreground).text_size(11)))
        .when(hasDiffQ, el => el.child(div().id("ds-clear").size(18).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.diffQuery = ""; this.diffSearchInput.set_value(""); this.diffHits = []; cx.notify(); })
          .child(svg("mods/workspace-chrome/x.svg").size(10))))
        .child(pillToggle("ds-side", this.diffSide !== "both", sideLabel, "Lines: ± both / + added / − removed", cx => {
          this.diffSide = this.diffSide === "both" ? "added" : this.diffSide === "added" ? "removed" : "both";
          this.runDiffSearch(cx); cx.notify();
        }))
        .child(pillToggle("ds-case", this.diffCase, "Aa", "Match case", cx => { this.diffCase = !this.diffCase; this.runDiffSearch(cx); cx.notify(); }))
        .child(pillToggle("ds-word", this.diffWholeWord, "ab", "Match whole word", cx => { this.diffWholeWord = !this.diffWholeWord; this.runDiffSearch(cx); cx.notify(); }))
        .child(pillToggle("ds-regex", this.diffRegex, ".*", "Use regular expression", cx => { this.diffRegex = !this.diffRegex; this.runDiffSearch(cx); cx.notify(); }))
        .child(pillToggle("ds-scope", this.diffScope === "commits", this.diffScope === "commits" ? "All" : "Net", "Net diff vs every commit in range", cx => {
          this.diffScope = this.diffScope === "net" ? "commits" : "net";
          this.runDiffSearch(cx); cx.notify();
        })))
      // Full-height file tree OR diff-search results
      .child(v_flex().id("cmp-body").flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1)
        .when(Boolean(this.compareError), el => el.child(div().p(8).text_size(11.5).text_color(t.ansi1).child(this.compareError)))
        .when(!this.compareError && this.compareLoading && !this.compareFiles.length, el => el.child(div().p(8).text_size(11.5).text_color(t.dim).child("Comparing...")))
        .when(!this.compareError && hasDiffQ, el => el
          .when(this.diffBusy, e => e.child(div().p(8).text_size(11.5).text_color(t.dim).child("Searching changed lines...")))
          .when(!this.diffBusy && !filteredHits.length, e => e.child(div().p(8).text_size(11.5).text_color(t.dim).child("No matching changed lines")))
          .when(!this.diffBusy && filteredHits.length > 0, e => e.child(div().px(6).pb(3).text_size(10).text_color(t.dim).child(`${filteredHits.length} matches`)))
          .children(filteredHits.map((h, i) => h_flex().id(`dh-${i}`).h(23).flex_none().px(6).gap(6).items_center().rounded(4).cursor_pointer()
            .hover(s => s.bg(t.hover)).tooltip(`${h.path}:${h.line}\n${h.text}`)
            .on_click((_e, cx) => this.openInBigViewer({
              mode: h.commit ? "commit" : "compare",
              path: h.path,
              sha: h.commit || null,
              line: h.line,
              fileList: files,
            }, cx))
            .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(h.sign === "+" ? t.ansi2 : t.ansi1).child(h.sign))
            .child(div().w(28).flex_none().text_right().text_size(10).text_color(t.dim).child(String(h.line)))
            .child(div().max_w(105).truncate().text_size(10.5).text_color(t.accent).child(h.path.split("/").pop() || h.path))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(h.text)))))
        .when(!this.compareError && !hasDiffQ, el => el
          .when(!this.compareLoading && !files.length, e => e.child(div().p(8).text_size(11.5).text_color(t.dim).child(q ? "No matching files" : `No differences vs ${this.compareBase || "base"}`)))
          .children(this.renderTreeRows(t, files, { pane: "compare" }))));
  }

  renderGraphGutter(grow, laneCount, t, isSelected) {
    const gutterW = Math.max(1, laneCount) * LANE_W + 4;
    const xDot = laneX(grow.lane, laneCount);
    const dotCol = laneCol(grow.color);
    const pieces = [];

    for (let i = 0; i < grow.links.length; i++) {
      const lk = grow.links[i];
      const col = laneCol(lk.color);
      const x1 = laneX(lk.fromLane, laneCount);
      const x2 = laneX(lk.toLane, laneCount);

      if (lk.kind === "through") {
        pieces.push(div().absolute().top(0).left(x1 - 1).w(2).h(GRAPH_ROW_H).bg(col));
      } else if (lk.kind === "in") {
        if (x1 === x2) {
          pieces.push(div().absolute().top(0).left(x1 - 1).w(2).h(13).bg(col));
        } else if (x1 > x2) {
          // Curves smoothly down from right lane into left dot
          const w = x1 - x2 + 1;
          pieces.push(div().absolute().top(0).left(x2).w(w).h(14).overflow_hidden()
            .child(div().ml(-7).mt(-8).w(w + 7).h(22).rounded(7).border(2).border_color(col)));
        } else {
          // Curves smoothly down from left lane into right dot
          const w = x2 - x1 + 1;
          pieces.push(div().absolute().top(0).left(x1 - 1).w(w).h(14).overflow_hidden()
            .child(div().mt(-8).w(w + 7).h(22).rounded(7).border(2).border_color(col)));
        }
      } else if (lk.kind === "out") {
        if (x1 === x2) {
          pieces.push(div().absolute().top(13).left(x1 - 1).w(2).h(13).bg(col));
        } else if (x2 > x1) {
          // Forks smoothly from dot rightwards and down into target lane
          const w = x2 - x1 + 1;
          pieces.push(div().absolute().top(12).left(x1).w(w).h(14).overflow_hidden()
            .child(div().ml(-7).w(w + 7).h(22).rounded(7).border(2).border_color(col)));
        } else {
          // Merges smoothly from dot leftwards and down into target lane
          const w = x1 - x2 + 1;
          pieces.push(div().absolute().top(12).left(x2 - 1).w(w).h(14).overflow_hidden()
            .child(div().w(w + 7).h(22).rounded(7).border(2).border_color(col)));
        }
      }
    }

    // Hollow commit ring drawn on top of all lane connectors (exact Termic style)
    pieces.push(div().absolute().top(9).left(xDot - 4).size(8).rounded_full()
      .bg(isSelected ? t.selected : t.background).border(2).border_color(dotCol));

    return div().relative().w(gutterW).h(GRAPH_ROW_H).flex_none().children(pieces);
  }

  renderHistoryTab(t) {
    const chipCol = kind => kind === "head" ? "#a855f7" : kind === "branch" ? "#60a5fa" : kind === "tag" ? t.blocked : "#8b5cf6";
    const laneCount = Math.max(1, this.graphLanes);
    const gutterW = laneCount * LANE_W + 4;

    return v_flex().flex_1().min_h(0)
      // Scope strip: HEAD vs All branches
      .child(h_flex().h(25).flex_none().px(8).gap(6).items_center().bg(t.raised + "55").border_b(1).border_color(t.border)
        .child(div().text_size(10.5).text_color(t.dim).child(`${this.commits.length} commits`))
        .child(div().flex_1())
        .child(div().id("hist-scope-head").px(6).h(17).rounded(4).flex().items_center().text_size(10).cursor_pointer()
          .bg(!this.historyAllBranches ? t.selected : "#00000000").text_color(!this.historyAllBranches ? t.foreground : t.dim)
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { if (this.historyAllBranches) { this.historyAllBranches = false; this.loadHistory(cx); cx.notify(); } })
          .child("Branch"))
        .child(div().id("hist-scope-all").px(6).h(17).rounded(4).flex().items_center().text_size(10).cursor_pointer()
          .bg(this.historyAllBranches ? t.selected : "#00000000").text_color(this.historyAllBranches ? t.foreground : t.dim)
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { if (!this.historyAllBranches) { this.historyAllBranches = true; this.loadHistory(cx); cx.notify(); } })
          .child("All branches")))
      // Continuous zero-gap commit graph list
      .child(v_flex().id("hist-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).py(2).gap(0)
        .when(Boolean(this.error), el => el.child(div().p(8).text_size(11.5).text_color(t.ansi1).child(this.error)))
        .when(!this.error && this.historyLoading && !this.commits.length, el => el.child(div().p(8).text_size(11.5).text_color(t.dim).child("Loading history...")))
        .when(!this.error && !this.historyLoading && !this.commits.length, el => el.child(div().p(8).text_size(11.5).text_color(t.dim).child(this.searchQuery.trim() ? "No matching commits" : "No commits yet")))
        .children(this.commits.map((c, idx) => {
          const grow = this.graphRows[idx] ?? { lane: 0, color: 0, links: [], afterLanes: [] };
          const open = this.selectedCommit === c.sha;
          const cf = this.commitFiles[c.sha];
          const ageStr = c.timestamp ? formatCommitAge(c.timestamp) : c.age.replace(" ago", "");
          return v_flex().id(`hc-${c.sha}`).flex_none()
            .child(h_flex().h(GRAPH_ROW_H).pr(6).gap(6).items_center().rounded(4).cursor_pointer()
              .when(open, el => el.bg(t.selected)).hover(s => s.bg(open ? t.selected : t.hover))
              .tooltip(`${c.short} · ${c.author} (${c.age})\n${c.subject}`)
              .on_click((_e, cx) => this.toggleCommit(c, cx))
              .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openCommitMenu(c); })
              .child(this.renderGraphGutter(grow, laneCount, t, open))
              .children(c.refs.slice(0, 2).map((rf, ri) => {
                const col = chipCol(rf.kind);
                return div().id(`hcr-${c.sha}-${ri}`).flex_none().max_w(120).truncate().px(5).h(17).rounded(4)
                  .bg(col + "28").text_size(10).font_medium().text_color(col).flex().items_center().child(rf.label);
              }))
              .child(div().flex_1().min_w(0).truncate().text_size(11.8).text_color(open ? t.foreground : t.muted).child(c.subject))
              .child(div().flex_none().whitespace_nowrap().text_size(10.5).text_color(t.dim).child(ageStr)))
            .when(open, el => el.child(h_flex().items_stretch()
              // Continuous vertical pass-through lines down the left gutter while expanded
              .child(div().relative().w(gutterW).flex_none()
                .children((grow.afterLanes ?? []).map((al, ai) =>
                  div().id(`hct-${c.sha}-${ai}`).absolute().top(0).bottom(0).left(laneX(al.lane, laneCount) - 1).w(2).bg(laneCol(al.color)))))
              .child(v_flex().flex_1().min_w(0).pl(4).pr(4).py(4).gap(2)
                .child(h_flex().px(4).gap(6).items_center()
                  .child(div().px(5).h(16).rounded(3).bg(t.raised).text_size(10).text_color(t.accent).flex().items_center().child(c.short))
                  .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(`${c.author} · ${c.age}`)))
                .when(cf?.loading, e => e.child(div().px(4).py(2).text_size(11).text_color(t.dim).child("Loading files...")))
                .when(Boolean(cf?.error), e => e.child(div().px(4).py(2).text_size(11).text_color(t.ansi1).child(cf.error)))
                .when(Boolean(cf?.files?.length), e => e.children(this.renderTreeRows(t, cf.files, { pane: "commit", commitSha: c.sha }))))));
        }))
        .when(this.historyHasMore, el => el.child(div().id("hist-more").mx(6).my(6).h(24).rounded(5).bg(t.raised).flex().items_center().justify_center().text_size(11).text_color(t.accent).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.historyLimit += HISTORY_PAGE; this.loadHistory(cx); })
          .child("Load more commits"))));
  }

  render(cx) {
    const curLoc = locKey();
    if (curLoc !== this.context && curLoc !== this.pendingContext) {
      this.pendingContext = curLoc;
      cx.timer.after(1, cx => {
        this.pendingContext = null;
        this.refresh(cx, { quiet: true });
      });
    }
    const pendingAct = shared("wf.gitAction");
    if (pendingAct?.ts && pendingAct.ts > this.lastActionTs && pendingAct.ts !== this.pendingActionTs && (!pendingAct.root || !this.root || pendingAct.root === this.root)) {
      this.pendingActionTs = pendingAct.ts;
      cx.timer.after(1, cx => {
        this.pendingActionTs = 0;
        this.consumeGitAction(cx);
      });
    }
    const t = theme();
    const loc = location();
    const branchLabel = this.headBranch || loc.branch || loc.cwd?.split(/[\\/]/).pop() || "";
    const commitCount = this.unstaged.length + this.staged.length;
    const prStrip = this.renderPrStrip(t);

    const tabBtn = (id, label, count = null) => {
      const active = this.tab === id;
      return h_flex().id(`gtab-${id}`).h(24).px(8).gap(4).items_center().rounded(5).cursor_pointer()
        .bg(active ? t.selected : "#00000000").text_color(active ? t.foreground : t.muted)
        .hover(s => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.setTab(id, cx))
        .child(div().text_size(11.5).when(active, e => e.font_semibold()).child(label))
        .when(count !== null && count > 0, el => el.child(div().px(4).h(14).rounded(3).bg(t.raised).text_size(9.5).text_color(t.dim).flex().items_center().child(String(count))));
    };

    const syncBtn = (id, label, tip, kind) =>
      div().id(id).px(5).h(20).rounded(4).flex().items_center().text_size(10).cursor_pointer().flex_none()
        .text_color(this.syncBusy === kind ? t.accent : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tip).on_click((_e, cx) => this.runSync(kind, cx)).child(this.syncBusy === kind ? "..." : label);

    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12.5).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      // PR status strip (when branch has a PR)
      .when(Boolean(prStrip), el => el.child(prStrip))
      // Branch + Filter + Sync bar (Termic top row)
      .child(h_flex().h(34).flex_none().px(8).gap(5).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).tooltip(branchLabel).child(branchLabel))
        .when(this.behind > 0, el => el.child(syncBtn("git-pull", `↓${this.behind}`, "git pull --ff-only", "pull")))
        .when(this.ahead > 0, el => el.child(syncBtn("git-push-top", `↑${this.ahead}`, "git push", "push")))
        .child(syncBtn("git-fetch", "Fetch", "git fetch --prune", "fetch"))
        .child(div().id("git-refresh").size(20).rounded(4).flex().items_center().justify_center().text_size(11.5).text_color(t.dim).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh git state")
          .on_click((_e, cx) => this.refresh(cx)).child("↻")))
      // Tabs + Fuzzy Filter + View options row
      .child(h_flex().h(34).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(tabBtn("commit", "Commit", commitCount))
        .child(tabBtn("compare", "Compare", this.compareFiles.length || null))
        .child(tabBtn("history", "History"))
        .child(div().flex_1())
        .child(div().id("git-hide-u").px(5).h(20).rounded(4).flex().items_center().text_size(10).cursor_pointer().flex_none()
          .bg(this.hideUntracked ? t.accent + "22" : "#00000000").text_color(this.hideUntracked ? t.accent : t.dim)
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Hide untracked (?) files")
          .on_click((_e, cx) => this.toggleHideUntracked(cx)).child("−?"))
        .child(div().id("git-view-toggle").px(5).h(20).rounded(4).flex().items_center().text_size(10).text_color(t.muted).cursor_pointer().flex_none()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Toggle tree / flat list view")
          .on_click((_e, cx) => this.toggleViewMode(cx)).child(this.viewMode === "tree" ? "Tree" : "List")))
      // Shared Fuzzy Filter bar
      .child(h_flex().flex_none().px(8).py(5).gap(5).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/search.svg").size(11.5).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).child(Input.new(this.searchInput).h(23).px(6).items_center().rounded(5).border(1).border_color(t.border).bg(t.raised + "44").text_color(t.foreground).text_size(11.2)))
        .when(Boolean(this.searchQuery), el => el.child(div().id("git-search-clear").size(19).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            this.searchQuery = "";
            this.searchInput.set_value("");
            if (this.tab === "history") this.loadHistory(cx);
            cx.notify();
          }).child(svg("mods/workspace-chrome/x.svg").size(10.5)))))
      // Full-height active tab content
      .child(this.tab === "commit" ? this.renderCommitTab(t) : this.tab === "compare" ? this.renderCompareTab(t) : this.renderHistoryTab(t));
  }
}
