"""Hermes Footprint: what your Hermes Agent has left on your disk, and what can go.

Two roots, laid out as one treemap in the Desktop page:

  * Hermes itself — ~/.hermes, walked like dust/disktree: allocated blocks, hardlinks counted
    once, never crossing into another mounted filesystem. Folders are coloured by what they are
    *to Hermes* (app, toolchains, a Bot's memory, worktrees, backups, browser profiles, caches),
    which a generic disk tool cannot tell apart.
  * Made by your Bots — the folders Bots worked in (each session records its cwd and git repo)
    and the files they wrote with write_file / patch, with which Bot, how many sessions and when.

Read-only. The removal half (``trash()``) only ever moves a path the latest scan itself marked
reclaimable to the desktop trash, after the user has reviewed the list; nothing is deleted
permanently and nothing a Bot needs to run (state.db, memories, skills, plugins, config, keys) can
be marked. Message text never leaves this module: only paths, sizes, times and counts.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import sys
import stat as st
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path

DAY = 86400
WINDOWS = sys.platform.startswith("win")
MACOS = sys.platform == "darwin"


def alloc_bytes(s: os.stat_result) -> int:
    """What a file really costs on disk: allocated blocks where the OS reports them (Linux, macOS),
    the apparent size where it does not (Windows)."""
    blocks = getattr(s, "st_blocks", None)
    return blocks * 512 if blocks is not None else s.st_size


def under(path: str, folder: str) -> bool:
    """True when ``path`` is ``folder`` or inside it, on any OS (no string-prefix tricks)."""
    try:
        return os.path.commonpath([os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(folder))]) \
            == os.path.normcase(os.path.abspath(folder))
    except ValueError:  # different drives on Windows
        return False


def real_path(display: str, root: Path) -> Path:
    """``~/.hermes/a/b`` (the display form, always '/'-joined) -> the real path under ``root``."""
    if display == "~/.hermes":
        return Path(root)
    if display.startswith("~/.hermes/"):
        return Path(root).joinpath(*display[len("~/.hermes/"):].split("/"))
    return Path(os.path.expanduser(display))
KEEP_TOP = 16          # children kept per directory in the payload; the rest fold into one tile
MIN_SHARE = 0.006      # and anything under this share of its parent folds too
MAX_DEPTH = 5
BACKUP_AGE = 14 * DAY  # backups older than this are reclaimable, except the newest two
STALE_AGE = 30 * DAY   # worktrees, checkpoints and snapshots untouched this long

# What a folder is to Hermes. Order matters: first match on the path relative to ~/.hermes wins.
KIND_RULES = [
    (r"(^|/)node_modules(/|$)|(^|/)(venv|\.venv)(/|$)", "toolchain"),
    (r"^hermes-agent(/|$)", "app"),
    (r"^(installs|tools|bin|lsp|pet-builds)(/|$)", "toolchain"),
    (r"(^|/)(worktrees)(/|$)", "worktree"),
    (r"(^|/)(backups|state-snapshots|checkpoints|profile-exports)(/|$)|^profiles-backup", "backup"),
    (r"(^|/)(browser-profile[^/]*|bot-desktop|browser-github)(/|$)", "browser"),
    (r"(^|/)(cache|audio_cache|logs|tmp)(/|$)", "cache"),
    (r"(^|/)(state\.db[^/]*|memories|sessions|cron)(/|$)", "memory"),
    (r"(^|/)(skills|plugins|desktop-plugins|plugin-data)(/|$)", "skills"),
    (r"^profiles(/|$)", "bot"),
]
KIND_RULES = [(re.compile(rx), k) for rx, k in KIND_RULES]
KINDS = {
    "app": "Hermes app", "toolchain": "Toolchains & installs", "bot": "Bot (other)", "memory": "Bot memory & sessions",
    "skills": "Skills & plugins", "worktree": "Worktrees", "backup": "Backups & snapshots", "browser": "Browser profiles",
    "cache": "Caches & logs", "other": "Other", "workspace": "Made by your Bots",
}
# Never offered for removal, whatever the rules say: what a Bot needs to run.
PROTECTED_NAMES = ["memories", "skills", "plugins", "desktop-plugins", "config.yaml", "auth.json", "auth.lock", ".env",
                   "profile.yaml", "SOUL.md", "cron", "hermes-agent"]
# Case-insensitive: Windows and macOS treat SKILLS and skills as the same folder.
PROTECTED = re.compile(r"(^|/)(state\.db[^/]*|" + "|".join(map(re.escape, PROTECTED_NAMES)) + r")(/|$)", re.IGNORECASE)


def hermes_root() -> Path:
    env = os.environ.get("HERMES_HOME")
    root = Path(env) if env else Path.home() / ".hermes"
    if root.parent.name == "profiles":
        root = root.parent.parent
    return root


def kind_of(rel: str) -> str:
    for rx, k in KIND_RULES:
        if rx.search(rel):
            return k
    return "other"


class Stopped(Exception):
    """The user pressed Stop on the Desktop page."""


class Progress:
    """What a running scan is doing, for the Desktop page to poll (`footprint progress`), and the
    Stop flag it checks (`footprint stop`). Both are small files under plugin-data."""

    def __init__(self, root: Path):
        self.dir = root / "plugin-data" / "hermes-footprint"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.stop_flag = self.dir / "stop"
        self.stop_flag.unlink(missing_ok=True)
        try:
            self.last = json.loads((self.dir / "last.json").read_text())
        except (OSError, ValueError):
            self.last = {}
        self.started = time.time()
        self.at = 0.0
        self.state = {"phase": "walk", "files": 0, "where": ""}

    def update(self, force: bool = False, **kw) -> None:
        self.state.update(kw)
        now = time.time()
        if not force and now - self.at < 0.5:
            return
        self.at = now
        if self.stop_flag.exists():
            raise Stopped()
        data = {**self.state, "started": self.started, "elapsed": round(now - self.started, 1),
                "expected_files": self.last.get("files"), "expected_seconds": self.last.get("seconds"), "running": True}
        tmp = self.dir / "progress.json.tmp"
        tmp.write_text(json.dumps(data))
        os.replace(tmp, self.dir / "progress.json")

    def finish(self, files: int, stopped: bool = False) -> None:
        if not stopped:
            (self.dir / "last.json").write_text(json.dumps({"files": files, "seconds": round(time.time() - self.started, 1)}))
        (self.dir / "progress.json").write_text(json.dumps({"running": False, "stopped": stopped}))
        self.stop_flag.unlink(missing_ok=True)


def read_progress(root: Path | None = None) -> dict:
    root = Path(root) if root else hermes_root()
    try:
        return json.loads((root / "plugin-data" / "hermes-footprint" / "progress.json").read_text())
    except (OSError, ValueError):
        return {"running": False}


def request_stop(root: Path | None = None) -> dict:
    root = Path(root) if root else hermes_root()
    d = root / "plugin-data" / "hermes-footprint"
    d.mkdir(parents=True, exist_ok=True)
    (d / "stop").touch()
    return {"ok": True}


def entry_stat(e: os.DirEntry) -> os.stat_result:
    """``e.stat()`` without following links, with the device, inode and link count filled in.
    Windows' DirEntry.stat() leaves those at 0, so a device check would skip every folder and
    hardlinks could not be told apart; ``os.stat`` reports them."""
    s = e.stat(follow_symlinks=False)
    return s if s.st_dev else os.stat(e.path, follow_symlinks=False)


def is_link(s: os.stat_result) -> bool:
    """A symlink, or on Windows any reparse point: a junction reports as a folder, and walking it
    would count space outside ~/.hermes (or the same folders again, for a junction back inside)."""
    return st.S_ISLNK(s.st_mode) or bool(getattr(s, "st_file_attributes", 0) & getattr(st, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


class Walker:
    """dust's shape, single-threaded: walk once, aggregate bottom-up, dedupe hardlinks."""

    def __init__(self, dev: int, progress: Progress | None = None, root: str = ""):
        self.dev = dev
        self.seen: set = set()
        self.files = 0
        self.progress = progress
        self.root = root

    def walk(self, path: str) -> dict:
        node = {"name": os.path.basename(path) or path, "bytes": 0, "files": 0, "mtime": 0.0, "children": [], "_abs": path}
        try:
            it = os.scandir(path)
        except OSError:
            return node
        with it:
            for e in it:
                try:
                    s = entry_stat(e)
                except OSError:
                    continue
                if st.S_ISDIR(s.st_mode):
                    if s.st_dev != self.dev or is_link(s) or os.path.ismount(e.path):
                        continue  # never enter another filesystem, a junction or a link
                    child = self.walk(e.path)
                    node["children"].append(child)
                    node["bytes"] += child["bytes"]; node["files"] += child["files"]
                    node["mtime"] = max(node["mtime"], child["mtime"], s.st_mtime)
                elif st.S_ISREG(s.st_mode) or st.S_ISLNK(s.st_mode):
                    if s.st_nlink > 1:
                        key = (s.st_dev, s.st_ino)
                        if key in self.seen:
                            continue
                        self.seen.add(key)
                    size = alloc_bytes(s)
                    self.files += 1
                    if self.progress and not self.files % 2000:
                        self.progress.update(files=self.files, where=path[len(self.root):].lstrip("/").split("/")[0])
                    node["files"] += 1; node["bytes"] += size
                    node["mtime"] = max(node["mtime"], s.st_mtime)
                    node.setdefault("_files", []).append((e.name, size, s.st_mtime))
        return node


