# wf-menu

The + menu of a branch in wf-branches: Claude Code (1), Terminal (2) or Open folder. Opened by
wf-branches as a popup with props `{ worktree, repo, branch }`; runs `wf open --focus`, which
starts the terminal in that branch's own space and shows it. Stays open while the terminal
starts, so an error shows in the menu.
