# Architecture

## Components

| Layer | Files | Responsibility |
| --- | --- | --- |
| Web UI | `src/**` | Editor, tabs, console, REPL, file explorer, packages, settings. Plain TypeScript, no framework. |
| Plugin contracts | `src/plugins/zinia-python.ts`, `src/plugins/zinia-files.ts` | Typed interfaces of the two native plugins. `npm run check:ios` checks that the TypeScript and Swift method lists match. |
| Runtime service | `src/services/python.ts`, `runtimeMachine.ts` | Lifecycle state machine, one execution at a time, output and input routing, timeouts, interrupt. |
| Swift plugins | `ios/App/App/ZiniaPython/ZiniaPythonPlugin.swift`, `ZiniaFilesPlugin.swift` | Argument validation, JSON requests, output batching, memory guard, document picker, folder bookmarks, coordinated file I/O. |
| Interpreter host | `ios/App/App/ZiniaPython/ZPInterpreter.h/.m` | CPython initialisation, dedicated interpreter thread, the `_zinia_native` built-in module, interrupts, `input()` waits, HTTPS through URLSession. |
| Runtime engine | `python/zinia/*.py` | Request handling, script execution, REPL, error description, self-test, package installer. Bundled into the app as `app/zinia`. |
| Build phases | `ios/App/scripts/*.sh` | Copy the runtime package into the app; copy the standard library and convert extension modules into signed frameworks (CPython iOS docs, step 7). |

Registration: `SceneDelegate` creates `ZiniaBridgeViewController`, a `CAPBridgeViewController` subclass whose `capacitorDidLoad()` calls `bridge?.registerPluginInstance(...)` for both plugins. This is Capacitor's documented way to register plugins compiled into the app target. npm-installed plugins (Filesystem, Keyboard, App, Status Bar) come through Swift Package Manager (`ios/App/CapApp-SPM`).

## The CPython embedding

`ZPInterpreter.m` follows the official guide (https://docs.python.org/3/using/ios.html, "Adding Python to an iOS project", step 8):

- `PyPreConfig_InitIsolatedConfig` with `utf8_mode = 1`, then `Py_PreInitialize`.
- `PyImport_AppendInittab("_zinia_native", …)` registers the bridge module.
- `PyConfig_InitIsolatedConfig` with `buffered_stdio = 0`, `write_bytecode = 0`, `install_signal_handlers = 1`, `use_system_logger = 1`, `home = <App.app>/python`, and an explicit module search path: `python/lib/python3.X`, `python/lib/python3.X/lib-dynload`, `app`.
- `Py_InitializeFromConfig`, `import zinia.bridge`, `zinia.bridge.initialize(config_json)`, then `PyEval_SaveThread()` releases the GIL.

Before touching CPython, the host checks that `Py_InitializeFromConfig` is loaded (`dlsym`) and that `os.py`, `encodings/` and `lib-dynload/` exist in the bundle. A missing piece becomes a structured error (`FRAMEWORK_MISSING`, `STDLIB_MISSING`, `SUPPORT_MISSING`) that the UI shows as a diagnostic panel. `Python.framework` is **weakly linked**, so a missing framework is reported instead of crashing at launch.

CPython is initialised **once per process**. If initialisation fails after CPython has been touched, the state becomes `failed`, and later attempts report `ALREADY_FAILED` instead of re-initialising. Many extension modules don't support `Py_Finalize` + `Py_Initialize` in one process, so ZiniaPython never does that. "Reset interpreter state" is a *soft* reset: a new REPL namespace, user modules removed from `sys.modules`, `gc.collect()`.

## Execution model

- **One interpreter, one thread.** CPython is started on a dedicated `NSThread` with an 8 MB stack. Because that thread called `Py_Initialize`, it is Python's *main thread*. This matters: Python runs signal handlers only on its main thread, so `KeyboardInterrupt` works there.
- **One request at a time.** Every request (run, REPL entry, package operation, self-test) is a JSON string queued to that thread and passed to `zinia.bridge.handle()`. The Swift plugin rejects a second request with `BUSY` instead of queuing it behind a script that might never end. The web UI's state machine prevents overlap in the first place.
- **Scripts:** every run gets a fresh `__main__` module, `sys.argv = [file]`, `sys.path[0]` = the script's folder followed by the project root, and the working directory = the project folder (or the file's folder, if configured). Modules imported from your workspace are removed from `sys.modules` before and after each run, so edits to `helpers.py` take effect immediately. The unsaved editor text is registered in `linecache`, so tracebacks show the code that actually ran. Afterwards, `sys.path`, `sys.argv`, the working directory, the recursion limit, trace and profile hooks, the SIGINT handler and the standard streams are restored.
- **REPL:** a separate, persistent namespace. Script runs never change REPL variables, and resetting the REPL never touches files. Line mode uses `codeop` semantics, so incomplete input shows a `...` prompt. Block mode executes a whole block and displays the value of the last expression.
- **Not undone after a run:** threads the script started, files it wrote, and standard-library modules it imported. Background threads that print after their script ends appear in the console as background output.

