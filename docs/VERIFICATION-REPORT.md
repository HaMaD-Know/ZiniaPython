# Verification report

Date: 2026-10-20. Written to separate **what was executed and passed** from **what has not been run yet**. Nothing here is a predicted result.

## Environment used

| Item | Value |
| --- | --- |
| OS | Windows 11 Home (10.0.26200), no macOS, no Xcode |
| Node.js / npm | 24.18.1 / 11.16.0 |
| Desktop Python | CPython 3.12.10 (Windows, AMD64) |
| Git | 2.55.0.windows.5 |

Swift and Objective-C can't be compiled on Windows. They are built in `.github/workflows/build-ios.yml` on GitHub's macOS runners; the results of those runs are in the next section.

## iOS build and on-simulator self-test (GitHub Actions)

Repository: https://github.com/HaMaD-Know/ZiniaPython. First fully green run: [Build iOS #7](https://github.com/HaMaD-Know/ZiniaPython/actions/runs/39378527509), commit `fa03bc0`, macOS 26 runner, Xcode 26.5.

| Step | Result |
| --- | --- |
| Lint, type check, frontend tests, runtime tests (macOS, CPython 3.14) | passed |
| iOS project wiring, framework fetch + SHA-256, `lipo` architectures | passed |
| **Simulator build** (Swift + Objective-C compiled and linked, Python build phases) | passed |
| Simulator app bundle check (Python.framework, stdlib, extension frameworks, runtime package, web UI) | passed |
| **Embedded-Python self-test inside the app on the iOS Simulator** | **passed** |
| **Device build** (arm64, Release, unsigned) + bundle check + `ZiniaPython-unsigned.ipa` | passed |
| Signed IPA | skipped: no signing secrets configured |

Self-test report published by the run:

```
Python 3.14.8 (CPython) on iOS 26.5, machine arm64
Initialized: True, start-up 3543 ms
Missing-runtime diagnostic detected: True
PASS  Hello World                     PASS  Output before an exception
PASS  Arithmetic                      PASS  input() with supplied stdin
PASS  Loop                            PASS  __name__ == '__main__'
PASS  Standard library                PASS  sys.exit(3)
PASS  Functions                       PASS  Import a helper module from the project
PASS  Syntax error                    PASS  Create, read, rename and delete a file
PASS  Runtime error                   PASS  Stop a long-running loop
PASS  Missing module
Modules importable: 94/99; unavailable: tkinter, turtle, curses, readline, dbm.gnu
```

Problems found and fixed on the way to this run (runs 1–6): a desktop test that assumed Linux paths on macOS (`/var` vs `/private/var`); module purging across both path forms; the bundled runtime folder renamed from `app` to `python-app` (it clashed with the `App` executable on case-insensitive file systems); a `sysconfig` exception and frozen `os` (no `os.__file__`) in the embedded runtime; and CI reading the full self-test report from the app container. The 3.5 s start-up was measured on a cold simulator; device timing hasn't been measured.

## Executed checks and results

| # | Command | Result | What it proves |
| --- | --- | --- | --- |
| 1 | `npm run lint` | passed | ESLint, no errors |
| 2 | `npm run typecheck` | passed | TypeScript 6.0.3, strict mode |
| 3 | `npm test` | **57 / 57 passed** (8 files) | Frontend logic, including the graphics preview; see the details below |
| 4 | `python -I python/tests/run_tests.py` | **97 passed, 2 skipped** (99 tests) | Runtime engine and graphics modules on real CPython 3.12 |
| 5 | same with `ZINIA_NETWORK_TESTS=1` | **68 / 68 passed** | Including live PyPI analysis (six installable; numpy native-only) |
| 6 | `npm run check:ios` | **77 / 77 checks passed** | Xcode project wiring (below) |
| 7 | `scripts/fetch-python-runtime.ps1` | passed | Download + SHA-256 `157a6b95…e0a3` verified + extraction on Windows |
| 8 | `node scripts/verify-runtime.mjs` | **27 / 27 checks passed** | Real CPython 3.14.8 iOS framework: slices, architectures, platforms, stdlib |
| 9 | `npm run build` + `npx cap sync ios` | passed | Production web bundle; Capacitor sync keeps the native wiring |
| 10 | bundle inspection | passed | No development-bridge code in `dist/` |
| 11 | `bash -n` on all shell scripts | passed | Syntax of 10 build and CI scripts |
| 12 | YAML parse of both workflows | passed | `build-ios.yml` (27 steps), `validate.yml` (3 jobs) |
| 13 | C-API symbol check | passed | Every CPython symbol used by `ZPInterpreter.m` exists in the 3.14.8 headers |
| 14 | `scripts/ci/configure-signing.mjs` dry run | passed | Edits only the App/Release configuration; the project still parses |

