// Unified Termic-style 3-level collapsible sidebar for herdr-app:
//   Level 1: Repositories (collapsible, curated list with add/hide/show, no 13-repo dump)
//   Level 2: Branches / worktrees (collapsible, PR + coder phase pill + status + hover + menu)
//   Level 3: Sessions & terminals attached to that branch (live AI CLIs with real icons + past Claude sessions)
// Replaces both wf-repos and wf-branches with one resizable, hideable sidebar.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  theme, terminals, spaces, panes, focused, layout,
  shared, setShared, watchFolder, run, nextCommand,
  openOverlay, pickFolder, notify, checking,
} from "herdr";
import {
  listRepos, gatherRepo, prList, prCiSummary, repoCiSnapshot, ciTrends, mergeCiSettings, formatDuration,
  applyAgents, groupRows, applyBranchOrder, reorderBranchList, counts, spaceForWorktree, readLabels, terminalsAt, statusWord, isWithin, chipLabel, sessionNameFor,
} from "./lib/wf/index.js";
import { exec, fs, wf, setting, loadLocalConfig, track, flushTelemetry } from "./lib/wf/herdr-adapter.js";
import { Launcher } from "./launcher.js";

const SCAN_MS = 90000;
const ACTIVE_PR_MS = 6000; // 6s adaptive ETag poll while any CI workflow or PR check is running
const PR_MS = 20000;       // 20s idle poll (304 Not Modified = 0 rate-limit cost)
const MIN_GAP_MS = 3000;
const MAX_WATCHES = 20;
const PAST_SHOWN = 4;
const OTHERS_SHOWN = 120;

const STORE_OPEN_REPOS = "wf-sidebar.open-repos";
const STORE_OPEN_BRANCHES = "wf-sidebar.open-branches";
const STORE_OPEN_EVERYTHING = "wf-sidebar.open-everything";
const BLOCKER_TEXT = { conflict: "conflict", ci: "CI red", changes: "changes" };

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const isNarrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function loadSet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch { return null; }
}

function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

const GENERIC_TITLES = new Set(["", "claude", "claude code", "zsh", "bash", "fish", "sh", "terminal"]);
const HC_ADDR = /^(?:[a-z0-9._-]+\/)?t[0-9a-z]{1,6}$/i;

// Strips leading Claude spinner/status glyphs (e.g. "✳ ", "⠐ ") from a live terminal title
// and ignores generic placeholders or raw hc terminal addresses (e.g. "t44", "t3z") that herdr
// emits during startup and teardown.
function cleanLiveTitle(raw, address = null) {
  if (!raw) return null;
  const s = String(raw).replace(/^[✳✶✷✸✹✺✻✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋⠂⠐⠒⠲⠴⠦⠇⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●○•·\s]+/, "").trim();
  if (!s || GENERIC_TITLES.has(s.toLowerCase())) return null;
  if (address && s === address) return null;
  if (HC_ADDR.test(s)) return null;
  return s;
}

