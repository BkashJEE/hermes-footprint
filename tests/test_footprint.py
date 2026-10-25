"""Run: python3 tests/test_footprint.py  (plain unittest; builds a fake ~/.hermes in a temp dir)."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("footprint_data", HERE / "footprint_data.py")
fd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fd)

OLD = time.time() - 90 * 86400
REAL_SCANDIR = os.scandir


class WindowsDirEntry:
    """A DirEntry as Windows hands it out: stat() leaves st_ino, st_dev and st_nlink at 0
    (https://docs.python.org/3/library/os.html#os.DirEntry.stat)."""

    def __init__(self, entry):
        self._e = entry
        self.name, self.path = entry.name, entry.path

    def stat(self, follow_symlinks=True):
        s = self._e.stat(follow_symlinks=follow_symlinks)
        return os.stat_result((s.st_mode, 0, 0, 0, s.st_uid, s.st_gid, s.st_size, s.st_atime, s.st_mtime, s.st_ctime))

    def is_dir(self, follow_symlinks=True):
        return self._e.is_dir(follow_symlinks=follow_symlinks)

    def is_file(self, follow_symlinks=True):
        return self._e.is_file(follow_symlinks=follow_symlinks)


class windows_scandir:
    def __init__(self, path):
        self._it = REAL_SCANDIR(path)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._it.close()

    def __iter__(self):
        return (WindowsDirEntry(e) for e in self._it)

    def close(self):
        self._it.close()


def make(root: Path, rel: str, size: int = 4096, mtime: float | None = None) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * size)
    if mtime:
        os.utime(p, (mtime, mtime))
    return p


class FootprintTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / ".hermes"
        r = self.root
        make(r, "hermes-agent/run_agent.py", 200_000)
        make(r, "state.db", 50_000)
        make(r, "memories/MEMORY.md", 2_000)
        make(r, "cache/uv/wheel.whl", 300_000)
        make(r, "cache/screenshot.png", 100_000)               # the user's file in cache: never offered
        make(r, "profiles/nova/cache/uv/w.whl", 50_000)
        make(r, "profiles/nova/state.db", 30_000)
        make(r, "web/node_modules/a/index.js", 80_000); make(r, "web/package.json", 100)
        make(r, "tools/node_modules/b.js", 60_000)              # no package.json next to it: not offered
        make(r, "profiles/nova/lsp/node_modules/c.js", 60_000); make(r, "profiles/nova/lsp/package.json", 100)
        for i, age in enumerate([1, 3, 40, 60]):
            t = time.time() - age * 86400
            make(r, f"backups/b{i}/data.tar", 70_000, t); os.utime(r / f"backups/b{i}", (t, t))
        make(r, "worktrees/old/file.py", 90_000, OLD); os.utime(r / "worktrees/old", (OLD, OLD))
        make(r, "worktrees/new/file.py", 90_000)
        a = make(r, "skills/x/SKILL.md", 40_000)
        os.link(a, r / "skills/x/SKILL-hardlink.md")

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self):
        with mock.patch.object(fd, "bot_work", return_value={"folders": [], "files": {"written": 0, "still_there": 0, "gone": 0, "bytes": 0, "by_bot": {}}}):
            return fd.collect(self.root)

    def test_reclaimable_by_name_and_context(self):
        paths = {r["path"] for r in self.scan()["reclaimable"]}
        self.assertIn("~/.hermes/cache/uv", paths)
        self.assertIn("~/.hermes/profiles/nova/cache/uv", paths)
        self.assertIn("~/.hermes/web/node_modules", paths)
        self.assertIn("~/.hermes/worktrees/old", paths)
        self.assertNotIn("~/.hermes/cache", paths)                  # whole cache folder holds user files
        self.assertNotIn("~/.hermes/tools/node_modules", paths)     # no package.json: not reinstallable
        self.assertNotIn("~/.hermes/worktrees/new", paths)
        self.assertNotIn("~/.hermes/profiles/nova/lsp/node_modules", paths)  # Hermes-managed language server

    def test_backups_keep_newest_two(self):
        paths = {r["path"] for r in self.scan()["reclaimable"]}
        self.assertEqual({p for p in paths if "backups" in p}, {"~/.hermes/backups/b2", "~/.hermes/backups/b3"})

    def test_protected_never_offered(self):
        for r in self.scan()["reclaimable"]:
            self.assertIsNone(fd.PROTECTED.search(r["path"].replace("~/.hermes/", "")), r["path"])

    def test_reading_a_checkout_does_not_write_it(self):
        """`git status` refreshes `.git/index` unless `--no-optional-locks` is passed, so a scan
        could write to a checkout. This is a plain checkout: a linked worktree keeps its index in
        the parent repo (`<repo>/.git/worktrees/<n>/index`), and git decides per entry whether a
        refreshed stat cache is worth writing, which makes that path harder to observe."""
        repo = Path(self.tmp.name) / "checkout"
        repo.mkdir()
        ident = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                 "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        env = {**os.environ, **ident}

        def git(*a):
            return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True, env=env)

        git("init", "-q")
        (repo / "a.txt").write_text("x\n")
        git("add", ".")
        git("commit", "-qm", "base")
        index = repo / ".git" / "index"
        old = time.time() - 3600
        os.utime(index, (old, old))             # stamp the index hours ago: a rewrite cannot hide
        os.utime(repo / "a.txt", None)          # and make the cached stat stale
        before = index.stat().st_mtime
        fd.git_info(str(repo))
        fd.git_dirty(str(repo))
        self.assertEqual(before, index.stat().st_mtime,
                         "the scan rewrote .git/index; pass --no-optional-locks to git")

    def test_hardlinks_counted_once_and_kinds(self):
        d = self.scan()
        skills = next(c for c in d["hermes"]["children"] if c["name"] == "skills")
        self.assertEqual(skills["kind"], "skills")
        self.assertLess(skills["bytes"], 2 * 40_000)
        self.assertEqual(fd.kind_of("hermes-agent/x"), "app")
        self.assertEqual(fd.kind_of("profiles/nova/state.db"), "memory")
        self.assertEqual(fd.kind_of("web/node_modules/a"), "toolchain")

    def test_trash_refuses_unmarked_and_protected(self):
        calls = []
        with mock.patch.object(fd.subprocess, "run", side_effect=lambda cmd, **k: calls.append(cmd) or mock.Mock(returncode=0, stdout="", stderr="")), \
             mock.patch.object(fd.shutil, "which", return_value="/usr/bin/gio"), \
             mock.patch.dict(sys.modules, {"send2trash": None}), \
             mock.patch.object(fd, "WINDOWS", False), mock.patch.object(fd, "MACOS", False):
            res = fd.trash(["~/.hermes/state.db", "~/.hermes/cache", "~/.hermes/cache/uv", "/etc"], self.root)
        ok = {r["path"]: r["ok"] for r in res["results"]}
        self.assertIn("re-checked", [r["why"] for r in res["results"] if r["path"] == "~/.hermes/cache"][0])
        self.assertEqual(ok, {"~/.hermes/state.db": False, "~/.hermes/cache": False, "~/.hermes/cache/uv": True, "/etc": False})
        trash_calls = [c for c in calls if c[:2] == ["gio", "trash"]]
        self.assertEqual(trash_calls, [["gio", "trash", "--", str(self.root / "cache/uv")]])

    def test_open_only_inside_hermes(self):
        opened = []
        with mock.patch.object(fd.subprocess, "Popen", side_effect=lambda cmd, **k: opened.append(cmd)), \
             mock.patch.object(fd, "bot_work", return_value={"folders": [], "files": {}}):
            self.assertTrue(fd.open_folder("~/.hermes/cache/uv/wheel.whl", self.root)["ok"])   # a file opens its folder
            self.assertFalse(fd.open_folder("/etc", self.root)["ok"])
            self.assertFalse(fd.open_folder("~/.hermes/../../etc", self.root)["ok"])
        self.assertEqual(len(opened), 1)
        self.assertTrue(opened[0][-1].replace("\\", "/").endswith("/cache/uv"))

    def test_git_details_for_a_worktree(self):
        import subprocess
        repo = self.root / "worktrees" / "gitwt"
        repo.mkdir(parents=True)
        run = lambda *a: subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True, check=True)
        run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
        (repo / "a.txt").write_text("a"); run("add", "a.txt"); run("commit", "-qm", "one")
        (repo / "a.txt").write_text("changed"); (repo / "new.txt").write_text("n")
        g = fd.git_info(str(repo))
        self.assertEqual((g["changed"], g["untracked"], g["unpushed"]), (1, 1, 1))  # no remote: the commit exists only here
        self.assertTrue(g["branch"])
        for d, _, fs in os.walk(repo):
            for x in fs + [""]:
                os.utime(os.path.join(d, x) if x else d, (OLD, OLD))
        rec = {r["path"]: r for r in self.scan()["reclaimable"]}
        r = rec["~/.hermes/worktrees/gitwt"]
        self.assertIn("1 commit(s) on no remote", r["reason"])
        self.assertIn("look first", r["reason"])
        self.assertEqual(r["git"]["unpushed"], 1)

    def test_progress_and_stop(self):
        prog = fd.Progress(self.root)
        prog.update(force=True, files=10, where="cache")
        p = fd.read_progress(self.root)
        self.assertTrue(p["running"]); self.assertEqual(p["files"], 10)
        fd.request_stop(self.root)
        with self.assertRaises(fd.Stopped):
            prog.update(force=True)
        prog.finish(0, stopped=True)
        self.assertEqual(fd.read_progress(self.root), {"running": False, "stopped": True})
        self.assertFalse((self.root / "plugin-data/hermes-footprint/stop").exists())

    def test_stop_during_a_scan_returns_stopped(self):
        fd.request_stop(self.root)
        real = fd.Progress.__init__
        def keep_flag(selfp, root):
            real(selfp, root); selfp.stop_flag.touch()   # the user presses Stop right after the scan starts
        with mock.patch.object(fd.Progress, "__init__", keep_flag), \
             mock.patch.object(fd, "bot_work", return_value={"folders": [], "files": {}}):
            self.assertEqual(fd.collect(self.root, report=True), {"stopped": True})

    def test_recheck_matches_the_scan(self):
        scanned = {r["path"] for r in self.scan()["reclaimable"]}
        for p in sorted(scanned):
            self.assertIsNotNone(fd.recheck(p, self.root), p)
        self.assertIsNone(fd.recheck("~/.hermes/backups/b0", self.root))      # newest backup: kept
        self.assertIsNone(fd.recheck("~/.hermes/tools/node_modules", self.root))
        self.assertIsNone(fd.recheck("~/.hermes/state.db", self.root))
        self.assertIsNone(fd.recheck("~/.hermes/../etc", self.root))
        self.assertIsNone(fd.recheck("~/.hermes/cache/missing", self.root))
        self.assertEqual(fd.recheck("~/.hermes/cache/uv", self.root)["bytes"], 300_000 if os.name == "nt" else fd.alloc_bytes(os.stat(self.root / "cache/uv/wheel.whl")))

    def test_alloc_bytes_without_st_blocks(self):
        class WinStat:  # Windows stat results have no st_blocks
            st_size = 1234
        self.assertEqual(fd.alloc_bytes(WinStat()), 1234)
        real = os.stat(self.root / "state.db")
        self.assertEqual(fd.alloc_bytes(real), real.st_blocks * 512 if hasattr(real, "st_blocks") else real.st_size)

    def test_trash_command_per_os(self):
        with mock.patch.object(fd, "WINDOWS", True), mock.patch.object(fd, "MACOS", False), \
             mock.patch.object(fd.shutil, "which", return_value="C:\\\\ps\\\\powershell.exe"), \
             mock.patch.object(fd.os.path, "isdir", return_value=True):
            cmd = fd.trash_command("C:\\Users\\x\\.hermes\\cache\\it's")
            self.assertEqual(cmd[1:4], ["-NoProfile", "-NonInteractive", "-Command"])
            self.assertIn("SendToRecycleBin", cmd[-1]); self.assertIn("DeleteDirectory", cmd[-1])
            self.assertIn("$env:FOOTPRINT_TRASH_PATH", cmd[-1])
        with mock.patch.object(fd, "WINDOWS", False), mock.patch.object(fd, "MACOS", True), \
             mock.patch.object(fd.shutil, "which", return_value="/usr/bin/osascript"):
            cmd = fd.trash_command('/Users/x/.hermes/cache/a"b')
            self.assertEqual(cmd[:2], ["osascript", "-e"]); self.assertIn('POSIX file "/Users/x/.hermes/cache/a\\"b"', cmd[2])
        with mock.patch.object(fd, "WINDOWS", False), mock.patch.object(fd, "MACOS", False), \
             mock.patch.object(fd.shutil, "which", side_effect=lambda n: "/usr/bin/trash-put" if n == "trash-put" else None):
            self.assertEqual(fd.trash_command("/h/.hermes/cache/uv"), ["trash-put", "--", "/h/.hermes/cache/uv"])
        with mock.patch.object(fd, "WINDOWS", False), mock.patch.object(fd, "MACOS", False), mock.patch.object(fd.shutil, "which", return_value=None):
            self.assertIsNone(fd.trash_command("/h/.hermes/cache/uv"))

    def test_windows_trash_path_is_never_part_of_the_script(self):
        """PowerShell also ends a '...' string at the typographic quotes (U+2018-U+201B), so escaping
        only ' let a folder name run code. The path must reach PowerShell as data, not as script."""
        name = "C:\\h\\.hermes\\backups\\a\u2019); ni pwned; (\u2019 it's"
        seen = []
        with mock.patch.object(fd, "WINDOWS", True), mock.patch.object(fd, "MACOS", False), \
             mock.patch.object(fd.shutil, "which", return_value="C:\\ps\\powershell.exe"), \
             mock.patch.dict(sys.modules, {"send2trash": None}), \
             mock.patch.object(fd.subprocess, "run", side_effect=lambda cmd, **k: seen.append((cmd, k)) or mock.Mock(returncode=0, stdout="", stderr="")):
            self.assertIsNone(fd.send_to_trash(name))
        (cmd, kw), = seen
        self.assertFalse(any("\u2019" in a or "pwned" in a for a in cmd), cmd)
        self.assertEqual(kw["env"]["FOOTPRINT_TRASH_PATH"], name)

    @unittest.skipUnless(os.name == "nt" and os.environ.get("FOOTPRINT_REAL_TRASH"),
                         "Windows only; set FOOTPRINT_REAL_TRASH=1 (moves a small test folder to the Recycle Bin)")
    def test_windows_real_trash_runs_no_code_from_a_name(self):
        evil = "a\u2019); ni INJECTED.txt; (\u2019"
        make(self.root, f"backups/{evil}/f.txt", 10, OLD); os.utime(self.root / "backups" / evil, (OLD, OLD))
        cwd = os.getcwd(); os.chdir(self.tmp.name)
        try:
            res = fd.trash([f"~/.hermes/backups/{evil}"], self.root)
        finally:
            os.chdir(cwd)
        self.assertFalse((Path(self.tmp.name) / "INJECTED.txt").exists(), "the folder name ran as code")
        self.assertTrue(res["results"][0]["ok"], res)
        self.assertFalse((self.root / "backups" / evil).exists())

    def link(self, link: Path, target: Path) -> None:
        target.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":   # a junction needs no admin rights, unlike a symlink
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True)
        else:
            os.symlink(target, link)

    def test_recheck_refuses_paths_the_scan_never_produces(self):
        """The re-check must hold for any caller (REST, CLI), not only for paths the page sends:
        no backslashes, '.', '..' or empty segments, no case games with protected names, and no
        link or junction anywhere on the way."""
        make(self.root, ".env", 100, OLD)
        make(self.root, "skills/x/__pycache__/m.pyc", 100)
        self.link(self.root / "cache" / "pip", Path(self.tmp.name) / "outside")
        make(Path(self.tmp.name), "outside/secret.txt", 10)
        for p in ["~/.hermes/backups/x\\..\\..\\.env", "~/.hermes/backups/b9/../b2", "~/.hermes/backups/./b2",
                  "~/.hermes/backups//b2", "~/.hermes/SKILLS/x/__pycache__", "~/.hermes/cache/pip"]:
            self.assertIsNone(fd.recheck(p, self.root), p)
        self.assertIsNotNone(fd.recheck("~/.hermes/backups/b2", self.root))
        self.assertIsNotNone(fd.recheck("~/.hermes/cache/uv", self.root))

    def test_source_compiles_without_warnings(self):
        """An invalid escape such as "C:\\Windows" in a normal string is a warning today and an error later."""
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            compile(Path(fd.__file__).read_text(encoding="utf-8"), fd.__file__, "exec")

    def test_windows_programs_never_come_from_the_current_folder(self):
        """Windows looks for a bare program name in the current folder first (CreateProcess and
        Python's shutil.which), so a planted explorer.exe, powershell.exe or git.exe there would run."""
        here, on_path = Path(self.tmp.name) / "cwd", Path(self.tmp.name) / "bin"
        for d in (here, on_path):
            d.mkdir(); (d / "git.exe").write_bytes(b"")
        windir = os.path.join("C:\\", "Windows")
        cwd = os.getcwd(); os.chdir(here)
        try:
            with mock.patch.object(fd, "WINDOWS", True), mock.patch.object(fd, "MACOS", False), \
                 mock.patch.dict(os.environ, {"SystemRoot": windir, "PATH": str(on_path)}):
                self.assertEqual(fd.trash_command(str(self.root / "cache" / "uv"))[0],
                                 os.path.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
                self.assertEqual(fd.open_command("C:\\x")[0], os.path.join(windir, "explorer.exe"))
                self.assertEqual(fd.find_exe("git"), str(on_path / "git.exe"))
            with mock.patch.object(fd, "WINDOWS", True), mock.patch.dict(os.environ, {"PATH": os.pathsep.join(["", "."])}):
                self.assertIsNone(fd.find_exe("git"))   # only the one in the current folder: never used
        finally:
            os.chdir(cwd)

    def test_scan_does_not_walk_into_links(self):
        """A junction (Windows) or symlink to a folder elsewhere is not Hermes' space. The walk and
        du() must not enter it, and a link back to ~/.hermes must not be walked again."""
        dev = os.stat(self.root).st_dev
        before, du_before = self.scan()["hermes"]["bytes"], fd.du(str(self.root), dev)
        make(Path(self.tmp.name), "elsewhere/big.bin", 500_000)
        self.link(self.root / "cache" / "linked", Path(self.tmp.name) / "elsewhere")
        self.link(self.root / "cache" / "loop", self.root)
        self.assertLess(self.scan()["hermes"]["bytes"] - before, 100_000)
        self.assertLess(fd.du(str(self.root), dev, limit_s=30) - du_before, 100_000)

    def test_open_command_per_os_and_under(self):
        with mock.patch.object(fd, "WINDOWS", True), mock.patch.object(fd, "MACOS", False):
            self.assertTrue(fd.open_command("C:\\x")[0].endswith("explorer.exe"))
        with mock.patch.object(fd, "WINDOWS", False), mock.patch.object(fd, "MACOS", True):
            self.assertEqual(fd.open_command("/x")[0], "open")
        self.assertTrue(fd.under(str(self.root / "cache" / "uv"), str(self.root)))
        self.assertFalse(fd.under("/etc", str(self.root)))
        self.assertFalse(fd.under(str(self.root) + "2", str(self.root)))  # a sibling that merely shares the prefix

    def test_windows_direntry_without_device_ids(self):
        """Windows' DirEntry.stat() reports st_dev 0, which never equals the root's device: the
        walk must still enter subfolders, count a hardlink once, and size a Bot folder."""
        expected_du = fd.du(str(self.root / "cache"), os.stat(self.root).st_dev)
        with mock.patch.object(fd.os, "scandir", windows_scandir):
            d = self.scan()
            paths = {r["path"] for r in d["reclaimable"]}
            self.assertIn("~/.hermes/cache/uv", paths)
            self.assertIsNotNone(fd.recheck("~/.hermes/cache/uv", self.root))
            skills = next(c for c in d["hermes"]["children"] if c["name"] == "skills")
            self.assertLess(skills["bytes"], 2 * 40_000)
            self.assertEqual(fd.du(str(self.root / "cache"), os.stat(self.root).st_dev), expected_du)
        self.assertGreater(expected_du, 0)

    def test_installed_pip_and_uv_are_not_caches(self):
        """A folder named pip or uv inside site-packages is the installed package, not a cache."""
        r = self.root
        make(r, "tools/python-3.14/Lib/site-packages/pip/__init__.py", 50_000, OLD)
        make(r, "tools/python-3.14/Lib/site-packages/uv/uv.exe", 50_000, OLD)
        make(r, "web/venv/Lib/site-packages/pip/__init__.py", 50_000, OLD)
        make(r, "cache/pip/http/x", 50_000)
        paths = {x["path"] for x in self.scan()["reclaimable"]}
        self.assertIn("~/.hermes/cache/pip", paths)                       # a real pip cache is still offered
        for p in ("~/.hermes/tools/python-3.14/Lib/site-packages/pip",
                  "~/.hermes/tools/python-3.14/Lib/site-packages/uv",
                  "~/.hermes/web/venv/Lib/site-packages/pip"):
            self.assertNotIn(p, paths)
            self.assertIsNone(fd.recheck(p, self.root), p)

    def test_payload_has_no_private_fields(self):
        import json
        s = json.dumps(self.scan())
        self.assertNotIn('"_abs"', s)
        self.assertNotIn('"_files"', s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
