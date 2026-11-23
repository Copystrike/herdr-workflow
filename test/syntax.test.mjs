import test from "node:test";
import assert from "node:assert/strict";
import { languageForPath, syntaxPalette, tokenizeCodeLine, dedentDiffRows } from "../wf-lib/syntax.js";

test("syntax: maps common extensions to EditorState languages", () => {
  assert.equal(languageForPath("src/app.tsx"), "js");
  assert.equal(languageForPath("backend/Service.cs"), "c");
  assert.equal(languageForPath("Cargo.toml"), "yaml");
  assert.equal(languageForPath("README.md"), "markdown");
  assert.equal(languageForPath("unknown.xyz"), "txt");
});

test("syntax: tokenizes keywords, types, functions, strings, numbers, and comments", () => {
  const toks = tokenizeCodeLine('public async Task<Order> Load(int count = 42) // fetch "ok"', "Order.cs");
  assert.equal(toks.some(t => t.kind === "keyword" && t.text === "public"), true);
  assert.equal(toks.some(t => t.kind === "type" && t.text === "Task"), true);
  assert.equal(toks.some(t => t.kind === "function" && t.text === "Load"), true);
  assert.equal(toks.some(t => t.kind === "number" && t.text === "42"), true);
  assert.equal(toks.some(t => t.kind === "comment" && t.text.includes("fetch")), true);
});

test("syntax: highlights JSON keys vs string values and derives palette from theme", () => {
  const toks = tokenizeCodeLine('  "theme": "monospace-dark",', "settings.json");
  assert.equal(toks.some(t => t.kind === "function" && t.text === '"theme"'), true);
  assert.equal(toks.some(t => t.kind === "string" && t.text === '"monospace-dark"'), true);

  const pal = syntaxPalette({ ansi5: "#a87ffb", ansi2: "#17b877", foreground: "#d9dfe7" });
  assert.equal(pal.keyword, "#a87ffb");
  assert.equal(pal.string, "#17b877");
  assert.equal(pal.plain, "#d9dfe7");
});

test("syntax: dedentDiffRows trims excess common leading indent per hunk while preserving relative nesting", () => {
  const rows = [
    { kind: "gap", label: "hunk 1" },
    { kind: " ", text: "            if (ok) {" },
    { kind: "+", text: "                return 1;" },
    { kind: " ", text: "            }" },
  ];
  const out = dedentDiffRows(rows, "unified");
  assert.equal(out[1].text, "  if (ok) {");
  assert.equal(out[2].text, "      return 1;");
  assert.equal(out[3].text, "  }");
});
