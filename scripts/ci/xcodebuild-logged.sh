#!/usr/bin/env bash
# Runs xcodebuild with the full log written to build/logs/<name>.log, prints a
# short summary on success and the errors plus the end of the log on failure.
#
# Usage: xcodebuild-logged.sh <log-name> <xcodebuild arguments...>
set -uo pipefail

NAME="$1"
shift
mkdir -p build/logs
LOG="build/logs/$NAME.log"

echo "xcodebuild $*"
xcodebuild "$@" > "$LOG" 2>&1
STATUS=$?

grep -E 'Installing Python|Python standard library installed|Installed ZiniaPython runtime|Installed build-time packages|^\*\* .* \*\*$' "$LOG" | tail -n 20 || true
if [ $STATUS -ne 0 ]; then
    echo "::error::xcodebuild failed ($NAME); full log in the ZiniaPython-build-logs artifact"
    grep -E '(error|fatal error):' "$LOG" | sort -u | head -n 60 || true
    echo "----- last 120 lines of $LOG -----"
    tail -n 120 "$LOG"
fi
exit $STATUS
