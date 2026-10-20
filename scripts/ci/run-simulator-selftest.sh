#!/usr/bin/env bash
# Installs a simulator build of ZiniaPython, launches it with --zinia-selftest
# and checks the report printed by ZiniaSelfTestRunner.swift. The self-test
# starts the embedded CPython exactly like the IDE does and runs real scripts
# and imports in it (python/zinia/selftest.py).
#
# Usage: run-simulator-selftest.sh <simulator-udid> <path/to/App.app> <output.json>
set -euo pipefail

UDID="$1"
APP="$2"
OUT="$3"
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
LOG="$(dirname "$OUT")/selftest-console.log"
END_MARKER="=====ZINIA-SELFTEST-END====="
mkdir -p "$(dirname "$OUT")"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"

echo "Launching $BUNDLE_ID with --zinia-selftest"
# --console-pty streams the app's stdout. The runner exits the app when done;
# macOS has no `timeout`, so a watchdog loop limits the wait to 5 minutes.
xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BUNDLE_ID" --zinia-selftest > "$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 300); do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    if grep -q "$END_MARKER" "$LOG" 2>/dev/null; then sleep 2; break; fi
    sleep 1
done
kill "$PID" 2>/dev/null || true
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true

# The runner also writes the full report to Documents/zinia-selftest.json; the
# console copy can be cut off because the pseudo-terminal limits line length.
DATA=$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null || true)
REPORT_FILE="${DATA:+$DATA/Documents/zinia-selftest.json}"

python3 - "$LOG" "$OUT" "${REPORT_FILE:-}" <<'PY'
import json
import os
import sys

log, out, report_file = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(log, encoding="utf-8", errors="replace").read()


def annotate(level, title, body):
    # Annotations are readable through the public API (job logs are not).
    body = body[-3800:].replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::{level} title={title}::{body}")


begin, end = "=====ZINIA-SELFTEST-BEGIN=====", "=====ZINIA-SELFTEST-END====="
if begin not in text or end not in text:
    print(text[-4000:])
    annotate("error", "Simulator self-test", "The self-test report was not found in the simulator output.\n" + text[-3000:])
    sys.exit(1)
report = json.loads(text.split(begin, 1)[1].split(end, 1)[0])
with open(out, "w") as fh:
    json.dump(report, fh, indent=2)
selftest = report.get("selftest") or {}
summary = selftest.get("summary", {})
runtime = report.get("runtime") or {}
lines = [
    "Python %s (%s) on %s %s, machine %s" % (runtime.get("pythonVersion"), runtime.get("implementation"),
                                            runtime.get("systemName"), runtime.get("systemVersion"), runtime.get("machine")),
    "Initialized: %s, start-up %.0f ms" % (report.get("initialized"), runtime.get("startupMs") or 0),
    "Missing-runtime diagnostic detected: %s" % (report.get("missingRuntimeDiagnostic") or {}).get("detected"),
]
for case in selftest.get("cases", []):
    detail = "" if case["passed"] else " (status %s, error %s, stdout %r)" % (case.get("status"), case.get("errorType"), str(case.get("stdout"))[:200])
    lines.append("%s  %s%s" % ("PASS" if case["passed"] else "FAIL", case["title"], detail))
unavailable = [m["module"] for m in selftest.get("modules", []) if not m["available"]]
lines.append("Modules importable: %s/%s; unavailable: %s" % (summary.get("modulesAvailable"), summary.get("modulesChecked"), ", ".join(unavailable)))
print("\n".join(lines))
if not report.get("success"):
    if report.get("initError"):
        err = report["initError"]
        lines.append("Start-up error %s: %s" % (err.get("code"), err.get("message")))
        tb = (err.get("data") or {}).get("pythonTraceback")
        if tb:
            lines.append(tb)
    annotate("error", "Simulator self-test failed", "\n".join(lines))
    sys.exit(1)
annotate("notice", "Simulator self-test passed", "\n".join(lines))
print("Embedded Python self-test passed")
PY
