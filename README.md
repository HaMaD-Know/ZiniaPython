# ZiniaPython IDE

A Python IDE for iPhone and iPad. You write Python in a CodeMirror 6 editor, and **Run executes it in a real CPython 3.14 interpreter embedded in the app**, offline, on the device. There's no server, no cloud execution and no JavaScript imitation of Python.

| Part | What it is |
| --- | --- |
| UI | Capacitor 8 + TypeScript + Vite, CodeMirror 6 editor, Lucide icons, no UI framework |
| Python | CPython **3.14.8** for iOS (BeeWare `Python-Apple-support` 3.14-b12, pinned by SHA-256), embedded with the C API |
| Native code | Objective-C interpreter host (`ZPInterpreter.m`) plus two Swift Capacitor plugins (`ZiniaPython`, `ZiniaFiles`) compiled into the app target |
| Runtime engine | `python/zinia`: output streaming, tracebacks, REPL, self-test and package installer, written in Python and tested on desktop CPython |
| Builds | GitHub Actions on macOS: simulator build plus an **embedded-Python self-test**, an unsigned device IPA, and an optional signed IPA |

> **Status:** everything that can be checked without a Mac has been checked: 67 runtime tests, 39 frontend tests, 77 iOS-project wiring checks and 27 checks of the real CPython iOS framework. The iOS app itself still needs its first build in GitHub Actions. See [docs/VERIFICATION-REPORT.md](docs/VERIFICATION-REPORT.md) for exactly what ran and what did not.

---

## Contents

