#!/usr/bin/env bash
# Runs a command with its output saved to build/logs/<name>.log. If it fails,
# the failing lines and the end of the output are also published as a GitHub
# error annotation. Annotations of a public repository can be read through the
# public REST API, while full job logs need a signed-in account - this keeps
# CI failures diagnosable from anywhere.
#
# Usage: run-annotated.sh <name> <command> [args...]
set -uo pipefail

NAME="$1"
shift
mkdir -p build/logs
LOG="build/logs/$NAME.log"

"$@" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}

if [ "$STATUS" -ne 0 ]; then
    python3 - "$NAME" "$LOG" <<'PY'
import sys

name, log = sys.argv[1], sys.argv[2]
lines = open(log, encoding="utf-8", errors="replace").read().splitlines()
markers = ("FAIL", "ERROR", "error:", "Error:", "Traceback", "AssertionError", "Exception", "failed")
picked = [l for l in lines if any(m in l for m in markers)][-30:]
body = "\n".join(picked + ["--- last lines ---"] + lines[-40:])[-3800:]
escaped = body.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
print(f"::error title={name} failed::{escaped}")
PY
fi
exit "$STATUS"
