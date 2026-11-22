// F4 sessions: the selected branch's Claude sessions (live ones from labelled terminals, past ones
// from its transcripts, newest first) on the branch page, and the repository's sessions outside
// any current worktree (its own folder, removed worktrees) under "Sessions without a branch".
// Clicking a live session shows it; clicking a past one resumes it in a labelled terminal. A
// session from a removed worktree resumes in the selected branch (wf copies it there first).
// Transcripts are read by the wf CLI, never here: one can be tens of megabytes.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, run, notify } from "herdr";
import { readLabels, statusWord } from "./lib/wf/index.js";
import { exec, wf, track, flushTelemetry } from "./lib/wf/herdr-adapter.js";

const SHOWN = 4; // per list until "more"

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

export class Sessions {
  constructor({ dot }) {
    this.dot = dot; // the row's agent status dot, shared with the branch list
    this.branch = { path: null, list: null, loading: false, error: null, more: false };
    this.repo = { dir: null, list: null, loading: false, more: false };
    this.answer = null; // { id, text, loading }
    this.hover = null;
    this.starting = new Set();
  }

  // The live terminal of each session id, from the `session` label.
  live() {
    const out = new Map();
    for (const t of terminals() ?? []) {
      if (t.state && t.state !== "live") continue;
      const id = readLabels(t.labels)?.session;
      if (id) out.set(id, { address: t.address, status: statusWord(t.status) });
    }
    return out;
  }

  loadBranch(path, cx) {
    if (!path) return;
    if (this.branch.path !== path) { this.branch = { path, list: null, loading: false, error: null, more: false }; this.answer = null; }
    if (this.branch.loading) return;
    this.branch.loading = true;
    cx.spawn(async cx => {
      const r = await wf(["sessions", "--worktree", path]);
      if (this.branch.path !== path) return;
      this.branch = { ...this.branch, loading: false, list: r.sessions ?? [], error: r.error ?? null };
      cx.notify();
    });
  }

  loadRepo(dir, cx) {
    if (!dir) return;
    if (this.repo.dir !== dir) this.repo = { dir, list: null, loading: false, more: false };
    if (this.repo.loading) return;
    this.repo.loading = true;
    cx.spawn(async cx => {
      const r = await wf(["sessions", "--repo", dir]);
      if (this.repo.dir !== dir) return;
      this.repo = { ...this.repo, loading: false, list: r.sessions ?? [], total: r.total ?? 0 };
      cx.notify();
    });
  }

  // Shows a live session, else resumes it in `worktree` (copying it there when it lives elsewhere).
  open(s, target, cx) {
    const live = this.live().get(s.id);
    if (live) { run("agent.focus", { terminal: live.address }); return; }
    if (!target) { notify({ title: "Select a branch first", body: "This session's worktree is gone: it resumes in the selected branch.", level: "info" }); return; }
    if (this.starting.has(s.id)) return;
    this.starting.add(s.id); cx.notify();
    track("ui", { surface: "wf-sessions", action: "resume", repo: target.repo, branch: target.branch, copied: Boolean(target.copy) });
    const args = ["open", "--worktree", target.worktree, "--claude", "--focus", "--resume", s.id];
    if (target.copy) args.push("--file", s.file);
    if (target.repo) args.push("--repo", target.repo);
    if (target.branch) args.push("--branch", target.branch);
    cx.spawn(async cx => {
      const r = await wf(args);
      flushTelemetry();
      if (r.error) notify({ title: "Couldn't resume the session", body: r.error, level: "error" });
      cx.timer.after(3000, cx => { this.starting.delete(s.id); this.loadBranch(this.branch.path, cx); cx.notify(); });
      cx.notify();
    });
  }

  showAnswer(s, cx) {
    if (this.answer?.id === s.id) { this.answer = null; cx.notify(); return; }
    this.answer = { id: s.id, text: null, loading: true };
    track("ui", { surface: "wf-sessions", action: "answer" });
    cx.spawn(async cx => {
      const r = await wf(["answer", "--file", s.file]);
      if (this.answer?.id !== s.id) return;
      this.answer = { id: s.id, loading: false, text: r.error ? `Couldn't read it: ${r.error}` : r.text ?? "No answer yet." };
      cx.notify();
    });
  }

  copy(text, what, cx) {
    cx.write_to_clipboard(text);
    track("ui", { surface: "wf-sessions", action: `copy-${what}` });
    notify({ title: what === "id" ? "Session id copied" : "Resume command copied", level: "success", timeout: 2000 });
  }

