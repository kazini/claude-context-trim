# Selective Context Trim
> [!NOTE]
> <sub>This project was developed with Agentic LLM assistance. Its planning, specifications, criteria, and systems-design were directed, in detail, by a human developer. Most of the code was written by an LLM and has not been fully reviewed by a human developer, despite passing test validations; it is *not* up to production standards. You have been warned!</sub>

<sub>Claude Code mod, requires 2.1.287+</sub>

Long Claude Code sessions accumulate file dumps and tool usage that, after a point or depending on the selective use, end up without use and accumulating context. Some tools clear these without regard, and the auto-compactor often means docs have to be re-read.

This tool was made mainly for unattended sessions, letting the agent rewrite its own history or flag it for trimming, and it conservatively auto-flags certain elements in the session that can be consolidated to a newer version or that can be cleared: a file read again after edits, a command re-run, the same section twice; The old copy gets replaced by a short pointer to the newer one.

Overall, this should help for token savings and information retention over long sessions before the autocompaction is triggered, especially in cases where documents and files are loaded often.


### Install
Try it once: `claude --plugin-dir /path/to/selective-context-trim/selective-context-trim`

For the **manual install**, download the release zip, extract it, and run `install_manual.py` from the extracted `selective-context-trim` folder. It installs the plugin as a custom marketplace addition. Default scope is `user`; pass `--scope project` or `--scope local` from the project where you want it. Needs Python 3.9+ and Claude Code on PATH.

> **[PENDING]** To install from the Claude community plugin directory instead, open the Selective Context Trim listing on claude.ai and turn it on there; Claude Code syncs it as `selective-context-trim@synced`. Choose one install path, not both. <sub>*(This is pending me getting a paid membership for Claude and submitting it, then receiving approval)*</sub>

By default the plugin pre-approves its own two tools so an unattended run never stalls on a permission prompt. Turn `autoAllowTools` off if you’d rather use your normal allow rules.


## How it works:
It accumulates trim requests on a queue, and applies them once the accumulated saved tokens exceed the cache savings for the modified section onwards, aware of cache hit points. If the cache goes cold, it auto-applies all pending trims. Agents can use a `force: true` mode on the tool to make that and the accumulated edits go through either way, but get warned and stay pending if it would break cache economics.

- **`inspect_session`** — Shows what’s taking up space, roughly what each result costs, and what looks worth trimming.
- **`trim_session`** — Manually flag something for trimming. A flag can turn the result into a **stub**, replace it with a one-line **summary**, or **delete** it outright.

<details>
<summary><i>More details on how the tool works.</i></summary>
Flagging is free, and by default it waits. Nothing is written just because the agent flagged something. The automatic trimmer applies the flags when it’s actually worth the trim. `force: true` is the explicit “do it now” for a change the agent considers significant: it queues the trim for the end of that turn, reloads, and carries on using the agent’s `session_note`. Using `force` won’t push a set that would re-process more than it saves.

By default the tool just says `Flagged… pending` and lets the agent keep working. Re-flagging something that’s already flagged silently replaces that flag with no second flag and no message at all. `trim_session { "list": true }` shows what’s waiting and why; `unflag` cancels by flag id or `tool_use_id`. After large tool results, hints include the `tool_use_id` so the agent knows what it can flag. Those are controlled by `nudges` and `nudgeTokens`.

Example:
```jsonc
{
  "tool_targets": [
    { "id": "toolu_01", "mode": "stub" },
    { "id": "toolu_02", "mode": "summary",
      "replacement": "verifyToken ignores expiry (l.88)." },
    { "id": "toolu_03", "mode": "delete" }
  ],
  "regex_rules": [
    { "pattern": "(?:DEBUG[^\\n]*\\n)+",
      "scope_tool_ids": ["toolu_04"], "mode": "delete" }
  ],
  "session_note": "Agent pruned context: success"
}
```

A stub reads like `[Trimmed: 142 lines / 3,420 chars removed from Read(src/auth.ts) (toolu_01…)]`; a summary reads `[Trimmed — Summary: …]`. Regex rules run only on decoded result text. Pin them with `scope_tool_ids` if you want them to wait safely; unscoped rules can only run immediately. Patterns can’t match the empty string, can’t be longer than 400 characters, refusing aggressive ones like `(a+)+`.
</details>

