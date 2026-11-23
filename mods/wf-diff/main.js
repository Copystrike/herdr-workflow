// Big center-pane Diff & File Viewer (Termic DiffPane style):
//   - Side-by-side Split diff (default) + Unified diff toggle
//   - Whole-file syntax-highlighted read-only Editor toggle ("Open")
//   - Breadcrumb path, mode/ref badge, Prev/Next file walk, and Mark as viewed toggle
//     (synced live with wf-changes via shared("wf.fileViewed") and localStorage)
//   - Driven by shared("wf.diffFocus") so clicking any file in wf-changes or wf-files
//     reuses this big viewer tab immediately without opening dozens of tabs.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, readTextFile, theme, settings, shared, setShared, spaces, run, notify, checking } from "herdr";
import { parseSplitDiff, githubUrlFor, languageForPath, syntaxPalette, tokenizeCodeLine, dedentDiffRows } from "./lib/wf/index.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const LS_DIFF_STYLE = "wf-diff.style"; // "split" | "unified"
const LS_DIFF_WRAP = "wf-diff.wrap";
const LS_VIEWED = "wf-changes.viewed";
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", cs: "c" };

function loadJson(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function saveJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

export default class WorkflowDiffViewer extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.spec = null;
    this.lastFocusTs = 0;
    this.style = loadJson(LS_DIFF_STYLE, "split") === "unified" ? "unified" : "split";
    this.wrapLines = loadJson(LS_DIFF_WRAP, true) !== false;
    this.viewWhole = false;
    this.loading = false;
    this.error = null;
    this.splitRows = [];
    this.unifiedRows = [];
    this.splitMinW = 900;
    this.uniMinW = 600;
    this.diffVisibleLimit = 220;
    this.diffWidth = 500;
    this.wholeText = null;
    this.wholeLang = "txt";
    this.wholeError = null;
    this.jumpLine = null;
    this.contextLines = 3; // expands when clicking unchanged-lines separator
    // Retained EditorState created ONLY outside render (init / async loadContent)!
    this.editorKey = "";
    this.fileEditor = this.makeEditor("txt");
    if (checking()) return;
    this.syncFromShared(cx, { fromRender: false });
  }

  makeEditor(lang) {
    const t = theme();
    const syn = syntaxPalette(t);
    this.editorKey = `${lang}|${t.background}|${t.accent}`;
    return EditorState.new({
      value: "",
      language: lang,
      readonly: true,
      line_numbers: true,
      font_family: settings().font_family ?? "JetBrains Mono",
      font_size: 12.5,
      syntax: syn,
    });
  }

  ensureEditorFor(path) {
    const lang = languageForPath(path);
    const t = theme();
    const want = `${lang}|${t.background}|${t.accent}`;
    if (this.editorKey !== want) {
      if (this.fileEditor?.release) this.fileEditor.release();
      this.fileEditor = this.makeEditor(lang);
    }
  }

  syncFromShared(cx, { fromRender = false } = {}) {
    const focus = shared("wf.diffFocus");
    if (!focus?.path || !focus?.root || focus.ts === this.lastFocusTs) return;
    this.lastFocusTs = focus.ts;
    this.spec = focus;
    this.viewWhole = focus.mode === "file";
    this.jumpLine = typeof focus.line === "number" ? focus.line : null;
    this.contextLines = 3;
    this.renameMyTab(focus);
    this.loadContent(cx, { fromRender });
  }

  renameMyTab(spec) {
    const base = spec.path.split("/").pop() || spec.path;
    const desired = spec.mode === "file" ? base : `Δ ${base}`;
    const activeSpace = (spaces() ?? []).find(s => s.active);
    const activeTab = (activeSpace?.tabs ?? []).find(tb => tb.active);
    if (activeTab && activeTab.name !== desired && (activeTab.name.startsWith("Δ ") || activeTab.name === "Diff" || activeTab.name === base || spec.tabId === activeTab.id)) {
      run("tab.rename", { id: activeTab.id, name: desired });
    }
  }

  isViewed() {
    const s = this.spec;
    if (!s?.root || !s?.path || !s?.fp) return false;
    const map = shared("wf.fileViewed") ?? loadJson(LS_VIEWED, {});
    return map?.[s.root]?.[s.path] === s.fp;
  }

  toggleViewed(cx, { advance = false } = {}) {
    const s = this.spec;
    if (!s?.root || !s?.path || !s?.fp) return;
    const nowViewed = this.isViewed();
    setShared("wf.gitAction", {
      type: "toggle-viewed",
      root: s.root,
      isDir: false,
      rel: s.path,
      fp: s.fp,
      files: [{ path: s.path, fp: s.fp }],
      mark: !nowViewed,
      ts: Date.now(),
    });
    // Also update shared mirror immediately so button state flips on the same frame
    const prev = shared("wf.fileViewed") ?? loadJson(LS_VIEWED, {});
    const cur = { ...(prev[s.root] ?? {}) };
    if (!nowViewed) cur[s.path] = s.fp;
    else delete cur[s.path];
    const next = { ...prev, [s.root]: cur };
    setShared("wf.fileViewed", next);
    saveJson(LS_VIEWED, next);
    if (advance && !nowViewed) this.stepFile(1, cx, { onlyUnviewed: true });
    cx.notify();
  }

  stepFile(delta, cx, { onlyUnviewed = false } = {}) {
    const s = this.spec;
    const list = Array.isArray(s?.fileList) ? s.fileList : [];
    if (list.length < 2) return;
    const idx = list.findIndex(f => f.path === s.path);
    if (idx < 0) return;
    const viewedMap = (shared("wf.fileViewed") ?? loadJson(LS_VIEWED, {}))[s.root] ?? {};
    for (let step = 1; step <= list.length; step++) {
      const ni = (idx + delta * step + list.length) % list.length;
      const cand = list[ni];
      if (onlyUnviewed && cand.fp && viewedMap[cand.path] === cand.fp) continue;
      setShared("wf.diffFocus", {
        ...s,
        path: cand.path,
        fresh: Boolean(cand.fresh),
        fp: cand.fp ?? "",
        status: cand.status ?? s.status,
        line: null,
        ts: Date.now(),
      });
      this.syncFromShared(cx);
      return;
    }
    if (onlyUnviewed) notify({ title: "All files reviewed", level: "success", timeout: 1800 });
  }

  loadContent(cx, { fromRender = false } = {}) {
    const s = this.spec;
    if (!s?.root || !s?.path) return;
    this.loading = true;
    this.error = null;
    this.wholeError = null;
    const seq = Date.now();
    this.loadSeq = seq;
    if (!fromRender) cx.notify();

    cx.spawn(async cx => {
      try {
        if (this.viewWhole || s.mode === "file" || s.fresh) {
          this.ensureEditorFor(s.path);
          const text = await readTextFile(`${s.root}/${s.path}`, { on: s.on ?? null }).catch(() => null);
          if (this.loadSeq !== seq) return;
          if (text === null) {
            this.wholeError = "File is unreadable or no longer on disk.";
            this.fileEditor.set_value("");
          } else if (text.includes("\0")) {
            this.wholeError = "Binary file (no text preview)";
            this.fileEditor.set_value("");
          } else {
            const clipped = text.length > 400000 ? text.slice(0, 400000) + "\n... (file truncated)" : text;
            const lines = clipped.split("\n");
            let display = clipped;
            if (this.jumpLine && this.jumpLine > 1 && this.jumpLine <= lines.length) {
              const startIdx = Math.max(0, this.jumpLine - 6);
              display = lines.slice(startIdx).join("\n");
            }
            this.wholeText = clipped;
            this.fileEditor.set_value(display);
          }
          if (s.fresh && !this.viewWhole && this.wholeText !== null) {
            const lines = this.wholeText.replace(/\n$/, "").split("\n").slice(0, 2000);
            const synthetic = `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
            this.prepareDiffRows(parseSplitDiff(synthetic), s.path);
          }
        }
        if (!this.viewWhole && s.mode !== "file" && !s.fresh) {
          const ctxFlag = `-U${this.contextLines}`;
          let args;
          if (s.mode === "staged") {
            args = ["diff", "--cached", ctxFlag, "--no-ext-diff", "--no-textconv", "--no-color", "--", s.path];
          } else if (s.mode === "unstaged") {
            args = ["diff", ctxFlag, "--no-ext-diff", "--no-textconv", "--no-color", "--", s.path];
          } else if (s.mode === "compare" && s.baseSha) {
            args = ["diff", s.baseSha, ctxFlag, "--no-ext-diff", "--no-textconv", "--no-color", "--", s.path];
          } else if (s.mode === "commit" && s.sha) {
            args = ["show", "--format=", ctxFlag, "--no-ext-diff", "--no-textconv", "--no-color", s.sha, "--", s.path];
          } else {
            args = ["diff", "HEAD", ctxFlag, "--no-ext-diff", "--no-textconv", "--no-color", "--", s.path];
          }
          const r = await exec("git", [...READ, ...args], { cwd: s.root, on: s.on ?? null });
          if (this.loadSeq !== seq) return;
          if (r.code !== 0) throw new Error((r.stderr || "git diff failed").trim());
          this.prepareDiffRows(parseSplitDiff(r.stdout), s.path);
        }
      } catch (e) {
        if (this.loadSeq === seq) this.error = String(e?.message ?? e);
      } finally {
        if (this.loadSeq === seq) this.loading = false;
        cx.notify();
      }
    });
  }

  prepareDiffRows(parsed, path) {
    const split = dedentDiffRows(parsed.split || [], "split");
    const unified = dedentDiffRows(parsed.unified || [], "unified");
    let maxS = 60;
    for (const r of split) {
      if (r.kind === "gap" || r.kind === "note") continue;
      if (r.left) {
        r.left.toks = tokenizeCodeLine(r.left.text ?? "", path);
        if ((r.left.text || "").length > maxS) maxS = r.left.text.length;
      }
      if (r.right) {
        r.right.toks = tokenizeCodeLine(r.right.text ?? "", path);
        if ((r.right.text || "").length > maxS) maxS = r.right.text.length;
      }
    }
    let maxU = 60;
    for (const r of unified) {
      if (r.kind === "gap" || r.kind === "note") continue;
      r.toks = tokenizeCodeLine(r.text ?? "", path);
      if ((r.text || "").length > maxU) maxU = r.text.length;
    }
    this.splitRows = split;
    this.unifiedRows = unified;
    this.splitMinW = Math.round(maxS * 7.2 + 64) * 2;
    this.uniMinW = Math.round(maxU * 7.2 + 100);
    this.diffVisibleLimit = 220;
  }

  toggleWholeFile(cx) {
    this.viewWhole = !this.viewWhole;
    this.loadContent(cx);
  }

  expandMoreContext(cx) {
    this.contextLines = this.contextLines < 25 ? 25 : this.contextLines < 200 ? 200 : 10000;
    this.loadContent(cx);
  }

  renderHighlightedCode(toks, fallbackText, pal) {
    const list = Array.isArray(toks) ? toks : tokenizeCodeLine(fallbackText, this.spec?.path || "");
    if (!list.length) return div().flex_1().min_w(0);
    if (this.wrapLines) {
      return h_flex().flex_1().min_w(0).flex_wrap().items_center().overflow_hidden()
        .children(list.map(tok => div().max_w_full().min_w(0).whitespace_normal().text_color(pal[tok.kind] || pal.plain).child(tok.text)));
    }
    return h_flex().flex_1().min_w(0).items_center().overflow_hidden()
      .children(list.map(tok => div().whitespace_nowrap().text_color(pal[tok.kind] || pal.plain).child(tok.text)));
  }

  renderSplitRow(row, t, i, pal) {
    if (row.kind === "note") {
      return div().px(14).py(10).text_size(12).text_color(t.dim).child(row.text);
    }
    if (row.kind === "gap") {
      return h_flex().id(`sgap-${i}`).h(24).w_full().flex_none().px(12).gap(8).items_center().bg(t.raised + "aa").border_y(1).border_color(t.border)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip("Click to expand surrounding unchanged lines")
        .on_click((_e, cx) => this.expandMoreContext(cx))
        .child(div().text_size(10.5).text_color(t.dim).child(`⋮  ${row.label}  (click to expand)`));
    }
    const cell = (side, sideKind) => {
      const bg = side?.kind === "-" ? t.ansi1 + "1a" : side?.kind === "+" ? t.ansi2 + "1a" : "#00000000";
      const numCol = side?.kind === "-" ? t.ansi1 : side?.kind === "+" ? t.ansi2 : t.dim;
      const prefix = side?.kind === "-" ? "−" : side?.kind === "+" ? "+" : " ";
      return h_flex().flex_1().min_w(0).min_h(21).py(1).px(4).gap(5).items_start().overflow_hidden().bg(bg)
        .when(sideKind === "left", el => el.border_r(1).border_color(t.border))
        .child(div().w(26).flex_none().text_right().text_size(10).text_color(numCol).opacity(side ? 0.75 : 0.2).child(side?.num != null ? String(side.num) : ""))
        .child(div().w(8).flex_none().text_size(10.5).text_color(numCol).child(side ? prefix : ""))
        .child(side ? this.renderHighlightedCode(side.toks, side.text ?? "", pal) : div().flex_1().min_w(0));
    };
    return h_flex().w_full().min_w(0).flex_none().min_h(21).items_stretch()
      .child(cell(row.left, "left"))
      .child(cell(row.right, "right"));
  }

  renderUnifiedRow(row, t, i, pal) {
    if (row.kind === "note") {
      return div().px(14).py(10).text_size(12).text_color(t.dim).child(row.text);
    }
    if (row.kind === "gap") {
      return h_flex().id(`ugap-${i}`).h(24).w_full().flex_none().px(12).gap(8).items_center().bg(t.raised + "aa").border_y(1).border_color(t.border)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip("Click to expand surrounding unchanged lines")
        .on_click((_e, cx) => this.expandMoreContext(cx))
        .child(div().text_size(10.5).text_color(t.dim).child(`⋮  ${row.label}  (click to expand)`));
    }
    const bg = row.kind === "+" ? t.ansi2 + "1a" : row.kind === "-" ? t.ansi1 + "1a" : "#00000000";
    const numCol = row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim;
    const glyph = row.kind === "+" ? "+" : row.kind === "-" ? "−" : " ";
    return h_flex().w_full().min_w(0).flex_none().min_h(21).py(1).px(6).gap(5).items_start().bg(bg)
      .child(div().w(28).flex_none().text_right().text_size(10).text_color(numCol).opacity(0.75).child(row.oldNum != null ? String(row.oldNum) : ""))
      .child(div().w(28).flex_none().text_right().text_size(10).text_color(numCol).opacity(0.75).child(row.newNum != null ? String(row.newNum) : ""))
      .child(div().w(8).flex_none().text_color(numCol).child(glyph))
      .child(this.renderHighlightedCode(row.toks, row.text ?? "", pal));
  }

  render(cx) {
    this.syncFromShared(cx, { fromRender: true });
    const t = theme();
    const s = this.spec;
    if (!s) {
      return v_flex().id("wf-diff-empty").size_full().bg(t.background).items_center().justify_center()
        .child(div().text_size(13).text_color(t.dim).child("Select a file from Changes or Files to inspect it here."));
    }

    const segs = String(s.path).split("/");
    const viewed = this.isViewed();
    const canView = Boolean(s.fp) && (s.mode === "unstaged" || s.mode === "staged" || s.mode === "compare");
    const fileCount = Array.isArray(s.fileList) ? s.fileList.length : 0;
    const fileIdx = fileCount ? s.fileList.findIndex(f => f.path === s.path) : -1;
    const modeLabel = s.mode === "compare" ? `Compare ${s.baseRef || "base"} → ${s.branch || "HEAD"}`
      : s.mode === "commit" ? `Commit ${(s.sha || "").slice(0, 7)}`
      : s.mode === "staged" ? "Staged"
      : s.mode === "unstaged" ? "Unstaged"
      : "File";
    const ghUrl = githubUrlFor({ slug: s.slug, ref: s.branch || "main", path: s.path, commit: s.sha || null });

    const btn = (id, label, active, onClick, { icon = null, tip = null, accent = false } = {}) =>
      h_flex().id(id).h(24).px(8).gap(5).items_center().rounded(5).cursor_pointer().flex_none()
        .bg(active ? (accent ? t.accent + "28" : t.selected) : t.raised)
        .border(1).border_color(active ? (accent ? t.accent : t.accent + "66") : t.border)
        .text_size(11.2).text_color(active ? (accent ? t.accent : t.foreground) : t.muted)
        .hover(st => st.bg(t.hover).text_color(t.foreground))
        .when(Boolean(tip), el => el.tooltip(tip))
        .on_click((_e, cx) => onClick(cx))
        .when(Boolean(icon), el => el.child(icon))
        .when(Boolean(label), el => el.child(div().whitespace_nowrap().child(label)));

    const rows = this.style === "split" ? this.splitRows : this.unifiedRows;
    const pal = syntaxPalette(t);
    const minRowW = this.style === "split" ? this.splitMinW : this.uniMinW;
    const visLimit = Math.max(100, this.diffVisibleLimit || 220);
    const visRows = rows.slice(0, visLimit);

    return v_flex().id("wf-diff").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      // Row 1: Breadcrumb path
      .child(h_flex().h(28).flex_none().px(14).gap(5).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .children(segs.map((seg, idx) => h_flex().gap(5).items_center()
          .when(idx > 0, el => el.child(div().text_size(10.5).text_color(t.dim).child("›")))
          .child(div().text_size(11.5).text_color(idx === segs.length - 1 ? t.foreground : t.dim).when(idx === segs.length - 1, e => e.font_medium()).child(seg))))
        .child(div().flex_1())
        .child(div().flex_none().px(6).h(17).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).flex().items_center().child(modeLabel)))
      // Row 2: Action toolbar (Split/Unified, Open whole file, Mark as viewed, Prev/Next, Copy, GitHub)
      .child(h_flex().h(36).flex_none().px(14).gap(6).items_center().bg(t.background).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).tooltip(s.path).child(s.path))
        .when(!this.viewWhole && s.mode !== "file", el => el
          .child(btn("vd-split", "Split", this.style === "split", cx => { this.style = "split"; saveJson(LS_DIFF_STYLE, "split"); cx.notify(); }, { tip: "Side-by-side split diff" }))
          .child(btn("vd-unified", "Unified", this.style === "unified", cx => { this.style = "unified"; saveJson(LS_DIFF_STYLE, "unified"); cx.notify(); }, { tip: "Inline unified diff" }))
          .child(btn("vd-wrap", "Wrap", this.wrapLines, cx => { this.wrapLines = !this.wrapLines; saveJson(LS_DIFF_WRAP, this.wrapLines); cx.notify(); }, { accent: true, tip: "Wrap long code lines" })))
        .when(s.mode !== "file" && s.status !== "D", el => el
          .child(btn("vd-open", this.viewWhole ? "Diff" : "Open", this.viewWhole, cx => this.toggleWholeFile(cx), {
            icon: svg("mods/workspace-chrome/file-text.svg").size(12).text_color(this.viewWhole ? t.accent : t.muted),
            tip: this.viewWhole ? "Back to diff view" : "Open whole file",
          })))
        .when(canView, el => el
          .child(btn("vd-viewed", viewed ? "Viewed" : "Mark as viewed", viewed, cx => this.toggleViewed(cx, { advance: true }), {
            icon: svg(viewed ? "mods/workspace-chrome/check.svg" : "mods/wf-changes/icons/eye.svg").size(12).text_color(viewed ? t.accent : t.muted),
            accent: true,
            tip: viewed ? "Unmark viewed" : "Mark as viewed and advance to next unviewed file",
          })))
        .when(fileCount > 1, el => el
          .child(btn("vd-prev", "", false, cx => this.stepFile(-1, cx), { icon: svg("mods/workspace-chrome/chevron-left.svg").size(12).text_color(t.muted), tip: "Previous file" }))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${fileIdx + 1}/${fileCount}`))
          .child(btn("vd-next", "", false, cx => this.stepFile(1, cx), { icon: svg("mods/workspace-chrome/chevron-right.svg").size(12).text_color(t.muted), tip: "Next file" })))
        .when(Boolean(ghUrl), el => el
          .child(btn("vd-gh", "GitHub", false, cx => cx.open_url(ghUrl), { tip: "Open on GitHub" }))))
      // Main body
      .when(this.loading, el => el.child(div().p(16).text_size(12.5).text_color(t.dim).child("Loading...")))
      .when(!this.loading && Boolean(this.error), el => el.child(div().p(16).text_size(12.5).text_color(t.ansi1).child(this.error)))
      .when(!this.loading && !this.error && (this.viewWhole || s.mode === "file"), el => el
        .child(this.wholeError
          ? div().p(16).text_size(12.5).text_color(t.dim).child(this.wholeError)
          : v_flex().flex_1().min_h(0)
            .when(Boolean(this.jumpLine && this.jumpLine > 1), e => e.child(h_flex().h(24).flex_none().px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
              .child(div().text_size(10.5).text_color(t.muted).child(`Jumped to line ${this.jumpLine}`))
              .child(div().id("vd-from1").text_size(10.5).text_color(t.accent).cursor_pointer()
                .on_click((_e, cx) => { this.jumpLine = null; if (this.wholeText != null) this.fileEditor.set_value(this.wholeText); cx.notify(); })
                .child("From line 1"))))
            .child(Editor.new(this.fileEditor).flex_1().min_h(0))))
      .when(!this.loading && !this.error && !this.viewWhole && s.mode !== "file", el => el
        .child(v_flex().id(this.style === "split" ? "wf-diff-split" : "wf-diff-uni").flex_1().min_h(0).overflow_y_scrollbar().when(!this.wrapLines, e => e.overflow_x_scrollbar())
          .font_family(settings().font_family ?? "JetBrains Mono").text_size(this.style === "split" ? 11 : 11.5)
          .child(v_flex().w_full().when(!this.wrapLines, e => e.min_w(minRowW))
            .children(visRows.length
              ? visRows.map((row, idx) => this.style === "split" ? this.renderSplitRow(row, t, idx, pal) : this.renderUnifiedRow(row, t, idx, pal))
              : [div().p(16).text_size(12).text_color(t.dim).child("No diff lines")])
            .when(rows.length > visRows.length, e => e.child(h_flex().id("vd-diff-more").w_full().flex_none().px(14).py(12).gap(8).items_center().justify_center()
              .bg(t.raised + "77").border_t(1).border_color(t.border)
              .child(div().text_size(11.2).text_color(t.dim).child(`Showing ${visRows.length} of ${rows.length} lines`))
              .child(div().id("vd-diff-more-btn").px(10).h(24).rounded(5).flex().items_center().text_size(11).font_medium().cursor_pointer()
                .bg(t.solid).text_color(t.solid_foreground).hover(st => st.opacity(0.9))
                .on_click((_e, cx) => { this.diffVisibleLimit = visRows.length + 250; cx.notify(); })
                .child(`Show ${Math.min(250, rows.length - visRows.length)} more`)))))))
  }
}