# Folders whose contents are rebuilt on demand. Never a whole folder just because it is called "cache".
REBUILDABLE = {
    "uv": "package cache (uv): rebuilt when needed", "pip": "package cache (pip): rebuilt when needed",
    "_cacache": "package cache (npm): rebuilt when needed", "__pycache__": "compiled Python: rebuilt when needed",
    "Cache": "browser cache: rebuilt when needed", "Code Cache": "browser cache: rebuilt when needed",
    "GPUCache": "browser cache: rebuilt when needed", "ShaderCache": "browser cache: rebuilt when needed",
    "Crashpad": "crash reports",
}
# Package caches that share their name with an installed package: pip and uv are also folders in
# site-packages, so a folder with that name directly inside a package folder is code, not cache.
PACKAGE_NAMED = {"uv", "pip", "_cacache"}
PACKAGE_FOLDERS = {"site-packages", "dist-packages", "node_modules"}


def find_exe(name: str) -> str | None:
    """A program on PATH. On Windows, never from the current folder: CreateProcess and
    shutil.which look there first, so a planted git.exe would run instead."""
    if not WINDOWS:
        return shutil.which(name)
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if d and d != "." and os.path.isabs(d):
            exe = os.path.join(d, name + ".exe")
            if os.path.isfile(exe):
                return exe
    return None