### Details

**Runtime engine (`python/tests`, real CPython):** the specification's scripts 1–8 and 12 with exact output comparison; syntax error line and column; traceback contents and the frames hidden from the user; error location inside a helper module; unsaved-buffer lines in tracebacks; working directory and `sys.path`/`sys.argv` restoration; a fresh `__main__` on every run; edited helpers re-imported; packages in subfolders; `input()` with supplied stdin and EOF; stderr separation; `sys.exit` codes; output limit; recursion limit restore; `KeyboardInterrupt` of a busy loop (test 11) and the interpreter still usable afterwards; a script can't permanently disable Stop; the REPL (persistence, incomplete input, block mode, `_`, reset, project imports, `SystemExit`); wheel install/import/uninstall, upgrade, **path-traversal and absolute-path rejection**, native-code rejection, `.data` handling, PyPI classification of five verdicts, dependency resolution with markers and extras, checksum mismatch, HTTPS-only; the bridge JSON protocol, argument validation, the `os._exit` guard, module checks; the self-test runs 15/15 on desktop CPython.

**Frontend (Vitest):** path helpers; runtime state machine (spec section 12 transitions, no overlapping runs, fatal start-up failure); tabs model (test 14: dirty tracking across tabs, close/neighbour, Save As, external-change reload vs conflict, renames, session snapshot); settings sanitising and persistence (test 10); traceback rendering using **fixtures generated by real CPython** (`scripts/generate-error-fixtures.py`); `PythonService` against a **mocked** native plugin (start-up diagnostic for test 15, `UNAVAILABLE` never simulated, output routing, BUSY, interrupt, timeout, input round trip, recovery after a plugin error); workspace files through the **real** `@capacitor/filesystem` web implementation (test 9: create/save/reopen/rename/copy/delete, no temp files left, conflict detection, starter project, search, recent files).

**iOS project wiring (77 checks):** every native source file is compiled; every file reference exists; `Python.xcframework` is linked weakly and embedded with code signing; the build phases are present and ordered (Resources → Install runtime package → Process Python libraries → Embed Frameworks); the required build settings are set in Debug and Release; **both plugins are registered** in `ZiniaBridgeViewController`, which `SceneDelegate` and `Main.storyboard` use; **the method names in the Swift plugins match the TypeScript interfaces exactly, and each has an `@objc` implementation**; the bridging header, Info.plist keys, lock file and the interpreter configuration flags required by the CPython docs are all present; the bundle identifiers match.

**CPython iOS framework (27 checks):** `ios-arm64` slice: arm64, LC_BUILD_VERSION platform *iOS*, minimum 13.0. `ios-arm64_x86_64-simulator`: arm64 (iOS Simulator, 14.0) and x86_64 (iOS Simulator, 13.0). The headers declare Python 3.14.8, matching the lock file. Each architecture has 67 compiled stdlib modules (`_ssl` checked per architecture), the standard library has 2,427 files, and the build helper and plist template are present.

## Graphics engine (zinia_draw, zinia_3d)

