// Dedicated TeamCity Sakura-inspired CI/CD tab for herdr-app.
// Opened via tab.new { mod: "wf-ci", props: { repo, dir, slug, workflow?, runId? } } when
// clicking any workflow pill or bar on a repository's sidebar CI strip.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor } from "gpui-base";
import { theme, shared, setShared, notify, checking, nextCommand } from "herdr";
import {
  DEFAULT_CI_SETTINGS, mergeCiSettings, defaultShortName, repoInfo,
  repoCiSnapshot, branchCiSnapshot, ciTrends, runJobs, jobAnnotations, runLog, sliceStepLog, rerunWorkflow, formatDuration,
  createCiCache, isCacheableState, pickDefaultJob, logCacheKey,
} from "./lib/wf/index.js";
import { exec, fs, wf, CI_CACHE_DIR, track, flushTelemetry } from "./lib/wf/herdr-adapter.js";

const ACTIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 20000;
const RECENCY_CHOICES = [3, 7, 14, 30];

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function withAlpha(hex, aa) {
  const s = String(hex || "#888888");
  return s.length === 9 && s.startsWith("#") ? s.slice(0, 7) + aa : s.length === 7 && s.startsWith("#") ? s + aa : s;
}

function barColor(t, state) {
  if (state === "failed") return "#ef4444";
  if (state === "passed") return "#22c55e";
  if (state === "queued") return "#15803d";
  if (state === "running") return "#16a34a";
  return t.dim;
}

function statusBadge(t, state) {
  const col = barColor(t, state);
  const label = state === "passed" ? "passed" : state === "failed" ? "failed" : state === "running" ? "running" : state === "queued" ? "queued" : state || "unknown";
  return h_flex().px(6).h(18).rounded(4).gap(4).items_center().bg(withAlpha(col, "22")).border(1).border_color(withAlpha(col, "55"))
    .child(div().size(6).rounded_full().bg(col).when(state === "running" || state === "queued", el => el.loop("opacity", { from: 0.4, to: 1, period: 1200 })))
    .child(div().text_size(10).font_semibold().text_color(col).child(label));
}

