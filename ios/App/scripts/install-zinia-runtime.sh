#!/bin/bash
# Xcode build phase: "Install ZiniaPython runtime package".
#
# Copies ZiniaPython's Python support package (python/zinia in the repository)
# into <App.app>/python-app/zinia, where the interpreter's module search path expects
# it, plus any packages that were compiled for iOS ahead of time
# (python-runtime/app_packages/<platform>, optional).
set -euo pipefail

REPO_ROOT="$(cd "$PROJECT_DIR/../.." && pwd)"
SOURCE="$REPO_ROOT/python/zinia"
DEST="$CODESIGNING_FOLDER_PATH/python-app/zinia"

if [ ! -f "$SOURCE/bridge.py" ]; then
    echo "error: ZiniaPython runtime package not found at $SOURCE" >&2
    exit 1
fi

mkdir -p "$CODESIGNING_FOLDER_PATH/python-app"
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' "$SOURCE/" "$DEST/"
echo "Installed ZiniaPython runtime package into python-app/zinia"

# Optional: build-time packages, one folder per platform because compiled
# modules differ between device (iphoneos) and simulator (iphonesimulator).
PACKAGES="$REPO_ROOT/python-runtime/app_packages/$PLATFORM_NAME"
if [ -d "$PACKAGES" ] && [ -n "$(ls -A "$PACKAGES" 2>/dev/null)" ]; then
    rsync -a --delete --exclude '__pycache__' "$PACKAGES/" "$CODESIGNING_FOLDER_PATH/app_packages/"
    echo "Installed build-time packages from $PACKAGES"
else
    rm -rf "$CODESIGNING_FOLDER_PATH/app_packages"
fi
