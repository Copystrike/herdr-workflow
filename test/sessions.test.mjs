// F4 on disk (bin/sessions.mjs) against a throwaway Claude config folder with acme data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/wf-sessions-`);
process.env.CLAUDE_CONFIG_DIR = `${root}/claude`;
process.env.HERDR_APP_HOME = `${root}/app`;
const { listSessions, repoSessionDirs, copySessionInto, lastAnswerOf, insideRepo } = await import("../bin/sessions.mjs");
const { claudeProjectDirName } = await import("../wf-lib/index.js");

const repo = `${root}/repos/acme-shop`;
const live = `${repo}/feat-acme-login`;
const sibling = `${root}/repos/acme-shop-api`;
const dirOf = p => `${root}/claude/projects/${claudeProjectDirName(p)}`;
const line = o => JSON.stringify(o) + "\n";
function session(cwd, id, prompt) {
  mkdirSync(dirOf(cwd), { recursive: true });
  writeFileSync(`${dirOf(cwd)}/${id}.jsonl`, line({ cwd, message: { content: prompt }, type: "user" }) + line({ type: "assistant", message: { content: [{ type: "text", text: `answer to ${prompt}` }] } }));
}
for (const p of [repo, live, sibling]) mkdirSync(p, { recursive: true });
session(repo, "00000000-0000-4000-8000-000000000001", "plan the acme release");
session(`${repo}/feat-acme-old`, "00000000-0000-4000-8000-000000000002", "old acme work");
session(live, "00000000-0000-4000-8000-000000000003", "acme login");
session(sibling, "00000000-0000-4000-8000-000000000004", "api work");
mkdirSync(`${dirOf(`${repo}/feat-acme-old`)}/00000000-0000-4000-8000-000000000002/subagents`, { recursive: true });

test.after(() => rmSync(root, { recursive: true, force: true }));

test("repository sessions: its own folder and removed worktrees, not live worktrees or a sibling repo", () => {
  const dirs = repoSessionDirs(repo, [live]);
  const { sessions } = listSessions(dirs);
  const kept = sessions.filter(s => insideRepo(s.cwd, repo)).map(s => s.prompt).sort();
  assert.deepEqual(kept, ["old acme work", "plan the acme release"]);
  assert.ok(existsSync(`${root}/app/data/wf/sessions-cache.json`));
  assert.doesNotMatch(readFileSync(`${root}/app/data/wf/sessions-cache.json`, "utf8"), /acme release|old acme work/);
});

test("resuming elsewhere copies the transcript and its sidecar folder once", () => {
  const file = `${dirOf(`${repo}/feat-acme-old`)}/00000000-0000-4000-8000-000000000002.jsonl`;
  assert.equal(copySessionInto(file, live), true);
  assert.ok(existsSync(`${dirOf(live)}/00000000-0000-4000-8000-000000000002.jsonl`));
  assert.ok(existsSync(`${dirOf(live)}/00000000-0000-4000-8000-000000000002/subagents`));
  assert.equal(copySessionInto(file, live), false);
  assert.equal(lastAnswerOf(file), "answer to old acme work");
});
