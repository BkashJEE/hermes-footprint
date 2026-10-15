"""``hermes footprint`` CLI command and ``/footprint`` slash command.

The desktop page runs ``hermes --profile <p> footprint --json`` through the gateway's ``cli.exec``
RPC, and ``footprint trash PATH... --json`` after the user has reviewed and confirmed a list.
"""

from __future__ import annotations

import base64
import json
import sys
import time

from . import footprint_data as data


def gb(b) -> str:
    return f"{(b or 0) / 1e9:.2f} GB"


def render_text(d: dict) -> str:
    h = d["hermes"]
    lines = [f"Hermes uses {gb(h['bytes'])} in {d['files_scanned']:,} files ({gb(d['disk']['free'])} free on this disk).", ""]
    for c in [c for c in h.get("children", []) if not c.get("rest")][:8]:
        lines.append(f"  {gb(c['bytes']):>9}  {c['name']}  ({d['kinds'].get(c['kind'], c['kind'])})")
    if d["reclaimable"]:
        lines += ["", f"Worth a look: {gb(d['reclaimable_bytes'])} in {len(d['reclaimable'])} place(s)"]
        lines += [f"  {gb(r['bytes']):>9}  {r['path']}  — {r['reason']}" for r in d["reclaimable"][:6]]
    f = d["bots"]["files"]
    lines += ["", f"Your Bots worked in {len(d['bots']['folders'])} folder(s) and wrote {f['written']} file(s); "
                  f"{f['still_there']} are still there."]
    lines += ["", "Open Footprint in Hermes Desktop to review and move items to the trash."]
    return "\n".join(lines)


# Hermes Desktop's cli.exec returns at most 48,000 characters of output, so a big scan goes to
# the page in base64 parts: the scan prints part 0 and caches the rest, `footprint part N` prints N.
PART_CHARS = 30_000  # bytes per part before base64, which makes 40,000 characters


def cache_file():
    return data.hermes_root() / "plugin-data" / "hermes-footprint" / "scan.json"


def emit_parts(text: str, part: int = 0, scan_id: str | None = None) -> dict:
    raw = text.encode()
    parts = max(1, -(-len(raw) // PART_CHARS))
    chunk = raw[part * PART_CHARS:(part + 1) * PART_CHARS]
    return {"id": scan_id, "part": part, "parts": parts, "data": base64.b64encode(chunk).decode()}


def scan_payload() -> dict:
    text = json.dumps(data.collect(), separators=(",", ":"), default=str)
    if len(text) <= PART_CHARS:
        return json.loads(text)
    scan_id = str(int(time.time() * 1000))
    f = cache_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"id": scan_id, "text": text}))
    return emit_parts(text, 0, scan_id)


def part_payload(n: int) -> dict:
    cached = json.loads(cache_file().read_text())
    return emit_parts(cached["text"], n, cached["id"])


def slash_command(raw_args: str) -> str:
    return render_text(data.collect())


def setup_argparse(subparser) -> None:
    subparser.add_argument("action", nargs="?", choices=["scan", "trash", "part"], default="scan")
    subparser.add_argument("paths", nargs="*", help="With trash: ~/.hermes/... paths the scan marked reclaimable")
    subparser.add_argument("--json", action="store_true", help="Emit JSON for the desktop page")
    subparser.set_defaults(func=handle_cli)


def handle_cli(args) -> None:
    try:
        action = getattr(args, "action", "scan")
        if action == "trash":
            payload = data.trash(list(getattr(args, "paths", []) or []))
        elif action == "part":
            payload = part_payload(int((getattr(args, "paths", None) or ["0"])[0]))
        elif getattr(args, "json", False):
            payload = scan_payload()
        else:
            payload = data.collect()
    except Exception as e:  # the page shows this instead of crashing
        payload = {"error": f"footprint failed: {type(e).__name__}: {e}"}
    if getattr(args, "json", False):
        sys.stdout.write(json.dumps(payload, separators=(",", ":"), default=str) + "\n")
    elif "error" in payload:
        print(payload["error"])
    elif "results" in payload:
        for r in payload["results"]:
            print(("moved to trash  " if r["ok"] else "skipped  ") + r["path"] + ("" if r["ok"] else f"  ({r['why']})"))
        print(f"Freed {gb(payload['freed_bytes'])}; {gb(payload['free_after'])} free now.")
    else:
        print(render_text(payload))
