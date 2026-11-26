#!/bin/bash
# fresh state for a scenario: new fake server (empty cache), empty logs, no old sessions; config seeded
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
pkill -f "^python3 fake/server.py" 2>/dev/null; sleep 0.3
mkdir -p "$CLAUDE_CONFIG_DIR" "$T/reqs" "$T/relay"   # absent on a fresh clone (gitignored)
cd $T && rm -rf api.log reqs/* tui.raw tui.txt tui.cmd tui.pid tui.out relay/* $CLAUDE_CONFIG_DIR/projects $CLAUDE_CONFIG_DIR/sessions
(FAKE_MODE=${1:-happy} nohup python3 fake/server.py 8765 > fake/server.out 2>&1 &); sleep 0.8
python3 - <<'PY'
import json,os
cfg=os.environ['CLAUDE_CONFIG_DIR']; T=os.environ['T']; key=os.environ['ANTHROPIC_API_KEY']
p=cfg+'/.claude.json'; d=json.load(open(p)) if os.path.exists(p) else {}
d.update({'hasCompletedOnboarding':True,'theme':'dark','numStartups':5,
  'customApiKeyResponses':{'approved':[key[-20:]],'rejected':[]},
  'hasAcknowledgedCostThreshold':True,'bypassPermissionsModeAccepted':True})
d.setdefault('projects',{})[T+'/work']={'hasTrustDialogAccepted':True,'hasCompletedProjectOnboarding':True,'allowedTools':[]}
json.dump(d,open(p,'w'),indent=1)
json.dump({'permissions':{'allow':['Read','Edit','Agent','mcp__selective-context-trim__inspect_session','mcp__selective-context-trim__trim_session']}},open(cfg+'/settings.json','w'))
PY
echo reset-done
