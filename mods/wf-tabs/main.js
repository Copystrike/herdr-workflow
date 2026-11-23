// Workflow tab bar: mirrors Herdr's tabs mod, but closing the last tab of a space
// transitions cleanly to the empty canvas ("Here your AI sessions will open") instead
// of popping up "Close space?" and jumping into an unrelated background space.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

function allTabIdsOf(allSpaces) {
  const ids = [];
  for (const s of allSpaces ?? []) {
    for (const tb of s.tabs ?? []) ids.push(tb.id);
  }
  return ids;
}

export default class WorkflowTabs extends View {
  init() {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.autoCollapsedSidebar = false;
    this.lastReviewMode = false;
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    this.prevSpaceId = null;
    this.prevSpaceTabCount = 0;
    this.prevAllTabIds = new Set();
  }

  wheel(e) {
    if (shared("wf.emptyView")?.on) return;
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  enterEmpty(allSpaces, mainStack) {
    const knownTabs = allTabIdsOf(allSpaces);
    setShared("wf.emptyView", { on: true, knownTabs, ts: Date.now() });
    if (mainStack && mainStack.active !== "empty") {
      run("layout.select", { stack: "main-stack", child: "empty" });
    }
  }

  exitEmpty(mainStack) {
    setShared("wf.emptyView", null);
    if (mainStack && mainStack.active !== "active-tab") {
      run("layout.select", { stack: "main-stack", child: "active-tab" });
    }
  }

  minimizeTab(allSpaces, mainStack) {
    this.enterEmpty(allSpaces, mainStack);
  }

  closeTab(tabId, space, allSpaces, mainStack) {
    const isLastInSpace = (space?.tabs?.length ?? 0) <= 1;
    if (isLastInSpace) {
      this.enterEmpty(allSpaces, mainStack);
    }
    run("tab.close", { id: tabId, confirmed: true });
  }

  render(cx) {
    const t = theme();
    const root = layout();
    const mainStack = find(root, "main-stack");
    const allSpaces = spaces() ?? [];
    const space = allSpaces.find(p => p.active);
    const spaceTabs = space?.tabs ?? [];
    const curAllTabIds = new Set(allTabIdsOf(allSpaces));
    const navTs = Number(shared("wf.navTs") ?? 0);
    let ev = shared("wf.emptyView");

    const isBoot = spaceTabs.length === 1 && (spaceTabs[0].name === "__ci_boot__" || spaceTabs[0].name === "__wf_boot__");

    // Reconcile empty-canvas state across tab closes, pane closes, Ctrl+W, and new spawns.
    if (isBoot) {
      if (mainStack && mainStack.active !== "empty") {
        run("layout.select", { stack: "main-stack", child: "empty" });
      }
    } else if (ev?.on) {
      const known = new Set(Array.isArray(ev.knownTabs) ? ev.knownTabs : []);
      // Only exit empty view once the *active* space actually holds a brand-new tab (prevents
      // flashing an old background space during the brief window before space.select lands).
      const activeHasNewTab = spaceTabs.some(tb => !known.has(tb.id) && tb.name !== "__ci_boot__" && tb.name !== "__wf_boot__");
      if (activeHasNewTab || (navTs && navTs > (ev.ts ?? 0))) {
        this.exitEmpty(mainStack);
        ev = null;
      } else if (mainStack && mainStack.active !== "empty") {
        run("layout.select", { stack: "main-stack", child: "empty" });
      }
    } else {
      if (!space || spaceTabs.length === 0) {
        if (mainStack && mainStack.active !== "empty") {
          run("layout.select", { stack: "main-stack", child: "empty" });
        }
      } else if (
        this.prevSpaceId &&
        this.prevSpaceId !== space.id &&
        this.prevSpaceTabCount <= 1 &&
        !allSpaces.some(s => s.id === this.prevSpaceId) &&
        Date.now() - navTs > 1200 &&
        spaceTabs.every(tb => this.prevAllTabIds.has(tb.id))
      ) {
        // The previous single-tab space was just closed (e.g. via pane close or Ctrl+W) and
        // Herdr fell back to an unrelated existing background space: stay on the empty canvas.
        this.enterEmpty(allSpaces, mainStack);
        ev = shared("wf.emptyView");
      } else if (mainStack && mainStack.active !== "active-tab") {
        run("layout.select", { stack: "main-stack", child: "active-tab" });
      }
    }

    this.prevSpaceId = ev?.on ? null : (space?.id ?? null);
    this.prevSpaceTabCount = ev?.on ? 0 : spaceTabs.length;
    this.prevAllTabIds = curAllTabIds;

    const isEmpty = isBoot || Boolean(ev?.on) || !space || spaceTabs.length === 0;
    const shown = isEmpty ? [] : spaceTabs;
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }

    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, lbl, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(lbl);
    const allPanes = panes() ?? [];
    const item = (c, i) => {
      const lead = allPanes.find(p => p.tab === c.id && p.program?.agent) ?? allPanes.find(p => p.tab === c.id);
      const program = lead?.program;
      const isAiTerminal = Boolean(lead?.terminal && program?.agent);
      const name = label(c, lead);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(h_flex().gap(2).items_center().flex_none()
          .when(isAiTerminal, e => e.child(div().id(`min-${c.id}`).size(18).rounded(4).flex().items_center().justify_center()
            .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Minimize to background (keeps AI session running)")
            .on_mouse_down("left", stop)
            .on_mouse_up("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); this.minimizeTab(allSpaces, mainStack); })
            .child(svg("mods/workspace-chrome/minus.svg").size(11))))
          .child(div().id(`close-${c.id}`).size(18).rounded(4).flex().items_center().justify_center()
            .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.ansi1))
            .tooltip(isAiTerminal ? "Close tab (stops AI session)" : "Close tab")
            .on_mouse_down("left", stop)
            .on_mouse_up("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(c.id, space, allSpaces, mainStack); })
            .child(svg("mods/pane/close.svg").size(11)))));
    };

