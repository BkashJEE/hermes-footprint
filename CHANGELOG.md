# Changelog

## 0.3.2 — 2026-10-15
- The Desktop page now talks to the plugin's own backend, `dashboard/plugin_api.py`, through `ctx.rest` (the documented way), and falls back to the `hermes footprint` CLI only when that backend isn't mounted. No `plugin_api.py` has to be written by hand: it ships with the plugin.
- Clearer failure text on the page, with the exact enable command.
- `tests/test_plugin_api.py` covers the backend with FastAPI's test client.
- Dropped the `provides_commands` manifest field, which current Hermes logged as unknown.
- Windows and macOS: sizes no longer need `st_blocks` (Windows has none), Trash goes through `send2trash`, the Finder or the Recycle Bin, Open uses the OS opener, and path checks are real-path comparisons. Thanks to the reader who hit the Windows crash first.

## 0.3.1 — 2026-10-15
- `hermes plugins install` works: the protected-names pattern is now built from a list. Written by hand, its `.env|` looked like an environment dump to Hermes's install scan, which held the install for confirmation. Nothing is protected differently.

## 0.3.0 — 2026-10-15
- Can go tab: catalog-style cards with the size as the hero, its share of what can go, SAFE / LOOK FIRST, and Keep / Trash on the card. A summary card comes first.
- Git-aware worktrees: branch or detached commit, last commit, changed and untracked files, commits on no remote, and stashes in the main repo. Any risk makes the card LOOK FIRST.
- ✦ Hand to a Bot: drafts a removal job in Hermes chat for the marked items, with each tool's own clean command pointed at that exact folder. It checks first and asks before acting; nothing is sent.
- Live scan progress (files, folder, phase) and Stop. A stopped scan keeps the last result.
- Bot cards in the same catalog style.
- Always runs on a local profile where the plugin is enabled (it was failing when Desktop's primary profile didn't have it). Never runs on a remote connection.
- Scan failures go to Desktop's log.

## 0.2.0 — 2026-10-15
- Review deck: one card per item, Keep (K) or Trash (T), SAFE / LOOK FIRST badges, a summary, then one confirm. Kept items stay off the list.
- Bot cards: a mini treemap per Bot, with files written, folders worked in, what can go and the biggest item.
- ✦ Ask a Bot (drafts a question in chat, never sends it), Open in file manager, Copy path.
- Big scans reach the page in parts, because Hermes Desktop's `cli.exec` returns at most 48,000 characters.
- Never offers the `node_modules` of language servers and runtimes that Hermes installs.

## 0.1.0 — 2026-10-15
- Treemap of `~/.hermes` by kind, reclaimable items with reasons, Move to Trash after review, the Made by your Bots view, a status-bar chip, `hermes footprint` and `/footprint`.
