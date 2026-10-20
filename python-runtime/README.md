# python-runtime

The CPython build for iOS that ZiniaPython embeds.

## Where it comes from

CPython supports iOS officially (PEP 730, Python 3.13+). The official guide, https://docs.python.org/3/using/ios.html, explains how to build or obtain a `Python.xcframework` and add it to an Xcode project. python.org doesn't publish iOS binaries itself; the guide points to `Apple/iOS/README.md` in the CPython sources for building one. ZiniaPython uses the prebuilt framework from **BeeWare's Python-Apple-support** project, which builds CPython with CPython's own iOS build system:

| | |
| --- | --- |
| Release | `3.14-b12` |
| Python | 3.14.8 |
| Archive | `Python-3.14-iOS-support.b12.tar.gz` (37,085,073 bytes) |
| SHA-256 | `157a6b956f47a12f005ad1e23e3e264536ef06dd35e1366acb48edbaa128e0a3` |
| Slices | `ios-arm64` (devices), `ios-arm64_x86_64-simulator` |
| Minimum iOS | 13.0 (device slice), 14.0 (arm64 simulator) |

All of this is pinned in [`runtime.lock.json`](runtime.lock.json). It was verified on 2026-10-20 by downloading the archive, checking the hash, and reading the Mach-O headers (`node scripts/verify-runtime.mjs`):

```
ok   ios-arm64: arm64 slice built for iOS (minimum 13.0)
ok   ios-arm64_x86_64-simulator: arm64 slice built for iOS Simulator (minimum 14.0)
ok   ios-arm64_x86_64-simulator: x86_64 slice built for iOS Simulator (minimum 13.0)
ok   ios-arm64: headers declare Python 3.14.8 (lock file: 3.14.8)
ok   ios-arm64: lib-arm64 has 67 compiled stdlib modules
ok   standard library has 2427 files
ok   build helper present: build/utils.sh
```

## Layout of the framework

```
Python.xcframework/
  Info.plist                     slices and architectures
  build/utils.sh                 install_python(): copies the stdlib, converts .so -> frameworks
  build/iOS-dylib-Info-template.plist
  lib/python3.14/                shared, pure-Python standard library
  ios-arm64/
    Python.framework/            the interpreter (Headers/ included)
    lib-arm64/python3.14/        lib-dynload/*.so and sysconfig data for this slice
  ios-arm64_x86_64-simulator/
    Python.framework/
    lib-arm64/, lib-x86_64/
```

The CPython documentation names the helper `build/build_utils.sh`; this release ships the same functions as `build/utils.sh`. `ios/App/scripts/process-python.sh` accepts either name.

## Getting it

The framework isn't committed (it's large and generated). Fetch it with:

```bash
bash scripts/fetch-python-runtime.sh          # macOS / Linux / CI
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-python-runtime.ps1   # Windows (inspection only)
```

Both download into `python-runtime/downloads/`, verify the SHA-256, and extract `Python.xcframework` into `ios/App/`, where the Xcode project expects it (`$(PROJECT_DIR)/Python.xcframework`).

## Optional: build-time packages

`app_packages/iphoneos/` and `app_packages/iphonesimulator/` can hold packages compiled for iOS (see [docs/PACKAGES.md](../docs/PACKAGES.md#native-packages)). The build copies the folder matching the platform into the app and converts their extension modules into frameworks.

## Changing the version

See the README, [Change the Python version safely](../README.md#change-the-python-version-safely). The native host reads the version from the framework headers (`PY_MAJOR_VERSION`, `PY_MINOR_VERSION`), so no Swift or Objective-C changes are needed for a minor-version update. The simulator self-test in CI confirms the new runtime starts.

## Building it yourself

Python-Apple-support documents the build (`make iOS` on a Mac with Xcode). CPython 3.14's own tooling is `python Apple build iOS` in the CPython source tree (see `Apple/iOS/README.md`). Building takes a Mac. Put the resulting archive somewhere reachable over HTTPS and update `runtime.lock.json`.
