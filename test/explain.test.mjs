import test from "node:test";
import assert from "node:assert/strict";
import {
  diffPatchState,
  buildExplainPrompt,
  buildBugHuntPrompt,
  buildAskPrompt,
  extractAiJson,
  mergeExplainResult,
  summarizeExplain,
  searchExplainReview,
  formatFindingFixPrompt,
  formatQaContinuePrompt,
  normalizeExplainConfig,
  addExplainLanguage,
  isNonProductionFile,
  filterBugHuntFiles,
  layoutDiagram,
  parseInlineMarkdown,
  branchStateHash,
} from "../wf-lib/explain.js";

test("explain: diffPatchState partitions unchanged, added, modified, and removed files", () => {
  const cached = {
    version: 1,
    files: {
      "a.js": { patchHash: "h1", status: "M", added: 10, removed: 2 },
      "b.js": { patchHash: "h2", status: "M", added: 5, removed: 0 },
      "deleted.js": { patchHash: "h3", status: "A", added: 20, removed: 0 },
    },
  };
  const current = [
    { path: "a.js", patchHash: "h1", status: "M", added: 10, removed: 2 },
    { path: "b.js", patchHash: "h2-new", status: "M", added: 8, removed: 1 },
    { path: "c.js", patchHash: "h4", status: "A", added: 12, removed: 0 },
  ];
  const d = diffPatchState(current, cached);
  assert.deepEqual(d.unchanged.map(f => f.path), ["a.js"]);
  assert.deepEqual(d.modified.map(f => f.path), ["b.js"]);
  assert.deepEqual(d.added.map(f => f.path), ["c.js"]);
  assert.deepEqual(d.removed, ["deleted.js"]);
  assert.equal(d.staleCount, 3);
  assert.equal(d.hasChanges, true);
});

test("explain: mergeExplainResult preserves unchanged findings & resolved state on incremental update", () => {
  const firstFiles = [
    { path: "db.js", patchHash: "h1", status: "M", added: 20, removed: 0 },
    { path: "api.js", patchHash: "h2", status: "M", added: 40, removed: 5 },
  ];
  const initial = mergeExplainResult(null, {
    title: "Add invitations",
    summary: "Adds DB model and API",
    layers: [
      { id: "l1", title: "Data model", summary: "Schema", dependsOn: [], files: [{ path: "db.js", role: "Model" }] },
      { id: "l2", title: "API", summary: "Endpoints", dependsOn: ["l1"], files: [{ path: "api.js", role: "Handler" }] },
    ],
    fileSummaries: [
      { path: "db.js", summary: "Invitation model" },
      { path: "api.js", summary: "Create endpoint" },
    ],
    findings: [
      { file: "db.js", lineStart: 4, lineEnd: 4, severity: "minor", category: "maintainability", title: "Add index", body: "Index email", suggestion: "" },
      { file: "api.js", lineStart: 15, lineEnd: 16, severity: "critical", category: "security", title: "Weak token", body: "Use CSPRNG", suggestion: "crypto.randomUUID()" },
    ],
  }, firstFiles, { root: "/r", branch: "feat/inv", baseRef: "origin/main", baseSha: "abc" });

  // Resolve the db.js finding
  const dbFinding = initial.findings.find(f => f.file === "db.js");
  initial.resolvedIds = [dbFinding.id];

  // Incremental update: only api.js changed (and fixed the weak token!), plus ui.js added
  const nextFiles = [
    { path: "db.js", patchHash: "h1", status: "M", added: 20, removed: 0 },
    { path: "api.js", patchHash: "h2-v2", status: "M", added: 42, removed: 6 },
    { path: "ui.js", patchHash: "h3", status: "A", added: 30, removed: 0 },
  ];
  const updated = mergeExplainResult(initial, {
    title: "Add invitations",
    summary: "Adds DB model, API, and UI",
    layers: [
      { id: "l1", title: "Data model", summary: "Schema", dependsOn: [], files: [{ path: "db.js", role: "Model" }] },
      { id: "l2", title: "API", summary: "Endpoints", dependsOn: ["l1"], files: [{ path: "api.js", role: "Handler" }] },
    ],
    fileSummaries: [
      { path: "api.js", summary: "Uses CSPRNG now" },
      { path: "ui.js", summary: "Invite dialog" },
    ],
    findings: [
      // api.js finding fixed -> omitted; new major finding on ui.js
      { file: "ui.js", lineStart: 10, lineEnd: 12, severity: "major", category: "bug", title: "Missing error state", body: "Handle failed invite", suggestion: "" },
    ],
  }, nextFiles, {
    root: "/r",
    branch: "feat/inv",
    baseRef: "origin/main",
    baseSha: "abc",
    isIncremental: true,
    changedPaths: ["api.js", "ui.js"],
    analyzedFiles: 2,
    reusedFiles: 1,
  });

  // db.js finding + its summary + its resolvedId were preserved!
  assert.equal(updated.files["db.js"].summary, "Invitation model");
  assert.equal(updated.findings.some(f => f.id === dbFinding.id), true);
  assert.deepEqual(updated.resolvedIds, [dbFinding.id]);
  // api.js old critical finding was cleared because api.js was re-analyzed without it
  assert.equal(updated.findings.some(f => f.file === "api.js"), false);
  // ui.js was omitted from AI layers -> auto-placed into fallback "Other changes" layer
  assert.equal(updated.layers.some(l => l.files.some(f => f.path === "ui.js")), true);

  const stats = summarizeExplain(updated);
  assert.equal(stats.openFindings.length, 1);
  assert.equal(stats.resolvedFindings.length, 1);
  assert.equal(stats.counts.major, 1);
  assert.equal(stats.counts.critical, 0);
});

