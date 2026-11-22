// F2 launcher: what was pasted, which branch it becomes, and the first message the session gets.
// Prompts are built in memory at send time and never written to a file or a log.

// Kinds: issue (URL or #n), issues (several), pr (URL), command (/skill ...), text.
export function parseInput(raw, repoSlug) {
  const text = String(raw ?? "").trim();
  if (!text) return { kind: "empty" };
  const issueUrls = [...text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g)].map(m => ({ repo: m[1], number: Number(m[2]), url: m[0] }));
  const prUrl = text.match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.split(/\s+/);
    return { kind: "command", command: cmd, args: rest.join(" "), text };
  }
  const bare = text.match(/^#?(\d+)$/);
  if (bare && repoSlug) return { kind: "issue", issue: { repo: repoSlug, number: Number(bare[1]), url: `https://github.com/${repoSlug}/issues/${bare[1]}` } };
  const onlyLinks = text.replace(/https:\/\/github\.com\/\S+/g, "").replace(/[\s,;]+/g, "") === "";
  if (onlyLinks && issueUrls.length === 1 && !prUrl) return { kind: "issue", issue: issueUrls[0] };
  if (onlyLinks && issueUrls.length > 1) return { kind: "issues", issues: issueUrls };
  if (onlyLinks && prUrl && !issueUrls.length) return { kind: "pr", pr: { repo: prUrl[1], number: Number(prUrl[2]), url: prUrl[0] } };
  return { kind: "text", text };
}

// Kebab-case slug of a title, folding diacritics to ASCII.
export function slugify(title, maxWords = 0) {
  let words = String(title).replace(/ß/g, "ss").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (maxWords) words = words.slice(0, maxWords);
  return words.join("-");
}

const PREFIX_BY_LABEL = [
  [/^(bug|fix|fix\?|exception|ai-fix)$/i, "fix"],
  [/^(ci)$/i, "ci"],
  [/^(dependencies|chore)$/i, "chore"],
  [/^(documentation|docs)$/i, "docs"],
  [/^(user story|feature|enhancement|feature-request)$/i, "feat"],
];
export function prefixFromLabels(labels) {
  for (const [re, prefix] of PREFIX_BY_LABEL) if ((labels ?? []).some(l => re.test(typeof l === "string" ? l : l.name))) return prefix;
  return "feat";
}

// Worktree folder for a branch: bare repos keep "/" flattened to "-" beside .bare;
// a regular clone puts linked worktrees under <checkout>/.claude/worktrees/.
export const worktreePathFor = (repoDir, bare, branch) =>
  bare ? `${repoDir}/${branch.replace(/\//g, "-")}` : `${repoDir}/.claude/worktrees/${branch.replace(/\//g, "-")}`;

// Concise standing rules included in generated task prompts.
export const STANDING_RULES = [
  "Stay inside the issue. Something unrelated goes to a new issue, not this branch.",
  "Do not start fix loops: before fixing something, decide whether it belongs to this issue.",
  "Finish the job fully; do not stop at the first green test.",
  "Keep reports concise: the next step first, details after.",
  "Only ask what the issue and the repository cannot answer.",
];

const quote = s => String(s ?? "").trim().split("\n").map(l => `> ${l}`).join("\n");

// issue: { number, title, url, body, comments: [{author, body}] } from `gh issue view`.
export function issuePrompt({ issue, repo, branch, base }) {
  const comments = issue.comments ?? [];
  return [
    `Your assignment is exactly one issue: ${repo}#${issue.number} "${issue.title}" (${issue.url}). Nothing else is in scope; report related findings instead of acting on them.`,
    "",
    `You are already in the dedicated worktree for branch ${branch}, cut from origin/${base}. Stay in this worktree and target ${base} when opening a pull request.`,
    "",
    `Branch rules: target ${base}, never another feature branch. To catch up, rebase onto origin/${base} and push with --force-with-lease. Report unrelated CI, lint or test-infrastructure failures instead of fixing them here.`,
    "",
    "Start by reading the issue and the relevant code, propose a brief plan, and wait for approval before making code changes.",
    "",
    "Rules:",
    ...STANDING_RULES.map(r => `- ${r}`),
    "",
    `The issue as it stands now (${comments.length ? comments.length + " comments" : "no comments yet"}):`,
    quote(issue.body || "(no description)"),
    ...comments.flatMap(c => ["", `Comment by ${c.author?.login ?? c.author ?? "someone"}:`, quote(c.body)]),
  ].join("\n");
}

export function textPrompt({ text, branch, base }) {
  return [
    text.trim(),
    "",
    `You are on branch ${branch}, cut from origin/${base}, in its own worktree. Work only here; one PR targeting ${base}.`,
    "",
    "Rules:",
    ...STANDING_RULES.map(r => `- ${r}`),
  ].join("\n");
}

export function prPrompt({ pr, base }) {
  return [
    `This worktree is on the head of pull request #${pr.number} "${pr.title}" (${pr.url}), targeting ${pr.baseRefName ?? base}.`,
    "Read the PR, its review comments and its checks, then tell me in a few lines where it stands and what you would do next. Change nothing until I say so.",
  ].join("\n");
}

// The branch a paste becomes, before checking what exists.
export function proposeBranch(parsed, facts = {}) {
  switch (parsed.kind) {
    case "issue": return facts.issue ? `${prefixFromLabels(facts.issue.labels)}/${slugify(facts.issue.title)}` : null;
    case "pr": return facts.pr?.headRefName ?? null;
    case "command": {
      const prefix = /fix/.test(parsed.command) ? "fix" : "feat";
      const words = facts.issue ? facts.issue.title : parsed.args;
      return words ? `${prefix}/${slugify(words, 8)}` : null;
    }
    case "text": return `feat/${slugify(parsed.text.split("\n")[0], 6)}`;
    default: return null;
  }
}

export const validBranch = b => /^[a-z0-9][a-z0-9._/-]*[a-z0-9]$/i.test(b ?? "") && !b.includes("..") && !b.includes("//");
