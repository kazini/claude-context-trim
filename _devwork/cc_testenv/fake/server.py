#!/usr/bin/env python3
"""Fake Anthropic Messages API for testing the selective-context-trim mod.

- Scripted agent: reads files, calls inspect_session, then trim_session with the ids the
  mod itself recommended (parsed out of inspect_session's own output).
- Logs every request body to reqs/NNN.json plus a one-line summary to api.log.
- Simulates prompt-cache accounting from the cache_control markers Claude Code ACTUALLY sends,
  using the documented semantics (entry per breakpoint prefix hash, 20-block lookback).
"""
import json, hashlib, re, sys, time, threading, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__)) + "/.."
LOCK = threading.Lock()
def make_dup_fixture():
    """work/dup.txt: ~300 distinct lines, every 10th carrying `marker-A` (the scenario edits those)."""
    import zlib
    rows = ["row %04d: record for item %d status=pending marker-%s checksum=%08x" % (i, i * 7, "A" if i % 10 == 3 else "C", zlib.crc32(b"dup%d" % i)) for i in range(300)]
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "work", "dup.txt"), "w").write("\n".join(rows) + "\n")

STATE = {"n": 0, "cache": set(), "mode": os.environ.get("FAKE_MODE", "happy")}
if STATE["mode"] in ("dupes", "nim"): make_dup_fixture()
CPT = 3.5  # chars per token for the simulation
TRIM = "mcp__selective-context-trim__trim_session"
INSPECT = "mcp__selective-context-trim__inspect_session"

def _nocc(b):
    """The block as the cache sees it: the cache_control marker is not part of the content."""
    return {k: v for k, v in b.items() if k != "cache_control"}

def flat_blocks(req):
    """Every block of the prompt in order, with its cache_control flag: tools, system, messages."""
    out = []
    for t in req.get("tools") or []:
        out.append((json.dumps(_nocc(t), sort_keys=True), bool(t.get("cache_control"))))
    sysv = req.get("system")
    if isinstance(sysv, str):
        out.append((sysv, False))
    elif isinstance(sysv, list):
        for b in sysv:
            out.append((json.dumps(_nocc(b), sort_keys=True), bool(b.get("cache_control"))))
    for m in req.get("messages", []):
        c = m.get("content")
        if isinstance(c, str):  # a string and a single text block are the same prompt content
            out.append((m["role"] + ":" + json.dumps({"type": "text", "text": c}, sort_keys=True), False))
        else:
            for b in c:
                out.append((m["role"] + ":" + json.dumps(_nocc(b), sort_keys=True), bool(b.get("cache_control"))))
    return out

def simulate_cache(req):
    blocks = flat_blocks(req)
    h = hashlib.sha256(); hashes = []; cum = []; tot = 0
    for s, _ in blocks:
        h.update(s.encode()); hashes.append(h.copy().hexdigest()); tot += len(s); cum.append(tot)
    bps = [i for i, (_, cc) in enumerate(blocks) if cc]
    read_idx = -1
    for bp in bps:  # each breakpoint checks itself and up to 19 blocks before it
        for i in range(bp, max(-1, bp - 20), -1):
            if hashes[i] in STATE["cache"]:
                read_idx = max(read_idx, i); break
    last_bp = bps[-1] if bps else -1
    read = int(cum[read_idx] / CPT) if read_idx >= 0 else 0
    upto = int(cum[last_bp] / CPT) if last_bp >= 0 else 0
    for bp in bps: STATE["cache"].add(hashes[bp])
    return {"input_tokens": max(0, int(tot / CPT) - upto), "cache_read_input_tokens": read,
            "cache_creation_input_tokens": max(0, upto - read)}, {"blocks": len(blocks), "breakpoints": bps, "read_idx": read_idx}

def text_of(c):
    if isinstance(c, str): return c
    return "\n".join((b.get("text") or "") if b.get("type") == "text" else
                     (text_of(b.get("content")) if b.get("type") == "tool_result" else "") for b in c)

def last_user(req):
    for m in reversed(req.get("messages", [])):
        if m["role"] == "user": return m
    return None

