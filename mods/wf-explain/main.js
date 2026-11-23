// CodeRabbit Explain / Change Stack style local AI review view for Herdr:
//   - Left rail: Overview + dependency-ordered numbered Layers with severity & viewed badges
//   - Overview: 3 KPI cards (Layers, Files changed, Severity findings), Summary, Items to act on
//   - Layer view: Layer header + depends-on pills, file stepper, Split/Unified diff, inline
//     finding cards anchored under exact diff lines, Mark viewed sync, Resolve/Reopen, Send to AI
//   - On-demand + Incremental updates: unchanged files keep cached analysis (0 tokens)
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, TextView } from "gpui-base";
import {
  exec, readTextFile, theme, settings, shared, setShared, spaces, panes, terminals, agents,
  notify, checking, run,
} from "herdr";
import { wf } from "./lib/wf/herdr-adapter.js";
import {
  parseSplitDiff,
  EXPLAIN_ENGINES,
  addExplainLanguage,
  layoutDiagram,
  parseInlineMarkdown,
  summarizeExplain,
  searchExplainReview,
  formatFindingFixPrompt,
  formatQaContinuePrompt,
  formatRelativeAge,
  branchStateHash,
  syntaxPalette,
  tokenizeCodeLine,
  dedentDiffRows,
  isWithin,
  readLabels,
  statusWord,
} from "./lib/wf/index.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const LS_DIFF_STYLE = "wf-diff.style";
const LS_DIFF_WRAP = "wf-diff.wrap";
const LS_RAIL_OPEN = "wf-explain.railOpen";
const LS_RAIL_W = "wf-explain.railWidth";
const LS_VIEWED = "wf-changes.viewed";
const LS_ENGINE = "wf-explain.engine";
const LS_LANG = "wf-explain.lang";
const LS_LANGS = "wf-explain.langs";
const LS_BUG_HUNT_MIN = "wf-explain.bugHuntMin";
const LS_QA_W = "wf-explain.qaWidth";
const BUG_HUNT_PRESETS = [0, 6, 10, 12, 15, 20];
const QUICK_ASK_CHIPS = [
  { id: "user", label: "User impact?", prompt: "In 3 short bullets, what actually changes for end users or admins? Skip internal code names." },
  { id: "prod", label: "Prod risk?", prompt: "Could anything in this branch break production, migrations, or existing data? Verify against the codebase first." },
  { id: "risky", label: "Riskiest code?", prompt: "Which 1-2 spots in this branch are the trickiest or most likely to hide an edge-case bug?" },
  { id: "test", label: "How to test?", prompt: "Give me a short 3-step manual checklist to verify this branch works end to end." },
];

function withAlpha(hex, aa) {
  const s = String(hex || "#888888");
  return (s.length === 9 ? s.slice(0, 7) : s) + aa;
}

