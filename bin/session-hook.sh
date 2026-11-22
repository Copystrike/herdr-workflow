#!/bin/sh
# Claude SessionStart hook: keeps the `session` label of a wf terminal on the current Claude
# session id, which changes on /clear and /resume. Does nothing outside herdr or in a terminal
# wf did not start (no wf.v label). Reads the hook JSON on stdin; never fails the session.
[ -n "$HC_TERMINAL_ID" ] || exit 0
id=$(jq -r '.session_id // empty' 2>/dev/null) || exit 0
[ -n "$id" ] || exit 0
labels=$(hc get "$HC_TERMINAL_ID" --json 2>/dev/null | jq -c '.labels // {}' 2>/dev/null) || exit 0
[ "$(printf '%s' "$labels" | jq -r '."wf.v" // empty')" = 1 ] || exit 0
[ "$(printf '%s' "$labels" | jq -r '.session // empty')" = "$id" ] && exit 0
hc label "$HC_TERMINAL_ID" "session=$id" >/dev/null 2>&1
exit 0