  // One session: its status dot, title, and counts; on hover its actions.
  item(t, s, { target, where, live }) {
    const busy = this.starting.has(s.id);
    const hovered = this.hover === s.id;
    const meta = [
      live ? `live ${live.address}` : busy ? "resuming…" : null,
      `${s.prompts} prompt${s.prompts === 1 ? "" : "s"}`,
      s.compactions ? `${s.compactions}× compacted` : null,
      where,
      ago(s.last),
    ].filter(Boolean).join(" · ");
    const link = (id, text, action) => div().id(`${id}-${s.id}`).px(4).rounded(3).text_color(t.muted).cursor_pointer()
      .hover(st => st.bg(t.raised).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(text);
    const resume = `${s.cwd && !where ? `cd ${quote(s.cwd)} && ` : ""}claude --resume ${s.id}`;
    return v_flex().id(`ss-${s.id}`).flex_none().px(6).py(3).gap(1).rounded(5).cursor_pointer()
      .hover(st => st.bg(t.hover))
      .on_hover((h, cx) => { this.hover = h ? s.id : this.hover === s.id ? null : this.hover; cx.notify(); })
      .on_click((_e, cx) => this.open(s, target, cx))
      .child(h_flex().gap(6).items_center()
        .child(live ? this.dot(t, live.status ?? "idle") : div().size(7).mx(2).flex_none().rounded(4).bg(t.dim + "55"))
        .child(div().flex_1().min_w(0).truncate().child(s.title)))
      .child(h_flex().pl(17).gap(4).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(meta))
        .when(hovered && Boolean(s.file), el => el
          .child(link("sa", this.answer?.id === s.id ? "hide" : "answer", cx => this.showAnswer(s, cx)))
          .child(link("si", "id", cx => this.copy(s.id, "id", cx)))
          .child(link("sc", "cmd", cx => this.copy(resume, "command", cx)))
          .child(link("sf", "file", () => exec("xdg-open", [s.file])))))
      .when(Boolean(s.prompt) && s.prompt !== s.title, el => el.child(div().pl(17).text_size(11).text_color(t.muted).truncate().child(s.prompt)))
      .when(this.answer?.id === s.id, el => el.child(div().id(`sx-${s.id}`).ml(17).mt(3).p(6).max_h(180).overflow_y_scroll().rounded(5)
        .bg(t.raised).text_size(11.5).text_color(t.foreground).whitespace_normal()
        .child(this.answer.loading ? "Reading…" : this.answer.text)));
  }

  // The branch page's session list. `row` is the selected worktree row.
  renderBranch(t, row, repoName) {
    const b = this.branch.path === row.path ? this.branch : { list: null, loading: true };
    const live = this.live();
    const known = new Set((b.list ?? []).map(s => s.id));
    // A Claude just started has a label before its transcript has a line.
    const fresh = row.terminals.map(a => (terminals() ?? []).find(x => x.address === a))
      .map(x => x && readLabels(x.labels)?.session).filter(id => id && !known.has(id))
      .map(id => ({ id, title: "New session", prompts: 0, compactions: 0, last: Date.now(), file: null, fresh: true }));
    const all = [...fresh, ...(b.list ?? [])];
    const shown = b.more ? all : all.slice(0, SHOWN);
    const target = { worktree: row.path, repo: repoName, branch: row.branch };
    let box = v_flex().gap(1);
    for (const s of shown) box = box.child(this.item(t, s, { target, live: live.get(s.id) }));
    return v_flex().gap(2)
      .child(h_flex().gap(8).items_center()
        .child(div().w(70).flex_none().text_color(t.dim).child("sessions"))
        .child(div().flex_1().text_color(t.dim).child(b.loading && !b.list ? "reading…" : b.error ? b.error : all.length ? `${all.length}, newest first` : "none yet")))
      .when(all.length > 0, el => el.child(box))
      .when(all.length > SHOWN, el => el.child(div().id("ss-more").pl(6).text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.branch.more = !this.branch.more; cx.notify(); })
        .child(this.branch.more ? "fewer" : `${all.length - SHOWN} more`)));
  }

  // Items for the list's "Sessions without a branch": past sessions of the repository folder
  // (resumed there) and of removed worktrees (resumed in the selected branch).
  repoItems(t, repoDir, picked, repoName) {
    const r = this.repo.dir === repoDir ? this.repo : { list: null, loading: true };
    if (!r.list) return [div().px(10).text_size(11).text_color(t.dim).child("reading past sessions…")];
    const live = this.live();
    const shown = r.more ? r.list : r.list.slice(0, SHOWN);
    const items = shown.map(s => {
      const home = s.home === "repo";
      const target = home ? { worktree: repoDir, repo: repoName, branch: null }
        : picked ? { worktree: picked.path, repo: repoName, branch: picked.branch, copy: true } : null;
      const where = home ? "repo folder" : `removed ${s.cwd?.split("/").pop() ?? "worktree"}${picked ? `, resumes in ${picked.branch}` : ""}`;
      return div().px(4).child(this.item(t, s, { target, where, live: live.get(s.id) }));
    });
    if (r.list.length > SHOWN)
      items.push(div().id("sr-more").px(10).text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.repo.more = !this.repo.more; cx.notify(); })
        .child(r.more ? "fewer" : `${r.list.length - SHOWN} more${r.total > r.list.length ? ` (newest ${r.list.length} of ${r.total})` : ""}`));
    if (!r.list.length) items.push(div().px(10).text_size(11).text_color(t.dim).child("no past sessions outside the worktrees"));
    return items;
  }
}
