# wf-repos

F1 sidebar: the repositories of `wf.workspaces`, grouped per workspace, each with a count of
branches that need you (orange) and that are running (blue). Click or `wf-repos.next` /
`wf-repos.prev` / `wf-repos.select:<name>` picks the repository wf-branches shows.

Reads: `git` and `gh pr list` per repository every 2 minutes (2 at a time, the first pass 4 s after loading so wf-branches reads first), live `terminals()`.
Writes: shared `wf.repo`, `wf.branch` (cleared on a new repository), telemetry.

Before changing it, check its telemetry (`wf stats --mod wf-repos` once F12's report exists).