function agentDot(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().size(13).flex_none().rounded(4).bg(t.blocked + "26").text_size(9.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("?");
  if (status === "done") return div().size(6).mx(2).flex_none().rounded(3).bg(t.done);
  if (status === "idle") return div().size(6).mx(2).flex_none().rounded(3).border(1).border_color(t.idle);
  return div().w(10).flex_none();
}

function programGlyph(program, t, dim = false) {
  const icon = program?.icon;
  if (!icon) return svg("icons/shell.svg").size(12).flex_none().text_color(dim ? t.dim : t.muted);
  if (program.tint) return svg(icon).size(12).flex_none().text_color(dim ? t.dim : t.foreground);
  return image(icon).size(12).flex_none().when(dim, el => el.opacity(0.45));
}

function phaseColor(t, p) {
  if (p.key === "merged" || p.key === "closed") return t.dim;
  if (p.who === "user") return t.blocked;
  if (p.who === "session") return t.working;
  return t.muted;
}

async function isGitRepo(dir) {
  for (const marker of [".bare", ".git"]) {
    try { await fs.readdir(`${dir}/${marker}`); return true; } catch {}
    try { await fs.readFile(`${dir}/${marker}`, "utf8"); return true; } catch {}
  }
  return false;
}

export default class WorkflowSidebar extends View {
  init(_props, cx) {
    this.models = {};          // repoDir -> gatherRepo model
    this.prs = {};             // repoDir -> { at, list }
    this.ci = {};              // repoDir -> { at, trends, branch }
    this.lastCiSettingsTs = 0;
    this.lastCiBumpTs = 0;
    this.lastPrRefreshAt = 0;
    this.loading = new Set();  // repoDirs currently refreshing
    this.lastRefresh = {};     // repoDir -> ms
    this.watches = [];         // active FolderWatch handles to cancel on re-watch/close
    this.discovered = [];      // all repos discovered under wf.workspaces (for Manage drawer)
    this.manage = false;
    this.statusFilter = null;  // null | "needs" | "running"
    this.hover = null;
    this.drag = null;          // { repoDir, path, branch, startY, active, overPath, position, orderedPaths }
    this.suppressClickUntil = 0;
    this.starting = new Set();
    this.branchSessions = {};  // worktreePath -> { list, loading, error, more }
    this.repoSessions = {};    // repoDir -> { list, loading, total, more }
    this.answer = null;        // { id, text, loading }
    this.openOthers = new Set();
    this.openRepoSess = new Set();
    this.openArchived = new Set();
    this.openRepos = loadSet(STORE_OPEN_REPOS) ?? new Set();
    this.openBranches = loadSet(STORE_OPEN_BRANCHES) ?? new Set();
    this.openEverything = (() => {
      try { const v = localStorage.getItem(STORE_OPEN_EVERYTHING); return v === null ? true : JSON.parse(v); }
      catch { return true; }
    })();
    this.seededOpen = this.openRepos.size > 0;
    this.syncedPath = null;
    this.lastFocusKey = null;
    this.pendingSelect = null; // { repoDir, branch }
    this.renaming = null;      // { path, branch, ts }
    this.renameInput = InputState.new({ value: "" });
    this.renameInput.on("submit", (_e, cx) => this.commitRename(cx));
    this.renamingSession = null; // { key, terminal, sessionId, file, worktree, tabId, currentName, ts }
    this.sessionRenameInput = InputState.new({ value: "" });
    this.sessionRenameInput.on("submit", (_e, cx) => this.commitSessionRename(cx));
    this.lastSyncedTabTitle = {}; // terminalAddress -> last title pushed to tab.rename
    this.pendingSessionRename = {}; // terminalAddress -> { name, until }
    this.lastKnownTitle = {};     // terminalAddress -> last non-generic display name (prevents t3z flicker on stop)
    this.pendingResumeTitles = {}; // sessionId -> { name, until } (prevents t3z flicker on start/resume)
    this.lastSessionsBump = 0;

    this.filterText = "";
    this.filterInput = InputState.new({ value: "", placeholder: "Filter branches..." });
    this.filterInput.on("change", (_e, cx) => { this.filterText = this.filterInput.value(); cx.notify(); });

    this.launcher = new Launcher({
      repo: () => this.targetRepo(),
      onStarted: (repoDir, branch, cx) => {
        if (repoDir) this.openRepos.add(repoDir);
        if (branch) this.pendingSelect = { repoDir, branch };
        this.saveOpen();
        if (repoDir) this.refreshRepo(repoDir, cx, { prs: true });
      },
    });

    this.handle = cx.focus_handle();
    if (checking()) return;

    track("mod", { mod: "wf-sidebar", action: "loaded" });
    this.bootstrap(cx);
    const gdir = this.globalDir();
    if (gdir) this.loadBranchSessions(gdir, cx);
    cx.timer.every(SCAN_MS, cx => this.scanAll(cx));
    cx.timer.every(ACTIVE_PR_MS, cx => {
      const hasActive = this.hasActiveCi();
      if (!hasActive && Date.now() - this.lastPrRefreshAt < PR_MS) return;
      this.lastPrRefreshAt = Date.now();
      this.refreshOpenPrs(cx);
    });
    cx.timer.every(10000, cx => this.refreshLiveSessions(cx));
    cx.timer.every(15000, () => { flushTelemetry(); });
    cx.spawn(async cx => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
  }

  async close() {
    this.cancelWatches();
    flushTelemetry();
  }

  cancelWatches() {
    for (const w of this.watches) {
      try { w.cancel?.(); } catch { /* ignore */ }
    }
    this.watches = [];
    this.watchGen = (this.watchGen ?? 0) + 1;
  }

  globalDir() {
    const custom = shared("wf.globalDir");
    if (typeof custom === "string" && custom.trim()) return custom.trim().replace(/\/+$/, "");
    const first = setting("wf.workspaces")?.[0];
    return typeof first === "string" && first.trim() ? first.trim().replace(/\/+$/, "") : null;
  }

  toggleEverything(cx) {
    this.openEverything = !this.openEverything;
    try { localStorage.setItem(STORE_OPEN_EVERYTHING, JSON.stringify(this.openEverything)); } catch {}
    const gdir = this.globalDir();
    if (this.openEverything && gdir) this.loadBranchSessions(gdir, cx);
    cx.notify();
  }

  saveOpen() {
    saveSet(STORE_OPEN_REPOS, this.openRepos);
    saveSet(STORE_OPEN_BRANCHES, this.openBranches);
  }

  // Configured repos in shared("wf.repos"): [{ name, dir, hidden?: boolean }]
  configuredRepos() {
    const list = shared("wf.repos");
    return Array.isArray(list) ? list : null;
  }

  visibleRepos() {
    return (this.configuredRepos() ?? []).filter(r => !r.hidden);
  }

  targetRepo() {
    const vis = this.visibleRepos();
    const active = shared("wf.repo");
    if (active?.dir && vis.some(r => r.dir === active.dir)) return active;
    const expanded = vis.find(r => this.openRepos.has(r.dir));
    return expanded ?? vis[0] ?? active ?? null;
  }

  // Discover workspace repos for the Manage drawer, and seed wf.repos on first run with
  // repos that have live terminals (or the first few discovered repos).
  bootstrap(cx) {
    cx.spawn(async cx => {
      await loadLocalConfig();
      const found = [];
      const seen = new Set();
      for (const root of setting("wf.workspaces")) {
        for (const r of await listRepos(fs, root)) {
          if (seen.has(r.dir)) continue;
          seen.add(r.dir);
          found.push({ name: r.name, dir: r.dir, workspace: root.split("/").pop() });
        }
      }
      this.discovered = found;

      let repos = this.configuredRepos();
      if (!repos || !repos.length) {
        const live = terminals() ?? [];
        const picked = [];
        for (const r of found) {
          const hasLive = live.some(t => (!t.state || t.state === "live") && (isWithin(t.cwd, r.dir) || readLabels(t.labels)?.repo === r.name));
          if (hasLive) picked.push({ name: r.name, dir: r.dir, hidden: false });
        }
        if (!picked.length && found.length) {
          for (const r of found.slice(0, 2)) picked.push({ name: r.name, dir: r.dir, hidden: false });
        }
        repos = picked;
        setShared("wf.repos", repos);
      }

      if (!this.seededOpen) {
        const vis = repos.filter(r => !r.hidden);
        const live = terminals() ?? [];
        for (const r of vis) {
          const hasLive = live.some(t => (!t.state || t.state === "live") && (isWithin(t.cwd, r.dir) || readLabels(t.labels)?.repo === r.name));
          if (hasLive) this.openRepos.add(r.dir);
        }
        if (!this.openRepos.size && vis.length) this.openRepos.add(vis[0].dir);
        this.seededOpen = true;
        this.saveOpen();
      }

      if (!shared("wf.repo") && repos.length) {
        const first = repos.find(r => !r.hidden) ?? repos[0];
        setShared("wf.repo", { name: first.name, dir: first.dir });
      }

      cx.notify();
      this.scanAll(cx, { prs: true });
    });
  }

  scanAll(cx, { prs = false } = {}) {
    const vis = this.visibleRepos();
    if (!vis.length) return;
    // Expanded repos refresh first so the user sees them immediately.
    const ordered = [...vis].sort((a, b) => Number(this.openRepos.has(b.dir)) - Number(this.openRepos.has(a.dir)));
    cx.spawn(async cx => {
      const queue = [...ordered];
      const worker = async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          await this.refreshRepoAsync(r, cx, { prs });
        }
      };
      await Promise.all([worker(), worker()]);
      this.rewatch(cx);
    });
  }

  refreshRepo(dir, cx, opts = {}) {
    const r = (this.configuredRepos() ?? []).find(x => x.dir === dir);
    if (!r) return;
    cx.spawn(async cx => {
      await this.refreshRepoAsync(r, cx, opts);
      this.rewatch(cx);
    });
  }

  async refreshRepoAsync(repo, cx, { prs = false } = {}) {
    const dir = repo.dir;
    if (this.loading.has(dir)) return;
    this.loading.add(dir);
    cx.notify();
    const t0 = Date.now();
    try {
      const prCache = this.prs[dir] ?? { at: 0, list: undefined };
      const stale = prs || prCache.list === undefined || Date.now() - prCache.at > PR_MS;
      if (!this.models[dir]) {
        const quick = await gatherRepo({ exec, fs, repo, terminals: terminals(), prs: undefined });
        this.models[dir] = quick;
        cx.notify();
      }
      const slug = this.models[dir]?.slug;
      if (stale) {
        const ciCfg = mergeCiSettings(shared("wf.ciSettings"));
        const [list, snap] = slug
          ? await Promise.all([prList(exec, dir, slug), repoCiSnapshot(exec, dir, slug, ciCfg)])
          : [null, null];
        this.prs[dir] = { at: Date.now(), list };
        if (snap) {
          this.ci[dir] = {
            at: Date.now(),
            branch: snap.branch,
            trends: ciTrends(snap, { limit: 6, recencyDays: ciCfg.recencyDays }),
          };
        }
      }
      const model = await gatherRepo({ exec, fs, repo, terminals: terminals(), prs: slug ? this.prs[dir]?.list : null });
      this.models[dir] = model;
      this.lastRefresh[dir] = Date.now();
      track("refresh", { mod: "wf-sidebar", repo: repo.name, ms: Date.now() - t0, count: model.rows.length });

      // Refresh sessions for any currently expanded branches in this repo.
      for (const row of model.rows) {
        if (this.openBranches.has(row.path)) this.loadBranchSessions(row.path, cx);
      }
      if (this.openRepoSess.has(dir)) this.loadRepoSessions(dir, cx);

      if (this.pendingSelect?.repoDir === dir) {
        const hit = model.rows.find(r => r.branch === this.pendingSelect.branch);
        if (hit) {
          this.pendingSelect = null;
          this.openBranches.add(hit.path);
          this.saveOpen();
          setShared("wf.repo", { name: model.name, dir: model.dir });
          setShared("wf.branch", { repo: model.name, path: hit.path, branch: hit.branch });
          this.syncedPath = hit.path;
          const space = spaceForWorktree(spaces(), panes(), hit.path);
          if (space && !space.active) run("space.select", { id: space.id });
        }
      }
    } catch (e) {
      this.models[dir] = { name: repo.name, dir, error: String(e), rows: [], others: [], sessions: [] };
      track("error", { mod: "wf-sidebar", error: "refresh failed" });
    } finally {
      this.loading.delete(dir);
      cx.notify();
    }
  }

  rewatch(cx) {
    this.cancelWatches();
    const gen = this.watchGen;
    const targets = [];
    for (const r of this.visibleRepos()) {
      if (!this.openRepos.has(r.dir)) continue;
      targets.push({ repoDir: r.dir, dir: `${r.dir}/.bare/refs` });
      targets.push({ repoDir: r.dir, dir: `${r.dir}/.bare/worktrees` });
      targets.push({ repoDir: r.dir, dir: `${r.dir}/.git/refs` });
      const m = this.models[r.dir];
      for (const row of m?.rows ?? []) {
        if (this.openBranches.has(row.path) || row.terminals.length) {
          targets.push({ repoDir: r.dir, dir: `${row.path}/docs` });
        }
      }
    }
    for (const { repoDir, dir } of targets.slice(0, MAX_WATCHES)) {
      cx.spawn(async cx => {
        if (!(await fs.exists(dir))) return;
        try {
          for (;;) {
            const w = watchFolder(dir);
            this.watches.push(w);
            const changed = await w;
            if (this.watchGen !== gen || !changed?.length) return;
            const wait = MIN_GAP_MS - (Date.now() - (this.lastRefresh[repoDir] ?? 0));
            if (wait > 0) cx.timer.after(wait, cx => this.refreshRepo(repoDir, cx));
            else this.refreshRepo(repoDir, cx);
          }
        } catch { /* folder gone or cancelled */ }
      });
    }
  }

  // ------------------------------------------------------------------ commands & actions

  command(c, cx) {
    const [name, arg] = String(c).split(/:(.*)/s);
    if (name === "focus") { this.handle.focus(); return; }
    if (name === "refresh") { this.scanAll(cx, { prs: true }); return; }
    if (name === "manage") { this.manage = !this.manage; cx.notify(); return; }
    if (name === "test-menu") {
      const target = this.targetRepo();
      const wt = target?.dir || "/tmp";
      const repo = target?.name || "repo";
      if (arg === "branch") this.openBranchMenu({ name: repo, dir: wt }, { path: wt, branch: "main", dirty: 2 }, 0, false);
      else if (arg === "session") this.openSessionMenu({ terminal: null, sessionId: "e2e-session", file: null, worktree: wt, repo, branch: "main", title: "Closed session" });
      else if (arg === "session-live") this.openSessionMenu({ terminal: "t99", sessionId: "e2e-session", file: null, worktree: wt, repo, branch: "main", title: "Open session" });
      else this.openNewMenu(wt, repo, "main");
      return;
    }
    if (name === "open-ci") {
      const target = this.visibleRepos().find(r => this.models[r.dir]?.slug) || this.targetRepo();
      const slug = target && this.models[target.dir]?.slug;
      if (target && slug) this.openCiTab(target, slug, { tab: arg === "settings" ? "settings" : "overview" });
      return;
    }
    if (name === "test-drag") {
      if (arg === "clear") { this.drag = null; cx.notify(); return; }
      const target = this.visibleRepos().find(r => (this.models[r.dir]?.rows?.length ?? 0) >= 2);
      const rows = target ? (this.models[target.dir]?.rows ?? []) : [];
      if (target && rows.length >= 2) {
        this.drag = {
          repoDir: target.dir,
          path: rows[0].path,
          branch: rows[0].branch,
          startY: 0,
          active: true,
          overPath: rows[1].path,
          position: "after",
          orderedPaths: rows.map(r => r.path),
        };
        cx.notify();
      }
      return;
    }
  }

  addRepoFolder(cx) {
    cx.spawn(async cx => {
      const picked = await pickFolder({ prompt: "Add repository" });
      if (!picked) return;
      const dir = picked.replace(/\/+$/, "");
      if (!(await isGitRepo(dir))) {
        notify({ title: "Not a git repository", body: dir, level: "warning" });
        return;
      }
      const name = dir.split("/").pop();
      const cur = [...(this.configuredRepos() ?? [])];
      const idx = cur.findIndex(r => r.dir === dir);
      if (idx >= 0) cur[idx] = { ...cur[idx], hidden: false };
      else cur.push({ name, dir, hidden: false });
      setShared("wf.repos", cur);
      setShared("wf.repo", { name, dir });
      this.openRepos.add(dir);
      this.saveOpen();
      track("ui", { surface: "wf-sidebar", action: "add-repo", repo: name });
      this.refreshRepo(dir, cx, { prs: true });
      cx.notify();
    });
  }

  toggleRepoVisibility(repo, cx) {
    const cur = [...(this.configuredRepos() ?? [])];
    const idx = cur.findIndex(r => r.dir === repo.dir);
    if (idx >= 0) {
      cur[idx] = { ...cur[idx], hidden: !cur[idx].hidden };
    } else {
      cur.push({ name: repo.name, dir: repo.dir, hidden: false });
    }
    setShared("wf.repos", cur);
    const entry = idx >= 0 ? cur[idx] : cur[cur.length - 1];
    if (!entry.hidden) {
      this.openRepos.add(entry.dir);
      this.saveOpen();
      this.refreshRepo(entry.dir, cx, { prs: true });
    }
    cx.notify();
  }

  removeRepo(dir, cx) {
    const cur = (this.configuredRepos() ?? []).filter(r => r.dir !== dir);
    setShared("wf.repos", cur);
    this.openRepos.delete(dir);
    this.saveOpen();
    cx.notify();
  }

  toggleRepo(repo, cx) {
    setShared("wf.repo", { name: repo.name, dir: repo.dir });
    if (this.openRepos.has(repo.dir)) {
      this.openRepos.delete(repo.dir);
    } else {
      this.openRepos.add(repo.dir);
      if (!this.models[repo.dir]) this.refreshRepo(repo.dir, cx, { prs: true });
    }
    this.saveOpen();
    this.rewatch(cx);
    cx.notify();
  }

  toggleBranch(model, row, cx) {
    if (this.openBranches.has(row.path)) {
      this.openBranches.delete(row.path);
    } else {
      this.openBranches.add(row.path);
      this.loadBranchSessions(row.path, cx);
      if (model) {
        setShared("wf.repo", { name: model.name, dir: model.dir });
        setShared("wf.branch", { repo: model.name, path: row.path, branch: row.branch });
        this.syncedPath = row.path;
      }
    }
    this.saveOpen();
    cx.notify();
  }

  showActiveCanvas() {
    setShared("wf.emptyView", null);
    setShared("wf.navTs", Date.now());
    run("layout.select", { stack: "main-stack", child: "active-tab" });
  }

  // Clicking a branch row toggles its collapsible and selects its existing space (if any).
  // Never spawns a new Claude session automatically: use + or click a past session to start one.
  selectBranch(model, row, cx) {
    if (Date.now() < this.suppressClickUntil) return;
    setShared("wf.repo", { name: model.name, dir: model.dir });
    setShared("wf.branch", { repo: model.name, path: row.path, branch: row.branch });
    this.syncedPath = row.path;
    const wasOpen = this.openBranches.has(row.path);
    if (wasOpen) {
      this.openBranches.delete(row.path);
    } else {
      this.openBranches.add(row.path);
      if (cx) this.loadBranchSessions(row.path, cx);
    }
    this.saveOpen();
    track("ui", { surface: "wf-sidebar", action: wasOpen ? "collapse-branch" : "expand-branch", repo: model.name, branch: row.branch, phase: row.phase.key });
    const space = spaceForWorktree(spaces(), panes(), row.path);
    if (space) {
      this.showActiveCanvas();
      if (!space.active) run("space.select", { id: space.id });
    }
    if (space && row.terminals.length) wf(["resume", "--worktree", row.path]);
    if (cx) cx.notify();
  }

  openNewMenu(worktree, repo, branch) {
    openOverlay({ mod: "wf-menu", kind: "popup", props: { mode: "new", worktree, repo, branch } });
  }

  openBranchMenu(model, row, liveCount, archived) {
    const orderMap = shared("wf.branchOrder");
    const hasCustomOrder = Boolean(orderMap && Array.isArray(orderMap[model.dir]) && orderMap[model.dir].length);
    openOverlay({
      mod: "wf-menu",
      kind: "popup",
      props: { mode: "branch", worktree: row.path, repo: model.name, repoDir: model.dir, branch: row.branch, liveCount, archived, dirty: row.dirty ?? 0, hasCustomOrder },
    });
  }

  commitBranchDrop(cx) {
    const d = this.drag;
    this.drag = null;
    if (!d?.active) { cx.notify(); return; }
    this.suppressClickUntil = Date.now() + 250;
    if (d.overPath && d.overPath !== d.path && Array.isArray(d.orderedPaths) && d.orderedPaths.length) {
      const nextPaths = reorderBranchList(d.orderedPaths, d.path, d.overPath, d.position);
      const prev = shared("wf.branchOrder");
      const map = prev && typeof prev === "object" ? { ...prev } : {};
      map[d.repoDir] = nextPaths;
      setShared("wf.branchOrder", map);
      track("ui", { surface: "wf-sidebar", action: "reorder-branch", branch: d.branch });
      flushTelemetry();
    }
    cx.notify();
  }

  openSessionMenu(propsObj) {
    openOverlay({ mod: "wf-menu", kind: "popup", props: { mode: "session", ...propsObj } });
  }

  // Opens or focuses the dedicated TeamCity Sakura CI tab in its own clean space.
  // When closed, wf-tabs deletes that space automatically and returns to the empty canvas.
  openCiTab(repo, slug, { workflow = null, runId = null, tab = "overview" } = {}, cx = null) {
    if (!slug) return;
    const title = `CI · ${repo.name}`;
    setShared("wf.ciFocus", { repo: repo.name, dir: repo.dir, slug, workflow, runId, tab, ts: Date.now() });
    for (const s of spaces() ?? []) {
      const hit = (s.tabs ?? []).find(tb => tb.name === title);
      if (hit) {
        this.showActiveCanvas();
        if (!s.active) run("space.select", { id: s.id });
        run("tab.select", { id: hit.id });
        return;
      }
    }
    if (this.starting.has(title)) return;
    this.starting.add(title);
    const propsObj = { repo: repo.name, dir: repo.dir, slug, workflow, runId, tab };
    const spawnFn = cx?.spawn ? (fn => cx.spawn(fn)) : (fn => fn());
    spawnFn(async () => {
      try {
        const res = await exec("herdr-app", ["do", "space.new", JSON.stringify({ name: title, tab: "__ci_boot__", folder: repo.dir, focus: false })]);
        const created = res.code === 0 ? JSON.parse(res.stdout || "{}") : null;
        if (!created?.space) {
          notify({ title: "Could not open CI tab", body: (res.stderr || res.stdout || "space.new failed").trim(), level: "error" });
          return;
        }
        // Add wf-ci into its own space, select it, and immediately drop the bootstrap shell tab.
        await exec("herdr-app", ["do", "tab.new", JSON.stringify({ space: created.space, name: title, mod: "wf-ci", props: propsObj, focus: true })]);
        if (created.tab) {
          await exec("herdr-app", ["do", "tab.close", JSON.stringify({ id: created.tab, confirmed: true })]);
        }
        if (created.terminal) {
          await exec("hc", ["kill", created.terminal]).catch(() => {});
          await exec("hc", ["rm", created.terminal]).catch(() => {});
        }
        this.showActiveCanvas();
        run("space.select", { id: created.space });
      } catch (e) {
        notify({ title: "Could not open CI tab", body: String(e?.message ?? e), level: "error" });
      } finally {
        this.starting.delete(title);
      }
    });
  }

  stopLiveTerminal(term, worktreePath, repoName, branch, cx) {
    if (this.starting.has(term.address)) return;
    // If stopping the last live tab in the active space, drop cleanly to the empty canvas.
    const allSpaces = spaces() ?? [];
    const activeSpace = allSpaces.find(s => s.active);
    const pane = (panes() ?? []).find(p => p.terminal === term.address);
    if (activeSpace && pane && (activeSpace.tabs ?? []).length <= 1 && (activeSpace.tabs ?? []).some(tb => tb.id === pane.tab)) {
      const knownTabs = allSpaces.flatMap(s => (s.tabs ?? []).map(tb => tb.id));
      setShared("wf.emptyView", { on: true, knownTabs, ts: Date.now() });
      run("layout.select", { stack: "main-stack", child: "empty" });
    }
    this.starting.add(term.address); cx.notify();
    track("ui", { surface: "wf-sidebar", action: "stop-session", repo: repoName, branch });
    cx.spawn(async cx => {
      const r = await wf(["stop", "--terminal", term.address]);
      if (r.error) {
        track("error", { mod: "wf-sidebar", error: r.error });
        notify({ title: "Could not stop session", body: r.error, level: "error" });
      }
      flushTelemetry();
      this.starting.delete(term.address);
      this.loadBranchSessions(worktreePath, cx);
      cx.notify();
    });
  }

  branchDisplayName(row) {
    const names = shared("wf.branchNames");
    return (names && typeof names === "object" && names[row.path]) || row.branch;
  }

  commitRename(cx) {
    const cur = this.renaming;
    if (!cur) return;
    const next = this.renameInput.value().trim();
    const names = { ...(shared("wf.branchNames") ?? {}) };
    if (next && next !== cur.branch) names[cur.path] = next;
    else delete names[cur.path];
    setShared("wf.branchNames", names);
    const space = spaceForWorktree(spaces(), panes(), cur.path);
    if (space) run("space.rename", { id: space.id, name: next || cur.branch });
    track("ui", { surface: "wf-sidebar", action: "rename-branch", branch: cur.branch });
    this.renaming = null;
    setShared("wf.rename", null);
    cx.notify();
  }

  cancelRename(cx) {
    this.renaming = null;
    setShared("wf.rename", null);
    cx.notify();
  }

  commitSessionRename(cx) {
    const cur = this.renamingSession;
    if (!cur) return;
    const next = this.sessionRenameInput.value().replace(/[\r\n]+/g, " ").trim();
    this.renamingSession = null;
    setShared("wf.renameSession", null);
    if (!next || next === cur.currentName) { cx.notify(); return; }

    if (cur.terminal) {
      this.pendingSessionRename[cur.terminal] = { name: next, until: Date.now() + 6000 };
      this.lastSyncedTabTitle[cur.terminal] = next;
      track("ui", { surface: "wf-sidebar", action: "rename-session-live" });
      cx.notify();
      const args = ["rename", "--terminal", cur.terminal, "--name", next];
      if (cur.tabId) args.push("--tab", cur.tabId);
      cx.spawn(async cx => {
        const r = await wf(args);
        if (r.error) {
          delete this.pendingSessionRename[cur.terminal];
          track("error", { mod: "wf-sidebar", error: r.error });
          notify({ title: "Could not rename session", body: r.error, level: "error" });
        } else {
          notify({ title: "Session renamed", body: r.sentCli ? `Sent /rename ${next}` : next, level: "success", timeout: 1800 });
        }
        flushTelemetry();
        if (cur.worktree) cx.timer.after(1500, cx => this.loadBranchSessions(cur.worktree, cx));
        cx.notify();
      });
      return;
    }

    if (cur.file && cur.sessionId) {
      track("ui", { surface: "wf-sidebar", action: "rename-session-past" });
      cx.notify();
      cx.spawn(async cx => {
        const r = await wf(["rename", "--file", cur.file, "--session", cur.sessionId, "--name", next]);
        if (r.error) {
          track("error", { mod: "wf-sidebar", error: r.error });
          notify({ title: "Could not rename session", body: r.error, level: "error" });
        } else {
          notify({ title: "Session renamed", body: next, level: "success", timeout: 1800 });
        }
        flushTelemetry();
        if (cur.worktree) this.loadBranchSessions(cur.worktree, cx);
        cx.notify();
      });
    }
  }

  cancelSessionRename(cx) {
    this.renamingSession = null;
    setShared("wf.renameSession", null);
    cx.notify();
  }

  // Gently refreshes transcript metadata for expanded branches and global Everything sessions
  // with active terminals so any /rename done inside Claude Code stays reflected in the sidebar.
  refreshLiveSessions(cx) {
    const gdir = this.globalDir();
    if (gdir && this.openEverything && terminalsAt(terminals() ?? [], gdir).length) {
      this.loadBranchSessions(gdir, cx);
    }
    for (const r of this.visibleRepos()) {
      const m = this.models[r.dir];
      if (!m || !this.openRepos.has(r.dir)) continue;
      for (const row of m.rows) {
        if (this.openBranches.has(row.path) && row.terminals.length) {
          this.loadBranchSessions(row.path, cx);
        }
      }
    }
  }

  hasActiveCi() {
    for (const r of this.visibleRepos()) {
      if (!this.openRepos.has(r.dir)) continue;
      const trends = this.ci[r.dir]?.trends ?? [];
      if (trends.some(tr => tr.latest?.state === "running" || tr.latest?.state === "queued")) return true;
      const rows = this.models[r.dir]?.rows ?? [];
      if (rows.some(row => row.ci?.ci === "running")) return true;
    }
    return false;
  }

  // Refreshes PR & CI check status for expanded repos so running pipelines progress live in the sidebar.
  refreshOpenPrs(cx) {
    this.lastPrRefreshAt = Date.now();
    for (const r of this.visibleRepos()) {
      if (this.openRepos.has(r.dir) && this.models[r.dir]?.slug) {
        this.refreshRepo(r.dir, cx, { prs: true });
      }
    }
  }

  focusTerminal(term, worktreePath) {
    this.showActiveCanvas();
    const space = spaceForWorktree(spaces(), panes(), worktreePath);
    if (space && !space.active) run("space.select", { id: space.id });
    const pane = (panes() ?? []).find(p => p.terminal === term.address);
    if (pane) {
      run("tab.select", { id: pane.tab });
      run("pane.focus", { pane: pane.pane });
    } else {
      run("agent.focus", { terminal: term.address });
    }
  }

  // ------------------------------------------------------------------ sessions (Level 3)

  loadBranchSessions(path, cx) {
    const cur = this.branchSessions[path];
    if (cur?.loading) return;
    this.branchSessions[path] = { ...(cur ?? { list: null, error: null, more: false }), loading: true };
    cx.spawn(async cx => {
      const r = await wf(["sessions", "--worktree", path]);
      if (r.error) {
        track("error", { mod: "wf-sidebar", error: r.error });
        this.branchSessions[path] = { ...(this.branchSessions[path] ?? {}), loading: false, error: r.error };
      } else {
        const list = r.sessions ?? [];
        this.branchSessions[path] = { ...(this.branchSessions[path] ?? {}), loading: false, list, error: null };
        this.syncTabTitlesForWorktree(path, list);
      }
      cx.notify();
    });
  }

  // Syncs Herdr's top tab title with Claude's real session title (outside render).
  syncTabTitlesForWorktree(worktreePath, sessionsList) {
    const live = terminals() ?? [];
    const allPanes = panes() ?? [];
    const allSpaces = spaces() ?? [];
    const byId = new Map((sessionsList ?? []).map(s => [s.id, s]));
    for (const term of live) {
      if (term.state && term.state !== "live") continue;
      const lbl = readLabels(term.labels);
      const inWt = lbl?.worktree ? lbl.worktree === worktreePath : isWithin(term.cwd, worktreePath);
      if (!inWt) continue;
      const isClaude = term.program?.key === "claude" || term.app === "claude-code" || Boolean(lbl?.session);
      if (!isClaude) continue;
      const pend = this.pendingSessionRename[term.address];
      if (pend && pend.until > Date.now()) continue;
      const pane = allPanes.find(p => p.terminal === term.address);
      if (!pane?.tab) continue;
      const space = allSpaces.find(s => s.tabs.some(tb => tb.id === pane.tab));
      const tab = space?.tabs.find(tb => tb.id === pane.tab);
      const oscTitle = cleanLiveTitle(pane.title, term.address) ?? cleanLiveTitle(term.title, term.address);
      const tr = lbl?.session ? byId.get(lbl.session) : null;
      const trTitle = tr?.title && tr.title !== "(no prompt yet)" ? tr.title : null;
      const canonical = oscTitle || trTitle;
      if (canonical && tab?.name !== canonical && this.lastSyncedTabTitle[term.address] !== canonical) {
        this.lastSyncedTabTitle[term.address] = canonical;
        run("tab.rename", { id: pane.tab, name: canonical });
      }
    }
  }

  loadRepoSessions(dir, cx) {
    const cur = this.repoSessions[dir];
    if (cur?.loading) return;
    this.repoSessions[dir] = { ...(cur ?? { list: null, total: 0, more: false }), loading: true };
    cx.spawn(async cx => {
      const r = await wf(["sessions", "--repo", dir]);
      this.repoSessions[dir] = { ...(this.repoSessions[dir] ?? {}), loading: false, list: r.sessions ?? [], total: r.total ?? 0 };
      cx.notify();
    });
  }

  resumePastSession(s, target, cx) {
    const live = (terminals() ?? []).find(t => (!t.state || t.state === "live") && readLabels(t.labels)?.session === s.id);
    if (live) { this.focusTerminal(live, target.worktree); return; }
    if (this.starting.has(s.id)) return;
    this.starting.add(s.id);
    if (s.title) this.pendingResumeTitles[s.id] = { name: s.title, until: Date.now() + 8000 };
    cx.notify();
    track("ui", { surface: "wf-sidebar", action: "resume-session", repo: target.repo, branch: target.branch });
    const args = ["open", "--worktree", target.worktree, "--claude", "--focus", "--resume", s.id];
    if (target.copy) args.push("--file", s.file);
    if (target.repo) args.push("--repo", target.repo);
    if (target.branch) args.push("--branch", target.branch);
    cx.spawn(async cx => {
      const r = await wf(args);
      if (r.error) {
        track("error", { mod: "wf-sidebar", error: r.error });
        notify({ title: "Could not resume session", body: r.error, level: "error" });
      } else {
        this.showActiveCanvas();
      }
      flushTelemetry();
      cx.timer.after(2000, cx => { this.starting.delete(s.id); this.loadBranchSessions(target.worktree, cx); cx.notify(); });
      cx.notify();
    });
  }

  showAnswer(s, cx) {
    if (this.answer?.id === s.id) { this.answer = null; cx.notify(); return; }
    this.answer = { id: s.id, text: null, loading: true };
    cx.notify();
    cx.spawn(async cx => {
      const r = await wf(["answer", "--file", s.file]);
      if (this.answer?.id !== s.id) return;
      this.answer = { id: s.id, loading: false, text: r.error ? `Could not read: ${r.error}` : r.text ?? "No answer yet." };
      cx.notify();
    });
  }

  copyText(text, label, cx) {
    cx.write_to_clipboard(text);
    notify({ title: `${label} copied`, level: "success", timeout: 1800 });
  }

  // Keep wf.branch in sync when the user actually focuses a different terminal/pane.
  // Never overwrites an explicit sidebar branch click while the same terminal stays focused
  // or while the empty canvas is displayed.
  syncActiveFromFocus(liveTerms) {
    if (shared("wf.emptyView")?.on) return null;
    const f = focused();
    if (!f) return null;
    const pane = f.pane ? (panes() ?? []).find(p => p.pane === f.pane) : null;
    const term = f.terminal ? liveTerms.find(t => t.address === f.terminal) : null;
    const cwd = pane?.cwd || f.cwd || term?.cwd;
    const lbl = readLabels(term?.labels);
    const activeWorktree = lbl?.worktree || cwd;
    if (!activeWorktree) return null;
    const focusKey = `${f.pane ?? ""}|${f.terminal ?? ""}|${activeWorktree}`;
    if (focusKey === this.lastFocusKey) return null;
    this.lastFocusKey = focusKey;
    for (const r of this.visibleRepos()) {
      const m = this.models[r.dir];
      if (!m?.rows?.length) continue;
      const hit = m.rows.find(row => row.path === activeWorktree || isWithin(activeWorktree, row.path));
      if (hit) {
        if (this.syncedPath !== hit.path) {
          this.syncedPath = hit.path;
          setShared("wf.repo", { name: m.name, dir: m.dir });
          setShared("wf.branch", { repo: m.name, path: hit.path, branch: hit.branch });
          if (!this.openBranches.has(hit.path)) {
            this.openBranches.add(hit.path);
            this.saveOpen();
          }
        }
        return hit.path;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ rendering helpers

  renderCompactRail(t, live) {
    const vis = this.visibleRepos();
    const gdir = this.globalDir();
    const gLive = gdir ? terminalsAt(live, gdir) : [];
    const gNeeds = gLive.some(x => statusWord(x.status) === "blocked");
    const gRun = gLive.some(x => statusWord(x.status) === "working");
    const tiles = [];
    if (gdir) {
      tiles.push(div().id("rail-workspace").relative().size(30).rounded(7).flex().items_center().justify_center().cursor_pointer()
        .bg(t.raised).border(1).border_color(t.border).text_size(10.5).font_semibold().text_color(t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`Workspace (${gdir.split("/").pop()})${gLive.length ? ` · ${gLive.length} live` : ""}`)
        .on_click((_e, cx) => {
          this.openEverything = true;
          try { localStorage.setItem(STORE_OPEN_EVERYTHING, "true"); } catch {}
          this.loadBranchSessions(gdir, cx);
          run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 320 });
          cx.notify();
        })
        .child("WS")
        .when(gNeeds, el => el.child(div().absolute().top(-2).right(-2).size(7).rounded_full().bg(t.blocked)))
        .when(!gNeeds && gRun, el => el.child(div().absolute().top(-2).right(-2).size(7).rounded_full().bg(t.working))));
    }
    for (const r of vis) {
      const m = this.models[r.dir];
      const c = m && !m.error ? counts({ rows: applyAgents(m.rows, live) }) : null;
      const selected = shared("wf.repo")?.dir === r.dir;
      const badge = r.name.replace(/^(customers|internal)-/, "").slice(0, 2).toUpperCase();
      tiles.push(div().id(`rail-${r.dir}`).relative().size(30).rounded(7).flex().items_center().justify_center().cursor_pointer()
        .bg(selected ? t.selected : t.raised).text_size(11).font_semibold().text_color(selected ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`${r.name}${c?.needs ? ` · ${c.needs} needs you` : ""}${c?.running ? ` · ${c.running} running` : ""}`)
        .on_click((_e, cx) => {
          setShared("wf.repo", { name: r.name, dir: r.dir });
          this.openRepos.add(r.dir);
          this.saveOpen();
          run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 320 });
          cx.notify();
        })
        .child(badge)
        .when(Boolean(c?.needs), el => el.child(div().absolute().top(-2).right(-2).size(7).rounded_full().bg(t.blocked)))
        .when(!c?.needs && Boolean(c?.running), el => el.child(div().absolute().top(-2).right(-2).size(7).rounded_full().bg(t.working))));
    }
    return v_flex().id("wf-sidebar-rail").size_full().min_h(0).bg(t.chrome).py(6).gap(6).items_center().overflow_y_scrollbar()
      .children(tiles);
  }

  renderWorkspaceSection(t, ctx) {
    const gdir = this.globalDir();
    if (!gdir) return null;
    const { live, allPanes, allSpaces, focusedTerm, filter } = ctx;
    const liveList = terminalsAt(live, gdir);
    const liveIds = new Set();
    let gRunning = 0, gNeeds = 0;
    for (const term of liveList) {
      const sid = readLabels(term.labels)?.session;
      if (sid) liveIds.add(sid);
      const st = statusWord(term.status);
      if (st === "working") gRunning++;
      if (st === "blocked") gNeeds++;
    }
    const bs = this.branchSessions[gdir];
    const allPast = (bs?.list ?? []).filter(s => !liveIds.has(s.id));
    const filteredPast = filter ? allPast.filter(s => String(s.title ?? "").toLowerCase().includes(filter)) : allPast;
    const shownPast = bs?.more ? filteredPast : filteredPast.slice(0, PAST_SHOWN);
    const totalCount = liveList.length + allPast.length;
    const expanded = this.openEverything;
    const dirLabel = gdir.split("/").pop() || "workspace";

    const rows = [];
    if (expanded) {
      for (const term of liveList) {
        rows.push(this.renderLiveSessionRow(t, term, gdir, "Workspace", null, focusedTerm, allPanes, allSpaces, 16));
      }
      const target = { worktree: gdir, repo: "Workspace", branch: null };
      for (const s of shownPast) {
        rows.push(this.renderPastSessionRow(t, s, target, 16));
      }
      if (filteredPast.length > PAST_SHOWN) {
        rows.push(div().id("ws-more").pl(16).py(1).text_size(10.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { if (this.branchSessions[gdir]) { this.branchSessions[gdir].more = !bs.more; cx.notify(); } })
          .child(bs.more ? "fewer sessions" : `+${filteredPast.length - PAST_SHOWN} more`));
      }
      if (!liveList.length && !filteredPast.length) {
        rows.push(div().id("ws-empty").pl(16).py(2).text_size(10.8).text_color(t.dim).cursor_pointer()
          .hover(s => s.text_color(t.foreground))
          .on_click(() => this.openNewMenu(gdir, "Workspace", null))
          .child(bs?.loading ? "reading sessions..." : filter ? "no matching workspace sessions" : "Click + to start a workspace manager"));
      }
    }

    return v_flex().id("wf-workspace-sec").flex_none().border_t(1).border_color(t.border)
      .child(h_flex().id("ws-hdr").h(26).flex_none().px(10).gap(5).items_center().cursor_pointer()
        .hover(s => s.bg(t.hover))
        .tooltip(`Workspace root (${dirLabel}) · cross-repo orchestration & management`)
        .on_click((_e, cx) => this.toggleEverything(cx))
        .child(svg(`mods/workspace-chrome/chevron-${expanded ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(svg("mods/workspace-chrome/layers.svg").size(11).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_semibold().text_color(t.dim).child("WORKSPACE"))
        .when(gRunning > 0, el => el.child(div().flex_none().px(5).h(15).rounded(4).bg(t.working + "24").text_size(9.5).text_color(t.working).flex().items_center().child(String(gRunning))))
        .when(gNeeds > 0, el => el.child(div().flex_none().px(5).h(15).rounded(4).bg(t.blocked + "26").text_size(9.5).font_semibold().text_color(t.blocked).flex().items_center().child(String(gNeeds))))
        .when(!gRunning && !gNeeds && totalCount > 0, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(String(totalCount))))
        .child(div().id("ws-plus").size(20).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`New agent or terminal in ${dirLabel}`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.openNewMenu(gdir, "Workspace", null); })
          .child(svg("mods/workspace-chrome/plus.svg").size(12)))
        .child(div().id("ws-ref").size(20).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .text_size(11.5).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh workspace sessions")
          .on_click((_e, cx) => { cx.stop_propagation(); this.loadBranchSessions(gdir, cx); }).child("↻")))
      .when(expanded, el => el.child(v_flex().id("ws-list").max_h(160).overflow_y_scrollbar().px(4).pb(4).children(rows)));
  }

  renderManagePanel(t) {
    const cur = this.configuredRepos() ?? [];
    const byDir = new Map(cur.map(r => [r.dir, r]));
    const rows = [];

    for (const r of cur) {
      rows.push(h_flex().id(`mg-${r.dir}`).h(25).flex_none().px(6).gap(6).items_center().rounded(5).hover(s => s.bg(t.hover))
        .child(div().id(`mg-vis-${r.dir}`).px(5).h(17).rounded(4).flex().items_center().text_size(10).cursor_pointer()
          .bg(r.hidden ? t.background : t.accent + "26").text_color(r.hidden ? t.dim : t.accent)
          .on_click((_e, cx) => this.toggleRepoVisibility(r, cx))
          .child(r.hidden ? "hidden" : "shown"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(r.hidden ? t.dim : t.foreground).child(r.name))
        .child(div().id(`mg-rm-${r.dir}`).px(4).text_size(10.5).text_color(t.dim).cursor_pointer().hover(s => s.text_color(t.ansi1))
          .on_click((_e, cx) => this.removeRepo(r.dir, cx)).child("x")));
    }

    const unadded = this.discovered.filter(d => !byDir.has(d.dir));
    if (unadded.length) {
      rows.push(div().px(6).pt(6).pb(2).text_size(10).text_color(t.dim).child("Available in workspaces"));
      for (const d of unadded) {
        rows.push(h_flex().id(`mg-add-${d.dir}`).h(24).flex_none().px(6).gap(6).items_center().rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleRepoVisibility(d, cx))
          .child(svg("mods/workspace-chrome/plus.svg").size(10).text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(d.name)));
      }
    }

    return v_flex().id("wf-manage").flex_none().max_h(210).overflow_y_scrollbar().mx(6).mb(4).p(6).gap(2)
      .rounded(7).border(1).border_color(t.border).bg(t.raised)
      .child(h_flex().px(4).pb(3).items_center()
        .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.muted).child("Show / hide repositories"))
        .child(div().id("mg-done").text_size(10.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { this.manage = false; cx.notify(); }).child("Done")))
      .children(rows);
  }

  renderLiveSessionRow(t, term, worktreePath, repoName, branch, focusedTerm, allPanes, allSpaces, indent = 34) {
    const pane = allPanes.find(p => p.terminal === term.address);
    const space = allSpaces.find(s => s.tabs.some(tb => tb.id === pane?.tab));
    const tab = space?.tabs.find(tb => tb.id === pane?.tab);
    const lbl = readLabels(term.labels);
    const isFocused = focusedTerm === term.address;
    const rowKey = `lt:${term.address}`;
    const isRenaming = this.renamingSession?.key === rowKey;
    const hovered = this.hover === rowKey;
    const stopping = this.starting.has(term.address);
    const status = statusWord(term.status);
    const isClaude = term.program?.key === "claude" || term.app === "claude-code" || Boolean(lbl?.session);

    // Bi-directional session title resolution (never flickers raw hc address like "t3z"):
    //   1) Pending rename just submitted from Herdr sidebar
    //   2) Pending resume title carried from the clicked past session
    //   3) Live terminal title set by Claude Code (updates immediately on /rename in CLI!)
    //   4) Transcript title (customTitle > aiTitle > firstPrompt) from wf sessions
    //   5) Non-generic Herdr tab name
    //   6) Last known good title for this terminal (prevents flicker while stopping)
    //   7) Worktree slug / program name fallback (never raw term.address)
    const pend = this.pendingSessionRename[term.address];
    const pendingName = pend && pend.until > Date.now() ? pend.name : null;
    if (pend && !pendingName) delete this.pendingSessionRename[term.address];
    const resPend = lbl?.session ? this.pendingResumeTitles[lbl.session] : null;
    const resumeName = resPend && resPend.until > Date.now() ? resPend.name : null;
    if (resPend && !resumeName && lbl?.session) delete this.pendingResumeTitles[lbl.session];
    const oscTitle = cleanLiveTitle(pane?.title, term.address) ?? cleanLiveTitle(term.title, term.address);
    const transcriptMatch = lbl?.session ? (this.branchSessions[worktreePath]?.list ?? []).find(s => s.id === lbl.session) : null;
    const transcriptTitle = transcriptMatch?.title && transcriptMatch.title !== "(no prompt yet)" ? transcriptMatch.title : null;
    const tabTitle = tab?.named && !GENERIC_TITLES.has(String(tab.name ?? "").trim().toLowerCase()) ? tab.name : null;
    const resolved = pendingName || (isClaude ? (oscTitle || transcriptTitle || resumeName || tabTitle) : (tabTitle || oscTitle));
    if (resolved) this.lastKnownTitle[term.address] = resolved;
    const fallbackProg = term.program?.name && term.program.key !== "program" ? term.program.name : null;
    const name = resolved || this.lastKnownTitle[term.address] || (isClaude ? (sessionNameFor(worktreePath) || "Claude Code") : (fallbackProg || "Terminal"));

    if (isRenaming) {
      return h_flex().id(`lt-ren-${term.address}`).h(27).flex_none().pl(indent).pr(6).gap(4).items_center()
        .on_key_down((e, cx) => { if (e.key === "escape") { this.cancelSessionRename(cx); cx.stop_propagation(); } })
        .child(div().flex_1().min_w(0).child(Input.new(this.sessionRenameInput).h(22).px(6).items_center().rounded(5).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground).text_size(11.5)))
        .child(div().id(`lt-ren-ok-${term.address}`).px(6).h(20).rounded(4).bg(t.solid).text_color(t.solid_foreground).text_size(10).flex().items_center().cursor_pointer()
          .on_click((_e, cx) => this.commitSessionRename(cx)).child("Save"));
    }

    const prog = term.program?.name;
    const sub = prog && prog.toLowerCase() !== name.toLowerCase() && !isClaude ? prog : null;

    return h_flex().id(`lt-${term.address}`).h(24).flex_none().pl(indent).pr(6).gap(6).items_center().rounded(5).cursor_pointer()
      .when(isFocused, el => el.bg(t.selected)).hover(s => s.bg(isFocused ? t.selected : t.hover))
      .on_hover((h, cx) => { this.hover = h ? rowKey : this.hover === rowKey ? null : this.hover; cx.notify(); })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.openSessionMenu({
          terminal: term.address, sessionId: lbl?.session ?? null, file: transcriptMatch?.file ?? null,
          worktree: worktreePath, repo: repoName, branch, title: name,
          spaceId: space?.id ?? null, tabId: pane?.tab ?? null, paneId: pane?.pane ?? null,
        });
      })
      .on_click(() => this.focusTerminal(term, worktreePath))
      .child(programGlyph(term.program, t, false))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(isFocused ? t.foreground : t.muted).tooltip(name).child(stopping ? "stopping..." : name))
      .when(!hovered && Boolean(sub), el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(sub)))
      .when(!hovered && Boolean(status), el => el.child(agentDot(t, status)))
      .when(!hovered && !status && lbl?.role === "shell", el => el.child(div().flex_none().text_size(10).text_color(t.dim).child("sh")))
      .when(hovered && !stopping, el => el.child(div().id(`lt-x-${term.address}`).size(17).flex_none().rounded(4).flex().items_center().justify_center()
        .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.ansi1)).tooltip("Stop session (stays resumable)")
        .on_click((_e, cx) => { cx.stop_propagation(); this.stopLiveTerminal(term, worktreePath, repoName, branch, cx); })
        .child(svg("mods/workspace-chrome/x.svg").size(10))));
  }

  renderPastSessionRow(t, s, target, indent = 34) {
    const busy = this.starting.has(s.id);
    const rowKey = `ps:${s.id}`;
    const isRenaming = this.renamingSession?.key === rowKey;
    const hovered = this.hover === rowKey;
    const resume = `${s.cwd ? `cd ${quote(s.cwd)} && ` : ""}claude --resume ${s.id}`;
    const micro = (id, label, action) => div().id(`${id}-${s.id}`).px(4).rounded(3).text_size(10).text_color(t.muted).cursor_pointer()
      .hover(st => st.bg(t.raised).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);

    if (isRenaming) {
      return h_flex().id(`ps-ren-${s.id}`).h(27).flex_none().pl(indent).pr(6).gap(4).items_center()
        .on_key_down((e, cx) => { if (e.key === "escape") { this.cancelSessionRename(cx); cx.stop_propagation(); } })
        .child(div().flex_1().min_w(0).child(Input.new(this.sessionRenameInput).h(22).px(6).items_center().rounded(5).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground).text_size(11.5)))
        .child(div().id(`ps-ren-ok-${s.id}`).px(6).h(20).rounded(4).bg(t.solid).text_color(t.solid_foreground).text_size(10).flex().items_center().cursor_pointer()
          .on_click((_e, cx) => this.commitSessionRename(cx)).child("Save"));
    }

    return v_flex().id(`ps-${s.id}`).flex_none()
      .child(h_flex().h(23).pl(indent).pr(8).gap(6).items_center().rounded(5).cursor_pointer()
        .hover(st => st.bg(t.hover))
        .on_hover((h, cx) => { this.hover = h ? rowKey : this.hover === rowKey ? null : this.hover; cx.notify(); })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          this.openSessionMenu({
            terminal: null, sessionId: s.id, file: s.file, worktree: target.worktree,
            repo: target.repo, branch: target.branch, title: s.title,
          });
        })
        .on_click((_e, cx) => this.resumePastSession(s, target, cx))
        .child(image("icons/claude.svg").size(11).flex_none().opacity(0.45))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).tooltip(s.title).child(busy ? "resuming..." : s.title))
        .when(!hovered, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`${s.prompts}p · ${ago(s.last)}`)))
        .when(hovered && Boolean(s.file), el => el
          .child(micro("psa", this.answer?.id === s.id ? "hide" : "ans", cx => this.showAnswer(s, cx)))
          .child(micro("psi", "id", cx => this.copyText(s.id, "Session id", cx)))
          .child(micro("psc", "cmd", cx => this.copyText(resume, "Resume command", cx)))))
      .when(this.answer?.id === s.id, el => el.child(div().id(`psx-${s.id}`).ml(indent).mr(8).my(2).p(6).max_h(140).overflow_y_scroll().rounded(5)
        .bg(t.raised).text_size(11).text_color(t.foreground).whitespace_normal()
        .child(this.answer.loading ? "Reading..." : this.answer.text)));
  }

  renderBranchTree(t, model, { row, depth }, { activeWorktree, live, allPanes, allSpaces, focusedTerm, archivedSet, orderedPaths = null }) {
    const expanded = this.openBranches.has(row.path);
    const isActive = activeWorktree === row.path;
    const isArchived = archivedSet.has(row.path);
    const isRenaming = this.renaming?.path === row.path;
    const hovered = this.hover === `br:${row.path}`;
    const pr = row.pr;
    const ci = row.ci ?? null;
    const liveList = live.filter(x => (!x.state || x.state === "live") && row.terminals.includes(x.address));
    const hasLive = liveList.length > 0;
    const showChip = !row.isBase && row.phase.key !== "none";
    const chipCol = phaseColor(t, row.phase);
    const label = this.branchDisplayName(row);
    const out = [];

    const drag = this.drag;
    const isDraggingThis = Boolean(drag?.active && drag.repoDir === model.dir && drag.path === row.path);
    const isDropTarget = Boolean(drag?.active && drag.repoDir === model.dir && drag.overPath === row.path && drag.path !== row.path);
    const dropLine = () => h_flex().h(3).flex_none().pl(12 + depth * 12).pr(8).items_center().gap(0)
      .child(div().size(6).flex_none().rounded_full().bg(t.accent))
      .child(div().flex_1().h(2).rounded_full().bg(t.accent));

    // Level 2: Branch / Worktree header row (click toggles collapsible; hold & drag reorders like a playlist; right-click opens menu)
    if (isRenaming) {
      out.push(h_flex().id(`br-ren-${row.path}`).h(29).flex_none().pl(12 + depth * 12).pr(6).gap(4).items_center()
        .on_key_down((e, cx) => { if (e.key === "escape") { this.cancelRename(cx); cx.stop_propagation(); } })
        .child(div().flex_1().min_w(0).child(Input.new(this.renameInput).h(24).px(6).items_center().rounded(5).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground).text_size(11.8)))
        .child(div().id(`br-ren-ok-${row.path}`).px(6).h(22).rounded(4).bg(t.solid).text_color(t.solid_foreground).text_size(10.5).flex().items_center().cursor_pointer()
          .on_click((_e, cx) => this.commitRename(cx)).child("Save")));
    } else {
      if (isDropTarget && drag.position === "before") out.push(dropLine());
      out.push(h_flex().id(`br-${row.path}`).h(27).flex_none().pl(12 + depth * 12).pr(6).gap(5).items_center().rounded(5).cursor_pointer()
        .when(isActive && !isDraggingThis, el => el.bg(t.selected))
        .when(isDraggingThis, el => el.opacity(0.42).bg(t.raised).border(1).border_color(t.accent + "88"))
        .hover(s => s.bg(isActive ? t.selected : t.hover))
        .on_hover((h, cx) => { this.hover = h ? `br:${row.path}` : this.hover === `br:${row.path}` ? null : this.hover; cx.notify(); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openBranchMenu(model, row, liveList.length, isArchived); })
        .when(!isArchived && Array.isArray(orderedPaths), el => el
          .on_mouse_down("left", (e, _cx) => {
            this.drag = {
              repoDir: model.dir, path: row.path, branch: row.branch,
              startY: e.position.y, active: false, overPath: null, position: "before",
              orderedPaths,
            };
          })
          .on_mouse_move((e, cx) => {
            const d = this.drag;
            if (!d || d.repoDir !== model.dir) return;
            if (!d.active) {
              if (Math.abs(e.position.y - d.startY) < 5) return;
              d.active = true;
            }
            const half = (e.bounds?.size?.height ?? 27) / 2;
            const pos = e.local_position.y < half ? "before" : "after";
            if (d.overPath !== row.path || d.position !== pos) {
              d.overPath = row.path;
              d.position = pos;
              cx.notify();
            }
          })
          .on_mouse_up("left", (_e, cx) => {
            if (this.drag) {
              if (this.drag.active) cx.stop_propagation();
              this.commitBranchDrop(cx);
            }
          }))
        .on_click((_e, cx) => this.selectBranch(model, row, cx))
        .child(div().id(`bchev-${row.path}`).size(15).flex_none().flex().items_center().justify_center().rounded(3)
          .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleBranch(model, row, cx); })
          .child(svg(`mods/workspace-chrome/chevron-${expanded ? "down" : "right"}.svg`).size(10)))
        .when(Boolean(row.agent), el => el.child(agentDot(t, row.agent)))
        .when(depth > 0, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child("↳")))
        .child(div().flex_1().min_w(0).truncate().text_size(12)
          .text_color(isArchived ? t.dim : hasLive ? t.foreground : t.dim)
          .when(hasLive && isActive, el => el.font_medium())
          .child(label))
        // Termic TaskPrBadge + TaskPrSignals (exact icons, static — motion is reserved for local agents):
        //   Left of #num: green Check when PR is approved (open)
        //   #num color: PR state only (open=green, draft=dim, merged=purple, closed=muted red)
        //   Blocker slot: Swords red (conflict) > Workflow red (CI failing) > PencilLine amber (changes requested)
        //   Progress slot: Workflow amber (CI running + passed/total) | Workflow green (CI passing)
        .when(Boolean(pr?.number), el => {
          const prCol = pr.state === "MERGED" ? t.ansi5 : pr.state === "CLOSED" ? t.ansi1 : pr.isDraft ? t.dim : t.ansi2;
          const approved = Boolean(ci?.approved && pr.state === "OPEN" && !pr.isDraft);
          const blocker = ci?.conflict ? { icon: "swords", color: t.ansi1 }
            : ci?.ci === "failing" ? { icon: "workflow", color: t.ansi1 }
            : ci?.changesRequested ? { icon: "pencil-line", color: t.ansi3 }
            : null;
          const progress = ci?.ci === "running" ? { icon: "workflow", color: t.ansi3 }
            : ci?.ci === "passing" ? { icon: "workflow", color: t.ansi2 }
            : null;
          return el.child(h_flex().id(`bprbadge-${row.path}`).flex_none().gap(3).items_center().px(2).rounded(4)
            .when(Boolean(pr.url), e => e.cursor_pointer().hover(s => s.bg(t.raised))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(pr.url); }))
            .tooltip(ci?.tooltip ?? `PR #${pr.number} (${pr.state?.toLowerCase() ?? "open"})`)
            .when(approved, e => e.child(h_flex().gap(1).items_center()
              .child(svg("mods/wf-sidebar/icons/check.svg").size(11).text_color(t.ansi2))
              .when((ci?.approvals ?? 0) > 0, e2 => e2.child(div().text_size(9.5).text_color(t.ansi2).child(String(ci.approvals))))))
            .child(div().text_size(10.5).text_color(prCol).when(pr.state === "CLOSED", e => e.opacity(0.65)).child(`#${pr.number}`))
            .when(Boolean(blocker), e => e.child(svg(`mods/wf-sidebar/icons/${blocker.icon}.svg`).size(11).text_color(blocker.color)))
            .when(Boolean(progress), e => e.child(h_flex().gap(2).items_center()
              .child(svg(`mods/wf-sidebar/icons/${progress.icon}.svg`).size(11).text_color(progress.color))
              .when(ci?.ci === "running" && ci.total > 0, e2 => e2.child(div().text_size(9.5).text_color(t.ansi3).child(`${ci.passed}/${ci.total}`))))));
        })
        .when(showChip, el => el.child(div().flex_none().px(5).h(16).rounded(4).border(1).border_color(chipCol + "44").bg(chipCol + "18")
          .text_size(9.8).text_color(chipCol).flex().items_center().when(!hasLive, el => el.opacity(0.65)).child(chipLabel(row.phase))))
        .when(!hovered && !showChip && liveList.length > 0, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`(${liveList.length})`)))
        .when(hovered || isActive, el => el.child(div().id(`bplus-${row.path}`).flex_none().size(18).rounded(4).flex().items_center().justify_center()
          .text_color(t.muted).hover(s => s.bg(t.raised).text_color(t.foreground))
          .tooltip("New agent or terminal in this branch")
          .on_click((_e, cx) => { cx.stop_propagation(); this.openNewMenu(row.path, model.name, row.branch); })
          .child(svg("mods/workspace-chrome/plus.svg").size(11)))));
    }

    if (!expanded) {
      if (isDropTarget && drag.position === "after") out.push(dropLine());
      return out;
    }

    // Level 3: Live terminals & AI CLIs attached to this branch
    const liveSessionIds = new Set();
    for (const term of liveList) {
      const sid = readLabels(term.labels)?.session;
      if (sid) liveSessionIds.add(sid);
      out.push(this.renderLiveSessionRow(t, term, row.path, model.name, row.branch, focusedTerm, allPanes, allSpaces));
    }

    // Level 3: Past / sleeping Claude sessions for this branch
    const bs = this.branchSessions[row.path];
    const past = (bs?.list ?? []).filter(s => !liveSessionIds.has(s.id));
    const shownPast = bs?.more ? past : past.slice(0, PAST_SHOWN);
    const target = { worktree: row.path, repo: model.name, branch: row.branch };
    for (const s of shownPast) out.push(this.renderPastSessionRow(t, s, target));
    if (past.length > PAST_SHOWN) {
      out.push(div().id(`bmore-${row.path}`).pl(34).py(1).text_size(10.5).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.branchSessions[row.path].more = !bs.more; cx.notify(); })
        .child(bs.more ? "fewer sessions" : `+${past.length - PAST_SHOWN} more sessions`));
    }
    if (!liveList.length && !past.length) {
      out.push(div().pl(34).py(1).text_size(10.5).text_color(t.dim).child(bs?.loading ? "reading sessions..." : "no sessions yet (click + to start)"));
    }

    // Compact action strip when branch is expanded (keeps branches clean; PR CI lives in the row badges)
    const hasNext = Boolean(row.phase.next?.command && row.phase.who === "user");
    if (hasNext || row.issue || row.pr?.url) {
      out.push(h_flex().pl(34).pr(8).py(2).gap(6).items_center().text_size(10.5)
        .when(hasNext, el => el.child(div().id(`bnext-${row.path}`).px(6).h(18).rounded(4).bg(t.blocked + "22").text_color(t.blocked).flex().items_center().cursor_pointer()
          .hover(s => s.bg(t.blocked + "38")).tooltip(`Copy: ${row.phase.next.command}`)
          .on_click((_e, cx) => this.copyText(row.phase.next.command, "Command", cx))
          .child(row.phase.next.command)))
        .when(Boolean(row.pr?.url), el => el.child(div().id(`bpr-${row.path}`).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => cx.open_url(row.pr.url)).child(`PR #${row.pr.number}`)))
        .when(Boolean(row.issue), el => el.child(div().id(`biss-${row.path}`).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => cx.open_url(row.issue)).child("issue"))));
    }

    if (isDropTarget && drag.position === "after") out.push(dropLine());
    return out;
  }

  renderRepoSection(t, repo, ctx) {
    const { live, filter } = ctx;
    const m = this.models[repo.dir];
    if (m && !m.error) applyAgents(m.rows, live);
    const c = m && !m.error ? counts({ rows: m.rows }) : null;
    const expanded = this.openRepos.has(repo.dir);
    const hovered = this.hover === `rp:${repo.dir}`;
    const isTarget = this.targetRepo()?.dir === repo.dir;
    const isLoading = this.loading.has(repo.dir);
    const out = [];

    // Level 1: Collapsible Repository Header (Termic style)
    out.push(h_flex().id(`rp-${repo.dir}`).h(28).flex_none().mt(3).px(6).gap(5).items_center().rounded(5).cursor_pointer()
      .bg(t.raised + (expanded ? "99" : "55")).hover(s => s.bg(t.hover))
      .on_hover((h, cx) => { this.hover = h ? `rp:${repo.dir}` : this.hover === `rp:${repo.dir}` ? null : this.hover; cx.notify(); })
      .on_click((_e, cx) => this.toggleRepo(repo, cx))
      .child(svg(`mods/workspace-chrome/chevron-${expanded ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(11.2).font_semibold().text_color(isTarget ? t.foreground : t.muted).child(repo.name.toUpperCase()))
      .when(isLoading, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.dim).spin(900)))
      .when(Boolean(c?.running), el => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.working + "24").text_size(10).text_color(t.working).flex().items_center().child(String(c.running))))
      .when(Boolean(c?.needs), el => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.blocked + "26").text_size(10).font_semibold().text_color(t.blocked).flex().items_center().child(String(c.needs))))
      .when(hovered || isTarget, el => el
        .child(div().id(`rp-plus-${repo.dir}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
          .text_color(t.muted).hover(s => s.bg(t.selected).text_color(t.foreground))
          .tooltip("New session in repository folder")
          .on_click((_e, cx) => { cx.stop_propagation(); this.openNewMenu(repo.dir, repo.name, null); })
          .child(svg("mods/workspace-chrome/plus.svg").size(11)))
        .child(div().id(`rp-ref-${repo.dir}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
          .text_size(11).text_color(t.dim).hover(s => s.bg(t.selected).text_color(t.foreground))
          .tooltip("Refresh repository")
          .on_click((_e, cx) => { cx.stop_propagation(); this.refreshRepo(repo.dir, cx, { prs: true }); }).child("↻"))));

    if (!expanded) return out;
    if (!m) {
      out.push(div().pl(20).py(4).text_size(11).text_color(t.dim).child("Loading branches..."));
      return out;
    }
    if (m.error) {
      out.push(div().pl(20).py(4).text_size(11).text_color(t.ansi1).child(m.error));
      return out;
    }

    // Flexible balanced TeamCity Sakura CI pill strip (no collapsible: clicking opens the
    // dedicated wf-ci tab for full build history, jobs, logs, and workflow settings).
    const trends = this.ci[repo.dir]?.trends ?? [];
    if (trends.length && m.slug) {
      const SAKURA_PASS = "#22c55e";
      const SAKURA_FAIL = "#ef4444";
      const SAKURA_RUN = "#16a34a";
      const SAKURA_QUEUE = "#15803d";
      const barStrip = (prefix, tr, bars) => h_flex().gap(2).items_end().h(13).flex_none()
        .children(bars.map((b, i) => {
          const h = Math.max(3, Math.round(b.ratio * 13));
          const col = b.state === "failed" ? SAKURA_FAIL
            : b.state === "passed" ? SAKURA_PASS
            : b.state === "queued" ? SAKURA_QUEUE
            : b.state === "running" ? SAKURA_RUN
            : t.dim + "66";
          return div().id(`${prefix}-${i}`).w(3.5).h(h).rounded(1).bg(col).cursor_pointer()
            .when(b.stale, el => el.opacity(0.32))
            .when(b.state === "running" || b.state === "queued", el => el.loop("opacity", { from: 0.45, to: 1, period: 1300 }))
            .on_click((_e, cx) => { cx.stop_propagation(); this.openCiTab(repo, m.slug, { workflow: tr.name, runId: b.id }, cx); })
            .tooltip(b.tooltip);
        }));

      // Balance rows cleanly across the live sidebar width (e.g. 4 chips -> 1x4 when wide, 2x2 at 320-420px; never 3+1).
      const panelW = findNode(layout(), "sidebar")?.size?.px ?? 320;
      const availW = Math.max(120, panelW - 48);
      const maxCols = Math.max(1, Math.min(trends.length, Math.floor(availW / 102)));
      const rowCount = Math.ceil(trends.length / maxCols);
      const cols = Math.ceil(trends.length / rowCount);
      const chipRows = [];
      for (let rIdx = 0; rIdx < trends.length; rIdx += cols) {
        chipRows.push(trends.slice(rIdx, rIdx + cols));
      }

      out.push(h_flex().id(`ci-strip-${repo.dir}`).flex_none().pl(12).pr(6).py(3).gap(4).items_start()
        .child(v_flex().flex_1().min_w(0).gap(4)
          .children(chipRows.map((rowItems, ri) =>
            h_flex().gap(5).items_center()
              .children(rowItems.map((tr, ciIdx) => {
                const i = ri * cols + ciIdx;
                const st = tr.latest?.state ?? "cancelled";
                const dotCol = st === "failed" ? SAKURA_FAIL
                  : st === "passed" ? SAKURA_PASS
                  : st === "running" ? SAKURA_RUN
                  : st === "queued" ? SAKURA_QUEUE
                  : t.dim;
                return h_flex().id(`ci-chip-${repo.dir}-${i}`).flex_1().min_w(0).h(23).px(7).gap(5).items_center().justify_between()
                  .rounded(5).border(1).border_color(st === "failed" ? SAKURA_FAIL + "66" : t.border).bg(t.raised + "88")
                  .cursor_pointer().hover(s => s.bg(t.hover).border_color(t.accent + "77"))
                  .tooltip(`${tr.name} (${tr.source === "pr" ? "PRs" : (tr.branch || "main")})\nClick to open CI tab`)
                  .on_click((_e, cx) => this.openCiTab(repo, m.slug, { workflow: tr.name }, cx))
                  .child(h_flex().gap(5).items_center().min_w(0)
                    .child(div().size(6).flex_none().rounded_full().bg(dotCol)
                      .when(st === "running" || st === "queued", el => el.loop("opacity", { from: 0.4, to: 1, period: 1200 })))
                    .child(div().truncate().text_size(10.8).text_color(st === "failed" ? SAKURA_FAIL : t.muted).child(tr.short)))
                  .child(barStrip(`cic-${repo.dir}-${i}`, tr, tr.bars.slice(-5)));
              })))))
        .child(div().id(`ci-cfg-${repo.dir}`).size(23).flex_none().rounded(5).flex().items_center().justify_center()
          .cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Choose CI workflows & short names")
          .on_click((_e, cx) => this.openCiTab(repo, m.slug, { tab: "settings" }, cx))
          .child(svg("mods/wf-sidebar/icons/sliders.svg").size(12))));
    }

    // Tier 2: Branchless / repo-root control room (outside any worktree, e.g. triage, research & orchestration)
    if (!this.statusFilter) {
      const rs = this.repoSessions[repo.dir];
      const liveIds = new Set();
      const repoLiveTerms = [];
      for (const s of m.sessions) {
        const term = live.find(x => x.address === s.address);
        if (term) {
          const sid = readLabels(term.labels)?.session;
          if (sid) liveIds.add(sid);
          repoLiveTerms.push(term);
        }
      }
      const allPastRepo = (rs?.list ?? []).filter(s => s.home === "repo" && !liveIds.has(s.id));
      const repoSessCount = repoLiveTerms.length + allPastRepo.length;
      const repoSessOpen = this.openRepoSess.has(repo.dir);
      const rsHovered = this.hover === `rs:${repo.dir}`;
      const rsRunning = repoLiveTerms.some(x => statusWord(x.status) === "working");
      const rsNeeds = repoLiveTerms.some(x => statusWord(x.status) === "blocked");
      out.push(h_flex().id(`rs-${repo.dir}`).h(25).flex_none().pl(12).pr(6).gap(5).items_center().rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
        .on_hover((h, cx) => { this.hover = h ? `rs:${repo.dir}` : this.hover === `rs:${repo.dir}` ? null : this.hover; cx.notify(); })
        .tooltip(`${repo.name} root (outside any branch) · triage, research & orchestration`)
        .on_click((_e, cx) => {
          if (this.openRepoSess.has(repo.dir)) this.openRepoSess.delete(repo.dir);
          else { this.openRepoSess.add(repo.dir); this.loadRepoSessions(repo.dir, cx); }
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${repoSessOpen ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(svg("mods/workspace-chrome/layers.svg").size(11).flex_none().text_color(repoLiveTerms.length ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(repoLiveTerms.length ? t.foreground : t.muted).child("general"))
        .when(rsNeeds, el => el.child(agentDot(t, "blocked")))
        .when(!rsNeeds && rsRunning, el => el.child(agentDot(t, "working")))
        .when(repoSessCount > 0, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`(${repoSessCount})`)))
        .when(rsHovered || repoSessOpen, el => el.child(div().id(`rs-plus-${repo.dir}`).flex_none().size(18).rounded(4).flex().items_center().justify_center()
          .text_color(t.muted).hover(s => s.bg(t.raised).text_color(t.foreground))
          .tooltip(`New agent or terminal in ${repo.name} root`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.openNewMenu(repo.dir, repo.name, null); })
          .child(svg("mods/workspace-chrome/plus.svg").size(11)))));
      if (repoSessOpen) {
        for (const term of repoLiveTerms) {
          out.push(this.renderLiveSessionRow(t, term, repo.dir, repo.name, null, ctx.focusedTerm, ctx.allPanes, ctx.allSpaces));
        }
        const shownPastRepo = rs?.more ? allPastRepo : allPastRepo.slice(0, PAST_SHOWN);
        for (const s of shownPastRepo) {
          out.push(this.renderPastSessionRow(t, s, { worktree: repo.dir, repo: repo.name, branch: null }));
        }
        if (allPastRepo.length > PAST_SHOWN) {
          out.push(div().id(`rsmore-${repo.dir}`).pl(34).py(1).text_size(10.5).text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { if (this.repoSessions[repo.dir]) { this.repoSessions[repo.dir].more = !rs.more; cx.notify(); } })
            .child(rs.more ? "fewer sessions" : `+${allPastRepo.length - PAST_SHOWN} more`));
        }
        if (!repoLiveTerms.length && !allPastRepo.length) {
          out.push(div().pl(34).py(1).text_size(10.5).text_color(t.dim).child(rs?.loading ? "reading sessions..." : "no repo-root chats yet (click + to start)"));
        }
      }
    }

    // Branches / worktrees (custom drag-and-drop playlist order if set, else grouped by urgency; archived below)
    const groups = groupRows(m);
    const activeItems = [];
    const archivedItems = [];
    for (const g of groups) {
      if (this.statusFilter && g.key !== this.statusFilter) continue;
      for (const item of g.items) {
        if (ctx.archivedSet.has(item.row.path)) archivedItems.push(item);
        else activeItems.push(item);
      }
    }
    const orderMap = shared("wf.branchOrder");
    const savedOrder = orderMap && typeof orderMap === "object" ? orderMap[repo.dir] : null;
    const orderedActive = applyBranchOrder(activeItems, savedOrder);
    const orderedPaths = orderedActive.map(it => it.row.path);
    const repoCtx = { ...ctx, orderedPaths };
    let shownCount = 0;
    for (const item of orderedActive) {
      const label = this.branchDisplayName(item.row).toLowerCase();
      if (filter && !item.row.branch.toLowerCase().includes(filter) && !label.includes(filter) && !repo.name.toLowerCase().includes(filter)) continue;
      shownCount++;
      out.push(...this.renderBranchTree(t, m, item, repoCtx));
    }
    if (!shownCount && (filter || this.statusFilter)) {
      out.push(div().pl(20).py(3).text_size(11).text_color(t.dim).child("No matching branches"));
    }

    // Collapsible Archived tasks (right-click -> Restore task to bring back)
    if (archivedItems.length && !this.statusFilter) {
      const archOpen = this.openArchived.has(repo.dir);
      out.push(h_flex().id(`arch-${repo.dir}`).h(23).flex_none().pl(14).pr(8).gap(5).items_center().rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (this.openArchived.has(repo.dir)) this.openArchived.delete(repo.dir);
          else this.openArchived.add(repo.dir);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${archOpen ? "down" : "right"}.svg`).size(9).text_color(t.dim))
        .child(div().text_size(10.5).text_color(t.dim).child(`Archived (${archivedItems.length})`)));
      if (archOpen) {
        for (const item of archivedItems) out.push(...this.renderBranchTree(t, m, item, ctx));
      }
    }

    // Collapsible other branches (no worktree)
    if (m.others?.length && !this.statusFilter) {
      const othersOpen = this.openOthers.has(repo.dir);
      const filteredOthers = filter ? m.others.filter(o => o.name.toLowerCase().includes(filter)) : m.others;
      out.push(h_flex().id(`oth-${repo.dir}`).h(23).flex_none().pl(14).pr(8).gap(5).items_center().rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (this.openOthers.has(repo.dir)) this.openOthers.delete(repo.dir);
          else this.openOthers.add(repo.dir);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${othersOpen ? "down" : "right"}.svg`).size(9).text_color(t.dim))
        .child(div().text_size(10.5).text_color(t.dim).child(`Other branches (${filteredOthers.length})`)));
      if (othersOpen) {
        for (const o of filteredOthers.slice(0, OTHERS_SHOWN)) {
          out.push(h_flex().h(22).flex_none().pl(28).pr(8).gap(6).items_center().text_size(11)
            .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(o.name))
            .child(div().flex_none().text_size(9.5).text_color(t.dim).child(o.where)));
        }
      }
    }

    return out;
  }

  render(cx) {
    try { return this.draw(cx); }
    catch (e) {
      track("error", { mod: "wf-sidebar", error: "render failed", detail: String(e?.message ?? e).slice(0, 120) });
      flushTelemetry();
      return div().p(10).text_size(11.5).text_color(theme().ansi1).child(`wf-sidebar: ${e?.stack ?? e}`);
    }
  }

  draw(cx) {
    const t = theme();
    const live = terminals() ?? [];
    if (isNarrow()) return this.renderCompactRail(t, live);

    const allPanes = panes() ?? [];
    const allSpaces = spaces() ?? [];
    const focusedTerm = focused()?.terminal ?? null;
    const activeWorktree = this.syncActiveFromFocus(live) ?? shared("wf.branch")?.path ?? null;

    // Trigger lazy session load for workspace root, expanded repos' general containers, and expanded branches.
    const gdir = this.globalDir();
    if (gdir && this.openEverything && !this.branchSessions[gdir]) {
      this.loadBranchSessions(gdir, cx);
    }
    for (const r of this.visibleRepos()) {
      const m = this.models[r.dir];
      if (!m || !this.openRepos.has(r.dir)) continue;
      if (!this.repoSessions[r.dir]) this.loadRepoSessions(r.dir, cx);
      for (const row of m.rows) {
        if (this.openBranches.has(row.path) && !this.branchSessions[row.path]) {
          this.loadBranchSessions(row.path, cx);
        }
      }
    }

    // Rollup totals across visible repos
    let totalNeeds = 0, totalRunning = 0;
    for (const r of this.visibleRepos()) {
      const m = this.models[r.dir];
      if (!m || m.error) continue;
      const c = counts({ rows: applyAgents(m.rows, live) });
      totalNeeds += c.needs;
      totalRunning += c.running;
    }

    // Pick up rename requests from wf-menu (branch or session) — defer InputState mutations out of draw()
    const renameReq = shared("wf.rename");
    if (renameReq?.path && renameReq.ts !== this.renaming?.ts) {
      this.renaming = renameReq;
      const names = shared("wf.branchNames");
      const currentName = (names && names[renameReq.path]) || renameReq.branch || "";
      cx.timer.after(1, cx => {
        this.renameInput.set_value(currentName);
        this.renameInput.focus();
        cx.notify();
      });
    }
    const sessRenameReq = shared("wf.renameSession");
    if (sessRenameReq?.key && sessRenameReq.ts !== this.renamingSession?.ts) {
      this.renamingSession = sessRenameReq;
      const currentName = sessRenameReq.currentName ?? "";
      cx.timer.after(1, cx => {
        this.sessionRenameInput.set_value(currentName);
        this.sessionRenameInput.focus();
        cx.notify();
      });
    }
    const bump = shared("wf.sessionsBump");
    if (bump?.ts && bump.ts > this.lastSessionsBump) {
      this.lastSessionsBump = bump.ts;
      if (bump.worktree) this.loadBranchSessions(bump.worktree, cx);
    }
    const ciCfg = shared("wf.ciSettings");
    if (ciCfg?.ts && ciCfg.ts > this.lastCiSettingsTs) {
      this.lastCiSettingsTs = ciCfg.ts;
      cx.timer.after(1, cx => this.refreshOpenPrs(cx));
    }
    const ciBump = shared("wf.ciBump");
    if (ciBump?.ts && ciBump.ts > this.lastCiBumpTs) {
      this.lastCiBumpTs = ciBump.ts;
      cx.timer.after(1, cx => this.refreshOpenPrs(cx));
    }

    const archivedSet = new Set(Array.isArray(shared("wf.archived")) ? shared("wf.archived") : []);
    const filter = this.filterText.trim().toLowerCase();
    const ctx = { activeWorktree, live, allPanes, allSpaces, focusedTerm, filter, archivedSet };
    const treeRows = [];
    for (const r of this.visibleRepos()) treeRows.push(...this.renderRepoSection(t, r, ctx));

    const pill = (id, text, color, active, action) => div().id(id).px(6).h(18).rounded(4).flex().items_center().text_size(10.5).cursor_pointer()
      .bg(active ? color + "38" : color + "1a").border(1).border_color(active ? color : "#00000000").text_color(color)
      .on_click((_e, cx) => action(cx)).child(text);

    const workspaceSection = this.renderWorkspaceSection(t, ctx);

    return v_flex().id("wf-sidebar").track_focus(this.handle).size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .on_mouse_up("left", (_e, cx) => { if (this.drag) this.commitBranchDrop(cx); })
      .on_key_down((e, cx) => { if (e.key === "escape" && this.drag) { this.drag = null; cx.notify(); cx.stop_propagation(); } })
      // Persistent compact paste-an-issue / branch launcher
      .child(this.launcher.render(t))
      // Filter bar
      .child(div().px(8).pb(5)
        .child(Input.new(this.filterInput).h(26).px(8).items_center().rounded(6).border(1).border_color(t.border).bg(t.background).text_color(t.foreground).text_size(11.5)))
      // Optional compact status rollup strip
      .when(totalNeeds > 0 || totalRunning > 0 || Boolean(this.statusFilter), el => el.child(h_flex().px(8).pb(5).gap(5).items_center()
        .when(totalNeeds > 0 || this.statusFilter === "needs", e => e.child(pill("st-needs", `${totalNeeds} needs you`, t.blocked, this.statusFilter === "needs", cx => { this.statusFilter = this.statusFilter === "needs" ? null : "needs"; cx.notify(); })))
        .when(totalRunning > 0 || this.statusFilter === "running", e => e.child(pill("st-run", `${totalRunning} running`, t.working, this.statusFilter === "running", cx => { this.statusFilter = this.statusFilter === "running" ? null : "running"; cx.notify(); })))
        .when(Boolean(this.statusFilter), e => e.child(div().id("st-clear").text_size(10).text_color(t.dim).cursor_pointer().hover(s => s.text_color(t.foreground)).on_click((_e, cx) => { this.statusFilter = null; cx.notify(); }).child("clear")))))
      // Tier 1: Global WORKSPACE section (workspace root, above PROJECTS)
      .when(Boolean(workspaceSection), el => el.child(workspaceSection))
      // PROJECTS header with Manage (show/hide) and + Add repository
      .child(h_flex().h(26).flex_none().px(10).gap(4).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child("PROJECTS"))
        .child(div().id("wf-sb-manage").px(5).h(18).rounded(4).flex().items_center().text_size(10.5).cursor_pointer()
          .bg(this.manage ? t.selected : "#00000000").text_color(this.manage ? t.foreground : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Show, hide or remove repositories")
          .on_click((_e, cx) => { this.manage = !this.manage; cx.notify(); }).child("Manage"))
        .child(div().id("wf-sb-add").size(20).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Add a repository folder")
          .on_click((_e, cx) => this.addRepoFolder(cx))
          .child(svg("mods/workspace-chrome/plus.svg").size(12)))
        .child(div().id("wf-sb-refresh").size(20).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .text_size(11.5).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh all visible repositories")
          .on_click((_e, cx) => this.scanAll(cx, { prs: true })).child("↻")))
      // Inline repo show/hide manager when toggled
      .when(this.manage, el => el.child(this.renderManagePanel(t)))
      // 3-level collapsible tree
      .child(v_flex().id("wf-sb-tree").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(10).children(treeRows)
        .when(!this.visibleRepos().length, el => el.child(div().p(12).text_size(11.5).text_color(t.dim).child("No repositories shown. Click + or Manage above."))));
  }
}
