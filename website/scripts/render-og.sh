#!/bin/sh
# Renders public/og.png (1200x630) from the built site's cover. Run `bun run build` first.
# Uses headless Chrome against dist/ via file:// so no server is started.
set -e
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --force-prefers-reduced-motion --window-size=1440,756 --force-device-scale-factor=0.8333333 --virtual-time-budget=4000 \
  --screenshot="$PWD/public/og.png" "file://$PWD/dist/index.html"
if command -v pngquant >/dev/null; then pngquant --force --quality=70-90 --output public/og.png public/og.png; fi
