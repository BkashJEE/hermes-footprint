"""The Desktop page's backend (dashboard/plugin_api.py), tested with FastAPI's test client on a fake ~/.hermes.

Run: ~/.hermes/hermes-agent/venv/bin/python tests/test_plugin_api.py
(it skips itself when fastapi is not installed; Hermes's own venv has it).
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:  # plain python3 without Hermes's venv
    FastAPI = None

HERE = Path(__file__).resolve().parent.parent


@unittest.skipIf(FastAPI is None, "fastapi not installed; run with ~/.hermes/hermes-agent/venv/bin/python")
class PluginApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name) / ".hermes"
        (root / "cache" / "uv").mkdir(parents=True)
        (root / "cache" / "uv" / "w.whl").write_bytes(b"x" * 300_000)
        (root / "memories").mkdir()
        (root / "memories" / "MEMORY.md").write_text("m")
        self.old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(root)
        spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_hermes-footprint", HERE / "dashboard" / "plugin_api.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        app = FastAPI()
        app.include_router(mod.router, prefix="/api/plugins/hermes-footprint")
        self.c = TestClient(app)

    def tearDown(self):
        if self.old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self.old_home
        self.tmp.cleanup()

    def test_health(self):
        self.assertTrue(self.c.get("/api/plugins/hermes-footprint/health").json()["ok"])

    def test_scan_then_progress_is_idle(self):
        r = self.c.get("/api/plugins/hermes-footprint/scan")
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual([x["path"] for x in d["reclaimable"]], ["~/.hermes/cache/uv"])
        self.assertNotIn("parts", d)  # REST returns the whole payload; parts are a CLI-only concern
        self.assertEqual(self.c.get("/api/plugins/hermes-footprint/progress").json()["running"], False)

    def test_trash_validates_and_refuses_unmarked(self):
        self.assertEqual(self.c.post("/api/plugins/hermes-footprint/trash", json={"paths": "x"}).status_code, 400)
        self.assertEqual(self.c.post("/api/plugins/hermes-footprint/trash", json={}).status_code, 400)
        r = self.c.post("/api/plugins/hermes-footprint/trash", json={"paths": ["~/.hermes/memories"]}).json()
        self.assertFalse(r["results"][0]["ok"])
        self.assertEqual(r["freed_bytes"], 0)

    def test_open_is_guarded(self):
        self.assertEqual(self.c.post("/api/plugins/hermes-footprint/open", json={"path": 5}).status_code, 400)
        self.assertFalse(self.c.post("/api/plugins/hermes-footprint/open", json={"path": "/etc"}).json()["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
