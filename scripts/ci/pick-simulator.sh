#!/usr/bin/env bash
# Prints the UDID of an available iPhone simulator on the newest installed
# iOS runtime. Used to build and run the embedded-Python self-test in CI.
set -euo pipefail

LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
xcrun simctl list devices available --json > "$LIST"

python3 - "$LIST" <<'PY'
import json
import sys

devices = json.load(open(sys.argv[1]))["devices"]

def version(runtime):
    tail = runtime.rsplit(".", 1)[-1]  # e.g. "iOS-26-5"
    parts = tail.split("-")
    return [int(p) for p in parts[1:] if p.isdigit()] if parts[0] == "iOS" else []

for runtime in sorted((r for r in devices if version(r)), key=version, reverse=True):
    phones = [d for d in devices[runtime] if d.get("isAvailable") and d["name"].startswith("iPhone")]
    if phones:
        print(phones[0]["udid"])
        sys.stderr.write("Using %s (%s)\n" % (phones[0]["name"], runtime))
        sys.exit(0)
sys.stderr.write("No available iPhone simulator found\n")
sys.exit(1)
PY
