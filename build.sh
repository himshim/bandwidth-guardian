#!/usr/bin/env bash
# Bandwidth Guardian — reproducible build script
#
# Produces a deterministic zip that can be uploaded to the Chrome Web Store.
# The zip is byte-for-byte reproducible on any machine because:
#   - All file timestamps are set to a fixed value (SOURCE_DATE_EPOCH)
#   - Files are sorted before zipping (consistent ordering)
#   - No system-specific metadata is included
#
# Usage:
#   bash build.sh           # builds bandwidth-guardian-<version>.zip
#   bash build.sh --out dir # write zip to a specific directory

set -euo pipefail

VERSION=$(python3 -c "import json,sys; print(json.load(open('manifest.json'))['version'])")
OUTDIR="${2:-$(pwd)}"
ZIPFILE="$OUTDIR/bandwidth-guardian-$VERSION.zip"

# Fixed epoch makes the build reproducible regardless of when it runs.
# Update this only when you intentionally want a different timestamp embedded.
SOURCE_DATE_EPOCH=1709856000  # 2024-03-08 00:00:00 UTC

echo "Building Bandwidth Guardian v$VERSION..."

# Files and directories to include in the extension zip.
# Explicitly listed — nothing stray goes in.
INCLUDE=(
  manifest.json
  defaults.js
  service-worker.js
  content.js
  prehook.js
  popup.html
  popup.js
  options.html
  options.js
  _locales
  icons
)

# Create a temp staging dir with fixed timestamps
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

for item in "${INCLUDE[@]}"; do
  if [ -e "$item" ]; then
    cp -r "$item" "$STAGING/"
  else
    echo "WARNING: $item not found, skipping"
  fi
done

# Apply fixed timestamps to every file recursively
find "$STAGING" -exec touch -d "@$SOURCE_DATE_EPOCH" {} +

# Build the zip with sorted, reproducible entry order
cd "$STAGING"
find . -type f | sort | zip -X -@ "$ZIPFILE"
cd - > /dev/null

echo "Done: $ZIPFILE"
echo "Size: $(du -sh "$ZIPFILE" | cut -f1)"
