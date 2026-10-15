#!/usr/bin/env bash
# Rebuild the README images and the GitHub social preview from the harness, which runs the real
# desktop/plugin.js against harness/payload.js (make it first: python3 harness/make-payload.py).
# Needs Node 22+ and Chrome or Chromium. The harness's Trash step is canned and never touches the disk.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m http.server 4735 --bind 127.0.0.1 >/dev/null 2>&1 &
server=$!
trap 'kill $server' EXIT
sleep 1
url=http://127.0.0.1:4735/harness/index.html
shot() { node scripts/capture.mjs "$url$1" --out "docs/$2" --width 1440 --height 860 --select "#root" --wait "${3:-3500}"; }
shot "?view=cards" can-go.png
shot "" treemap.png
shot "?view=bots" bot-cards.png
shot "?view=deck" review-deck.png
node scripts/capture.mjs http://127.0.0.1:4735/docs/social.html --out docs/social-preview.png --width 1280 --height 640 --scale 1 --wait 1500
