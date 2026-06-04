#!/usr/bin/env bash
# Build a releasable extension bundle for upload to extensions.gnome.org.
#
# Produces dist/<uuid>.shell-extension.zip containing only the runtime files
# (metadata.json, extension.js, prefs.js, stylesheet.css, lib/, icons/, and the
# compiled schema). Development files such as README.md, AGENTS.md, LICENSE, the
# tools/ directory, and mockups are intentionally left out of the bundle.
#
# Usage:
#   ./build.sh                 Pack the current version.
#   ./build.sh -major          Bump X.y.z -> (X+1).0.0, then pack.
#   ./build.sh -minor          Bump x.Y.z -> x.(Y+1).0, then pack.
#   ./build.sh -patch          Bump x.y.Z -> x.y.(Z+1), then pack.
#
# A version bump rewrites "version-name" in src/metadata.json and also
# increments the integer "version" field, which extensions.gnome.org requires
# to strictly increase on every upload.
set -euo pipefail

cd "$(dirname "$0")"

SRC=src
OUT=dist
META="$SRC/metadata.json"
SCHEMA=schemas/org.gnome.shell.extensions.claude-usage.gschema.xml

# ---- parse the optional version-bump flag ----
BUMP=""
for arg in "$@"; do
    case "$arg" in
        -major|--major) part=major ;;
        -minor|--minor) part=minor ;;
        -patch|--patch) part=patch ;;
        -h|--help)
            sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            echo "Usage: $0 [-major|-minor|-patch]" >&2
            exit 1
            ;;
    esac
    if [[ -n "$BUMP" && "$BUMP" != "$part" ]]; then
        echo "Pick only one of -major, -minor, or -patch." >&2
        exit 1
    fi
    BUMP="$part"
done

# ---- apply the version bump, if requested ----
if [[ -n "$BUMP" ]]; then
    current=$(sed -n 's/.*"version-name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$META")
    if [[ ! "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Cannot parse version-name \"$current\" as X.Y.Z in $META." >&2
        exit 1
    fi
    IFS='.' read -r major minor patch <<<"$current"
    case "$BUMP" in
        major) major=$((major + 1)); minor=0; patch=0 ;;
        minor) minor=$((minor + 1)); patch=0 ;;
        patch) patch=$((patch + 1)) ;;
    esac
    newname="$major.$minor.$patch"

    code=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$META")
    newcode=$((code + 1))

    sed -i \
        -e "s/\(\"version-name\"[[:space:]]*:[[:space:]]*\"\)[^\"]*\"/\1$newname\"/" \
        -e "s/\(\"version\"[[:space:]]*:[[:space:]]*\)[0-9][0-9]*/\1$newcode/" \
        "$META"

    echo "Version: $current -> $newname (version code $code -> $newcode)"
fi

mkdir -p "$OUT"

gnome-extensions pack "$SRC" \
    --extra-source=lib \
    --extra-source=icons \
    --schema="$SCHEMA" \
    --out-dir="$OUT" \
    --force

UUID=$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$META")
echo "Built $OUT/$UUID.shell-extension.zip"
echo "Upload it at https://extensions.gnome.org/upload/"
