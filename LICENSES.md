# Dependencies and licenses

ZiniaPython IDE's own code is under the MIT License ([LICENSE](LICENSE)). Everything below keeps its own license. Versions are the ones pinned in `package-lock.json`, `python-runtime/runtime.lock.json`, `ios/App/CapApp-SPM/Package.swift` and `python/zinia/_vendor`.

## Shipped inside the iOS app

### Python runtime

| Component | Version | License |
| --- | --- | --- |
| CPython (interpreter and standard library) | 3.14.8 | Python Software Foundation License Version 2 (https://docs.python.org/3/license.html) |
| BeeWare Python-Apple-support (build of CPython for iOS) | 3.14-b12 | BSD 3-Clause (https://github.com/beeware/Python-Apple-support) |
| OpenSSL (linked into `_ssl`, `_hashlib`) | 3.5.9 | Apache License 2.0 |
| libFFI (`_ctypes`) | 3.4.7 | MIT |
| XZ Utils / liblzma (`_lzma`) | 5.6.4 | 0BSD (liblzma) |
| bzip2 (`_bz2`) | 1.0.8 | bzip2/libbzip2 license (BSD-style) |
| mpdecimal (`_decimal`) | 4.0.0 | BSD 2-Clause |
| Zstandard (`_zstd`) | 1.5.7 | BSD 3-Clause (dual-licensed with GPLv2; used under BSD) |
| SQLite (`_sqlite3`, iOS system library) | provided by iOS | Public domain |

Versions of the bundled libraries come from the `VERSIONS` file in the support package.

### Vendored Python library

| Component | Version | License |
| --- | --- | --- |
| packaging (`python/zinia/_vendor/packaging`) | 26.3 | Apache 2.0 **or** BSD 2-Clause; license texts in `python/zinia/_vendor/packaging-LICENSES/` |

### JavaScript (bundled into the web UI)

| Package | Version | License |
| --- | --- | --- |
| @capacitor/core | 8.5.3 | MIT |
| @capacitor/app | 8.1.2 | MIT |
| @capacitor/filesystem | 8.1.5 | MIT |
| @capacitor/keyboard | 8.0.6 | MIT |
| @capacitor/status-bar | 8.0.4 | MIT |
| @capacitor/synapse | 1.0.4 | ISC |
| @codemirror/autocomplete, commands, lang-python, language, search, state, view | 6.x (see package-lock.json) | MIT |
| @lezer/common, highlight, lr, python | 1.x | MIT |
| @codemirror/streamparser, style-mod, w3c-keyname, crelt, @marijn/find-cluster-break | – | MIT |
| lucide (icons) | 1.59.0 | ISC |
| tslib | 2.8.1 | 0BSD |

### Native (Swift Package Manager)

| Package | Version | License |
| --- | --- | --- |
| capacitor-swift-pm (Capacitor, Cordova) | 8.5.3 | MIT |
| Capacitor plugins (App, Filesystem, Keyboard, Status Bar) | see above | MIT |
| ion-ios-filesystem (IONFilesystemLib, used by @capacitor/filesystem) | 2.0.1 | see https://github.com/ionic-team/ion-ios-filesystem |

## Development only (not shipped)

| Package | Version | License |
| --- | --- | --- |
| @capacitor/cli | 8.5.3 | MIT |
| typescript | 6.0.3 | Apache 2.0 |
| vite | 8.3.4 | MIT |
| vitest | 5.0.5 | MIT |
| eslint, @eslint/js | 10.13.0, 10.0.1 | MIT |
| typescript-eslint | 8.72.0 | MIT |
| jsdom | 30.1.3 | MIT |
| fake-indexeddb | 6.2.6 | Apache 2.0 |
| xcode (project file parser) | 3.0.1 | Apache 2.0 |
| @types/node | 24.19.2 | MIT |

Run `npx license-checker --production` (not installed by default) for a full transitive list.

## Redistribution notes

- The PSF license requires keeping the copyright notice and license text. The CPython license text ships with the standard library in the app (`python/lib/python3.14/LICENSE.txt`). It's also at https://docs.python.org/3/license.html.
- OpenSSL 3 is Apache 2.0. Include its notice when you distribute the app (for example on an "About" or website page).
- Apps distributed through the App Store need privacy manifests for certain libraries (OpenSSL is on Apple's list). The pinned support package (3.14-b12) contains **no** `.xcprivacy` files. Before an App Store submission, add `_ssl.xcprivacy` and `_hashlib.xcprivacy` next to those modules (the build helper installs any `<module>.xcprivacy` it finds) and check Apple's current requirements. Ad hoc and development builds don't need them.
