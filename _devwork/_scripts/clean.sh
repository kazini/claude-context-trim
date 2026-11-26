#!/usr/bin/env bash
# Remove everything regenerable (mostly gitignored), leaving only sources.
# Undo with _devwork/_scripts/restore.sh.
#
#   clean.sh            installs (local Claude Code, tsc tooling), generated .claude-plugin/types,
#                       the plugin's .gitignore, marketplace cache, python caches, release zips
#   clean.sh --state    the above + generated test state (claude-config, logs, captured requests)
#   clean.sh --dry-run  list what would be removed and how big it is; change nothing
#
# Only fixed paths inside this repository are ever touched (each one is checked); tracked sources,
# fixtures (_devwork/cc_testenv/work) and version pins (cc/package*.json) are never removed, apart
# from the plugin's own .gitignore, which restore.sh recreates.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PLUGIN="$REPO/selective-context-trim"
T="$REPO/_devwork/cc_testenv"

DRY=0; STATE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --state)   STATE=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

# Refuse to run anywhere that does not look like this repository.
if [ ! -f "$PLUGIN/.claude-plugin/plugin.json" ] || [ ! -d "$REPO/_devwork/_scripts" ] || [ -z "$REPO" ] || [ "$REPO" = "/" ]; then
  echo "refusing to run: $REPO does not look like the Context Trim repository" >&2; exit 1
fi

if [ "$DRY" = 0 ] && [ -f "$T/stopall.sh" ]; then bash "$T/stopall.sh" || true; fi   # never delete under a running test process

TOTAL_KB=0
remove() {  # remove <path relative to the repo>
  local rel="$1" abs="$REPO/$1"
  case "$abs" in "$REPO"/?*) ;; *) echo "refusing unsafe path: $abs" >&2; exit 1 ;; esac
  if [ -e "$abs" ] || [ -L "$abs" ]; then
    local kb; kb=$(du -sk "$abs" 2>/dev/null | cut -f1); kb=${kb:-0}
    TOTAL_KB=$((TOTAL_KB + kb))
    if [ "$DRY" = 1 ]; then printf '  would remove  %-62s %7s KB\n' "$rel" "$kb"
    else rm -rf -- "$abs"; printf '  removed       %-62s %7s KB\n' "$rel" "$kb"; fi
  fi
}

echo "Context Trim clean-up ($([ "$DRY" = 1 ] && echo dry run || echo for real)$([ "$STATE" = 1 ] && echo ', including test state'))"

# installs and generated declarations (the plugin folder must stay free of node_modules for Claude Code to write its types)
remove "_devwork/cc_testenv/cc/node_modules"
remove "_devwork/cc_testenv/tooling/node_modules"
remove "node_modules"                         # a dev symlink or a real install at the repo root
remove "selective-context-trim/node_modules"  # ... or inside the plugin folder
remove "selective-context-trim/.claude-plugin/types"
remove "selective-context-trim/.gitignore"    # recreated by restore.sh; never shipped
# caches
remove "_devwork/cc_testenv/claude-config/plugins"
remove ".cache"
remove ".npm"
while IFS= read -r d; do remove "${d#"$REPO"/}"; done < <(find "$REPO" -name node_modules -prune -o -name __pycache__ -type d -print 2>/dev/null)
while IFS= read -r f; do remove "${f#"$REPO"/}"; done < <(find "$REPO" -maxdepth 2 \( -name '*.tsbuildinfo' -o -name '*.pyc' \) -not -path '*/node_modules/*' 2>/dev/null)
# build artifacts: the default output folder (and any stray zip an older version left at the root)
remove "_devwork/dist"
for z in "$REPO"/*.zip; do [ -e "$z" ] && remove "${z#"$REPO"/}"; done

if [ "$STATE" = 1 ]; then
  remove "_devwork/cc_testenv/claude-config"
  for f in api.log drive.out mod-debug.log .hung .hung.log tui.raw tui.txt tui.cmd tui.pid tui.out fake/server.out; do remove "_devwork/cc_testenv/$f"; done
  for d in reqs relay; do remove "_devwork/cc_testenv/$d"; done
  for f in "$T"/.corrupted*; do [ -e "$f" ] && remove "${f#"$REPO"/}"; done
fi

printf '%s %s MB\n' "$([ "$DRY" = 1 ] && echo 'Would free' || echo 'Freed')" "$((TOTAL_KB / 1024))"
[ "$DRY" = 1 ] || echo "Restore with: _devwork/_scripts/restore.sh"
