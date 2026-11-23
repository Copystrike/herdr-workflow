// node --test test/
// Pure unit and temp-fixture tests for wf-lib (using synthetic acme/shop fixtures only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { exec, fs } from "../bin/node-adapter.mjs";
import * as wf from "../wf-lib/index.js";

// ---------------------------------------------------------------- path sanitiser

test("claude project dir: standard sanitisation cases", () => {
  assert.equal(wf.claudeProjectDirName("/Users/x/dev/external/demo"), "-Users-x-dev-external-demo");
  assert.equal(wf.claudeProjectDirName("/Users/x/.config/dotfiles"), "-Users-x--config-dotfiles");
  assert.equal(wf.claudeProjectDirName("/a_b c.d"), "-a-b-c-d");
});

test("claude project dir: over 200 characters is cut and hashed from the original path", () => {
  const long = "/home/acme/" + "x".repeat(250);
  const name = wf.claudeProjectDirName(long);
  assert.equal(name.slice(0, 200), long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200));
  assert.match(name, /^.{200}-[0-9a-z]+$/);
  assert.equal(name.slice(201), Math.abs(wf.hash31(long)).toString(36));
  // Same sanitised text, different original: different hash.
  assert.notEqual(wf.claudeProjectDirName("/home/acme/" + "x".repeat(250)), wf.claudeProjectDirName("/home/acme." + "x".repeat(250)));
  assert.equal(wf.claudeProjectDirName("/a/" + "b".repeat(197)).length, 200);
});

// ---------------------------------------------------------------- front-matter

test("front-matter: nested maps, lists of maps, comments, quoting", () => {
  const { data, body } = wf.parseFrontMatter(`---
slug:       portal-ordering
issue:      https://github.com/acme/shop/issues/412
approved:   false                     # gate 1
seeded:     removed
pr:         null
title:      "a: quoted # not a comment"
stack:
  base:     feat/cart   # PR #11
artifacts:
  plan:     https://claude.ai/artifact/abc
  handover: null
milestones:
  - id: 1
    title: Order draft endpoint + validation
    status: done
    commit: 1000021e6
  - id: 2
    title: Cart screen
    status: todo
    commit: null
tags:
  - a
  - b
---
# Plan

## Deviations
- one
`);
  assert.equal(data.slug, "portal-ordering");
  assert.equal(data.approved, false);
  assert.equal(data.seeded, "removed");
  assert.equal(data.pr, null);
  assert.equal(data.title, "a: quoted # not a comment");
  assert.equal(data.stack.base, "feat/cart");
  assert.equal(data.artifacts.handover, null);
  assert.equal(data.milestones.length, 2);
  // A sha that looks like a number in exponent form stays a string.
  assert.equal(data.milestones[0].commit, "1000021e6");
  assert.equal(data.milestones[1].commit, null);
  assert.deepEqual(data.tags, ["a", "b"]);
  assert.deepEqual(wf.sections(body).map(s => s.title), ["Deviations"]);
});

test("front-matter: no front-matter, and fenced headings are not sections", () => {
  assert.equal(wf.parseFrontMatter("# Just a doc\n").data, null);
  assert.deepEqual(wf.sections("## A\n```\n## not a heading\n```\n## B\n").map(s => s.title), ["A", "B"]);
});

// ---------------------------------------------------------------- phase derivation

const planFiles = over => ({
  slug: "x", plan: "docs/features/x/implementation-plan.md", reviews: [], notApplied: [],
  planFacts: {
    approved: true, seeded: true, pr: null, base: null, stopped: null, deviations: 0,
    artifacts: { plan: "https://claude.ai/artifact/a", handover: "https://claude.ai/artifact/b" },
    milestones: wf.milestoneFacts([{ id: 1, status: "done", commit: "aaa" }, { id: 2, status: "done", commit: "bbb" }]),
    ...over,
  },
});
const reviewed = { reviewedAfterMilestones: true, codeAfterReview: false, reviewCommit: "ccc1234567" };
const draft = { number: 7, state: "OPEN", isDraft: true };
const key = args => wf.derivePhase(args).key;

test("phase: every row of the workflow phase state machine", () => {
  assert.equal(key({ isBase: true }), "base");
  assert.equal(key({ files: { slug: "x", plan: null, batch: null, reviews: [] }, pr: null }), "none");
  assert.equal(key({ files: planFiles({ approved: false }), pr: null }), "gate1");
  assert.equal(key({ files: planFiles({ milestones: wf.milestoneFacts([{ status: "done", commit: "a" }, { status: "todo", commit: null }]) }), pr: null }), "implementing");
  assert.equal(key({ files: planFiles({ approved: false, stopped: "cannot reach the db" }), pr: draft }), "stopped", "Stopped outranks all");
  assert.equal(key({ files: planFiles({}), git: { ...reviewed, reviewedAfterMilestones: false }, pr: null }), "reviewing");
  assert.equal(key({ files: planFiles({ artifacts: { plan: "p", handover: null } }), git: reviewed, pr: null }), "handover");
  assert.equal(key({ files: planFiles({ seeded: false }), git: reviewed, pr: null }), "seeding");
  assert.equal(key({ files: planFiles({ seeded: "removed" }), git: reviewed, pr: null }), "openingPr");
  assert.equal(key({ files: planFiles({ pr: "https://github.com/acme/shop/pull/7" }), git: reviewed, pr: draft }), "gate2");
  assert.equal(key({ files: planFiles({ pr: "x" }), git: { ...reviewed, codeAfterReview: true }, pr: draft }), "fixFirst");
  assert.equal(key({ files: planFiles({ pr: "x" }), git: reviewed, pr: { ...draft, isDraft: false } }), "inReview");
  assert.equal(key({ files: planFiles({ pr: "x" }), git: reviewed, pr: { ...draft, state: "MERGED" } }), "merged");
});

test("phase: a status outside todo / in_progress / done settles its milestone", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, status: "done", commit: `c${i}` }));
  const m = wf.milestoneFacts([...eleven, { id: 12, status: "blocked", commit: null }]);
  assert.deepEqual([m.done, m.settled, m.settledText, m.interrupted, m.lastCommit], [11, 1, "1 blocked", false, "c10"]);
  const git = { reviewedAfterMilestones: true, codeAfterReview: false, reviewCommit: "ccc" };
  const p = wf.derivePhase({ files: planFiles({ pr: "x", milestones: m }), git, pr: { number: 7, state: "OPEN", isDraft: true } });
  assert.deepEqual([p.key, wf.chipLabel(p), p.next.command], ["gate2", "test, mark ready", "gh pr ready"]);
  assert.match(wf.statusLine(planFiles({ milestones: m }), null), /milestones 11\/12, 1 blocked/);
  // in_progress and todo stay pending, and in_progress alone is not an interrupted run.
  const ip = wf.milestoneFacts([{ status: "done", commit: "a" }, { status: "in_progress" }, { status: "skipped" }]);
  assert.deepEqual([ip.settled, ip.interrupted], [1, false]);
  assert.equal(wf.derivePhase({ files: planFiles({ milestones: ip }), pr: null }).key, "implementing");
});

