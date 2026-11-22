// F1 repository view and F2 launcher: every worktree of the selected repository (shared "wf.repo")
// grouped by what it waits on, with its phase chip, PR signals, agent status, ahead/behind and
// dirty count; the branches without a worktree; branchless sessions; and the selected branch's
// page with its Claude sessions (F4, sessions.js). Selecting a branch sets shared "wf.branch" for
// wf-files and shows that branch's own herdr space (one per worktree), resuming its Claude
// sessions that a restart left as shells.
// The launcher at the top turns a pasted issue, PR, /command or task into a branch, a worktree
// and a Claude session with its first message.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, terminals, spaces, panes, shared, setShared, watchFolder, run, nextCommand, openOverlay, checking } from "herdr";
import { gatherRepo, prList, applyAgents, groupRows, spaceForWorktree } from "./lib/wf/index.js";
import { exec, fs, wf, track, flushTelemetry } from "./lib/wf/herdr-adapter.js";
import { Launcher } from "./launcher.js";
import { Sessions } from "./sessions.js";

const PR_MS = 60000; // PRs once per repository per minute
const MIN_GAP_MS = 3000; // never refresh faster than this after a file change
const MAX_WATCHES = 24; // watchFolder allows 64 folders for every mod together
const OTHERS_SHOWN = 200;

const WHO_COLOR = t => ({ user: t.blocked, session: t.working, app: t.dim });

function chip(t, phase) {
  const c = phase.key === "merged" || phase.key === "closed" ? t.dim : WHO_COLOR(t)[phase.who] ?? t.muted;
  return div().flex_none().px(6).h(18).rounded(5).bg(c + "22").text_size(10.5).text_color(c).flex().items_center().child(phase.label);
}

function agentDot(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("?");
  if (status === "done") return div().size(7).mx(2).flex_none().rounded(4).bg(t.done);
  if (status === "idle") return div().size(7).mx(2).flex_none().rounded(4).border(1).border_color(t.idle);
  return div().w(11).flex_none();
}

const BLOCKER_TEXT = { conflict: "conflict", ci: "CI red", changes: "changes requested" };

