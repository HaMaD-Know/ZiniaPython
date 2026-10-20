#!/usr/bin/env bash
# Packages a device build (.app) into an .ipa (a zip with a Payload folder).
#
# An IPA made from an unsigned build CANNOT be installed as it is. It must be
# signed first - by Xcode, by the signed workflow path, or by a re-signing tool
# such as Sideloadly or AltStore (see docs/SIGNING.md).
#
# Usage: package-ipa.sh <path/to/App.app> <output.ipa>
set -euo pipefail

APP="$1"
mkdir -p "$(dirname "$2")"
OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/Payload"
ditto "$APP" "$WORK/Payload/$(basename "$APP")"
rm -f "$OUT"
(cd "$WORK" && ditto -c -k --sequesterRsrc --keepParent Payload "$OUT")

INNER="$WORK/Payload/$(basename "$APP")"
echo "IPA: $OUT ($(du -h "$OUT" | cut -f1))"
echo "  Python.framework: $(test -f "$INNER/Frameworks/Python.framework/Python" && echo present || echo MISSING)"
echo "  Standard library: $(ls -d "$INNER"/python/lib/python3.* 2>/dev/null | sed "s#$INNER/##" || echo MISSING)"
echo "  Frameworks: $(ls -d "$INNER"/Frameworks/*.framework | wc -l | tr -d ' ')"
echo "  Runtime package: $(test -f "$INNER/app/zinia/bridge.py" && echo present || echo MISSING)"
echo "  Signature:"
codesign -dv "$INNER" 2>&1 | grep -E 'Signature|Authority|TeamIdentifier|not signed' | sed 's/^/    /' || true
