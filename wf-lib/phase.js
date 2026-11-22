// Branch workflow phase derivation as a pure function.
// Inputs are facts from optional markdown plan files, git history, and PR state.
//
//   derivePhase({ isBase, files, git, pr })
//     isBase  this worktree is on the default branch (no phase)
//     files   readWorkflowFiles() result
//     git     { reviewedAfterMilestones: bool|null, codeAfterReview: bool|null, reviewCommit: sha|null }
//     pr      { number, state: "OPEN"|"MERGED"|"CLOSED", isDraft } | null; undefined = PR source unknown
//
// Returns { key, label, who, next } where who is "user" | "session" | "app" | null and
// next is { label, command } or null.

export const PHASES = {
  base: { label: "Default branch", who: null },
  none: { label: "Not started", who: "app" },
  error: { label: "Unreadable plan", who: "user" },
  stopped: { label: "Stopped", who: "user" },
  gate1: { label: "Gate 1: plan to approve", who: "user" },
  implementing: { label: "Implementing", who: "session" },
  interrupted: { label: "Interrupted", who: "session" },
  fixing: { label: "Fixing", who: "session" },
  waiting: { label: "Waiting on an answer", who: "user" },
  reviewing: { label: "Reviewing", who: "session" },
  handover: { label: "Handing over", who: "session" },
  seeding: { label: "Seeding", who: "session" },
  openingPr: { label: "Opening PR", who: "session" },
  gate2: { label: "Gate 2: test it", who: "user" },
  fixFirst: { label: "Fix-first round", who: "session" },
  inReview: { label: "Ready / in review", who: "session" },
  merged: { label: "Merged", who: "user" },
  closed: { label: "PR closed", who: "user" },
  prUnknown: { label: "PR open", who: null },
};

// Which group / board column a phase belongs to.
export const GROUP_OF = {
  base: "open", none: "open", error: "needs", stopped: "needs", gate1: "needs", implementing: "running",
  interrupted: "running", fixing: "running", waiting: "needs", reviewing: "running", handover: "running",
  seeding: "running", openingPr: "running", gate2: "needs", fixFirst: "running", inReview: "review",
  merged: "done", closed: "done", prUnknown: "review",
};

const tick = v => (v ? "✓" : "–");

function phase(key, extra = {}) {
  const p = PHASES[key];
  return { key, label: p.label, who: p.who, next: null, ...extra };
}

// One-line summary of plan / batch progress and PR status.
export function statusLine(files, pr) {
  const p = files?.planFacts;
  if (p) {
    const m = p.milestones;
    const reviewed = files.reviews?.length > 0;
    return [
      `plan ✓`, `approved ${tick(p.approved)}`, `milestones ${m.done}/${m.total}${m.settledText ? `, ${m.settledText}` : ""}`,
      `review ${tick(reviewed)}`, `handover ${tick(p.artifacts.handover)}`,
      `seeded ${p.seeded === "removed" ? "removed" : tick(p.seeded === true)}`,
      `PR ${pr?.number ? "#" + pr.number : p.pr ? "✓" : "–"}`,
    ].join(" · ");
  }
  const b = files?.batchFacts;
  if (b) return [`fixes ${b.done}/${b.total}`, b.dropped ? `dropped ${b.dropped}` : null, `review ${tick(files.reviews?.length)}`,
    `handover ${tick(b.handover)}`, `PR ${pr?.number ? "#" + pr.number : "–"}`].filter(Boolean).join(" · ");
  return "no plan";
}

const FEATURE_READY = { label: "Test and mark ready", command: "gh pr ready" };
const BATCH_READY = { label: "Tested, mark ready", command: "gh pr ready" };

// After the PR exists: shared tail for feature plans and fix batches.
function prPhase(pr, git, base, ready = FEATURE_READY, gate = "mark ready") {
  if (pr === undefined) return phase("prUnknown", base);
  if (!pr) return phase("openingPr", { ...base, next: null });
  if (pr.state === "MERGED") return phase("merged", { ...base, next: { label: "Archive worktree", command: null } });
  if (pr.state === "CLOSED") return phase("closed", base);
  if (pr.isDraft) {
    if (git?.codeAfterReview && git.reviewCommit)
      return phase("fixFirst", { ...base, gate, next: { label: "Review the fix round", command: `Review changes since ${git.reviewCommit.slice(0, 9)}` } });
    return phase("gate2", { ...base, gate, next: ready });
  }
  return phase("inReview", base);
}

