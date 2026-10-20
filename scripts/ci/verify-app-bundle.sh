#!/usr/bin/env bash
# Checks a built App.app: the embedded Python framework, the standard library,
# extension modules converted to frameworks with .fwork pointers, the runtime
# package, and architectures (with lipo).
#
# Usage: verify-app-bundle.sh <path/to/App.app> <device|simulator>
set -euo pipefail

APP="$1"
KIND="$2"
FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }

[ -f "$APP/Frameworks/Python.framework/Python" ] && ok "Python.framework embedded" || bad "Python.framework missing"
STDLIB=$(ls -d "$APP"/python/lib/python3.* 2>/dev/null | head -n 1 || true)
[ -n "$STDLIB" ] && [ -f "$STDLIB/os.py" ] && ok "standard library at ${STDLIB#$APP/}" || bad "standard library missing"
SO_LEFT=$(find "$APP/python" -name '*.so' 2>/dev/null | wc -l | tr -d ' ')
[ "$SO_LEFT" = "0" ] && ok "no loose .so files remain in the bundle" || bad "$SO_LEFT .so files were not converted to frameworks"
FWORK=$(find "$APP/python" -name '*.fwork' | wc -l | tr -d ' ')
[ "$FWORK" -gt 40 ] && ok "$FWORK extension modules have .fwork pointers" || bad "only $FWORK .fwork files"
[ -f "$APP/python-app/zinia/bridge.py" ] && ok "runtime package python-app/zinia present" || bad "runtime package missing"
[ -f "$APP/public/index.html" ] && ok "web UI present" || bad "web UI (public/index.html) missing"

ARCHS=$(lipo -archs "$APP/Frameworks/Python.framework/Python")
echo "  Python.framework architectures: $ARCHS"
case "$KIND" in
    device) [[ "$ARCHS" == *arm64* ]] && ok "device build contains arm64" || bad "device build lacks arm64" ;;
    simulator) [[ "$ARCHS" == *arm64* || "$ARCHS" == *x86_64* ]] && ok "simulator build architectures present" || bad "no simulator architecture" ;;
esac
SSL_FW=$(ls -d "$APP"/Frameworks/*_ssl*.framework 2>/dev/null | head -n 1 || true)
[ -n "$SSL_FW" ] && ok "ssl extension framework: $(basename "$SSL_FW")" || bad "_ssl extension framework missing"

exit $FAIL
