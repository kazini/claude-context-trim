#!/usr/bin/env bash
# Drive the REAL Claude Code TUI (with the real plugin) with a REAL model, through fake/server.py's `nim` mode.
# The key is read from <repo>/_devwork/.apikeys (NVIDIA_NIM_KEY) by the server itself; it never enters this shell.
#
#   nohup bash nim.sh <model> <prompt-file> [idle-seconds] >/dev/null 2>&1 &     # a sandbox call is cut after ~125 s: run in the background
#   ... poll until $T/nim.done exists, then:  python3 show.py
#
# models: minimaxai/minimax-m3.1-flash | nvidia/nemotron-3.5-lightning-30b-a3b
# The prompt file holds the task (use absolute paths: the model does not know $T). idle-seconds (default 35): how long to wait
# after the model stops, for the cold-cache pass (TRIM_COLD_AFTER_MS=6000) to apply what is flagged.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/env.sh"
rm -f "$T/nim.done"
export NIM_MODEL="${1:?model}" TRIM_COLD_AFTER_MS=6000
bash "$T/reset.sh" nim >/dev/null
PROMPT="$(cat "${2:?prompt file}")"
cd "$T" || exit 1
timeout 240 python3 drive.py --steps "$(python3 -c 'import json,sys;print(json.dumps([sys.argv[1],{"wait_stage":"nim-final","timeout":150},{"sleep":int(sys.argv[2])}]))' "$PROMPT" "${3:-35}")" --settle 3 > drive.out 2>&1
touch "$T/nim.done"
