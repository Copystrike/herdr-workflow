// F1 sidebar: the repositories of the configured workspaces, with how many branches need you
// and how many are running. Clicking one selects it for wf-branches (shared "wf.repo").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, terminals, shared, setShared, nextCommand, checking } from "herdr";
import { listRepos, gatherRepo, prList, applyAgents, counts } from "./lib/wf/index.js";
import { exec, fs, setting, loadLocalConfig, track, flushTelemetry } from "./lib/wf/herdr-adapter.js";

const SCAN_MS = 120000; // full pass over every repo, PRs included
const FIRST_SCAN_MS = 4000;

export default class Repos extends View {
  init(_props, cx) {
    this.repos = null; // [{ name, dir, workspace }]
    this.models = {}; // dir -> gathered model
    this.scanning = false;
    track("mod", { mod: "wf-repos", action: "loaded" });
    if (checking()) return;
    this.load(cx);
    cx.timer.every(SCAN_MS, cx => this.scan(cx));
    cx.timer.every(15000, () => { flushTelemetry(); });
    // Key commands (keys.json "wf-repos.next"): next, prev, select:<repo name>.
    cx.spawn(async cx => { for (;;) { this.command(await nextCommand()); cx.notify(); } });
  }

  command(c) {
    const list = this.repos ?? [];
    if (!list.length) return;
    const [name, arg] = String(c).split(/:(.*)/s);
    const at = list.findIndex(r => r.dir === shared("wf.repo")?.dir);
    const pick = name === "next" ? list[(at + 1) % list.length] : name === "prev" ? list[(at - 1 + list.length) % list.length]
      : name === "select" ? list.find(r => r.name === arg) : null;
    if (!pick) return;
    setShared("wf.repo", { name: pick.name, dir: pick.dir }); setShared("wf.branch", null);
    track("ui", { surface: "wf-repos", action: `key-${name}` });
  }

  load(cx) {
    cx.spawn(async cx => {
      await loadLocalConfig();
      const out = [];
      for (const root of setting("wf.workspaces")) {
        for (const r of await listRepos(fs, root)) out.push({ ...r, workspace: root.split("/").pop() });
      }
      this.repos = out;
      if (!shared("wf.repo") && out.length) setShared("wf.repo", { name: out[0].name, dir: out[0].dir });
      cx.notify();
      // wf-branches reads the selected repository first: the host's file reads are shared, and a
      // full pass here would hold up its first paint.
      cx.timer.after(FIRST_SCAN_MS, cx => this.scan(cx));
    });
  }

  scan(cx) {
    if (this.scanning || !this.repos) return;
    this.scanning = true;
    const t0 = Date.now();
    cx.spawn(async cx => {
      try {
        // Two at a time: each repo runs several git calls, two gh calls and many file reads.
        const queue = [...this.repos];
        const worker = async () => {
          for (let r = queue.shift(); r; r = queue.shift()) {
            try { this.models[r.dir] = await gatherRepo({ exec, fs, repo: r, terminals: terminals(), fetchPrs: s => prList(exec, r.dir, s) }); }
            catch (e) { this.models[r.dir] = { error: String(e), rows: [] }; track("error", { mod: "wf-repos", error: "gather failed" }); }
            cx.notify();
          }
        };
        await Promise.all([worker(), worker()]);
        track("scan", { mod: "wf-repos", ms: Date.now() - t0, count: this.repos.length });
      } finally { this.scanning = false; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme();
    const live = terminals();
    const picked = shared("wf.repo");
    const rows = [];
    let workspace = null;
    for (const r of this.repos ?? []) {
      if (r.workspace !== workspace) {
        workspace = r.workspace;
        rows.push(div().px(10).pt(10).pb(4).text_size(11).text_color(t.dim).child(workspace));
      }
      const m = this.models[r.dir];
      const c = m && !m.error ? counts({ rows: applyAgents(m.rows, live) }) : null;
      const selected = picked?.dir === r.dir;
      rows.push(h_flex().id(`repo-${r.dir}`).h(28).flex_none().mx(4).px(8).gap(6).items_center().rounded(6).cursor_pointer()
        .when(selected, el => el.bg(t.selected)).hover(s => s.bg(selected ? t.selected : t.hover))
        .on_click(() => { setShared("wf.repo", { name: r.name, dir: r.dir }); setShared("wf.branch", null); track("ui", { surface: "wf-repos", action: "select", repo: r.name }); })
        .child(div().flex_1().min_w(0).truncate().text_color(selected ? t.foreground : t.muted).child(r.name))
        .when(!m, el => el.child(div().text_size(11).text_color(t.dim).child("…")))
        .when(Boolean(m?.error), el => el.child(div().text_size(11).text_color(t.ansi1).child("!")))
        .when(Boolean(c?.running), el => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.working + "26").text_size(10.5).text_color(t.working).flex().items_center().child(String(c.running))))
        .when(Boolean(c?.needs), el => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child(String(c.needs)))));
    }
    return v_flex().id("wf-repos").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().h(34).flex_none().px(12).items_center().gap(6)
        .child(div().flex_1().font_semibold().child("Repositories"))
        .when(this.scanning, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.dim).spin(900)))
        .child(div().id("wf-repos-rescan").text_size(11).text_color(t.dim).cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { track("ui", { surface: "wf-repos", action: "rescan" }); this.scan(cx); }).child("↻")))
      .child(v_flex().id("wf-repos-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(rows)
        .when(this.repos !== null && !this.repos.length, el => el.child(div().p(12).text_color(t.dim).text_size(12).child("No repositories in the configured workspaces"))));
  }
}
