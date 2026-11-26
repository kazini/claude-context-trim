# source me (bash): everything Claude Code writes goes inside the project folder.
# Location-independent: every path is derived from this file's own place in the repo.
#   <repo>/selective-context-trim/   the plugin itself ($PLUGIN)
#   <repo>/_devwork/cc_testenv/      this test bed ($T)
if [ -z "${BASH_SOURCE[0]:-}" ]; then echo "env.sh must be sourced from bash" >&2; return 1 2>/dev/null || exit 1; fi
_env_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export T="$_env_here"
export REPO="$(cd "$_env_here/../.." && pwd)"
export PLUGIN="$REPO/selective-context-trim"
unset _env_here

export CLAUDE_CONFIG_DIR="$T/claude-config"
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765
export ANTHROPIC_API_KEY=sk-ant-api03-faketestkey000000000000000000000000000000000000000000000000000000000000-AAAAAA
export DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1
export PATH="$T/cc/node_modules/.bin:$PATH"
export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1   # do not load AGENTS.md/CLAUDE.md from the project root into test sessions