def windows_program(*rel: str) -> str:
    """A program that ships with Windows, by its full path under %SystemRoot%."""
    return os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", *rel)


# Toolchains Hermes installs and expects to find (language servers, runtimes): not ours to offer.
HERMES_MANAGED = re.compile(r"^(profiles/[^/]+/)?(lsp|tools|installs|bin)/")


def git_info(path: str | None) -> dict | None:
    """What git says about a checkout, like disktree's panel: branch, changed and untracked files,
    commits that exist on no remote, stashes in its repo, and the last commit's time."""
    if not path:
        return None

    git = find_exe("git")
    if not git:
        return None

    def run(*args):
        r = subprocess.run([git, "--no-optional-locks", "-C", path, *args], capture_output=True,
                           text=True, timeout=30, env={**os.environ, "GIT_NO_LAZY_FETCH": "1"})
        return r.stdout if r.returncode == 0 else None
    try:
        status = run("status", "--porcelain=v1", "--branch")
        if status is None:
            return None
        lines = status.splitlines()
        head = lines[0][3:] if lines and lines[0].startswith("## ") else ""
        branch = None if head.startswith("HEAD (no branch)") else head.split("...")[0].replace("No commits yet on ", "")
        unpushed = run("rev-list", "--count", "HEAD", "--not", "--remotes")
        last = run("log", "-1", "--format=%ct")
        stashes = run("stash", "list")
        return {"branch": branch, "short": (run("rev-parse", "--short", "HEAD") or "").strip() or None,
                "changed": sum(1 for l in lines[1:] if l and not l.startswith("??")),
                "untracked": sum(1 for l in lines[1:] if l.startswith("??")),
                "unpushed": int(unpushed.strip()) if unpushed and unpushed.strip().isdigit() else None,
                "stashes": len(stashes.splitlines()) if stashes else 0,
                "last_commit": int(last.strip()) if last and last.strip().isdigit() else None}
    except (OSError, subprocess.SubprocessError):
        return None