function loadJson(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function saveJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function severityMeta(sev, t) {
  if (sev === "critical") return { label: "Critical", col: t.ansi1 || "#ef4444" };
  if (sev === "major") return { label: "Major", col: t.blocked || "#f59e0b" };
  if (sev === "minor") return { label: "Minor", col: t.accent || "#60a5fa" };
  return { label: "Nit", col: t.dim || "#9ca3af" };
}

export default class WorkflowExplain extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.spec = null; // { root, branch, baseRef, baseSha, ts }
    this.lastFocusTs = 0;
    this.pendingFocusTs = 0;

    this.engine = loadJson(LS_ENGINE, "claude");
    if (!EXPLAIN_ENGINES.some(e => e.id === this.engine)) this.engine = "claude";
    const savedLangs = loadJson(LS_LANGS, ["English"]);
    const savedLang = loadJson(LS_LANG, "English");
    const initLang = addExplainLanguage(savedLangs, savedLang);
    this.languages = initLang.list;
    this.language = initLang.selected;
    this.langOpen = false;
    this.langInput = InputState.new({ value: "", placeholder: "Add language (e.g. Dutch, Flemish, French)..." });
    this.langInput.on("submit", (_e, cx) => this.submitNewLanguage(cx));

    const savedBugMin = Number(loadJson(LS_BUG_HUNT_MIN, 12));
    this.bugHuntMinFiles = Number.isFinite(savedBugMin) ? Math.max(0, Math.min(200, Math.floor(savedBugMin))) : 12;
    this.bugHuntOpen = false;
    this.bugHuntInput = InputState.new({ value: "", placeholder: "Custom file threshold..." });
    this.bugHuntInput.on("submit", (_e, cx) => this.submitCustomBugHuntMin(cx));

    this.askScope = null; // { type: "branch"|"layer"|"finding", id, label }
    this.qaOpen = false;
    const savedQaW = Number(loadJson(LS_QA_W, 400));
    this.qaWidth = Number.isFinite(savedQaW) ? Math.max(280, Math.min(620, savedQaW)) : 400;
    this.resizingQa = null;
    this.qaToggled = new Map(); // qaId -> boolean override (newest defaults open, older default collapsed)
    this.askRunning = false;
    this.askLabel = "";
    this.askInput = InputState.new({ value: "", placeholder: "Ask a read-only question (verifies against full repo)..." });
    this.askInput.on("submit", (_e, cx) => this.submitAsk(cx));

    this.searchQuery = "";
    this.searchInput = InputState.new({ value: "", placeholder: "Search concepts, files, risks..." });
    this.searchInput.on("change", (_e, cx) => {
      this.searchQuery = this.searchInput.value() || "";
      cx.notify();
    });

    this.diagramOpen = true;

    this.status = null; // { cached, totalFiles, staleCount, addedCount, modifiedCount, removedCount, baseRef, baseSha, branch }
    this.review = null; // ExplainReview
    this.statusLoading = false;
    this.running = false;
    this.runLabel = "";
    this.error = null;
    this.sendingId = null;
    this.confirmActiveAi = null; // { full: boolean, agentName: string } when warning before run

    // Navigation state
    this.viewMode = "overview"; // "overview" | "layer"
    this.activeLayerId = null;
    this.activeFilePath = null;
    this.highlightFindingId = null;
    this.showResolved = false;
    this.expandedFindings = new Set();

    // Diff viewer state for active file in Layer view
    this.style = loadJson(LS_DIFF_STYLE, "unified") === "split" ? "split" : "unified";
    this.wrapLines = loadJson(LS_DIFF_WRAP, true) !== false;
    this.railOpen = loadJson(LS_RAIL_OPEN, true) !== false;
    const savedW = Number(loadJson(LS_RAIL_W, 196));
    this.railWidth = Number.isFinite(savedW) ? Math.max(140, Math.min(420, savedW)) : 196;
    this.resizingRail = null;
    this.diffLoading = false;
    this.diffError = null;
    this.diffFileKey = "";
    this.splitRows = [];
    this.unifiedRows = [];
    this.splitMinW = 900;
    this.uniMinW = 600;
    this.diffVisibleLimit = 220;
    this.contextLines = 3;

    if (checking()) return;
    cx.timer.every(1500, cx => {
      if ((this.running || this.askRunning) && this.spec?.root) this.pollJobStatus(cx);
    });
    const focus = shared("wf.explainFocus");
    if (focus?.root) {
      this.applyFocus(focus, cx);
    } else {
      const picked = shared("wf.branch");
      if (picked?.path) {
        this.applyFocus({ root: picked.path, branch: picked.branch || null, baseRef: null, ts: Date.now() }, cx);
      }
    }
  }

  applyFocus(focus, cx) {
    if (!focus?.root) return;
    this.lastFocusTs = focus.ts || Date.now();
    const changedRoot = !this.spec || this.spec.root !== focus.root || this.spec.branch !== focus.branch;
    this.spec = {
      root: focus.root,
      branch: focus.branch || null,
      baseRef: focus.baseRef || null,
      baseSha: focus.baseSha || null,
      ts: this.lastFocusTs,
    };
    if (changedRoot) {
      this.status = null;
      this.review = null;
      this.error = null;
      this.viewMode = "overview";
      this.activeLayerId = null;
      this.activeFilePath = null;
      this.highlightFindingId = null;
      this.diffFileKey = "";
      this.splitRows = [];
      this.unifiedRows = [];
    }
    this.loadStatus(cx, { autoRunIfEmpty: Boolean(focus.autoRun) });
  }

  loadStatus(cx, { autoRunIfEmpty = false } = {}) {
    const s = this.spec;
    if (!s?.root || this.statusLoading) return;
    this.statusLoading = true;
    this.error = null;
    const seq = Date.now();
    this.statusSeq = seq;
    cx.notify();

    cx.spawn(async cx => {
      try {
        const args = ["explain", "--worktree", s.root, "--status"];
        if (s.baseRef) args.push("--base", s.baseRef);
        const res = await wf(args);
        if (this.statusSeq !== seq) return;
        if (res?.error) throw new Error(res.error);
        this.status = res;
        if (res.branch) this.spec.branch = res.branch;
        if (res.baseRef) this.spec.baseRef = res.baseRef;
        if (res.baseSha) this.spec.baseSha = res.baseSha;
        if (res.review) this.review = res.review;
        if (res.job?.state === "running") {
          this.running = true;
          this.runStartedAt = res.job.startedAt || Date.now();
          this.runLabel = this.formatRunningLabel(res.job);
        }
        if (res.askJob?.state === "running") {
          this.askRunning = true;
          this.askLabel = `Answering "${String(res.askJob.question || "").slice(0, 48)}"... (${res.askJob.elapsedSec || 0}s)`;
        }
        this.statusLoading = false;
        cx.notify();
        if (autoRunIfEmpty && !this.review && (res.totalFiles || 0) > 0 && !this.running) {
          this.triggerExplain(cx, { full: false });
        }
      } catch (e) {
        if (this.statusSeq === seq) {
          this.error = String(e?.message ?? e);
          this.statusLoading = false;
          cx.notify();
        }
      }
    });
  }

  formatRunningLabel(job) {
    const eng = job?.engine || this.engine;
    const sec = job?.elapsedSec ?? Math.max(0, Math.floor((Date.now() - (this.runStartedAt || Date.now())) / 1000));
    if (job?.phase === "bug-hunt") {
      const bf = job.bugHuntFiles || 0;
      const sk = job.bugHuntSkipped || 0;
      return `Pass 2 bug-hunt on ${bf} prod ${bf === 1 ? "file" : "files"}${sk > 0 ? ` (${sk} test/doc skipped)` : ""} via ${eng}... (${sec}s)`;
    }
    const n = job?.targetFiles || this.status?.totalFiles || 0;
    const verb = job?.mode === "incremental" ? "Updating" : "Analyzing";
    return `${verb} ${n || "branch"} ${n === 1 ? "file" : "files"} via ${eng}... (${sec}s)`;
  }

  pollJobStatus(cx) {
    const s = this.spec;
    if (!s?.root || this.pollingJob) return;
    this.pollingJob = true;
    cx.spawn(async cx => {
      try {
        const args = ["explain", "--worktree", s.root, "--status"];
        if (s.baseRef) args.push("--base", s.baseRef);
        const res = await wf(args);
        if (!res || res.error) return;
        this.status = res;
        if (res.review) this.review = res.review;
        if (this.running) {
          const job = res.job;
          if (job?.state === "running") {
            this.runLabel = this.formatRunningLabel(job);
          } else if (job?.state === "done") {
            this.running = false;
            this.runLabel = "";
            setShared("wf.explainSaved", { root: s.root, ts: Date.now() });
            const secs = job.durationMs ? ` (${(job.durationMs / 1000).toFixed(1)}s)` : "";
            const msg = job.mode === "incremental"
              ? `Updated ${job.analyzedFiles} changed, reused ${job.reusedFiles} cached${secs}`
              : job.mode === "cached"
              ? "Review is already up to date"
              : `Analyzed ${job.analyzedFiles ?? this.status.totalFiles} files${secs}`;
            notify({ title: "AI Explain ready", body: msg, level: "success", timeout: 2600 });
            if (this.viewMode === "layer" && this.activeFilePath) {
              this.diffFileKey = "";
              this.loadActiveFileDiff(cx);
            }
          } else if (job?.state === "cancelled") {
            this.running = false;
            this.runLabel = "";
          } else if (job?.state === "error") {
            this.running = false;
            this.runLabel = "";
            this.error = job.error || "AI Explain worker failed";
            notify({ title: "AI Explain failed", body: this.error.slice(0, 140), level: "error", timeout: 4500 });
          }
        }
        if (this.askRunning) {
          const aj = res.askJob;
          if (aj?.state === "running") {
            this.askLabel = `Answering "${String(aj.question || "").slice(0, 48)}"... (${aj.elapsedSec || 0}s)`;
          } else if (aj?.state === "done") {
            this.askRunning = false;
            this.askLabel = "";
            notify({ title: "Question answered", body: String(aj.question || "").slice(0, 80), level: "success", timeout: 2200 });
          } else if (aj?.state === "error") {
            this.askRunning = false;
            this.askLabel = "";
            this.error = aj.error || "Follow-up question failed";
            notify({ title: "Ask failed", body: this.error.slice(0, 140), level: "error", timeout: 3500 });
          }
        }
        cx.notify();
      } finally {
        this.pollingJob = false;
      }
    });
  }

  cancelExplain(cx) {
    const s = this.spec;
    if (!s?.root || !this.running) return;
    this.running = false;
    this.runLabel = "";
    cx.notify();
    cx.spawn(async cx => {
      const args = ["explain", "--worktree", s.root, "--cancel"];
      if (s.baseRef) args.push("--base", s.baseRef);
      await wf(args).catch(() => null);
      notify({ title: "AI Explain cancelled", body: "Kept previous cached review", level: "info", timeout: 2200 });
      cx.notify();
    });
  }

  findWorkingAiOnBranch(root) {
    if (!root) return null;
    const workingAddrs = new Set(
      (agents() ?? []).filter(a => statusWord(a.status) === "working" && a.terminal).map(a => a.terminal)
    );
    for (const term of terminals() ?? []) {
      if (term.state && term.state !== "live") continue;
      const addr = term.address || term.id;
      const isWorking = workingAddrs.has(addr) || statusWord(term.status) === "working";
      if (!isWorking) continue;
      const lblWt = readLabels(term.labels)?.worktree;
      if ((lblWt && lblWt === root) || (term.cwd && isWithin(term.cwd, root))) {
        return term.program?.name || "AI agent";
      }
    }
    return null;
  }

  triggerExplain(cx, { full = false, force = false } = {}) {
    const s = this.spec;
    if (!s?.root || this.running) return;
    if (!force) {
      const activeName = this.findWorkingAiOnBranch(s.root);
      if (activeName) {
        this.confirmActiveAi = { full, agentName: activeName };
        cx.notify();
        return;
      }
    }
    this.confirmActiveAi = null;
    this.running = true;
    this.runStartedAt = Date.now();
    this.error = null;
    const isInc = Boolean(!full && this.review && (this.status?.unchangedCount || 0) > 0);
    const n = isInc ? (this.status?.addedCount || 0) + (this.status?.modifiedCount || 0) : (this.status?.totalFiles || 0);
    this.runLabel = this.formatRunningLabel({ mode: isInc ? "incremental" : "full", targetFiles: n, engine: this.engine, elapsedSec: 0 });
    cx.notify();

    cx.spawn(async cx => {
      try {
        const args = [
          "explain", "--worktree", s.root, "--engine", this.engine, "--lang", this.language,
          "--bug-hunt-min", String(this.bugHuntMinFiles), "--bg",
        ];
        if (s.baseRef) args.push("--base", s.baseRef);
        if (full) args.push("--full");
        const res = await wf(args);
        if (res?.error) throw new Error(res.error);
        if (res?.job) this.runLabel = this.formatRunningLabel(res.job);
      } catch (e) {
        this.running = false;
        this.runLabel = "";
        this.error = String(e?.message ?? e);
        notify({ title: "AI Explain failed", body: this.error.slice(0, 140), level: "error", timeout: 4500 });
      } finally {
        cx.notify();
      }
    });
  }

  toggleResolve(findingId, resolved, cx) {
    const s = this.spec;
    if (!s?.root || !this.review || !findingId) return;
    // Optimistic UI update
    const cur = new Set(this.review.resolvedIds || []);
    if (resolved) cur.delete(findingId);
    else cur.add(findingId);
    this.review = { ...this.review, resolvedIds: [...cur] };
    cx.notify();

    cx.spawn(async cx => {
      const args = ["explain", "--worktree", s.root, "--resolve", findingId];
      if (s.baseRef) args.push("--base", s.baseRef);
      if (resolved) args.push("--unresolve");
      const res = await wf(args).catch(() => null);
      if (res?.review) {
        this.review = res.review;
        cx.notify();
      }
    });
  }

  sendFindingToAi(finding, cx) {
    if (!finding || !this.spec?.root || this.sendingId) return;
    this.sendingId = finding.id;
    cx.notify();
    const prompt = formatFindingFixPrompt(finding);

    cx.spawn(async cx => {
      try {
        const list = await wf(["list", "--all"]);
        const tasks = Array.isArray(list?.tasks) ? list.tasks : [];
        const live = tasks.filter(tk => (tk.state === "live" || tk.running) && tk.terminal);
        const match = live.find(tk => tk.worktree === this.spec.root)
          || (this.spec.branch ? live.find(tk => tk.branch === this.spec.branch) : null);
        if (!match?.terminal) {
          notify({
            title: "No running AI session for this branch",
            body: "Start a Claude/Codex session on this branch first, then click Check & fix.",
            level: "warn",
            timeout: 3500,
          });
          return;
        }
        const res = await wf(["send", "--terminal", match.terminal, "--wait", "5", "--force", "--prompt", prompt]);
        if (res?.error) throw new Error(res.error);
        notify({ title: "Sent finding to AI session", body: `${finding.file}:${finding.lineStart}`, level: "success", timeout: 2200 });
      } catch (e) {
        notify({ title: "Could not send to AI", body: String(e?.message ?? e), level: "error", timeout: 3500 });
      } finally {
        this.sendingId = null;
        cx.notify();
      }
    });
  }

  isQaOutdated(item) {
    const curHash = this.status?.branchHash || branchStateHash(this.review?.files);
    return Boolean(item?.branchHash && curHash && item.branchHash !== curHash);
  }

  continueQaInAi(item, cx) {
    if (!item || !this.spec?.root || this.sendingId) return;
    this.sendingId = item.id;
    cx.notify();
    const prompt = formatQaContinuePrompt(item, { outdated: this.isQaOutdated(item) });

    cx.spawn(async cx => {
      try {
        const list = await wf(["list", "--all"]);
        const tasks = Array.isArray(list?.tasks) ? list.tasks : [];
        const live = tasks.filter(tk => (tk.state === "live" || tk.running) && tk.terminal);
        const match = live.find(tk => tk.worktree === this.spec.root)
          || (this.spec.branch ? live.find(tk => tk.branch === this.spec.branch) : null);
        if (!match?.terminal) {
          notify({
            title: "No running AI session for this branch",
            body: "Start a Claude/Codex session on this branch first, then click Continue in AI.",
            level: "warn",
            timeout: 3500,
          });
          return;
        }
        const res = await wf(["send", "--terminal", match.terminal, "--wait", "5", "--force", "--prompt", prompt]);
        if (res?.error) throw new Error(res.error);
        notify({ title: "Continued in main AI", body: String(item.question || "").slice(0, 70), level: "success", timeout: 2200 });
        const targetPane = (panes() ?? []).find(p => p.terminal === match.terminal);
        if (targetPane?.tab) run("tab.select", { id: targetPane.tab });
      } catch (e) {
        notify({ title: "Could not send to AI", body: String(e?.message ?? e), level: "error", timeout: 3500 });
      } finally {
        this.sendingId = null;
        cx.notify();
      }
    });
  }

  cycleEngine(cx) {
    const idx = EXPLAIN_ENGINES.findIndex(e => e.id === this.engine);
    this.engine = EXPLAIN_ENGINES[(idx + 1) % EXPLAIN_ENGINES.length].id;
    saveJson(LS_ENGINE, this.engine);
    cx.notify();
  }

  selectLanguage(lang, cx) {
    const res = addExplainLanguage(this.languages, lang);
    this.languages = res.list;
    this.language = res.selected;
    this.langOpen = false;
    saveJson(LS_LANGS, this.languages);
    saveJson(LS_LANG, this.language);
    cx.notify();
  }

  submitNewLanguage(cx) {
    const raw = (this.langInput?.value?.() || "").trim();
    if (!raw) return;
    this.langInput.set_value("");
    this.selectLanguage(raw, cx);
  }

  selectBugHuntMin(n, cx) {
    const v = Math.max(0, Math.min(200, Math.floor(Number(n) || 0)));
    this.bugHuntMinFiles = v;
    this.bugHuntOpen = false;
    saveJson(LS_BUG_HUNT_MIN, v);
    cx.notify();
  }

  submitCustomBugHuntMin(cx) {
    const raw = (this.bugHuntInput?.value?.() || "").trim();
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    this.bugHuntInput.set_value("");
    this.selectBugHuntMin(n, cx);
  }

  openAsk(scope, cx) {
    this.askScope = scope || { type: "branch", id: "", label: this.spec?.branch || "this branch" };
    this.qaOpen = true;
    this.langOpen = false;
    this.bugHuntOpen = false;
    cx.notify();
    if (this.askInput?.focus) {
      cx.timer.after(10, () => { try { this.askInput.focus(); } catch {} });
    }
  }

  dismissQa(qaId, cx) {
    const s = this.spec;
    if (!s?.root || !this.review || !qaId) return;
    this.review = { ...this.review, qa: (this.review.qa || []).filter(q => q.id !== qaId) };
    cx.notify();
    cx.spawn(async cx => {
      const args = ["explain", "--worktree", s.root, "--delete-qa", qaId];
      if (s.baseRef) args.push("--base", s.baseRef);
      const res = await wf(args).catch(() => null);
      if (res?.review) { this.review = res.review; cx.notify(); }
    });
  }

  clearOutdatedQa(cx) {
    const s = this.spec;
    if (!s?.root || !this.review) return;
    this.review = { ...this.review, qa: (this.review.qa || []).filter(q => !this.isQaOutdated(q)) };
    cx.notify();
    cx.spawn(async cx => {
      const args = ["explain", "--worktree", s.root, "--clear-outdated-qa"];
      if (s.baseRef) args.push("--base", s.baseRef);
      const res = await wf(args).catch(() => null);
      if (res?.review) { this.review = res.review; cx.notify(); }
    });
  }

  clearAllQa(cx) {
    const s = this.spec;
    if (!s?.root || !this.review) return;
    this.review = { ...this.review, qa: [] };
    cx.notify();
    cx.spawn(async cx => {
      const args = ["explain", "--worktree", s.root, "--clear-qa"];
      if (s.baseRef) args.push("--base", s.baseRef);
      const res = await wf(args).catch(() => null);
      if (res?.review) { this.review = res.review; cx.notify(); }
    });
  }

  submitAsk(cx, customQuestion = null) {
    const s = this.spec;
    const q = (customQuestion !== null ? String(customQuestion) : (this.askInput?.value?.() || "")).trim();
    if (!s?.root || !q || this.askRunning) return;
    const scope = this.askScope || { type: "branch", id: "", label: s.branch || "this branch" };
    if (customQuestion === null) this.askInput.set_value("");
    this.qaOpen = true;
    this.askRunning = true;
    this.askLabel = `Answering "${q.slice(0, 48)}"... (0s)`;
    this.error = null;
    cx.notify();

    cx.spawn(async cx => {
      try {
        const args = [
          "explain", "--worktree", s.root, "--engine", this.engine, "--lang", this.language,
          "--ask", q, "--scope-type", scope.type, "--scope-id", scope.id || "", "--scope-label", scope.label || "",
          "--bg",
        ];
        if (s.baseRef) args.push("--base", s.baseRef);
        const res = await wf(args);
        if (res?.error) throw new Error(res.error);
      } catch (e) {
        this.askRunning = false;
        this.askLabel = "";
        this.error = String(e?.message ?? e);
        notify({ title: "Ask failed", body: this.error.slice(0, 140), level: "error", timeout: 3500 });
      } finally {
        cx.notify();
      }
    });
  }

  // ------------------------------------------------------------------ navigation & viewed sync

  openOverview(cx) {
    this.viewMode = "overview";
    this.highlightFindingId = null;
    cx.notify();
  }

  openLayer(layerId, cx, { filePath = null, findingId = null } = {}) {
    const layer = (this.review?.layers || []).find(l => l.id === layerId);
    if (!layer) return;
    this.viewMode = "layer";
    this.activeLayerId = layer.id;
    this.highlightFindingId = findingId || null;
    const desired = filePath && layer.files.some(f => f.path === filePath)
      ? filePath
      : layer.files[0]?.path || null;
    this.selectLayerFile(desired, cx);
  }

  jumpToFinding(finding, cx) {
    if (!finding || !this.review) return;
    const layer = (this.review.layers || []).find(l => (l.files || []).some(f => f.path === finding.file));
    if (layer) {
      this.openLayer(layer.id, cx, { filePath: finding.file, findingId: finding.id });
    }
  }

  selectLayerFile(path, cx) {
    this.activeFilePath = path;
    this.contextLines = 3;
    this.diffVisibleLimit = 220;
    this.loadActiveFileDiff(cx);
    cx.notify();
  }

  stepLayerFile(delta, cx) {
    const layer = (this.review?.layers || []).find(l => l.id === this.activeLayerId);
    const files = layer?.files || [];
    if (files.length < 2) return;
    const idx = Math.max(0, files.findIndex(f => f.path === this.activeFilePath));
    const next = files[(idx + delta + files.length) % files.length];
    if (next) this.selectLayerFile(next.path, cx);
  }

  fileFp(path) {
    const meta = this.review?.files?.[path];
    if (!meta) return "";
    if (meta.status === "?") return `?:${path}`;
    return `${meta.status || "M"}:${meta.added || 0}:${meta.removed || 0}`;
  }

  isFileViewed(path) {
    const root = this.spec?.root;
    const fp = this.fileFp(path);
    if (!root || !path || !fp) return false;
    const map = shared("wf.fileViewed") ?? loadJson(LS_VIEWED, {});
    return map?.[root]?.[path] === fp;
  }

  toggleFileViewed(path, cx, { advance = false } = {}) {
    const root = this.spec?.root;
    const fp = this.fileFp(path);
    if (!root || !path || !fp) return;
    const was = this.isFileViewed(path);
    const prev = shared("wf.fileViewed") ?? loadJson(LS_VIEWED, {});
    const cur = { ...(prev[root] ?? {}) };
    if (!was) cur[path] = fp;
    else delete cur[path];
    const next = { ...prev, [root]: cur };
    setShared("wf.fileViewed", next);
    saveJson(LS_VIEWED, next);
    setShared("wf.gitAction", {
      type: "toggle-viewed",
      root,
      isDir: false,
      rel: path,
      fp,
      files: [{ path, fp }],
      mark: !was,
      ts: Date.now(),
    });
    if (advance && !was) this.stepLayerFile(1, cx);
    cx.notify();
  }

  prepareDiffRows(parsed, path) {
    const split = dedentDiffRows(parsed.split || [], "split");
    const unified = dedentDiffRows(parsed.unified || [], "unified");
    let maxS = 60;
    for (const r of split) {
      if (r.kind === "gap" || r.kind === "note") continue;
      if (r.left) {
        r.left.toks = tokenizeCodeLine(r.left.text ?? "", path);
        if ((r.left.text || "").length > maxS) maxS = r.left.text.length;
      }
      if (r.right) {
        r.right.toks = tokenizeCodeLine(r.right.text ?? "", path);
        if ((r.right.text || "").length > maxS) maxS = r.right.text.length;
      }
    }
    let maxU = 60;
    for (const r of unified) {
      if (r.kind === "gap" || r.kind === "note") continue;
      r.toks = tokenizeCodeLine(r.text ?? "", path);
      if ((r.text || "").length > maxU) maxU = r.text.length;
    }
    this.splitRows = split;
    this.unifiedRows = unified;
    this.splitMinW = Math.round(maxS * 7.2 + 64) * 2;
    this.uniMinW = Math.round(maxU * 7.2 + 100);
  }

  loadActiveFileDiff(cx) {
    const root = this.spec?.root;
    const path = this.activeFilePath;
    const baseSha = this.review?.baseSha || this.spec?.baseSha;
    if (!root || !path) return;
    const key = `${root}|${baseSha}|${path}|${this.contextLines}`;
    if (this.diffFileKey === key && !this.diffError) return;
    this.diffFileKey = key;
    this.diffLoading = true;
    this.diffError = null;
    const seq = Date.now();
    this.diffSeq = seq;

    cx.spawn(async cx => {
      try {
        const fileMeta = this.review?.files?.[path];
        if (fileMeta?.binary) {
          this.splitRows = [{ kind: "note", text: "Binary file (no text diff)" }];
          this.unifiedRows = [{ kind: "note", text: "Binary file (no text diff)" }];
          return;
        }
        if (fileMeta?.status === "?") {
          const text = await readTextFile(`${root}/${path}`).catch(() => null);
          if (this.diffSeq !== seq) return;
          const lines = (text || "").replace(/\n$/, "").split("\n").slice(0, 2000);
          const synthetic = `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
          this.prepareDiffRows(parseSplitDiff(synthetic), path);
          return;
        }
        const args = baseSha
          ? ["diff", baseSha, `-U${this.contextLines}`, "--no-ext-diff", "--no-textconv", "--no-color", "--", path]
          : ["diff", "HEAD", `-U${this.contextLines}`, "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
        const r = await exec("git", [...READ, ...args], { cwd: root });
        if (this.diffSeq !== seq) return;
        if (r.code !== 0) throw new Error((r.stderr || "git diff failed").trim());
        this.prepareDiffRows(parseSplitDiff(r.stdout), path);
      } catch (e) {
        if (this.diffSeq === seq) this.diffError = String(e?.message ?? e);
      } finally {
        if (this.diffSeq === seq) this.diffLoading = false;
        cx.notify();
      }
    });
  }

  // ------------------------------------------------------------------ rendering

  renderFindingCard(f, t, { compact = false, showJump = false } = {}) {
    const sev = severityMeta(f.severity, t);
    const resolved = Boolean((this.review?.resolvedIds || []).includes(f.id));
    const highlighted = this.highlightFindingId === f.id;
    const expanded = compact || this.expandedFindings.has(f.id);
    const hasDetails = Boolean(f.body || f.suggestion);
    const shortFile = String(f.file || "").split("/").pop() || f.file;
    const loc = f.lineEnd && f.lineEnd !== f.lineStart
      ? `L${f.lineStart}-${f.lineEnd}`
      : `L${f.lineStart || 1}`;
    const sending = this.sendingId === f.id;
    const summaryLine = f.impact || (!expanded && f.body ? f.body.split(/(?<=[.!?])\s+/)[0] : "");

    return v_flex().id(`ex-find-${compact ? "in" : "ov"}-${f.id}`).w_full().min_w(0).flex_none()
      .p(13).gap(8).rounded(9).bg(t.raised + "99")
      .border(1).border_color(highlighted ? t.accent : (resolved ? t.border : withAlpha(sev.col, "44")))
      .when(resolved, el => el.opacity(0.62))
      // Line 1: Severity dot + bold plain-English headline + file badge
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(div().size(8).flex_none().rounded_full().bg(sev.col))
        .child(div().flex_1().min_w(0).text_size(12.5).font_semibold().text_color(t.foreground).whitespace_normal().child(f.title))
        .child(div().flex_none().px(6).h(18).rounded(4).bg(withAlpha(sev.col, "1e")).text_size(10).font_semibold().text_color(sev.col).flex().items_center().child(sev.label)))
      // Line 2: One crisp consequence line (calm, scannable, selectable)
      .when(Boolean(summaryLine), el => el.child(div().w_full().min_w(0).pl(16).child(this.renderRichText(summaryLine, t, { id: `ex-fs-${compact ? "in" : "ov"}-${f.id}`, size: 11.8, color: t.muted }))))
      // Line 3: Expanded "Why & fix" (progressive disclosure - hidden by default on Overview)
      .when(expanded && Boolean(f.body && f.body !== summaryLine), el => el
        .child(div().w_full().min_w(0).pl(16).pt(2).child(this.renderRichText(f.body, t, { id: `ex-fb-${compact ? "in" : "ov"}-${f.id}`, size: 11.5, color: t.muted }))))
      .when(expanded && Boolean(f.suggestion), el => el
        .child(div().w_full().min_w(0).ml(16).p(9).rounded(6).bg(t.background).border(1).border_color(t.border)
          .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.foreground).whitespace_normal()
          .child(f.suggestion)))
      // Line 4: Quiet location + crisp action buttons
      .child(h_flex().w_full().min_w(0).pl(16).pt(2).gap(6).items_center().flex_wrap()
        .child(div().min_w(0).truncate().text_size(10.8).text_color(t.dim).tooltip(`${f.file} · ${loc}`).child(`${shortFile} · ${loc}`))
        .child(div().flex_1())
        .when(!compact && hasDetails, el => el.child(div().id(`ex-det-${f.id}`).px(7).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer().flex_none()
          .bg(t.background).border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            if (this.expandedFindings.has(f.id)) this.expandedFindings.delete(f.id);
            else this.expandedFindings.add(f.id);
            cx.notify();
          })
          .child(expanded ? "Less ▴" : "Why? ▾")))
        .when(showJump, el => el.child(div().id(`ex-jmp-${f.id}`).px(8).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer().flex_none()
          .bg(t.background).border(1).border_color(t.border).text_color(t.foreground).hover(s => s.bg(t.hover).border_color(t.accent))
          .on_click((_e, cx) => this.jumpToFinding(f, cx))
          .child("Open diff")))
        .child(div().id(`ex-ask-f-${compact ? "in" : "ov"}-${f.id}`).px(7).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer().flex_none()
          .bg(t.background).border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Ask a read-only follow-up question about this finding")
          .on_click((_e, cx) => this.openAsk({ type: "finding", id: f.id, label: f.title }, cx))
          .child("Ask"))
        .child(div().id(`ex-ai-${compact ? "in" : "ov"}-${f.id}`).px(8).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer().flex_none()
          .bg(withAlpha(t.accent, "20")).border(1).border_color(withAlpha(t.accent, "55")).text_color(t.accent)
          .hover(s => s.bg(withAlpha(t.accent, "33")))
          .tooltip("Ask your running AI session on this branch to verify this finding and fix it if it is a real bug")
          .on_click((_e, cx) => this.sendFindingToAi(f, cx))
          .child(sending ? "Sending..." : "Check & fix"))
        .child(div().id(`ex-res-${compact ? "in" : "ov"}-${f.id}`).px(8).h(22).rounded(5).flex().items_center().gap(4).text_size(10.8).cursor_pointer().flex_none()
          .bg(t.background).border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.toggleResolve(f.id, resolved, cx))
          .child(svg("mods/workspace-chrome/check.svg").size(11).text_color(resolved ? t.ansi2 : t.dim))
          .child(resolved ? "Reopen" : "Done")));
  }

  // Renders native selectable Markdown via GPUI TextView (supports **bold**, `inline code`, bullets, and mouse copy).
  renderRichText(text, t, { id = "rt", size = 11.8, color = t.muted } = {}) {
    const s = String(text || "").trim();
    if (!s) return div();
    return div().w_full().min_w(0).text_size(size).text_color(color)
      .child(TextView.markdown(id, s).selectable(true));
  }

  // GitHub permalink-style syntax-highlighted code snippet card hydrated from the real file on disk.
  renderSnippetCard(snip, t, keyPrefix) {
    const rawLines = Array.isArray(snip?.lines) ? snip.lines : [];
    if (!rawLines.length) return div();
    const pal = syntaxPalette(t);
    const mono = settings().font_family ?? "JetBrains Mono";
    const loc = snip.lineEnd && snip.lineEnd !== snip.lineStart ? `L${snip.lineStart}-L${snip.lineEnd}` : `L${snip.lineStart || 1}`;
    // Trim common leading indentation so deeply nested methods stay compact and readable
    let minIndent = Infinity;
    for (const l of rawLines) {
      if (String(l.text || "").trim().length === 0) continue;
      const m = /^([ \t]*)/.exec(l.text || "");
      minIndent = Math.min(minIndent, m ? m[1].length : 0);
    }
    const trim = Number.isFinite(minIndent) ? minIndent : 0;
    const rawCopy = `${snip.file}#${loc}\n${rawLines.map(l => l.text ?? "").join("\n")}`;

    return v_flex().id(`ex-snip-${keyPrefix}`).w_full().min_w(0).rounded(7).overflow_hidden()
      .bg(t.background).border(1).border_color(t.border)
      // Permalink header with Copy button
      .child(h_flex().w_full().min_w(0).px(10).py(5).gap(8).items_center().bg(t.raised + "88").border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(10.5).text_color(t.accent).tooltip(`${snip.file}#${loc}`).child(`${snip.file}#${loc}`))
        .when(Boolean(snip.caption), el => el.child(div().flex_none().max_w(220).truncate().text_size(10.5).text_color(t.dim).tooltip(snip.caption).child(snip.caption)))
        .child(div().id(`ex-sncp-${keyPrefix}`).px(6).h(18).rounded(4).flex().items_center().text_size(9.8).cursor_pointer().flex_none()
          .bg(t.background).border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.write_to_clipboard(rawCopy);
            notify({ title: "Copied snippet", body: `${snip.file}#${loc}`, level: "info", timeout: 1600 });
          })
          .child("Copy")))
      // Syntax-highlighted code lines
      .child(v_flex().w_full().min_w(0).py(5).font_family(mono).text_size(11)
        .children(rawLines.map((l, idx) => {
          const codeText = trim > 0 ? String(l.text || "").slice(trim) : String(l.text || "");
          const toks = tokenizeCodeLine(codeText, snip.file || "");
          return h_flex().id(`ex-snl-${keyPrefix}-${idx}`).w_full().min_w(0).px(8).py(1).gap(8).items_start()
            .child(div().w(30).flex_none().text_right().text_size(10).text_color(t.dim).opacity(0.65).child(String(l.num ?? "")))
            .child(h_flex().flex_1().min_w(0).flex_wrap().items_center().overflow_hidden()
              .children(toks.length
                ? toks.map(tok => div().max_w_full().min_w(0).whitespace_normal().text_color(pal[tok.kind] || pal.plain).child(tok.text))
                : [div().child(" ")]));
        })));
  }

  renderQaList(t, items) {
    if (!items.length) return div();
    // Show newest first; newest is expanded by default, older questions start collapsed and expand on click.
    const ordered = [...items].reverse();
    return v_flex().w_full().min_w(0).gap(8)
      .children(ordered.map((item, idx) => {
        const isOpen = this.qaToggled.has(item.id) ? this.qaToggled.get(item.id) : idx === 0;
        const outdated = this.isQaOutdated(item);
        const tldr = item.tldr || item.answer || "";
        const bullets = Array.isArray(item.bullets) ? item.bullets : [];
        const snippets = Array.isArray(item.snippets) ? item.snippets : [];
        const sending = this.sendingId === item.id;
        const mdLines = [];
        if (tldr) mdLines.push(tldr);
        if (bullets.length) {
          if (mdLines.length) mdLines.push("");
          for (const b of bullets) mdLines.push(`- ${b}`);
        }
        const combinedMd = mdLines.join("\n");
        const scopeTag = item.scopeType === "finding"
          ? `Card${item.scopeLabel ? `: ${item.scopeLabel}` : ""}`
          : item.scopeType === "layer"
          ? `Layer${item.scopeLabel ? `: ${item.scopeLabel}` : ""}`
          : "Branch";

        return v_flex().id(`ex-qa-${item.id}`).w_full().min_w(0).p(10).gap(8).rounded(8)
          .bg(t.background).border(1).border_color(isOpen ? withAlpha(t.accent, "44") : t.border)
          // Clickable header row (chevron + Q badge + question + time + dismiss X)
          .child(h_flex().id(`ex-qah-${item.id}`).w_full().min_w(0).gap(6).items_center().cursor_pointer()
            .on_click((_e, cx) => { this.qaToggled.set(item.id, !isOpen); cx.notify(); })
            .child(svg(`mods/workspace-chrome/chevron-${isOpen ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
            .child(div().px(5).h(16).rounded(4).bg(withAlpha(t.accent, "22")).text_size(9.5).font_semibold().text_color(t.accent).flex().items_center().flex_none().child("Q"))
            .child(div().flex_1().min_w(0).text_size(11.6).font_semibold().text_color(t.foreground)
              .when(!isOpen, e => e.truncate())
              .when(isOpen, e => e.whitespace_normal())
              .child(String(item.question || "")))
            .when(outdated, el => el.child(div().px(5).h(15).rounded(3).bg(withAlpha(t.blocked, "22")).text_size(9).font_semibold().text_color(t.blocked).flex().items_center().flex_none().tooltip("Files changed since this answer was generated").child("outdated")))
            .when(Boolean(item.createdAt), el => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(formatRelativeAge(item.createdAt))))
            .child(div().id(`ex-qadel-${item.id}`).size(18).rounded(4).flex().items_center().justify_center().cursor_pointer().flex_none()
              .hover(s => s.bg(withAlpha(t.ansi1, "22")))
              .tooltip("Dismiss this question")
              .on_click((e, cx) => { cx.stop_propagation(); this.dismissQa(item.id, cx); })
              .child(svg("mods/workspace-chrome/x.svg").size(10).text_color(t.dim))))
          // Collapsible body
          .when(isOpen, el => el
            // Scope pill
            .child(h_flex().w_full().min_w(0).pl(16).gap(6).items_center()
              .child(div().px(6).h(16).rounded(4).bg(t.raised).border(1).border_color(t.border).max_w_full().truncate().text_size(9.5).text_color(t.dim).flex().items_center().child(scopeTag)))
            // Selectable formatted Markdown body (TL;DR + scannable bullets)
            .when(Boolean(combinedMd), e => e.child(div().w_full().min_w(0).pl(16)
              .child(this.renderRichText(combinedMd, t, { id: `ex-qam-${item.id}`, size: 11.6, color: t.foreground }))))
            // Embedded GitHub permalink-style code snippets
            .when(snippets.length > 0, e => e.child(v_flex().w_full().min_w(0).pl(16).pt(2).gap(6)
              .children(snippets.map((sn, si) => this.renderSnippetCard(sn, t, `${item.id}-${si}`)))))
            // Action footer: Copy + Continue in main AI
            .child(h_flex().w_full().min_w(0).pl(16).pt(2).gap(6).items_center().justify_end()
              .child(div().id(`ex-qacp-${item.id}`).px(7).h(22).rounded(5).flex().items_center().text_size(10.5).cursor_pointer().flex_none()
                .bg(t.raised).border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  cx.write_to_clipboard(combinedMd || tldr);
                  notify({ title: "Copied answer", body: String(item.question || "").slice(0, 60), level: "info", timeout: 1500 });
                })
                .child("Copy"))
              .child(div().id(`ex-qacont-${item.id}`).px(8).h(22).rounded(5).flex().items_center().text_size(10.5).font_medium().cursor_pointer().flex_none()
                .bg(withAlpha(t.accent, "20")).border(1).border_color(withAlpha(t.accent, "55")).text_color(t.accent)
                .hover(s => s.bg(withAlpha(t.accent, "33")))
                .tooltip("Send this Q&A context to your running main AI session and switch to it")
                .on_click((_e, cx) => this.continueQaInAi(item, cx))
                .child(sending ? "Sending..." : "Continue in AI"))));
      }));
  }

  renderQaDrawer(t) {
    const qaItems = Array.isArray(this.review?.qa) ? this.review.qa : [];
    const outdatedCount = qaItems.filter(q => this.isQaOutdated(q)).length;
    const scope = this.askScope || { type: "branch", id: "", label: this.spec?.branch || "this branch" };
    const scopeBadge = scope.type === "finding"
      ? `Card: ${scope.label || ""}`
      : scope.type === "layer"
      ? `Layer: ${scope.label || ""}`
      : `Branch: ${scope.label || ""}`;

    return v_flex().w(this.qaWidth).flex_none().h_full().min_h(0).bg(t.chrome)
      // Drawer header
      .child(h_flex().h(36).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`Q&A${qaItems.length ? ` (${qaItems.length})` : ""}`))
        .child(div().flex_1())
        .when(outdatedCount > 0, el => el.child(div().id("ex-qa-clear-old").px(7).h(20).rounded(4).flex().items_center().text_size(10).cursor_pointer().flex_none()
          .bg(withAlpha(t.blocked, "1e")).border(1).border_color(withAlpha(t.blocked, "55")).text_color(t.blocked).hover(s => s.bg(withAlpha(t.blocked, "33")))
          .tooltip("Dismiss only Q&As from before recent file changes")
          .on_click((_e, cx) => this.clearOutdatedQa(cx))
          .child(`Clear outdated (${outdatedCount})`)))
        .when(qaItems.length > 0, el => el.child(div().id("ex-qa-clear").px(7).h(20).rounded(4).flex().items_center().text_size(10.2).cursor_pointer().flex_none()
          .bg(t.raised).border(1).border_color(t.border).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.ansi1))
          .tooltip("Dismiss all saved questions for this branch")
          .on_click((_e, cx) => this.clearAllQa(cx))
          .child("Clear")))
        .child(div().id("ex-qa-close").size(22).rounded(4).flex().items_center().justify_center().cursor_pointer().flex_none()
          .hover(s => s.bg(t.hover))
          .tooltip("Close Q&A panel")
          .on_click((_e, cx) => { this.qaOpen = false; cx.notify(); })
          .child(svg("mods/workspace-chrome/x.svg").size(11).text_color(t.muted))))
      // Vertically scrollable Q&A body
      .child(v_flex().id("ex-qa-scroll").flex_1().min_h(0).w_full().min_w(0).overflow_y_scrollbar().p(10).gap(8)
        .when(qaItems.length === 0, el => el.child(v_flex().p(14).gap(6).rounded(8).bg(t.background).border(1).border_color(t.border)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Ask about this branch"))
          .child(div().text_size(11.2).text_color(t.dim).whitespace_normal().child("Questions run read-only against the full repo and embed real code snippets. Older answers auto-collapse so your diff stays clear."))))
        .when(qaItems.length > 0, el => el.child(this.renderQaList(t, qaItems))))
      // Pinned Ask composer + 1-click quick questions at bottom of drawer
      .child(v_flex().w_full().min_w(0).flex_none().p(10).gap(6).bg(t.chrome).border_t(1).border_color(t.border)
        .child(h_flex().w_full().min_w(0).gap(5).items_center().flex_wrap()
          .children(QUICK_ASK_CHIPS.map(chip => div().id(`ex-qchip-${chip.id}`).px(7).h(20).rounded(5).flex().items_center().text_size(10).cursor_pointer().flex_none()
            .bg(t.raised).border(1).border_color(t.border).text_color(t.muted)
            .hover(s => s.bg(t.hover).border_color(t.accent).text_color(t.foreground))
            .tooltip(chip.prompt)
            .on_click((_e, cx) => {
              if (!this.askRunning) this.submitAsk(cx, chip.prompt);
            })
            .child(chip.label))))
        .child(h_flex().w_full().min_w(0).gap(6).items_center()
          .child(div().px(6).h(18).rounded(4).bg(withAlpha(t.accent, "20")).border(1).border_color(withAlpha(t.accent, "44"))
            .max_w_full().truncate().text_size(10).font_medium().text_color(t.accent).flex().items_center().tooltip(scopeBadge).child(scopeBadge))
          .when(scope.type !== "branch", el => el.child(div().id("ex-qa-reset-scope").text_size(10).text_color(t.dim).cursor_pointer().flex_none()
            .hover(s => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.askScope = { type: "branch", id: "", label: this.spec?.branch || "this branch" }; cx.notify(); })
            .child("×"))))
        .child(h_flex().w_full().min_w(0).gap(6).items_center()
          .child(div().flex_1().min_w(0).child(Input.new(this.askInput).h(28).px(9).items_center().rounded(6).border(1).border_color(t.border).bg(t.background).text_size(11.5).text_color(t.foreground)))
          .child(div().id("ex-ask-send").px(10).h(28).rounded(6).flex().items_center().text_size(11).font_semibold().flex_none()
            .bg(this.askRunning ? t.raised : t.solid)
            .text_color(this.askRunning ? t.dim : t.solid_foreground)
            .when(!this.askRunning, e => e.cursor_pointer().hover(st => st.opacity(0.9)))
            .on_click((_e, cx) => this.submitAsk(cx))
            .child(this.askRunning ? "..." : "Ask"))));
  }

  renderIntentCheck(t, rev) {
    const ic = rev?.intentCheck;
    if (!ic || ic.status === "none" || (!ic.summary && !(ic.gaps || []).length)) return null;
    const meta = ic.status === "aligned"
      ? { label: "Aligned", col: t.ansi2 }
      : ic.status === "mismatch"
      ? { label: "Mismatch", col: t.ansi1 }
      : { label: "Partial", col: t.blocked };
    const ctx = rev.intentContext;
    const refs = [];
    if (ctx?.pr?.number) refs.push(`PR #${ctx.pr.number}`);
    for (const iss of ctx?.issues || []) {
      if (iss?.number) refs.push(`Issue #${iss.number}`);
    }

    return v_flex().w_full().min_w(0).p(14).gap(8).rounded(10)
      .bg(t.raised + "66").border(1).border_color(withAlpha(meta.col, "44"))
      .child(h_flex().w_full().min_w(0).gap(8).items_center().flex_wrap()
        .child(div().size(8).flex_none().rounded_full().bg(meta.col))
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Intent check"))
        .child(div().px(6).h(18).rounded(4).bg(withAlpha(meta.col, "20")).text_size(10).font_semibold().text_color(meta.col).flex().items_center().child(meta.label))
        .children(refs.map((r, i) => div().id(`ex-ic-ref-${i}`).px(6).h(18).rounded(4).bg(t.background).border(1).border_color(t.border).text_size(10).text_color(t.dim).flex().items_center().child(r))))
      .when(Boolean(ic.summary), el => el.child(div().w_full().min_w(0).pl(16).child(this.renderRichText(ic.summary, t, { id: "ex-ic-sum", size: 12, color: t.muted }))))
      .when((ic.gaps || []).length > 0, el => el.child(v_flex().w_full().min_w(0).pl(16).pt(2).gap(4)
        .children(ic.gaps.map((g, i) => h_flex().id(`ex-ic-gap-${i}`).w_full().min_w(0).gap(6).items_start()
          .child(div().mt(6).size(4).flex_none().rounded_full().bg(meta.col))
          .child(div().flex_1().min_w(0).child(this.renderRichText(g, t, { id: `ex-ic-g-${i}`, size: 11.5, color: t.foreground })))))));
  }

  renderStoryHero(t, rev) {
    const st = rev?.story;
    if (!st || (!st.pitch && !st.before && !st.after)) return null;
    const copyText = [
      st.pitch,
      st.before ? `Before: ${st.before}` : "",
      st.after ? `Now: ${st.after}` : "",
      st.example ? `Example: ${st.example}` : "",
    ].filter(Boolean).join("\n");

    return v_flex().w_full().min_w(0).p(15).gap(12).rounded(10)
      .bg(t.raised + "77").border(1).border_color(withAlpha(t.accent, "44"))
      // Top row: Release pitch ("PR statement") + Copy button
      .when(Boolean(st.pitch), el => el.child(h_flex().w_full().min_w(0).gap(10).items_start()
        .child(div().flex_1().min_w(0).child(this.renderRichText(st.pitch, t, { id: "ex-st-pitch", size: 12.8, color: t.foreground })))
        .child(div().id("ex-st-copy").px(7).h(22).rounded(5).flex().items_center().text_size(10.2).cursor_pointer().flex_none()
          .bg(t.background).border(1).border_color(t.border).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Copy release pitch & Before/Now summary")
          .on_click((_e, cx) => {
            cx.write_to_clipboard(copyText);
            notify({ title: "Copied summary", body: rev.title || "PR statement", level: "info", timeout: 1600 });
          })
          .child("Copy"))))
      // Compact 2-column Before -> Now contrast strip
      .when(Boolean(st.before || st.after), el => el.child(h_flex().w_full().min_w(0).gap(8).items_stretch()
        .when(Boolean(st.before), e => e.child(v_flex().flex_1().min_w(0).p(10).gap(4).rounded(8)
          .bg(withAlpha(t.ansi1, "10")).border(1).border_color(withAlpha(t.ansi1, "33"))
          .child(div().px(5).h(16).rounded(4).bg(withAlpha(t.ansi1, "20")).text_size(9.5).font_semibold().text_color(t.ansi1).flex().items_center().self_start().child("Before"))
          .child(this.renderRichText(st.before, t, { id: "ex-st-before", size: 11.6, color: t.muted }))))
        .when(Boolean(st.before && st.after), e => e.child(div().flex_none().flex().items_center().justify_center().text_size(13).text_color(t.dim).child("→")))
        .when(Boolean(st.after), e => e.child(v_flex().flex_1().min_w(0).p(10).gap(4).rounded(8)
          .bg(withAlpha(t.ansi2, "12")).border(1).border_color(withAlpha(t.ansi2, "3a"))
          .child(div().px(5).h(16).rounded(4).bg(withAlpha(t.ansi2, "22")).text_size(9.5).font_semibold().text_color(t.ansi2).flex().items_center().self_start().child("Now"))
          .child(this.renderRichText(st.after, t, { id: "ex-st-after", size: 11.6, color: t.foreground }))))))
      // Optional 1-line concrete example
      .when(Boolean(st.example), el => el.child(h_flex().w_full().min_w(0).px(10).py(6).gap(7).items_center().rounded(7)
        .bg(t.background).border(1).border_color(t.border)
        .child(div().px(5).h(16).rounded(4).bg(withAlpha(t.accent, "20")).text_size(9.5).font_semibold().text_color(t.accent).flex().items_center().flex_none().child("Example"))
        .child(div().flex_1().min_w(0).child(this.renderRichText(st.example, t, { id: "ex-st-ex", size: 11.4, color: t.muted })))));
  }

  renderUiChangesCard(t, rev) {
    const items = Array.isArray(rev?.uiChanges) ? rev.uiChanges : [];
    if (!items.length) return null;
    return v_flex().w_full().min_w(0).p(14).gap(10).rounded(10)
      .bg(withAlpha(t.accent, "0f")).border(1).border_color(withAlpha(t.accent, "44"))
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(div().px(6).h(18).rounded(4).bg(withAlpha(t.accent, "24")).text_size(9.8).font_semibold().text_color(t.accent).flex().items_center().flex_none().child("UI"))
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`Visible UI changes (${items.length})`))
        .child(div().flex_1())
        .child(div().text_size(10.2).text_color(t.dim).child("Ready to demo / explain to team")))
      .child(v_flex().w_full().min_w(0).gap(8)
        .children(items.map((u, i) => v_flex().id(`ex-uic-${i}`).w_full().min_w(0).p(10).gap(4).rounded(8)
          .bg(t.background).border(1).border_color(t.border)
          .when(Boolean(u.screen), el => el.child(div().text_size(10.2).font_medium().text_color(t.accent).child(u.screen)))
          .when(Boolean(u.change), el => el.child(this.renderRichText(u.change, t, { id: `ex-uich-${i}`, size: 12, color: t.foreground })))
          .when(Boolean(u.detail), el => el.child(this.renderRichText(u.detail, t, { id: `ex-uicd-${i}`, size: 11.4, color: t.muted }))))));
  }

  renderDiagramCard(t, rev) {
    const layout = layoutDiagram(rev?.diagram);
    if (!layout) return null;
    const kindStyle = kind => {
      if (kind === "ui") return { tag: "Screen", col: t.accent };
      if (kind === "api") return { tag: "Endpoint", col: t.ansi6 || t.accent };
      if (kind === "data") return { tag: "Database", col: t.ansi5 || t.accent };
      if (kind === "infra") return { tag: "Infra", col: t.blocked };
      if (kind === "external") return { tag: "External", col: t.dim };
      return { tag: "Backend", col: t.ansi2 };
    };

    const openNode = (node, cx) => {
      if (!node) return;
      const hasLayer = Boolean(node.layerId && (rev.layers || []).some(l => l.id === node.layerId));
      if (hasLayer) this.openLayer(node.layerId, cx);
      else {
        this.openAsk({ type: "branch", id: "", label: node.label }, cx);
        this.submitAsk(cx, `Explain in 3 short bullets how "${node.label}" is involved in this branch.`);
      }
    };

    const nodePill = (node, idKey) => {
      const ks = kindStyle(node.kind);
      const hasLayer = Boolean(node.layerId && (rev.layers || []).some(l => l.id === node.layerId));
      return h_flex().id(idKey).px(8).py(5).gap(6).items_center().rounded(7).cursor_pointer().flex_none()
        .bg(node.changed ? withAlpha(t.accent, "18") : t.background)
        .border(1).border_color(node.changed ? withAlpha(t.accent, "77") : t.border)
        .hover(s => s.border_color(t.accent).bg(withAlpha(t.accent, "24")))
        .tooltip(hasLayer ? "Click to inspect this layer's diff" : `Click to ask how "${node.label}" fits in`)
        .on_click((_e, cx) => openNode(node, cx))
        .child(div().px(5).h(16).rounded(4).bg(withAlpha(ks.col, "22")).text_size(9.5).font_semibold().text_color(ks.col).flex().items_center().flex_none().child(ks.tag))
        .child(div().text_size(11.3).font_semibold().text_color(t.foreground).child(node.label))
        .when(node.changed, el => el.child(div().size(6).flex_none().rounded_full().bg(t.accent)));
    };

    return v_flex().w_full().min_w(0).p(14).gap(10).rounded(10).bg(t.raised + "55").border(1).border_color(t.border)
      .child(h_flex().id("ex-diag-toggle").w_full().min_w(0).gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.diagramOpen = !this.diagramOpen; cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${this.diagramOpen ? "down" : "right"}.svg`).size(11).text_color(t.dim))
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child("How it connects"))
        .when(Boolean(layout.caption), el => el.child(div().flex_1().min_w(0).truncate().text_size(11.2).text_color(t.muted).child(layout.caption)))
        .child(h_flex().gap(4).items_center().flex_none()
          .child(div().size(6).rounded_full().bg(t.accent))
          .child(div().text_size(10).text_color(t.dim).child("changed"))))
      .when(this.diagramOpen, el => el
        // Clean, honest, non-overflowing clickable connection rows (no misleading column arrows)
        .when(layout.edges.length > 0, e => e.child(v_flex().w_full().min_w(0).gap(6)
          .children(layout.edges.slice(0, 6).map((ed, i) => {
            const fromNode = layout.nodeById.get(ed.from) || { id: ed.from, label: ed.from, kind: "service", changed: false, layerId: "" };
            const toNode = layout.nodeById.get(ed.to) || { id: ed.to, label: ed.to, kind: "service", changed: false, layerId: "" };
            return h_flex().id(`ex-dedge-${i}`).w_full().min_w(0).p(7).gap(7).items_center().flex_wrap().rounded(8).bg(t.background + "88").border(1).border_color(t.border)
              .child(div().w(18).h(18).flex_none().rounded(5).bg(t.raised).flex().items_center().justify_center().text_size(10).font_semibold().text_color(t.dim).child(String(i + 1)))
              .child(nodePill(fromNode, `ex-df-${i}`))
              .child(div().text_size(11).text_color(t.dim).child("→"))
              .when(Boolean(ed.label), x => x.child(div().px(6).h(18).rounded(4).bg(t.raised).text_size(10.2).text_color(t.muted).flex().items_center().child(ed.label)))
              .when(Boolean(ed.label), x => x.child(div().text_size(11).text_color(t.dim).child("→")))
              .child(nodePill(toNode, `ex-dt-${i}`));
          }))))
        // Fallback if nodes exist without edges
        .when(layout.edges.length === 0, e => e.child(h_flex().w_full().min_w(0).gap(6).flex_wrap()
          .children(layout.nodes.map((n, i) => nodePill(n, `ex-dn-${i}`))))));
  }

  renderOverview(t, stats) {
    const rev = this.review;
    const layers = rev.layers || [];
    const bullets = Array.isArray(rev.bullets) ? rev.bullets : [];
    const totalLines = Math.max(1, stats.added + stats.removed);
    const addedPct = Math.round((stats.added / totalLines) * 100);
    const totalOpen = stats.openFindings.length;
    const age = formatRelativeAge(rev.updatedAt);
    const bhNote = rev.bugHuntPass?.ran ? ` · 2-pass (${rev.bugHuntPass.scannedFiles} prod files)` : "";
    const runMeta = (rev.lastRunMode === "incremental"
      ? `Updated ${age} · ${rev.lastAnalyzedFiles} refreshed, ${rev.lastReusedFiles} cached`
      : `Updated ${age} · ${rev.engine}`) + bhNote;
    const leadLine = rev.tldr || rev.summary || "";
    const storyHero = this.renderStoryHero(t, rev);
    const intentCard = this.renderIntentCheck(t, rev);
    const uiChangesCard = this.renderUiChangesCard(t, rev);
    const diagramCard = this.renderDiagramCard(t, rev);

    const kpiCard = (title, mainVal, mainUnit, barEl, subEl) =>
      v_flex().flex_1().min_w(0).p(12).gap(6).rounded(10).bg(t.raised + "77").border(1).border_color(t.border)
        .child(div().truncate().text_size(10.8).text_color(t.dim).child(title))
        .child(h_flex().gap(5).items_baseline().min_w(0)
          .child(div().text_size(20).font_semibold().text_color(t.foreground).child(String(mainVal)))
          .child(div().truncate().text_size(11).text_color(t.dim).child(mainUnit)))
        .child(barEl)
        .child(subEl);

    const layerBar = h_flex().h(4).w_full().min_w(0).gap(3)
      .children((layers.length ? layers : [{ id: "empty" }]).map((l, i) => {
        const lc = stats.byLayer.get(l.id);
        const col = lc?.critical > 0 ? t.ansi1 : lc?.major > 0 ? t.blocked : lc?.total > 0 ? t.accent : t.border;
        return div().id(`lb-${i}`).flex_1().h(4).rounded(3).bg(col);
      }));

    const filesBar = h_flex().h(4).w_full().min_w(0).gap(2).overflow_hidden().rounded(3)
      .when(stats.added > 0 || stats.removed === 0, el => el.child(div().flex_1().h(4).rounded(3).bg(t.ansi2)))
      .when(stats.removed > 0, el => el.child(div().w(Math.max(12, Math.round((100 - addedPct) * 0.6))).flex_none().h(4).rounded(3).bg(t.ansi1)));

    const findingsBar = h_flex().h(4).w_full().min_w(0).gap(2)
      .when(totalOpen === 0, el => el.child(div().flex_1().h(4).rounded(3).bg(t.ansi2)))
      .when(stats.counts.critical > 0, el => el.child(div().flex_1().h(4).rounded(3).bg(t.ansi1)))
      .when(stats.counts.major > 0, el => el.child(div().flex_1().h(4).rounded(3).bg(t.blocked)))
      .when(stats.counts.minor + stats.counts.nit > 0, el => el.child(div().flex_1().h(4).rounded(3).bg(t.accent)));

    return v_flex().id("ex-overview").flex_1().h_full().min_w(0).min_h(0).overflow_y_scrollbar().p(22)
      .child(v_flex().w_full().max_w(760).min_w(0).gap(20)
        // 1. Calm headline + Release Pitch / Before -> Now hero (falls back to leadLine for older cached reviews)
        .child(v_flex().w_full().min_w(0).gap(8)
          .child(div().w_full().min_w(0).truncate().text_size(10.8).text_color(t.dim).child(runMeta))
          .child(div().w_full().min_w(0).text_size(19).font_semibold().text_color(t.foreground).whitespace_normal().child(rev.title || this.spec?.branch || "Branch Explain"))
          .when(Boolean(storyHero), el => el.child(storyHero))
          .when(!storyHero && Boolean(leadLine), el => el.child(this.renderRichText(leadLine, t, { id: "ex-ov-tldr", size: 13, color: t.muted }))))
        // 2. 3 Compact KPI cards
        .child(h_flex().gap(10).w_full().min_w(0).items_stretch()
          .child(kpiCard(
            "Layers",
            stats.layerCount,
            stats.layerCount === 1 ? "step" : "steps",
            layerBar,
            div().w_full().min_w(0).truncate().text_size(10.8).text_color(t.dim).child(
              stats.layersWithFindings === 0 ? "All clear" : `${stats.layersWithFindings} with notes`
            )
          ))
          .child(kpiCard(
            "Files",
            stats.fileCount,
            stats.fileCount === 1 ? "file" : "files",
            filesBar,
            h_flex().gap(8).min_w(0)
              .child(div().text_size(10.8).text_color(t.ansi2).child(`+${stats.added}`))
              .child(div().text_size(10.8).text_color(t.ansi1).child(`−${stats.removed}`))
          ))
          .child(kpiCard(
            "Needs eyes",
            totalOpen,
            totalOpen === 1 ? "item" : "items",
            findingsBar,
            h_flex().gap(8).items_center().min_w(0).flex_wrap()
              .when(totalOpen === 0, el => el.child(div().text_size(10.8).text_color(t.ansi2).child("Ready to go")))
              .when(stats.counts.critical > 0, el => el.child(div().text_size(10.8).text_color(t.ansi1).child(`● ${stats.counts.critical} Crit`)))
              .when(stats.counts.major > 0, el => el.child(div().text_size(10.8).text_color(t.blocked).child(`● ${stats.counts.major} Maj`)))
              .when(stats.counts.minor + stats.counts.nit > 0, el => el.child(div().text_size(10.8).text_color(t.accent).child(`● ${stats.counts.minor + stats.counts.nit} Min`)))
          )))
        // 2b. Intent check against PR / linked issue (when present)
        .when(Boolean(intentCard), el => el.child(intentCard))
        // 2c. Visible UI changes (customer/team demo ready)
        .when(Boolean(uiChangesCard), el => el.child(uiChangesCard))
        // 3. Needs your eyes FIRST (so a tired reviewer sees what matters in 2 seconds)
        .child(v_flex().w_full().min_w(0).gap(10)
          .child(h_flex().w_full().min_w(0).gap(8).items_center()
            .child(div().text_size(12.5).font_semibold().text_color(t.foreground)
              .child(totalOpen === 0 ? "Nothing blocking" : `Needs your eyes (${totalOpen})`))
            .when(stats.counts.critical > 0, el => el.child(div().px(6).h(18).rounded(4).bg(withAlpha(t.ansi1, "22")).text_size(10).font_semibold().text_color(t.ansi1).flex().items_center().child("Critical")))
            .child(div().flex_1())
            .child(div().id("ex-ov-ask").px(8).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer().flex_none()
              .bg(t.raised).border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Ask a read-only question about this branch")
              .on_click((_e, cx) => this.openAsk({ type: "branch", id: "", label: this.spec?.branch || "this branch" }, cx))
              .child("Ask a question")))
          .when(totalOpen === 0, el => el.child(div().w_full().min_w(0).p(14).rounded(9).bg(t.raised + "55").border(1).border_color(t.border)
            .text_size(12).text_color(t.dim).whitespace_normal().child("No bugs or risky spots flagged. Skim the steps below or click any layer on the left.")))
          .children(stats.openFindings.map(f => this.renderFindingCard(f, t, { showJump: true }))))
        // 4. At a glance (scannable bullets with bold lead-ins, no dense paragraphs)
        .when(bullets.length > 0, el => el.child(v_flex().w_full().min_w(0).p(16).gap(10).rounded(10).bg(t.raised + "55").border(1).border_color(t.border)
          .child(div().text_size(12).font_semibold().text_color(t.muted).child("At a glance"))
          .children(bullets.map((b, i) => h_flex().id(`ex-bul-${i}`).w_full().min_w(0).gap(8).items_start()
            .child(div().mt(6).size(5).flex_none().rounded_full().bg(t.accent))
            .child(v_flex().flex_1().min_w(0).gap(1)
              .when(Boolean(b.lead), e => e.child(div().w_full().min_w(0).text_size(12.2).font_semibold().text_color(t.foreground).whitespace_normal().child(b.lead)))
              .when(Boolean(b.text), e => e.child(this.renderRichText(b.text, t, { id: `ex-bul-t-${i}`, size: 12, color: t.muted }))))))))
        // 4b. Visual Architecture / Data-flow diagram
        .when(Boolean(diagramCard), el => el.child(diagramCard))
        // 5. Walkthrough steps (clean clickable cards with generous spacing)
        .child(v_flex().w_full().min_w(0).gap(8)
          .child(div().text_size(12).font_semibold().text_color(t.muted).child("Walkthrough order"))
          .children(layers.map((l, idx) => {
            const lc = stats.byLayer.get(l.id) || { critical: 0, major: 0, total: 0 };
            return h_flex().id(`ex-sum-l-${l.id}`).w_full().min_w(0).p(11).gap(11).rounded(9).bg(t.raised + "55").border(1).border_color(t.border)
              .items_start().cursor_pointer().hover(s => s.bg(t.raised).border_color(t.accent))
              .on_click((_e, cx) => this.openLayer(l.id, cx))
              .child(div().w(22).h(22).flex_none().rounded(6).bg(t.background).flex().items_center().justify_center().text_size(11).font_semibold().text_color(t.muted).child(String(idx + 1)))
              .child(v_flex().flex_1().min_w(0).gap(3)
                .child(div().w_full().min_w(0).text_size(12.5).font_semibold().text_color(t.foreground).whitespace_normal().child(l.title))
                .when(Boolean(l.summary), el => el.child(div().w_full().min_w(0).text_size(11.8).text_color(t.muted).whitespace_normal().child(l.summary))))
              .child(h_flex().gap(5).items_center().flex_none()
                .child(div().px(6).h(18).rounded(4).bg(t.background).text_size(10).text_color(t.dim).flex().items_center().child(`${l.files.length} ${l.files.length === 1 ? "file" : "files"}`))
                .when(lc.critical > 0, el => el.child(div().px(5).h(18).rounded(4).bg(withAlpha(t.ansi1, "22")).text_size(10).text_color(t.ansi1).flex().items_center().child(`● ${lc.critical}`)))
                .when(lc.major > 0, el => el.child(div().px(5).h(18).rounded(4).bg(withAlpha(t.blocked, "22")).text_size(10).text_color(t.blocked).flex().items_center().child(`● ${lc.major}`))));
          })))
        // 6. Resolved findings (collapsed)
        .when(stats.resolvedFindings.length > 0, el => el.child(v_flex().w_full().min_w(0).p(12).gap(8).rounded(9).bg(t.raised + "33").border(1).border_color(t.border)
          .child(h_flex().id("ex-toggle-res").gap(6).items_center().cursor_pointer()
            .on_click((_e, cx) => { this.showResolved = !this.showResolved; cx.notify(); })
            .child(svg(`mods/workspace-chrome/chevron-${this.showResolved ? "down" : "right"}.svg`).size(11).text_color(t.dim))
            .child(div().text_size(11.5).text_color(t.dim).child(`Done (${stats.resolvedFindings.length})`)))
          .when(this.showResolved, e => e.children(stats.resolvedFindings.map(f => this.renderFindingCard(f, t, { showJump: true })))))));
  }

  renderDiffWithFindings(t, fileFindings) {
    const rows = this.style === "split" ? this.splitRows : this.unifiedRows;
    const pal = syntaxPalette(t);
    const wrap = this.wrapLines;
    const rowMinW = this.style === "split" ? this.splitMinW : this.uniMinW;

    const renderCode = (toks, fallbackText) => {
      const list = Array.isArray(toks) ? toks : tokenizeCodeLine(fallbackText, this.activeFilePath || "");
      if (!list.length) return div().flex_1().min_w(0);
      if (wrap) {
        return h_flex().flex_1().min_w(0).flex_wrap().items_center().overflow_hidden()
          .children(list.map(tok => div().max_w_full().min_w(0).whitespace_normal().text_color(pal[tok.kind] || pal.plain).child(tok.text)));
      }
      return h_flex().flex_1().min_w(0).items_center().overflow_hidden()
        .children(list.map(tok => div().whitespace_nowrap().text_color(pal[tok.kind] || pal.plain).child(tok.text)));
    };
    const byLine = new Map();
    const topFindings = [];
    for (const f of fileFindings) {
      const anchor = f.lineEnd || f.lineStart || 0;
      if (anchor <= 0) topFindings.push(f);
      else {
        const list = byLine.get(anchor) || [];
        list.push(f);
        byLine.set(anchor, list);
      }
    }

    const placed = new Set();
    const out = [];
    for (const f of topFindings) {
      placed.add(f.id);
      out.push(div().px(14).py(6).child(this.renderFindingCard(f, t, { compact: true })));
    }

    const renderRow = (row, idx) => {
      if (row.kind === "note") {
        return div().px(14).py(10).text_size(12).text_color(t.dim).child(row.text);
      }
      if (row.kind === "gap") {
        return h_flex().id(`ex-gap-${idx}`).h(24).w_full().flex_none().px(12).gap(8).items_center().bg(t.raised + "aa").border_y(1).border_color(t.border)
          .cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.contextLines = this.contextLines < 25 ? 25 : 200; this.diffFileKey = ""; this.loadActiveFileDiff(cx); })
          .child(div().text_size(10.5).text_color(t.dim).child(`⋮  ${row.label}  (click to expand)`));
      }
      if (this.style === "split") {
        const cell = (side, sideKind) => {
          const bg = side?.kind === "-" ? withAlpha(t.ansi1, "1a") : side?.kind === "+" ? withAlpha(t.ansi2, "1a") : "#00000000";
          const numCol = side?.kind === "-" ? t.ansi1 : side?.kind === "+" ? t.ansi2 : t.dim;
          const prefix = side?.kind === "-" ? "−" : side?.kind === "+" ? "+" : " ";
          return h_flex().flex_1().min_w(0).min_h(20).py(1).px(4).gap(4).items_start().overflow_hidden().bg(bg)
            .when(sideKind === "left", el => el.border_r(1).border_color(t.border))
            .child(div().w(26).flex_none().text_right().text_size(10).text_color(numCol).opacity(side ? 0.72 : 0.2).child(side?.num != null ? String(side.num) : ""))
            .child(div().w(8).flex_none().text_size(10.5).text_color(numCol).child(side ? prefix : ""))
            .child(side ? renderCode(side.toks, side.text ?? "") : div().flex_1().min_w(0));
        };
        return h_flex().w_full().min_w(0).flex_none().min_h(20).items_stretch()
          .child(cell(row.left, "left"))
          .child(cell(row.right, "right"));
      }
      const bg = row.kind === "+" ? withAlpha(t.ansi2, "1a") : row.kind === "-" ? withAlpha(t.ansi1, "1a") : "#00000000";
      const numCol = row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim;
      const glyph = row.kind === "+" ? "+" : row.kind === "-" ? "−" : " ";
      return h_flex().w_full().min_w(0).flex_none().min_h(20).py(1).px(6).gap(5).items_start().bg(bg)
        .child(div().w(28).flex_none().text_right().text_size(10).text_color(numCol).opacity(0.72).child(row.oldNum != null ? String(row.oldNum) : ""))
        .child(div().w(28).flex_none().text_right().text_size(10).text_color(numCol).opacity(0.72).child(row.newNum != null ? String(row.newNum) : ""))
        .child(div().w(8).flex_none().text_color(numCol).child(glyph))
        .child(renderCode(row.toks, row.text ?? ""));
    };

    const limit = Math.max(100, this.diffVisibleLimit || 220);
    const capped = rows.slice(0, limit);
    for (let i = 0; i < capped.length; i++) {
      const row = capped[i];
      out.push(renderRow(row, i));
      const newLine = this.style === "split" ? row.right?.num : row.newNum;
      if (newLine != null && byLine.has(newLine)) {
        for (const f of byLine.get(newLine)) {
          placed.add(f.id);
          out.push(div().px(14).py(8).child(this.renderFindingCard(f, t, { compact: true })));
        }
      }
    }

    if (rows.length > capped.length) {
      const rem = rows.length - capped.length;
      out.push(h_flex().id("ex-diff-more").w_full().flex_none().px(14).py(12).gap(8).items_center().justify_center()
        .bg(t.raised + "77").border_t(1).border_color(t.border)
        .child(div().text_size(11.2).text_color(t.dim).child(`Showing ${capped.length} of ${rows.length} lines`))
        .child(div().id("ex-diff-more-250").px(10).h(24).rounded(5).flex().items_center().text_size(11).font_medium().cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).hover(s => s.opacity(0.9))
          .on_click((_e, cx) => { this.diffVisibleLimit = capped.length + 250; cx.notify(); })
          .child(`Show ${Math.min(250, rem)} more`)));
    }

    // Any findings anchored to lines outside the visible diff context hunks go at the top so nothing is ever hidden!
    const unplaced = fileFindings.filter(f => !placed.has(f.id));
    if (unplaced.length) {
      const banner = v_flex().px(14).py(8).gap(6).border_b(1).border_color(t.border)
        .children(unplaced.map(f => this.renderFindingCard(f, t, { compact: true })));
      out.unshift(banner);
    }

    return { items: out.length ? out : [div().p(16).text_size(12).text_color(t.dim).child("No diff lines")], rowMinW };
  }

  renderLayerView(t, stats) {
    const layers = this.review?.layers || [];
    const layerIdx = layers.findIndex(l => l.id === this.activeLayerId);
    const layer = layerIdx >= 0 ? layers[layerIdx] : layers[0];
    if (!layer) return this.renderOverview(t, stats);

    const files = layer.files || [];
    const activePath = this.activeFilePath && files.some(f => f.path === this.activeFilePath)
      ? this.activeFilePath
      : files[0]?.path || null;
    const fileIdx = Math.max(0, files.findIndex(f => f.path === activePath));
    const activeFileObj = files[fileIdx] || null;
    const fileMeta = activePath ? this.review?.files?.[activePath] : null;
    const viewed = activePath ? this.isFileViewed(activePath) : false;
    const unviewedLeft = files.filter(f => !this.isFileViewed(f.path)).length;
    const fileFindings = activePath ? (stats.byFile.get(activePath) || []) : [];
    const depLayers = (layer.dependsOn || []).map(id => layers.find(x => x.id === id)).filter(Boolean);

    return v_flex().flex_1().h_full().min_w(0).min_h(0)
      // Layer title + summary + Depends on pills + Ask button
      .child(h_flex().w_full().min_w(0).flex_none().px(14).py(9).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().w(20).h(20).flex_none().rounded(5).bg(t.raised).flex().items_center().justify_center().text_size(10.5).font_semibold().text_color(t.accent).child(String(layerIdx + 1)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().w_full().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(layer.title))
          .when(Boolean(layer.summary), el => el.child(div().w_full().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(layer.summary).child(layer.summary))))
        .when(depLayers.length > 0, el => el.child(h_flex().gap(5).items_center().flex_none()
          .child(div().text_size(10.5).text_color(t.dim).child("Depends on"))
          .children(depLayers.map(dl => div().id(`ex-dep-${dl.id}`).px(7).h(20).rounded(5).bg(t.raised).border(1).border_color(t.border)
            .flex().items_center().text_size(10.5).text_color(t.foreground).cursor_pointer().hover(s => s.border_color(t.accent))
            .on_click((_e, cx) => this.openLayer(dl.id, cx))
            .child(dl.title)))))
        .child(div().id(`ex-ask-l-${layer.id}`).px(8).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer().flex_none()
          .bg(t.raised).border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Ask a read-only question about this layer")
          .on_click((_e, cx) => this.openAsk({ type: "layer", id: layer.id, label: layer.title }, cx))
          .child("Ask")))
      // File stepper & controls toolbar (controls always visible, path truncates cleanly)
      .child(h_flex().w_full().min_w(0).h(36).flex_none().px(14).gap(6).items_center().bg(t.background).border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(11.2).font_medium().text_color(t.foreground).child(`File ${fileIdx + 1}/${files.length}`))
        .child(div().flex_none().px(6).h(18).rounded(4).bg(t.raised).text_size(10).text_color(unviewedLeft === 0 ? t.ansi2 : t.dim).flex().items_center()
          .child(unviewedLeft === 0 ? "All viewed" : `${unviewedLeft} left`))
        .when(files.length > 1, el => el
          .child(div().id("ex-fprev").size(22).flex_none().rounded(5).bg(t.raised).border(1).border_color(t.border).flex().items_center().justify_center().cursor_pointer()
            .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.stepLayerFile(-1, cx))
            .child(svg("mods/workspace-chrome/chevron-left.svg").size(12).text_color(t.muted)))
          .child(div().id("ex-fnext").size(22).flex_none().rounded(5).bg(t.raised).border(1).border_color(t.border).flex().items_center().justify_center().cursor_pointer()
            .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.stepLayerFile(1, cx))
            .child(svg("mods/workspace-chrome/chevron-right.svg").size(12).text_color(t.muted))))
        .child(div().flex_1().min_w(0).truncate().text_size(11.2).text_color(t.muted).font_family(settings().font_family ?? "JetBrains Mono").tooltip(activePath || "").child(activePath || ""))
        .when(Boolean(fileMeta), el => el.child(h_flex().gap(4).flex_none()
          .when((fileMeta.added || 0) > 0, e => e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${fileMeta.added}`)))
          .when((fileMeta.removed || 0) > 0, e => e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${fileMeta.removed}`)))))
        .child(div().id("ex-style-uni").flex_none().px(7).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer()
          .bg(this.style === "unified" ? t.selected : t.raised).border(1).border_color(this.style === "unified" ? withAlpha(t.accent, "66") : t.border)
          .text_color(this.style === "unified" ? t.foreground : t.muted)
          .on_click((_e, cx) => { this.style = "unified"; saveJson(LS_DIFF_STYLE, "unified"); cx.notify(); }).child("Unified"))
        .child(div().id("ex-style-spl").flex_none().px(7).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer()
          .bg(this.style === "split" ? t.selected : t.raised).border(1).border_color(this.style === "split" ? withAlpha(t.accent, "66") : t.border)
          .text_color(this.style === "split" ? t.foreground : t.muted)
          .on_click((_e, cx) => { this.style = "split"; saveJson(LS_DIFF_STYLE, "split"); cx.notify(); }).child("Split"))
        .child(div().id("ex-wrap").flex_none().px(7).h(22).rounded(5).flex().items_center().text_size(10.8).cursor_pointer()
          .bg(this.wrapLines ? withAlpha(t.accent, "24") : t.raised).border(1).border_color(this.wrapLines ? withAlpha(t.accent, "66") : t.border)
          .text_color(this.wrapLines ? t.accent : t.muted).tooltip("Wrap long code lines so nothing is clipped")
          .on_click((_e, cx) => { this.wrapLines = !this.wrapLines; saveJson(LS_DIFF_WRAP, this.wrapLines); cx.notify(); }).child("Wrap"))
        .when(Boolean(activePath), el => el.child(h_flex().id("ex-viewed").flex_none().h(22).px(8).gap(4).items_center().rounded(5).cursor_pointer()
          .bg(viewed ? withAlpha(t.accent, "28") : t.raised).border(1).border_color(viewed ? t.accent : t.border)
          .text_size(10.8).text_color(viewed ? t.accent : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.toggleFileViewed(activePath, cx, { advance: true }))
          .child(svg(viewed ? "mods/workspace-chrome/check.svg" : "mods/wf-changes/icons/eye.svg").size(11).text_color(viewed ? t.accent : t.muted))
          .child(viewed ? "Viewed" : "Viewed?"))))
      // File pills row (wraps cleanly so all files stay clickable)
      .when(files.length > 1, el => el.child(h_flex().w_full().min_w(0).flex_none().px(14).py(5).gap(5).items_center().flex_wrap().bg(t.raised + "44").border_b(1).border_color(t.border)
        .children(files.map((lf, i) => {
          const isCur = lf.path === activePath;
          const isV = this.isFileViewed(lf.path);
          const fOpen = (stats.byFile.get(lf.path) || []).filter(x => !x.resolved).length;
          const base = lf.path.split("/").pop() || lf.path;
          return h_flex().id(`ex-fp-${i}`).h(22).px(7).gap(4).items_center().rounded(5).cursor_pointer().flex_none()
            .bg(isCur ? t.selected : t.background).border(1).border_color(isCur ? withAlpha(t.accent, "77") : t.border)
            .text_size(10.8).text_color(isCur ? t.foreground : (isV ? t.dim : t.muted))
            .tooltip(lf.path)
            .on_click((_e, cx) => this.selectLayerFile(lf.path, cx))
            .when(isV, e => e.child(svg("mods/workspace-chrome/check.svg").size(10).text_color(t.ansi2)))
            .child(div().max_w(160).truncate().child(base))
            .when(fOpen > 0, e => e.child(div().px(4).h(14).rounded(3).bg(withAlpha(t.ansi1, "22")).text_size(9.5).text_color(t.ansi1).flex().items_center().child(String(fOpen))));
        }))))
      // File role strip
      .when(Boolean(activeFileObj?.role), el => el.child(h_flex().w_full().min_w(0).flex_none().px(14).py(5).bg(t.raised + "66").border_b(1).border_color(t.border)
        .child(div().w_full().min_w(0).text_size(11.2).text_color(t.muted).whitespace_normal().child(activeFileObj.role))))
      // Diff body with inline findings
      .when(this.diffLoading, el => el.child(div().p(16).text_size(12).text_color(t.dim).child("Loading diff...")))
      .when(!this.diffLoading && Boolean(this.diffError), el => el.child(div().p(16).text_size(12).text_color(t.ansi1).child(this.diffError)))
      .when(!this.diffLoading && !this.diffError, el => {
        const rendered = this.renderDiffWithFindings(t, fileFindings);
        return el.child(v_flex().id(`ex-diff-${this.style}`).flex_1().w_full().min_w(0).min_h(0)
          .overflow_y_scrollbar().when(!this.wrapLines, e => e.overflow_x_scrollbar())
          .font_family(settings().font_family ?? "JetBrains Mono").text_size(this.style === "split" ? 11 : 11.5)
          .child(v_flex().w_full().when(!this.wrapLines, e => e.min_w(rendered.rowMinW))
            .children(rendered.items)));
      });
  }

  renderLeftRail(t, stats) {
    const rev = this.review;
    const layers = rev?.layers || [];
    const totalOpen = stats.openFindings.length;
    const hasQuery = Boolean(this.searchQuery.trim());
    const results = hasQuery ? searchExplainReview(rev, this.searchQuery) : null;

    return v_flex().w(this.railWidth).flex_none().h_full().min_h(0).bg(t.chrome)
      // Concept-first instant search bar (searches plain-English summaries, file roles, findings, and Q&As)
      .child(h_flex().flex_none().px(8).pt(8).pb(4).gap(4).items_center()
        .child(div().flex_1().min_w(0).child(Input.new(this.searchInput).h(26).px(8).items_center().rounded(6).border(1).border_color(hasQuery ? withAlpha(t.accent, "66") : t.border).bg(t.background).text_size(11).text_color(t.foreground)))
        .when(hasQuery, el => el.child(div().id("ex-srch-clr").size(22).rounded(5).flex().items_center().justify_center().cursor_pointer().flex_none()
          .bg(t.raised).border(1).border_color(t.border).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.searchQuery = ""; this.searchInput.set_value(""); cx.notify(); })
          .child(svg("mods/workspace-chrome/x.svg").size(10).text_color(t.muted)))))
      .when(hasQuery, el => el.child(v_flex().id("ex-rail-search").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(6)
        .when(results.total === 0, e => e.child(div().p(8).text_size(11.2).text_color(t.dim).whitespace_normal().child(`No matches for "${this.searchQuery.trim()}". Try Ask in Q&A instead.`)))
        .when(results.findings.length > 0, e => e
          .child(div().px(4).text_size(9.8).font_semibold().text_color(t.dim).child(`NEEDS EYES (${results.findings.length})`))
          .children(results.findings.map(f => {
            const sev = severityMeta(f.severity, t);
            return v_flex().id(`ex-sf-${f.id}`).p(7).gap(2).rounded(6).cursor_pointer().bg(t.raised + "77").border(1).border_color(t.border)
              .hover(s => s.bg(t.hover).border_color(t.accent))
              .on_click((_ev, cx) => this.jumpToFinding(f, cx))
              .child(h_flex().gap(5).items_center()
                .child(div().size(6).flex_none().rounded_full().bg(sev.col))
                .child(div().flex_1().min_w(0).truncate().text_size(11.2).font_medium().text_color(t.foreground).child(f.title)))
              .when(Boolean(f.impact), x => x.child(div().pl(11).truncate().text_size(10.2).text_color(t.dim).child(f.impact)));
          })))
        .when(results.layers.length > 0, e => e
          .child(div().px(4).pt(4).text_size(9.8).font_semibold().text_color(t.dim).child(`LAYERS (${results.layers.length})`))
          .children(results.layers.map(l => v_flex().id(`ex-sl-${l.id}`).p(7).gap(2).rounded(6).cursor_pointer().bg(t.raised + "55").border(1).border_color(t.border)
            .hover(s => s.bg(t.hover).border_color(t.accent))
            .on_click((_ev, cx) => this.openLayer(l.id, cx))
            .child(div().truncate().text_size(11.2).font_medium().text_color(t.foreground).child(l.title))
            .when(Boolean(l.summary), x => x.child(div().truncate().text_size(10.2).text_color(t.dim).child(l.summary))))))
        .when(results.files.length > 0, e => e
          .child(div().px(4).pt(4).text_size(9.8).font_semibold().text_color(t.dim).child(`FILES (${results.files.length})`))
          .children(results.files.map((f, i) => v_flex().id(`ex-sfile-${i}`).p(7).gap(2).rounded(6).cursor_pointer().bg(t.raised + "55").border(1).border_color(t.border)
            .hover(s => s.bg(t.hover).border_color(t.accent))
            .tooltip(f.path)
            .on_click((_ev, cx) => this.openLayer(f.layerId, cx, { filePath: f.path }))
            .child(div().truncate().text_size(11).font_medium().text_color(t.foreground).child(f.path.split("/").pop() || f.path))
            .when(Boolean(f.role), x => x.child(div().truncate().text_size(10.2).text_color(t.muted).child(f.role))))))
        .when(results.qa.length > 0, e => e
          .child(div().px(4).pt(4).text_size(9.8).font_semibold().text_color(t.dim).child(`Q&A (${results.qa.length})`))
          .children(results.qa.map(q => v_flex().id(`ex-sqa-${q.id}`).p(7).gap(2).rounded(6).cursor_pointer().bg(t.raised + "55").border(1).border_color(t.border)
            .hover(s => s.bg(t.hover).border_color(t.accent))
            .on_click((_ev, cx) => { this.qaOpen = true; this.qaToggled.set(q.id, true); cx.notify(); })
            .child(div().truncate().text_size(11).font_medium().text_color(t.foreground).child(q.question)))))))
      .when(!hasQuery, el => el.child(v_flex().id("ex-rail-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(4)
        // Overview item
        .child(h_flex().id("ex-nav-overview").h(32).px(9).gap(7).items_center().rounded(6).cursor_pointer()
          .bg(this.viewMode === "overview" ? t.selected : "#00000000")
          .border(1).border_color(this.viewMode === "overview" ? withAlpha(t.accent, "55") : "#00000000")
          .hover(s => s.bg(this.viewMode === "overview" ? t.selected : t.hover))
          .on_click((_e, cx) => this.openOverview(cx))
          .child(svg("mods/workspace-chrome/git-branch.svg").size(13).text_color(this.viewMode === "overview" ? t.accent : t.muted))
          .child(div().flex_1().text_size(12).font_medium().text_color(this.viewMode === "overview" ? t.foreground : t.muted).child("Overview"))
          .when(totalOpen > 0, el => el.child(div().px(5).h(16).rounded(4).bg(withAlpha(stats.counts.critical > 0 ? t.ansi1 : t.blocked, "22"))
            .text_size(10).text_color(stats.counts.critical > 0 ? t.ansi1 : t.blocked).flex().items_center().child(String(totalOpen)))))
        // Layers section label
        .when(layers.length > 0, el => el.child(div().px(8).pt(8).pb(2).text_size(10).font_semibold().text_color(t.dim).child(`LAYERS (${layers.length})`)))
        // Numbered layer cards
        .children(layers.map((l, idx) => {
          const active = this.viewMode === "layer" && this.activeLayerId === l.id;
          const lc = stats.byLayer.get(l.id) || { critical: 0, major: 0, minor: 0, total: 0 };
          const allViewed = l.files.length > 0 && l.files.every(f => this.isFileViewed(f.path));
          return v_flex().id(`ex-nav-l-${l.id}`).p(8).gap(5).rounded(7).cursor_pointer()
            .bg(active ? t.selected : "#00000000")
            .border(1).border_color(active ? withAlpha(t.accent, "55") : "#00000000")
            .hover(s => s.bg(active ? t.selected : t.hover))
            .on_click((_e, cx) => this.openLayer(l.id, cx))
            .child(h_flex().gap(7).items_center()
              .child(div().w(18).h(18).flex_none().rounded(4).bg(active ? withAlpha(t.accent, "28") : t.raised)
                .flex().items_center().justify_center().text_size(10).font_semibold()
                .text_color(active ? t.accent : t.dim).child(String(idx + 1)))
              .child(div().flex_1().min_w(0).truncate().text_size(11.8).font_medium()
                .text_color(active ? t.foreground : (allViewed ? t.dim : t.foreground)).child(l.title))
              .when(allViewed, e => e.child(svg("mods/workspace-chrome/check.svg").size(11).text_color(t.ansi2))))
            .child(h_flex().pl(25).gap(5).items_center()
              .child(div().px(6).h(16).rounded(4).bg(t.raised).text_size(9.8).text_color(t.dim).flex().items_center()
                .child(`${l.files.length} ${l.files.length === 1 ? "file" : "files"} touched`))
              .when(lc.critical > 0, e => e.child(div().px(5).h(16).rounded(4).bg(withAlpha(t.ansi1, "22")).text_size(9.8).text_color(t.ansi1).flex().items_center().child(`● ${lc.critical}`)))
              .when(lc.major > 0, e => e.child(div().px(5).h(16).rounded(4).bg(withAlpha(t.blocked, "22")).text_size(9.8).text_color(t.blocked).flex().items_center().child(`● ${lc.major}`)))
              .when(lc.critical === 0 && lc.major === 0 && lc.total > 0, e => e.child(div().px(5).h(16).rounded(4).bg(withAlpha(t.accent, "22")).text_size(9.8).text_color(t.accent).flex().items_center().child(`● ${lc.total}`))));
        }))));
  }

  render(cx) {
    const focus = shared("wf.explainFocus");
    if (focus?.root && focus.ts && focus.ts !== this.lastFocusTs && focus.ts !== this.pendingFocusTs) {
      this.pendingFocusTs = focus.ts;
      cx.timer.after(1, cx => {
        this.pendingFocusTs = 0;
        this.applyFocus(focus, cx);
      });
    }

    const t = theme();
    const s = this.spec;
    const stats = summarizeExplain(this.review);
    const stale = this.status?.staleCount ?? 0;
    const totalFiles = this.status?.totalFiles ?? stats.fileCount;
    const engineLabel = EXPLAIN_ENGINES.find(e => e.id === this.engine)?.label || this.engine;
    const langMismatch = Boolean(this.review && (this.review.language || "English").toLowerCase() !== this.language.toLowerCase());

    const primaryLabel = this.running
      ? "Analyzing..."
      : !this.review
      ? "Run AI Explain"
      : langMismatch
      ? `Re-explain (${this.language})`
      : stale > 0
      ? `Update (${stale} changed)`
      : "Up to date";
    const primaryHighlight = !this.running && (!this.review || stale > 0 || langMismatch);

    return v_flex().id("wf-explain").relative().track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.confirmActiveAi) { this.confirmActiveAi = null; cx.stop_propagation(); cx.notify(); return; }
          if (this.qaOpen) { this.qaOpen = false; cx.stop_propagation(); cx.notify(); return; }
          if (this.langOpen || this.bugHuntOpen) { this.langOpen = false; this.bugHuntOpen = false; cx.stop_propagation(); cx.notify(); }
        }
      })
      .on_mouse_move((e, cx) => {
        if (this.resizingRail) {
          const next = Math.max(140, Math.min(420, Math.round(this.resizingRail.startW + (e.position.x - this.resizingRail.startX))));
          if (next !== this.railWidth) { this.railWidth = next; cx.notify(); }
        } else if (this.resizingQa) {
          const next = Math.max(280, Math.min(620, Math.round(this.resizingQa.startW - (e.position.x - this.resizingQa.startX))));
          if (next !== this.qaWidth) { this.qaWidth = next; cx.notify(); }
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.resizingRail) {
          this.resizingRail = null;
          saveJson(LS_RAIL_W, this.railWidth);
          cx.notify();
        }
        if (this.resizingQa) {
          this.resizingQa = null;
          saveJson(LS_QA_W, this.qaWidth);
          cx.notify();
        }
      })
      // Top control bar
      .child(h_flex().h(38).flex_none().px(14).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .when(Boolean(this.review), el => el.child(div().id("ex-rail-toggle").size(24).flex_none().rounded(5)
          .bg(this.railOpen ? t.selected : t.raised).border(1).border_color(this.railOpen ? withAlpha(t.accent, "55") : t.border)
          .flex().items_center().justify_center().cursor_pointer()
          .hover(st => st.bg(t.hover))
          .tooltip(this.railOpen ? "Hide layers sidebar for wider code diff" : "Show layers sidebar")
          .on_click((_e, cx) => { this.railOpen = !this.railOpen; saveJson(LS_RAIL_OPEN, this.railOpen); cx.notify(); })
          .child(svg(this.railOpen ? "mods/workspace-chrome/chevron-left.svg" : "mods/workspace-chrome/chevron-right.svg").size(12).text_color(t.muted))))
        .child(svg("mods/workspace-chrome/git-compare.svg").size(13).flex_none().text_color(t.accent))
        .child(div().text_size(12.2).font_semibold().text_color(t.foreground).child("AI Explain"))
        .when(Boolean(s?.branch), el => el.child(h_flex().gap(5).items_center().min_w(0)
          .child(div().text_size(11).text_color(t.dim).child(s.baseRef || "base"))
          .child(div().text_size(10.5).text_color(t.dim).child("→"))
          .child(div().max_w(240).truncate().text_size(11.5).text_color(t.muted).tooltip(s.branch).child(s.branch))))
        .child(div().flex_1())
        // Language selector pill (remembers last chosen + lets you add any language)
        .child(h_flex().id("ex-lang").px(8).h(24).gap(4).items_center().rounded(5)
          .bg(this.langOpen ? t.selected : t.raised).border(1).border_color(this.langOpen ? withAlpha(t.accent, "66") : t.border)
          .text_size(11).text_color(this.langOpen ? t.foreground : t.muted).cursor_pointer().flex_none()
          .hover(st => st.bg(t.hover).text_color(t.foreground))
          .tooltip("Choose or add explanation language (defaults to your last pick)")
          .on_click((_e, cx) => { this.langOpen = !this.langOpen; if (this.langOpen) this.bugHuntOpen = false; cx.notify(); })
          .child(div().child(this.language))
          .child(svg("mods/workspace-chrome/chevron-down.svg").size(10).text_color(t.dim)))
        // Pass 2 bug-hunt threshold pill (configurable file count; skips tests/docs/generated)
        .child(h_flex().id("ex-bughunt").px(8).h(24).gap(4).items_center().rounded(5)
          .bg(this.bugHuntOpen ? t.selected : t.raised).border(1).border_color(this.bugHuntOpen ? withAlpha(t.accent, "66") : t.border)
          .text_size(11).text_color(this.bugHuntOpen ? t.foreground : t.muted).cursor_pointer().flex_none()
          .hover(st => st.bg(t.hover).text_color(t.foreground))
          .tooltip("Run a dedicated Pass 2 bug-hunt on production files when branch reaches this file count")
          .on_click((_e, cx) => { this.bugHuntOpen = !this.bugHuntOpen; if (this.bugHuntOpen) this.langOpen = false; cx.notify(); })
          .child(div().child(this.bugHuntMinFiles > 0 ? `2-pass: ${this.bugHuntMinFiles}+` : "2-pass: Off"))
          .child(svg("mods/workspace-chrome/chevron-down.svg").size(10).text_color(t.dim)))
        // Engine switcher pill (Claude / Codex / Gemini)
        .child(div().id("ex-engine").px(8).h(24).rounded(5).bg(t.raised).border(1).border_color(t.border)
          .flex().items_center().text_size(11).text_color(t.muted).cursor_pointer().flex_none()
          .hover(st => st.bg(t.hover).text_color(t.foreground))
          .tooltip("Click to switch AI engine (Claude / Codex / Gemini)")
          .on_click((_e, cx) => this.cycleEngine(cx))
          .child(`Engine: ${engineLabel}`))
        // Primary on-demand / incremental update button
        .child(div().id("ex-run").px(10).h(24).rounded(5).flex().items_center().text_size(11.2).font_medium().flex_none()
          .bg(primaryHighlight ? t.solid : t.raised)
          .border(1).border_color(primaryHighlight ? t.solid : t.border)
          .text_color(primaryHighlight ? t.solid_foreground : t.muted)
          .when(!this.running && Boolean(s?.root), el => el.cursor_pointer().hover(st => st.opacity(0.9)))
          .on_click((_e, cx) => {
            if (!this.running && s?.root) this.triggerExplain(cx, { full: langMismatch });
          })
          .child(primaryLabel))
        // Full re-run button (when a cached review exists)
        .when(Boolean(this.review) && !this.running, el => el.child(div().id("ex-full").px(8).h(24).rounded(5).flex_none()
          .bg(t.raised).border(1).border_color(t.border).flex().items_center().text_size(11).text_color(t.muted).cursor_pointer()
          .hover(st => st.bg(t.hover).text_color(t.foreground))
          .tooltip("Re-analyze every file from scratch (ignores cached file analyses)")
          .on_click((_e, cx) => this.triggerExplain(cx, { full: true }))
          .child("Full re-run")))
        // Q&A right-drawer toggle pill
        .when(Boolean(this.review), el => {
          const qaCount = Array.isArray(this.review?.qa) ? this.review.qa.length : 0;
          return el.child(h_flex().id("ex-qa-toggle").px(8).h(24).gap(5).items_center().rounded(5)
            .bg(this.qaOpen ? withAlpha(t.accent, "24") : t.raised)
            .border(1).border_color(this.qaOpen ? withAlpha(t.accent, "66") : t.border)
            .text_size(11).text_color(this.qaOpen ? t.accent : t.muted).cursor_pointer().flex_none()
            .hover(st => st.bg(t.hover).text_color(t.foreground))
            .tooltip("Toggle side Q&A drawer (keeps your diff full height)")
            .on_click((_e, cx) => {
              this.qaOpen = !this.qaOpen;
              if (this.qaOpen && !this.askScope) {
                this.askScope = { type: "branch", id: "", label: s?.branch || "this branch" };
              }
              cx.notify();
            })
            .child(div().child(qaCount > 0 ? `Q&A (${qaCount})` : "Q&A")));
        })
        // Refresh status button
        .child(div().id("ex-refresh").size(24).flex_none().rounded(5).bg(t.raised).border(1).border_color(t.border)
          .flex().items_center().justify_center().text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover(st => st.bg(t.hover).text_color(t.foreground))
          .tooltip("Check for newly modified files")
          .on_click((_e, cx) => this.loadStatus(cx))
          .child("↻")))
      // Language quick-pick & add bar (opens when Lang pill is clicked)
      .when(this.langOpen, el => el.child(h_flex().w_full().min_w(0).flex_none().px(14).py(7).gap(8).items_center().flex_wrap()
        .bg(t.raised + "88").border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child("Language:"))
        .children(this.languages.map((lang, i) => {
          const active = lang.toLowerCase() === this.language.toLowerCase();
          return div().id(`ex-lopt-${i}`).px(8).h(22).rounded(5).flex().items_center().text_size(11).cursor_pointer().flex_none()
            .bg(active ? withAlpha(t.accent, "28") : t.background)
            .border(1).border_color(active ? t.accent : t.border)
            .text_color(active ? t.accent : t.muted)
            .hover(st => st.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.selectLanguage(lang, cx))
            .child(lang);
        }))
        .child(h_flex().flex_1().min_w(180).max_w(280).gap(5).items_center()
          .child(div().flex_1().min_w(0).child(Input.new(this.langInput).h(24).px(8).items_center().rounded(5).border(1).border_color(t.border).bg(t.background).text_size(11).text_color(t.foreground)))
          .child(div().id("ex-lang-add").px(8).h(24).rounded(5).flex().items_center().text_size(11).font_medium().cursor_pointer().flex_none()
            .bg(t.solid).text_color(t.solid_foreground).hover(st => st.opacity(0.9))
            .on_click((_e, cx) => this.submitNewLanguage(cx))
            .child("Use")))))
      // Pass 2 bug-hunt threshold quick-pick bar
      .when(this.bugHuntOpen, el => el.child(h_flex().w_full().min_w(0).flex_none().px(14).py(7).gap(8).items_center().flex_wrap()
        .bg(t.raised + "88").border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child("Pass 2 bug-hunt (skips tests/docs):"))
        .children(BUG_HUNT_PRESETS.map((n, i) => {
          const active = this.bugHuntMinFiles === n;
          return div().id(`ex-bhopt-${i}`).px(8).h(22).rounded(5).flex().items_center().text_size(11).cursor_pointer().flex_none()
            .bg(active ? withAlpha(t.accent, "28") : t.background)
            .border(1).border_color(active ? t.accent : t.border)
            .text_color(active ? t.accent : t.muted)
            .hover(st => st.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.selectBugHuntMin(n, cx))
            .child(n === 0 ? "Off" : `${n}+ files`);
        }))
        .child(h_flex().flex_1().min_w(140).max_w(220).gap(5).items_center()
          .child(div().flex_1().min_w(0).child(Input.new(this.bugHuntInput).h(24).px(8).items_center().rounded(5).border(1).border_color(t.border).bg(t.background).text_size(11).text_color(t.foreground)))
          .child(div().id("ex-bh-set").px(8).h(24).rounded(5).flex().items_center().text_size(11).font_medium().cursor_pointer().flex_none()
            .bg(t.solid).text_color(t.solid_foreground).hover(st => st.opacity(0.9))
            .on_click((_e, cx) => this.submitCustomBugHuntMin(cx))
            .child("Set")))))
      // Running progress bar banner with Cancel button
      .when(this.running, el => el.child(h_flex().h(32).flex_none().px(14).gap(8).items_center()
        .bg(withAlpha(t.accent, "18")).border_b(1).border_color(withAlpha(t.accent, "44"))
        .child(div().size(8).flex_none().rounded_full().bg(t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.accent).child(this.runLabel || "Running AI Explain..."))
        .child(div().id("ex-cancel").px(9).h(22).rounded(5).flex().items_center().text_size(11).font_medium().cursor_pointer().flex_none()
          .bg(withAlpha(t.ansi1, "22")).border(1).border_color(withAlpha(t.ansi1, "66")).text_color(t.ansi1)
          .hover(st => st.bg(withAlpha(t.ansi1, "38")))
          .tooltip("Stop the running AI worker immediately (keeps previous cached review)")
          .on_click((_e, cx) => this.cancelExplain(cx))
          .child("Cancel"))))
      // Running follow-up Ask banner
      .when(this.askRunning, el => el.child(h_flex().h(30).flex_none().px(14).gap(8).items_center()
        .bg(withAlpha(t.accent, "14")).border_b(1).border_color(withAlpha(t.accent, "33"))
        .child(div().size(7).flex_none().rounded_full().bg(t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(11.2).text_color(t.accent).child(this.askLabel || "Answering question..."))))
      // Error banner
      .when(Boolean(this.error), el => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center()
        .bg(withAlpha(t.ansi1, "18")).border_b(1).border_color(withAlpha(t.ansi1, "44"))
        .child(div().flex_1().text_size(11.5).text_color(t.ansi1).whitespace_normal().child(this.error))
        .child(div().id("ex-err-x").size(18).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .on_click((_e, cx) => { this.error = null; cx.notify(); })
          .child(svg("mods/workspace-chrome/x.svg").size(11).text_color(t.ansi1)))))
      // Empty / Not yet generated state
      .when(!this.review && !this.running, el => el.child(v_flex().flex_1().min_h(0).items_center().justify_center().gap(10).p(24)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(
          !s?.root ? "Select a branch in the sidebar first" : `Ready to explain ${s.branch || "this branch"}`
        ))
        .child(div().max_w(460).text_size(12).text_color(t.muted).whitespace_normal().child(
          !s?.root
            ? "Open AI Explain from the Git sidebar on any branch to group its changes into review layers and highlight items that need attention."
            : `${totalFiles} changed ${totalFiles === 1 ? "file" : "files"} vs ${s.baseRef || "base"}. Runs locally via ${engineLabel} on demand, and future updates only re-analyze files whose diff changed.`
        ))
        .when(Boolean(s?.root), e => e.child(div().id("ex-start-cta").mt(6).px(16).h(32).rounded(7)
          .bg(t.solid).text_color(t.solid_foreground).flex().items_center().text_size(12.2).font_semibold().cursor_pointer()
          .hover(st => st.opacity(0.9))
          .on_click((_e, cx) => this.triggerExplain(cx, { full: false }))
          .child(`Generate Change Stack (${engineLabel})`)))))
      // Main 2-pane Change Stack body (Resizable Left Layers rail + Overview / Layer view)
      .when(Boolean(this.review), el => el.child(h_flex().flex_1().w_full().min_w(0).min_h(0).items_stretch().overflow_hidden()
        .when(this.railOpen, e => e
          .child(this.renderLeftRail(t, stats))
          .child(div().id("ex-rail-resize").w(5).flex_none().h_full().cursor_col_resize()
            .bg(this.resizingRail ? t.accent : t.border)
            .hover(st => st.bg(t.accent))
            .tooltip("Drag to resize Layers sidebar")
            .on_mouse_down("left", (ev, cx) => {
              cx.stop_propagation();
              this.resizingRail = { startX: ev.position.x, startW: this.railWidth };
              cx.notify();
            })))
        .child(this.viewMode === "layer" ? this.renderLayerView(t, stats) : this.renderOverview(t, stats))
        .when(this.qaOpen, e => e
          .child(div().id("ex-qa-resize").w(5).flex_none().h_full().cursor_col_resize()
            .bg(this.resizingQa ? t.accent : t.border)
            .hover(st => st.bg(t.accent))
            .tooltip("Drag to resize Q&A drawer")
            .on_mouse_down("left", (ev, cx) => {
              cx.stop_propagation();
              this.resizingQa = { startX: ev.position.x, startW: this.qaWidth };
              cx.notify();
            }))
          .child(this.renderQaDrawer(t)))))
      // Confirmation popup when an AI agent is actively modifying code in this branch
      .when(Boolean(this.confirmActiveAi), el => el.child(
        div().id("ex-ai-warn-backdrop").absolute().top(0).left(0).right(0).bottom(0)
          .bg("#00000088").flex().items_center().justify_center().p(20)
          .on_click((_e, cx) => { this.confirmActiveAi = null; cx.notify(); })
          .child(v_flex().id("ex-ai-warn-card").w(430).max_w_full().p(18).gap(12).rounded(10)
            .bg(t.chrome).border(1).border_color(withAlpha(t.blocked, "77"))
            .on_click((_e, cx) => cx.stop_propagation())
            .child(h_flex().gap(8).items_center()
              .child(div().size(9).flex_none().rounded_full().bg(t.blocked))
              .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(`${this.confirmActiveAi.agentName} is still active on this branch`)))
            .child(div().w_full().min_w(0).text_size(12).text_color(t.muted).whitespace_normal()
              .child("Are you sure you want to generate an AI explanation while an AI in this branch is still working? It may edit files mid-run that the explainer misses or misreads."))
            .child(h_flex().pt(4).gap(8).justify_end()
              .child(div().id("ex-ai-warn-cancel").px(12).h(28).rounded(6).flex().items_center().text_size(11.5).cursor_pointer()
                .bg(t.raised).border(1).border_color(t.border).text_color(t.muted).hover(st => st.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => { this.confirmActiveAi = null; cx.notify(); })
                .child("Cancel"))
              .child(div().id("ex-ai-warn-go").px(12).h(28).rounded(6).flex().items_center().text_size(11.5).font_semibold().cursor_pointer()
                .bg(withAlpha(t.blocked, "28")).border(1).border_color(t.blocked).text_color(t.blocked).hover(st => st.bg(withAlpha(t.blocked, "40")))
                .on_click((_e, cx) => {
                  const full = Boolean(this.confirmActiveAi?.full);
                  this.triggerExplain(cx, { full, force: true });
                })
                .child("Generate anyway"))))));
  }
}
