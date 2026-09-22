#!/usr/bin/env bash
# Build the Chrome Web Store upload zip: only the files the extension ships,
# never the dev docs or the 256px store icon. Output: dist/accord-extension-<version>.zip
# Directory layout (icons/, fonts/) is preserved — the manifest references those paths.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -e "process.stdout.write(require('./manifest.json').version)")
OUT="dist/accord-extension-${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"

FILES=(
  manifest.json
  background.js
  content.js
  styles.css
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
  fonts/urbanist-latin.woff2
  fonts/cormorant-mark.woff2
)

if command -v zip >/dev/null 2>&1; then
  zip -q -X "$OUT" "${FILES[@]}"
else
  # Windows without `zip`: stage into a temp tree (so subfolders survive), then
  # let PowerShell compress the staged tree. Compress-Archive flattens a flat
  # file list, so staging is required to keep icons/ and fonts/ paths intact.
  STAGE=$(mktemp -d)
  for f in "${FILES[@]}"; do
    mkdir -p "$STAGE/$(dirname "$f")"
    cp "$f" "$STAGE/$f"
  done
  WINSTAGE=$(cygpath -w "$STAGE" 2>/dev/null || echo "$STAGE")
  WINOUT=$(cygpath -w "$PWD/$OUT" 2>/dev/null || echo "$PWD/$OUT")
  powershell -NoProfile -Command "Compress-Archive -Force -Path '$WINSTAGE\\*' -DestinationPath '$WINOUT'"
  rm -rf "$STAGE"
fi

echo "built $OUT"
