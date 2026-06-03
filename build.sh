#!/usr/bin/env bash
# Build a releasable extension bundle for upload to extensions.gnome.org.
#
# Produces dist/<uuid>.shell-extension.zip containing only the runtime files
# (metadata.json, extension.js, prefs.js, stylesheet.css, lib/, icons/, and the
# compiled schema). Development files such as README.md, AGENTS.md, LICENSE, the
# tools/ directory, and mockups are intentionally left out of the bundle.
set -euo pipefail

cd "$(dirname "$0")"

SRC=src
OUT=dist
SCHEMA=schemas/org.gnome.shell.extensions.claude-usage.gschema.xml

mkdir -p "$OUT"

gnome-extensions pack "$SRC" \
    --extra-source=lib \
    --extra-source=icons \
    --schema="$SCHEMA" \
    --out-dir="$OUT" \
    --force

UUID=$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/metadata.json")
echo "Built $OUT/$UUID.shell-extension.zip"
echo "Upload it at https://extensions.gnome.org/upload/"