def tool_use(id_, name, inp): return {"type": "tool_use", "id": id_, "name": name, "input": inp}
def text(t): return {"type": "text", "text": t}

def decide(req):
    """Return (stage, content_blocks, stop_reason)."""
    lu = last_user(req)
    if lu is None: return "none", [text("ok")], "end_turn"
    c = lu["content"]
    results = [b for b in c if isinstance(c, list) and b.get("type") == "tool_result"] if isinstance(c, list) else []
    if results:
        r = results[-1]; tid = r["tool_use_id"]; body = text_of(r.get("content"))
        if tid == "toolu_dp_read1":  # dupes: read, edit ~10% of the lines, read again, stop
            return "d-edit", [tool_use("toolu_dp_edit1", "Edit", {"file_path": ROOT + "/work/dup.txt", "old_string": "marker-A", "new_string": "marker-B", "replace_all": True})], "tool_use"
        if tid == "toolu_dp_edit1":
            return "d-read2", [tool_use("toolu_dp_read2", "Read", {"file_path": ROOT + "/work/dup.txt"})], "tool_use"
        if tid == "toolu_dp_read2":
            return "d-done", [text("Re-read the edited file; that is all for now.")], "end_turn"
        m = re.match(r"toolu_fk_read(\d+)$", tid)
        if m:
            k, N, pre = int(m.group(1)), (28 if STATE["mode"] == "large" else 3), ("L" if STATE["mode"] == "large" else "big")
            if k < N:
                return "read%d" % (k + 1), [tool_use("toolu_fk_read%d" % (k + 1), "Read", {"file_path": "%s/work/%s%d.txt" % (ROOT, pre, k + 1)})], "tool_use"
            if STATE["mode"] == "cold":
                return "flag", [text("Read all three. The first is spent (nothing I need); flagging it for trimming."),
                                tool_use("toolu_fk_trim", TRIM, {"tool_targets": [{"id": "toolu_fk_read1"}]})], "tool_use"
            return "inspect", [text("I have what I need from those files; checking what is worth trimming."),
                               tool_use("toolu_fk_inspect", INSPECT, {})], "tool_use"
        if tid == "toolu_fk_inspect":
            ids = re.findall(r"^★ (toolu_\w+)", body, re.M)
            args = {"tool_targets": [{"id": i} for i in ids]} if ids else {"tool_targets": [{"id": "toolu_fk_read3"}], "force": True}
            if STATE["mode"] == "large":  # a deliberate batch: the newest 20 reads, with a stated horizon
                args = {"tool_targets": [{"id": "toolu_fk_read%d" % k} for k in range(9, 29)], "expected_remaining_requests": 40}
            if STATE["mode"] == "regexonly":
                args = {"regex_rules": [{"pattern": "alpha beta gamma", "mode": "delete"}]}
            return "trim", [tool_use("toolu_fk_trim", TRIM, args)], "tool_use"
        if tid == "toolu_fk2_read1":
            return "r2-read2", [tool_use("toolu_fk2_read2", "Read", {"file_path": ROOT + "/work/L2.txt"})], "tool_use"
        if tid == "toolu_fk2_read2":
            return "r2-inspect", [text("Two more files read; checking again."), tool_use("toolu_fk2_inspect", INSPECT, {})], "tool_use"
        if tid == "toolu_fk2_inspect":
            return "r2-trim", [tool_use("toolu_fk2_trim", TRIM, {"tool_targets": [{"id": "toolu_fk2_read1"}, {"id": "toolu_fk2_read2"}], "expected_remaining_requests": 40, "force": True})], "tool_use"
        if tid == "toolu_fk2_trim":
            return "after-trim2", [text("Second trim queued.")], "end_turn"
        if tid == "toolu_fk_edit1":
            return "edit-result", [text("Edit attempted.")], "end_turn"
        if tid == "toolu_fk_trim":
            if STATE["mode"] == "cold":
                return "after-flag", [text("Flag recorded; carrying on. That is all for now.")], "end_turn"
            return "after-trim", [text("Trim queued.")], "end_turn"
        return "other-result", [text("ok")], "end_turn"
    # only the LAST text block counts: earlier blocks are system reminders / loaded project files
    t = (c if isinstance(c, str) else next((b.get("text", "") for b in reversed(c) if b.get("type") == "text"), ""))
    if "success. Continue with your task" in t:
        if STATE["mode"] == "twice":
            if "toolu_fk2_trim" in json.dumps(req):
                return "continued2", [text("Second continuation: all good.")], "end_turn"
            return "continued", [tool_use("toolu_fk2_read1", "Read", {"file_path": ROOT + "/work/L1.txt"})], "tool_use"
        if STATE["mode"] == "edit":  # try to Edit a file whose Read was just trimmed
            return "continued", [tool_use("toolu_fk_edit1", "Edit", {"file_path": ROOT + "/work/big3.txt", "old_string": "file3", "new_string": "FILE3", "replace_all": True})], "tool_use"
        return "continued", [text("Continuing after the trim: all good.")], "end_turn"
    if "failed to resume" in t or "Session trim aborted" in t or "made no changes" in t:
        return "notified", [text("Understood; carrying on without the trim.")], "end_turn"
    if t.strip() == "NEXT":
        return "next", [text("Noted.")], "end_turn"
    if "START JOB" in t and STATE["mode"] == "dupes":
        return "d-read1", [tool_use("toolu_dp_read1", "Read", {"file_path": ROOT + "/work/dup.txt"})], "tool_use"
    if "START JOB" in t:
        return "read1", [tool_use("toolu_fk_read1", "Read", {"file_path": ROOT + "/work/" + ("L1" if STATE["mode"] == "large" else "big1") + ".txt"})], "tool_use"
    return "chat", [text("Hello from the fake model.")], "end_turn"

