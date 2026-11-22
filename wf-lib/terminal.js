// Global terminal interaction settings: PowerShell-style right-click copy/paste,
// copy-on-select, configurable soft-newline Enter key, and multiline paste confirmation.
// Pure helpers so both mods (wf-term-menu, wf-term-settings) and node tests share one truth table.

export const DEFAULT_TERM_SETTINGS = {
  copyOnSelect: true,
  newlineKey: "ctrl",          // "shift" | "ctrl"
  rightClick: "quick-edit",    // "quick-edit" ("Copy or paste") | "paste" | "menu"
  warnMultilinePaste: false,
};

export function mergeTermSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    copyOnSelect: typeof src.copyOnSelect === "boolean" ? src.copyOnSelect : DEFAULT_TERM_SETTINGS.copyOnSelect,
    newlineKey: src.newlineKey === "shift" || src.newlineKey === "ctrl" ? src.newlineKey : DEFAULT_TERM_SETTINGS.newlineKey,
    rightClick: src.rightClick === "quick-edit" || src.rightClick === "paste" || src.rightClick === "menu"
      ? src.rightClick
      : DEFAULT_TERM_SETTINGS.rightClick,
    warnMultilinePaste: typeof src.warnMultilinePaste === "boolean" ? src.warnMultilinePaste : DEFAULT_TERM_SETTINGS.warnMultilinePaste,
  };
}

// Decides what a terminal right-click should do given the user's mode and whether text is selected.
export function rightClickOutcome({ action, hasSelection }) {
  if (action === "menu") return "menu";
  if (action === "paste") return "paste";
  return hasSelection ? "copy" : "paste";
}

// Counts how many lines a paste spans. Terminals run a line on every CR/LF, so a trailing newline
// counts as submitting the line before it.
export function pasteLineCount(text) {
  if (!text) return 0;
  return String(text).replace(/\r\n|\n/g, "\r").split("\r").length;
}

export function pasteSubmits(text) {
  return pasteLineCount(text) > 1;
}

// Updates a parsed herdr keys.json object so the chosen modifier+Enter sends a soft newline
// (`\` + CR, accepted by Claude Code, Codex, Gemini and shells) while the other submits (`\r`).
export function applyNewlineKeyBindings(keysObj, newlineKey) {
  const base = keysObj && typeof keysObj === "object" && !Array.isArray(keysObj) ? keysObj : {};
  const term = base.terminal && typeof base.terminal === "object" && !Array.isArray(base.terminal) ? base.terminal : {};
  const soft = "send:\\\r";
  const submit = "send:\r";
  return {
    ...base,
    terminal: {
      ...term,
      "ctrl-enter": newlineKey === "ctrl" ? soft : submit,
      "shift-enter": newlineKey === "shift" ? soft : submit,
    },
  };
}

// Updates a parsed herdr settings.json object with the native `copy_on_select` toggle.
export function applyCopyOnSelectSetting(settingsObj, enabled) {
  const base = settingsObj && typeof settingsObj === "object" && !Array.isArray(settingsObj) ? settingsObj : {};
  return { ...base, copy_on_select: Boolean(enabled) };
}
