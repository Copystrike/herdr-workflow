// Compact F2 launcher embedded at the top of wf-sidebar: paste an issue (URL or #n), several
// issue URLs, a PR URL, a /command or a task, press Enter to preview the branch, Enter again
// to make the worktree and start Claude with its first message. Esc cancels; Up/Down walk history.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { wf, track, flushTelemetry } from "./lib/wf/herdr-adapter.js";

const DELIVER_TRIES = 9; // 9 x 20 s: time to answer a trust dialog

export class Launcher {
  constructor({ repo, onStarted }) {
    this.repo = repo; // () => { name, dir } | null
    this.onStarted = onStarted; // (repoDir, branch, cx) => void
    this.state = "idle"; // idle | proposing | proposal | starting | delivering
    this.proposal = null;
    this.note = null;
    this.error = null;
    this.history = [];
    this.back = 0;
    this.input = InputState.new({ value: "", placeholder: "Paste issue, PR, /cmd or task..." });
    this.input.on("submit", (_e, cx) => (this.state === "proposal" ? this.start(cx) : this.propose(cx)));
    this.input.on("change", (_e, cx) => { if (this.state === "proposal") this.cancel(cx); });
    this.branch = InputState.new({ value: "" });
    this.branch.on("submit", (_e, cx) => this.start(cx));
  }

  busy() { return this.state === "proposing" || this.state === "starting" || this.state === "delivering"; }

  propose(cx) {
    const text = this.input.value().trim();
    const r0 = this.repo();
    if (!text || !r0 || this.busy()) return;
    this.state = "proposing"; this.error = null; this.note = null; cx.notify();
    cx.spawn(async cx => {
      const r = await wf(["new", "--repo", r0.dir, "--dry-run", "--", text]);
      if (r.error) { this.state = "idle"; this.error = r.error; cx.notify(); return; }
      this.proposal = { ...r, text, dir: r0.dir };
      this.state = "proposal";
      if (r.kind !== "issues") { this.branch.set_value(r.branch); this.branch.focus(); }
      track("launch", { action: `propose-${r.kind}`, repo: r0.name, count: r.items?.length ?? 1 });
      cx.notify();
    });
  }

  cancel(cx) {
    if (this.busy()) return;
    this.state = "idle"; this.proposal = null; this.error = null;
    this.input.focus(); cx.notify();
  }

  start(cx) {
    const p = this.proposal;
    if (this.state !== "proposal" || !p) return;
    const single = p.kind !== "issues";
    const branch = single ? this.branch.value().trim() : null;
    const edited = single && branch !== p.branch;
    if (single && !edited && p.existing) {
      this.finish(cx, p.dir, p.text, p.branch, `${p.branch} already exists`);
      return;
    }
    this.state = "starting"; this.error = null; this.note = "Making the worktree..."; cx.notify();
    cx.spawn(async cx => {
      const args = ["new", "--repo", p.dir, "--focus"];
      if (edited) args.push("--branch", branch);
      const r = await wf([...args, "--", p.text]);
      if (r.error) { this.state = "proposal"; this.error = r.error; this.note = null; cx.notify(); return; }
      const started = (r.kind === "issues" ? r.items : [r]).filter(i => i.terminal);
      track("launch", { action: `start-${p.kind}`, repo: p.repo, count: started.length });
      this.state = "delivering";
      for (const item of started) {
        this.note = `Starting Claude in ${item.branch}...`; cx.notify();
        const payload = item.kind === "issue" || item.kind === "pr" ? item.ref : p.text;
        let done = null;
        for (let i = 0; i < DELIVER_TRIES && !done?.delivered; i++) {
          done = await wf(["deliver", "--terminal", item.terminal, "--repo", p.dir, "--branch", item.branch, "--kind", item.kind, "--wait", "20", "--", payload]);
          if (done.error) break;
          if (!done.delivered) { this.note = `${item.branch}: Claude is ${done.status ?? "not ready"}; answer it in its terminal`; cx.notify(); }
        }
        track("launch", { action: done?.delivered ? "delivered" : "not-delivered", repo: p.repo });
      }
      const skipped = r.kind === "issues" ? r.items.filter(i => !i.terminal).map(i => i.branch) : [];
      const last = started[started.length - 1];
      this.finish(cx, p.dir, p.text, last?.branch ?? null,
        `Started ${started.map(i => i.branch).join(", ")}${skipped.length ? `; already there: ${skipped.join(", ")}` : ""}`);
    });
  }