# ── nim mode: a REAL model behind the fake provider ───────────────────────────────────────────────
# Claude Code (the real TUI + the real plugin) talks Anthropic Messages to this server; for the main
# thread the request is translated to an OpenAI chat call to NVIDIA NIM and the answer translated back.
# The key is read from <repo>/_devwork/.apikeys (NVIDIA_NIM_KEY) here and nowhere else: it is never put in the
# environment, the logs or the captured requests. Model: NIM_MODEL (default minimaxai/minimax-m3.1-flash).
NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
NIM_KEEP = {"Read", "Edit"}  # keep the prompt small: the plugin's own tools are always kept
NIM_SYSTEM = ("You are a careful coding agent working in a project directory. Use the provided tools to do what the user asks, "
              "one step at a time, and keep your own text short. When the task is complete, reply with one short sentence.")
NIM_CALLS = {"n": 0}

def nim_key():
    p = os.path.join(ROOT, "..", ".apikeys")  # <repo>/_devwork/.apikeys
    if not os.path.exists(p): raise RuntimeError("_devwork/.apikeys is missing (copy _devwork/.apikeys.example and fill in NVIDIA_NIM_KEY)")
    for line in open(p):
        m = re.match(r"^\s*(?:export\s+)?NVIDIA_NIM_KEY\s*=\s*(.*?)\s*$", line)
        if m: return m.group(1).strip("\"'")
    raise RuntimeError("NVIDIA_NIM_KEY not found in _devwork/.apikeys (copy _devwork/.apikeys.example)")

def nim_messages(req):
    out = [{"role": "system", "content": NIM_SYSTEM}]
    for m in req.get("messages", []):
        c = m["content"]
        if isinstance(c, str):
            out.append({"role": m["role"], "content": c}); continue
        if m["role"] == "assistant":
            txt = "".join(b.get("text", "") for b in c if b.get("type") == "text")
            calls = [{"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": json.dumps(b.get("input", {}))}}
                     for b in c if b.get("type") == "tool_use"]
            msg = {"role": "assistant", "content": txt or None}
            if calls: msg["tool_calls"] = calls
            if txt or calls: out.append(msg)
        else:
            for b in c:
                if b.get("type") == "tool_result":
                    out.append({"role": "tool", "tool_call_id": b["tool_use_id"], "content": text_of(b.get("content")) or "(empty)"})
            txt = "\n".join(b.get("text", "") for b in c if b.get("type") == "text")
            if txt.strip(): out.append({"role": "user", "content": txt})
    return out

