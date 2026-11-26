#!/bin/bash
# stop every test process of this project (patterns split so this script never matches itself)
for pat in "tui.py daemon" "fake/server.py" "plugin-dir"; do
  for pid in $(ps -eo pid,args | grep -F "$pat" | grep -v grep | awk '{print $1}'); do kill "$pid" 2>/dev/null; done
done
sleep 0.5; exit 0
