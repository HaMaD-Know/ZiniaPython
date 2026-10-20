# Known limitations

These come from iOS itself, from CPython's iOS support, or from the design choices explained here. None of them are hidden in the app: errors say which case applies.

## Running code

- **No subprocesses.** iOS doesn't let apps start other programs. `subprocess.run()`, `os.system()`, `os.fork()` and multiprocessing worker processes fail. Use `threading` or `concurrent.futures.ThreadPoolExecutor` instead.
- **One interpreter, one script at a time.** Runs, REPL entries and package operations take turns on one interpreter thread. A second run while one is active is refused (`BUSY`).
- **Stop is cooperative.** It raises `KeyboardInterrupt` (and wakes blocking sleeps and I/O). A single long C-level operation finishes before the interrupt takes effect, and a script that swallows `KeyboardInterrupt` can't be stopped. Force-quit the app in those cases. The optional run time limit uses the same mechanism.
- **No true restart.** CPython is initialised once per app launch. *Reset interpreter state* clears REPL variables and your imported modules; a full restart means relaunching the app.
- **Shared interpreter state.** Standard-library modules a script imports stay imported. Threads a script starts keep running after it ends; their output appears as background output. A file in your project named like an already-imported standard-library module (for example `random.py`) is shadowed by the standard library.
- **C-level output.** Text that C extensions write directly to file descriptors 1 and 2 goes to the iOS system log, not the console.
- **`os._exit()`** is converted to `SystemExit`, because it would close the app.
- **Memory.** iOS terminates apps that use too much memory. The memory guard stops a script when the app is close to the limit, but very fast allocations can still win the race.
- **Background.** iOS suspends apps in the background. A running script pauses while ZiniaPython isn't in the foreground, and servers started by scripts aren't reachable then.
- **Stack depth.** The interpreter thread has an 8 MB stack. The default recursion limit (1000) is safe; raising it far beyond can crash.

## Standard library

Present and working: everything in the self-test's module list except the modules below. That includes `json`, `math`, `pathlib`, `sqlite3`, `ssl`, `hashlib`, `zlib`/`bz2`/`lzma`/`compression.zstd`, `ctypes`, `asyncio`, `threading`, `socket`, `urllib.request`, `decimal`, `unittest`, `zoneinfo` and `xml`. The self-test (*Settings › Python runtime*) shows the real status on your device.

Not available:

| Module | Reason (category) |
| --- | --- |
| `tkinter`, `turtle`, `idlelib`, `turtledemo` | Tk isn't part of the CPython iOS build (native extension) |
| `curses`, `readline` | No terminal libraries on iOS (OS feature). The console has its own line editing. |
| `dbm.gnu`, `dbm.ndbm` | Libraries not in the iOS build (native extension). Use `dbm.sqlite3` or `sqlite3`. |
| `venv`, `ensurepip`, `pip` | Separate executables can't run on iOS (iOS restriction). Use the Packages screen. |
| `subprocess` / `multiprocessing` process creation | Modules import, but starting processes fails (iOS restriction) |
| Modules removed in Python 3.12/3.13 (`distutils`, `imp`, `cgi`, `telnetlib`, …) | Removed from Python (PEP 594/632) |

`webbrowser` opens URLs outside the app. `ctypes` can call only code that is already loaded into the app.

## Files

- ZiniaPython can access **its own workspace**, plus **folders and files you choose** with Apple's document picker. It can't browse the whole device or other apps' data. iOS doesn't allow that, and ZiniaPython never tries to bypass it (no jailbreak).
- Opened folders depend on their storage provider. iCloud Drive files may need to download first (`NOT_DOWNLOADED`, try again). Some providers don't support every operation (rename, copy, delete). Errors say what failed.
- Folder access is remembered with a bookmark. If the provider signs out or the folder moves, you must select it again.
- Deleting in the workspace is permanent. In opened folders, the provider decides whether deleted items go to *Recently Deleted*.
- Files larger than 20 MB aren't opened in the editor. Files over 5 MB ask first, and non-text files open as text only after a warning.

## Packages

- Only **pure-Python** packages can be installed on the device. Packages with compiled code must be bundled at build time ([PACKAGES.md](PACKAGES.md)).
- The resolver is greedy: it reports dependency conflicts instead of searching for alternative versions.

## Editor

- Suggestions are local and lexical (keywords, built-ins, common module members, names in the file, project modules). There's **no language server**: no type inference, go-to-definition or linting.

## Building and installing

- Building the app needs macOS with Xcode. GitHub Actions provides that; a Windows PC can't build iOS apps by itself.
- An unsigned IPA can't be installed until it's signed. Free Apple ID signing expires after 7 days ([SIGNING.md](SIGNING.md)).
