#!/usr/bin/env python3
"""Package the Selective Context Trim plugin into a release zip.

Run from anywhere:  python3 _devwork/package_plugin.py [--skip-tests] [--flat] [--out PATH]

Repository layout this script relies on:
  selective-context-trim/   the plugin: .claude-plugin/, hooks/, tsconfig.json, README.md
                            and icon.png. The folder name IS the plugin name (checked
                            against the manifest).
  README.md, LICENSE       required at the repo root; BUNDLED into the zip as if they sat
                            inside the plugin folder. The root README.md replaces the
                            directory-facing plugin README.md there (any other LICENSE*
                            is bundled too).
  _devwork/install_manual.py  dev-only source, bundled into the zip as install_manual.py.
                            It is deliberately not in the directory plugin folder.
  _devwork/                 everything else here is dev only and never shipped: this
                            script, tests/, cc_testenv/, _scripts/

What it does
  1. Runs the test suite (node --test _devwork/tests/*.spec.ts) and aborts if anything fails.
  2. Collects the shipped files: the whitelist SHIP_PATHS from the plugin folder, the
     root-level README.md / LICENSE*, and the dev-only install_manual.py, leaving out
     anything regenerated or dev-only (including the plugin's .gitignore, see EXCLUDED_*).
  3. Checks the result: manifest present, folder name == manifest name, every hooks.json module
     present, every relative import inside the shipped code resolves to a shipped file (so the
     whitelist can never silently omit something the runtime needs).
  4. Writes <plugin-name>.zip to _devwork/dist/ by default (gitignored there; atomic: temp file + rename).

The GitHub release workflow (.github/workflows/pack-release.yml) calls this same script, so a
release zip and a local one are bundled identically (README, LICENSE, icon and install_manual.py included).
Standard library only; the test step needs Node >= 22.6 (>= 22.18 runs .ts natively).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "selective-context-trim"
TESTS_DIR = ROOT / "_devwork" / "tests"

# What the release contains from the plugin folder (relative to it, posix style): files, or
# directories walked recursively.
SHIP_PATHS = [
    ".claude-plugin/plugin.json",
    "hooks",
    "icon.png",
    "README.md",
    "tsconfig.json",
]
# Taken from the REPO ROOT and placed at the top of the plugin folder inside the zip.
ROOT_BUNDLE_REQUIRED = ["README.md", "LICENSE"]
ROOT_BUNDLE_GLOBS = ["LICENSE*"]
# Taken from _devwork and placed in the plugin folder inside the zip. The source
# stays out of the directory plugin folder on purpose.
DEV_BUNDLED = {"install_manual.py": ROOT / "_devwork" / "install_manual.py"}
ROOT_BUNDLED: dict[str, Path] = {}  # zip-relative name -> source file (filled by collect())


def src(rel: Path) -> Path:
    """Where a shipped path is read from."""
    return ROOT_BUNDLED.get(rel.as_posix(), PLUGIN_DIR / rel)


# Inside shipped directories: whole subtrees that never ship (relative path, posix style).
EXCLUDED_PATHS = {
    ".claude-plugin/types": "generated Claude Code type declarations",
}
# Matched on any path component, at any depth.
EXCLUDED_NAMES = {
    "node_modules": "node_modules (dev tooling)",
    ".git": "git metadata",
    ".gitignore": "git ignore rules (dev-only, recreated by restore.sh)",
    "__pycache__": "python caches",
    ".DS_Store": "OS junk",
}
EXCLUDED_SUFFIXES = (".pyc", ".jsonl_trim-backup", ".zip")

IMPORT_RE = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""")


class PackagingError(Exception):
    pass


def human(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def tree_size(path: Path) -> int:
    if path.is_symlink() or path.is_file():
        return 0 if path.is_symlink() else path.stat().st_size
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file() and not f.is_symlink())


# --------------------------------------------------------------------------- tests

