// Custom terminal right-click handler (`"terminal_menu": "wf-term-menu"` in workflow.json).
// Implements Windows console / PowerShell right-click gestures ("Copy or paste", "Paste", or
// full context "Menu") controlled by shared `wf.termSettings`, with optional multiline paste guard.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, panes, focused, shared, setShared, checking } from "herdr";
import { mergeTermSettings, rightClickOutcome, pasteLineCount, pasteSubmits } from "./lib/wf/index.js";

function menuIcon(command) {
  if (command === "terminal.copy") return "mods/workspace-chrome/files.svg";
  if (command === "terminal.paste") return "mods/workspace-chrome/file-text.svg";
  if (command === "wf-term-settings") return "mods/workspace-chrome/settings.svg";
  const name = command.endsWith(".close") ? "x" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

function shortcut(name, args) {
  const value = args && Object.values(args)[0];
  const k = keys().find(b => (b.section === "global" || b.section === "terminal") && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class TerminalMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.mode = "menu"; // "menu" | "confirm-paste" | "closing"
    this.pendingPaste = null; // { lines, target }
    this.handle = cx.focus_handle();
    if (checking()) return;

    const p = props() ?? {};
    const tg = p.target ?? {};
    const cfg = mergeTermSettings(shared("wf.termSettings"));
    const term = terminals().find(t => t.address === tg.terminal);
    const hasSelection = Boolean(term?.selection);
    const outcome = rightClickOutcome({ action: cfg.rightClick, hasSelection });

    if (outcome === "copy") {
      this.mode = "closing";
      if (tg.pane && focused()?.pane !== tg.pane) run("pane.focus", { pane: tg.pane });
      run("terminal.copy", {});
      if (tg.terminal) run("terminal.clear_selection", { terminal: tg.terminal });
      if (p.overlay) closeOverlay(p.overlay);
      return;
    }

    if (outcome === "paste") {
      const clip = cx.read_from_clipboard?.();
      if (cfg.warnMultilinePaste && clip && pasteSubmits(clip)) {
        this.mode = "confirm-paste";
        this.pendingPaste = { lines: pasteLineCount(clip), target: tg };
        this.handle.focus();
        return;
      }
      this.mode = "closing";
      this.performPaste(tg, clip);
      if (p.overlay) closeOverlay(p.overlay);
      return;
    }

    this.handle.focus();
  }

  performPaste(tg, clip) {
    if (tg?.pane && focused()?.pane !== tg.pane) run("pane.focus", { pane: tg.pane });
    if (clip && clip.length > 0) run("terminal.paste", {});
    else run("terminal.paste_image", {});
  }

  menuItems() {
    const p = props() ?? {};
    const tg = p.target ?? {};
    const all = terminals();
    const term = all.find(t => t.address === tg.terminal);
    const parent = term?.parent && all.find(t => t.address === term.parent);
    const toProgram = term?.labels?.["herdr.right-click"] === "program";
    const inTab = panes().some(pane => pane.pane === tg.pane);
    const hasSel = Boolean(term?.selection);

    return [
      ...(hasSel ? [["Copy", "terminal.copy", { _focusPane: tg.pane, _clearTerminal: tg.terminal }]] : []),
      ["Paste", "terminal.paste", { _focusPane: tg.pane }],
      ["Select all", "terminal.select_all", { terminal: tg.terminal }],
      ...(inTab ? [
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
      ] : []),
      ...(term ? [
        toProgram
          ? ["Use Herdr right-click", "terminal.right_click", { terminal: term.address, to: "menu" }]
          : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
      ] : []),
      ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
      ["All terminals settings...", "wf-term-settings", {}],
      ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
    ];
  }

  choose(i, cx) {
    const it = this.menuItems()[i];
    if (!it) return;
    const p = props() ?? {};
    if (p.overlay) closeOverlay(p.overlay);
    const [, cmd, args] = it;
    if (cmd === "wf-term-settings") {
      openOverlay({ mod: "wf-term-settings", kind: "dialog", width: 540, height: 420 });
      return;
    }
    if (cmd === "terminal.copy") {
      if (args._focusPane && focused()?.pane !== args._focusPane) run("pane.focus", { pane: args._focusPane });
      run("terminal.copy", {});
      if (args._clearTerminal) run("terminal.clear_selection", { terminal: args._clearTerminal });
      return;
    }
    if (cmd === "terminal.paste") {
      const clip = cx.read_from_clipboard?.();
      this.performPaste({ pane: args._focusPane }, clip);
      return;
    }
    run(cmd, args);
  }

  confirmPasteNow(disableWarning, cx) {
    const p = props() ?? {};
    const tg = this.pendingPaste?.target ?? p.target;
    if (disableWarning) {
      const cur = mergeTermSettings(shared("wf.termSettings"));
      setShared("wf.termSettings", { ...cur, warnMultilinePaste: false });
    }
    if (p.overlay) closeOverlay(p.overlay);
    this.performPaste(tg, cx.read_from_clipboard?.());
  }

  render(cx) {
    const t = theme();
    if (this.mode === "closing") return div().size(1);

    if (this.mode === "confirm-paste") {
      const lines = this.pendingPaste?.lines ?? 2;
      return v_flex().id("wf-term-paste-confirm").track_focus(this.handle).w_full().p(12).gap(10).bg(t.popover).text_color(t.foreground).text_size(12.5)
        .on_key_down((e, cx) => {
          if (e.key === "escape") closeOverlay(props()?.overlay);
          else if (e.key === "enter") this.confirmPasteNow(false, cx);
        })
        .child(div().font_semibold().text_size(13).child(`Paste ${lines} lines?`))
        .child(div().text_size(11.5).text_color(t.muted).whitespace_normal()
          .child(`The clipboard holds ${lines} lines. A terminal runs each line as soon as its newline arrives.`))
        .child(h_flex().gap(6).justify_end().pt(4)
          .child(div().id("paste-cancel").px(9).h(26).rounded(6).flex().items_center().bg(t.raised).text_color(t.foreground).cursor_pointer()
            .hover(s => s.bg(t.hover)).on_click(() => closeOverlay(props()?.overlay)).child("Cancel"))
          .child(div().id("paste-always").px(9).h(26).rounded(6).flex().items_center().bg(t.raised).text_color(t.muted).cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.confirmPasteNow(true, cx)).child("Always paste"))
          .child(div().id("paste-go").px(10).h(26).rounded(6).flex().items_center().bg(t.solid).text_color(t.solid_foreground).font_semibold().cursor_pointer()
            .hover(s => s.opacity(0.9)).on_click((_e, cx) => this.confirmPasteNow(false, cx)).child("Paste")));
    }

    const list = this.menuItems();
    return v_flex().id("wf-term-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at - 1 + list.length) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => {
        const sep = i > 0 && (it[1] === "pane.split" && list[i - 1][1] !== "pane.split" || it[1] === "wf-term-settings" || it[1] === "pane.close");
        return v_flex()
          .when(sep, el => el.child(div().mx(7).my(3).h(1).bg(t.border)))
          .child(h_flex().id(`tm-${i}`).h(29).px(8).gap(8).rounded(6).items_center().justify_between().text_color(t.foreground)
            .when(i === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(13).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(10.5).text_color(t.dim).child(shortcut(it[1], it[2]))));
      }));
  }
}
