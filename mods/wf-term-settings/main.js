// Global "All terminals" settings dialog for herdr-workflow:
//   - Copy on select (native settings.json `copy_on_select`, live-reloaded by herdr-app)
//   - Newline key (Shift+Enter vs Ctrl+Enter, written live to keys.json `terminal` section)
//   - Right click ("Copy or paste" Windows PowerShell gesture, "Paste", or "Menu")
//   - Warn before pasting multiple lines (guards right-click pastes spanning >1 line)
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, shared, setShared, props, closeOverlay, appHome, readTextFile, writeTextFile, checking } from "herdr";
import { mergeTermSettings, applyNewlineKeyBindings, applyCopyOnSelectSetting } from "./lib/wf/index.js";

async function updateJsonFile(path, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readTextFile(path);
    let parsed = {};
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { return `Could not parse ${path}`; }
    }
    const next = mutate(parsed);
    const out = JSON.stringify(next, null, 2) + "\n";
    try {
      await writeTextFile(path, out, raw ?? null);
      return null;
    } catch {
      // Retry on compare-and-set race
    }
  }
  return `Could not save ${path}`;
}

export default class TerminalSettings extends View {
  init(_props, cx) {
    this.cfg = mergeTermSettings(shared("wf.termSettings"));
    this.error = null;
    this.savedNote = null;
    this.handle = cx.focus_handle();
    if (checking()) return;
    this.handle.focus();
    cx.spawn(async cx => {
      await this.syncFromFiles();
      cx.notify();
    });
  }

  async syncFromFiles() {
    const cur = mergeTermSettings(shared("wf.termSettings"));
    try {
      const sRaw = await readTextFile(`${appHome()}/settings.json`);
      if (sRaw) {
        const s = JSON.parse(sRaw);
        if (typeof s.copy_on_select === "boolean") cur.copyOnSelect = s.copy_on_select;
      }
    } catch {}
    try {
      const kRaw = await readTextFile(`${appHome()}/keys.json`);
      if (kRaw) {
        const k = JSON.parse(kRaw);
        const term = k?.terminal ?? {};
        if (term["shift-enter"] === "send:\\\r") cur.newlineKey = "shift";
        else if (term["ctrl-enter"] === "send:\\\r") cur.newlineKey = "ctrl";
      }
    } catch {}
    this.cfg = cur;
    setShared("wf.termSettings", cur);
  }

  persist(patch, cx, fileOp = null) {
    this.cfg = mergeTermSettings({ ...this.cfg, ...patch });
    this.error = null;
    setShared("wf.termSettings", this.cfg);
    cx.notify();
    if (!fileOp) {
      this.savedNote = "Applied to all terminals";
      cx.notify();
      return;
    }
    cx.spawn(async cx => {
      const err = await fileOp();
      this.error = err;
      this.savedNote = err ? null : "Applied to all terminals";
      cx.notify();
    });
  }

  toggleCopyOnSelect(cx) {
    const next = !this.cfg.copyOnSelect;
    this.persist({ copyOnSelect: next }, cx, () =>
      updateJsonFile(`${appHome()}/settings.json`, obj => applyCopyOnSelectSetting(obj, next)));
  }

  setNewlineKey(key, cx) {
    if (this.cfg.newlineKey === key) return;
    this.persist({ newlineKey: key }, cx, () =>
      updateJsonFile(`${appHome()}/keys.json`, obj => applyNewlineKeyBindings(obj, key)));
  }

  setRightClick(mode, cx) {
    if (this.cfg.rightClick === mode) return;
    this.persist({ rightClick: mode }, cx);
  }

  toggleWarnMultiline(cx) {
    this.persist({ warnMultilinePaste: !this.cfg.warnMultilinePaste }, cx);
  }

  renderToggle(t, id, on, onClick) {
    return h_flex().id(id).w(38).h(22).p(2).rounded_full().items_center().flex_none().cursor_pointer()
      .bg(on ? t.accent : t.raised).border(1).border_color(on ? t.accent : t.border)
      .justify_end().when(!on, el => el.justify_start())
      .on_click((_e, cx) => onClick(cx))
      .child(div().size(16).rounded_full().bg(on ? t.solid_foreground : t.muted));
  }

  renderSegmented(t, idPrefix, options, value, onSelect) {
    return h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.background).border(1).border_color(t.border)
      .children(options.map(([optVal, label]) => {
        const active = value === optVal;
        return div().id(`${idPrefix}-${optVal}`).px(10).h(24).rounded(5).flex().items_center().text_size(11.5).cursor_pointer()
          .bg(active ? t.accent : "#00000000")
          .text_color(active ? t.solid_foreground : t.muted)
          .when(active, el => el.font_semibold())
          .hover(s => active ? s : s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => onSelect(optVal, cx))
          .child(label);
      }));
  }

  renderRow(t, title, hint, control) {
    return h_flex().py(10).gap(16).items_start().justify_between().border_t(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11.5).text_color(t.dim).whitespace_normal().child(hint)))
      .child(div().pt(2).flex_none().child(control));
  }

  render(cx) {
    const t = theme();
    return v_flex().id("wf-term-settings").track_focus(this.handle).size_full().p(18).gap(8).bg(t.popover).text_color(t.foreground)
      .on_key_down(e => { if (e.key === "escape") closeOverlay(props()?.overlay); })
      .child(h_flex().pb(4).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(15).font_semibold().child("All terminals"))
          .child(div().text_size(11.5).text_color(t.dim).child("Global copy, paste, and newline behavior for every terminal pane.")))
        .child(div().id("ts-close").px(8).h(24).rounded(5).flex().items_center().text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(props()?.overlay)).child("Close")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .child(this.renderRow(
          t,
          "Copy on select",
          "iTerm-style: selecting text with the mouse in any terminal copies it to the clipboard automatically. Applies to every terminal.",
          this.renderToggle(t, "ts-cos", this.cfg.copyOnSelect, cx => this.toggleCopyOnSelect(cx)),
        ))
        .child(this.renderRow(
          t,
          "Newline key",
          "Which modifier plus Enter inserts a newline in the agent prompt instead of sending it. The other combination submits like a bare Enter.",
          this.renderSegmented(t, "ts-nl", [["shift", "Shift+Enter"], ["ctrl", "Ctrl+Enter"]], this.cfg.newlineKey, (v, cx) => this.setNewlineKey(v, cx)),
        ))
        .child(this.renderRow(
          t,
          "Right click",
          "What the right mouse button does in a terminal. \"Copy or paste\" is the Windows console gesture: copies when text is selected and pastes when nothing is. \"Menu\" opens the context menu instead.",
          this.renderSegmented(t, "ts-rc", [["quick-edit", "Copy or paste"], ["paste", "Paste"], ["menu", "Menu"]], this.cfg.rightClick, (v, cx) => this.setRightClick(v, cx)),
        ))
        .child(this.renderRow(
          t,
          "Warn before pasting multiple lines",
          "A terminal runs a line as soon as its newline arrives, so a paste spanning multiple lines submits them immediately. Asks before right-click paste.",
          this.renderToggle(t, "ts-warn", this.cfg.warnMultilinePaste, cx => this.toggleWarnMultiline(cx)),
        )))
      .when(Boolean(this.error), el => el.child(div().text_size(11.5).text_color(t.ansi1).child(this.error)))
      .when(!this.error && Boolean(this.savedNote), el => el.child(div().text_size(11.5).text_color(t.dim).child(this.savedNote)));
  }
}
