# wf-lib

Shared code for the `wf-*` mods and the `wf` CLI (`bin/wf.mjs`). Plain ESM with no `herdr` import:
callers pass `exec` and `fs`, so the same modules run inside a mod and under `node --test`.
Mods can only import from their own folder, so `scripts/install.sh` copies this folder into each
mod as `lib/wf/`.

| File | What |
|---|---|
| `labels.js` | terminal label schema; terminals of a worktree; most urgent agent status |
| `paths.js` | Claude Code's project-folder name for a path (200-character hash rule) |
| `frontmatter.js` | lightweight YAML front-matter parser and Markdown `## ` section splitter |
| `plan.js` | optional plan, fix-batch, and review-log reader; `docsSnapshot()` answers folder reads via one `find` |
| `phase.js` | `derivePhase()`: pure workflow phase state machine and compact chip labels |
| `git.js` | git worktree, ref, status, archive guard, and phase-commit fact readers |
| `git-panel.js` | Commit / Compare / History git client helpers, fuzzy matcher, split diff, and active-lanes commit graph |
| `forge.js` | GitHub PR and Actions CI trend / job / step-log helpers through `gh` |
| `ci-cache.js` | two-tier disk + memory cache for CI snapshots, jobs, annotations, and build logs |
| `repo.js` | repository model, branch groups, stacks, drag-and-drop branch ordering, counts |
| `agent.js` | Claude Code argv/resume helpers, one herdr space per worktree, reboot-resume detection |
| `sessions.js` | Claude Code JSONL transcript parsing (prompts, compactions, titles, last answer) |
| `launch.js` | launcher input parser (issue, PR, command, text), branch name proposal, prompt builders |
| `terminal.js` | global terminal behavior helpers (PowerShell right-click copy/paste, newline key, multiline paste guard) |
| `telemetry.js` | local-only `track()` with field whitelist and compare-and-set writer |
| `herdr-adapter.js` | mods only: herdr exec/fs, local `wf/config.json` + settings defaults, telemetry writer, `wf()` CLI caller |

Tests: `node --test 'test/*.test.mjs'`.