    const sidebar = find(root, "sidebar"), w = window();
    // Auto-collapse Herdr's main left sidebar on code-review tabs (Explain / Diff) so code has
    // full horizontal width, and restore it when switching back to a terminal or other tab.
    const activeTabObj = !isEmpty && active >= 0 ? shown[active] : null;
    const isReviewMode = Boolean(activeTabObj && activeTabObj.name === "✦ Explain");
    if (isReviewMode !== this.lastReviewMode) {
      this.lastReviewMode = isReviewMode;
      const curW = sidebar?.size?.px ?? 320;
      const isNarrow = curW < 160;
      if (isReviewMode && !isNarrow) {
        this.autoCollapsedSidebar = true;
        const railPx = w?.platform === "macos" ? 76 : 44;
        cx.timer.after(1, () => {
          setShared("sidebar.width", curW);
          setShared("sidebar.collapsed", true);
          run("layout.resize", { id: "sidebar", px: railPx });
        });
      } else if (!isReviewMode && this.autoCollapsedSidebar) {
        this.autoCollapsedSidebar = false;
        if (isNarrow) {
          const restoreW = shared("sidebar.width") ?? 320;
          cx.timer.after(1, () => {
            setShared("sidebar.collapsed", false);
            run("layout.resize", { id: "sidebar", px: restoreW });
          });
        }
      }
    }
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    if (!isEmpty) this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, lbl, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(lbl);
    };

    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => {
        const br = shared("wf.branch");
        if (br?.path) {
          openOverlay({ mod: "wf-menu", kind: "popup", props: { mode: "new", worktree: br.path, repo: br.repo ?? null, branch: br.branch ?? null } });
        } else {
          openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
        }
      }))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(div().id("wf-term-prefs").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("All terminals settings (copy/paste, newline key)")
        .on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "wf-term-settings", kind: "dialog", width: 560, height: 420 }))
        .child(svg("mods/workspace-chrome/terminal.svg").size(13)))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
