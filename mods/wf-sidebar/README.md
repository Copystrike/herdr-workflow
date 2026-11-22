# wf-sidebar

Unified Termic-style 3-level collapsible sidebar for `herdr-app`:

1. **Repositories** (collapsible, curated list in shared `wf.repos` with `+` folder picker and `Manage` show/hide drawer).
2. **Branches / worktrees** (collapsible directly under each repo, with PR `#`, blocker/CI signals, compact phase pills via `chipLabel()`, and hover `+` to spawn any installed AI CLI via `wf-menu`).
3. **Sessions & terminals** (live terminals/agents attached to the branch with each CLI's own icon and OSC 7501 status, plus past Claude sessions underneath to resume on click).

Includes a compact persistent paste-an-issue launcher at the top, live branch filtering, status rollup filters, active-space sync for `wf-files`, and compact rail rendering when the sidebar is collapsed below 160px.