### Output

`sys.stdout` and `sys.stderr` are replaced once, at start-up, by routers that send text to the active run. A router calls `_zinia_native.emit_output()`. The Swift `ZiniaOutputBatcher` merges consecutive chunks and delivers at most about 20 events per second (sooner when 32 KB is pending) as the Capacitor event `output`. Before a run's promise resolves, the batcher is flushed, so all output arrives before the result. Each run forwards at most 2,000,000 characters to the UI; the script keeps running after the limit.

Output written straight to file descriptor 1 or 2 by C code (not through `sys.stdout`) goes to the iOS system log, not the console.

### Input

`sys.stdin.readline()` (and so `input()`) first uses any text supplied with the request (`stdin` option). After that it calls `_zinia_native.read_input()`, which flushes output, emits `inputRequest`, releases the GIL and waits on a semaphore. The console shows an input field; `provideInput` signals the semaphore. **EOF** makes `input()` raise `EOFError`; **Stop** while waiting raises `KeyboardInterrupt`.

### Stop and interrupt

`interrupt(executionId)`:

1. If the run is waiting in `input()`, the wait is cancelled and `read_input` raises `KeyboardInterrupt`.
2. Otherwise `PyErr_SetInterruptEx(SIGINT)` is called, exactly what Ctrl+C does. Python raises `KeyboardInterrupt` at the next bytecode boundary.
3. If Python's SIGINT handler (or a script's own handler) is installed, a real `SIGINT` is also sent to the interpreter thread with `pthread_kill`. This makes blocking calls such as `time.sleep()` and socket reads return early. It is never sent while SIGINT has its default disposition, because that would terminate the app.

**Limits:** a single long-running C operation (for example `sum(range(10**12))`, or a huge regular-expression backtrack) can't be interrupted until it returns. A script that catches `KeyboardInterrupt` and keeps going can't be stopped either. In those cases, force-quit the app. The UI's Stop button shows the real state: *Stopping…* stays until the run actually ends.

### Memory guard

While a script runs, the plugin polls `os_proc_available_memory()` every 0.5 s and listens for memory warnings. Below 96 MB of headroom it interrupts the run and prints a notice, because iOS would otherwise terminate the whole app.

### `os._exit()`

`os._exit()` would end the whole iOS process, closing the IDE. ZiniaPython replaces it with a version that prints a notice and raises `SystemExit`. `sys.exit()` and `exit()` behave as normal and end only the script.

## Files

- **Workspace:** the app's `Documents` folder, accessed through the official `@capacitor/filesystem` plugin. Saves go to a temporary file that is then renamed over the target. The modification time loaded with the file is checked before saving, so a change made by another app produces a conflict prompt instead of being silently overwritten. `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` show the workspace in the Files app.
- **Opened folders:** `ZiniaFilesPlugin` presents `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])`. It starts security-scoped access and stores a bookmark (`Application Support/ZiniaPython/folder-bookmarks.json`). Stale bookmarks are refreshed, and unavailable folders produce a "select it again" message. Reads and writes use `NSFileCoordinator`, and writes use `Data.write(.atomic)`. iCloud placeholders that aren't downloaded yet start downloading and report `NOT_DOWNLOADED`.
- **Python and opened folders:** while a folder is open, its security-scoped access lets Python read and write it too, so projects can run from iCloud Drive. The native plugins accept working directories and project roots only inside the workspace, an opened folder, or the app's temporary directory.
- **Path safety:** native and web code reject absolute paths, `..` segments and NUL characters in root-relative paths. Deleting a root is refused.

## Packages

See [PACKAGES.md](PACKAGES.md). In short: `python/zinia/packages.py` uses PyPI's JSON API through `URLSession` (the iOS trust store). It installs only pure-Python wheels, verifies SHA-256, unpacks into `Application Support/ZiniaPython/site-packages` with path-traversal checks, records a `RECORD` file, and uninstalls exactly those files.

## Desktop development bridge

`npm run dev:bridge` starts the Vite dev server in mode `bridge`. The plugin in `vite-dev-bridge.ts` runs `scripts/dev-bridge-worker.py` with the developer's own Python. That worker loads the same `python/zinia` package and provides a desktop stand-in for `_zinia_native`. Requests need the `X-Zinia-Dev: 1` header, so other websites can't use the bridge. The bridge exists only in the dev server: production builds constant-fold `import.meta.env.DEV` to `false` and drop it entirely.

## Security model

ZiniaPython runs your code in the app's own process with the app's permissions. **It is not a sandbox.** Within the iOS app sandbox, a script can read, change or delete the workspace, packages, settings storage and any folder you opened. It can make network connections. It can't escape the iOS sandbox: other apps' data and system locations stay protected by iOS.

ZiniaPython itself sends nothing anywhere. There are no analytics. Network requests happen only for package checks and installs, or when your own scripts make them.
