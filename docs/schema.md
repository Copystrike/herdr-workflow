# Schemas

The contracts between the wf mods, the `wf` CLI and `wf-watch`. Code: `wf-lib/labels.js`,
`wf-lib/telemetry.js`. Bump the version on any incompatible change.

## Terminal labels (version 1)

Every hc terminal the app starts carries these labels (`hc run --label k=v`, built by
`labelArgs()`). They are the join key between a terminal and a repo, branch and session.

| Label | Value |
|---|---|
| `wf.v` | schema version, `1` |
| `repo` | repository name: the folder under `repos/` |
| `branch` | branch name, `feat/portal-ordering` |
| `worktree` | absolute worktree path |
| `session` | Claude Code session id; `bin/session-hook.sh` (a Claude SessionStart hook) keeps it current after /clear and /resume |
| `role` | `task`, `orchestrator`, `server` or `shell` |

Roles: `task` is a Claude session (started as `bin/claude --session-id <session>`), `shell` a
plain terminal. `herdr.space` and `herdr.tab` place the terminal: every worktree gets one herdr
space with the id `spaceIdFor(path)` (`wfsp` + two base-36 hashes of the path), so the same
branch always lands in the same space, and selecting a branch selects that space.

A terminal without `worktree` is matched to a worktree by its cwd (`terminalsIn()`), so a
`claude` started by hand in a worktree still shows on its branch.

## Shared state (herdr `shared()`)

| Key | Value | Written by |
|---|---|---|
| `wf.repo` | `{ name, dir }`, the active repository | wf-sidebar / wf-repos |
| `wf.branch` | `{ repo, path, branch }`, the selected worktree, or null | wf-sidebar / wf-branches |
| `wf.workspaces` | folders to list repositories from (a workspace or one repository); also read from `~/.config/herdr-app/wf/config.json` | user |
| `wf.termSettings` | `{ copyOnSelect, newlineKey, rightClick, warnMultilinePaste }` global terminal interaction preferences | wf-term-settings |
| `wf.telemetry` | `false` turns local telemetry off; nothing is written then | user |

## Telemetry (version 1)

One JSON object per line in `~/.config/herdr-app/data/wf/telemetry/<yyyy-mm-dd>.jsonl` (local
date; `<date>.<n>.jsonl` past 900 KiB). Local only, never sent.

Every line: `v` (1), `ts` (ISO time), `event`. Other fields only from this list, and only as
numbers, booleans or single-line strings up to 120 characters: `mod`, `version`, `error`, `ms`,
`cmd`, `exit`, `bytes`, `surface`, `action`, `repo`, `branch`, `phase_from`, `phase_to`,
`command`, `terminal`, `session`, `status`, `pattern`, `phase`, `count`, `group`. `clean()`
drops anything else, so a prompt, a diff or a file's content cannot reach the file.

| Event | Fields | When |
|---|---|---|
| `mod` | `mod`, `action: loaded` | a wf mod starts |
| `error` | `mod`, `error` (a fixed message, no data) | a gather or refresh throws |
| `exec` | `cmd` (program + first plain-word argument), `ms`, `exit`, `bytes` | an exec fails or takes over 2 s |
| `scan` | `mod`, `ms`, `count` | wf-repos finished a pass over every repository |
| `refresh` | `mod`, `repo`, `ms`, `count` | wf-branches re-read a repository |
| `ui` | `surface`, `action`, `repo`, `branch`, `phase` | a click or key command |
| `launch` | `action` (`propose-<kind>`, `start-<kind>`, `delivered`, `not-delivered`), `repo`, `count` | the F2 launcher |

## Session cache

`~/.config/herdr-app/data/wf/sessions-cache.json` (mode 600), written by `wf sessions`: per
transcript its size, mtime, the byte offset read up to, prompt and compaction counts, titles and
cwd. Never prompt text: the first prompt is read from the transcript each time. Transcripts only
grow, so a listing reads only what was added since. Delete the file to rebuild it.

## The `wf` CLI

`node ~/.config/herdr-app/wf/bin/wf.mjs <command>` (installed by `scripts/install.sh`). Every
command prints one JSON object, `{ "error": "..." }` on failure. The mods call it for anything
that starts terminals or touches git.

| Command | Does |
|---|---|
| `open --worktree <p> --claude\|--shell [--repo] [--branch] [--focus]` | starts Claude (new session id, named after the worktree folder like Termic: `--name <slug>`) or a shell in the worktree's space, names the tab, names a new space after the branch |
| `open --worktree <p> --claude --resume <session> [--file <transcript>] ...` | resumes that session there instead (`--resume <session> --name <slug>`, label `session` set at once); with `--file` from another project folder, first copies the transcript and its sidecar folder into the worktree's project folder, since Claude only finds sessions under the folder of its cwd |
| `sessions --worktree <p>` | the worktree's Claude sessions, newest first: `id`, `file`, `cwd`, `title` (its name, else Claude's title, else the first prompt), `prompt` (the first, shortened), `prompts`, `compactions`, `last` (ms), `size` |
| `sessions --repo <dir>` | the same for sessions outside every current worktree (the repository folder, removed worktrees), newest 60 of `total`, each with `home`: `repo` or `removed` |
| `answer --file <transcript>` | `{text}`: Claude's last answer, read from the end of the transcript |
| `resume --worktree <p>` | types `bin/claude --resume <session> --name <slug>` into each `task` terminal there whose Claude is gone and a shell sits in its place |
| `new --repo <dir> [--branch <b>] [--dry-run] [--focus] -- <pasted>` | `--dry-run`: the branch, base and worktree a paste becomes, and what already exists. Without: fetch, `git worktree add` from `origin/<base>`, copy the dev config, `open --claude` |
| `deliver --terminal <t> --repo <dir> --branch <b> --kind <k> [--wait <s>] -- <ref\|text>` | builds the first message in memory and types it once Claude is idle; `{delivered: false, status}` when it isn't within the wait |