def git_dirty(path: str | None) -> int:
    git = find_exe("git") if path else None
    if not git:
        return 0
    try:
        run = subprocess.run([git, "--no-optional-locks", "-C", path, "status", "--porcelain"],
                             capture_output=True, text=True, timeout=20,
                             env={**os.environ, "GIT_NO_LAZY_FETCH": "1"})
        return len([l for l in run.stdout.splitlines() if l.strip()]) if run.returncode == 0 else 0
    except (OSError, subprocess.SubprocessError):
        return 0


def reclaim_reason(rel: str, node: dict, siblings: list, parent_rel: str, now: float, sib_files: set = frozenset()) -> str | None:
    """Why this folder's space can be had back, or None. Name *and* context, like disktree."""
    if PROTECTED.search(rel):
        return None
    name = node["name"]
    age = now - node["mtime"] if node["mtime"] else 0
    sib = {s["name"] for s in siblings} | set(sib_files)
    if name == "node_modules" and "package.json" in sib and not HERMES_MANAGED.search(rel):
        return "reinstallable (npm install brings it back)"
    parent = os.path.basename(parent_rel)
    if name in REBUILDABLE and not (name in PACKAGE_NAMED and parent in PACKAGE_FOLDERS):
        return REBUILDABLE[name]
    if parent in ("backups", "profile-exports") or name.startswith("profiles-backup"):
        newest = sorted((s for s in siblings), key=lambda s: -s["mtime"])[:2]
        if age > BACKUP_AGE and node not in newest:
            return f"backup from {int(age // DAY)} days ago (the newest two are kept)"
    if parent in ("checkpoints", "state-snapshots") and age > STALE_AGE:
        return f"snapshot untouched for {int(age // DAY)} days"
    if parent == "worktrees" and age > STALE_AGE:
        g = node["_git"] = git_info(node.get("_abs"))
        risks = []
        if g:
            if g["changed"]:
                risks.append(f"{g['changed']} changed file(s)")
            if g["untracked"]:
                risks.append(f"{g['untracked']} untracked item(s)")
            if g["unpushed"]:
                risks.append(f"{g['unpushed']} commit(s) on no remote")
        return (f"worktree untouched for {int(age // DAY)} days" + (f"; it has {', '.join(risks)}, look first" if risks else "")
                + " (then run git worktree prune in its repo)")
    if name == "pet-builds":
        return "build output"
    return None


def shape(node: dict, rel: str, depth: int, now: float, parent_rel: str = "", siblings: list | None = None,
          sib_files: set = frozenset()) -> dict:
    """Turn the raw walk into the payload: kinds, reclaim reasons, folding of small items."""
    kind = kind_of(rel) if rel else "other"
    out = {"name": node["name"], "path": rel, "bytes": node["bytes"], "files": node["files"], "mtime": node["mtime"], "kind": kind}
    if rel:
        why = reclaim_reason(rel, node, siblings or [], parent_rel, now, sib_files)
        if why:
            out["reclaim"] = why
            if node.get("_git"):
                out["git"] = node["_git"]
    kids = sorted(node["children"], key=lambda c: -c["bytes"])
    files = sorted(node.get("_files", []), key=lambda f: -f[1])
    entries = [("dir", c) for c in kids] + [("file", f) for f in files]
    entries.sort(key=lambda e: -(e[1]["bytes"] if e[0] == "dir" else e[1][1]))
    keep, rest_b, rest_n = [], 0, 0
    for i, (t, x) in enumerate(entries):
        size = x["bytes"] if t == "dir" else x[1]
        if depth < MAX_DEPTH and i < KEEP_TOP and node["bytes"] and size / node["bytes"] >= MIN_SHARE:
            keep.append((t, x))
        else:
            rest_b += size; rest_n += 1
    children = []
    for t, x in keep:
        if t == "dir":
            crel = f"{rel}/{x['name']}" if rel else x["name"]
            if "reclaim" in out:  # a reclaimable folder is one tile: its insides don't matter
                continue
            children.append(shape(x, crel, depth + 1, now, rel, kids, {f[0] for f in files}))
        else:
            name, size, mtime = x
            crel = f"{rel}/{name}" if rel else name
            children.append({"name": name, "path": crel, "bytes": size, "files": 1, "mtime": mtime, "kind": kind_of(crel), "file": True})
    if rest_n and "reclaim" not in out:
        children.append({"name": f"{rest_n:,} smaller items", "path": rel, "bytes": rest_b, "files": 0, "mtime": 0, "kind": kind, "rest": True})
    if children and "reclaim" not in out:
        out["children"] = children
    return out


