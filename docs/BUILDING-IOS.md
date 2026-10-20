# Building the iOS app

There are two ways to build, both producing the same app:

- **GitHub Actions** (`.github/workflows/build-ios.yml`), the recommended way. No Mac is needed.
- **A Mac with Xcode 26 or newer**, for local development and debugging.

## Requirements

| Item | Version | Source |
| --- | --- | --- |
| Xcode | 26.0 or newer (CI uses 26.5) | Required by Capacitor 8 (https://capacitorjs.com/docs/ios) |
| iOS deployment target | 15.0 | Capacitor 8 minimum; CPython's iOS build supports 13.0+ |
| Node.js | 22 or newer | `@capacitor/cli` 8 requires `>=22.0.0` |
| CPython | 3.14.8 (`Python-3.14-iOS-support.b12`) | Pinned in `python-runtime/runtime.lock.json` |
| Architectures | arm64 (device); arm64 or x86_64 (Simulator) | Verified by `scripts/verify-runtime.mjs` |

Swift packages are resolved by Xcode: `capacitor-swift-pm` 8.5.3 and the npm plugins under `node_modules/@capacitor/*`. CocoaPods isn't used.

## What the Xcode project contains

Capacitor generated `ios/App/App.xcodeproj` (`npx cap add ios`). These additions are committed and checked by `npm run check:ios`:

- **Sources:** `ZPInterpreter.m` (Objective-C) and six Swift files in `App/ZiniaPython/`. `App/App-Bridging-Header.h` exposes `ZPInterpreter.h` to Swift.
- **Frameworks:** `Python.xcframework`, linked *weak* and embedded with *Code Sign On Copy*.
- **Build settings** (Debug and Release), per the CPython iOS guide, step 6: `ENABLE_USER_SCRIPT_SANDBOXING = NO`, `FRAMEWORK_SEARCH_PATHS = $(PROJECT_DIR)`, `HEADER_SEARCH_PATHS = "$(BUILT_PRODUCTS_DIR)/Python.framework/Headers"`, `CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = NO`, `ENABLE_TESTABILITY = YES`, and `SWIFT_OBJC_BRIDGING_HEADER`.
- **Build phases**, in this order:
  1. Sources
  2. Frameworks
  3. Resources (the web UI in `public/`)
  4. *Install ZiniaPython runtime package*, which runs `ios/App/scripts/install-zinia-runtime.sh`: copies `python/zinia` into `App.app/python-app/zinia`, plus `python-runtime/app_packages/<platform>` when present.
  5. *Process Python libraries*, which runs `ios/App/scripts/process-python.sh`: the guide's step 7. It sources the framework's helper (`build/build_utils.sh`, or `build/utils.sh` in the pinned BeeWare package), copies the platform's standard library into `App.app/python/lib`, and converts every `.so` into `Frameworks/<module>.framework` with a `.fwork` pointer. Unsigned builds use an ad-hoc signature for these frameworks.
  6. Embed Frameworks

`Python.xcframework` itself isn't committed. `scripts/fetch-python-runtime.sh` (or `.ps1` on Windows) downloads it into `ios/App/` and verifies its checksum.

> The build helper copies `lib-$ARCHS`, so build **one architecture at a time** (`ARCHS=arm64`). The workflow and the commands below do this; `process-python.sh` stops with a clear error otherwise. The path to the project must not contain spaces, which is a limitation of the helper. GitHub's runner paths never do.

## Building with GitHub Actions

See the README, [Building the iOS app with GitHub Actions](../README.md#building-the-ios-app-with-github-actions). Useful workflow inputs (**Actions › Build iOS › Run workflow**):

- **run_selftest:** build for the Simulator and run the embedded-Python self-test (default: on).
- **export_method:** `debugging`, `release-testing` (ad hoc), `app-store-connect` or `enterprise`, used for the signed IPA.

## Building on a Mac

```bash
npm ci
npm run build
npx cap sync ios
bash scripts/fetch-python-runtime.sh
node scripts/verify-runtime.mjs
open ios/App/App.xcodeproj
```

In Xcode, choose the **App** scheme and a simulator or a connected device. Set your team under *Signing & Capabilities*, then run. From the command line:

```bash
# Simulator
xcodebuild build -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build/sim ARCHS=arm64

# Device, unsigned
xcodebuild build -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/device \
  ARCHS=arm64 CODE_SIGNING_ALLOWED=NO

# Check the bundle and package an IPA
bash scripts/ci/verify-app-bundle.sh build/device/Build/Products/Release-iphoneos/App.app device
bash scripts/ci/package-ipa.sh build/device/Build/Products/Release-iphoneos/App.app build/ZiniaPython-unsigned.ipa
```

Run the embedded-Python self-test on a simulator:

```bash
UDID=$(bash scripts/ci/pick-simulator.sh)
bash scripts/ci/run-simulator-selftest.sh "$UDID" build/sim/Build/Products/Debug-iphonesimulator/App.app build/selftest.json
```

To see the start-up diagnostic on purpose, add the launch argument `-ZiniaSimulateMissingStdlib YES` to the scheme (*Product › Scheme › Edit Scheme › Run › Arguments*).

## After changing web or Python code

- Web UI: `npm run build && npx cap sync ios`
- `python/zinia`: nothing extra. The build phase copies it on every build.
- Native code: just rebuild.

## Updating Capacitor

```bash
npm install @capacitor/core@latest @capacitor/ios@latest @capacitor/cli@latest
npx cap sync ios
npm run check:ios
```

`cap sync` regenerates `ios/App/CapApp-SPM/Package.swift` but leaves the project file alone, so the ZiniaPython wiring is kept. Run `npm run check:ios` to confirm.
