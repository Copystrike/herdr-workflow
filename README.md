# herdr-workflow

A personal developer workflow layout, mod suite, and orchestration CLI for [**herdr-app**](https://github.com/herdrdev/herdr-app) + **herdr-core** (`hc`).

Turns Herdr into a branch-centric workspace IDE for running AI coding agents alongside a full Git client, GitHub Actions CI inspector, and PowerShell-style terminal ergonomics.

## Features

- **3-tier collapsible sidebar (`wf-sidebar`)**
  - **Workspace** root sessions above **Projects**, with a repo-root `general` container inside every repository and collapsible branch/worktree rows underneath.
  - Live agent status dots (OSC 7501), PR badges, optional markdown plan phase chips, Spotify-style drag-and-drop branch reordering, and an archive guard that blocks archiving worktrees with staged, unstaged, or untracked changes.
  - Persistent paste-to-launch bar (GitHub issue URL / `#n`, PR URL, `/command`, or free text -> worktree + branch + agent session).
  - Compact 44px rail mode and a `Manage` drawer to show/hide or add repository folders.
- **GitHub Actions CI strip & inspector (`wf-ci`)**
  - TeamCity Sakura-style duration-proportional trend bars in the sidebar per repository.
  - Clicking any workflow opens a dedicated `wf-ci` tab with expandable jobs, clickable step nodes with inline step-log drawers, jump-cut to the exact line in the full log `Editor`, inline re-run failed/all, two-tier disk caching, and a Settings tab for watched workflows and short labels.
- **Full Git client (`wf-changes`) & big diff/file viewer (`wf-diff`)**
  - **Commit**: Unstaged/Staged split, stage/unstage per file or all, discard / delete untracked with 2-click confirmation, amend toggle, commit, and push.
  - **Compare**: Searchable local/remote base ref picker, 3-dot/2-dot toggle, PR header card, Fetch/Pull/Push, hide untracked toggle, multi-term fuzzy file filter, and diff-content search (`±`, `Aa`, `ab`, `.*`, `Net|All`).
  - **History**: Active-lanes colored commit graph tree with curved branch/merge connectors, hollow commit rings, `Branch` / `All branches` scope toggle, compact ages, and expandable per-commit files.
  - **Big center viewer (`wf-diff`)**: Side-by-side Split and Unified diff views, expandable unchanged context regions, whole-file `Editor` tab, `Mark as viewed` review tracking synced with `wf-changes`, Prev/Next file stepping, and GitHub links.
- **File tree & shared context menus (`wf-files`, `wf-menu`)**
  - Clicking or expanding any branch immediately loads its Files and Changes panels without opening a terminal first.
  - Right-click context menus on files, folders, branches, and sessions (open in viewer, mark as viewed, copy relative/absolute path, open on GitHub, reveal in file manager, stage/unstage/discard, rename/close/remove session).
- **All terminals settings & PowerShell right-click (`wf-term-menu`, `wf-term-settings`)**
  - **Copy on select** (native `copy_on_select` in `settings.json`).
  - **Newline key** (`Shift+Enter` or `Ctrl+Enter`, synced live to `keys.json`).
  - **Right click**: Windows console / PowerShell **Copy or paste** (copies when text is selected and clears selection, otherwise pastes text or clipboard image), **Paste**, or **Menu**.
  - **Warn before pasting multiple lines** confirmation guard.
- **Clean empty canvas & dedicated mod spaces (`wf-tabs`, `wf-empty`)**
  - Closing the last tab of a space lands on a clean empty canvas instead of jumping into unrelated background spaces.
  - CI and diff tabs cleanly open in their own space even when zero spaces exist and tear down when closed.
- **Orchestration CLI (`bin/wf.mjs` -> `~/.local/bin/wf`)**
  - JSON-emitting CLI shared by the mods and agent sessions: `wf projects`, `wf list`, `wf status`, `wf new`, `wf open`, `wf send`, `wf logs`, `wf diff`, `wf result`, `wf sessions`, `wf resume`, `wf rename`, `wf stop`, `wf remove-session`, `wf deliver`, `wf ci-jobs`.

## Repository layout

```
bin/           wf CLI, Claude launcher wrapper, SessionStart hook, transcript reader
docs/          label, shared-state, and local telemetry schemas
layouts/       workflow.json Herdr layout and preview SVG
mods/          Herdr GPUI mods (wf-sidebar, wf-tabs, wf-empty, wf-files, wf-changes,
               wf-diff, wf-ci, wf-menu, wf-term-menu, wf-term-settings, wf-repos, wf-branches)
scripts/       install.sh (builds & installs mods, layout, CLI) and e2e-visual.mjs
test/          unit tests (wf-lib, sessions) and static mod safety checks
wf-lib/        shared pure ESM library bundled into each mod on install
```

## Installation

Requires [herdr-app](https://github.com/herdrdev/herdr-app), `herdr-core` (`hc`), Node.js 20+, `git`, and optionally `gh` (GitHub CLI) for PR and CI features.

```bash
git clone https://github.com/Copystrike/herdr-workflow.git
cd herdr-workflow
bash scripts/install.sh
```

`scripts/install.sh` bundles `wf-lib/` into each mod, installs the mods and `workflow.json` into `~/.config/herdr-app/`, symlinks `~/.local/bin/wf`, and runs `herdr-app check` on every mod.

Then select the **workflow** layout in Herdr (`Ctrl+Shift+L`).

## Configuration

Per-machine paths and hooks live outside this repository in `~/.config/herdr-app/wf/config.json`:

```json
{
  "wf.workspaces": [
    "~/Projects",
    "~/Projects/my-workspace"
  ],
  "postWorktreeHook": "~/bin/copy-env-to-worktree.sh"
}
```

- `wf.workspaces`: Array of workspace folders (each containing `repos/<name>`) or individual git repository folders (supports both bare-repo + worktrees and standard clones). Defaults to `["~/Projects"]`.
- `postWorktreeHook` (optional, or `WF_POST_WORKTREE_HOOK` env var): Script called as `<hook> <baseWorktree> <newWorktree>` after `wf new` creates a worktree.
- Terminal interaction settings (**Copy on select**, **Newline key**, **Right click**, **Warn before pasting multiple lines**) can be changed live from the terminal icon in the top bar or from the terminal right-click menu.

## Testing

```bash
node --test 'test/*.test.mjs'
```

- `test/wf-lib.test.mjs`: pure unit tests for git, diff/graph, forge/CI, phase derivation, launcher, and terminal settings.
- `test/sessions.test.mjs`: Claude transcript parsing and cross-worktree resume copying against temporary directories.
- `test/mod-safety.test.mjs`: static guards against render-time retained state constructors, synchronous `cx.notify()` in `render()`/`draw()`, invalid 10-digit hex theme token concatenations, missing SVG assets, missing `checking()` guards, and `herdr-app check` validation for all mods.
