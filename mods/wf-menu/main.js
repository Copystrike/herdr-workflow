// Multi-mode popup menu for wf-sidebar:
//   mode "branch":  right-click context menu on a branch row (New..., Rename, Copy branch name,
//                   Stop task, Archive / Restore task, Open folder)
//   mode "new":     + menu (Claude Code, Claude Code (Code Mode), all installed AI CLIs via
//                   knownAgents(), Terminal, Open folder)
//   mode "session": right-click context menu on a Level 3 live or past session row
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, knownAgents, shared, setShared, run, notify, checking } from "herdr";
import { worktreeStatus, archiveBlockReason, filterFuzzy } from "./lib/wf/index.js";
import { exec, wf, track, flushTelemetry } from "./lib/wf/herdr-adapter.js";

const KNOWN = "new-menu.agents";
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

function glyph(item, t) {
  if (!item?.icon) return svg("icons/agent.svg").size(14).text_color(t.foreground);
  if (item.tint) return svg(item.icon).size(14).text_color(t.foreground);
  return image(item.icon).size(14);
}

export default class Menu extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.sub = null; // null = use props().mode ("new" default), or "new" when drilling into New...
    this.agents = (shared(KNOWN)?.[""] ?? []).filter(a => a.installed && Array.isArray(a.run) && a.run.length);
    this.busy = null;
    this.error = null;
    this.confirmDiscard = false;
    this.refQuery = "";
    this.refInput = InputState.new({ value: "", placeholder: "Filter branches..." });
    this.refInput.on("change", (_e, cx) => { this.refQuery = this.refInput.value(); cx.notify(); });
    const p = props() ?? {};
    if (p.mode === "git-ref") this.refInput.focus();
    this.gitStatus = p.dirty > 0 ? { dirty: p.dirty, staged: 0, unstaged: 0, untracked: 0 } : null;
    this.gitChecked = false;
    if (checking()) return;
    if ((p.mode ?? "new") === "branch" && !p.archived && p.worktree) {
      cx.spawn(async cx => {
        const st = await worktreeStatus(exec, p.worktree).catch(() => null);
        this.gitStatus = st;
        this.gitChecked = true;
        cx.notify();
      });
    }
    cx.spawn(async cx => {
      try {
        const list = await knownAgents();
        setShared(KNOWN, { ...(shared(KNOWN) ?? {}), "": list });
        this.agents = list.filter(a => a.installed && Array.isArray(a.run) && a.run.length);
        cx.notify();
      } catch { /* fall back to cached list */ }
    });
  }

  activeMode() {
    return this.sub ?? props()?.mode ?? "new";
  }

  installedAgents() {
    const base = this.agents.length
      ? this.agents
      : [{ key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"] }];
    // Insert "Claude Code (Code Mode)" right after Claude Code so both normal and ce launches are 1 click.
    const out = [];
    for (const a of base) {
      out.push(a);
      if (a.key === "claude") {
        out.push({ key: "claude-code-mode", name: "Claude Code (Code Mode)", icon: a.icon, tint: a.tint, run: a.run, codeMode: true });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ actions

  startAgent(agent, cx) {
    if (this.busy) return;
    const p = props() ?? {};
    this.busy = agent.key; this.error = null; cx.notify();
    track("ui", { surface: "wf-menu", action: `open-${agent.key}`, repo: p.repo, branch: p.branch });
    const args = ["open", "--worktree", p.worktree, "--focus"];
    if (p.repo) args.push("--repo", p.repo);
    if (p.branch) args.push("--branch", p.branch);
    if (agent.key === "claude" || agent.key === "claude-code-mode") {
      args.push("--claude");
      if (agent.codeMode) args.push("--code-mode");
    } else {
      args.push("--agent", agent.name, "--", ...agent.run);
    }
    cx.spawn(async cx => {
      const r = await wf(args);
      if (r.error) track("error", { mod: "wf-menu", error: r.error });
      flushTelemetry();
      if (!r.error) {
        setShared("wf.emptyView", null);
        setShared("wf.navTs", Date.now());
        run("layout.select", { stack: "main-stack", child: "active-tab" });
        return closeOverlay(p.overlay);
      }
      this.busy = null; this.error = r.error; cx.notify();
    });
  }

  startShell(cx) {
    if (this.busy) return;
    const p = props() ?? {};
    this.busy = "shell"; this.error = null; cx.notify();
    track("ui", { surface: "wf-menu", action: "open-shell", repo: p.repo, branch: p.branch });
    const args = ["open", "--worktree", p.worktree, "--shell", "--focus"];
    if (p.repo) args.push("--repo", p.repo);
    if (p.branch) args.push("--branch", p.branch);
    cx.spawn(async cx => {
      const r = await wf(args);
      if (r.error) track("error", { mod: "wf-menu", error: r.error });
      flushTelemetry();
      if (!r.error) {
        setShared("wf.emptyView", null);
        setShared("wf.navTs", Date.now());
        run("layout.select", { stack: "main-stack", child: "active-tab" });
        return closeOverlay(p.overlay);
      }
      this.busy = null; this.error = r.error; cx.notify();
    });
  }

  stopTask(cx) {
    if (this.busy) return;
    const p = props() ?? {};
    this.busy = "stop"; this.error = null; cx.notify();
    track("ui", { surface: "wf-menu", action: "stop-task", repo: p.repo, branch: p.branch });
    cx.spawn(async cx => {
      const r = await wf(["stop", "--worktree", p.worktree]);
      if (r.error) track("error", { mod: "wf-menu", error: r.error });
      flushTelemetry();
      if (r.error) { this.busy = null; this.error = r.error; cx.notify(); return; }
      const n = r.stopped?.length ?? 0;
      notify({ title: n ? `Stopped ${n} session${n === 1 ? "" : "s"}` : "No running sessions", body: p.branch ?? p.repo, level: "success", timeout: 2200 });
      closeOverlay(p.overlay);
    });
  }

  toggleArchive(cx) {
    if (this.busy) return;
    const p = props() ?? {};
    const archived = new Set(Array.isArray(shared("wf.archived")) ? shared("wf.archived") : []);
    const willArchive = !archived.has(p.worktree);
    this.busy = "archive"; this.error = null; cx.notify();
    track("ui", { surface: "wf-menu", action: willArchive ? "archive-task" : "restore-task", repo: p.repo, branch: p.branch });
    cx.spawn(async cx => {
      if (willArchive && p.worktree) {
        // Always run a fresh git status check so staged, unstaged, or untracked work is never archived uncommitted.
        const st = await worktreeStatus(exec, p.worktree).catch(() => null);
        this.gitStatus = st;
        this.gitChecked = true;
        const reason = archiveBlockReason(st);
        if (reason) {
          this.busy = null;
          this.error = reason;
          notify({ title: "Cannot archive branch", body: reason, level: "warning", timeout: 4000 });
          track("ui", { surface: "wf-menu", action: "archive-blocked-dirty", repo: p.repo, branch: p.branch });
          flushTelemetry();
          cx.notify();
          return;
        }
      }
      if (willArchive && p.liveCount > 0) {
        const r = await wf(["stop", "--worktree", p.worktree]);
        if (r.error) track("error", { mod: "wf-menu", error: r.error });
      }
      if (willArchive) archived.add(p.worktree); else archived.delete(p.worktree);
      setShared("wf.archived", [...archived]);
      flushTelemetry();
      notify({ title: willArchive ? "Task archived" : "Task restored", body: p.branch ?? p.repo, level: "info", timeout: 2200 });
      closeOverlay(p.overlay);
    });
  }

  stopSingleTerminal(cx) {
    if (this.busy) return;
    const p = props() ?? {};
    this.busy = "stop-one"; this.error = null; cx.notify();
    track("ui", { surface: "wf-menu", action: "stop-session", repo: p.repo, branch: p.branch });
    cx.spawn(async cx => {
      const r = await wf(["stop", "--terminal", p.terminal]);
      if (r.error) track("error", { mod: "wf-menu", error: r.error });
      flushTelemetry();
      if (r.error) { this.busy = null; this.error = r.error; cx.notify(); return; }
      if (p.worktree) setShared("wf.sessionsBump", { worktree: p.worktree, ts: Date.now() });
      notify({ title: "Session stopped", body: "Click it under the branch to resume anytime.", level: "success", timeout: 2200 });
      closeOverlay(p.overlay);
    });
  }

  removeSession(cx) {
    if (this.busy) return;
    const p = props() ?? {};
    if (p.terminal) {
      this.error = "Close this session first before removing it.";
      cx.notify();
      return;
    }
    this.busy = "remove-one"; this.error = null; cx.notify();
    track("ui", { surface: "wf-menu", action: "remove-session", repo: p.repo, branch: p.branch });
    const args = ["remove-session"];
    if (p.terminal) args.push("--terminal", p.terminal);
    if (p.worktree) args.push("--worktree", p.worktree);
    if (p.sessionId) args.push("--session", p.sessionId);
    if (p.file) args.push("--file", p.file);
    cx.spawn(async cx => {
      const r = await wf(args);
      if (r.error) track("error", { mod: "wf-menu", error: r.error });
      flushTelemetry();
      if (r.error) { this.busy = null; this.error = r.error; cx.notify(); return; }
      if (p.worktree) setShared("wf.sessionsBump", { worktree: p.worktree, ts: Date.now() });
      notify({ title: "Session removed", body: p.title ?? p.branch ?? "", level: "info", timeout: 2200 });
      closeOverlay(p.overlay);
    });
  }

  resumePastSession(cx) {
    if (this.busy) return;
    const p = props() ?? {};
    this.busy = "resume"; this.error = null; cx.notify();
    track("ui", { surface: "wf-menu", action: "resume-session", repo: p.repo, branch: p.branch });
    const args = ["open", "--worktree", p.worktree, "--claude", "--focus", "--resume", p.sessionId];
    if (p.repo) args.push("--repo", p.repo);
    if (p.branch) args.push("--branch", p.branch);
    cx.spawn(async cx => {
      const r = await wf(args);
      if (r.error) track("error", { mod: "wf-menu", error: r.error });
      flushTelemetry();
      if (!r.error) {
        setShared("wf.emptyView", null);
        setShared("wf.navTs", Date.now());
        run("layout.select", { stack: "main-stack", child: "active-tab" });
        return closeOverlay(p.overlay);
      }
      this.busy = null; this.error = r.error; cx.notify();
    });
  }

  renameBranch() {
    const p = props() ?? {};
    closeOverlay(p.overlay);
    setShared("wf.rename", { path: p.worktree, branch: p.branch, ts: Date.now() });
  }

  renameSession() {
    const p = props() ?? {};
    closeOverlay(p.overlay);
    setShared("wf.renameSession", {
      key: p.terminal ? `lt:${p.terminal}` : `ps:${p.sessionId}`,
      terminal: p.terminal ?? null,
      sessionId: p.sessionId ?? null,
      file: p.file ?? null,
      worktree: p.worktree ?? null,
      tabId: p.tabId ?? null,
      currentName: p.title ?? "",
      ts: Date.now(),
    });
  }

  copy(text, label, cx) {
    const p = props() ?? {};
    cx.write_to_clipboard(text);
    notify({ title: `${label} copied`, body: text, level: "success", timeout: 1800 });
    closeOverlay(p.overlay);
  }

  resetBranchOrder() {
    const p = props() ?? {};
    const prev = shared("wf.branchOrder");
    if (prev && typeof prev === "object" && p.repoDir) {
      const next = { ...prev };
      delete next[p.repoDir];
      setShared("wf.branchOrder", next);
    }
    notify({ title: "Branch order reset", body: p.repo ?? "", level: "info", timeout: 1800 });
    closeOverlay(p.overlay);
  }

  folder() {
    const p = props() ?? {};
    closeOverlay(p.overlay);
    track("ui", { surface: "wf-menu", action: "open-folder" });
    exec("xdg-open", [p.openDir || p.worktree]);
  }

  emitGitAction(actionObj) {
    const p = props() ?? {};
    setShared("wf.gitAction", { ...actionObj, root: p.root, ts: Date.now() });
    closeOverlay(p.overlay);
  }

  runDiscard(cx) {
    const p = props() ?? {};
    if (!this.confirmDiscard) {
      this.confirmDiscard = true;
      cx.notify();
      return;
    }
    this.emitGitAction({
      type: "discard",
      isDir: Boolean(p.isDir),
      rel: p.rel,
      files: Array.isArray(p.files) ? p.files : [{ path: p.rel, fresh: Boolean(p.fresh), status: p.status }],
    });
  }

  renderGitItemMenu(t, p) {
    const isDir = Boolean(p.isDir);
    const files = Array.isArray(p.files) ? p.files : [];
    const viewableFiles = isDir ? files.filter(f => f.fp) : (p.canView ? [{ path: p.rel, fp: p.fp }] : []);
    const canView = viewableFiles.length > 0;
    const viewed = Boolean(p.viewed);
    const pane = p.pane ?? null; // "unstaged" | "staged" | "compare" | "history" | "files"
    const discardLabel = this.confirmDiscard
      ? (isDir ? `Confirm discard folder (${files.length})?` : (p.fresh ? "Confirm delete untracked file?" : "Confirm discard changes?"))
      : (isDir ? `Discard folder changes (${files.length})` : (p.fresh ? "Delete untracked file" : "Discard changes"));
    return v_flex().w_full()
      .when(!isDir && p.status !== "D" && (pane === "unstaged" || pane === "staged" || pane === "compare"), el => el
        .child(this.row("gi-open-file", svg("mods/workspace-chrome/file-text.svg").size(13).text_color(t.foreground), "Open whole file", "", () => this.emitGitAction({ type: "open-file", rel: p.rel }))))
      .when(canView && (pane === "unstaged" || pane === "staged" || pane === "compare"), el => el
        .child(this.row("gi-view", svg("mods/workspace-chrome/check.svg").size(13).text_color(viewed ? t.accent : t.muted),
          isDir ? (viewed ? "Unmark folder as viewed" : `Mark folder as viewed (${viewableFiles.length})`) : (viewed ? "Mark as not viewed" : "Mark as viewed"),
          "",
          () => this.emitGitAction({ type: "toggle-viewed", isDir, rel: p.rel, fp: p.fp, files: viewableFiles, mark: !viewed }))))
      .when(pane === "unstaged", el => el
        .child(this.row("gi-stage", svg("mods/workspace-chrome/plus.svg").size(13).text_color(t.ansi2),
          isDir ? `Stage folder (${files.length})` : "Stage file", "",
          () => this.emitGitAction({ type: "stage", paths: isDir ? files.map(f => f.path) : [p.rel] })))
        .child(this.row("gi-discard", svg("mods/workspace-chrome/x.svg").size(13).text_color(t.ansi1),
          discardLabel, this.confirmDiscard ? "click again" : "",
          cx => this.runDiscard(cx), { danger: true })))
      .when(pane === "staged", el => el
        .child(this.row("gi-unstage", svg("mods/workspace-chrome/minus.svg").size(13).text_color(t.blocked),
          isDir ? `Unstage folder (${files.length})` : "Unstage file", "",
          () => this.emitGitAction({ type: "unstage", paths: isDir ? files.map(f => f.path) : [p.rel] }))))
      .when(canView || pane === "unstaged" || pane === "staged", el => el.child(this.sep()))
      .child(this.row("gi-copy-rel", svg("mods/workspace-chrome/file-text.svg").size(13).text_color(t.muted), "Copy path (relative)", "", cx => this.copy(p.rel, "Relative path", cx)))
      .child(this.row("gi-copy-abs", svg("mods/workspace-chrome/file-text.svg").size(13).text_color(t.muted), "Copy path (absolute)", "", cx => this.copy(p.abs, "Absolute path", cx)))
      .when(Boolean(p.githubUrl), el => el
        .child(this.row("gi-gh", svg("mods/workspace-chrome/git-branch.svg").size(13).text_color(t.accent), "Open on GitHub", "", (_cx) => {
          closeOverlay(p.overlay);
          _cx.open_url(p.githubUrl);
        })))
      .child(this.sep())
      .child(this.row("gi-open-dir", svg("mods/workspace-chrome/folder.svg").size(13).text_color(t.muted), isDir ? "Open folder" : "Reveal in file manager", "", () => this.folder()));
  }

  renderGitCommitMenu(t, p) {
    return v_flex().w_full()
      .child(this.row("gc-sha", svg("mods/workspace-chrome/file-text.svg").size(13).text_color(t.muted), "Copy commit SHA", p.short ?? "", cx => this.copy(p.sha, "Commit SHA", cx)))
      .child(this.row("gc-msg", svg("mods/workspace-chrome/file-text.svg").size(13).text_color(t.muted), "Copy commit subject", "", cx => this.copy(p.subject ?? "", "Commit subject", cx)))
      .when(Boolean(p.githubUrl), el => el
        .child(this.sep())
        .child(this.row("gc-gh", svg("mods/workspace-chrome/git-branch.svg").size(13).text_color(t.accent), "Open commit on GitHub", "", cx => {
          closeOverlay(p.overlay);
          cx.open_url(p.githubUrl);
        })));
  }

  renderGitRefMenu(t, p) {
    const local = Array.isArray(p.local) ? p.local : [];
    const remote = Array.isArray(p.remote) ? p.remote : [];
    const q = this.refQuery.trim();
    const filtLocal = filterFuzzy(local, q, x => x).map(x => x.item);
    const filtRemote = filterFuzzy(remote, q, x => x).map(x => x.item);
    const cur = p.base ?? "";
    const mergeBase = Boolean(p.mergeBase);
    const refRow = (prefix, name) => {
      const active = name === cur;
      return h_flex().id(`gr-${prefix}-${name}`).h(26).px(8).gap(7).rounded(5).items_center().flex_none().cursor_pointer()
        .when(active, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click(() => this.emitGitAction({ type: "set-base", base: name }))
        .child(active ? svg("mods/workspace-chrome/check.svg").size(12).flex_none().text_color(t.accent) : div().w(12).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(11.8).text_color(active ? t.foreground : t.muted).child(name));
    };
    return v_flex().w_full().gap(4)
      .child(div().px(4).pt(2)
        .child(Input.new(this.refInput).h(26).px(8).items_center().rounded(6).border(1).border_color(t.border).bg(t.background).text_color(t.foreground).text_size(11.5)))
      .child(v_flex().id("gr-scroll").max_h(260).overflow_y_scrollbar().gap(1)
        .when(filtLocal.length > 0, el => el
          .child(div().px(8).pt(4).pb(2).text_size(10).font_semibold().text_color(t.dim).child("LOCAL"))
          .children(filtLocal.slice(0, 60).map(b => refRow("l", b))))
        .when(filtRemote.length > 0, el => el
          .child(div().px(8).pt(6).pb(2).text_size(10).font_semibold().text_color(t.dim).child("REMOTE"))
          .children(filtRemote.slice(0, 80).map(b => refRow("r", b))))
        .when(filtLocal.length === 0 && filtRemote.length === 0, el => el
          .child(div().px(8).py(8).text_size(11.5).text_color(t.dim).child("No matching branches"))))
      .child(this.sep())
      .child(this.row("gr-mb",
        mergeBase ? svg("mods/workspace-chrome/check.svg").size(12).text_color(t.accent) : div().w(12),
        "Compare from merge-base (...)", mergeBase ? "3-dot" : "2-dot",
        () => this.emitGitAction({ type: "toggle-merge-base" })));
  }

  // ------------------------------------------------------------------ rendering

  row(id, icon, name, hint, action, { danger = false, muted = false, disabled = false, tooltip = null } = {}) {
    const t = theme();
    return h_flex().id(id).h(29).px(9).gap(9).rounded(6).items_center().flex_none()
      .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.selected)).on_click((_e, cx) => action(cx)))
      .when(disabled, el => el.opacity(0.48).on_click((_e, cx) => action(cx)))
      .when(Boolean(tooltip), el => el.tooltip(tooltip))
      .child(icon)
      .child(div().flex_1().min_w(0).truncate().text_color(danger ? t.ansi1 : (muted || disabled) ? t.muted : t.foreground).child(name))
      .when(Boolean(hint), el => el.child(div().flex_none().whitespace_nowrap().text_size(11).text_color(disabled ? t.blocked : t.dim).child(hint)));
  }

  sep() {
    return div().h(1).mx(5).my(4).flex_none().bg(theme().border);
  }

  renderBranchMenu(t, p) {
    const hasLive = (p.liveCount ?? 0) > 0;
    const isArchived = Boolean(p.archived);
    const blockReason = !isArchived && (this.gitChecked || (this.gitStatus?.dirty ?? 0) > 0)
      ? archiveBlockReason(this.gitStatus)
      : null;
    const dirtyCount = this.gitStatus?.dirty ?? 0;
    const archiveHint = blockReason ? (dirtyCount > 0 ? `${dirtyCount} uncommitted` : "unverified") : "";
    return v_flex().w_full()
      .child(this.row("wfb-new", svg("mods/workspace-chrome/plus.svg").size(13).text_color(t.foreground), "New", "▸", cx => { this.sub = "new"; cx.notify(); }))
      .child(this.row("wfb-explain", svg("mods/workspace-chrome/git-compare.svg").size(13).text_color(t.accent), "AI Explain", "", () => {
        closeOverlay(p.overlay);
        setShared("wf.openExplainReq", {
          repo: p.repo || null,
          repoDir: p.repoDir || null,
          worktree: p.worktree,
          branch: p.branch || null,
          autoRun: true,
          ts: Date.now(),
        });
      }))
      .child(this.sep())
      .child(this.row("wfb-rename", svg("mods/workspace-chrome/square-pen.svg").size(13).text_color(t.muted), "Rename", "", () => this.renameBranch()))
      .when(Boolean(p.branch), el => el.child(this.row("wfb-copy", svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.muted), "Copy branch name", "", cx => this.copy(p.branch, "Branch name", cx))))
      .child(this.sep())
      .when(hasLive, el => el.child(this.row("wfb-stop", svg("mods/workspace-chrome/square.svg").size(12).text_color(t.blocked), this.busy === "stop" ? "Stopping..." : `Stop task (${p.liveCount})`, "", cx => this.stopTask(cx))))
      .child(this.row("wfb-archive", svg("mods/workspace-chrome/archive.svg").size(13).text_color(isArchived ? t.accent : t.muted),
        this.busy === "archive" ? (isArchived ? "Restoring..." : "Archiving...") : (isArchived ? "Restore task" : "Archive task"),
        archiveHint,
        cx => this.toggleArchive(cx),
        { disabled: Boolean(blockReason), tooltip: blockReason }))
      .when(Boolean(p.hasCustomOrder), el => el.child(this.row("wfb-reset-order", svg("mods/workspace-chrome/layers.svg").size(13).text_color(t.muted), "Reset branch order", "", () => this.resetBranchOrder())))
      .child(this.sep())
      .child(this.row("wfb-folder", svg("mods/workspace-chrome/folder.svg").size(13).text_color(t.muted), "Open folder", "", () => this.folder()));
  }

  renderSessionMenu(t, p) {
    const isLive = Boolean(p.terminal);
    const sid = p.sessionId;
    const resumeCmd = sid ? `${p.worktree ? `cd ${quote(p.worktree)} && ` : ""}claude --resume ${sid}` : null;
    return v_flex().w_full()
      .when(isLive, el => el
        .child(this.row("wfs-focus", svg("mods/workspace-chrome/terminal.svg").size(13).text_color(t.foreground), "Focus session", "", () => {
          closeOverlay(p.overlay);
          if (p.spaceId) run("space.select", { id: p.spaceId });
          if (p.tabId) run("tab.select", { id: p.tabId });
          if (p.paneId) run("pane.focus", { pane: p.paneId });
          else run("agent.focus", { terminal: p.terminal });
        }))
        .child(this.row("wfs-rename", svg("mods/workspace-chrome/square-pen.svg").size(13).text_color(t.muted), "Rename", "", () => this.renameSession()))
        .child(this.row("wfs-stop", svg("mods/workspace-chrome/square.svg").size(12).text_color(t.blocked), this.busy === "stop-one" ? "Closing..." : "Close session", "", cx => this.stopSingleTerminal(cx))))
      .when(!isLive && Boolean(sid), el => el
        .child(this.row("wfs-resume", image("icons/claude.svg").size(13), this.busy === "resume" ? "Resuming..." : "Resume session", "", cx => this.resumePastSession(cx)))
        .when(Boolean(p.file), e => e.child(this.row("wfs-rename-p", svg("mods/workspace-chrome/square-pen.svg").size(13).text_color(t.muted), "Rename", "", () => this.renameSession())))
        .child(this.row("wfs-remove-p", svg("mods/workspace-chrome/x.svg").size(13).text_color(t.ansi1), this.busy === "remove-one" ? "Removing..." : "Remove session", "", cx => this.removeSession(cx), { danger: true })))
      .when(Boolean(sid), el => el
        .child(this.sep())
        .child(this.row("wfs-id", svg("mods/workspace-chrome/file-text.svg").size(13).text_color(t.muted), "Copy session ID", "", cx => this.copy(sid, "Session ID", cx)))
        .child(this.row("wfs-cmd", svg("mods/workspace-chrome/terminal.svg").size(13).text_color(t.muted), "Copy resume command", "", cx => this.copy(resumeCmd, "Resume command", cx))))
      .when(Boolean(p.file), el => el
        .child(this.row("wfs-file", svg("mods/workspace-chrome/folder.svg").size(13).text_color(t.muted), "Open transcript", "", () => { closeOverlay(p.overlay); exec("xdg-open", [p.file]); })));
  }

  renderNewMenu(t, p) {
    const agents = this.installedAgents();
    const actions = [
      ...agents.map(a => ({ id: `wfm-${a.key}`, icon: glyph(a, t), label: this.busy === a.key ? `Starting ${a.name}...` : a.name, run: cx => this.startAgent(a, cx) })),
      { id: "wfm-shell", icon: svg("icons/shell.svg").size(14).text_color(t.foreground), label: this.busy === "shell" ? "Starting terminal..." : "Terminal", run: cx => this.startShell(cx) },
    ];
    return {
      actions,
      body: v_flex().w_full()
        .when(this.sub === "new" && p.mode === "branch", el => el
          .child(this.row("wfm-back", svg("mods/workspace-chrome/chevron-left.svg").size(13).text_color(t.dim), "Back", "", cx => { this.sub = null; cx.notify(); }, { muted: true }))
          .child(this.sep()))
        .children(actions.map((a, i) => this.row(a.id, a.icon, a.label, i < 9 ? String(i + 1) : "", a.run)))
        .child(this.sep())
        .child(this.row("wfm-folder", svg("mods/workspace-chrome/folder.svg").size(13).text_color(t.muted), "Open folder", "", () => this.folder())),
    };
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const mode = this.activeMode();
    const newInfo = mode === "new" ? this.renderNewMenu(t, p) : null;
    const title = mode === "session"
      ? (p.title ?? p.terminal ?? "Session")
      : mode === "git-item"
        ? (p.rel ?? "File")
        : mode === "git-commit"
          ? `${p.short ?? ""} · ${p.subject ?? "Commit"}`
          : mode === "git-ref"
            ? "Compare against branch"
            : (p.branch ? `${p.repo ? p.repo + " · " : ""}${p.branch}` : `${p.repo ?? "Repository"} · session`);

    const body = mode === "branch" ? this.renderBranchMenu(t, p)
      : mode === "session" ? this.renderSessionMenu(t, p)
      : mode === "git-item" ? this.renderGitItemMenu(t, p)
      : mode === "git-commit" ? this.renderGitCommitMenu(t, p)
      : mode === "git-ref" ? this.renderGitRefMenu(t, p)
      : newInfo.body;

    return v_flex().id("wf-menu").track_focus(this.handle).w_full().min_h(0).bg(t.popover).p(5).text_size(12.2).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (e.key === "escape") {
          if (this.sub) { this.sub = null; cx.notify(); } else closeOverlay(p.overlay);
          cx.stop_propagation();
          return;
        }
        if (newInfo) {
          const n = Number(e.key);
          if (n >= 1 && n <= newInfo.actions.length) { newInfo.actions[n - 1].run(cx); cx.stop_propagation(); }
        }
      })
      .child(div().px(9).pt(4).pb(4).text_size(10.8).text_color(t.dim).truncate().child(title))
      .child(body)
      .when(Boolean(this.error), el => el.child(div().px(9).py(4).text_size(11).text_color(t.ansi1).whitespace_normal().child(this.error)));
  }
}
