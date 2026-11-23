// Workflow footer bar (replaces workspace-status):
//   - Preserves host, active branch, agent count / needs-you indicator, and command palette hint
//   - Adds a Termic-style Claude usage pill ([ * | 16% ctx | 17% 5h | 19% wk ]) that reads
//     ~/.config/herdr-app/data/wf/usage.json live and opens wf-usage-popover on click.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  spaces, panes, focused, agents, theme, settings, run, window, keys,
  appHome, readTextFile, openOverlay, shared, checking,
} from "herdr";
import { selectActiveContext } from "./lib/wf/index.js";

function withAlpha(hex, aa) {
  const s = String(hex || "#888888");
  return (s.length === 9 ? s.slice(0, 7) : s) + aa;
}

function pctColor(pct, t) {
  if (pct == null) return t.dim;
  if (pct >= 90) return t.ansi1 || "#ef4444";
  if (pct >= 75) return t.blocked || "#f59e0b";
  return t.muted;
}

function currentCwd() {
  const picked = shared("wf.branch");
  if (picked?.path) return picked.path;
  const f = focused();
  const p = f?.pane ? (panes() ?? []).find(x => x.pane === f.pane) : null;
  const sp = (spaces() ?? []).find(s => s.active);
  return p?.cwd || f?.cwd || sp?.folder || null;
}

export default class WorkflowStatus extends View {
  init(_props, cx) {
    this.usage = null;
    this.lastRaw = "";
    if (checking()) return;
    this.pollUsage(cx);
    cx.timer.every(3000, cx => this.pollUsage(cx));
  }

  pollUsage(cx) {
    cx.spawn(async cx => {
      try {
        const raw = await readTextFile(`${appHome()}/data/wf/usage.json`).catch(() => null);
        if (!raw || raw === this.lastRaw) return;
        this.lastRaw = raw;
        this.usage = JSON.parse(raw);
        cx.notify();
      } catch {}
    });
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find(k => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map(p => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = (spaces() ?? []).find(s => s.active);
    const list = agents() ?? [];
    const needs = list.filter(a => a.status === "blocked").length;
    const cwd = currentCwd();
    const ctx = selectActiveContext(this.usage, cwd);
    const ctxPct = ctx?.ctxPct ?? null;
    const fivePct = this.usage?.fiveHour?.pct ?? null;
    const weekPct = this.usage?.sevenDay?.pct ?? null;

    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const metric = (pct, suffix) => h_flex().h(19).px(6).gap(3).items_center().rounded(4).bg(t.raised)
      .child(div().text_size(10.8).font_medium().text_color(pctColor(pct, t)).child(pct != null ? `${pct}%` : "--"))
      .child(div().text_size(10.2).text_color(t.dim).child(suffix));

    return h_flex().size_full().px(14).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      // Termic-style live usage pill
      .child(h_flex().id("wf-usage-pill").h(22).px(5).gap(4).items_center().rounded(6)
        .bg(t.background + "aa").border(1).border_color(t.border).cursor_pointer()
        .hover(s => s.bg(t.hover).border_color(withAlpha(t.accent, "66")))
        .tooltip("Claude usage: Context / 5h session / Weekly limit (click for details)")
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          const W = 324, H = 368, GAP = 10;
          const zoom = Number(settings()?.zoom) || 1;
          const renderedW = Math.round(W * zoom);
          const renderedH = Math.round(H * zoom);
          const b = e?.bounds;
          const pos = e?.position;
          const btnTop = b?.y ?? (pos?.y != null ? pos.y - Math.round(14 * zoom) : null);
          const btnRight = b ? (b.x + b.width) : (pos?.x != null ? pos.x + Math.round(90 * zoom) : null);
          const at = btnTop != null && btnRight != null
            ? { x: Math.max(8, Math.round(btnRight - renderedW)), y: Math.max(8, Math.round(btnTop - renderedH - GAP)) }
            : "pointer";
          openOverlay({ mod: "wf-usage-popover", kind: "popup", frame: "none", width: W, height: H, at, props: { cwd } });
        })
        .child(div().px(3).text_size(12).font_semibold().text_color("#d97757").child("✳"))
        .child(metric(ctxPct, "ctx"))
        .child(metric(fivePct, "5h"))
        .child(metric(weekPct, "wk")))
      .child(div().id("palette").text_color(t.dim).cursor_pointer().hover(s => s.text_color(t.foreground))
        .on_click(() => run("app.palette")).child(this.hint()));
  }
}