export default class WorkflowCiTab extends View {
  init(props, cx) {
    const focusInit = shared("wf.ciFocus");
    this.repo = props?.repo || focusInit?.repo || shared("wf.repo")?.name || "";
    this.dir = props?.dir || focusInit?.dir || shared("wf.repo")?.dir || "";
    this.slug = props?.slug || focusInit?.slug || "";
    this.tab = (props?.tab || focusInit?.tab) === "settings" ? "settings" : "overview"; // "overview" | "settings"
    this.snapshot = null;
    this.trends = [];
    this.loading = false;
    this.error = null;

    this.selectedWorkflow = props?.workflow || focusInit?.workflow || null;
    this.selectedRunId = props?.runId || focusInit?.runId || null;
    this.branchScope = (!this.selectedWorkflow && (props?.branch || focusInit?.branch)) || null;
    this.focusBranch = this.branchScope;
    this.inspectorView = "summary"; // "summary" (fast jobs/steps/errors) | "logs" (on-demand Editor logs)
    this.jobsByRun = {};        // runId -> { loading, list }
    this.openJobs = new Map();  // jobId -> boolean (override; default: expanded so all steps are visible)
    this.openSteps = new Set(); // `${jobId}:${stepNumber}` expanded inline step log drawers
    this.stepEditors = new Map(); // stepKey -> { editor: EditorState, text, totalLines, startLine }
    this.jobLogByJob = {};      // jobId -> { loading, text, cached, error } for inline step log slicing
    this.pendingJump = null;    // { jobId, step, nextStep } jump-cut target when opening Full Editor
    this.jumpOffsetLine = 0;    // 0-based start line index when jump-cut into Full Editor (0 = from line 1)
    this.jumpedLabel = null;    // e.g. "Step 8 · line 1241" shown after jump-cut
    this.annotationsByJob = {}; // jobId -> [{ level, path, line, title, message }]
    this.selectedJobId = null;  // null = all jobs, number = specific job
    this.logMode = "failed";    // "failed" | "full"
    this.logState = { loading: false, raw: "", error: null, key: null, truncated: false, totalLines: 0, cached: false };
    this.logFilter = "";
    this.wfSearch = "";
    this.rerunning = new Set();
    this.lastFocusTs = focusInit?.ts ?? 0;
    this.cache = createCiCache({ fs, dir: CI_CACHE_DIR });
    this.inFlightLogs = new Map(); // cacheKey -> Promise
    this.inFlightJobs = new Map(); // runId -> Promise
    this.lastPollAt = 0;
    this.prefetchGen = 0;

    // Settings editor states (retained across renders)
    this.shortInputs = new Map(); // lowercase workflow name -> InputState
    this.wfSearchInput = InputState.new({ value: "", placeholder: "Search workflows" });
    this.wfSearchInput.on("change", (_e, cx) => { this.wfSearch = this.wfSearchInput.value(); cx.notify(); });
    this.branchInput = InputState.new({ value: "", placeholder: "Default branch (e.g. main)" });
    this.branchInput.on("submit", (_e, cx) => this.saveBranchOverride(cx));

    this.logFilterInput = InputState.new({ value: "", placeholder: "Filter log lines..." });
    this.logFilterInput.on("change", (_e, cx) => {
      this.logFilter = this.logFilterInput.value();
      this.syncEditorText();
      cx.notify();
    });

    this.logEditor = EditorState.new({
      value: "Select a build to inspect its jobs and logs.",
      readonly: true,
      line_numbers: true,
      folding: false,
      soft_wrap: false,
      font_size: 11.5,
    });

    this.handle = cx.focus_handle();
    if (checking()) return;

    this.syncBranchInputFromSettings();
    this.hydrateFromCache(cx);
    this.refresh(cx, { selectRunId: this.selectedRunId });
    cx.timer.every(ACTIVE_POLL_MS, cx => {
      if (this.tab !== "overview") return;
      const hasActive = this.trends.some(tr => tr.latest?.state === "running" || tr.latest?.state === "queued");
      if (!hasActive && Date.now() - this.lastPollAt < IDLE_POLL_MS) return;
      this.refresh(cx, { quiet: true });
    });
    cx.spawn(async cx => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
  }

  // Paints cached snapshot + jobs + logs immediately (<15ms) while live refresh runs in the background.
  hydrateFromCache(cx) {
    if (!this.slug || this.branchScope) return;
    cx.spawn(async cx => {
      const snap = await this.cache.getSnapshot(this.slug);
      if (!snap || this.snapshot || this.branchScope) return;
      this.applySnapshot(snap, cx, { selectRunId: this.selectedRunId });
    });
  }

  applySnapshot(snap, cx, { selectRunId = null } = {}) {
    const cfg = this.ciSettings();
    this.snapshot = snap;
    this.ensureShortInputs();
    this.trends = ciTrends(snap, { limit: cfg.runsPerWorkflow, recencyDays: cfg.recencyDays });
    this.error = null;

    if (this.focusBranch && !selectRunId) {
      const br = this.focusBranch;
      const candidates = [];
      for (const tr of this.trends) {
        const latestOnBranch = [...tr.bars].reverse().find(b => b.branch === br);
        if (latestOnBranch) candidates.push({ wfName: tr.name, bar: latestOnBranch });
      }
      if (candidates.length) {
        const rank = s => s === "failed" ? 3 : (s === "running" || s === "queued") ? 2 : 1;
        candidates.sort((a, b) => rank(b.bar.state) - rank(a.bar.state) || (b.bar.createdMs ?? 0) - (a.bar.createdMs ?? 0));
        this.selectedWorkflow = candidates[0].wfName;
        this.selectedRunId = candidates[0].bar.id;
        this.focusBranch = null;
      }
    }

    if (!this.selectedWorkflow || !this.trends.some(tr => tr.name === this.selectedWorkflow)) {
      this.selectedWorkflow = this.trends[0]?.name ?? null;
    }
    const wf = this.trends.find(tr => tr.name === this.selectedWorkflow);
    const wantRun = selectRunId ?? this.selectedRunId;
    const foundRun = wf?.bars.find(b => b.id === wantRun);
    if (foundRun) {
      this.selectedRunId = foundRun.id;
    } else if (wf?.bars.length) {
      this.selectedRunId = wf.bars[wf.bars.length - 1].id;
    } else {
      this.selectedRunId = null;
    }
    if (this.selectedRunId) {
      const bar = this.currentRun();
      if (bar && !this.jobsByRun[bar.id]) {
        this.logMode = bar.state === "failed" ? "failed" : "full";
        this.loadRunDetails(bar, cx);
      }
    }
    cx.notify();
  }

  ciSettings() {
    return mergeCiSettings(shared("wf.ciSettings"));
  }

  saveCiSettings(next, cx) {
    const payload = { ...mergeCiSettings(next), ts: Date.now() };
    setShared("wf.ciSettings", payload);
    cx.notify();
    this.refresh(cx, { forceMeta: true });
  }

  syncBranchInputFromSettings() {
    const cfg = this.ciSettings();
    const ov = this.slug ? cfg.overrides?.[this.slug] : null;
    const val = (typeof ov?.branch === "string" ? ov.branch : cfg.branch) || "";
    if (this.branchInput.value() !== val) this.branchInput.set_value(val);
  }

  // Must ONLY be called from init, event handlers, or async callbacks — NEVER inside render().
  ensureShortInputs() {
    const cfg = this.ciSettings();
    const ov = this.slug ? cfg.overrides?.[this.slug] : null;
    const allWf = this.snapshot?.allWorkflows ?? [];
    for (const w of allWf) {
      const k = w.name.toLowerCase();
      if (this.shortInputs.has(k)) continue;
      const curShort = ov?.shorts?.[k]
        ?? cfg.shorts?.[k]
        ?? cfg.workflows.find(x => x.name.toLowerCase() === k)?.short
        ?? "";
      const st = InputState.new({ value: curShort, placeholder: "Short name" });
      st.on("submit", (_e, cx) => this.saveShortName(w.name, cx));
      this.shortInputs.set(k, st);
    }
  }

  openSettingsTab(cx) {
    this.tab = "settings";
    this.syncBranchInputFromSettings();
    this.ensureShortInputs();
    cx.notify();
  }

  command(c, cx) {
    const [name, arg] = String(c).split(/:(.*)/s);
    if (name === "refresh") { this.refresh(cx, { forceMeta: true }); return; }
    if (name === "tab") {
      if (arg === "settings") this.openSettingsTab(cx);
      else { this.tab = "overview"; cx.notify(); }
      return;
    }
    if (name === "select-wf" && arg) {
      this.tab = "overview";
      this.selectWorkflow(arg, cx);
      return;
    }
    if (name === "view") {
      this.tab = "overview";
      if (arg === "logs") this.openLogsView(cx);
      else { this.inspectorView = "summary"; cx.notify(); }
      return;
    }
    if (name === "toggle-step") {
      const bar = this.currentRun();
      const jobs = bar ? (this.jobsByRun[bar.id]?.list ?? []) : [];
      const [jiStr, siStr] = String(arg || "0:0").split(":");
      const job = jobs[Number(jiStr) || 0];
      const step = job?.steps?.[Number(siStr) || 0];
      if (bar && job && step) this.toggleStepNode(bar, job, step, cx);
      return;
    }
    if (name === "jump-step") {
      const bar = this.currentRun();
      const jobs = bar ? (this.jobsByRun[bar.id]?.list ?? []) : [];
      const [jiStr, siStr] = String(arg || "0:4").split(":");
      const job = jobs[Number(jiStr) || 0];
      const step = job?.steps?.[Number(siStr) || 0];
      const nextStep = job?.steps?.find(ns => ns.number > step?.number && ns.startedMs != null) ?? null;
      if (bar && job && step) this.openLogsView(cx, { jobId: job.id, jumpToStep: step, nextStep });
      return;
    }
  }

  refresh(cx, { forceMeta = false, quiet = false, selectRunId = null } = {}) {
    if (!quiet) { this.loading = true; this.error = null; cx.notify(); }
    cx.spawn(async cx => {
      try {
        if (!this.slug && this.dir) {
          const info = await repoInfo(exec, this.dir).catch(() => null);
          this.slug = info?.slug || "";
        }
        if (!this.slug) {
          this.error = "No GitHub repository slug available.";
          return;
        }
        const cfg = this.ciSettings();
        const scopeBranch = this.branchScope;
        const snap = scopeBranch
          ? await branchCiSnapshot(exec, this.dir || ".", this.slug, scopeBranch, cfg, { forceMeta })
          : await repoCiSnapshot(exec, this.dir || ".", this.slug, cfg, { forceMeta });
        if (this.branchScope !== scopeBranch) return;
        if (!snap) {
          if (!this.snapshot) this.error = `Could not fetch GitHub Actions runs for ${this.slug}.`;
          return;
        }
        if (!scopeBranch) await this.cache.setSnapshot(this.slug, snap);
        this.lastPollAt = Date.now();
        this.applySnapshot(snap, cx, { selectRunId });
        this.warmLatestJobs(cx);
      } catch (e) {
        if (!this.snapshot) this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  currentWorkflow() {
    return this.trends.find(tr => tr.name === this.selectedWorkflow) ?? this.trends[0] ?? null;
  }

  currentRun() {
    const wf = this.currentWorkflow();
    if (!wf) return null;
    return wf.bars.find(b => b.id === this.selectedRunId) ?? wf.bars[wf.bars.length - 1] ?? null;
  }

  releaseStepEditors() {
    for (const entry of this.stepEditors.values()) {
      try { entry.editor.release(); } catch {}
    }
    this.stepEditors.clear();
    this.openSteps.clear();
  }

  selectWorkflow(name, cx, runId = null) {
    this.selectedWorkflow = name;
    const wf = this.trends.find(tr => tr.name === name);
    const target = (runId && wf?.bars.find(b => b.id === runId)) || wf?.bars[wf.bars.length - 1] || null;
    this.selectedRunId = target?.id ?? null;
    this.selectedJobId = null;
    this.inspectorView = "summary";
    this.pendingJump = null;
    this.jumpOffsetLine = 0;
    this.jumpedLabel = null;
    this.releaseStepEditors();
    if (target) {
      this.logMode = target.state === "failed" ? "failed" : "full";
      this.loadRunDetails(target, cx);
    }
    cx.notify();
  }

  selectRun(bar, cx) {
    if (!bar) return;
    this.selectedRunId = bar.id;
    this.selectedJobId = null;
    this.inspectorView = "summary";
    this.pendingJump = null;
    this.jumpOffsetLine = 0;
    this.jumpedLabel = null;
    this.releaseStepEditors();
    this.logMode = bar.state === "failed" ? "failed" : "full";
    this.loadRunDetails(bar, cx);
    cx.notify();
  }

  // Explicitly opens the Full Logs Editor (one screen depth away); if jumpToStep is passed,
  // clears any text filter and jump-cuts the Editor cursor straight to that step's first line.
  openLogsView(cx, { jobId = undefined, failedOnly = undefined, jumpToStep = null, nextStep = null } = {}) {
    const bar = this.currentRun();
    if (!bar) return;
    const jobs = this.jobsByRun[bar.id]?.list ?? [];
    if (jobId !== undefined) {
      this.selectedJobId = jobId;
    } else if (this.selectedJobId === null) {
      const picked = pickDefaultJob(jobs);
      if (picked) this.selectedJobId = picked.id;
    }
    if (failedOnly !== undefined) {
      this.logMode = failedOnly ? "failed" : "full";
    }
    if (jumpToStep) {
      if (this.logFilter) {
        this.logFilter = "";
        this.logFilterInput.set_value("");
      }
      this.pendingJump = { jobId: this.selectedJobId, step: jumpToStep, nextStep };
      this.jumpOffsetLine = 0;
      this.jumpedLabel = null;
    } else {
      this.pendingJump = null;
      this.jumpOffsetLine = 0;
      this.jumpedLabel = null;
    }
    this.inspectorView = "logs";
    this.loadLogs(cx);
    // If the same job log is already loaded in the Editor, apply the jump-cut immediately!
    if (this.pendingJump && !this.logState.loading && this.logState.raw) {
      this.applyPendingJump();
    } else if (!jumpToStep && !this.logState.loading && this.logState.raw) {
      this.syncEditorText();
    }
    cx.notify();
  }

  applyPendingJump() {
    const jmp = this.pendingJump;
    if (!jmp || this.logFilter.trim() || this.logState.loading || this.logState.error) return;
    if (jmp.jobId !== this.selectedJobId) return;
    const sliced = sliceStepLog(this.logState.raw, jmp.step, jmp.nextStep);
    this.pendingJump = null;
    if (sliced.startLine != null && sliced.startLine > 1) {
      this.jumpOffsetLine = sliced.startLine - 1;
      this.jumpedLabel = `Step ${jmp.step.number} · line ${sliced.startLine}`;
    } else {
      this.jumpOffsetLine = 0;
      this.jumpedLabel = `Step ${jmp.step.number}`;
    }
    this.syncEditorText();
  }

  fetchLogDedup(opts) {
    const k = logCacheKey(opts);
    if (!opts.force && this.inFlightLogs.has(k)) return this.inFlightLogs.get(k);
    const p = runLog(exec, this.dir || ".", this.slug, { ...opts, cache: this.cache })
      .finally(() => { if (this.inFlightLogs.get(k) === p) this.inFlightLogs.delete(k); });
    this.inFlightLogs.set(k, p);
    return p;
  }

  // Ensures a retained read-only EditorState exists for an open step (NEVER called from render()).
  syncStepEditor(job, step) {
    const stepKey = `${job.id}:${step.number}`;
    const jlog = this.jobLogByJob[job.id];
    const nextStep = job.steps.find(ns => ns.number > step.number && ns.startedMs != null) ?? null;
    let entry = this.stepEditors.get(stepKey);
    if (!entry) {
      entry = {
        editor: EditorState.new({
          value: jlog?.loading ? "Retrieving step logs from GitHub..." : "",
          readonly: true,
          line_numbers: true,
          folding: false,
          soft_wrap: false,
          font_size: 11,
        }),
        text: "",
        totalLines: 0,
        startLine: null,
      };
      this.stepEditors.set(stepKey, entry);
    }
    if (jlog && !jlog.loading && !jlog.error) {
      const sliced = sliceStepLog(jlog.text, step, nextStep);
      if (entry.text !== sliced.text) {
        entry.text = sliced.text;
        entry.totalLines = sliced.totalLines;
        entry.startLine = sliced.startLine;
        entry.editor.set_value(sliced.text);
      }
    } else if (jlog?.error) {
      const msg = `Error loading step log:\n${jlog.error}`;
      if (entry.text !== msg) {
        entry.text = msg;
        entry.totalLines = 0;
        entry.editor.set_value(msg);
      }
    }
    return entry;
  }

  // Clicking an individual step node toggles its compact scrollable Editor drawer and fetches
  // that job's log on demand (cached in memory + disk so subsequent step clicks are instant).
  toggleStepNode(bar, job, step, cx) {
    const stepKey = `${job.id}:${step.number}`;
    if (this.openSteps.has(stepKey)) {
      this.openSteps.delete(stepKey);
      const old = this.stepEditors.get(stepKey);
      if (old) { try { old.editor.release(); } catch {} this.stepEditors.delete(stepKey); }
      cx.notify();
      return;
    }
    this.openSteps.add(stepKey);
    this.syncStepEditor(job, step);
    cx.notify();
    const existing = this.jobLogByJob[job.id];
    if (existing && !existing.error && (existing.loading || existing.text)) return;
    this.loadJobLogForSteps(bar, job, cx);
  }

  loadJobLogForSteps(bar, job, cx, { force = false } = {}) {
    if (!bar || !job || !this.slug) return;
    const attempt = bar.attempt ?? 1;
    const cacheable = isCacheableState(bar.state) && isCacheableState(job.state);
    this.jobLogByJob[job.id] = { loading: true, text: "", cached: false, error: null };
    cx.notify();
    cx.spawn(async cx => {
      const res = await this.fetchLogDedup({
        slug: this.slug, runId: bar.id, jobId: job.id, failedOnly: false, cacheable, attempt, force,
      });
      this.jobLogByJob[job.id] = {
        loading: false,
        text: res.text || "",
        cached: Boolean(res.cached),
        error: res.error || null,
      };
      // Populate every currently open step Editor for this job outside render()
      for (const s of job.steps ?? []) {
        if (this.openSteps.has(`${job.id}:${s.number}`)) {
          this.syncStepEditor(job, s);
        }
      }
      cx.notify();
    });
  }

  async fetchJobsFast(bar, { force = false } = {}) {
    const runId = bar.id;
    const attempt = bar.attempt ?? 1;
    const cacheable = isCacheableState(bar.state);
    if (!force && cacheable) {
      const hit = await this.cache.getJobs(this.slug, runId, attempt);
      if (hit) return { jobs: hit, error: null };
    }
    if (!force && this.inFlightJobs.has(runId)) return this.inFlightJobs.get(runId);

    const p = (async () => {
      try {
        const batch = await wf(["ci-jobs", "--slug", this.slug, "--runs", String(runId)]);
        const entry = batch?.runs?.[String(runId)];
        if (entry && !entry.error && Array.isArray(entry.jobs)) {
          if (cacheable && entry.jobs.length && entry.jobs.every(j => j.state !== "running" && j.state !== "queued")) {
            await this.cache.setJobs(this.slug, runId, attempt, entry.jobs);
          }
          return { jobs: entry.jobs, error: null };
        }
        // Fallback to direct gh api if wf ci-jobs failed
        const fallback = await runJobs(exec, this.dir || ".", this.slug, runId, {
          cache: this.cache, cacheable, attempt, force,
        });
        return { jobs: fallback, error: entry?.error && !fallback.length ? entry.error : null };
      } catch (e) {
        return { jobs: [], error: String(e?.message ?? e) };
      } finally {
        if (this.inFlightJobs.get(runId) === p) this.inFlightJobs.delete(runId);
      }
    })();
    this.inFlightJobs.set(runId, p);
    return p;
  }

  loadRunDetails(bar, cx, { force = false } = {}) {
    if (!bar || !this.slug) return;
    const runId = bar.id;
    this.jobsByRun[runId] = { loading: true, list: this.jobsByRun[runId]?.list ?? [], error: null };
    cx.notify();
    cx.spawn(async cx => {
      try {
        const { jobs, error } = await this.fetchJobsFast(bar, { force });
        this.jobsByRun[runId] = { loading: false, list: jobs, error };
        if (this.selectedRunId === runId && this.selectedJobId === null) {
          const picked = pickDefaultJob(jobs);
          if (picked) this.selectedJobId = picked.id;
        }
        cx.notify();

        // Fetch lightweight check-run annotations (exact error messages!) for failed jobs only.
        const failedJobs = jobs.filter(j => j.state === "failed");
        if (failedJobs.length) {
          await Promise.all(failedJobs.map(async j => {
            const anns = await jobAnnotations(exec, this.dir || ".", this.slug, j.id, {
              cache: this.cache, cacheable: isCacheableState(j.state), force,
            }).catch(() => []);
            this.annotationsByJob[j.id] = anns;
          }));
          cx.notify();
        }

        // NEVER auto-fetch heavy raw logs on Summary — only fetch logs if user is already in Logs view.
        if (this.selectedRunId === runId && this.inspectorView === "logs") {
          this.loadLogs(cx, { force });
        }
      } catch (e) {
        this.jobsByRun[runId] = { loading: false, list: this.jobsByRun[runId]?.list ?? [], error: String(e?.message ?? e) };
        cx.notify();
      }
    });
  }

  // Warms jobs for the latest build of ALL watched workflows + next 2 runs in ONE single
  // HTTP keep-alive batch call (never fetches raw logs!) so switching workflow cards is 0ms instant.
  warmLatestJobs(cx) {
    if (!this.slug || !this.trends.length) return;
    const gen = ++this.prefetchGen;
    const candidates = [];
    const seen = new Set();
    const addBar = b => {
      if (!b?.id || seen.has(b.id) || !isCacheableState(b.state)) return;
      seen.add(b.id);
      candidates.push(b);
    };
    for (const tr of this.trends) addBar(tr.bars[tr.bars.length - 1]);
    const wfCur = this.currentWorkflow();
    for (const b of (wfCur?.bars ?? []).slice().reverse().slice(0, 3)) addBar(b);

    cx.spawn(async cx => {
      const missing = [];
      for (const b of candidates) {
        if (this.jobsByRun[b.id]?.list?.length) continue;
        const hit = await this.cache.getJobs(this.slug, b.id, b.attempt ?? 1);
        if (hit) {
          this.jobsByRun[b.id] = { loading: false, list: hit, error: null };
        } else {
          missing.push(b);
        }
      }
      if (!missing.length || this.prefetchGen !== gen) { cx.notify(); return; }
      const batch = await wf(["ci-jobs", "--slug", this.slug, "--runs", missing.map(b => b.id).join(",")]).catch(() => null);
      if (!batch?.runs || this.prefetchGen !== gen) return;
      for (const b of missing) {
        const entry = batch.runs[String(b.id)];
        if (entry && !entry.error && Array.isArray(entry.jobs) && entry.jobs.length) {
          this.jobsByRun[b.id] = { loading: false, list: entry.jobs, error: null };
          if (entry.jobs.every(j => j.state !== "running" && j.state !== "queued")) {
            await this.cache.setJobs(this.slug, b.id, b.attempt ?? 1, entry.jobs);
          }
        }
      }
      cx.notify();
    });
  }

  loadLogs(cx, { force = false } = {}) {
    const bar = this.currentRun();
    if (!bar || !this.slug) return;
    const jobId = this.selectedJobId;
    const failedOnly = !jobId && this.logMode === "failed";
    const attempt = bar.attempt ?? 1;
    const cacheable = isCacheableState(bar.state);
    const key = `${bar.id}:${jobId ?? "all"}:${failedOnly ? "f" : "a"}:a${attempt}`;
    if (!force && this.logState.key === key && !this.logState.loading) return;

    this.logState = { loading: true, raw: "", error: null, key, truncated: false, totalLines: 0, cached: false };
    this.logEditor.set_value("Retrieving GitHub Actions logs...");
    cx.notify();

    cx.spawn(async cx => {
      const res = await this.fetchLogDedup({
        slug: this.slug, runId: bar.id, jobId, failedOnly, cacheable, attempt, force,
      });
      if (this.logState.key !== key) return;
      if ((res.error || !res.text.trim()) && failedOnly) {
        const full = await this.fetchLogDedup({
          slug: this.slug, runId: bar.id, jobId, failedOnly: false, cacheable, attempt, force,
        });
        if (this.logState.key !== key) return;
        this.logMode = "full";
        this.logState = {
          loading: false,
          raw: full.text || "(No log output yet — build may still be queued or running.)",
          error: full.error, key, truncated: full.truncated, totalLines: full.totalLines ?? 0, cached: Boolean(full.cached),
        };
      } else {
        this.logState = {
          loading: false,
          raw: res.text || "(No log output returned.)",
          error: res.error, key, truncated: res.truncated, totalLines: res.totalLines ?? 0, cached: Boolean(res.cached),
        };
      }
      this.syncEditorText();
      this.applyPendingJump();
      cx.notify();
    });
  }

  syncEditorText() {
    if (this.logState.loading) return;
    const raw = this.logState.error ? `Error loading log:\n${this.logState.error}` : this.logState.raw;
    const q = this.logFilter.trim().toLowerCase();
    if (!q) {
      if (this.jumpOffsetLine > 0 && !this.logState.error) {
        const lines = raw.split("\n");
        const tail = lines.slice(this.jumpOffsetLine);
        this.logEditor.set_value([
          `--- Jumped to ${this.jumpedLabel || `line ${this.jumpOffsetLine + 1}`} (${this.jumpOffsetLine} earlier lines above; click "From line 1" to view top) ---`,
          ...tail,
        ].join("\n"));
        return;
      }
      this.logEditor.set_value(raw);
      return;
    }
    const matched = raw.split("\n").filter(l => l.toLowerCase().includes(q));
    this.logEditor.set_value(matched.length ? matched.join("\n") : `(No log lines matching "${this.logFilter.trim()}")`);
  }

  triggerRerun(runId, failedOnly, cx) {
    if (!runId || this.rerunning.has(runId)) return;
    this.rerunning.add(runId);
    cx.notify();
    track("ui", { surface: "wf-ci", action: failedOnly ? "rerun-failed" : "rerun-all", slug: this.slug });
    cx.spawn(async cx => {
      const r = await rerunWorkflow(exec, this.dir || ".", this.slug, runId, { failedOnly });
      this.rerunning.delete(runId);
      if (r.ok) {
        notify({ title: failedOnly ? "Re-running failed jobs" : "Re-running workflow", body: `Run #${runId}`, level: "success", timeout: 2200 });
        cx.timer.after(2000, cx => this.refresh(cx, { quiet: true }));
      } else {
        notify({ title: "Re-run failed", body: r.error, level: "error" });
      }
      flushTelemetry();
      cx.notify();
    });
  }

  // ------------------------------------------------------------------ Settings mutations

  currentWatchedSet() {
    const cfg = this.ciSettings();
    const ov = this.slug ? cfg.overrides?.[this.slug] : null;
    if (Array.isArray(ov?.watch)) return new Set(ov.watch.map(n => n.toLowerCase()));
    return new Set(this.trends.map(tr => tr.name.toLowerCase()));
  }

  toggleWatchWorkflow(wfName, cx) {
    if (!this.slug) return;
    const cfg = this.ciSettings();
    const ov = { ...(cfg.overrides?.[this.slug] ?? {}) };
    const cur = new Set(Array.isArray(ov.watch) ? ov.watch.map(n => n.toLowerCase()) : this.trends.map(tr => tr.name.toLowerCase()));
    const k = wfName.toLowerCase();
    let list = Array.isArray(ov.watch) ? [...ov.watch] : this.trends.map(tr => tr.name);
    if (cur.has(k)) {
      list = list.filter(n => n.toLowerCase() !== k);
    } else {
      list.push(wfName);
    }
    ov.watch = list;
    this.saveCiSettings({ ...cfg, overrides: { ...cfg.overrides, [this.slug]: ov } }, cx);
  }

  saveShortName(wfName, cx) {
    const st = this.shortInputs.get(wfName.toLowerCase());
    if (!st) return;
    const val = st.value().trim();
    const cfg = this.ciSettings();
    const shorts = { ...(cfg.shorts ?? {}) };
    if (val) shorts[wfName.toLowerCase()] = val;
    else delete shorts[wfName.toLowerCase()];
    this.saveCiSettings({ ...cfg, shorts }, cx);
  }

  commitAllShortNames(cx) {
    const cfg = this.ciSettings();
    const shorts = { ...(cfg.shorts ?? {}) };
    let changed = false;
    for (const [k, st] of this.shortInputs.entries()) {
      const val = st.value().trim();
      const prev = shorts[k] ?? "";
      if (val !== prev) {
        if (val) shorts[k] = val;
        else delete shorts[k];
        changed = true;
      }
    }
    const brVal = this.branchInput.value().trim();
    const ov = { ...(cfg.overrides?.[this.slug] ?? {}) };
    const prevBr = ov.branch ?? "";
    if (brVal !== prevBr) {
      if (brVal) ov.branch = brVal;
      else delete ov.branch;
      changed = true;
    }
    if (changed) {
      const overrides = this.slug ? { ...cfg.overrides, [this.slug]: ov } : cfg.overrides;
      this.saveCiSettings({ ...cfg, shorts, overrides }, cx);
    }
    this.tab = "overview";
    cx.notify();
  }

  saveBranchOverride(cx) {
    if (!this.slug) return;
    const val = this.branchInput.value().trim();
    const cfg = this.ciSettings();
    const ov = { ...(cfg.overrides?.[this.slug] ?? {}) };
    if (val) ov.branch = val;
    else delete ov.branch;
    this.saveCiSettings({ ...cfg, overrides: { ...cfg.overrides, [this.slug]: ov } }, cx);
    notify({ title: "CI branch updated", body: val || `Default (${this.snapshot?.defaultBranch || "main"})`, level: "success", timeout: 1600 });
  }

  setRecencyDays(days, cx) {
    const cfg = this.ciSettings();
    this.saveCiSettings({ ...cfg, recencyDays: days }, cx);
  }

  resetRepoSettings(cx) {
    const cfg = this.ciSettings();
    const overrides = { ...cfg.overrides };
    delete overrides[this.slug];
    for (const st of this.shortInputs.values()) {
      try { st.release(); } catch {}
    }
    this.shortInputs.clear();
    this.saveCiSettings({ ...cfg, overrides }, cx);
    this.ensureShortInputs();
    this.branchInput.set_value("");
    notify({ title: "Reset to defaults", body: this.repo || this.slug, level: "info", timeout: 1800 });
  }

  // ------------------------------------------------------------------ Rendering

  renderTrendsCards(t) {
    if (!this.trends.length) {
      return div().flex_none().p(14).rounded(7).border(1).border_color(t.border).bg(t.raised)
        .text_size(12).text_color(t.dim)
        .child(this.loading ? "Loading GitHub Actions workflows..." : (this.error || "No watched workflows matched. Open Settings to pick workflows."));
    }

    return h_flex().flex_none().flex_wrap().gap(8).items_stretch()
      .children(this.trends.map((tr, ti) => {
        const isSelWf = tr.name === (this.currentWorkflow()?.name);
        const lat = tr.latest;
        const latState = lat?.state ?? "cancelled";
        const latCol = barColor(t, latState);
        const dur = lat?.durationSec ? formatDuration(lat.durationSec) : "";
        const when = lat?.createdMs ? ago(lat.createdMs) : "";

        return v_flex().id(`ci-card-${ti}`).flex_1().min_w(215).p(10).gap(8).rounded(7).cursor_pointer()
          .bg(isSelWf ? t.selected : t.raised)
          .border(1).border_color(isSelWf ? t.accent : (latState === "failed" ? t.ansi1 + "77" : t.border))
          .hover(s => s.border_color(isSelWf ? t.accent : t.muted))
          .on_click((_e, cx) => this.selectWorkflow(tr.name, cx))
          // Card header
          .child(h_flex().gap(6).items_center()
            .child(div().size(8).flex_none().rounded_full().bg(latCol)
              .when(latState === "running" || latState === "queued", el => el.loop("opacity", { from: 0.4, to: 1, period: 1200 })))
            .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(tr.name))
            .child(div().flex_none().px(5).h(16).rounded(4).flex().items_center().text_size(9.5)
              .bg(t.background).text_color(t.dim).child(tr.source === "pr" ? "PRs" : (tr.branch || "main"))))
          // Sakura duration histogram (oldest left -> newest right, height = duration)
          .child(h_flex().h(46).gap(3).items_end().pt(2)
            .children(tr.bars.length ? tr.bars.map((b, bi) => {
              const h = Math.max(6, Math.round(b.ratio * 42));
              const isSelBar = isSelWf && b.id === this.selectedRunId;
              return div().id(`ci-bar-${ti}-${bi}`).flex_1().min_w(6).max_w(16).h(h).rounded(2).cursor_pointer()
                .bg(barColor(t, b.state))
                .when(b.stale, el => el.opacity(0.32))
                .when(b.state === "running" || b.state === "queued", el => el.loop("opacity", { from: 0.45, to: 1, period: 1300 }))
                .when(isSelBar, el => el.border(1.5).border_color(t.foreground))
                .tooltip(b.tooltip)
                .on_click((_e, cx) => { cx.stop_propagation(); this.selectWorkflow(tr.name, cx, b.id); });
            }) : [div().text_size(10.5).text_color(t.dim).child("No runs")]))
          // Footer: short label + latest duration & age
          .child(h_flex().gap(6).items_center().text_size(10.5).text_color(t.dim)
            .child(div().flex_1().min_w(0).truncate().child(lat?.runNumber ? `#${lat.runNumber} · ${lat.branch || tr.branch}` : tr.short))
            .when(Boolean(dur), el => el.child(div().flex_none().whitespace_nowrap().text_color(t.muted).child(dur)))
            .when(Boolean(when), el => el.child(div().flex_none().whitespace_nowrap().child(when))));
      }));
  }

  renderBuildList(t, wf) {
    const runs = wf ? [...wf.bars].reverse() : []; // newest first in list
    return v_flex().w(310).h_full().flex_none().min_h(0).rounded(7).border(1).border_color(t.border).bg(t.chrome).overflow_hidden()
      .child(h_flex().h(30).flex_none().px(10).items_center().border_b(1).border_color(t.border).bg(t.raised)
        .child(div().flex_1().truncate().text_size(11).font_semibold().text_color(t.muted).child(wf ? `${wf.name} Builds` : "Builds"))
        .child(div().flex_none().whitespace_nowrap().text_size(10).text_color(t.dim).child(`${runs.length} runs`)))
      .child(v_flex().id("ci-run-list").flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(2)
        .children(runs.length ? runs.map((b, i) => {
          const sel = b.id === this.selectedRunId;
          const busy = this.rerunning.has(b.id);
          return h_flex().id(`ci-run-${i}`).px(8).py(6).gap(7).items_center().rounded(5).cursor_pointer()
            .bg(sel ? t.selected : "#00000000").hover(s => s.bg(sel ? t.selected : t.hover))
            .when(b.stale && !sel, el => el.opacity(0.55))
            .on_click((_e, cx) => this.selectRun(b, cx))
            .child(div().size(7).flex_none().rounded_full().bg(barColor(t, b.state))
              .when(b.state === "running" || b.state === "queued", el => el.loop("opacity", { from: 0.4, to: 1, period: 1200 })))
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(h_flex().gap(5).items_center()
                .child(div().flex_none().whitespace_nowrap().text_size(11).font_semibold().text_color(sel ? t.foreground : t.muted).child(b.runNumber ? `#${b.runNumber}` : String(b.id)))
                .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(sel ? t.foreground : t.muted).child(b.title || b.branch || b.event)))
              .child(h_flex().gap(6).items_center().text_size(10).text_color(t.dim)
                .child(div().flex_1().min_w(0).truncate().child(`${b.branch}${b.actor ? ` · ${b.actor}` : ""}`))
                .when(b.attempt > 1, el => el.child(div().flex_none().whitespace_nowrap().text_color(t.ansi3).child(`try ${b.attempt}`)))))
            .child(v_flex().flex_none().items_end().gap(1).text_size(10)
              .child(div().whitespace_nowrap().text_color(t.muted).child(b.durationSec ? formatDuration(b.durationSec) : ""))
              .child(div().whitespace_nowrap().text_color(t.dim).child(ago(b.createdMs))))
            .when(b.state === "failed", el => el.child(div().id(`ci-rr-${b.id}`).size(20).flex_none().rounded(4).flex().items_center().justify_center()
              .text_size(11).text_color(t.ansi1).hover(s => s.bg(t.ansi1 + "28")).tooltip("Re-run failed jobs")
              .on_click((_e, cx) => { cx.stop_propagation(); this.triggerRerun(b.id, true, cx); })
              .child(busy ? "..." : "↻")));
        }) : [div().p(12).text_size(11).text_color(t.dim).child("No recent builds.")]));
  }

  renderBuildInspector(t, wf, bar) {
    if (!bar) {
      return v_flex().flex_1().h_full().min_w(0).min_h(0).rounded(7).border(1).border_color(t.border).bg(t.chrome).items_center().justify_center()
        .child(div().text_size(12).text_color(t.dim).child("Click any workflow bar or build to inspect jobs and steps."));
    }

    const jobData = this.jobsByRun[bar.id] ?? { loading: false, list: [] };
    const jobs = jobData.list ?? [];
    const selJob = jobs.find(j => j.id === this.selectedJobId) ?? null;
    const failedJobs = jobs.filter(j => j.state === "failed");
    const busy = this.rerunning.has(bar.id);
    const maxJobDur = Math.max(10, ...jobs.map(j => j.durationSec ?? 0));

    const btn = (id, label, color, onClick, primary = false) => div().id(id).px(9).h(23).rounded(5).flex().items_center().text_size(10.5).cursor_pointer()
      .when(primary, el => el.bg(t.solid).text_color(t.solid_foreground).font_semibold().hover(s => s.opacity(0.9)))
      .when(!primary, el => el.bg(t.raised).border(1).border_color(t.border).text_color(color).hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => onClick(cx)).child(label);

    const header = h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised)
      .child(statusBadge(t, bar.state))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().whitespace_nowrap().text_size(12).font_semibold().text_color(t.foreground).child(`${wf?.name ?? "Build"}${bar.runNumber ? ` #${bar.runNumber}` : ""}`))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(bar.title || "")))
        .child(div().text_size(10.5).text_color(t.dim).child(
          [bar.branch, bar.sha, bar.actor, bar.durationSec ? formatDuration(bar.durationSec) : null, ago(bar.createdMs)].filter(Boolean).join(" · ")
        )))
      .when(this.inspectorView === "summary", el => el.child(btn("ci-btn-logs", bar.state === "failed" ? "Retrieve error logs" : "Check logs", t.foreground, cx => this.openLogsView(cx), true)))
      .when(this.inspectorView === "logs", el => el.child(btn("ci-btn-back", "← Summary", t.foreground, cx => { this.inspectorView = "summary"; cx.notify(); })))
      .when(bar.state === "failed", el => el.child(btn("ci-btn-rrf", busy ? "Starting..." : "Re-run failed", "#ef4444", cx => this.triggerRerun(bar.id, true, cx))))
      .child(btn("ci-btn-rra", "Re-run all", t.muted, cx => this.triggerRerun(bar.id, false, cx)))
      .when(Boolean(bar.url), el => el.child(btn("ci-btn-gh", "GitHub", t.accent, cx => cx.open_url(bar.url))));

    // ------------------------------------------------------------------ View A: Fast Build Summary (default — zero heavy log fetch!)
    if (this.inspectorView === "summary") {
      // Collect failure spotlight cards (exact failing step + lightweight GitHub error annotations)
      const errorCards = failedJobs.map((fj, fi) => {
        const fSteps = fj.steps.filter(s => s.state === "failed");
        const anns = (this.annotationsByJob[fj.id] ?? []).filter(a => a.level === "failure" || a.level === "error");
        return v_flex().id(`ci-err-${fi}`).p(10).gap(6).rounded(6).border(1).border_color("#ef444466").bg("#ef444414")
          .child(h_flex().gap(8).items_center()
            .child(div().size(8).flex_none().rounded_full().bg("#ef4444"))
            .child(div().flex_1().min_w(0).text_size(11.5).font_semibold().text_color("#ef4444")
              .child(`Failed in ${fj.name}${fSteps.length ? ` · Step ${fSteps[0].number}: ${fSteps[0].name}` : ""}`))
            .child(btn(`ci-err-log-${fi}`, "Check job logs", t.foreground, cx => this.openLogsView(cx, { jobId: fj.id }), true)))
          .when(anns.length > 0, el => el.child(v_flex().gap(3).pl(14)
            .children(anns.slice(0, 4).map((a, ai) =>
              h_flex().id(`ci-ann-${fi}-${ai}`).gap(6).items_start().text_size(11)
                .when(Boolean(a.path), e => e.child(div().flex_none().whitespace_nowrap().text_color(t.dim).child(`${a.path}${a.line ? `:${a.line}` : ""}`)))
                .child(div().flex_1().min_w(0).text_color(t.foreground).whitespace_normal().child(a.message))))));
      });

      return v_flex().flex_1().h_full().min_w(0).min_h(0).rounded(7).border(1).border_color(t.border).bg(t.chrome).overflow_hidden()
        .child(header)
        .child(v_flex().id("ci-summary-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10)
          // Failure spotlight right at the top when anything broke
          .when(errorCards.length > 0, el => el.children(errorCards))
          // Loading / error / empty state (never leaves a blank black screen or stuck spinner)
          .when(Boolean(jobData.error) && !jobs.length, el => el.child(h_flex().p(10).gap(8).items_center().rounded(6).border(1).border_color("#ef444466").bg("#ef444414")
            .child(div().flex_1().text_size(11.5).text_color("#ef4444").child(`Could not load jobs: ${jobData.error}`))
            .child(btn("ci-jobs-retry", "Retry", t.foreground, cx => this.loadRunDetails(bar, cx, { force: true })))))
          .when(jobData.loading && !jobs.length, el => el.child(h_flex().p(10).gap(8).items_center().rounded(6).border(1).border_color(t.border).bg(t.raised)
            .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.accent).spin(900))
            .child(div().flex_1().text_size(11.5).text_color(t.muted).child(`Loading jobs for #${bar.runNumber ?? bar.id}...`))
            .child(div().text_size(10.5).text_color(t.dim).child(`${bar.event || "run"}${bar.actor ? ` · ${bar.actor}` : ""}`))))
          .when(!jobData.loading && !jobData.error && !jobs.length, el => el.child(h_flex().p(10).gap(8).items_center().rounded(6).border(1).border_color(t.border).bg(t.raised)
            .child(div().flex_1().text_size(11.5).text_color(t.dim).child("No job details recorded for this run yet."))
            .child(btn("ci-jobs-reload", "Reload", t.muted, cx => this.loadRunDetails(bar, cx, { force: true })))))
          // Expanded-by-default job cards; every individual step node is clickable/collapsible and loads its log on demand!
          .children(jobs.map((j, ji) => {
            const col = barColor(t, j.state);
            const durRatio = Math.max(0.06, Math.min(1, (j.durationSec ?? 0) / maxJobDur));
            const barPx = Math.round(durRatio * 96);
            const visibleSteps = j.steps.filter(s => s.state !== "skipped" || j.steps.length <= 10);
            const isOpen = this.openJobs.has(j.id) ? this.openJobs.get(j.id) : true;
            const failedStep = j.steps.find(s => s.state === "failed");
            const jlog = this.jobLogByJob[j.id];
            return v_flex().id(`ci-jcard-${ji}`).rounded(7).border(1)
              .border_color(j.state === "failed" ? "#ef444466" : t.border).bg(t.raised)
              // Job card header (expanded by default; still collapsible on click)
              .child(h_flex().id(`ci-jhdr-${ji}`).px(10).py(7).gap(8).items_center().cursor_pointer()
                .hover(s => s.bg(t.hover))
                .border_b(isOpen && visibleSteps.length ? 1 : 0).border_color(t.border)
                .on_click((_e, cx) => { this.openJobs.set(j.id, !isOpen); cx.notify(); })
                .child(svg(`mods/workspace-chrome/chevron-${isOpen ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
                .child(div().size(8).flex_none().rounded_full().bg(col)
                  .when(j.state === "running" || j.state === "queued", el => el.loop("opacity", { from: 0.4, to: 1, period: 1200 })))
                .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(j.state === "failed" ? "#ef4444" : t.foreground).child(j.name))
                .when(!isOpen && Boolean(failedStep), el => el.child(div().flex_none().text_size(10.5).text_color("#ef4444").child(`Step ${failedStep.number}: ${failedStep.name}`)))
                .when(!isOpen && !failedStep && visibleSteps.length > 0, el => el.child(div().flex_none().whitespace_nowrap().text_size(10).text_color(t.dim).child(`${visibleSteps.length} steps`)))
                // Mini proportional duration bar
                .child(h_flex().w(100).h(6).flex_none().rounded(3).bg(t.background).overflow_hidden().items_center()
                  .child(div().w(barPx).h(6).rounded(3).bg(col)))
                .when(Boolean(j.durationSec), el => el.child(div().w(52).flex_none().text_right().whitespace_nowrap().text_size(10.5).text_color(t.muted).child(formatDuration(j.durationSec))))
                .child(div().id(`ci-jlog-${ji}`).px(9).h(23).rounded(5).flex().items_center().text_size(10.5).cursor_pointer()
                  .bg(t.background).border(1).border_color(t.border).text_color(t.accent).hover(s => s.bg(t.hover))
                  .on_click((_e, cx) => { cx.stop_propagation(); this.openLogsView(cx, { jobId: j.id }); }).child("Full log")))
              // Clickable collapsible step nodes (request job log on first click, slice to exact step inline)
              .when(isOpen && visibleSteps.length > 0, el => el.child(v_flex().px(8).py(6).gap(2)
                .children(visibleSteps.map((s, si) => {
                  const scol = barColor(t, s.state);
                  const isFail = s.state === "failed";
                  const isSkip = s.state === "skipped";
                  const stepKey = `${j.id}:${s.number}`;
                  const stepOpen = this.openSteps.has(stepKey);
                  const nextStep = j.steps.find(ns => ns.number > s.number && ns.startedMs != null) ?? null;
                  const stepEntry = stepOpen ? this.stepEditors.get(stepKey) : null;
                  const boxH = Math.min(260, Math.max(96, (stepEntry?.totalLines || 6) * 16 + 22));

                  return v_flex().id(`ci-snode-${ji}-${si}`).rounded(5)
                    .when(stepOpen, e => e.bg(t.background + "99").border(1).border_color(isFail ? "#ef444455" : t.border))
                    .child(h_flex().id(`ci-jstep-${ji}-${si}`).h(23).px(6).gap(6).items_center().rounded(4).cursor_pointer()
                      .hover(st => st.bg(isFail ? "#ef444426" : t.hover))
                      .when(isFail && !stepOpen, e => e.bg("#ef44441a"))
                      .when(isSkip, e => e.opacity(0.45))
                      .tooltip("Click to retrieve & toggle all logs for this step")
                      .on_click((_e, cx) => this.toggleStepNode(bar, j, s, cx))
                      .child(svg(`mods/workspace-chrome/chevron-${stepOpen ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
                      .child(div().size(6).flex_none().rounded_full().bg(scol)
                        .when(s.state === "running" || s.state === "queued", e => e.loop("opacity", { from: 0.4, to: 1, period: 1200 })))
                      .child(div().w(22).flex_none().text_size(10).text_color(t.dim).child(`${s.number}.`))
                      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(isFail ? "#ef4444" : (stepOpen ? t.foreground : t.muted)).child(s.name))
                      .when(s.durationSec != null && s.durationSec > 0, e => e.child(div().flex_none().whitespace_nowrap().text_size(10).text_color(t.dim).child(formatDuration(s.durationSec)))))
                    // Compact scrollable Editor holding ALL lines of this step + jump-cut Full logs button
                    .when(stepOpen, e => e.child(v_flex().px(8).pb(8).pt(4).gap(5).border_t(1).border_color(t.border)
                      .child(h_flex().gap(6).items_center().text_size(10).text_color(t.dim)
                        .child(div().flex_1().child(
                          jlog?.loading ? "Retrieving step logs from GitHub..."
                            : jlog?.error ? `Error: ${jlog.error}`
                            : `${stepEntry?.totalLines ?? 0} lines in this step${stepEntry?.startLine ? ` (line ${stepEntry.startLine})` : ""}`
                        ))
                        .when(Boolean(jlog?.cached && !jlog?.loading), el2 => el2.child(div().px(5).h(16).rounded(4).flex().items_center().bg(t.accent + "1f").text_size(9.5).text_color(t.accent).child("cached")))
                        .when(Boolean(stepEntry?.text), el2 => el2.child(div().id(`ci-scp-${ji}-${si}`).px(6).h(18).rounded(4).flex().items_center().cursor_pointer()
                          .bg(t.raised).text_color(t.muted).hover(st => st.bg(t.hover).text_color(t.foreground))
                          .on_click((_e, cx) => { cx.stop_propagation(); cx.write_clipboard(stepEntry.text); notify({ title: "Copied step log", body: `${s.number}. ${s.name}`, level: "info", timeout: 1400 }); })
                          .child("Copy")))
                        .child(div().id(`ci-sed-${ji}-${si}`).px(6).h(18).rounded(4).flex().items_center().cursor_pointer()
                          .bg(t.raised).text_color(t.accent).hover(st => st.bg(t.hover))
                          .tooltip("Open full job log and jump directly to this step")
                          .on_click((_e, cx) => { cx.stop_propagation(); this.openLogsView(cx, { jobId: j.id, jumpToStep: s, nextStep }); })
                          .child("Full log ↗")))
                      .when(Boolean(stepEntry?.editor), el2 => el2.child(
                        v_flex().id(`ci-slog-${ji}-${si}`).h(boxH).rounded(5).border(1).border_color(t.border).bg(t.chrome).overflow_hidden()
                          .child(Editor.new(stepEntry.editor).flex_1().min_h(0))
                      ))));
                }))));
          })));
    }

    // ------------------------------------------------------------------ View B: Logs Viewer (one screen depth away — on demand!)
    return v_flex().flex_1().h_full().min_w(0).min_h(0).rounded(7).border(1).border_color(t.border).bg(t.chrome).overflow_hidden()
      .child(header)
      // Job selector strip
      .child(h_flex().flex_none().flex_wrap().px(12).py(7).gap(5).items_center().border_b(1).border_color(t.border)
        .child(div().id("ci-job-all").px(7).h(22).rounded(5).flex().items_center().text_size(10.5).cursor_pointer()
          .bg(this.selectedJobId === null ? t.selected : t.raised)
          .border(1).border_color(this.selectedJobId === null ? t.accent : t.border)
          .text_color(this.selectedJobId === null ? t.foreground : t.muted)
          .on_click((_e, cx) => { this.selectedJobId = null; this.loadLogs(cx); cx.notify(); })
          .child("All jobs"))
        .children(jobs.map((j, ji) => {
          const isSel = j.id === this.selectedJobId;
          const col = barColor(t, j.state);
          return h_flex().id(`ci-job-${ji}`).px(7).h(22).rounded(5).gap(5).items_center().cursor_pointer()
            .bg(isSel ? t.selected : t.raised)
            .border(1).border_color(isSel ? t.accent : (j.state === "failed" ? "#ef444477" : t.border))
            .hover(s => s.bg(isSel ? t.selected : t.hover))
            .on_click((_e, cx) => { this.selectedJobId = j.id; this.loadLogs(cx); cx.notify(); })
            .child(div().size(6).rounded_full().bg(col))
            .child(div().text_size(10.5).text_color(j.state === "failed" ? "#ef4444" : (isSel ? t.foreground : t.muted)).child(j.name))
            .when(Boolean(j.durationSec), el => el.child(div().whitespace_nowrap().text_size(9.5).text_color(t.dim).child(formatDuration(j.durationSec))));
        })))
      // Log controls
      .child(h_flex().flex_none().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border).bg(t.raised + "77")
        .when(this.selectedJobId === null, el => el
          .child(div().id("ci-log-failed").px(7).h(21).rounded(4).flex().items_center().text_size(10.5).cursor_pointer()
            .bg(this.logMode === "failed" ? t.selected : "#00000000").text_color(this.logMode === "failed" ? t.foreground : t.dim)
            .on_click((_e, cx) => { this.logMode = "failed"; this.loadLogs(cx); cx.notify(); }).child("Failed log"))
          .child(div().id("ci-log-full").px(7).h(21).rounded(4).flex().items_center().text_size(10.5).cursor_pointer()
            .bg(this.logMode === "full" ? t.selected : "#00000000").text_color(this.logMode === "full" ? t.foreground : t.dim)
            .on_click((_e, cx) => { this.logMode = "full"; this.loadLogs(cx); cx.notify(); }).child("Full log")))
        .when(this.selectedJobId !== null, el => el
          .child(div().text_size(10.5).font_semibold().text_color(t.muted).child(`Job log: ${selJob?.name ?? ""}`)))
        .child(div().flex_1().min_w(120).max_w(280)
          .child(Input.new(this.logFilterInput).h(22).px(7).items_center().rounded(4).border(1).border_color(t.border).bg(t.background).text_color(t.foreground).text_size(10.5)))
        .when(this.logState.loading, el => el.child(div().text_size(10).text_color(t.dim).child("Loading...")))
        .when(!this.logState.loading && Boolean(this.jumpedLabel), el => el.child(h_flex().gap(4).items_center()
          .child(div().px(6).h(17).rounded(4).flex().items_center().bg("#22c55e22").text_size(9.5).text_color("#22c55e").whitespace_nowrap().child(this.jumpedLabel))
          .when(this.jumpOffsetLine > 0, e => e.child(div().id("ci-jump-top").px(6).h(17).rounded(4).flex().items_center().cursor_pointer()
            .bg(t.raised).border(1).border_color(t.border).text_size(9.5).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.jumpOffsetLine = 0; this.jumpedLabel = null; this.syncEditorText(); cx.notify(); }).child("From line 1")))))
        .when(!this.logState.loading && this.logState.cached, el => el.child(div().px(5).h(17).rounded(4).flex().items_center().bg(t.accent + "1f").text_size(9.5).text_color(t.accent).child("cached")))
        .when(!this.logState.loading && this.logState.totalLines > 0, el => el.child(div().whitespace_nowrap().text_size(10).text_color(t.dim).child(`${this.logState.totalLines} lines`)))
        .child(div().id("ci-log-reload").px(6).h(21).rounded(4).flex().items_center().text_size(10.5).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.loadLogs(cx, { force: true })).child("Reload"))
        .child(div().id("ci-log-copy").px(6).h(21).rounded(4).flex().items_center().text_size(10.5).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { cx.write_clipboard(this.logEditor.value()); notify({ title: "Copied log", body: `${bar.runNumber ? `#${bar.runNumber}` : bar.id}`, level: "info", timeout: 1400 }); }).child("Copy")))
      // Native read-only Editor for build logs
      .child(Editor.new(this.logEditor).flex_1().min_h(0));
  }

  renderSettings(t) {
    const cfg = this.ciSettings();
    const ov = this.slug ? cfg.overrides?.[this.slug] : null;
    const allWf = this.snapshot?.allWorkflows ?? [];
    const watched = this.currentWatchedSet();
    const q = this.wfSearch.trim().toLowerCase();
    const filteredWf = q
      ? allWf.filter(w => w.name.toLowerCase().includes(q) || (w.path || "").toLowerCase().includes(q))
      : allWf;

    return v_flex().id("ci-settings").flex_1().min_h(0).overflow_y_scrollbar().gap(12).max_w(820)
      // Termic-style CI workflows picker card
      .child(v_flex().p(14).gap(10).rounded(8).border(1).border_color(t.border).bg(t.raised)
        .child(v_flex().gap(2)
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child(`CI workflows: ${this.repo || this.slug}`))
          .child(div().text_size(11).text_color(t.dim).child("Pick which workflows this repository shows. A short name applies in every repository and syncs straight to the sidebar strip.")))
        .child(Input.new(this.wfSearchInput).h(28).px(9).items_center().rounded(6).border(1).border_color(t.border).bg(t.background).text_color(t.foreground).text_size(11.5))
        .child(v_flex().gap(3)
          .children(filteredWf.length ? filteredWf.map((w, i) => {
            const isOn = watched.has(w.name.toLowerCase());
            const k = w.name.toLowerCase();
            const inp = this.shortInputs.get(k);
            return h_flex().id(`ci-wf-opt-${i}`).h(30).px(6).gap(8).items_center().rounded(5).hover(s => s.bg(t.hover))
              // Termic-style checkbox
              .child(div().id(`ci-wf-tog-${i}`).size(17).flex_none().rounded(4).flex().items_center().justify_center().cursor_pointer()
                .bg(isOn ? t.accent : t.background).border(1).border_color(isOn ? t.accent : t.border)
                .on_click((_e, cx) => this.toggleWatchWorkflow(w.name, cx))
                .when(isOn, el => el.child(svg("mods/wf-sidebar/icons/check.svg").size(11).text_color(t.solid_foreground))))
              .child(div().flex_none().text_size(12).text_color(isOn ? t.foreground : t.muted).cursor_pointer()
                .on_click((_e, cx) => this.toggleWatchWorkflow(w.name, cx)).child(w.name))
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(w.path || ""))
              .when(Boolean(inp), el => el.child(div().w(120).flex_none().child(Input.new(inp).h(24).px(8).items_center().rounded(5).border(1).border_color(t.border).bg(t.background).text_color(t.foreground).text_size(11))));
          }) : [div().py(8).text_size(11).text_color(t.dim).child(allWf.length ? "No workflows match your search." : "No workflows loaded yet. Click Refresh above.")]))
        .child(h_flex().pt(6).gap(8).items_center().justify_end().border_t(1).border_color(t.border)
          .child(div().id("ci-set-reset").px(10).h(26).rounded(5).flex().items_center().text_size(11.5).cursor_pointer()
            .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.resetRepoSettings(cx)).child("Use the defaults"))
          .child(div().id("ci-set-done").px(14).h(26).rounded(5).flex().items_center().text_size(11.5).font_semibold().cursor_pointer()
            .bg(t.solid).text_color(t.solid_foreground).hover(s => s.opacity(0.9))
            .on_click((_e, cx) => this.commitAllShortNames(cx)).child("Done"))))

      // Branch & recency card
      .child(v_flex().p(14).gap(10).rounded(8).border(1).border_color(t.border).bg(t.raised)
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Branch & Recency"))
        .child(h_flex().flex_wrap().gap(8).items_center()
          .child(div().w(130).flex_none().text_size(11.5).text_color(t.muted).child("Watched branch"))
          .child(div().w(220).child(Input.new(this.branchInput).h(26).px(8).items_center().rounded(5).border(1).border_color(t.border).bg(t.background).text_color(t.foreground).text_size(11.5)))
          .child(div().id("ci-set-br-save").px(9).h(24).rounded(5).bg(t.solid).text_color(t.solid_foreground).text_size(11).flex().items_center().cursor_pointer()
            .on_click((_e, cx) => this.saveBranchOverride(cx)).child("Apply"))
          .child(div().text_size(10.5).text_color(t.dim).child(`Empty = default (${this.snapshot?.defaultBranch || "main"}). PR-only workflows fall back to PR runs.`)))
        .child(h_flex().flex_wrap().gap(8).items_center()
          .child(div().w(130).flex_none().text_size(11.5).text_color(t.muted).child("Recency window"))
          .child(h_flex().gap(5).children(RECENCY_CHOICES.map(d =>
            div().id(`ci-rec-${d}`).px(9).h(23).rounded(5).flex().items_center().text_size(11).cursor_pointer()
              .bg(cfg.recencyDays === d ? t.selected : t.background)
              .border(1).border_color(cfg.recencyDays === d ? t.accent : t.border)
              .text_color(cfg.recencyDays === d ? t.foreground : t.muted)
              .on_click((_e, cx) => this.setRecencyDays(d, cx)).child(`${d} days`))))
          .child(div().text_size(10.5).text_color(t.dim).child("Older runs dim to 30% opacity."))));
  }

  render(cx) {
    try {
      const t = theme();

      // Handle cross-tab jump requests from wf-sidebar / wf-changes while this tab is already open
      const focusReq = shared("wf.ciFocus");
      if (focusReq?.ts && focusReq.ts > this.lastFocusTs && focusReq.slug === this.slug) {
        this.lastFocusTs = focusReq.ts;
        if (focusReq.tab === "settings") {
          this.tab = "settings";
          cx.timer.after(1, cx => { this.openSettingsTab(cx); });
        } else {
          this.tab = "overview";
          if (focusReq.workflow) {
            const wfName = focusReq.workflow;
            const runId = focusReq.runId ?? null;
            cx.timer.after(1, cx => {
              if (this.branchScope) {
                this.branchScope = null;
                this.selectedWorkflow = wfName;
                this.selectedRunId = runId;
                this.refresh(cx);
              } else {
                this.selectWorkflow(wfName, cx, runId);
              }
            });
          } else if (focusReq.branch) {
            const br = focusReq.branch;
            cx.timer.after(1, cx => {
              this.branchScope = br;
              this.focusBranch = br;
              this.selectedWorkflow = null;
              this.selectedRunId = null;
              this.trends = [];
              this.snapshot = null;
              this.refresh(cx);
            });
          } else {
            cx.timer.after(1, cx => {
              if (this.branchScope) {
                this.branchScope = null;
                this.selectedWorkflow = null;
                this.selectedRunId = null;
                this.refresh(cx);
              }
            });
          }
        }
      }

      const wf = this.currentWorkflow();
      const bar = this.currentRun();
      const tabBtn = (id, label, active, onClick) => div().id(id).px(10).h(24).rounded(5).flex().items_center().text_size(11.5).cursor_pointer()
        .bg(active ? t.selected : "#00000000").text_color(active ? t.foreground : t.muted).font_semibold()
        .hover(s => s.bg(active ? t.selected : t.hover))
        .on_click((_e, cx) => onClick(cx)).child(label);

      return v_flex().id("wf-ci").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).p(12).gap(10)
        // Top header bar
        .child(h_flex().flex_none().gap(8).items_center().pb(6).border_b(1).border_color(t.border)
          .child(svg("mods/wf-sidebar/icons/workflow.svg").size(15).flex_none().text_color(t.accent))
          .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child((this.repo || this.slug || "CI Pipelines").toUpperCase()))
          .when(Boolean(this.slug), el => el.child(div().px(6).h(18).rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim).flex().items_center().child(this.slug)))
          .when(Boolean(this.branchScope), el => el.child(h_flex().id("ci-clear-br").px(7).h(20).gap(5).rounded(4).bg(t.accent + "22").border(1).border_color(t.accent + "55").items_center().cursor_pointer()
            .hover(s => s.bg(t.accent + "33"))
            .tooltip("Showing CI runs for this branch only — click to view all repo CI")
            .on_click((_e, cx) => { this.branchScope = null; this.focusBranch = null; this.selectedWorkflow = null; this.selectedRunId = null; this.refresh(cx); })
            .child(div().max_w(260).truncate().text_size(10.5).text_color(t.accent).child(`branch: ${this.branchScope}`))
            .child(div().text_size(10.5).text_color(t.accent).child("×"))))
          .when(!this.branchScope && Boolean(this.snapshot?.branch), el => el.child(div().px(6).h(18).rounded(4).bg(t.accent + "22").text_size(10.5).text_color(t.accent).flex().items_center().child(`branch: ${this.snapshot.branch}`)))
          .child(div().flex_1())
          .child(tabBtn("ci-tab-ov", "Overview", this.tab === "overview", cx => { this.tab = "overview"; cx.notify(); }))
          .child(tabBtn("ci-tab-set", "Settings", this.tab === "settings", cx => this.openSettingsTab(cx)))
          .child(div().id("ci-top-ref").px(8).h(24).rounded(5).flex().items_center().text_size(11).cursor_pointer()
            .bg(t.raised).border(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.refresh(cx, { forceMeta: true })).child(this.loading ? "Refreshing..." : "↻ Refresh"))
          .when(Boolean(this.slug), el => el.child(div().id("ci-top-gh").px(8).h(24).rounded(5).flex().items_center().text_size(11).cursor_pointer()
            .bg(t.raised).border(1).border_color(t.border).text_color(t.accent).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => cx.open_url(`https://github.com/${this.slug}/actions`)).child("GitHub Actions"))))

        // Body
        .when(this.tab === "overview", el => el
          .child(this.renderTrendsCards(t))
          .child(h_flex().flex_1().min_h(0).items_stretch().gap(10)
            .child(this.renderBuildList(t, wf))
            .child(this.renderBuildInspector(t, wf, bar))))
        .when(this.tab === "settings", el => el.child(this.renderSettings(t)));
    } catch (e) {
      track("error", { mod: "wf-ci", error: "render failed", detail: String(e?.message ?? e).slice(0, 120) });
      flushTelemetry();
      return div().p(12).text_size(12).text_color(theme().ansi1).child(`wf-ci: ${e?.stack ?? e}`);
    }
  }
}