def compact(n: dict) -> dict:
    """Payload form: no per-node path (the page rebuilds it from names), whole-second times."""
    out = {k: v for k, v in n.items() if k not in ("path", "children")}
    out["mtime"] = int(n["mtime"])
    if out.get("file"):
        out.pop("files", None)
    if "children" in n:
        out["children"] = [compact(c) for c in n["children"]]
    return out


def reclaimables(tree: dict, prefix: str) -> list:
    found = []

    def go(n):
        if n.get("reclaim"):
            found.append({"path": f"{prefix}/{n['path']}" if n["path"] else prefix, "bytes": n["bytes"], "reason": n["reclaim"],
                          "kind": n["kind"], "mtime": n["mtime"], **({"git": n["git"]} if n.get("git") else {})})
            return
        for c in n.get("children", []):
            go(c)
    go(tree)
    return sorted(found, key=lambda r: -r["bytes"])


def bot_work(root: Path, home: Path) -> dict:
    """Folders Bots worked in and files they wrote, from every profile's session database."""
    folders = defaultdict(lambda: {"bots": Counter(), "sessions": 0, "last": 0.0})
    written = defaultdict(set)
    homes = [("default", root)] + [(p.name, p) for p in sorted((root / "profiles").iterdir()) if p.is_dir()] if (root / "profiles").is_dir() else [("default", root)]
    for bot, ph in homes:
        db = ph / "state.db"
        if not db.exists():
            continue
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
            cols = {r[1] for r in c.execute("pragma table_info(sessions)")}
            if {"cwd", "git_repo_root"} <= cols:
                for cwd, repo, ts in c.execute("select cwd, git_repo_root, coalesce(last_activity_at, started_at) from sessions"):
                    where = repo or cwd
                    if not where:
                        continue
                    f = folders[where]; f["bots"][bot] += 1; f["sessions"] += 1; f["last"] = max(f["last"], float(ts or 0))
            for (tc,) in c.execute("select tool_calls from messages where role='assistant' and "
                                   "(tool_calls like '%write_file%' or tool_calls like '%\"patch\"%')"):
                try:
                    calls = json.loads(tc)
                except (TypeError, ValueError):
                    continue
                for call in calls if isinstance(calls, list) else []:
                    fn = call.get("function") or call
                    if fn.get("name") not in ("write_file", "patch"):
                        continue
                    a = fn.get("arguments")
                    try:
                        a = json.loads(a) if isinstance(a, str) else (a or {})
                    except ValueError:
                        continue
                    p = a.get("path") or a.get("file_path") if isinstance(a, dict) else None
                    if p:
                        written[os.path.expanduser(str(p))].add(bot)
            c.close()
        except sqlite3.Error:
            continue
    hroot = str(root)
    out = []
    for where, f in folders.items():
        if where in (str(home), "/", hroot) or under(where, hroot):
            continue  # home itself and Hermes' own folder are covered by the other root
        exists = os.path.isdir(where)
        files_in = [p for p in written if p != where and under(p, where)]
        out.append({"path": where.replace(str(home), "~", 1), "bots": dict(f["bots"].most_common()), "sessions": f["sessions"],
                    "last": f["last"], "exists": exists, "files_written": len(files_in),
                    "files_still_there": sum(1 for p in files_in if os.path.isfile(p))})
    still = [p for p in written if os.path.isfile(p)]
    return {"folders": sorted(out, key=lambda x: -x["sessions"]),
            "files": {"written": len(written), "still_there": len(still), "gone": len(written) - len(still),
                      "bytes": sum(os.path.getsize(p) for p in still),
                      "by_bot": dict(Counter(b for p in still for b in written[p]).most_common())}}


