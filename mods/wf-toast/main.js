// Custom notification toast mod (`"toast": "wf-toast"` in workflow.json).
// Supports Termic-style persistent dismissible action toasts (e.g. merged PR -> [Archive] / [x])
// while rendering standard Herdr notifications cleanly.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, shared, setShared } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

function recordDismissed(key) {
  if (!key) return;
  const prev = shared("wf.mergedDismissed");
  const list = Array.isArray(prev) ? prev : [];
  if (!list.includes(key)) setShared("wf.mergedDismissed", [...list.slice(-199), key]);
}

export default class WorkflowToast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const args = p.action?.args ?? null;
    const actionButton = typeof args?.button === "string" && args.button ? args.button : null;

    // Persistent dismissible action toast (Termic style: amber accent border + explicit action button + x)
    if (actionButton) {
      const accent = p.level === "error" ? t.ansi1 : p.level === "success" ? t.done : t.blocked;
      return h_flex()
        .id("wf-toast-action")
        .size_full()
        .px(10)
        .py(6)
        .gap(8)
        .items_center()
        .rounded(8)
        .bg(t.popover)
        .border(1)
        .border_color(accent)
        .child(div().size(18).flex_none().rounded(4).bg(accent + "22").flex().items_center().justify_center()
          .text_size(11).font_bold().text_color(accent).child("!"))
        .child(v_flex().flex_1().min_w(0).overflow_hidden().gap(2)
          .tooltip(p.body ? `${p.title}\n${p.body}` : (p.title ?? ""))
          .child(div().w_full().truncate().text_size(12).font_semibold().text_color(t.foreground).child(p.title ?? ""))
          .when(Boolean(p.body), el => el.child(div().w_full().truncate().text_size(11).text_color(t.muted).child(p.body ?? ""))))
        .child(div().id("wf-toast-btn").flex_none().px(9).h(26).rounded(6).flex().items_center()
          .bg(t.raised).border(1).border_color(t.border).text_size(11.5).font_medium().text_color(t.foreground).cursor_pointer()
          .hover(s => s.bg(t.selected).border_color(accent))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (args.dismissKey) recordDismissed(args.dismissKey);
            if (args.worktree && p.action?.name === "wf-sidebar.archive") {
              setShared("wf.archiveReq", {
                worktree: args.worktree,
                repo: args.repo ?? null,
                branch: args.branch ?? null,
                prNumber: args.prNumber ?? null,
                dismissKey: args.dismissKey ?? null,
                ts: Date.now(),
              });
            } else if (p.action?.name) {
              run(p.action.name, args ?? {});
            }
            closeOverlay(p.overlay);
          })
          .child(actionButton))
        .child(div().id("wf-toast-x").size(22).flex_none().rounded(5).flex().items_center().justify_center()
          .text_color(t.dim).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Dismiss")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (args.dismissKey) recordDismissed(args.dismissKey);
            closeOverlay(p.overlay);
          })
          .child(svg("mods/workspace-chrome/x.svg").size(11)));
    }

    // Standard Herdr notification toast
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    return h_flex()
      .id("toast")
      .size_full()
      .px(18)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
          .when(!login && Boolean(p.body), el => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
          .when(Boolean(login), el => el.child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
            .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
              .child(this.copied ? "Copied" : "Copy")))),
      );
  }
}
