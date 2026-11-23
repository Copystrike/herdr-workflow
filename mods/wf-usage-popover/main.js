// Termic-style Claude usage details popover:
//   - Context (this conversation, tokens / window)
//   - Session (rolling 5 hours, reset time)
//   - Weekly (rolling 7 days, reset day + time)
//   - Would have cost ($ at API rates across tracked sessions)
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, appHome, readTextFile, checking } from "herdr";
import { selectActiveContext, formatTokensCompact, formatResetTime, formatUsd } from "./lib/wf/index.js";

function barColor(pct, t) {
  if (pct == null) return t.border;
  if (pct >= 90) return t.ansi1 || "#ef4444";
  if (pct >= 75) return t.blocked || "#f59e0b";
  return t.muted || "#94a3b8";
}

export default class UsagePopover extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.usage = null;
    if (checking()) return;
    this.handle.focus();
    this.load(cx);
    cx.timer.every(3000, cx => this.load(cx));
  }

  load(cx) {
    cx.spawn(async cx => {
      try {
        const raw = await readTextFile(`${appHome()}/data/wf/usage.json`).catch(() => null);
        if (!raw) return;
        this.usage = JSON.parse(raw);
        cx.notify();
      } catch {}
    });
  }

  renderMeter(t, title, pct, leftSub, rightSub) {
    const clamped = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
    const fillW = Math.round((clamped / 100) * 284);
    return v_flex().gap(5)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(12.5).font_medium().text_color(t.foreground).child(title))
        .child(div().text_size(12.5).font_medium().text_color(pct != null && pct >= 75 ? barColor(pct, t) : t.muted).child(pct != null ? `${pct}%` : "--")))
      .child(div().w(284).h(6).rounded_full().bg(t.raised).overflow_hidden()
        .when(clamped > 0, el => el.child(div().h(6).w(Math.max(6, fillW)).rounded_full().bg(barColor(pct, t)))))
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(leftSub))
        .when(Boolean(rightSub), el => el.child(div().text_size(11).text_color(t.dim).child(rightSub))));
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const u = this.usage;
    const ctx = selectActiveContext(u, p.cwd || null);
    const ctxRight = ctx?.ctxUsed != null && ctx?.ctxSize != null
      ? `${formatTokensCompact(ctx.ctxUsed)} / ${formatTokensCompact(ctx.ctxSize)} tokens`
      : "waiting for next turn";
    const fiveRight = u?.fiveHour?.resetsAt ? formatResetTime(u.fiveHour.resetsAt, { showDay: false }) : "";
    const weekRight = u?.sevenDay?.resetsAt ? formatResetTime(u.sevenDay.resetsAt, { showDay: true }) : "";
    const costLabel = u?.totalCostUsd ? formatUsd(u.totalCostUsd) : "--";

    return v_flex().id("wf-usage-popover").track_focus(this.handle).size_full().p(16).gap(13)
      .bg(t.chrome).border(1).border_color(t.border).rounded(10).text_color(t.foreground)
      .on_key_down(e => { if (e.key === "escape") closeOverlay(p.overlay); })
      // Header
      .child(h_flex().gap(7).items_center()
        .child(div().text_size(14).font_semibold().text_color("#d97757").child("✳"))
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(u?.agent || "claude"))
        .when(Boolean(ctx?.model), el => el.child(div().px(6).h(17).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).flex().items_center().child(ctx.model)))
        .child(div().flex_1())
        .child(div().id("up-close").size(20).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(p.overlay))
          .child(svg("mods/workspace-chrome/x.svg").size(11))))
      // 3 Meters: Context, Session (5h), Weekly (7d)
      .child(this.renderMeter(t, "Context", ctx?.ctxPct ?? null, "this conversation", ctxRight))
      .child(this.renderMeter(t, "Session", u?.fiveHour?.pct ?? null, "rolling 5 hours", fiveRight))
      .child(this.renderMeter(t, "Weekly", u?.sevenDay?.pct ?? null, "rolling 7 days", weekRight))
      // Divider + Would have cost
      .child(div().h(1).w_full().bg(t.border))
      .child(v_flex().gap(3)
        .child(h_flex().items_center()
          .child(div().flex_1().text_size(12.2).text_color(t.muted).child("Would have cost"))
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child(costLabel)))
        .child(div().text_size(10.8).text_color(t.dim).whitespace_normal().child("at API rates across tracked sessions. Your plan covers it.")))
      .child(div().text_size(10.5).text_color(t.dim).child(
        u ? "Reported by the agent as it works." : "Send a message in Claude Code to populate live usage."
      ));
  }
}
