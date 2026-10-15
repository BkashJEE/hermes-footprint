# Hermes Footprint

**How much of your disk is Hermes Agent, what is it, and what can go.** Inside Hermes Desktop.

Inspired by [tobi/disktree](https://github.com/tobi/disktree), built for one folder that a generic disk tool can't read: `~/.hermes`. Footprint knows which folder is the Hermes app, a Bot's memory, a worktree, a backup, a browser profile, a language server or a package cache, and it knows what your Bots made outside it.

## What you get

- **Footprint page** (sidebar and ⌘K): a squarified treemap of `~/.hermes`, coloured by what each folder is *to Hermes*. Click a folder to zoom in.
- **Hatched tiles = can go.** Each one comes with a reason: "package cache (uv): rebuilt when needed", "backup from 40 days ago (the newest two are kept)", "worktree untouched for 30 days; it has 7 untracked items, look first".
- **Worth a look**: those items as a list. Mark them, review them, then **Move to Trash**. The disk bar shows the free space before and after.
- **Made by your Bots**: every folder a Bot worked in (from each session's own record), which Bots, how many sessions, and the files they wrote with `write_file` / `patch`, still there or since removed.
- **Status-bar chip**: `▦ Hermes 32.0 GB · 3.5 GB can go`.
- `hermes footprint` in the terminal and `/footprint` in chat.

## Safe by design

- Scanning is read-only. It counts allocated blocks (like `du`), counts hardlinks once, and never crosses into another mounted disk.
- Removal is **Move to Trash only** (`gio trash` or `trash-put`), never a permanent delete, and only after you review the list.
- Before moving anything, a fresh scan must mark that exact path again. Anything else is refused.
- **Never offered**: `state.db`, memories, skills, plugins, config, keys, `.env`, cron, the Hermes app itself, and the toolchains Hermes installs (language servers, runtimes). The Bots view is for knowing; nothing in it can be removed.
- Only paths, sizes, times and counts. No message text leaves the plugin.

## Install

```bash
hermes plugins install BkashJEE/hermes-footprint --enable
# then switch on its Desktop page in Hermes Desktop: Capabilities → Plugins
```

## Tests

```bash
python3 tests/test_footprint.py
```

The `harness/` folder renders the Desktop page in a browser with a mock SDK. Its trash step is canned and never touches the disk.

MIT licensed.