def du(path: str, dev: int, limit_s: float = 4.0) -> int | None:
    """Allocated bytes under path, or None when it takes too long (huge or unreadable)."""
    t0, total, seen, stack = time.time(), 0, set(), [path]
    while stack:
        if time.time() - t0 > limit_s:
            return None
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        s = entry_stat(e)
                    except OSError:
                        continue
                    if st.S_ISDIR(s.st_mode):
                        if s.st_dev == dev and not is_link(s):
                            stack.append(e.path)
                    else:
                        if s.st_nlink > 1:
                            if (s.st_dev, s.st_ino) in seen:
                                continue
                            seen.add((s.st_dev, s.st_ino))
                        total += alloc_bytes(s)
        except OSError:
            continue
    return total


def collect(root: Path | None = None, now: float | None = None, report: bool = False) -> dict:
    root = Path(root) if root else hermes_root()
    home = Path.home()
    now = time.time() if now is None else now
    t0 = time.time()
    prog = Progress(root) if report else None
    try:
        dev = os.stat(root).st_dev
        w = Walker(dev, prog, str(root))
        raw = w.walk(str(root))
        raw["name"] = "~/.hermes"
        if prog:
            prog.update(force=True, phase="sort", files=w.files, where="")
        tree = shape(raw, "", 0, now)
        if prog:
            prog.update(force=True, phase="bots")
        work = bot_work(root, home)
        for i, f in enumerate(work["folders"]):
            if f["exists"]:
                if prog:
                    prog.update(phase="sizes", where=f["path"], step=i + 1, steps=len(work["folders"]))
                f["bytes"] = du(os.path.expanduser(f["path"]), os.stat(os.path.expanduser(f["path"])).st_dev)
    except Stopped:
        prog.finish(0, stopped=True)
        return {"stopped": True}
    total = shutil.disk_usage(str(root))
    rec = reclaimables(tree, "~/.hermes")
    if prog:
        prog.finish(w.files)
    return {
        "generated_at": now, "scan_seconds": round(time.time() - t0, 2), "files_scanned": w.files,
        "disk": {"total": total.total, "used": total.used, "free": total.free},
        "hermes": compact(tree), "kinds": KINDS, "reclaimable": rec, "reclaimable_bytes": sum(r["bytes"] for r in rec),
        "bots": work, "privacy": "read-only; paths, sizes, times and counts only, no message text",
    }


# ── removal: reviewed paths to the desktop trash, never a permanent delete ──────────────────────
def trash_command(real: str) -> list | None:
    """The desktop's own 'move to trash' for this OS, as an argv list (never a shell string).
    Linux: gio or trash-cli. macOS: Finder. Windows: the Recycle Bin through .NET. None when no tool."""
    if WINDOWS:
        ps = windows_program("System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        kind = "DeleteDirectory" if os.path.isdir(real) else "DeleteFile"
        # The path reaches PowerShell as data (send_to_trash sets FOOTPRINT_TRASH_PATH), never as
        # script text: PowerShell also ends a '...' string at typographic quotes, so escaping ' is
        # not enough and a folder name could run code.
        return [ps, "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; "
                f"[Microsoft.VisualBasic.FileIO.FileSystem]::{kind}($env:FOOTPRINT_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"]
    if MACOS:
        if not shutil.which("osascript"):
            return None
        quoted = real.replace("\\", "\\\\").replace('"', '\\"')
        return ["osascript", "-e", f'tell application "Finder" to delete POSIX file "{quoted}"']
    if shutil.which("gio"):
        return ["gio", "trash", "--", real]
    if shutil.which("trash-put"):
        return ["trash-put", "--", real]
    return None


def send_to_trash(real: str) -> str | None:
    """Move one path to the trash; None on success, else a short reason."""
    try:  # the cross-platform library, when the host Python has it
        import send2trash  # type: ignore
        send2trash.send2trash(real)
        return None
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001 — report, then try the OS tool
        last = f"send2trash: {e}"
    else:
        last = None
    cmd = trash_command(real)
    if not cmd:
        return "no trash tool found (Linux: gio or trash-cli; macOS: osascript; Windows: PowerShell)"
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env={**os.environ, "FOOTPRINT_TRASH_PATH": real})
    if run.returncode == 0:
        return None
    return (run.stderr.strip().splitlines() or run.stdout.strip().splitlines() or ["failed"])[-1]


