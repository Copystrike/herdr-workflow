# wf-branches

F1 repository view and F2 launcher. The worktrees of shared `wf.repo` in groups (Needs you,
Running, In review, Open, Merged / closed), stacked branches under their parent; each row has the
agent status, phase chip, PR number with its blocker (conflict, CI red, changes requested) and a
pulsing dot while CI runs, ahead/behind, the dirty count and how many terminals it has. Below:
other branches (collapsed, filterable), branchless live sessions, and the selected branch's page
(status line, next action and the command it would send, plan, newest review, issue and PR
links, terminals with a New button).

Every worktree has its own herdr space. Selecting a branch shows that space, so only its
terminals are on screen, and resumes its Claude sessions that a restart left as shells
(`wf resume`). Clicking a branch with no terminals yet starts Claude Code in its space (herdr
has no empty space to show); next/prev only move the selection. + on the row (or New on the page)
opens wf-menu: Claude Code or Terminal in the branch's space.

Sessions (`sessions.js`, F4): the branch page lists the branch's Claude sessions, newest first,
with their name, first prompt, prompt and compaction counts and when they were last active; live
ones carry their status dot. Clicking a live one shows it, a past one resumes in a new labelled
terminal. On hover: the last answer, copy the id, copy the resume command, open the transcript.
"Sessions without a branch" lists past sessions of the repository folder (resumed there) and of
removed worktrees (resumed in the selected branch, copied there first). Transcripts are read by
`wf sessions` and `wf answer`, never by the mod.

Launcher (`launcher.js`, top of the panel): paste an issue (URL or #n), several issue URLs, a PR
URL, a /command or a task and press Enter. It shows the branch it becomes (editable), the base and
the worktree, or that the branch exists. Enter again makes the worktree (`wf new`), starts Claude
in its space and types the first message once Claude is idle (`wf deliver`, retried while a
trust dialog waits). Esc cancels; Up and Down recall this session's pastes (memory only).

Keys: `wf-branches.next`, `.prev`, `.select:<branch>`, `.refresh`.

Reads: `git` (worktree list, refs, status, log) in the repository and each worktree, one `find`
of each worktree's `docs/` for optional plan / batch / review files, `gh pr list` once
a minute, live `terminals()`, `spaces()`, `panes()`. Refreshes on changes under the git dir and
each worktree's `docs/`, at most every 3 s.
Writes: shared `wf.branch`, telemetry; through `wf`: new branches and worktrees, terminals.
