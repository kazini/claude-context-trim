#!/usr/bin/env bash
# Rebuild what clean.sh removed. Needs network (npm) unless the pieces are already there.
#
#   restore.sh              1. plugin .gitignore (dev-only ignore rules)
#                           2. tooling (typescript + @types/node)  from tooling/package-lock.json
#                           3. local Claude Code, pinned           from cc/package-lock.json
#                           4. .claude-plugin/types  (Claude Code writes it when it loads the plugin)
#                           5. a type-check as proof that it all works
#   restore.sh --skip-cc    skip 3 and 4 (the unit tests need neither Claude Code nor the types)
#   restore.sh --skip-types skip 4 and 5
#
# Idempotent: a piece that is already present is left alone.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PLUGIN="$REPO/selective-context-trim"
T="$REPO/_devwork/cc_testenv"

SKIP_CC=0; SKIP_TYPES=0
for a in "$@"; do
  case "$a" in
    --skip-cc)    SKIP_CC=1; SKIP_TYPES=1 ;;
    --skip-types) SKIP_TYPES=1 ;;
    -h|--help)    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

if [ ! -f "$PLUGIN/.claude-plugin/plugin.json" ] || [ ! -d "$REPO/_devwork/_scripts" ]; then
  echo "refusing to run: $REPO does not look like the Context Trim repository" >&2; exit 1
fi
step() { printf '\n== %s\n' "$*"; }

# ── 1. plugin .gitignore ────────────────────────────────────────────────────────
step "plugin .gitignore (dev-only ignore rules)"
if [ -f "$PLUGIN/.gitignore" ]; then echo "already present"
else
  cat > "$PLUGIN/.gitignore" <<'EOF'
# Dev-only ignore rules for files generated inside the plugin folder.
# Recreated by _devwork/_scripts/restore.sh. Never shipped: package_plugin.py ships a whitelist.
.claude-plugin/types/
node_modules
EOF
  echo "recreated"
fi

command -v node >/dev/null && command -v npm >/dev/null || { echo "node and npm are required" >&2; exit 1; }

TSC="$T/tooling/node_modules/.bin/tsc"
CLAUDE="$T/cc/node_modules/.bin/claude"
TYPES="$PLUGIN/.claude-plugin/types/claude-code/index.d.ts"

# ── 2. tooling ────────────────────────────────────────────────────────────────
step "tooling (typescript, @types/node)"
if [ -x "$TSC" ]; then echo "already installed: $("$TSC" --version)"
else (cd "$T/tooling" && npm ci --no-audit --no-fund --loglevel=error) && echo "installed: $("$TSC" --version)"; fi

# ── 3. Claude Code, at the version the lockfile pins ───────────────────────────
if [ "$SKIP_CC" = 0 ]; then
  step "local Claude Code (pinned by cc/package-lock.json)"
  if [ -x "$CLAUDE" ]; then echo "already installed: $("$CLAUDE" --version 2>&1 | head -1)"
  else (cd "$T/cc" && npm ci --no-audit --no-fund --loglevel=error) && echo "installed: $("$CLAUDE" --version 2>&1 | head -1)"; fi
fi

# ── 4. generated declarations ──────────────────────────────────────────────────
if [ "$SKIP_TYPES" = 0 ]; then
  step ".claude-plugin/types (written by Claude Code when it loads the plugin)"
  if [ -f "$TYPES" ]; then echo "already present"
  else
    # Claude Code only writes them while the plugin folder has NO node_modules (and only in an interactive session).
    if [ -L "$PLUGIN/node_modules" ]; then rm -- "$PLUGIN/node_modules"; fi
    if [ -d "$PLUGIN/node_modules" ]; then
      echo "skipped: $PLUGIN/node_modules is a real directory, so Claude Code will not generate the types (remove it and re-run)"
    else
      # shellcheck disable=SC1091
      source "$T/env.sh"
      bash "$T/reset.sh" happy >/dev/null                # fake provider up, config seeded
      # An interactive session is what makes Claude Code write them: print mode (claude -p) does not.
      ( cd "$T" && timeout 120 python3 drive.py --steps '["hello", {"sleep":3}]' --settle 4 >/dev/null 2>&1 ) || true
      bash "$T/stopall.sh" || true
      if [ -f "$TYPES" ]; then echo "generated"; else echo "WARNING: Claude Code did not write the types (see $T/fake/server.out)" >&2; fi
    fi
  fi

  # ── 5. proof ────────────────────────────────────────────────────────────────
  step "type-check (strict, against Claude Code's own declarations)"
  if [ -f "$TYPES" ] && [ -x "$TSC" ]; then
    if (cd "$PLUGIN" && "$TSC" -p . --typeRoots "$T/tooling/node_modules/@types"); then echo "OK: tsc exit 0"
    else echo "FAILED: tsc reported errors (above)" >&2; exit 1; fi
  else echo "skipped (types or tsc missing)"; fi
fi

printf '\nDone. Next: node --test _devwork/tests/*.spec.ts   (from %s)\n' "$REPO"
