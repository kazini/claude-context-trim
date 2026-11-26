#!/usr/bin/env python3
"""Drive the real Claude Code TUI through a pty and wait on the fake API's log."""
import os, pty, sys, time, json, select, re, fcntl, termios, struct, signal, argparse
T = os.environ['T']; PLUGIN = os.environ['PLUGIN']
ANSI = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]')
ap = argparse.ArgumentParser()
ap.add_argument('--steps', required=True, help='JSON list: ["text", {"wait_stage":"continued","timeout":60}, {"sleep":2}, {"raw":"\\r"} ...]')
ap.add_argument('--args', default='', help='extra claude args')
ap.add_argument('--settle', type=float, default=3.0, help='seconds to wait after the last step before quitting')
a = ap.parse_args()

def stages():
    try: return [json.loads(l) for l in open(T + '/api.log')]
    except FileNotFoundError: return []

env = dict(os.environ, TERM='xterm-256color', COLUMNS='170', LINES='50')
argv = ['claude', '--plugin-dir', PLUGIN, '--model', 'claude-sonnet-5-5'] + a.args.split()
pid, fd = pty.fork()
if pid == 0:
    os.chdir(T + '/work'); os.execvpe('claude', argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 170, 0, 0))
log = open(T + '/tui.raw', 'wb')
def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: return False
            if not d: return False
            log.write(d); log.flush()
    return True
alive = pump(6)  # startup
for step in json.loads(a.steps):
    if not alive: break
    if isinstance(step, str):
        os.write(fd, step.encode()); pump(0.6); os.write(fd, b'\r'); alive = pump(0.5)
    elif 'raw' in step:
        os.write(fd, step['raw'].encode().decode('unicode_escape').encode()); alive = pump(0.5)
    elif 'sleep' in step:
        alive = pump(step['sleep'])
    elif 'wait_stage' in step:
        want, tmo, t0 = step['wait_stage'], step.get('timeout', 60), time.time()
        nth = step.get('nth', 1)
        while time.time() - t0 < tmo and alive:
            if sum(1 for s in stages() if s['stage'] == want) >= nth: break
            alive = pump(0.3)
        else:
            print(f"!! timeout waiting for stage {want} (x{nth})")
alive = pump(a.settle)
try:
    os.write(fd, b'\x03'); pump(0.4); os.write(fd, b'\x03'); pump(0.8)
    os.kill(pid, signal.SIGTERM)
except Exception: pass
txt = ANSI.sub(b'', open(T + '/tui.raw', 'rb').read()).decode('utf8', 'replace')
open(T + '/tui.txt', 'w').write(txt)
print('driver done; tui.txt', len(txt), 'chars')