test("explain: extractAiJson handles Claude envelope, raw JSON, and fenced JSON", () => {
  const sample = { title: "T", summary: "S", layers: [], fileSummaries: [], findings: [] };
  assert.deepEqual(extractAiJson(JSON.stringify({ type: "result", structured_output: sample })), sample);
  assert.deepEqual(extractAiJson(JSON.stringify({ type: "result", result: "```json\n" + JSON.stringify(sample) + "\n```" })), sample);
  assert.deepEqual(extractAiJson(JSON.stringify(sample)), sample);
});

test("explain: buildExplainPrompt includes only changed diffs in incremental mode", () => {
  const prompt = buildExplainPrompt({
    branch: "feat/x",
    baseRef: "origin/main",
    isIncremental: true,
    existingReview: { title: "Old", summary: "S", layers: [], findings: [] },
    allFiles: [
      { path: "unchanged.js", status: "M", added: 5, removed: 0 },
      { path: "changed.js", status: "M", added: 3, removed: 1 },
    ],
    changedDiffs: [
      { path: "changed.js", status: "M", added: 3, removed: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
    ],
  });
  assert.match(prompt, /MODE: INCREMENTAL UPDATE/);
  assert.match(prompt, /=== FILE: changed\.js/);
  assert.doesNotMatch(prompt, /=== FILE: unchanged\.js/);
});

test("explain: config defaults to claude/English/12-file bug-hunt, remembers custom languages, and formats fix prompt cleanly", () => {
  assert.deepEqual(normalizeExplainConfig(null), { engine: "claude", model: "", effort: "medium", language: "English", bugHuntMinFiles: 12 });
  assert.deepEqual(normalizeExplainConfig({ engine: "codex", model: "o3", effort: "high", language: "Dutch", bugHuntMinFiles: 8 }), { engine: "codex", model: "o3", effort: "high", language: "Dutch", bugHuntMinFiles: 8 });
  assert.equal(normalizeExplainConfig({ bugHuntMinFiles: 0 }).bugHuntMinFiles, 0);
  const r1 = addExplainLanguage(["English"], "Dutch");
  assert.deepEqual(r1, { list: ["English", "Dutch"], selected: "Dutch" });
  const r2 = addExplainLanguage(r1.list, "dutch");
  assert.deepEqual(r2, { list: ["English", "Dutch"], selected: "Dutch" });
  const prompt = buildExplainPrompt({
    branch: "feat/x",
    baseRef: "main",
    changedDiffs: [],
    allFiles: [],
    language: "Flemish",
    intentContext: { pr: { number: 42, title: "Turn off dev email", body: "Closes #10" }, issues: [{ number: 10, title: "Disable mail on dev", body: "Stop sending on dev" }] },
  });
  assert.match(prompt, /natural Flemish/);
  assert.match(prompt, /VERIFY BEFORE REPORTING/);
  assert.match(prompt, /PR #42: Turn off dev email/);
  assert.match(prompt, /Linked Issue #10: Disable mail on dev/);
  assert.match(prompt, /USER\/FRONTEND-FIRST ORDER/);
  assert.match(prompt, /VISIBLE UI CHANGES/);
  assert.match(prompt, /RELEASE PITCH \+ BEFORE -> NOW/);
  const msg = formatFindingFixPrompt({ file: "a.ts", lineStart: 10, lineEnd: 12, severity: "critical", category: "security", title: "XSS", impact: "Runs injected script", body: "Escape HTML", suggestion: "" });
  assert.match(msg, /a\.ts:10-12/);
  assert.match(msg, /critical \(security\)/);
  assert.match(msg, /false positive/i);
  assert.match(msg, /Claimed impact: Runs injected script/);
});

test("explain: filterBugHuntFiles excludes tests, lockfiles, docs, and generated code", () => {
  assert.equal(isNonProductionFile("src/api/orders.ts"), false);
  assert.equal(isNonProductionFile("infra/terraform/key_vault.tf"), false);
  assert.equal(isNonProductionFile("src/api/orders.test.ts"), true);
  assert.equal(isNonProductionFile("tests/OrdersTests.cs"), true);
  assert.equal(isNonProductionFile("backend/App.SystemTests/Factory.cs"), true);
  assert.equal(isNonProductionFile("package-lock.json"), true);
  assert.equal(isNonProductionFile("README.md"), true);
  assert.equal(isNonProductionFile("src/schema.generated.ts"), true);

  const filtered = filterBugHuntFiles([
    { path: "src/app.ts", binary: false },
    { path: "src/app.test.ts", binary: false },
    { path: "assets/logo.png", binary: true },
    { path: "infra/main.tf", binary: false },
  ]);
  assert.deepEqual(filtered.map(f => f.path), ["src/app.ts", "infra/main.tf"]);

  const bhPrompt = buildBugHuntPrompt({
    branch: "feat/big",
    baseRef: "main",
    targetDiffs: [{ path: "src/app.ts", status: "M", added: 5, removed: 1, patch: "+x" }],
    skippedCount: 4,
    existingFindings: [{ file: "src/app.ts", lineStart: 1, severity: "major", title: "Existing" }],
    language: "Dutch",
  });
  assert.match(bhPrompt, /Pass 2/);
  assert.match(bhPrompt, /4 test\/doc\/generated files skipped/);
  assert.match(bhPrompt, /natural Dutch/);
});

test("explain: layoutDiagram arranges nodes into topological columns safely and buildAskPrompt scopes context", () => {
  const layout = layoutDiagram({
    caption: "Checkout flow",
    nodes: [
      { id: "ui", label: "Checkout UI", kind: "ui", changed: true },
      { id: "api", label: "Orders API", kind: "api", changed: true },
      { id: "db", label: "Postgres", kind: "data", changed: false },
    ],
    edges: [
      { from: "ui", to: "api", label: "POST /order" },
      { from: "api", to: "db", label: "insert row" },
    ],
  });
  assert.equal(layout.columns.length, 3);
  assert.deepEqual(layout.columns.map(c => c.map(n => n.id)), [["ui"], ["api"], ["db"]]);

  // Cycle safety
  const cyclic = layoutDiagram({
    caption: "Cycle",
    nodes: [{ id: "a", label: "A", kind: "service", changed: false }, { id: "b", label: "B", kind: "service", changed: false }],
    edges: [{ from: "a", to: "b", label: "calls" }, { from: "b", to: "a", label: "callback" }],
  });
  assert.ok(cyclic && cyclic.columns.length >= 1);

  const h1 = branchStateHash([{ path: "a.ts", patchHash: "111" }]);
  const h2 = branchStateHash([{ path: "a.ts", patchHash: "222" }]);
  assert.notEqual(h1, h2);
  const askPrompt = buildAskPrompt({
    question: "Does this touch prod?",
    scope: { type: "layer", layer: { id: "l1", title: "Infra", summary: "KV secrets", files: [{ path: "prd.tfvars" }] } },
    review: {
      branch: "chore/mail",
      baseRef: "main",
      title: "Disable mail",
      qa: [
        { question: "Old Q?", tldr: "Old answer", branchHash: h1 },
        { question: "New Q?", tldr: "Fresh answer", branchHash: h2 },
      ],
    },
    currentBranchHash: h2,
    language: "Dutch",
  });
  assert.match(askPrompt, /SCOPED LAYER: Infra/);
  assert.match(askPrompt, /Does this touch prod\?/);
  assert.match(askPrompt, /natural Dutch/);
  assert.match(askPrompt, /GITHUB-STYLE CODE SNIPPETS/);
  assert.match(askPrompt, /\[OUTDATED - code changed since this answer\] Q: Old Q\?/);
  assert.match(askPrompt, /\[current\] Q: New Q\?/);

  assert.deepEqual(
    parseInlineMarkdown("Calls `OrderService.NewId()` for **unique** IDs."),
    [
      { kind: "text", text: "Calls " },
      { kind: "code", text: "OrderService.NewId()" },
      { kind: "text", text: " for " },
      { kind: "bold", text: "unique" },
      { kind: "text", text: " IDs." },
    ],
  );

  const cont = formatQaContinuePrompt({
    scopeType: "layer",
    scopeLabel: "Tests",
    question: "Where does the tracking number come from?",
    tldr: "From OrderService.NewTrackingNumber()",
    bullets: ["Uses prefix + UUID"],
    snippets: [{ file: "src/OrderService.ts", lineStart: 305, lineEnd: 310, caption: "Helper method" }],
  });
  assert.match(cont, /Continuing a Q&A from AI Explain about layer \(Tests\)/);
  assert.match(cont, /src\/OrderService\.ts#L305-L310/);

  const sr = searchExplainReview({
    findings: [{ id: "f1", title: "Missing discount cap", impact: "Price can go negative", file: "Pricing.ts", severity: "major", category: "bug" }],
    layers: [{ id: "l1", title: "Pricing rules", summary: "Applies cart discount", files: [{ path: "src/Pricing.ts", role: "Calculates tiered cart discount" }] }],
    files: { "src/Pricing.ts": { summary: "Cart pricing" } },
    qa: [{ id: "q1", question: "How does discount rounding work?", tldr: "Rounds to 2 decimals" }],
  }, "discount");
  assert.equal(sr.findings.length, 1);
  assert.equal(sr.layers.length, 1);
  assert.equal(sr.files.length, 1);
  assert.equal(sr.qa.length, 1);
  assert.equal(sr.total, 4);
});