export default class Branches extends View {
  init(_props, cx) {
    this.model = null;
    this.key = null;
    this.loading = false;
    this.error = null;
    this.prs = { at: 0, list: undefined, dir: null };
    this.lastRefresh = 0;
    this.showOthers = false;
    this.hover = null;
    this.filter = "";
    this.input = InputState.new({ value: "", placeholder: "filter branches" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.sessions = new Sessions({ dot: agentDot });
    this.launcher = new Launcher({ repo: () => this.model, onStarted: (branch, cx) => { this.pendingSelect = branch; this.refresh(cx); } });
    track("mod", { mod: "wf-branches", action: "loaded" });
    if (checking()) return;
    cx.timer.every(PR_MS, cx => this.refresh(cx, { prs: true }));
    cx.timer.every(15000, () => { flushTelemetry(); });
    // Key commands (keys.json "wf-branches.next"): next, prev, select:<branch>, refresh.
    cx.spawn(async cx => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
  }

  command(c, cx) {
    const [name, arg] = String(c).split(/:(.*)/s);
    if (name === "refresh") return this.refresh(cx, { prs: true });
    const m = this.model;
    if (!m) return;
    const list = groupRows(m).flatMap(g => g.items.map(i => i.row));
    const at = list.findIndex(r => r.path === shared("wf.branch")?.path);
    const pick = name === "next" ? list[(at + 1) % list.length] : name === "prev" ? list[(at - 1 + list.length) % list.length]
      : name === "select" ? list.find(r => r.branch === arg) : null;
    if (pick) this.select(pick);
  }

  repo() { return shared("wf.repo"); }

  refresh(cx, { prs = false } = {}) {
    const repo = this.repo();
    if (!repo?.dir || this.loading) { if (this.loading) this.again = true; return; }
    this.loading = true;
    const key = repo.dir;
    const t0 = Date.now();
    cx.spawn(async cx => {
      try {
        const stale = this.prs.dir !== key || prs || Date.now() - this.prs.at > PR_MS;
        // First paint without PRs (git is fast; gh is not), then again with them.
        if (!this.model || this.model.dir !== key) {
          const quick = await gatherRepo({ exec, fs, repo, terminals: terminals(), prs: undefined });
          if (this.key !== key) return;
          this.model = quick; cx.notify();
        }
        if (stale) {
          const list = this.model?.slug ? await prList(exec, key, this.model.slug) : null;
          this.prs = { at: Date.now(), list, dir: key };
        }
        const model = await gatherRepo({ exec, fs, repo, terminals: terminals(), prs: this.model?.slug ? this.prs.list : null });
        if (this.key !== key) return;
        this.model = model; this.error = model.error ?? null;
        this.watch(cx, model);
        track("refresh", { mod: "wf-branches", repo: repo.name, ms: Date.now() - t0, count: model.rows.length });
      } catch (e) {
        this.error = String(e);
        track("error", { mod: "wf-branches", error: "refresh failed" });
      } finally {
        this.loading = false; this.lastRefresh = Date.now();
        if (this.model) {
          this.sessions.loadRepo(this.model.dir, cx);
          const picked = shared("wf.branch")?.path;
          if (picked && this.model.rows.some(r => r.path === picked)) this.sessions.loadBranch(picked, cx);
        }
        const pending = this.pendingSelect && this.model?.rows.find(r => r.branch === this.pendingSelect);
        if (pending) { this.pendingSelect = null; this.select(pending); }
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // Watch the git dir (refs, worktree HEADs) and each worktree's docs/ (plan, reviews, batches).
  watch(cx, model) {
    const dirs = [`${model.dir}/.bare/refs`, `${model.dir}/.bare/worktrees`, `${model.dir}/.git/refs`]
      .concat(model.rows.map(r => `${r.path}/docs`)).slice(0, MAX_WATCHES);
    const generation = (this.generation = (this.generation ?? 0) + 1);
    for (const dir of dirs) {
      cx.spawn(async cx => {
        if (!(await fs.exists(dir))) return;
        try {
          for (;;) {
            await watchFolder(dir);
            if (this.generation !== generation) return;
            const wait = MIN_GAP_MS - (Date.now() - this.lastRefresh);
            if (wait > 0) cx.timer.after(wait, cx => this.refresh(cx)); else this.refresh(cx);
          }
        } catch { /* folder went away */ }
      });
    }
  }

  // Shows the branch's own space, so only its terminals are on screen. Clicking a branch with no
  // space yet starts Claude Code in it (herdr has no empty space to show); stepping with next/prev
  // and the launcher's own select start nothing.
  select(row, cx = null) {
    setShared("wf.branch", { repo: this.model.name, path: row.path, branch: row.branch });
    track("ui", { surface: "wf-branches", action: "select", repo: this.model.name, branch: row.branch, phase: row.phase.key });
    const space = spaceForWorktree(spaces(), panes(), row.path);
    if (!space) { if (cx && !row.terminals.length) this.startClaude(row, cx); return; }
    if (!space.active) run("space.select", { id: space.id });
    if (row.terminals.length) wf(["resume", "--worktree", row.path]);
  }

  // One start per worktree at a time: the space shows up in spaces() a moment after wf returns.
  startClaude(row, cx) {
    this.starting ??= new Set();
    if (this.starting.has(row.path)) return;
    this.starting.add(row.path);
    track("ui", { surface: "wf-branches", action: "open-claude", repo: this.model.name, branch: row.branch });
    cx.spawn(async cx => {
      const r = await wf(["open", "--worktree", row.path, "--claude", "--focus", "--repo", this.model.name, "--branch", row.branch]);
      flushTelemetry();
      if (r.error) this.error = r.error;
      cx.timer.after(3000, () => this.starting.delete(row.path));
      this.refresh(cx);
    });
  }

  menu(row) {
    openOverlay({ mod: "wf-menu", kind: "popup", props: { worktree: row.path, repo: this.model.name, branch: row.branch } });
  }

  row(t, { row, depth }, picked) {
    const selected = picked?.path === row.path;
    const hovered = this.hover === row.path;
    const pr = row.pr;
    const sig = row.signals ?? {};
    return h_flex().id(`br-${row.path}`).h(30).flex_none().pl(10 + depth * 16).pr(8).gap(7).items_center().rounded(6).cursor_pointer()
      .when(selected, el => el.bg(t.selected)).hover(s => s.bg(selected ? t.selected : t.hover))
      .on_hover((h, cx) => { this.hover = h ? row.path : this.hover === row.path ? null : this.hover; cx.notify(); })
      .on_click((_e, cx) => this.select(row, cx))
      .child(agentDot(t, row.agent))
      .when(depth > 0, el => el.child(div().text_color(t.dim).child("↳")))
      .child(div().flex_1().min_w(0).truncate().text_color(row.isBase ? t.muted : t.foreground).child(row.branch))
      .when(Boolean(row.terminals.length) && !hovered, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(row.terminals.length))))
      .when(hovered || selected, el => el.child(div().id(`plus-${row.path}`).flex_none().size(18).rounded(4).flex().items_center().justify_center()
        .text_color(t.muted).hover(s => s.bg(t.raised).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.menu(row); })
        .child(svg("mods/workspace-chrome/plus.svg").size(12))))
      .when(!row.isBase, el => el.child(chip(t, row.phase)))
      .when(Boolean(pr?.number), el => el.child(div().flex_none().text_size(11)
        .text_color(sig.blocker ? t.ansi1 : pr.state === "MERGED" ? t.dim : t.muted)
        .child(`#${pr.number}${pr.isDraft ? " draft" : ""}${sig.blocker ? " · " + BLOCKER_TEXT[sig.blocker] : ""}`)))
      .when(sig.progress === "ci", el => el.child(div().flex_none().size(7).rounded(4).bg(t.ansi3).loop("opacity", { from: 0.3, to: 1, period: 1400 })))
      .when(row.ahead || row.behind, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${row.ahead ? "↑" + row.ahead : ""}${row.behind ? "↓" + row.behind : ""}`)))
      .when(Boolean(row.dirty), el => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(`●${row.dirty}`)));
  }

  page(t, row) {
    const p = row.phase;
    const line = (label, value) => h_flex().gap(8).child(div().w(70).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).truncate().child(value ?? "–"));
    const rel = row.path.startsWith(this.model.dir + "/") ? row.path.slice(this.model.dir.length + 1) : row.path;
    return v_flex().id("wf-page").flex_none().max_h(460).overflow_y_scrollbar().gap(5).p(12).border_t(1).border_color(t.border).text_size(12)
      .child(h_flex().gap(8).items_center().child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(row.branch)).child(row.isBase ? div() : chip(t, p)))
      .when(Boolean(row.line), el => el.child(div().text_color(t.muted).child(row.line)))
      .when(Boolean(p.next), el => el.child(h_flex().gap(8).items_center()
        .child(div().text_color(t.foreground).child(`Next: ${p.next.label}`))
        .when(Boolean(p.next.command), el => el.child(div().px(6).rounded(4).bg(t.raised).text_color(t.muted).font_family("JetBrains Mono").text_size(11).child(p.next.command)))))
      .when(Boolean(p.detail), el => el.child(div().text_color(t.blocked).child(String(p.detail).split("\n")[0])))
      .child(line("worktree", rel))
      .child(line("plan", row.files?.plan ?? row.files?.batch ?? null))
      .when(Boolean(row.files?.newestReview), el => el.child(line("review", `${row.files.newestReview}${row.files.notApplied ? ` · ${row.files.notApplied} not applied` : ""}`)))
      .child(h_flex().gap(8)
        .child(div().w(70).flex_none().text_color(t.dim).child("links"))
        .when(Boolean(row.issue), el => el.child(div().id("pg-issue").text_color(t.accent).cursor_pointer().on_click((_e, cx) => cx.open_url(row.issue)).child("issue")))
        .when(Boolean(row.pr?.url), el => el.child(div().id("pg-pr").text_color(t.accent).cursor_pointer().on_click((_e, cx) => cx.open_url(row.pr.url)).child(`PR #${row.pr.number}`)))
        .when(!row.issue && !row.pr?.url, el => el.child(div().text_color(t.dim).child("–"))))
      .child(h_flex().gap(8).items_center()
        .child(div().w(70).flex_none().text_color(t.dim).child("terminals"))
        .child(div().text_color(row.terminals.length ? t.foreground : t.dim).child(row.terminals.length ? `${row.terminals.length} in this branch's space` : "none yet"))
        .child(div().flex_1())
        .child(div().id("pg-new").px(8).h(22).rounded(5).flex().items_center().gap(5).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click(() => this.menu(row)).child(svg("mods/workspace-chrome/plus.svg").size(11)).child("New")))
      .child(this.sessions.renderBranch(t, row, this.model.name));
  }

  // A throw inside render leaves the last frame on screen with no error: show it instead.
  render(cx) {
    try { return this.draw(cx); }
    catch (e) {
      track("error", { mod: "wf-branches", error: "render failed" });
      return div().p(12).text_size(12).text_color(theme().ansi1).child(`wf-branches: ${e?.stack ?? e}`);
    }
  }

  draw(cx) {
    const t = theme();
    const repo = this.repo();
    if (repo?.dir !== this.key) {
      this.key = repo?.dir ?? null;
      this.model = null; this.error = null; this.generation = (this.generation ?? 0) + 1;
      if (repo?.dir) this.refresh(cx, { prs: true });
    }
    const m = this.model && this.model.dir === repo?.dir ? this.model : null;
    if (m) applyAgents(m.rows, terminals());
    const picked = shared("wf.branch");
    const selectedRow = m?.rows.find(r => r.path === picked?.path) ?? null;
    if (selectedRow && this.sessions.branch.path !== selectedRow.path) this.sessions.loadBranch(selectedRow.path, cx);
    if (m && this.sessions.repo.dir !== m.dir) this.sessions.loadRepo(m.dir, cx);
    const groups = m ? groupRows(m) : [];
    const f = this.filter.trim().toLowerCase();
    const others = m ? m.others.filter(o => !f || o.name.toLowerCase().includes(f)) : [];
    const prNote = !m ? "" : m.prs === "ok" ? "GitHub" : m.prs === "none" ? "no remote" : this.prs.dir === m.dir && this.prs.list === undefined ? "loading PRs" : "PRs unavailable";

    const head = (title, n, extra) => h_flex().px(10).pt(12).pb(4).gap(6).items_center().text_size(11).text_color(t.dim)
      .child(div().font_semibold().child(title)).child(div().child(String(n))).when(Boolean(extra), el => el.child(extra));

    const items = [];
    for (const g of groups) {
      items.push(head(g.title, g.items.length));
      for (const item of g.items) items.push(this.row(t, item, picked));
    }
    if (m) {
      items.push(div().id("wf-others-head").cursor_pointer().on_click((_e, cx) => { this.showOthers = !this.showOthers; track("ui", { surface: "wf-branches", action: this.showOthers ? "others-open" : "others-close" }); cx.notify(); })
        .child(head(`${this.showOthers ? "▾" : "▸"} Other branches`, m.others.length)));
      if (this.showOthers) {
        items.push(div().px(8).pb(4).child(Input.new(this.input).h(28).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12)));
        for (const o of others.slice(0, OTHERS_SHOWN))
          items.push(h_flex().h(24).flex_none().px(10).gap(8).items_center().text_size(12)
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(o.name))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(o.where)));
        if (others.length > OTHERS_SHOWN) items.push(div().px(10).text_size(11).text_color(t.dim).child(`${others.length - OTHERS_SHOWN} more; filter to narrow`));
      }
      items.push(head("Sessions without a branch", m.sessions.length + (this.sessions.repo.dir === m.dir ? this.sessions.repo.total ?? 0 : 0)));
      for (const s of m.sessions)
        items.push(h_flex().id(`ses-${s.address}`).h(26).flex_none().px(10).gap(7).items_center().rounded(6).cursor_pointer().hover(st => st.bg(t.hover))
          .on_click(() => run("agent.focus", { terminal: s.address }))
          .child(agentDot(t, s.status)).child(div().flex_1().truncate().text_size(12).child(`${s.agent ?? "terminal"} · ${s.address}`)));
      items.push(...this.sessions.repoItems(t, m.dir, selectedRow, m.name));
    }

    return v_flex().id("wf-branches").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(repo?.name ?? "No repository"))
        .when(Boolean(m?.base), el => el.child(div().text_size(11).text_color(t.dim).child(`base ${m.base}`)))
        .child(div().flex_1())
        .when(this.loading, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.dim).spin(900)))
        .child(div().text_size(11).text_color(t.dim).child(prNote))
        .child(div().id("wf-refresh").text_size(12).text_color(t.dim).cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { track("ui", { surface: "wf-branches", action: "refresh" }); this.refresh(cx, { prs: true }); }).child("↻")))
      .when(Boolean(m), el => el.child(this.launcher.render(t)))
      .when(Boolean(this.error), el => el.child(div().p(10).text_size(12).text_color(t.ansi1).child(this.error)))
      .when(!m && !this.error, el => el.child(div().p(12).text_size(12).text_color(t.dim).child(repo ? "Reading branches…" : "Pick a repository on the left")))
      .when(Boolean(m), el => el.child(v_flex().id("wf-branches-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(10).children(items)))
      .when(Boolean(selectedRow), el => el.child(this.page(t, selectedRow)));
  }
}