| Check | Result | Where it ran |
| --- | --- | --- |
| `python/tests/test_graphics.py` (17 tests): ordered command batches for the spec's 2D and 3D examples, outline/fill, colours, errors pointing at the user's line, animation with simulated touches and keys, `stop_animation`, fps validation, fresh state per run, drawing sent after an error, coalesced 3D changes, remove, validation, tap → object, REPL drawing, **all 12 examples run** | passed | desktop CPython 3.12 |
| `tests/unit/graphics.test.ts` (17 tests): 2D renderer draw order and replay, `set_background`/`clear` retention, canvas fitting and backing-store limit, pointer mapping, stale-run filtering, REPL batches, once-per-frame event posting with move coalescing, nothing posted after a run, malformed payloads, 3D scene model add/set/remove/dispose, default lights, camera home, bad commands | passed | Vitest (jsdom, no WebGL) |
| Self-test case "Graphics modules zinia_draw and zinia_3d" | **passed: 16/16 self-test checks** | iOS Simulator (iOS 26.5, arm64), CPython 3.14.8 inside the app, Build iOS run #8 |
| Browser walkthrough, desktop bridge (below) | passed | Chromium-based browser pane, desktop CPython |
| On an iPhone or iPad | **not run** | no device available |

Browser walkthrough through `npm run dev:bridge`:

- **⋯ › Graphics examples** created the *Graphics Examples* project with 12 programs and opened the first.
- `01_shapes_and_colors.py` → the preview opened beside the editor and showed every shape; the console printed the canvas size.
- `07_rotating_cube.py` → Three.js loaded on first use, the cube rotated, about 40 frames/s measured through the HTTP bridge. **Stop** → *Stopped by KeyboardInterrupt*, the traceback ends at the user's `run_animation` line.
- `11_object_viewer.py` → clicking the sphere printed `Selected blue sphere at (0.0, 1.0, 0.0)` (raycast tap → Python callback).
- iPhone-sized viewport (375×812): the preview covered the editor with the console still visible; two drags on `05_drawing_canvas.py` were drawn by Python; closing the preview returned to the editor and reopening it showed the same picture; fullscreen covered the whole screen and Escape left it.
- REPL: `create_canvas`, `set_background('white')`, a red circle → canvas pixels read back as white at the corner and red in the centre.

