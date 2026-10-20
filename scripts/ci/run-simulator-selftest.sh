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

python3 - "$LOG" "$OUT" <<'PY'
import json
import sys

log, out = sys.argv[1], sys.argv[2]
text = open(log, encoding="utf-8", errors="replace").read()
begin, end = "=====ZINIA-SELFTEST-BEGIN=====", "=====ZINIA-SELFTEST-END====="
if begin not in text or end not in text:
    print("::error::The self-test report was not found in the simulator output.")
    print(text[-4000:])
    sys.exit(1)
report = json.loads(text.split(begin, 1)[1].split(end, 1)[0])
with open(out, "w") as fh:
    json.dump(report, fh, indent=2)
selftest = report.get("selftest") or {}
summary = selftest.get("summary", {})
runtime = report.get("runtime") or {}
print("Python %s on %s (%s)" % (runtime.get("pythonVersion"), runtime.get("platform"), runtime.get("machine")))
print("Initialized: %s, start-up %.0f ms" % (report.get("initialized"), runtime.get("startupMs") or 0))
print("Missing-runtime diagnostic detected: %s" % (report.get("missingRuntimeDiagnostic") or {}).get("detected"))
for case in selftest.get("cases", []):
    print("  %s  %s" % ("PASS" if case["passed"] else "FAIL", case["title"]))
unavailable = [m["module"] for m in selftest.get("modules", []) if not m["available"]]
print("Modules importable: %s/%s; unavailable: %s" % (summary.get("modulesAvailable"), summary.get("modulesChecked"), ", ".join(unavailable)))
if not report.get("success"):
    print("::error::Embedded Python self-test failed")
    if report.get("initError"):
        print(json.dumps(report["initError"], indent=2))
    sys.exit(1)
print("Embedded Python self-test passed")
PY
