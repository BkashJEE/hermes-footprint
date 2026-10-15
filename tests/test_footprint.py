"""Run: python3 tests/test_footprint.py  (plain unittest; builds a fake ~/.hermes in a temp dir)."""
import importlib.util
import os
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
             mock.patch.object(fd.shutil, "which", return_value="/usr/bin/gio"):
            res = fd.trash(["~/.hermes/state.db", "~/.hermes/cache", "~/.hermes/cache/uv", "/etc"], self.root)
        ok = {r["path"]: r["ok"] for r in res["results"]}
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
        self.assertTrue(opened[0][-1].endswith("/cache/uv"))

    def test_payload_has_no_private_fields(self):
        import json
        s = json.dumps(self.scan())
        self.assertNotIn('"_abs"', s)
        self.assertNotIn('"_files"', s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