def recheck(display: str, root: Path, now: float | None = None) -> dict | None:
    """Is this exact path still reclaimable right now? Walks only that folder and looks at its
    parent's entries (the same rules as the full scan), so it takes well under a second instead of
    re-scanning all of ~/.hermes. Returns {bytes, reason} or None."""
    now = time.time() if now is None else now
    if not display.startswith("~/.hermes/"):
        return None
    rel = display[len("~/.hermes/"):]
    parts = rel.split("/")
    if any(p in ("", ".", "..") or "\\" in p for p in parts) or PROTECTED.search(rel):
        return None  # only the '/'-joined form the scan itself produces
    real = real_path(display, root)
    if real == Path(root) or not under(str(real), str(root)) or not real.exists():
        return None
    if os.path.normcase(os.path.realpath(real)) != os.path.normcase(os.path.join(os.path.realpath(root), *parts)):
        return None  # a symlink or junction on the way leads somewhere else
    dev = os.stat(root).st_dev
    if real.is_dir():
        node = Walker(dev).walk(str(real))
    else:
        st_ = real.stat()
        node = {"name": real.name, "bytes": alloc_bytes(st_), "files": 1, "mtime": st_.st_mtime, "children": [], "_abs": str(real)}
    siblings, files = [], set()
    try:
        with os.scandir(real.parent) as it:
            for e in it:
                if e.name == node["name"]:
                    siblings.append(node)   # the node itself, so "newest two backups" can recognise it
                    continue
                try:
                    st_ = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                if e.is_dir(follow_symlinks=False):
                    siblings.append({"name": e.name, "mtime": st_.st_mtime, "bytes": 0})
                else:
                    files.add(e.name)
    except OSError:
        return None
    parent_rel = rel.rsplit("/", 1)[0] if "/" in rel else ""
    why = reclaim_reason(rel, node, siblings, parent_rel, now, files)
    return {"bytes": node["bytes"], "reason": why} if why else None


def trash(paths: list[str], root: Path | None = None, report: bool = False) -> dict:
    """Move each path to the trash, but only if it is reclaimable right now (re-checked per path)."""
    root = Path(root) if root else hermes_root()
    prog = Progress(root) if report else None
    results = []
    try:
        for i, p in enumerate(paths, 1):
            name = p.rsplit("/", 1)[-1]
            if prog:
                prog.update(force=True, phase="check", step=i, steps=len(paths), where=name)
            ok = recheck(p, root)
            if ok is None:
                results.append({"path": p, "ok": False, "why": "not reclaimable right now (re-checked before moving)"}); continue
            if prog:
                prog.update(force=True, phase="trash", step=i, steps=len(paths), where=name)
            why = send_to_trash(str(real_path(p, root)))
            results.append({"path": p, "ok": why is None, "bytes": ok["bytes"], "why": why})
    except Stopped:
        pass
    finally:
        if prog:
            prog.finish(0, stopped=True)   # never record a trash run as a scan
    return {"results": results, "freed_bytes": sum(r.get("bytes", 0) for r in results if r["ok"]),
            "free_after": shutil.disk_usage(str(root)).free}


def open_folder(path: str, root: Path | None = None) -> dict:
    """Show a folder in the desktop file manager. Only inside ~/.hermes or a Bot work folder; a
    file opens its folder. Uses the desktop's own opener, never a shell."""
    root = Path(root) if root else hermes_root()
    real = real_path(path, root)
    real = real if real.is_dir() else real.parent
    try:
        real = real.resolve(strict=True)
    except OSError:
        return {"ok": False, "why": "not found"}
    if not under(str(real), str(root.resolve())):
        folders = {os.path.realpath(os.path.expanduser(f["path"])) for f in bot_work(root, Path.home())["folders"] if f["exists"]}
        if not any(under(str(real), f) for f in folders):
            return {"ok": False, "why": "only folders inside ~/.hermes or a Bot work folder"}
    cmd = open_command(str(real))
    if cmd is None:
        return {"ok": False, "why": "no file-manager opener found"}
    if WINDOWS:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    else:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"ok": True, "path": str(real)}


def open_command(real: str) -> list | None:
    if WINDOWS:
        return [windows_program("explorer.exe"), real]
    if MACOS:
        return ["open", real]
    if shutil.which("gio"):
        return ["gio", "open", real]
    if shutil.which("xdg-open"):
        return ["xdg-open", real]
    return None