<details>
<summary><h3><strong>Details on Auto-Trimmer</strong></h3></summary>
When a newer result seems to supersede an older one, the older result becomes a pointer to the newer one; The newer copy always wins.

- Only tool results are auto-flagged. User and agent messages are ignored.
- Same file or command: about 60% overlap; a single section needs about 85%. Different sources need about 95%.
- Sections are cut at natural boundaries and matched as a set, so moved lines still count. Line numbers and boilerplate prove nothing.
- Older `inspect_session` and `trim_session` results are deleted outright; the newest one stays readable. This happens regardless of `autoFlag`.
- A significant-yet-uncertain overlap gets one heads-up notice per session; `inspect_session` lists them too, and `unflag` vetoes that flag for good.

The stale-copy knobs are `autoFlag` (on by default) and `similarity` (0.95). Raise `similarity` if you prefer to err even further on the side of caution.
</details>

<details>
<summary><h3><strong>Details on Safety & Cache-hit detection</strong></h3></summary>
An edit invalidates the prompt cache from that point forward. Within about 20 content blocks (`lookbackBlocks`), only the tail is reprocessed; otherwise the whole conversation is. Cache entries live 5 minutes or 1 hour depending on the model.

A set of flags is applied when it saves enough, pays off over the next requests, forms a deliberate batch of 3+ items, or the cache is already cold. `minSavingsTokens` (3,000) filters tiny sets; `sizeableTokens` (20k) relaxes the recompute test. Pass `expected_remaining_requests` for one call, or set `assumedRemainingRequests` if your runs are usually long. Flags are considered newest first, so an old deep flag never blocks a recent one.

- Nothing is written while a turn is running. The rewrite happens after the last tool result is on disk.
- One backup, `<sessionId>.jsonl_trim-backup`, is overwritten by each trim. Backup and rewrite both use a temp file plus rename, and the transcript keeps its `0600` mode.
- Thinking blocks are stripped from the first change onward, empty lines are removed, and the `parentUuid` chain is relinked. Tool-use/tool-result pairs are checked before anything is written; if the check fails, nothing changes.
- The newest flagging call collapses to its `session_note`; older settled flagging calls are dropped. Clearing them never moves the rewrite point earlier.
- Reload uses `/resume <id>` and is verified by reading back what the engine holds. If it doesn’t take, the plugin tries `/clear` + `/resume`. If it errors or hangs past `resumeTimeoutMs` (5 s), the backup is restored and both you and the agent are told. `autoContinue` controls the follow-up prompt; `/trim-restore` puts the backup back byte-for-byte.
- A stub keeps no content, re-read the file if you need the exact text. The `toolUseResult` metadata is left as is; it isn’t sent to the model.
- On very large transcripts, only the last ~3.5 MiB can be edited; older targets are refused, and large transcripts are declined on Windows. Subagent sessions are refused the tools.
- The transcript format belongs to Claude Code and may change. Unknown record types are passed through untouched. Checked on Claude Code 2.1.318; other versions and Windows are untested.
</details>

### Privacy

Selective Context Trim runs entirely on your machine. It reads and rewrites the local Claude Code transcript for the active session, writes one `<sessionId>.jsonl_trim-backup` before a trim, and reloads the session after a successful rewrite. It makes no network requests, sends no transcript content anywhere, stores no credentials, and keeps no user data beyond that local backup. The backup is overwritten by the next trim; `/trim-restore` restores from it.

---

### Folder structure and testing
`selective-context-trim/` is the plugin/mod; `_devwork/` is for testing and development. `_devwork/package_plugin.py` runs the tests and bundles the plugin in a zip. Run tests with `node --test _devwork/tests/*.spec.ts` (Node ≥ 22.18). `_devwork/_scripts/restore.sh` and `clean.sh` manage the dev-only tooling and plugin `.gitignore`.

#### License
MIT, see [LICENSE](LICENSE).