def run_tests() -> None:
    node = shutil.which("node")
    if not node:
        raise PackagingError("node not found on PATH. Install Node >= 22.18 or pass --skip-tests.")
    ver = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    m = re.match(r"v(\d+)\.(\d+)", ver)
    if not m:
        raise PackagingError(f"could not parse node version {ver!r}")
    version = (int(m.group(1)), int(m.group(2)))
    flags: list[str] = []
    if version < (22, 6):
        raise PackagingError(f"node {ver} cannot run .ts tests; need >= 22.6 (>= 22.18 recommended).")
    if version < (22, 18):
        flags.append("--experimental-strip-types")

    specs = sorted(TESTS_DIR.glob("*.spec.ts"))
    if not specs:
        raise PackagingError(f"no *.spec.ts found under {TESTS_DIR}; refusing to package untested code.")

    print(f"[1/3] tests: node {ver}, {len(specs)} spec files ...", flush=True)
    proc = subprocess.run(
        [node, *flags, "--test", *map(str, specs)],
        cwd=ROOT, capture_output=True, text=True,
    )
    out = proc.stdout + "\n" + proc.stderr
    counts = {k: v for k, v in re.findall(r"^(?:#|ℹ)\s+(tests|pass|fail)\s+(\d+)", out, re.M)}
    if proc.returncode != 0:
        tail = "\n".join(out.strip().splitlines()[-40:])
        raise PackagingError(f"tests failed (exit {proc.returncode}). Last output:\n{tail}")
    if counts.get("tests") in (None, "0"):
        raise PackagingError("test runner reported no tests; refusing to package.")
    print(f"      ok: {counts.get('pass', '?')}/{counts.get('tests', '?')} passed")


# --------------------------------------------------------------------------- collect

def collect() -> tuple[list[Path], dict[str, int]]:
    """Return (files to ship as paths relative to PLUGIN_DIR, {reason: bytes left out})."""
    if not (PLUGIN_DIR / ".claude-plugin" / "plugin.json").is_file():
        raise PackagingError(f"not a plugin folder (no .claude-plugin/plugin.json): {PLUGIN_DIR}")
    included: set[Path] = set()
    skipped: dict[str, int] = {}

    def skip(reason: str, path: Path) -> None:
        skipped[reason] = skipped.get(reason, 0) + tree_size(path)

    def add_file(rel: Path) -> None:
        p = PLUGIN_DIR / rel
        if rel.name in EXCLUDED_NAMES:
            skip(EXCLUDED_NAMES[rel.name], p)
        elif rel.name.endswith(EXCLUDED_SUFFIXES):
            skip(f"*{rel.suffix} files", p)
        elif p.is_symlink():
            skip(f"symlink {rel.as_posix()} (not followed)", p)
        else:
            included.add(rel)

    def add_dir(rel_dir: Path) -> None:
        for dirpath, dirnames, filenames in os.walk(PLUGIN_DIR / rel_dir, followlinks=False):
            here = Path(dirpath)
            rel_here = here.relative_to(PLUGIN_DIR)
            keep = []
            for d in sorted(dirnames):
                rel = (rel_here / d).as_posix()
                if rel in EXCLUDED_PATHS:
                    skip(EXCLUDED_PATHS[rel], here / d)
                elif d in EXCLUDED_NAMES:
                    skip(EXCLUDED_NAMES[d], here / d)
                elif (here / d).is_symlink():
                    skip(f"symlink {rel} (not followed)", here / d)
                else:
                    keep.append(d)
            dirnames[:] = keep
            for f in sorted(filenames):
                add_file(rel_here / f)

    wanted = [PLUGIN_DIR / Path(rel) for rel in SHIP_PATHS]
    for path in wanted:
        rel = path.relative_to(PLUGIN_DIR)
        if path.is_dir() and not path.is_symlink():
            add_dir(rel)
        elif path.is_file():
            add_file(rel)
        elif rel.as_posix() in SHIP_PATHS:
            raise PackagingError(f"expected release file is missing: {rel.as_posix()}")
    ROOT_BUNDLED.clear()
    for name, source in DEV_BUNDLED.items():
        if not source.is_file():
            raise PackagingError(f"{source} is missing; it is bundled into every release")
        ROOT_BUNDLED[name] = source
    for name in ROOT_BUNDLE_REQUIRED:
        if not (ROOT / name).is_file():
            raise PackagingError(f"{name} is missing at the repo root ({ROOT}); it is bundled into every release")
        ROOT_BUNDLED[name] = ROOT / name
    for pattern in ROOT_BUNDLE_GLOBS:
        for f in sorted(ROOT.glob(pattern)):
            if f.is_file():
                ROOT_BUNDLED[f.name] = f
    included.update(Path(n) for n in ROOT_BUNDLED)
    return sorted(included), skipped


# --------------------------------------------------------------------------- verify

