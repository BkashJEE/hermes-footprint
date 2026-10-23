"""Hermes Footprint backend: the Desktop page's own REST namespace, ``/api/plugins/hermes-footprint/``.

Hermes mounts this router when the plugin is in ``plugins.enabled`` (the same gate as the Python
half), and the Desktop page reaches it with ``ctx.rest('/scan')``. It is the documented way for a
Desktop plugin to run server-side work, and it needs no ``hermes footprint`` CLI command, so the page
works on a Hermes that does not wire plugin CLI commands. The CLI path stays as a fallback.

Everything here is the same read-only scanner as the CLI: paths, sizes, times and counts only.
Removal is Trash only, and only for paths a fresh scan marks reclaimable.
"""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

VERSION = "0.3.5"
router = APIRouter()


def _data():
    """The plugin's scanner module, loaded by path: the host imports this file on its own, so a
    package-relative import would not resolve."""
    name = "hermes_footprint_data"
    mod = sys.modules.get(name)
    if mod is None:
        path = Path(__file__).resolve().parent.parent / "footprint_data.py"
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod


@router.get("/health")
async def health():
    return {"ok": True, "version": VERSION}


@router.get("/scan")
async def scan():
    """A full scan. Slow (seconds to a minute on a big ~/.hermes); the page polls /progress meanwhile."""
    return await asyncio.to_thread(_data().collect, None, None, True)


@router.get("/progress")
async def progress():
    return _data().read_progress()


@router.post("/stop")
async def stop():
    return _data().request_stop()


@router.post("/trash")
async def trash(body: dict):
    paths = body.get("paths") if isinstance(body, dict) else None
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
        raise HTTPException(status_code=400, detail="body must be {\"paths\": [\"~/.hermes/...\", ...]}")
    return await asyncio.to_thread(_data().trash, paths, None, True)


@router.post("/open")
async def open_folder(body: dict):
    path = body.get("path") if isinstance(body, dict) else None
    if not isinstance(path, str) or not path:
        raise HTTPException(status_code=400, detail="body must be {\"path\": \"~/.hermes/...\"}")
    return await asyncio.to_thread(_data().open_folder, path)