def nim_tools(req):
    tools = []
    for t in req.get("tools", []):
        n = t.get("name", "")
        if n in NIM_KEEP or n.startswith("mcp__selective-context-trim__"):
            tools.append({"type": "function", "function": {"name": n, "description": t.get("description", "")[:6000], "parameters": t.get("input_schema", {"type": "object"})}})
    return tools

def nim_decide(req):
    import urllib.request, urllib.error, time
    NIM_CALLS["n"] += 1
    if NIM_CALLS["n"] > 45: return "nim-final", [text("Stopping: too many requests in this test.")], "end_turn"
    body = {"model": os.environ.get("NIM_MODEL", "minimaxai/minimax-m3.1-flash"), "messages": nim_messages(req), "tools": nim_tools(req),
            "tool_choice": "auto", "max_tokens": 3000, "temperature": 0.2}
    data = json.dumps(body).encode()
    last = None
    for attempt in range(5):
        try:
            rq = urllib.request.Request(NIM_URL, data, {"Content-Type": "application/json", "Authorization": "Bearer " + nim_key(), "Accept": "application/json"})
            with urllib.request.urlopen(rq, timeout=120) as r: j = json.load(r)
            break
        except urllib.error.HTTPError as e: last = "http %s %s" % (e.code, e.read().decode()[:160]); time.sleep(2 + attempt * 2)
        except Exception as e: last = str(e)[:160]; time.sleep(2 + attempt * 2)
    else:
        return "nim-final", [text("NIM request failed: %s" % last)], "end_turn"
    msg = (j.get("choices") or [{}])[0].get("message", {})
    content = re.sub(r"<think>.*?</think>", "", msg.get("content") or "", flags=re.S).strip()
    blocks = [text(content)] if content else []
    for k, tc in enumerate(msg.get("tool_calls") or []):
        f = tc.get("function", {})
        try: args = json.loads(f.get("arguments") or "{}")
        except Exception: args = {}
        blocks.append(tool_use("toolu_nim_%d_%d" % (NIM_CALLS["n"], k), f.get("name", ""), args))
    if not blocks: blocks = [text("(the model returned nothing)")]
    calls = any(b["type"] == "tool_use" for b in blocks)
    return ("nim-tool" if calls else "nim-final"), blocks, ("tool_use" if calls else "end_turn")

def sse(ev, data): return ("event: %s\ndata: %s\n\n" % (ev, json.dumps(data))).encode()


RELAY = ROOT + "/relay"

def _short(t, n):
    t = t if isinstance(t, str) else json.dumps(t)
    return t if len(t) <= n else t[:n] + "…[+%d chars]" % (len(t) - n)

def build_digest(req, no, usage, info):
    """What the model would see, readable: the last messages, tool results truncated except the mod's own."""
    names = {}
    for m in req.get("messages", []):
        c = m.get("content")
        if isinstance(c, list):
            for b in c:
                if b.get("type") == "tool_use": names[b["id"]] = b["name"]
    out = ["=== REQUEST #%d  msgs=%d blocks=%s  cache(sim): read=%s create=%s input=%s  breakpoints=%s ===" % (
        no, len(req.get("messages", [])), info.get("blocks"), usage["cache_read_input_tokens"], usage["cache_creation_input_tokens"], usage["input_tokens"], info.get("breakpoints"))]
    out.append("tools: " + ", ".join(t["name"] for t in req.get("tools", [])))
    msgs = req.get("messages", [])
    for i, m in enumerate(msgs):
        c = m.get("content"); c = [{"type": "text", "text": c}] if isinstance(c, str) else c
        for b in c:
            t = b.get("type")
            if t == "text":
                txt = b["text"]
                lim = 150 if txt.lstrip().startswith("<system-reminder>") or len(txt) > 3000 else 600
                out.append("#%d %s text: %s" % (i, m["role"], _short(txt, lim)))
            elif t == "tool_use":
                out.append("#%d %s TOOL_USE %s id=%s input=%s" % (i, m["role"], b["name"], b["id"], _short(json.dumps(b["input"]), 400)))
            elif t == "tool_result":
                x = b.get("content"); x = x if isinstance(x, str) else "\n".join(y.get("text", "") for y in x)
                own = "trimming" in names.get(b["tool_use_id"], "")
                out.append("#%d %s TOOL_RESULT id=%s (%s, %d chars): %s" % (i, m["role"], b["tool_use_id"], names.get(b["tool_use_id"], "?"), len(x), _short(x, 6000 if own else 700)))
    return "\n".join(out)