export function derivePhase({ isBase, files, git, pr, branch }) {
  if (isBase) return phase("base");
  if (files?.error) return phase("error", { detail: files.error });
  const p = files?.planFacts;
  const b = files?.batchFacts;

  if (p) {
    const m = p.milestones;
    const base = { progress: { done: m.done, total: m.total } };
    // A "## Stopped" note outranks every other field.
    if (p.stopped) return phase("stopped", { ...base, detail: p.stopped, next: { label: "Read the note", command: null } });
    if (!p.approved) return phase("gate1", { ...base, next: { label: "Approve plan and start", command: "Approve plan and begin implementation" } });
    if (m.done + (m.settled ?? 0) < m.total) {
      if (m.interrupted) return phase("interrupted", { ...base, label: `Interrupted ${m.done}/${m.total}`, next: { label: "Resume implementation", command: "Resume implementation" } });
      return phase("implementing", { ...base, label: `Implementing ${m.done}/${m.total}`, next: { label: "Resume implementation", command: "Resume implementation" } });
    }
    // "Reviewed" is a log committed after the last milestone. Unknown git facts: any log counts.
    const reviewed = git?.reviewedAfterMilestones ?? (files.reviews.length > 0);
    // A PR already open outranks intermediate plan fields.
    const prKnown = pr !== undefined;
    const hasPr = prKnown ? !!pr : !!p.pr;
    if (!hasPr) {
      if (!reviewed) return phase("reviewing", { ...base, next: { label: "Run pre-PR review", command: "Review changes before opening a PR" } });
      if (!p.artifacts.handover) return phase("handover", { ...base, next: { label: "Write handover notes", command: "Write handover notes" } });
      if (p.seeded === false) return phase("seeding", { ...base, next: { label: "Prepare seed data", command: "Prepare local seed data" } });
      return phase("openingPr", { ...base, next: { label: "Open draft PR", command: "gh pr create --draft" } });
    }
    return prPhase(prKnown ? pr : undefined, git, base);
  }

  if (b) {
    const base = { progress: { done: b.done, total: b.total } };
    if (b.stopped) return phase("stopped", { ...base, detail: b.stopped });
    const hasPr = pr !== undefined ? !!pr : false;
    if (!hasPr) {
      if (b.waiting > 0) return phase("waiting", { ...base, label: `Waiting on an answer (${b.waiting})` });
      if (b.done < b.total) return phase("fixing", { ...base, label: `Fixing ${b.done}/${b.total}` });
      if (!files.reviews.length) return phase("reviewing", { ...base, next: { label: "Review the batch", command: "Review the fix batch before opening a PR" } });
      if (!b.handover) return phase("handover", { ...base, next: { label: "Write handover notes", command: `Write handover notes for ${[branch, files.batch].filter(Boolean).join(" ")}` } });
      return pr === undefined ? phase("prUnknown", base) : phase("openingPr", { ...base, next: { label: "Open draft PR", command: "gh pr create --draft" } });
    }
    return prPhase(pr, git, base, BATCH_READY, "mark ready");
  }

  // No plan and no batch: fall back to PR state when a PR exists.
  if (pr) return prPhase(pr, git, {});
  return phase("none", { next: null });
}

// Compact chip label for sidebar branch rows.
export function chipLabel(p) {
  const n = p.progress ? `${p.progress.done}/${p.progress.total}` : "";
  return {
    base: "default branch", none: "not started", error: "unreadable plan", stopped: "stopped", gate1: "approve plan",
    implementing: `implement ${n}`, interrupted: `resume implement ${n}`, fixing: `fix ${n}`,
    waiting: "question", reviewing: "review", handover: "handover", seeding: "seed",
    openingPr: "open PR", gate2: "test, mark ready",
    fixFirst: "fix round", inReview: "in review", merged: "merged", closed: "PR closed", prUnknown: "PR",
  }[p.key] ?? p.label;
}
