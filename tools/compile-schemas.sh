#!/usr/bin/env bash
# Recompile the GSettings schema for a development install.
#
# The extensions folder symlinks src/, so extension.js and the schema XML follow
# every branch switch instantly — but gschemas.compiled is a build artifact and
# is gitignored, so nothing regenerates it. Checking out a branch that adds a
# key therefore leaves the shell reading a stale compiled schema, and the
# extension dies at startup with:
#
#   GSettings key <name> not found in schema org.gnome.shell.extensions.claude-usage
#
# Run this after any checkout that touches the schema (the git hooks in
# tools/git-hooks do it automatically). Harmless to run at any time.
#
# Users installing from extensions.gnome.org are unaffected: the schema is
# compiled for them at install time.
set -euo pipefail

cd "$(dirname "$0")/.."
SCHEMA_DIR=src/schemas

xml=$(ls "$SCHEMA_DIR"/*.gschema.xml 2>/dev/null | head -1) || true
if [[ -z "${xml:-}" ]]; then
    echo "compile-schemas: no schema XML in $SCHEMA_DIR" >&2
    exit 1
fi

# Nothing to do when the compiled file is already newer than every source XML.
if [[ -f "$SCHEMA_DIR/gschemas.compiled" ]]; then
    stale=0
    for f in "$SCHEMA_DIR"/*.gschema.xml; do
        [[ "$f" -nt "$SCHEMA_DIR/gschemas.compiled" ]] && stale=1
    done
    [[ $stale -eq 0 ]] && exit 0
fi

glib-compile-schemas "$SCHEMA_DIR"

# Report anything the XML declares that the compiled schema somehow lacks, so a
# silent mismatch can't survive this script.
id=$(sed -n 's/.*<schema id="\([^"]*\)".*/\1/p' "$xml" | head -1)
missing=$(comm -23 \
    <(grep -oP 'key name="\K[^"]+' "$SCHEMA_DIR"/*.gschema.xml | sort -u) \
    <(gsettings --schemadir "$SCHEMA_DIR" list-keys "$id" 2>/dev/null | sort -u))

if [[ -n "$missing" ]]; then
    echo "compile-schemas: keys missing after compile: $(echo "$missing" | tr '\n' ' ')" >&2
    exit 1
fi

echo "compile-schemas: $SCHEMA_DIR recompiled ($(gsettings --schemadir "$SCHEMA_DIR" list-keys "$id" | wc -l) keys)"
echo "  On Wayland, log out and back in for the shell to pick it up."