def relay_wait(req, no, usage, info):
    os.makedirs(RELAY, exist_ok=True)
    tmp = RELAY + "/pending_%d.tmp" % no
    open(tmp, "w").write(build_digest(req, no, usage, info)); os.rename(tmp, RELAY + "/pending_%d.txt" % no)
    resp = RELAY + "/response_%d.json" % no
    t0 = time.time()
    while time.time() - t0 < 900:
        if os.path.exists(resp):
            time.sleep(0.1)
            r = json.load(open(resp)); os.remove(resp)
            blocks = []
            for i, b in enumerate(r.get("blocks", [])):
                if b["type"] == "text": blocks.append(text(b["text"]))
                else: blocks.append(tool_use(b.get("id") or "toolu_rl%d_%d" % (no, i), b["name"], b["input"]))
            return "relay", blocks or [text("(empty reply)")], ("tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn")
        time.sleep(0.2)
    return "relay-timeout", [text("relay timeout")], "end_turn"

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._json(200, {"data": [], "has_more": False})
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try: req = json.loads(raw)
        except Exception: req = {}
        path = self.path.split("?")[0]
        if path.endswith("/count_tokens"):
            return self._json(200, {"input_tokens": int(len(raw) / CPT)})
        if not path.endswith("/messages"):
            return self._json(200, {})
        main = any((t.get("name") == "Bash") for t in (req.get("tools") or []))
        with LOCK:
            STATE["n"] += 1; no = STATE["n"]
            if main: usage, info = simulate_cache(req)
            else: usage, info = {"input_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}, {}
            open("%s/reqs/%03d.json" % (ROOT, no), "w").write(json.dumps(req))
        if not main: stage, blocks, stop = "aux", [text('{"title":"Trim test"}')], "end_turn"
        elif STATE["mode"] == "relay": stage, blocks, stop = relay_wait(req, no, usage, info)
        elif STATE["mode"] == "nim": stage, blocks, stop = nim_decide(req)
        else:
            with LOCK: stage, blocks, stop = decide(req)
        with LOCK:
            body = json.dumps(req)
            line = {"n": no, "main": main, "model": req.get("model"), "stage": stage, "msgs": len(req.get("messages", [])),
                    "usage": usage, **info, "has_trimmed_marker": "chars removed from" in body,
                    "big_in_body": body.count("alpha beta gamma"), "idle_notice": "While you were idle" in body}
            open(ROOT + "/api.log", "a").write(json.dumps(line) + "\n")
        mid = "msg_fake_%d" % no
        if not req.get("stream"):
            return self._json(200, {"id": mid, "type": "message", "role": "assistant", "model": req.get("model", "fake"),
                                    "content": blocks, "stop_reason": stop, "stop_sequence": None,
                                    "usage": {**usage, "output_tokens": 20}})
        self.send_response(200)
        for k, v in (("content-type", "text/event-stream"), ("cache-control", "no-cache"), ("transfer-encoding", "chunked")):
            self.send_header(k, v)
        self.end_headers()
        def w(b):
            self.wfile.write(("%x\r\n" % len(b)).encode() + b + b"\r\n"); self.wfile.flush()
        w(sse("message_start", {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant",
            "model": req.get("model", "fake"), "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {**usage, "output_tokens": 1}}}))
        for i, b in enumerate(blocks):
            if b["type"] == "text":
                w(sse("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}))
                w(sse("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": b["text"]}}))
            else:
                w(sse("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}}}))
                w(sse("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(b["input"])}}))
            w(sse("content_block_stop", {"type": "content_block_stop", "index": i}))
        w(sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 20}}))
        w(sse("message_stop", {"type": "message_stop"}))
        w(b"")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
