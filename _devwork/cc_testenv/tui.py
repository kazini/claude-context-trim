#!/usr/bin/env python3
"""Persistent Claude Code TUI in a pty.   tui.py start | send TEXT | raw ESCAPED | tail [N] | stop"""
import os, sys, pty, time, json, select, re, fcntl, termios, struct, signal
T = os.environ['T']; CMD = T + '/tui.cmd'; RAW = T + '/tui.raw'
ANSI = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]')
def daemon():
    env = dict(os.environ, TERM='xterm-256color', COLUMNS='170', LINES='50')
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(T + '/work'); os.execvpe('claude', ['claude', '--plugin-dir', os.environ['PLUGIN'], '--model', 'claude-sonnet-5-5'] + os.environ.get('TUI_ARGS', '--permission-mode default').split(), env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 170, 0, 0))
    open(T + '/tui.pid', 'w').write(str(pid)); open(CMD, 'w').close()
    log = open(RAW, 'wb'); off = 0
    while True:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: break
            if not d: break
            log.write(d); log.flush()
        lines = open(CMD).read().splitlines()
        for l in lines[off:]:
            c = json.loads(l)
            if c['k'] == 'send': os.write(fd, c['v'].encode()); time.sleep(0.5); os.write(fd, b'\r')
            elif c['k'] == 'raw': os.write(fd, c['v'].encode().decode('unicode_escape').encode())
            elif c['k'] == 'stop':
                try: os.write(fd, b'\x03'); time.sleep(0.4); os.write(fd, b'\x03'); time.sleep(0.8); os.kill(pid, signal.SIGTERM)
                except Exception: pass
                return
        off = len(lines)
def tail(n):
    t = ANSI.sub(b'', open(RAW, 'rb').read()).decode('utf8', 'replace'); t = re.sub(r'[ \t]+', ' ', t); t = re.sub(r'\n\s*\n+', '\n', t)
    print(t[-n:])
a = sys.argv[1:]
if a[0] == 'daemon': daemon()
elif a[0] == 'start': os.system('(nohup python3 %s daemon > %s/tui.out 2>&1 &)' % (os.path.abspath(__file__), T)); time.sleep(6); print('tui started')
elif a[0] in ('send', 'raw'): open(CMD, 'a').write(json.dumps({'k': a[0], 'v': a[1]}) + '\n')
elif a[0] == 'tail': tail(int(a[1]) if len(a) > 1 else 2500)
elif a[0] == 'stop': open(CMD, 'a').write(json.dumps({'k': 'stop'}) + '\n')