  finish(cx, repoDir, text, branch, note) {
    this.history = [text, ...this.history.filter(h => h !== text)].slice(0, 30);
    this.back = 0;
    this.state = "idle"; this.proposal = null; this.note = note;
    this.input.set_value(""); this.input.focus();
    flushTelemetry();
    this.onStarted(repoDir, branch, cx);
    cx.notify();
  }

  key(e, cx) {
    if (e.key === "escape" && this.state === "proposal") { this.cancel(cx); cx.stop_propagation(); return; }
    if (this.state !== "idle" || !this.history.length || (e.key !== "up" && e.key !== "down")) return;
    this.back = Math.max(0, Math.min(this.history.length, this.back + (e.key === "up" ? 1 : -1)));
    this.input.set_value(this.back ? this.history[this.back - 1] : "");
    cx.stop_propagation(); cx.notify();
  }

  render(t) {
    const p = this.proposal;
    const target = this.repo();
    const field = state => Input.new(state).h(28).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(11.8);
    const button = (id, text, primary, action) => div().id(id).px(9).h(22).rounded(5).flex().items_center().text_size(11.5).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover(s => s.opacity(0.88))
      .on_click((_e, cx) => action(cx)).child(text);
    const rel = path => (p && path?.startsWith(p.dir + "/") ? path.slice(p.dir.length + 1) : path);

    let card = null;
    if (p && (this.state === "proposal" || this.state === "starting" || this.state === "delivering")) {
      const items = p.kind === "issues" ? p.items : [p];
      card = v_flex().gap(5).p(7).rounded(6).border(1).border_color(t.border).bg(t.raised).text_size(11.5);
      if (p.kind === "issues") {
        for (const i of items)
          card = card.child(h_flex().gap(6).child(div().flex_none().text_color(t.dim).child(`#${i.number}`))
            .child(div().flex_1().min_w(0).truncate().child(i.branch))
            .child(div().flex_none().text_size(10.5).text_color(i.existing ? t.blocked : t.dim).child(i.existing ? "exists" : "new")));
      } else {
        const what = p.number ? `${p.kind === "pr" ? "PR #" : "#"}${p.number} ${p.title ?? ""}` : p.kind === "command" ? "command" : "task";
        card = card.child(div().truncate().text_color(t.muted).child(what))
          .child(field(this.branch))
          .child(div().text_size(10.5).text_color(t.dim).truncate()
            .child(p.existing ? `exists${p.exists.worktree ? ` at ${rel(p.exists.worktree)}` : p.exists.local ? " as a local branch" : " on remote"}` : `new from origin/${p.base} · ${rel(p.worktree)}`));
      }
      if (this.state === "proposal") {
        const openOnly = p.kind !== "issues" && p.existing && this.branch.value().trim() === p.branch;
        card = card.child(h_flex().gap(6).justify_end()
          .child(button("wl-cancel", "Cancel", false, cx => this.cancel(cx)))
          .child(button("wl-start", openOnly ? "Show it" : p.kind === "issues" ? `Start ${items.filter(i => !i.existing).length}` : "Start", true, cx => this.start(cx))));
      }
    }
    return v_flex().id("wf-launch").flex_none().gap(5).px(8).pt(6).pb(4).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().gap(5).items_center()
        .child(div().flex_1().min_w(0).child(field(this.input)))
        .when(Boolean(target?.name), el => el.child(div().flex_none().max_w(86).px(5).h(22).rounded(4).bg(t.raised)
          .text_size(10).text_color(t.dim).flex().items_center().truncate().tooltip(`New branch target: ${target.name}`).child(target.name))))
      .when(this.state === "proposing", el => el.child(div().px(2).text_size(11).text_color(t.dim).child("Reading it...")))
      .when(Boolean(card), el => el.child(card))
      .when(Boolean(this.note) && this.state !== "proposing", el => el.child(h_flex().px(2).gap(4).items_center()
        .child(div().flex_1().min_w(0).text_size(10.5).text_color(t.muted).truncate().child(this.note))
        .child(div().id("wl-note-x").text_size(10.5).text_color(t.dim).cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.note = null; cx.notify(); }).child("x"))))
      .when(Boolean(this.error), el => el.child(div().px(2).text_size(10.5).text_color(t.ansi1).child(this.error)));
  }
}