Found and fixed during this walkthrough: `set_background()` before the first frame did not repaint (it now fills the canvas); validation errors pointed into `zinia_draw.py` (they now point at the user's line); events of the other surface could reach the wrong handler (they are now filtered by surface).

### Touch: `zinia_draw.on_touch` (2026-10-21)

| Check | Result | Where it ran |
| --- | --- | --- |
| 12 Python tests: `on_touch` exists and rejects non-functions; exact event format (start/move/end/tap, `dx`/`dy`, start position, finger count, cancelled, pointer type); hover and unknown fingers are not touch events; a program that only sets `on_touch` keeps listening; no second loop after `run_animation`; `stop_animation` ends `listen`; `listen` needs a handler; registering again replaces; three runs give identical events (no duplicates); handler errors point at the handler line; the drag example moves only the touched circle, ignores empty space, handles two fingers and clamps to the canvas | passed | desktop CPython 3.12 |
| Vitest: a pointer's move is never merged across its release or tap | passed | jsdom |
| Browser drag, desktop bridge, canvas scaled 800 → 355 CSS px at device pixel ratio 1.41: `13_drag_circles.py` kept running after its last line; dragging the cyan circle from canvas (200, 200) landed it at the predicted (498, 448) (pixel read-back); release removed the held outline; touching empty space did nothing and raised no error; the other circles never moved; Stop, then Run again, started fresh and dragging still worked; Stop prints just `KeyboardInterrupt` | passed | mouse in a Chromium-based browser pane |
| Fingers on an iPhone or iPad | **not run** | no device available |

Frame rates above were measured with the browser pane in the foreground. When the pane was in the background the browser throttled `requestAnimationFrame` and the measured rate fell to 2 frames/s (the 0.5 s acknowledgement timeout), as designed.

### Manual UI walkthrough (desktop development bridge)

The web UI ran in a browser against **desktop CPython 3.12.10** through the same `python/zinia` engine (`npm run dev:bridge`). This exercises the UI and the engine, **not** the iOS runtime. Observed:

- Create a project with starter files → `main.py` opens with syntax highlighting → **Run** prints `Hello, ZiniaPython!` and `3 languages: Python, Swift, TypeScript` (a helper import and a relative data path), *Finished in 4 ms*.
- `errors.py` → real traceback with clickable `File … line N` links, the failing line highlighted, status *IndexError*.
- `ask.py` → an input field appears; entering `Ada` prints `Nice to meet you, Ada!`.
- `loop.py` (infinite loop) → output streams; **Stop** → *Stopped by KeyboardInterrupt*, *Go to line 4*.
- REPL: `x = 6 * 7`, `x` → `42`; a multi-line `for` block with `...` prompts; `import zinia_nope` → traceback with an explanation.
- Reloading the page restores the open tabs.
- iPhone-sized viewport (375×812): compact layout with bottom navigation and the console sheet.
- Settings → **Run self-test** → *15/15 checks passed, 93/99 modules importable* (desktop Windows Python 3.12 lacks the 3.13/3.14-only modules and the Unix-only modules).
- Packages → check `six` → *Can be installed* → **Install** → resolve, download, SHA-256 check and unpack logged; `six 1.17.0` listed. Check `numpy` → *Not installable on iOS*, compiled for Linux, Linux (musl), Windows, macOS.
- The plain web preview (`npm run dev`, no bridge) shows *No Python runtime in the web preview*, with Run disabled and nothing simulated.

One finding came from this walkthrough. The first `import numpy` on this PC took 18 s inside the bridge (Windows Store Python). It was slow, not a hang. As a precaution, the bridge's protocol was isolated from C-level stdout writes.

## Specification tests (section 17)

| Test | Status | Evidence |
| --- | --- | --- |
| 1 Hello World | **PASSED** (desktop CPython and **iOS Simulator**) | `test_01_hello_world`; UI walkthrough; part of the CI simulator self-test |
| 2 Arithmetic | **PASSED** (desktop and **iOS Simulator**) | `test_02_arithmetic` |
| 3 Loop | **PASSED** (desktop and **iOS Simulator**) | `test_03_loop` |
| 4 Standard library | **PASSED** (desktop and **iOS Simulator**) | `test_04_standard_library` |
| 5 Functions | **PASSED** (desktop and **iOS Simulator**) | `test_05_functions` |
| 6 Syntax error | **PASSED** (desktop and **iOS Simulator**) | `test_06_syntax_error` (line 1, offset 12) |
| 7 Runtime error | **PASSED** (desktop + UI + **iOS Simulator**) | `test_07_runtime_error_traceback`; UI traceback |
| 8 User modules | **PASSED** (desktop + UI + **iOS Simulator**) | `test_08*`; starter project run in the UI |
| 9 Filesystem | **PASSED** (Python level on desktop and iOS Simulator; Capacitor Filesystem web implementation) · iOS Filesystem plugin from the UI not run | `test_09_*`, `workspace.test.ts` |
| 10 Persistence | **PASSED** (unit tests + UI reload + package persisted on disk) · NOT RUN on iOS | `settings.test.ts`, `tabsModel.test.ts`, `workspace.test.ts` |
| 11 Long-running script / Stop | **PASSED** (desktop + UI Stop + service contract + KeyboardInterrupt on the **iOS Simulator**) | `test_11_busy_loop_is_interrupted`. The iOS-specific `PyErr_SetInterruptEx` + `pthread_kill` path hasn't been executed. |
| 12 Missing module | **PASSED** (desktop + REPL in UI + **iOS Simulator**) | `test_12_missing_module` |
| 13 Document picker | **NOT RUN** | Needs an iOS device or simulator with user interaction and Apple's picker UI. Implemented in `ZiniaFilesPlugin.swift`. |
| 14 Multiple tabs | **PASSED** | `tabsModel.test.ts`, UI walkthrough |
| 15 Runtime initialization failure | **PASSED** (frontend diagnostic, web `UNAVAILABLE` path, and native bundle-layout diagnostic on the **iOS Simulator**) | `pythonService.test.ts`. The native bundle-layout check is part of the CI simulator self-test (`missingRuntimeDiagnostic`) and of the `-ZiniaSimulateMissingStdlib YES` launch argument. |

"iOS Simulator" means the case ran inside the real app through `ZiniaSelfTestRunner` in CI. Physical devices haven't been tested. That self-test executes cases 1–8, 9 (Python level), 11 (busy-loop interrupt), 12, the missing-runtime diagnostic, and 99 module imports inside the real embedded runtime.

## Quality gates (section 20)

1. **Is the editor functional?** Yes, in a browser (CodeMirror 6: highlighting, tabs, find/replace, completions, Run). Not yet on iOS.
2. **Is the native Capacitor plugin registered?** Yes: `ZiniaBridgeViewController.capacitorDidLoad()` calls `registerPluginInstance` for both plugins, and the static checks confirm the wiring and the method parity with TypeScript. It compiles and runs: the simulator self-test goes through it.
3. **Is CPython actually bundled, or only planned?** The build **integrates a real, verified CPython 3.14.8 iOS framework**: pinned and checksummed, with architectures verified, linked and embedded by the project, and the stdlib installed by a build phase. Bundled for real: `verify-app-bundle.sh` confirmed Python.framework, the standard library and the converted extension frameworks in both the simulator and device builds, and CPython 3.14.8 ran inside the app.
4. **Does Run call the real interpreter?** Yes. `ZiniaApp.runTab` → `PythonService.runScript` → `ZiniaPython.execute` → `ZiniaPythonPlugin.execute` → `ZPInterpreter submit` → `zinia.bridge.handle` → `executor.run_script`. There's no fallback: the web build rejects with `UNAVAILABLE` (observed).
5. **Does output appear in the console?** Yes with desktop CPython (UI walkthrough). Inside the app the runtime ran the self-test scripts and captured their output; the visual console on iOS hasn't been checked by a person yet.
6. **Are tracebacks returned correctly?** Yes: real CPython tracebacks, structured frames and location (tests and UI).
7. **Are files saved locally?** Yes: Capacitor Filesystem (web implementation) and disk via the dev bridge. The iOS implementation isn't run yet.
8. **Can user-selected folders be accessed within iOS rules?** Implemented with the document picker, security-scoped access and bookmarks. **Not run.**
9. **Are helper modules importable?** Yes (tests and UI).
10. **Is the standard library present?** Present in the framework (2,427 files, 67 extension modules per architecture). It is present in the app: 94 of 99 checked modules imported on the iOS Simulator.
11. **Does the package manager report compatibility honestly?** Yes, verified against live PyPI.
12. **Can GitHub Actions build the project?** Yes: Build iOS run #7 passed end to end (simulator build, self-test, unsigned device IPA).
13. **Is code signing documented?** Yes ([SIGNING.md](SIGNING.md)), with an unsigned path, a re-signing path and a secrets-based path.
14. **Are any build steps placeholders?** No. The signed path runs only when signing secrets exist.
15. **Which tests were executed?** All of the above: 39 frontend tests, 68 runtime tests, 77 project checks, 27 runtime-framework checks, and the manual UI walkthrough against desktop CPython.
16. **What remains incomplete?**
    - Installing on a physical iPhone or iPad (needs signing; see SIGNING.md).
    - On-device testing: document picker, opened folders and iCloud, the keyboard key bar, the memory guard, Stop through `pthread_kill`, installing a signed IPA.
    - App Store submission requirements (privacy manifests for OpenSSL; see LICENSES.md).
    - Out of scope by design: a language server (no go-to-definition or type checking).

## How to extend this report

Each **Build iOS** run publishes the self-test summary as an annotation on the run page, and the full JSON in the `ZiniaPython-build-logs` artifact (`selftest/simulator-selftest.json`). After testing on a device, add those results here.
