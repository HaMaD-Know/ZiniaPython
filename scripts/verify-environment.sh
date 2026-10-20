#!/usr/bin/env bash
# Checks a macOS or Linux environment for ZiniaPython IDE development.
set -uo pipefail
OK=1
check() {
    if command -v "$2" >/dev/null 2>&1; then
        printf '  ok       %-8s %s\n' "$1" "$($2 --version 2>&1 | head -n 1)"
    else
        printf '  MISSING  %-8s %s\n' "$1" "$3"
        OK=0
    fi
}
echo "ZiniaPython IDE - environment check"
check Node.js node "install Node.js 22 or newer"
check npm npm "comes with Node.js"
check Git git "install Git"
check Python python3 "optional: Python 3.12+ for npm run test:python"
if [ "$(uname)" = "Darwin" ]; then
    if command -v xcodebuild >/dev/null 2>&1; then
        printf '  ok       %-8s %s\n' Xcode "$(xcodebuild -version | head -n 1)"
        xcodebuild -version | head -n 1 | grep -qE 'Xcode (2[6-9]|[3-9][0-9])' || { echo "           Xcode 26 or newer is required by Capacitor 8"; OK=0; }
    else
        echo "  MISSING  Xcode    install Xcode 26+ from the App Store"
        OK=0
    fi
else
    echo "  note     Building the iOS app needs macOS with Xcode 26+ (or the GitHub Actions workflow)."
fi
[ $OK = 1 ] && echo "Environment OK." || echo "Install the missing tools above."
[ $OK = 1 ]