test("phase: a milestone done without a commit is an interrupted run", () => {
  const p = wf.derivePhase({ files: planFiles({ milestones: wf.milestoneFacts([{ status: "done", commit: "a" }, { status: "done", commit: null }]) }), pr: null });
  assert.equal(p.key, "interrupted");
  assert.equal(p.next.command, "Resume implementation");
});

test("phase: next actions name the step they run", () => {
  assert.equal(wf.derivePhase({ files: planFiles({ approved: false }), pr: null }).next.command, "Approve plan and begin implementation");
  assert.equal(wf.derivePhase({ files: planFiles({ pr: "x" }), git: reviewed, pr: draft }).next.command, "gh pr ready");
  assert.equal(wf.derivePhase({ files: planFiles({ pr: "x" }), git: { ...reviewed, codeAfterReview: true }, pr: draft }).next.command, "Review changes since ccc123456");
});

test("phase: without a PR source, a plan's pr field shows as an open PR, not as Opening PR", () => {
  assert.equal(key({ files: planFiles({ pr: "https://github.com/acme/shop/pull/7" }), git: reviewed }), "prUnknown");
  assert.equal(key({ files: planFiles({}), git: reviewed }), "openingPr");
});

test("phase: fix batches", () => {
  const batch = text => ({ slug: "b", plan: null, batch: "docs/fixes/b.md", reviews: [], notApplied: [], batchFacts: { ...wf.batchFacts(text), stopped: null } });
  const two = "# Fixes\n\n- [x] **one** — a\n      `test` · abc\n- [ ] **two** — b\n";
  assert.equal(wf.derivePhase({ files: batch(two), pr: null }).label, "Fixing 1/2");
  assert.equal(key({ files: batch("- [ ] **one**\n      waiting: which one is meant\n"), pr: null }), "waiting");
  assert.equal(key({ files: batch("- [x] **one**\n- [ ] **two**\n      dropped: belongs in a feature → #9\n"), pr: null }), "reviewing");
  assert.equal(key({ files: { ...batch("- [x] a\n"), reviews: [{ path: "r", stamp: "20260101-0101" }] }, pr: null }), "handover");
  assert.equal(key({ files: batch("Handover: https://claude.ai/artifact/h\n- [x] a\n"), git: reviewed, pr: draft }), "gate2");
});

// ---------------------------------------------------------------- git and forge parsers

test("worktree porcelain: bare, detached, CRLF", () => {
  const w = wf.parseWorktrees("worktree /r/.bare\r\nbare\r\n\r\nworktree /r/main\r\nHEAD 1\r\nbranch refs/heads/main\r\n\r\nworktree /r/x\r\nHEAD 2\r\ndetached\r\n");
  assert.deepEqual(w.map(x => [x.path, x.branch, x.bare, x.detached]), [["/r/.bare", null, true, false], ["/r/main", "main", false, false], ["/r/x", null, false, true]]);
});

test("status porcelain v2: ahead/behind and dirty count", () => {
  const s = wf.parseStatus("# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b f.ts\n? new.txt\n");
  assert.deepEqual(s, { ahead: 2, behind: 1, dirty: 2, staged: 0, unstaged: 1, untracked: 1, upstream: "origin/feat/x" });
});