1. [Features](#features)
2. [How it works](#how-it-works)
3. [Getting started on Windows](#getting-started-on-windows)
4. [Putting the project on GitHub](#putting-the-project-on-github)
5. [Building the iOS app with GitHub Actions](#building-the-ios-app-with-github-actions)
6. [Installing on your iPhone or iPad](#installing-on-your-iphone-or-ipad)
7. [Everyday tasks](#everyday-tasks)
8. [Repository layout](#repository-layout)
9. [Testing](#testing)
10. [Privacy and security](#privacy-and-security)
11. [Documentation index](#documentation-index)

---

## Features

**Editor**
- Python syntax highlighting, line numbers, code folding, auto-indent, Tab and Shift-Tab indentation, bracket matching, auto-closing brackets and quotes.
- Find and replace (regular expressions, case, whole word), undo/redo, select all, copy and paste.
- Local suggestions: keywords, built-ins, standard-library modules, members of common modules, names in the open file, and modules in your project. Nothing is sent anywhere.
- Multiple tabs with unsaved-change dots. Open tabs and unsaved buffers are restored after a restart.
- Font size, tab width (2/4/8), word wrap and line numbers are configurable. Dark, light and system themes.
- A row of coding keys above the iOS keyboard (Tab, `:`, brackets, quotes, `#`, arrows, undo).
- Detects when another app changes an open file. Clean tabs reload; edited tabs show a conflict banner.

**Running Python**
- **Run** executes the current file in the embedded interpreter. Unsaved edits run as they are. By default every changed file in the project is saved first, so imports see your latest code.
- `print()` output streams live; stdout and stderr are styled separately.
- Real tracebacks, with `File "...", line N` links that open the file at that line. The failing line is highlighted in the editor.
- Syntax errors show line and column. Missing modules come with an explanation (for example "tkinter is not part of the iOS build").
- `input()` works: the console shows an input field and the script waits for your answer.
- **Stop** raises `KeyboardInterrupt` in the script, and also wakes up `time.sleep()` and blocking I/O. Optional automatic stop after 30 s, 2 min or 10 min.
- A memory guard stops a script before iOS would kill the app for using too much memory.
- Projects run with the project folder as the working directory. `import helpers` finds `helpers.py`, and edited helpers are re-imported on the next run.

**REPL**
- Interactive Python with persistent variables, `>>>` and `...` prompts for multi-line statements, command history, and a multi-line block mode that shows the value of the last expression.
- "Reset interpreter state" clears REPL variables and imported project modules without touching files or tabs.

**Files and projects**
- The workspace is the app's Documents folder, so it also appears in the Files app under *On My iPhone › ZiniaPython*.
- Create, open, save, Save As, rename, duplicate, move and delete (with confirmation) files and folders. Search file names and contents. Recent files.
- Import files and export a file with Apple's document picker.
- **Open a folder** from iCloud Drive or another storage provider with the document picker. Access is kept with a security-scoped bookmark and reopened on the next launch.
- New projects start empty or with starter files (`main.py`, `helpers.py`, `README.md`, `data/example.json`). Each project has an entry point and run settings in `.zinia/project.json`.

**Packages**
- Checks any PyPI package and says honestly whether it can run on iOS: pure-Python wheel, iOS binary wheel, compiled for other platforms only, source only, or the wrong Python version.
- Installs pure-Python packages and their dependencies into app-private storage, verifying SHA-256 checksums and guarding against path traversal. Uninstall removes exactly the files the package installed.
- Packages with compiled code (numpy, pandas and so on) can be added when the app is built. See [docs/PACKAGES.md](docs/PACKAGES.md).

**Runtime and settings**
- A self-test you can run in the app: 15 real scripts, plus 99 modules imported with explanations for those that are unavailable.
- Runtime information (Python version, paths, memory), a local diagnostics log that never contains your code, clear cache, reset preferences, and licenses.

## How it works

```
 WKWebView (TypeScript UI)
   │  Capacitor bridge: ZiniaPython.execute({code, filename, workingDirectory, …})
   ▼
 ZiniaPythonPlugin.swift ── validates arguments, one request at a time, output batching, memory guard
   │
   ▼
 ZPInterpreter.m ── CPython C API on one dedicated 8 MB-stack thread ("Python's main thread")
   │   Py_PreInitialize / Py_InitializeFromConfig (UTF-8 mode, unbuffered, no bytecode,
   │   signal handlers, PYTHONHOME=<app>/python, path = stdlib, lib-dynload, app)
   ▼
 python/zinia/bridge.py ── handle(request_json) → executor / repl / selftest / packages
   │   sys.stdout/stderr → _zinia_native.emit_output → batched "output" events → console
   │   input()          → _zinia_native.read_input  → "inputRequest" event → console field
   ▼
 Your script, in a fresh __main__ with cwd = project folder and sys.path[0] = its folder
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the execution model, interrupts, the file system design and the security boundaries.

## Getting started on Windows

You need **Node.js 22 or newer**, **Git**, and optionally **Python 3.12+** to run the runtime tests. You don't need a Mac: GitHub Actions builds the iOS app on a macOS machine for you.

Check what's installed (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-environment.ps1
```

If anything is missing, install it with winget:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Python.Python.3.14
```

Install the dependencies and run the checks:

```powershell
cd "path\to\ZiniaPython IDE"
npm ci
npm run lint
npm run typecheck
npm test
npm run test:python
npm run check:ios
```

### Try the UI on your PC

```powershell
npm run dev:bridge
```

Open http://localhost:5173. This **desktop development bridge** runs your code with the Python installed on your PC, using the same `python/zinia` engine as the app, so you can work on the UI without an iPhone. The console says so clearly. The bridge exists only in the dev server: it's stripped from every production build and never reaches the iOS app. Files live in `.dev-workspace/`.

`npm run dev` starts the plain web preview without the bridge. There, Run is disabled and the console explains that Python only runs in the iOS app. Nothing is simulated.

### Look at the real iOS Python framework (optional)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-python-runtime.ps1
node scripts\verify-runtime.mjs
```

This downloads the pinned CPython iOS framework (about 37 MB), checks its SHA-256, and verifies that it contains an arm64 device slice plus arm64/x86_64 simulator slices for the right platforms, along with the standard library.

## Putting the project on GitHub

1. Create an empty repository at https://github.com/new (for example `ZiniaPython`). Don't add a README, `.gitignore` or license there; the project already has them.
2. In PowerShell, from the project folder:

   ```powershell
   git init -b main
   git config core.autocrlf false
   git add .
   git commit -m "ZiniaPython IDE"
   git remote add origin https://github.com/YOUR-NAME/ZiniaPython.git
   git push -u origin main
   ```

   Git asks you to sign in to GitHub the first time (a browser window opens). `.gitattributes` keeps shell scripts and the Xcode project at LF line endings, which the macOS build needs.

3. **Enable Actions.** In the repository, open **Actions**. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
4. The push starts two workflows automatically:
   - **Validate** (Linux, about 3 minutes): lint, type check, tests, and verification of the iOS framework.
   - **Build iOS** (macOS, 25–40 minutes): the real iOS builds.

   To start **Build iOS** by hand, open **Actions › Build iOS › Run workflow**.

### Reading a failed workflow

1. **Actions** › click the failed run › click the red job.
2. Expand the step with the red ✗. The scripts print the relevant errors at the end of that step.
3. Full Xcode logs are in the **ZiniaPython-build-logs** artifact, at the bottom of the run's summary page. It contains `simulator-build.log`, `device-build.log`, the self-test report and more.
4. [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) lists known failures and their fixes.

## Building the iOS app with GitHub Actions

The **Build iOS** workflow (`.github/workflows/build-ios.yml`) runs on `macos-26` with Xcode 26.5. It falls back to the newest Xcode 26.x on the runner and logs a warning if 26.5 is missing. The workflow:

1. Runs lint, type check, frontend tests and the Python runtime tests.
2. Builds the web assets and runs `npx cap sync ios`.
3. Checks the iOS project wiring (`scripts/check-ios-project.mjs`).
4. Downloads the pinned CPython framework, verifies its SHA-256, and checks its slices with `node` and `lipo`.
5. **Builds for the iOS Simulator** and starts the app with `--zinia-selftest`. The embedded CPython starts exactly as it does in the IDE and runs the self-test scripts. **The job fails if Python doesn't start or a test fails.**
6. **Builds for iOS devices** (arm64, Release, unsigned), checks the app bundle (Python.framework, standard library, extension modules converted to frameworks) and packages `ZiniaPython-unsigned.ipa`.
7. If signing secrets are configured, archives and exports **`ZiniaPython-signed.ipa`**.

**Downloading the result:** open the finished run and scroll to **Artifacts**:

| Artifact | Contents |
| --- | --- |
| `ZiniaPython-unsigned-ipa` | Device build, **not signed**. It must be signed before it can be installed. |
| `ZiniaPython-signed-ipa` | Signed IPA. Only produced when signing secrets are set. |
| `ZiniaPython-simulator-app` | Simulator build (`App.app`) for Xcode's simulator. |
| `ZiniaPython-build-logs` | Xcode logs and the simulator self-test report (JSON). |

GitHub wraps every artifact in a `.zip`. Unzip it to get the `.ipa`.

## Installing on your iPhone or iPad

iOS only installs **signed** apps. An unsigned IPA from CI can't be installed as it is. [docs/SIGNING.md](docs/SIGNING.md) covers all of this step by step:

- **Path A – free Apple ID, Windows PC:** sign `ZiniaPython-unsigned.ipa` with a third-party re-signing tool that runs on Windows (for example Sideloadly or AltStore). Turn on Developer Mode on the device (iOS 16+). Apps signed with a free account expire after 7 days and must be re-signed.
- **Path B – paid Apple Developer Program:** add your certificate and provisioning profile as GitHub secrets. The workflow then produces `ZiniaPython-signed.ipa`, which installs on the devices registered in your profile (for example through Apple Configurator, Xcode, or a link from an ad hoc distribution service).

Neither path makes the IPA installable on every device automatically.

## Everyday tasks

### Change the Python version safely

1. Pick a release from https://github.com/beeware/Python-Apple-support/releases (for example `3.15-b1`).
2. Download the `Python-3.X-iOS-support.bN.tar.gz` asset and compute its checksum:

   ```powershell
   (Get-FileHash .\Python-3.15-iOS-support.b1.tar.gz -Algorithm SHA256).Hash.ToLower()
   ```

3. Update `python-runtime/runtime.lock.json`: `release`, `pythonVersion`, `pythonMinor`, `url`, `sha256`, `sizeBytes`.
4. Run `scripts\fetch-python-runtime.ps1 -Force` and then `node scripts\verify-runtime.mjs`. The verifier compares the headers with the lock file.
5. Push. The simulator self-test in **Build iOS** proves the new runtime starts and runs code. The native code adapts automatically: it reads `PY_MAJOR_VERSION` and `PY_MINOR_VERSION` from the framework headers.

### Add a Python package

- **Pure Python:** in the app, open **Packages**, type the name, tap **Check**, then **Install**.
- **Packages with compiled code:** these must be compiled for iOS and added at build time. See [docs/PACKAGES.md](docs/PACKAGES.md#native-packages).

### Diagnose "Python runtime did not start"

The console shows a diagnostic panel with an error code:

| Code | Meaning | Fix |
| --- | --- | --- |
| `FRAMEWORK_MISSING` | Python.framework wasn't embedded | The *Embed Frameworks* phase failed. Check `device-build.log`. |
| `STDLIB_MISSING` | `python/lib/python3.X` isn't in the app | The *Process Python libraries* phase didn't run. Check the log. |
| `SUPPORT_MISSING` | `app/zinia` isn't in the app | The *Install ZiniaPython runtime package* phase didn't run. |
| `INIT_FAILED` / `PREINIT_FAILED` | CPython refused its configuration | The message names the failing function. |
| `BRIDGE_IMPORT_FAILED` | `import zinia.bridge` raised | The panel shows the Python traceback. |
| `ALREADY_FAILED` | An earlier start failed | Force-quit and reopen the app. |

**Settings › Python runtime › Run self-test** checks a running runtime. To reproduce the missing-runtime diagnostic on purpose, launch the app from Xcode with the argument `-ZiniaSimulateMissingStdlib YES`. More in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Change the app name or bundle identifier

Edit `appId` and `appName` in `capacitor.config.ts`, and `PRODUCT_BUNDLE_IDENTIFIER` (two places) in `ios/App/App.xcodeproj/project.pbxproj`. `npm run check:ios` fails if the two bundle identifiers disagree.

## Repository layout

```
capacitor.config.ts         Capacitor configuration (app id, keyboard behaviour)
index.html, src/            Web UI (TypeScript)
  app/                      App shell (App.ts) and the tabs model
  editor/                   CodeMirror setup, themes, local completions
  console/                  Output/REPL panel, traceback rendering
  files/                    Workspace, file providers, explorer, path helpers
  projects/                 Project model and starter template
  packages/, settings/      Packages and Settings screens
  services/                 Runtime service + lifecycle state machine, settings, storage, diagnostics
  plugins/                  Typed plugin interfaces (native + web fallbacks + dev bridge)
  styles/                   Design tokens and CSS
python/zinia/               Runtime engine bundled into the app (+ vendored `packaging`)
python/tests/               Runtime tests on desktop CPython
ios/App/App/ZiniaPython/    ZPInterpreter.h/.m, ZiniaPythonPlugin.swift, ZiniaFilesPlugin.swift, …
ios/App/scripts/            Xcode build phases (install runtime package, process Python libraries)
python-runtime/             runtime.lock.json (pinned CPython), optional build-time packages
scripts/                    Fetch/verify runtime, project checks, CI helpers, dev bridge, packaging
tests/                      Frontend unit and integration tests (Vitest)
.github/workflows/          validate.yml, build-ios.yml
docs/                       Architecture, building, signing, packages, limitations, troubleshooting, report
```

## Testing

| Command | What it runs |
| --- | --- |
| `npm test` | 39 Vitest tests: paths, state machine, tabs, settings, traceback rendering (from real CPython fixtures), the runtime service against a mocked plugin, and workspace files through the real Capacitor Filesystem web implementation |
| `npm run test:python` | 67 tests of `python/zinia` on desktop CPython: the specification's scripts, imports, interrupts, the REPL, package installation and path-traversal protection, and the bridge |
| `npm run check:ios` | 77 static checks of the Xcode project and plugin wiring |
| `node scripts/verify-runtime.mjs` | 27 checks of the CPython iOS framework (Mach-O architectures and platforms, headers, standard library) |
| CI simulator self-test | Real embedded CPython inside the iOS app on the Simulator |

## Privacy and security

- Works offline. There are no analytics, no telemetry and no accounts. Your code never leaves the device.
- Network access happens only when you check or install a package (HTTPS to pypi.org and files.pythonhosted.org).
- The diagnostics log is local and never contains source code or output.
- **Python runs in-process and is not a sandbox.** A script can read and change any file the app can reach, including your projects. Run only code you trust. iOS's own app sandbox still applies: scripts can't reach other apps' data or system files.
- The native plugins validate every argument. Working directories must be inside the workspace or a folder you opened, and there's no shell bridge.
- Signing material lives only in GitHub secrets. `.gitignore` blocks `*.p12`, `*.mobileprovision` and similar files.

## Documentation index

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, execution model, threads, interrupts, files
- [docs/BUILDING-IOS.md](docs/BUILDING-IOS.md): CI details, building on a Mac, Xcode build phases
- [docs/SIGNING.md](docs/SIGNING.md): signing and installation paths
- [docs/PACKAGES.md](docs/PACKAGES.md): package compatibility, installation, native packages
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md): known iOS limitations
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): problems and fixes
- [docs/VERIFICATION-REPORT.md](docs/VERIFICATION-REPORT.md): what was tested, results, quality gates
- [LICENSES.md](LICENSES.md): dependencies and licenses
- [python-runtime/README.md](python-runtime/README.md): the pinned CPython distribution

ZiniaPython IDE is released under the MIT License ([LICENSE](LICENSE)). Bundled components keep their own licenses ([LICENSES.md](LICENSES.md)).
