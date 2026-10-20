#!/usr/bin/env bash
# Selects the Xcode used by the build. Capacitor 8 requires Xcode 26 or newer.
#
# XCODE_VERSION (default 26.5) is tried first so builds are reproducible. If a
# runner image no longer ships that exact version, the newest installed
# Xcode 26.x is used instead and a warning is printed in the workflow log.
set -euo pipefail

WANTED="${XCODE_VERSION:-26.5}"
CANDIDATE="/Applications/Xcode_${WANTED}.app"

if [ ! -d "$CANDIDATE" ]; then
    FALLBACK=$(ls -d /Applications/Xcode_26*.app 2>/dev/null | sort -V | tail -n 1 || true)
    if [ -z "$FALLBACK" ]; then
        echo "::error::No Xcode 26.x is installed on this runner. Installed versions:"
        ls -d /Applications/Xcode*.app || true
        exit 1
    fi
    echo "::warning::Xcode $WANTED is not installed on this runner; using $FALLBACK"
    CANDIDATE="$FALLBACK"
fi

sudo xcode-select --switch "$CANDIDATE/Contents/Developer"
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
