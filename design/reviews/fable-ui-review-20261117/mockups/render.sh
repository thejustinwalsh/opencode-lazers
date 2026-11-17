#!/bin/sh
# Renders mockups/<name>.html to mockups/<name>.png with headless Chrome over file:// (no server).
set -e
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
for name in "${@:-tasks radar models trajectory settings}"; do
  for n in $name; do
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
      --force-prefers-reduced-motion --window-size=1280,860 --force-device-scale-factor=2 \
      --virtual-time-budget=2000 --screenshot="$PWD/$n.png" "file://$PWD/$n.html" 2>/dev/null
  done
done