test("PR signals: conflict over red CI over changes requested; running CI is progress", () => {
  const pr = o => ({ state: "OPEN", mergeable: "MERGEABLE", reviewDecision: null, statusCheckRollup: [], ...o });
  assert.deepEqual(wf.prSignals(pr({ mergeable: "CONFLICTING", statusCheckRollup: [{ conclusion: "FAILURE" }] })), { blocker: "conflict", progress: null });
  assert.equal(wf.prSignals(pr({ statusCheckRollup: [{ conclusion: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED" })).blocker, "ci");
  assert.equal(wf.prSignals(pr({ reviewDecision: "CHANGES_REQUESTED" })).blocker, "changes");
  assert.deepEqual(wf.prSignals(pr({ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] })), { blocker: null, progress: "ci" });
  assert.deepEqual(wf.prSignals({ state: "MERGED" }), { blocker: null, progress: null });
  const runCi = wf.prCiSummary(pr({ number: 42, statusCheckRollup: [{ name: "Build", conclusion: "SUCCESS" }, { name: "Test", status: "IN_PROGRESS", conclusion: "" }] }));
  assert.equal(runCi.ci, "running");
  assert.equal(runCi.passed, 1);
  assert.equal(runCi.total, 2);
  const okCi = wf.prCiSummary(pr({
    number: 42, reviewDecision: "APPROVED",
    latestReviews: [{ state: "APPROVED", author: { login: "alice" } }, { state: "APPROVED", author: { login: "bob" } }, { state: "COMMENTED", author: { login: "carol" } }],
    statusCheckRollup: [{ name: "Build", conclusion: "SUCCESS" }],
  }));
  assert.equal(okCi.ci, "passing");
  assert.equal(okCi.approved, true);
  assert.equal(okCi.approvals, 2);
  const trends = wf.ciTrends([
    { id: 3, name: "Build Web", status: "queued", conclusion: null, head_branch: "main", run_started_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-22T10:00:05Z" },
    { id: 2, name: "Build Web", status: "completed", conclusion: "failure", head_branch: "main", run_started_at: "2026-11-22T09:00:00Z", updated_at: "2026-11-22T09:10:00Z" },
    { id: 1, name: "Build Web", status: "completed", conclusion: "success", head_branch: "main", run_started_at: "2026-11-22T08:00:00Z", updated_at: "2026-11-22T08:05:00Z" },
  ], { now: Date.parse("2026-11-22T10:00:10Z") });
  assert.equal(trends.length, 1);
  assert.equal(trends[0].short, "Bd Web");
  assert.deepEqual(trends[0].bars.map(b => b.state), ["passed", "failed", "queued"]);
  assert.ok(trends[0].bars[1].ratio > trends[0].bars[0].ratio);
});

test("PRs by branch: the open PR wins over an older closed one", () => {
  const m = wf.prsByBranch([{ number: 1, headRefName: "a", state: "CLOSED", updatedAt: "2026-02" }, { number: 2, headRefName: "a", state: "OPEN", updatedAt: "2026-01" }]);
  assert.equal(m.a.number, 2);
  assert.equal(wf.prNumberOf("https://github.com/acme/shop/pull/42"), 42);
  assert.equal(wf.repoSlugFromUrl("git@github-personal:acme/shop.git"), "acme/shop");
});

test("a repository without a remote renders, with no PR column", async () => {
  const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main"); g("-c", "user.email=dev@acme.com", "-c", "user.name=dev", "commit", "-q", "--allow-empty", "-m", "init");
  const model = await wf.gatherRepo({ exec, fs, repo: { name: "local", dir }, terminals: [], fetchPrs: () => { throw new Error("must not ask a forge"); } });
  assert.equal(model.hasRemote, false);
  assert.equal(model.prs, "none");
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].isBase, true);
  assert.equal(model.rows[0].pr, null);
  execFileSync("rm", ["-rf", dir]);
});

// ---------------------------------------------------------------- labels

test("labels: args round-trip and terminals join by label, else by cwd", () => {
  const args = wf.labelArgs({ repo: "shop", branch: "feat/x", worktree: "/r/feat-x", session: "s1", role: "task" });
  const pairs = args.filter((_, i) => i % 2 === 1);
  const read = wf.readLabels(pairs);
  assert.deepEqual(read, { v: wf.LABEL_SCHEMA_VERSION, repo: "shop", branch: "feat/x", worktree: "/r/feat-x", session: "s1", role: "task" });
  assert.throws(() => wf.labelArgs({ role: "boss" }));
  const terms = [
    { address: "t1", state: "live", labels: { "wf.v": "1", worktree: "/r/feat-x" }, cwd: "/elsewhere", status: "working" },
    { address: "t2", state: "live", cwd: "/r/feat-x/src", status: "blocked" },
    { address: "t3", state: "live", cwd: "/r/feat-xy" },
    { address: "t4", state: "finished", cwd: "/r/feat-x" },
  ];
  const inX = wf.terminalsIn(terms, "/r/feat-x");
  assert.deepEqual(inX.map(t => t.address), ["t1", "t2"]);
  assert.equal(wf.mostUrgent(inX), "blocked");
});

test("live agents regroup rows: blocked needs user, working runs, phase otherwise", () => {
  const row = (path, key) => ({ path, branch: path, isBase: false, phase: { key } });
  const rows = [row("/r/a", "inReview"), row("/r/b", "gate2"), row("/r/c", "none"), row("/r/d", "gate1")];
  wf.applyAgents(rows, [
    { address: "t1", state: "live", cwd: "/r/a", status: "blocked" },
    { address: "t2", state: "live", cwd: "/r/c/src", status: "working" },
    { address: "t3", state: "live", cwd: "/r/d", status: "working" },
  ]);
  assert.deepEqual(rows.map(r => r.group), ["needs", "needs", "running", "needs"]);
  assert.deepEqual(rows[2].terminals, ["t2"]);
});

// ---------------------------------------------------------------- telemetry

test("telemetry: only whitelisted, short, single-line fields are kept", () => {
  const l = JSON.parse(wf.line("button", { surface: "f1", action: "select", prompt: "secret text", repo: "x".repeat(500), branch: "a\nb", ms: 3 }, new Date("2026-01-01T00:00:00Z")));
  assert.deepEqual(l, { v: 1, ts: "2026-01-01T00:00:00.000Z", event: "button", surface: "f1", action: "select", ms: 3 });
});

test("telemetry: batches, compare-and-set retry, rollover, and off writes nothing", async () => {
  const files = {};
  let conflicts = 1;
  const io = {
    readTextFile: async p => files[p] ?? null,
    writeTextFile: async (p, text, expected) => {
      if ((files[p] ?? null) !== expected) throw new Error("stale");
      if (conflicts-- > 0) { files[p] = (files[p] ?? "") + "{\"other\":1}\n"; throw new Error("stale"); }
      files[p] = text;
    },
    enabled: () => on,
  };
  let on = true;
  const t = wf.createTracker("/home/acme/.config/herdr-app/data/wf/telemetry", io);
  t.track("a", { ms: 1 }); t.track("b", { ms: 2 });
  assert.equal(await t.flush(new Date(2026, 2, 4, 10)), 2);
  const path = "/home/acme/.config/herdr-app/data/wf/telemetry/2026-03-04.jsonl";
  assert.equal(files[path].trim().split("\n").length, 3, "the other writer's line survives");
  files[path] = "x".repeat(950 * 1024);
  t.track("c", {});
  await t.flush(new Date(2026, 2, 4, 11));
  assert.ok(files[path.replace(".jsonl", ".1.jsonl")].includes('"event":"c"'));
  on = false;
  t.track("d", {});
  assert.equal(t.pending(), 0);
  assert.equal(await t.flush(), 0);
});

// ---------------------------------------------------------------- F2: agent and launcher

test("claude: the parent session's markers are found, the account is kept", () => {
  const env = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/home/acme/.claude-x", PATH: "/bin" };
  assert.deepEqual(wf.inheritedClaudeVars(env), ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]);
  assert.deepEqual(wf.claudeArgv("s", "/opt/wf/bin/claude"), ["/opt/wf/bin/claude", "--session-id", "s"]);
  assert.equal(wf.resumeCommand("s"), "claude --resume s");
});

test("claude: a session is named after its worktree folder", () => {
  assert.equal(wf.sessionNameFor("/home/acme/repos/acme-shop/feat-Fix login__now!/"), "feat-fix-login__now");
  assert.equal(wf.sessionNameFor("/home/acme/repos/acme-shop/main"), "main");
  assert.deepEqual(wf.claudeArgv("s", "claude", "feat-x"), ["claude", "--session-id", "s", "--name", "feat-x"]);
  assert.equal(wf.resumeCommand("s", "claude", "feat-x"), "claude --resume s --name feat-x");
});

test("one space per worktree: stable id, else the space whose panes sit in it", () => {
  const a = wf.spaceIdFor("/home/acme/repo/feat-a");
  assert.equal(a, wf.spaceIdFor("/home/acme/repo/feat-a"));
  assert.notEqual(a, wf.spaceIdFor("/home/acme/repo/feat-b"));
  assert.match(a, /^wfsp[0-9a-z]+$/);
  const spaces = [{ id: "s1", tabs: [{ id: "t1" }] }, { id: a, tabs: [] }];
  assert.equal(wf.spaceForWorktree(spaces, [], "/home/acme/repo/feat-a").id, a);
  assert.equal(wf.spaceForWorktree(spaces, [{ tab: "t1", cwd: "/home/acme/repo/feat-b/src" }], "/home/acme/repo/feat-b").id, "s1");
  assert.equal(wf.spaceForWorktree(spaces, [{ tab: "t1", cwd: "/home/acme/repo/feat-bb" }], "/home/acme/repo/feat-b"), null);
});

test("resume only a Claude task whose program is gone and a shell sits in its place", () => {
  const labels = { "wf.v": "1", role: "task", session: "s1", worktree: "/home/acme/repo/feat-a" };
  assert.equal(wf.needsResume({ state: "live", labels, foreground: { name: "zsh" } }), true);
  assert.equal(wf.needsResume({ state: "live", labels, foreground: { argv: ["/run/current-system/sw/bin/bash"] } }), true);
  assert.equal(wf.needsResume({ state: "live", labels, foreground: { name: "claude" } }), false);
  assert.equal(wf.needsResume({ state: "live", labels: { ...labels, role: "shell" }, foreground: { name: "zsh" } }), false);
  assert.equal(wf.needsResume({ state: "live", labels: { ...labels, session: undefined }, foreground: { name: "zsh" } }), false);
  assert.equal(wf.needsResume({ state: "exited", labels, foreground: { name: "zsh" } }), false);
});

test("launcher input: issue, issues, PR, command and text", () => {
  const slug = "acme/shop";
  assert.deepEqual(wf.parseInput("  ", slug), { kind: "empty" });
  assert.equal(wf.parseInput("#42", slug).issue.number, 42);
  assert.equal(wf.parseInput("42", slug).issue.url, "https://github.com/acme/shop/issues/42");
  assert.equal(wf.parseInput("https://github.com/acme/shop/issues/7", slug).kind, "issue");
  const many = wf.parseInput("https://github.com/acme/shop/issues/7\nhttps://github.com/acme/shop/issues/8", slug);
  assert.deepEqual(many.issues.map(i => i.number), [7, 8]);
  assert.deepEqual(wf.parseInput("https://github.com/acme/shop/pull/9", slug).pr, { repo: "acme/shop", number: 9, url: "https://github.com/acme/shop/pull/9" });
  assert.deepEqual(wf.parseInput("/fix #7 now", slug), { kind: "command", command: "/fix", args: "#7 now", text: "/fix #7 now" });
  assert.equal(wf.parseInput("look at https://github.com/acme/shop/issues/7 and fix it", slug).kind, "text");
  assert.equal(wf.parseInput("#42", null).kind, "text");
});

test("branch names: prefix from labels, slug of the title, existing heads for PRs", () => {
  assert.equal(wf.slugify("Façade: Größe ändern!"), "facade-grosse-andern");
  assert.equal(wf.slugify("one two three four five", 3), "one-two-three");
  assert.equal(wf.prefixFromLabels([{ name: "bug" }]), "fix");
  assert.equal(wf.prefixFromLabels(["documentation"]), "docs");
  assert.equal(wf.prefixFromLabels([]), "feat");
  const issue = { kind: "issue", issue: { number: 1 } };
  assert.equal(wf.proposeBranch(issue, { issue: { title: "Error messages are vague", labels: [{ name: "bug" }] } }), "fix/error-messages-are-vague");
  assert.equal(wf.proposeBranch({ kind: "pr" }, { pr: { headRefName: "feat/x" } }), "feat/x");
  assert.equal(wf.proposeBranch({ kind: "command", command: "/fix", args: "the login page" }), "fix/the-login-page");
  assert.equal(wf.proposeBranch(wf.parseInput("Make the checkout button font bigger please, thanks a lot")), "feat/make-the-checkout-button-font-bigger");
  assert.equal(wf.validBranch("feat/a-b"), true);
  assert.equal(wf.validBranch("feat//a"), false);
  assert.equal(wf.validBranch("-x"), false);
  assert.equal(wf.worktreePathFor("/home/acme/repo", true, "feat/a"), "/home/acme/repo/feat-a");
  assert.equal(wf.worktreePathFor("/home/acme/repo", false, "feat/a"), "/home/acme/repo/.claude/worktrees/feat-a");
});

test("prompts carry the assignment and the rules, and quote the issue", () => {
  const issue = { number: 7, title: "Vague errors", url: "https://github.com/acme/shop/issues/7", body: "It says\nerror", comments: [{ author: { login: "dev" }, body: "same" }] };
  const p = wf.issuePrompt({ issue, repo: "acme/shop", branch: "fix/vague-errors", base: "main" });
  assert.match(p, /^Your assignment is exactly one issue: acme\/shop#7/);
  assert.match(p, /branch fix\/vague-errors, cut from origin\/main/);
  assert.match(p, /> It says\n> error/);
  assert.match(p, /Comment by dev:\n> same/);
  for (const rule of wf.STANDING_RULES) assert.ok(p.includes(rule));
  assert.ok(wf.textPrompt({ text: "Do it", branch: "feat/x", base: "main" }).startsWith("Do it\n"));
});

test("docs snapshot: one find answers plan discovery the same as the real fs", async () => {
  const dir = mkdtempSync(`${tmpdir()}/wf-docs-`);
  try {
    mkdirSync(`${dir}/docs/features/checkout/reviews`, { recursive: true });
    writeFileSync(`${dir}/docs/features/checkout/implementation-plan.md`, `---\nslug: checkout\napproved: true\nmilestones:\n  - id: 1\n    title: Cart\n    status: done\n    commit: abc1234\n---\n# Plan\n`);
    writeFileSync(`${dir}/docs/features/checkout/reviews/20260101-1000.md`, "## Not applied\n- missing: edge case\n");

    let reads = 0;
    const counted = { ...fs, readdir: (...a) => { reads++; return fs.readdir(...a); }, exists: (...a) => { reads++; return fs.exists(...a); } };
    for (const branch of ["feat/checkout", "feat/no-such-plan"]) {
      const snap = await wf.docsSnapshot(exec, counted, dir);
      assert.deepEqual(await wf.readWorkflowFiles(snap, dir, branch), await wf.readWorkflowFiles(fs, dir, branch), branch);
    }
    assert.equal(reads, 0, "no folder reads under docs/");
    const none = await wf.docsSnapshot(exec, fs, "/home/acme-missing");
    assert.equal(await none.exists("/home/acme-missing/docs/fixes/x.md"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- F4: sessions

const rec = o => JSON.stringify(o);
const ACME_TRANSCRIPT = [
  rec({ type: "custom-title", customTitle: "feat-acme-login", sessionId: "s1" }),
  rec({ cwd: "/home/acme/repos/acme-shop/feat-acme-login", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill" }] }, type: "user" }),
  rec({ cwd: "/home/acme/repos/acme-shop/feat-acme-login", message: { content: "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>staged</command-args>" }, type: "user" }),
  rec({ cwd: "/home/acme/repos/acme-shop/feat-acme-login", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }, type: "user" }),
  rec({ type: "assistant", message: { content: [{ type: "text", text: "First answer." }] } }),
  rec({ type: "system", subtype: "compact_boundary" }),
  rec({ isCompactSummary: true, message: { content: "This session is being continued" }, type: "user" }),
  rec({ message: { content: "<task-notification>\n<task-id>a1</task-id>" }, type: "user" }),
  rec({ isSidechain: true, message: { content: "sub-agent prompt" }, type: "user" }),
  rec({ message: { content: "make the <pasted_content id=\"1\">acme</pasted_content> button blue" }, type: "user" }),
  rec({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub-agent answer" }] } }),
  rec({ type: "assistant", message: { content: [{ type: "text", text: "Done: the button is blue." }, { type: "tool_use", id: "t" }] } }),
  rec({ type: "ai-title", aiTitle: "Acme button colour" }),
].join("\n") + "\n";

test("sessions: prompts are what a person typed; meta, tool results, summaries and sub-agents are not", () => {
  const c = wf.emptyCounts();
  const used = wf.addLines(c, ACME_TRANSCRIPT);
  assert.equal(used, ACME_TRANSCRIPT.length);
  assert.equal(c.prompts, 2);
  assert.equal(c.compactions, 1);
  assert.equal(c.title, "feat-acme-login");
  assert.equal(c.aiTitle, "Acme button colour");
  assert.equal(c.cwd, "/home/acme/repos/acme-shop/feat-acme-login");
  assert.equal(wf.firstPrompt(ACME_TRANSCRIPT), "/review staged");
  assert.equal(wf.lastAnswer(ACME_TRANSCRIPT), "Done: the button is blue.");
  assert.equal(wf.sessionTitle(c, "x"), "feat-acme-login");
  assert.equal(wf.sessionTitle({ ...wf.emptyCounts() }, null), "(no prompt yet)");
});

test("sessions: counting resumes at the offset and leaves a half-written line for later", () => {
  const lines = ACME_TRANSCRIPT.split("\n");
  const half = lines.slice(0, 6).join("\n") + "\n" + lines[6].slice(0, 20);
  const c = wf.emptyCounts();
  const used = wf.addLines(c, half);
  assert.equal(half.slice(used), lines[6].slice(0, 20));
  wf.addLines(c, ACME_TRANSCRIPT.slice(used));
  assert.equal(c.prompts, 2);
  assert.equal(c.compactions, 1);
});

test("sessions: a typed prompt is cleaned of paste markers and shortened for the list", () => {
  assert.equal(wf.promptText(JSON.parse(ACME_TRANSCRIPT.split("\n")[9])), "make the acme button blue");
  assert.equal(wf.shortPrompt("a".repeat(400)).length, 160);
  const command = { type: "user", message: { content: "<command-name>/acme-task</command-name>\n<command-args>https://acme.test/1\n\nhttps://acme.test/2</command-args>" } };
  assert.equal(wf.promptText(command), "/acme-task https://acme.test/1 https://acme.test/2");
});

test("git facts: base commits merged in after the review are not a fix round; the branch's own are", async () => {
  const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const g = (args, when) => execFileSync("git", ["-c", "user.email=e2e@acme.com", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: `@${when} +0000`, GIT_COMMITTER_DATE: `@${when} +0000` },
  });
  const put = (p, s) => { mkdirSync(`${dir}/${p.split("/").slice(0, -1).join("/")}`, { recursive: true }); writeFileSync(`${dir}/${p}`, s); };
  try {
    g(["init", "-q", "-b", "main"], 1000);
    put("src/base.txt", "1"); g(["add", "."], 1000); g(["commit", "-q", "-m", "base"], 1000);
    g(["checkout", "-q", "-b", "feat/x"], 1000);
    put("docs/features/x/reviews/20260101-0101.md", "log"); g(["add", "."], 2000); g(["commit", "-q", "-m", "review"], 2000);
    g(["checkout", "-q", "main"], 3000);
    put("src/other.txt", "theirs"); g(["add", "."], 3000); g(["commit", "-q", "-m", "feat: other (#2)"], 3000);
    g(["checkout", "-q", "feat/x"], 4000);
    g(["merge", "-q", "--no-ff", "--no-edit", "main"], 4000);
    const files = { batchFacts: {}, reviewDirs: ["docs/features/x/reviews"], reviews: [{ path: "docs/features/x/reviews/20260101-0101.md" }] };
    assert.equal((await wf.phaseGitFacts(exec, dir, files)).codeAfterReview, false);
    put("src/base.txt", "2"); g(["commit", "-qam", "gate 2 fix"], 5000);
    assert.equal((await wf.phaseGitFacts(exec, dir, files)).codeAfterReview, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci settings: effectiveWorkflowDefs auto-selects active workflows, applies global shorts and per-repo overrides", () => {
  const all = [
    { id: 1, name: "Scan Secrets", state: "active" },
    { id: 2, name: "Deploy Web", state: "active" },
    { id: 3, name: "Build Server", state: "active" },
    { id: 4, name: "Test Suite", state: "active" },
    { id: 5, name: "Lint", state: "active" },
  ];
  // With empty default workflows, picks first 4 active workflows automatically
  const autoDefs = wf.effectiveWorkflowDefs(all, null, "acme/shop");
  assert.deepEqual(autoDefs.map(d => d.name), ["Scan Secrets", "Deploy Web", "Build Server", "Test Suite"]);

  const ordered = wf.effectiveWorkflowDefs(all, {
    workflows: [
      { name: "Build Server", short: "Bd Srv" },
      { name: "Deploy Web", short: "Dep Web" },
    ],
  }, "acme/shop");
  assert.deepEqual(ordered.map(d => [d.name, d.short]), [
    ["Build Server", "Bd Srv"],
    ["Deploy Web", "Dep Web"],
  ]);

  const custom = wf.effectiveWorkflowDefs(all, {
    shorts: { "scan secrets": "Sec", "deploy web": "Dep Web" },
    overrides: { "acme/shop": { watch: ["Deploy Web", "Scan Secrets"] } },
  }, "acme/shop");
  assert.deepEqual(custom.map(d => [d.name, d.short]), [
    ["Deploy Web", "Dep Web"],
    ["Scan Secrets", "Sec"],
  ]);
});

test("ci trends: snapshot mode dims stale runs beyond recencyDays and computes duration ratios", () => {
  const now = Date.parse("2026-11-22T18:00:00Z");
  const snap = {
    slug: "acme/shop",
    branch: "main",
    workflows: [
      {
        id: 2, name: "Deploy Web", short: "Dep Web", source: "branch", branch: "main",
        runs: [
          { id: 102, run_number: 22, status: "in_progress", conclusion: null, head_branch: "main", run_started_at: "2026-11-22T17:55:00Z", created_at: "2026-11-22T17:55:00Z", updated_at: "2026-11-22T17:58:00Z" },
          { id: 101, run_number: 21, status: "completed", conclusion: "success", head_branch: "main", run_started_at: "2026-11-21T10:00:00Z", created_at: "2026-11-21T10:00:00Z", updated_at: "2026-11-21T10:10:00Z" },
          { id: 100, run_number: 20, status: "completed", conclusion: "failure", head_branch: "main", run_started_at: "2026-11-01T10:00:00Z", created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:02:00Z" },
        ],
      },
    ],
  };
  const trends = wf.ciTrends(snap, { limit: 6, recencyDays: 7, now });
  assert.equal(trends.length, 1);
  assert.deepEqual(trends[0].bars.map(b => [b.id, b.state, b.stale]), [
    [100, "failed", true],
    [101, "passed", false],
    [102, "running", false],
  ]);
  assert.ok(trends[0].bars[1].ratio > trends[0].bars[0].ratio);
  assert.equal(trends[0].latest.id, 102);
});

test("ci cache: persists snapshots, jobs, and logs across instances, invalidates on attempt bump, and picks best default job", async () => {
  const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const fsp = await import("node:fs/promises");
  // Expose only the exact fs/promises subset Herdr's host provides (no rename/stat) so the test proves host compatibility.
  const herdrFs = {
    mkdir: fsp.mkdir, readFile: fsp.readFile, writeFile: fsp.writeFile, readdir: fsp.readdir, unlink: fsp.unlink,
  };
  try {
    assert.equal(wf.isCacheableState("passed"), true);
    assert.equal(wf.isCacheableState("failed"), true);
    assert.equal(wf.isCacheableState("running"), false);
    assert.equal(wf.isCacheableState("queued"), false);

    assert.equal(wf.pickDefaultJob([
      { id: 1, state: "skipped" },
      { id: 2, state: "passed" },
      { id: 3, state: "failed" },
    ]).id, 3);
    assert.equal(wf.pickDefaultJob([
      { id: 1, state: "skipped" },
      { id: 2, state: "passed" },
    ]).id, 2);

    const c1 = wf.createCiCache({ fs: herdrFs, dir, maxLogs: 2 });
    await c1.setSnapshot("acme/shop", { slug: "acme/shop", branch: "main", workflows: [] });
    await c1.setJobs("acme/shop", 42, 1, [{ id: 9, name: "build", state: "passed" }]);
    await c1.setLog({ slug: "acme/shop", runId: 42, jobId: 9, attempt: 1 }, { text: "ok line", truncated: false, totalLines: 1, error: null });

    // Fresh cache instance reading from disk (simulates reopening wf-ci tab or restarting Herdr)
    const c2 = wf.createCiCache({ fs: herdrFs, dir, maxLogs: 2 });
    assert.equal((await c2.getSnapshot("acme/shop"))?.branch, "main");
    assert.equal((await c2.getJobs("acme/shop", 42, 1))?.[0]?.id, 9);
    assert.equal(await c2.getJobs("acme/shop", 42, 2), null, "new attempt misses old jobs cache");
    const logHit = await c2.getLog({ slug: "acme/shop", runId: 42, jobId: 9, attempt: 1 });
    assert.equal(logHit?.text, "ok line");
    assert.equal(logHit?.cached, true);
    assert.equal(await c2.getLog({ slug: "acme/shop", runId: 42, jobId: 9, attempt: 2 }), null, "new attempt misses old log cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sliceStepLog: extracts only lines within the step UTC window without leaking into the next step", () => {
  const raw = [
    "2026-11-21T07:00:01.100Z setup line",
    "2026-11-21T07:00:05.200Z build line 1",
    "2026-11-21T07:00:06.800Z build line 2",
    "2026-11-21T07:00:10.050Z test line 1",
  ].join("\n");
  const build = { number: 2, name: "Build", startedMs: Date.parse("2026-11-21T07:00:05Z"), completedMs: Date.parse("2026-11-21T07:00:07Z") };
  const testStep = { number: 3, name: "Test", startedMs: Date.parse("2026-11-21T07:00:10Z"), completedMs: Date.parse("2026-11-21T07:00:12Z") };
  const out = wf.sliceStepLog(raw, build, testStep);
  assert.equal(out.totalLines, 2);
  assert.equal(out.text, "build line 1\nbuild line 2");
  assert.equal(out.startLine, 2);
  assert.equal(raw.slice(out.startOffset, out.lineEndOffset), "2026-11-21T07:00:05.200Z build line 1");
});

test("archiveBlockReason: blocks archiving when staged, unstaged, untracked, or unverified; allows clean worktree", () => {
  const clean = wf.parseStatus("# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -0\n");
  assert.deepEqual([clean.dirty, clean.staged, clean.unstaged, clean.untracked], [0, 0, 0, 0]);
  assert.equal(wf.archiveBlockReason(clean), null, "unpushed committed work is allowed to archive");

  const staged = wf.parseStatus("1 A. N... 000000 100644 100644 0000000 abcdef1 src/a.ts\n");
  assert.equal(staged.staged, 1);
  assert.match(wf.archiveBlockReason(staged), /1 staged/);

  const unstaged = wf.parseStatus("1 .M N... 100644 100644 100644 abcdef1 abcdef1 src/b.ts\n");
  assert.equal(unstaged.unstaged, 1);
  assert.match(wf.archiveBlockReason(unstaged), /1 unstaged/);

  const untracked = wf.parseStatus("? src/new.ts\n");
  assert.equal(untracked.untracked, 1);
  assert.match(wf.archiveBlockReason(untracked), /1 untracked/);

  const mixed = wf.parseStatus("1 MM N... 100644 100644 100644 a b src/c.ts\n? tmp.txt\n");
  assert.match(wf.archiveBlockReason(mixed), /1 staged, 1 unstaged, 1 untracked/);

  assert.match(wf.archiveBlockReason(null), /Could not verify git status/);
});

test("branch drag-and-drop ordering: applyBranchOrder & reorderBranchList preserve playlist order and float new branches", () => {
  const mk = p => ({ row: { path: p, branch: p }, depth: 0 });
  const items = [mk("/r/a"), mk("/r/b"), mk("/r/c")];
  assert.deepEqual(wf.applyBranchOrder(items, null).map(x => x.row.path), ["/r/a", "/r/b", "/r/c"]);

  const movedAfter = wf.reorderBranchList(["/r/a", "/r/b", "/r/c"], "/r/a", "/r/b", "after");
  assert.deepEqual(movedAfter, ["/r/b", "/r/a", "/r/c"]);

  const movedBefore = wf.reorderBranchList(movedAfter, "/r/c", "/r/b", "before");
  assert.deepEqual(movedBefore, ["/r/c", "/r/b", "/r/a"]);

  // Adding a brand-new branch "/r/d" and pruning a deleted "/r/gone"
  const withNew = wf.applyBranchOrder([mk("/r/a"), mk("/r/b"), mk("/r/c"), mk("/r/d")], ["/r/c", "/r/gone", "/r/b", "/r/a"]);
  assert.deepEqual(withNew.map(x => x.row.path), ["/r/d", "/r/c", "/r/b", "/r/a"]);
});

test("terminalsAt: matches only terminals directly in the workspace root, never nested repo worktrees", () => {
  const root = "/ws/workspace";
  const terms = [
    { address: "t1", state: "live", cwd: root, labels: { "wf.v": "1", worktree: root } },
    { address: "t2", state: "live", cwd: `${root}/`, labels: {} },
    { address: "t3", state: "live", cwd: `${root}/repos/app/main`, labels: {} },
    { address: "t4", state: "live", cwd: root, labels: { "wf.v": "1", worktree: `${root}/repos/app/feat-x` } },
    { address: "t5", state: "finished", cwd: root, labels: {} },
  ];
  assert.deepEqual(wf.terminalsAt(terms, root).map(t => t.address), ["t1", "t2"]);
});

test("git-panel: fuzzyMatch ranks contiguous basename matches above scattered subsequences", () => {
  const exact = wf.fuzzyMatch("src/components/ComparePanel.tsx", "compare");
  const subseq = wf.fuzzyMatch("src/c/o/m/p/a/r/e.ts", "compare");
  assert.ok(exact && subseq && exact.score > subseq.score);
  assert.ok(wf.fuzzyMatch("src/components/ComparePanel.tsx", "comp panel"), "multi-term AND matches");
  assert.equal(wf.fuzzyMatch("src/components/ComparePanel.tsx", "comp zzzz"), null);

  const ranked = wf.filterFuzzy([
    { path: "docs/notes/panel-overview.md" },
    { path: "src/components/ComparePanel.tsx" },
    { path: "src/lib/other.ts" },
  ], "comp panel");
  assert.deepEqual(ranked.map(x => x.item.path), ["src/components/ComparePanel.tsx"]);
});

test("git-panel: porcelain split, numstat, name-status, tree compaction, commit log, diff search, and GitHub URLs", () => {
  const num = wf.parseNumstatZ("12\t3\tsrc/a.ts\0-\t-\timg.png\0");
  assert.deepEqual(num["src/a.ts"], { added: 12, removed: 3, binary: false });
  assert.equal(num["img.png"].binary, true);

  const split = wf.parsePorcelainSplit("MM src/a.ts\0?? new.txt\0A  staged.ts\0", num, num);
  assert.deepEqual(split.staged.map(f => [f.path, f.status]), [["src/a.ts", "M"], ["staged.ts", "A"]]);
  assert.deepEqual(split.unstaged.map(f => [f.path, f.status]), [["src/a.ts", "M"], ["new.txt", "?"]]);

  const ns = wf.parseNameStatusZ("M\0src/a.ts\0R100\0old.ts\0src/new.ts\0D\0gone.ts\0", num);
  assert.deepEqual(ns.map(f => [f.path, f.status, f.oldPath ?? null]), [
    ["src/a.ts", "M", null],
    ["src/new.ts", "R", "old.ts"],
    ["gone.ts", "D", null],
  ]);
  assert.equal(ns[2].fp, "", "deleted files have empty fp");

  const rows = wf.buildFileRows([
    { path: "src/app/views/Home.tsx", status: "M", fp: "1" },
    { path: "src/app/views/Settings.tsx", status: "A", fp: "2" },
    { path: "README.md", status: "M", fp: "3" },
  ], { viewMode: "tree", isViewed: f => f.path.endsWith("Home.tsx") });
  assert.equal(rows[0].kind, "dir");
  assert.equal(rows[0].name, "src/app/views", "single-child directory chains compact");
  assert.equal(rows[0].fileCount, 2);
  assert.equal(rows[0].viewedCount, 1);

  const log = wf.parseCommitLog("abcdef123456\x1fabcdef1\x1f000111\x1fHEAD -> feat/x, origin/main, tag: v1.0\x1fAlice\x1f2 hours ago\x1ffeat: add git tab\x1e");
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].refs.map(r => [r.kind, r.label]), [["head", "feat/x"], ["tag", "v1.0"], ["remote", "origin/main"]]);

  const diffHits = wf.searchUnifiedDiff(
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,3 @@\n context\n-const oldToken = 1;\n+const newToken = 2;\n",
    "token",
    { side: "added" },
  );
  assert.deepEqual(diffHits, [{ path: "src/a.ts", line: 11, sign: "+", text: "const newToken = 2;" }]);
  assert.equal(wf.searchUnifiedDiff("diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+const newToken = 2;\n", "Token", { wholeWord: true }).length, 0);
  assert.equal(wf.searchUnifiedDiff("diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+const newToken = 2;\n", "newToken", { wholeWord: true }).length, 1);
  assert.equal(wf.searchUnifiedDiff("diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+const newToken = 2;\n", "new[A-Z]\\w+", { regex: true }).length, 1);

  const splitDiff = wf.parseSplitDiff("@@ -10,3 +10,4 @@ fn test()\n keep\n-oldLine\n+newLine1\n+newLine2\n tail");
  assert.equal(splitDiff.split[0].kind, "gap");
  assert.equal(splitDiff.split[0].count, 9);
  assert.equal(splitDiff.split[1].kind, "ctx");
  assert.equal(splitDiff.split[2].kind, "pair");
  assert.equal(splitDiff.split[2].left.text, "oldLine");
  assert.equal(splitDiff.split[2].right.text, "newLine1");
  assert.equal(splitDiff.split[3].left, null);
  assert.equal(splitDiff.split[3].right.text, "newLine2");

  assert.equal(wf.githubUrlFor({ slug: "acme/shop", ref: "feat/x", path: "src/a b.ts" }), "https://github.com/acme/shop/blob/feat%2Fx/src/a%20b.ts");
  assert.equal(wf.githubUrlFor({ slug: "acme/shop", ref: "main", path: "src/app", isDir: true }), "https://github.com/acme/shop/tree/main/src/app");
  assert.equal(wf.githubUrlFor({ slug: "acme/shop", commit: "abcdef1" }), "https://github.com/acme/shop/commit/abcdef1");

  // Commit graph lane layout: merge opens lane 1, side commit sits on lane 1 and converges back into lane 0
  const graph = wf.layoutGraph([
    { sha: "m1", parents: ["p1", "s1"] },
    { sha: "p1", parents: ["base"] },
    { sha: "s1", parents: ["base"] },
    { sha: "base", parents: [] },
  ]);
  assert.equal(wf.graphWidth(graph), 2);
  assert.deepEqual(graph.map(r => r.lane), [0, 0, 1, 0]);
  assert.ok(graph[0].links.some(l => l.kind === "out" && l.fromLane === 0 && l.toLane === 1), "merge forks lane 0 -> 1");
  assert.ok(graph[2].links.some(l => l.kind === "out" && l.fromLane === 1 && l.toLane === 0), "side lane curves back into base on lane 0");
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  assert.equal(wf.formatCommitAge(now / 1000 - 3 * 86400, now), "3d");
  assert.equal(wf.formatCommitAge(Date.UTC(2026, 10, 9, 12, 0, 0) / 1000, now), "Nov 9");
});

// ---------------------------------------------------------------- All terminals settings

test("terminal settings: PowerShell right-click truth table, multiline paste detection, newline key & copy-on-select", () => {
  assert.equal(wf.rightClickOutcome({ action: "quick-edit", hasSelection: true }), "copy");
  assert.equal(wf.rightClickOutcome({ action: "quick-edit", hasSelection: false }), "paste");
  assert.equal(wf.rightClickOutcome({ action: "paste", hasSelection: true }), "paste");
  assert.equal(wf.rightClickOutcome({ action: "paste", hasSelection: false }), "paste");
  assert.equal(wf.rightClickOutcome({ action: "menu", hasSelection: true }), "menu");
  assert.equal(wf.rightClickOutcome({ action: "menu", hasSelection: false }), "menu");

  assert.equal(wf.pasteLineCount(""), 0);
  assert.equal(wf.pasteLineCount("echo hi"), 1);
  assert.equal(wf.pasteSubmits("echo hi"), false);
  assert.equal(wf.pasteLineCount("echo hi\n"), 2);
  assert.equal(wf.pasteSubmits("echo hi\n"), true);
  assert.equal(wf.pasteLineCount("a\r\nb\nc"), 3);

  const ctrlKeys = wf.applyNewlineKeyBindings({ global: { "ctrl-1": "tab.select:1" }, terminal: { "ctrl-shift-c": "terminal.copy" } }, "ctrl");
  assert.equal(ctrlKeys.terminal["ctrl-enter"], "send:\\\r");
  assert.equal(ctrlKeys.terminal["shift-enter"], "send:\r");
  assert.equal(ctrlKeys.terminal["ctrl-shift-c"], "terminal.copy");

  const shiftKeys = wf.applyNewlineKeyBindings(ctrlKeys, "shift");
  assert.equal(shiftKeys.terminal["shift-enter"], "send:\\\r");
  assert.equal(shiftKeys.terminal["ctrl-enter"], "send:\r");

  const settingsOn = wf.applyCopyOnSelectSetting({ zoom: 1.2 }, true);
  assert.deepEqual(settingsOn, { zoom: 1.2, copy_on_select: true });
  assert.equal(wf.applyCopyOnSelectSetting(settingsOn, false).copy_on_select, false);

  assert.deepEqual(wf.mergeTermSettings(null), wf.DEFAULT_TERM_SETTINGS);
  assert.equal(wf.mergeTermSettings({ rightClick: "invalid", newlineKey: "shift" }).rightClick, "quick-edit");
  assert.equal(wf.mergeTermSettings({ rightClick: "menu", newlineKey: "shift" }).newlineKey, "shift");
});

test("forge reactive CI: HTTP ETag 304 conditional cache and gh event listen outcome parser", async () => {
  const p200 = wf.parseHttpResponse("HTTP/2 200\r\netag: \"abc123\"\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}");
  assert.deepEqual(p200, { status: 200, etag: "\"abc123\"", body: "{\"ok\":true}" });

  let calls = 0;
  const mockExec = async (_cmd, args) => {
    calls++;
    if (args.includes("If-None-Match: \"v1\"")) {
      return { code: 0, stdout: "HTTP/2 304\r\netag: \"v1\"\r\n\r\n", stderr: "" };
    }
    return { code: 0, stdout: "HTTP/2 200\r\netag: \"v1\"\r\n\r\n{\"workflow_runs\":[{\"id\":9}]}", stderr: "" };
  };
  const first = await wf.ghApiConditional(mockExec, "/tmp", "repos/acme/shop/actions/runs?test=1");
  const second = await wf.ghApiConditional(mockExec, "/tmp", "repos/acme/shop/actions/runs?test=1");
  assert.equal(calls, 2);
  assert.deepEqual(first, { workflow_runs: [{ id: 9 }] });
  assert.deepEqual(second, { workflow_runs: [{ id: 9 }] });

  assert.equal(wf.parsePrEventOutcome({ code: 8, stdout: "", stderr: "" }).status, "timeout");
  assert.equal(wf.parsePrEventOutcome({ code: 1, stdout: "", stderr: "HTTP 403: Event subscriptions are not enabled for this account" }).status, "unsupported");
  const ev = wf.parsePrEventOutcome({ code: 0, stdout: "{\"type\":\"com.github.pull_request.check_suite.status.changed.v1\",\"data\":{\"conclusion\":\"success\"}}\n", stderr: "" });
  assert.equal(ev.status, "event");
  assert.equal(ev.event.data.conclusion, "success");
});
