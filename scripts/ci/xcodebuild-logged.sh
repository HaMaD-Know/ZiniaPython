#!/usr/bin/env bash
# Runs xcodebuild with the full log written to build/logs/<name>.log, prints a
# short summary on success and the errors plus the end of the log on failure.
# On failure the compiler errors are also published as a GitHub annotation
# (readable through the public API; see run-annotated.sh).
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
    python3 - "$NAME" "$LOG" <<'PY'
import re
import sys

name, log = sys.argv[1], sys.argv[2]
lines = open(log, encoding="utf-8", errors="replace").read().splitlines()
errors = []
for line in lines:
    if re.search(r"(error|fatal error):", line) and line not in errors:
        errors.append(line.replace("/Users/runner/work/", ""))
body = "\n".join(errors[:40]) or "\n".join(lines[-40:])
body = body[-3800:]
escaped = body.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
print(f"::error title=xcodebuild {name}::{escaped}")
PY
fi
exit $STATUS
