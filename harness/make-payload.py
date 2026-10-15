"""Write harness/payload.js from a real, read-only scan of this machine, for the harness and the README images.

    python3 harness/make-payload.py

payload.js holds your folder names and sizes, so it is git-ignored; never commit it.
"""
import importlib.util
import json
from pathlib import Path

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("footprint_data", here.parent / "footprint_data.py")
fd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fd)
data = fd.collect()
(here / "payload.js").write_text("export default " + json.dumps(data) + "\n")
print(f"payload.js: {data['files_scanned']:,} files, {data['reclaimable_bytes'] / 1e9:.2f} GB can go")
