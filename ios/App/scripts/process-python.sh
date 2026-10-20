#!/bin/bash
# Xcode build phase: "Process Python libraries".
#
# Implements step 7 of https://docs.python.org/3/using/ios.html: copy the
# standard library for the platform being built into <App.app>/python/lib,
# convert every compiled extension module (.so) into a signed framework in
# <App.app>/Frameworks (App Store rule: binaries only inside frameworks), and
# leave a .fwork pointer where the .so was so Python's AppleFrameworkLoader can
# find it.
set -euo pipefail

XCFRAMEWORK="Python.xcframework"

if [ ! -d "$PROJECT_DIR/$XCFRAMEWORK" ]; then
    echo "error: $PROJECT_DIR/$XCFRAMEWORK is missing." >&2
    echo "error: Run scripts/fetch-python-runtime.sh (see python-runtime/README.md) before building." >&2
    exit 1
fi

# The CPython docs call this helper build_utils.sh; BeeWare's 3.14 support
# package (the pinned distribution) ships the same functions as utils.sh.
if [ -f "$PROJECT_DIR/$XCFRAMEWORK/build/build_utils.sh" ]; then
    # shellcheck disable=SC1090
    source "$PROJECT_DIR/$XCFRAMEWORK/build/build_utils.sh"
elif [ -f "$PROJECT_DIR/$XCFRAMEWORK/build/utils.sh" ]; then
    # shellcheck disable=SC1090
    source "$PROJECT_DIR/$XCFRAMEWORK/build/utils.sh"
else
    echo "error: $XCFRAMEWORK/build contains neither build_utils.sh nor utils.sh" >&2
    exit 1
fi

# install_stdlib copies lib-$ARCHS, so exactly one architecture must be built.
case "$ARCHS" in
    *" "*)
        echo "error: Building several architectures at once (ARCHS=$ARCHS) is not supported. Pass ARCHS=arm64." >&2
        exit 1
        ;;
esac

# Unsigned CI builds (CODE_SIGNING_ALLOWED=NO) have no signing identity, which
# the helper passes to codesign. Use an ad-hoc signature instead; any later
# re-signing (Xcode archive export, Sideloadly, AltStore) replaces it.
if [ -z "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
    export EXPANDED_CODE_SIGN_IDENTITY="-"
    export EXPANDED_CODE_SIGN_IDENTITY_NAME="ad-hoc"
fi

PACKAGE_DIRS=(app)
if [ -d "$CODESIGNING_FOLDER_PATH/app_packages" ]; then
    PACKAGE_DIRS+=(app_packages)
fi

# The helper is written for Xcode's default shell options; relax them.
set +u
install_python "$XCFRAMEWORK" "${PACKAGE_DIRS[@]}"
set -u

# Sanity check: fail the build rather than ship an app without a stdlib.
STDLIB_DIR=$(ls -d "$CODESIGNING_FOLDER_PATH"/python/lib/python3.* 2>/dev/null | head -n 1 || true)
if [ -z "$STDLIB_DIR" ] || [ ! -f "$STDLIB_DIR/os.py" ]; then
    echo "error: the Python standard library was not installed into the app bundle" >&2
    exit 1
fi
FWORK_COUNT=$(find "$STDLIB_DIR/lib-dynload" -name '*.fwork' | wc -l | tr -d ' ')
echo "Python standard library installed at ${STDLIB_DIR#$CODESIGNING_FOLDER_PATH/} ($FWORK_COUNT binary modules converted to frameworks)"
