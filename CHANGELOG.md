# Changelog

## 0.2.0 — 2026-10-15
- Review deck: one card per item, Keep (K) or Trash (T), SAFE / LOOK FIRST badges, a summary, then one confirm. Kept items stay off the list.
- Bot cards: a mini treemap per Bot, with files written, folders worked in, what can go and the biggest item.
- ✦ Ask a Bot (drafts a question in chat, never sends it), Open in file manager, Copy path.
- Big scans reach the page in parts, because Hermes Desktop's `cli.exec` returns at most 48,000 characters.
- Never offers the `node_modules` of language servers and runtimes that Hermes installs.

## 0.1.0 — 2026-10-15
- Treemap of `~/.hermes` by kind, reclaimable items with reasons, Move to Trash after review, the Made by your Bots view, a status-bar chip, `hermes footprint` and `/footprint`.