def verify_sources(files: list[Path]) -> tuple[str, str]:
    """Check the file set is a working plugin. Returns (name, version or '')."""
    shipped = {f.as_posix() for f in files}

    manifest_rel = ".claude-plugin/plugin.json"
    if manifest_rel not in shipped:
        raise PackagingError(f"{manifest_rel} missing")
    try:
        manifest = json.loads((PLUGIN_DIR / manifest_rel).read_text("utf-8"))
        name = manifest["name"]
        version = manifest.get("version", "")
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise PackagingError(f"{manifest_rel} unreadable or lacks a name: {e!r}")
    if not isinstance(version, str):
        raise PackagingError(f"{manifest_rel} version must be a string when present")
    if PLUGIN_DIR.name != name:
        raise PackagingError(f"the plugin folder is named {PLUGIN_DIR.name!r} but the manifest name is {name!r}; they must match")

    problems: list[str] = []
    hooks_rel = "hooks/hooks.json"
    if hooks_rel not in shipped:
        problems.append(f"{hooks_rel} missing")
    else:
        hooks = json.loads((PLUGIN_DIR / hooks_rel).read_text("utf-8"))
        for mod in hooks.get("modules", []):
            target = os.path.normpath(os.path.join("hooks", mod)).replace(os.sep, "/")
            if target not in shipped:
                problems.append(f"hooks.json module {mod!r} -> {target} is not in the package")

    # Every relative import in shipped code must land on a shipped file: this is what
    # guarantees leaving out tests/ (or anything else) cannot break the plugin at runtime.
    for f in files:
        if f.suffix not in {".ts", ".js", ".mjs", ".cjs"}:
            continue
        text = src(f).read_text("utf-8")
        for spec in IMPORT_RE.findall(text):
            target = os.path.normpath(os.path.join(f.parent.as_posix(), spec)).replace(os.sep, "/")
            if target not in shipped:
                problems.append(f"{f.as_posix()} imports {spec!r} -> {target}, which is not in the package")
    if problems:
        raise PackagingError("package would be broken:\n  - " + "\n  - ".join(problems))
    return name, version


# --------------------------------------------------------------------------- build

def build_zip(files: list[Path], name: str, out: Path, flat: bool) -> None:
    prefix = "" if flat else f"{name}/"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for rel in files:
                source = src(rel)
                info = zipfile.ZipInfo.from_file(source, prefix + rel.as_posix())
                info.compress_type = zipfile.ZIP_DEFLATED
                executable = os.access(source, os.X_OK)
                info.external_attr = (0o755 if executable else 0o644) << 16
                z.writestr(info, source.read_bytes(), compresslevel=9)
        with zipfile.ZipFile(tmp) as z:  # re-open and check what was actually written
            bad = z.testzip()
            if bad:
                raise PackagingError(f"corrupt entry in zip: {bad}")
            names = z.namelist()
            leaked = [n for n in names if re.search(r"(^|/)(tests|node_modules|_devwork|\.github)/|\.claude-plugin/types/|(^|/)AGENTS\.md$|(^|/)\.gitignore$", n)]
            if leaked:
                raise PackagingError(f"dev-only files leaked into the zip: {leaked[:5]}")
            if len(names) != len(files):
                raise PackagingError(f"zip has {len(names)} entries, expected {len(files)}")
        os.replace(tmp, out)
    finally:
        if tmp.exists():
            tmp.unlink()


def main() -> int:
    ap = argparse.ArgumentParser(description="Package the Selective Context Trim plugin.")
    ap.add_argument("--out", type=Path, default=None, help="output zip (default: _devwork/dist/<plugin-name>.zip)")
    ap.add_argument("--skip-tests", action="store_true", help="do not run the test suite first")
    ap.add_argument("--flat", action="store_true",
                    help="put .claude-plugin/ at the zip root instead of inside a <plugin-name>/ folder")
    args = ap.parse_args()

    try:
        if args.skip_tests:
            print("[1/3] tests: SKIPPED (--skip-tests)")
        else:
            run_tests()

        print("[2/3] collecting files ...", flush=True)
        files, skipped = collect()
        name, version = verify_sources(files)
        total = sum(src(f).stat().st_size for f in files)
        label = f"{name} {version}" if version else f"{name} (archive-derived version)"
        print(f"      {label}: {len(files)} files, {human(total)} uncompressed")
        for f in files:
            print(f"        + {f.as_posix()}" + ("   (from the repo root)" if f.as_posix() in ROOT_BUNDLED else ""))
        for reason, size in skipped.items():
            print(f"        - left out: {reason} ({human(size)})")

        out = (args.out or ROOT / "_devwork" / "dist" / f"{name}.zip").resolve()
        print(f"[3/3] writing {out} ...", flush=True)
        build_zip(files, name, out, args.flat)
        layout = "manifest at zip root" if args.flat else f"inside {name}/"
        print(f"      done: {human(out.stat().st_size)}, {layout}")
        return 0
    except PackagingError as e:
        print(f"\nPACKAGING FAILED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
