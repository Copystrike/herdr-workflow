// Clean empty canvas shown in main-stack when the last tab is closed instead of
// jumping into an unrelated background space.
import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";

export default class WorkflowEmpty extends View {
  render() {
    const t = theme();
    return v_flex()
      .id("wf-empty")
      .size_full()
      .min_h(0)
      .rounded(10)
      .border(1)
      .border_color(t.border)
      .bg(t.background)
      .items_center()
      .justify_center()
      .gap(8)
      .child(svg("mods/workspace-chrome/layers.svg").size(22).text_color(t.dim).opacity(0.6))
      .child(div().text_size(14).font_medium().text_color(t.muted).child("Here your AI sessions will open"))
      .child(div().text_size(11.8).text_color(t.dim).child("Select a branch or session in the sidebar, or click + to start one."));
  }
}
