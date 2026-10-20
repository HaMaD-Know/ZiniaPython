#!/usr/bin/env bash
# Downloads the pinned CPython iOS distribution (python-runtime/runtime.lock.json),
# verifies its SHA-256, and extracts Python.xcframework into ios/App/.
#
# Usage: scripts/fetch-python-runtime.sh [--force]
# Works on macOS (CI and local) and Linux. On Windows use fetch-python-runtime.ps1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/python-runtime/runtime.lock.json"
DEST="$ROOT/ios/App"
DOWNLOADS="$ROOT/python-runtime/downloads"
FORCE="${1:-}"

json() { node -e "process.stdout.write(String(require(process.argv[1])[process.argv[2]]))" "$LOCK" "$1"; }
URL="$(json url)"
SHA="$(json sha256)"
RELEASE="$(json release)"
ARCHIVE="$DOWNLOADS/$(basename "$URL")"
MARKER="$DEST/Python.xcframework/.zinia-runtime-release"

if [ "$FORCE" != "--force" ] && [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$RELEASE" ]; then
    echo "Python.xcframework $RELEASE is already installed."
    exit 0
fi

mkdir -p "$DOWNLOADS"
if [ ! -f "$ARCHIVE" ]; then
    echo "Downloading $URL"
    curl --fail --location --retry 3 --retry-delay 5 --output "$ARCHIVE.part" "$URL"
    mv "$ARCHIVE.part" "$ARCHIVE"
fi

if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
else
    ACTUAL="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
fi
if [ "$ACTUAL" != "$SHA" ]; then
    echo "error: SHA-256 mismatch for $ARCHIVE" >&2
    echo "error:   expected $SHA" >&2
    echo "error:   actual   $ACTUAL" >&2
    rm -f "$ARCHIVE"
    exit 1
fi
echo "Checksum verified ($SHA)"

rm -rf "$DEST/Python.xcframework"
tar -xzf "$ARCHIVE" -C "$DEST" Python.xcframework
echo "$RELEASE" > "$MARKER"
echo "Installed $DEST/Python.xcframework ($RELEASE)"
