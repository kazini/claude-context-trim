"""What happened in the last live run: request stages, then the session transcript as the model's tool calls and results.
   python3 show.py [width]      (run after a scenario; reads api.log and claude-config/projects/*/*.jsonl)"""
import glob, json, os, sys

T = os.path.dirname(os.path.abspath(__file__))
W = int(sys.argv[1]) if len(sys.argv) > 1 else 240

def short(s, n=W): return s.replace("\n", " ")[:n]

print("stages:", [(o["stage"], o["msgs"]) for o in (json.loads(l) for l in open(os.path.join(T, "api.log")) if l.strip())])
files = glob.glob(os.path.join(T, "claude-config/projects/*/*.jsonl"))
if not files: sys.exit("no session transcript found")
for line in open(files[0]):
    try: o = json.loads(line)
    except Exception: continue
    c = (o.get("message") or {}).get("content"); who = o.get("type")
    if isinstance(c, str) and who == "user": print("USER:", short(c))
    if not isinstance(c, list): continue
    for b in c:
        if not isinstance(b, dict): continue
        if b.get("type") == "text": print(("ASSISTANT:" if who == "assistant" else "USER(text):"), short(b["text"]))
        if b.get("type") == "tool_use": print("CALL", b["name"].split("__")[-1], short(json.dumps(b.get("input")), W))
        if b.get("type") == "tool_result":
            cc = b.get("content"); s = cc if isinstance(cc, str) else json.dumps(cc)
            print("  RESULT", b["tool_use_id"][-10:], len(s), repr(s[:W]))
