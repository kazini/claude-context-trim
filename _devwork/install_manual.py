#!/usr/bin/env python3
"""Manual installer for Selective Context Trim, shipped only in the release zip.

Run from the extracted selective-context-trim release folder:
  python3 install_manual.py [--scope user|project|local]

This script is not part of the directory plugin folder. For the Claude community
directory, turn the plugin on at claude.ai instead; Claude Code syncs it as
selective-context-trim@synced.

What it does
  1. Checks that Claude Code is new enough (2.1.292+; the shell form of
     `--marketplace` needs it).
  2. Runs `claude plugin install selective-context-trim --marketplace
     <marketplace.json URL>`, which registers the hosted marketplace and installs
     the plugin in one step. With --no-install it only runs
     `claude plugin marketplace add <marketplace.json URL> --scope user`.
  3. Sets extraKnownMarketplaces.kazini-context-trim.autoUpdate in user settings.
     The marketplace is always declared in user settings; --scope chooses where
     the plugin itself is enabled.

For --scope project or --scope local, run the script from the project where you
want the plugin. Only the Python standard library is needed. Claude Code must be
on PATH.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

MARKETPLACE = "kazini-context-trim"
MARKETPLACE_URL = "https://raw.githubusercontent.com/kazini/claude-context-trim/main/marketplace.json"
PLUGIN = "selective-context-trim"
PLUGIN_ID = f"{PLUGIN}@{MARKETPLACE}"
SOURCE = {"source": "url", "url": MARKETPLACE_URL}
MIN_CLAUDE = (2, 1, 292)  # shell `plugin install --marketplace` requires this


class InstallError(Exception):
    pass


def config_dir() -> Path:
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(override).expanduser() if override else Path.home() / ".claude"


def settings_path() -> Path:
    # `plugin install --marketplace` always declares the marketplace in user settings.
    return config_dir() / "settings.json"


def load_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except OSError as e:
        raise InstallError(f"could not read {path}: {e}") from e
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise InstallError(f"{path} is not valid JSON ({e}); fix it before running this script.") from e
    if not isinstance(data, dict):
        raise InstallError(f"{path} must contain a JSON object, not {type(data).__name__}.")
    return data


def write_settings(path: Path, settings: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    data = json.dumps(settings, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def find_claude() -> str:
    exe = shutil.which("claude")
    if not exe:
        raise InstallError("`claude` was not found on PATH. Install Claude Code, then re-run this script.")
    return exe


def check_version(exe: str) -> str:
    proc = subprocess.run([exe, "--version"], capture_output=True, text=True)
    out = (proc.stdout + proc.stderr).strip()
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", out)
    if not m:
        raise InstallError(f"could not parse Claude Code version from {out!r}.")
    version = tuple(int(x) for x in m.groups())
    if version < MIN_CLAUDE:
        need = ".".join(map(str, MIN_CLAUDE))
        raise InstallError(f"Claude Code {out} is too old for this installer; need >= {need}.")
    return out


def json_output(exe: str, args: list[str]) -> list:
    proc = subprocess.run([exe, *args], capture_output=True, text=True, cwd=Path.cwd())
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise InstallError(f"`claude {' '.join(args)}` failed: {detail}")
    text = (proc.stdout + "\n" + proc.stderr).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Tolerate any non-JSON chatter around the JSON array.
        start, end = text.find("["), text.rfind("]")
        if start < 0 or end <= start:
            raise InstallError(f"`claude {' '.join(args)}` did not return a JSON list.")
        try:
            data = json.loads(text[start:end + 1])
        except json.JSONDecodeError as e:
            raise InstallError(f"`claude {' '.join(args)}` returned malformed JSON: {e}")
    if not isinstance(data, list):
        raise InstallError(f"`claude {' '.join(args)}` did not return a JSON list.")
    return data


def marketplace_state(exe: str) -> dict:
    items = json_output(exe, ["plugin", "marketplace", "list", "--json"])
    return {item.get("name"): item for item in items if isinstance(item, dict)}


def marketplace_matches(entry: dict) -> bool:
    return entry.get("source") == "url" and entry.get("url") == MARKETPLACE_URL


def run_claude(exe: str, args: list[str]) -> None:
    print(f"      $ {exe} {' '.join(args)}", flush=True)
    proc = subprocess.run([exe, *args], cwd=Path.cwd())
    if proc.returncode != 0:
        raise InstallError(f"`claude {' '.join(args)}` failed with exit code {proc.returncode}.")


def resolve_conflict(exe: str, *, force: bool) -> bool:
    entry = marketplace_state(exe).get(MARKETPLACE)
    if not entry or marketplace_matches(entry):
        return False
    parts = [f"source={entry.get('source')!r}"]
    for key in ("repo", "url"):
        if key in entry:
            parts.append(f"{key}={entry.get(key)!r}")
    desc = ", ".join(parts)
    if not force:
        raise InstallError(
            f"marketplace {MARKETPLACE} already points somewhere else ({desc}). "
            f"Remove it with `claude plugin marketplace remove {MARKETPLACE}` first, or pass --force."
        )
    print(f"      replacing existing marketplace {MARKETPLACE} ({desc})", flush=True)
    run_claude(exe, ["plugin", "marketplace", "remove", MARKETPLACE])
    return True


def register_or_install(exe: str, scope: str, *, no_install: bool) -> None:
    if no_install:
        run_claude(exe, ["plugin", "marketplace", "add", MARKETPLACE_URL, "--scope", "user"])
        return
    # Adds the marketplace if needed, then installs. The marketplace is declared
    # in user settings even when the plugin scope is project or local.
    run_claude(exe, ["plugin", "install", PLUGIN, "--marketplace", MARKETPLACE_URL, "--scope", scope])


def configure_auto_update(path: Path, *, auto_update: bool) -> None:
    settings = load_settings(path)
    known = settings.get("extraKnownMarketplaces")
    if not isinstance(known, dict) or not isinstance(known.get(MARKETPLACE), dict):
        raise InstallError(
            f"marketplace {MARKETPLACE} was not declared in {path}; cannot enable auto-update."
        )
    known[MARKETPLACE]["source"] = dict(SOURCE)
    known[MARKETPLACE]["autoUpdate"] = auto_update
    write_settings(path, settings)


def verify_install(exe: str) -> None:
    installed = json_output(exe, ["plugin", "list", "--json"])
    if not any(item.get("id") == PLUGIN_ID for item in installed if isinstance(item, dict)):
        raise InstallError(f"{PLUGIN_ID} is not listed as installed after the command succeeded.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Install Selective Context Trim with auto-update from GitHub.")
    ap.add_argument("--scope", choices=("user", "project", "local"), default="user",
                    help="where to enable the plugin (default: user; project/local use the current directory)")
    ap.add_argument("--no-auto-update", action="store_true", help="register the marketplace without auto-update")
    ap.add_argument("--force", action="store_true", help="replace an existing marketplace entry pointing elsewhere")
    ap.add_argument("--no-install", action="store_true", help="only add the marketplace, do not install the plugin")
    ap.add_argument("--dry-run", action="store_true", help="show what would change without writing or installing")
    args = ap.parse_args()

    auto = not args.no_auto_update
    path = settings_path()

    try:
        if args.dry_run:
            print(f"[dry run] settings: {path} -> {MARKETPLACE}.autoUpdate = {str(auto).lower()}")
            if args.no_install:
                print(f"[dry run] $ claude plugin marketplace add {MARKETPLACE_URL} --scope user")
            else:
                print(f"[dry run] $ claude plugin install {PLUGIN} --marketplace {MARKETPLACE_URL} --scope {args.scope}")
            return 0

        exe = find_claude()
        version = check_version(exe)
        print(f"[1/3] claude: {version}", flush=True)

        print("[2/3] marketplace/plugin:", flush=True)
        resolve_conflict(exe, force=args.force)
        register_or_install(exe, args.scope, no_install=args.no_install)

        print("[3/3] auto-update:", flush=True)
        configure_auto_update(path, auto_update=auto)
        print(f"      {MARKETPLACE}.autoUpdate = {str(auto).lower()} in {path}", flush=True)

        if args.no_install:
            print("\nDone. marketplace added; plugin install skipped.")
        else:
            verify_install(exe)
            print("\nDone. Run /reload-plugins if you have a session open.")
        return 0
    except InstallError as e:
        print(f"\nINSTALL FAILED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
