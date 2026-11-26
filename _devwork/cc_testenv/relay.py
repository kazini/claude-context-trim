#!/usr/bin/env python3
"""Answer the fake API as the model. Several requests can be outstanding (main thread + subagents).
  relay.py list                                  outstanding request numbers
  relay.py wait [secs] [--n N]                   show the next unanswered request (or request N)
  relay.py reply [--to N] [--text T] [--tool NAME JSON]... [--wait secs]   answer request N (default: the last one shown)
  relay.py grep REGEX [--n N]                    search FULL tool results of request N
"""
import sys, os, json, time, glob, re
R = os.environ['T'] + '/relay'
def nums(pattern):
    return sorted(int(re.search(r'_(\d+)\.', f).group(1)) for f in glob.glob(R + '/' + pattern))
def outstanding():
    return [n for n in nums('pending_*.txt') if not os.path.exists(R + '/answered_%d' % n)]
def shown():
    try: return int(open(R + '/current').read())
    except Exception: return 0
def show(n):
    open(R + '/current', 'w').write(str(n)); open(R + '/seen_%d' % n, 'w').close(); print(open(R + '/pending_%d.txt' % n).read())
def wait(secs, only=None):
    t0 = time.time()
    while time.time() - t0 < secs:
        for n in outstanding():
            if only is not None and n != only: continue
            if not os.path.exists(R + '/seen_%d' % n): show(n); return
        time.sleep(0.3)
    print('(no new request within %ds; outstanding: %s)' % (secs, outstanding()))
a = sys.argv[1:]
def opt(name, default=None):
    if name in a: return a[a.index(name) + 1]
    return default
if not a or a[0] == 'wait': wait(int(a[1]) if len(a) > 1 and a[1].isdigit() else 60, int(opt('--n')) if opt('--n') else None)
elif a[0] == 'list': print(outstanding())
elif a[0] == 'reply':
    to = int(opt('--to', shown())); blocks, w, i = [], 0, 1
    while i < len(a):
        if a[i] == '--text': blocks.append({'type': 'text', 'text': a[i+1]}); i += 2
        elif a[i] == '--tool': blocks.append({'type': 'tool_use', 'name': a[i+1], 'input': json.loads(a[i+2])}); i += 3
        elif a[i] == '--wait': w = int(a[i+1]); i += 2
        elif a[i] == '--to': i += 2
        else: sys.exit('bad arg ' + a[i])
    tmp = R + '/response_%d.tmp' % to; json.dump({'blocks': blocks}, open(tmp, 'w')); os.rename(tmp, R + '/response_%d.json' % to); open(R + '/answered_%d' % to, 'w').close()
    print('replied to #%d with' % to, [b['type'] + (':' + b['name'] if 'name' in b else '') for b in blocks])
    if w: wait(w)
elif a[0] == 'grep':
    n = int(opt('--n', shown())); r = json.load(open(os.environ['T'] + '/reqs/%03d.json' % n)); pat = re.compile(a[1])
    for i, m in enumerate(r['messages']):
        c = m['content']
        if isinstance(c, list):
            for b in c:
                if b.get('type') == 'tool_result':
                    x = b['content']; x = x if isinstance(x, str) else '\n'.join(y.get('text', '') for y in x)
                    hits = [l for l in x.splitlines() if pat.search(l)]
                    print('#%d %s: %d chars, %d hit(s)%s' % (i, b['tool_use_id'], len(x), len(hits), (' -> ' + ' | '.join(h.strip()[:120] for h in hits[:3])) if hits else ''))
