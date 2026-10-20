"""Runtime self-test.

Runs inside whatever interpreter imports it - the embedded iOS runtime when
started from the app (Settings > Runtime > Run self-test, or the
``--zinia-selftest`` launch argument used by CI on the iOS Simulator), or
desktop CPython in the unit tests. Nothing here is simulated: every module is
actually imported and every script is actually executed.
"""

from __future__ import annotations

import importlib
import os
import platform
import shutil
import sys
import tempfile
import threading
import time
import _thread

from . import executor, module_info

# The modules the specification requires, followed by a broader sample.
REQUIRED_MODULES = [
    "sys", "os", "json", "math", "random", "pathlib", "datetime", "re", "statistics",
    "collections", "itertools", "functools", "unittest",
]
EXTRA_MODULES = [
    "asyncio", "threading", "sqlite3", "ssl", "hashlib", "hmac", "secrets", "zlib", "gzip", "bz2", "lzma",
    "zipfile", "tarfile", "decimal", "fractions", "ctypes", "socket", "select", "urllib.request",
    "http.client", "email", "html.parser", "xml.etree.ElementTree", "xml.dom.minidom", "csv",
    "unicodedata", "zoneinfo", "uuid", "tempfile", "shutil", "glob", "fnmatch", "io", "struct", "array",
    "heapq", "bisect", "string", "textwrap", "typing", "dataclasses", "enum", "logging", "argparse",
    "pickle", "copy", "pprint", "time", "calendar", "base64", "binascii", "codecs", "locale", "gettext",
    "contextlib", "abc", "operator", "traceback", "inspect", "dis", "ast", "tokenize", "timeit", "doctest",
    "difflib", "queue", "sched", "concurrent.futures", "importlib.metadata", "sysconfig", "platform",
    "webbrowser", "signal", "subprocess", "multiprocessing", "dbm.sqlite3", "compression.zstd",
    # Expected to be unavailable on iOS; included so the report explains why.
    "tkinter", "turtle", "curses", "readline", "dbm.gnu", "dbm.ndbm", "venv", "ensurepip", "idlelib",
]

# (id, title, source, expected stdout or None, checker name)
SCRIPT_CASES = [
    ("hello", "Hello World", 'print("Hello, ZiniaPython!")\n', "Hello, ZiniaPython!\n"),
    ("arithmetic", "Arithmetic", "print(2 + 3 * 4)\n", "14\n"),
    ("loop", "Loop", "for i in range(3):\n    print(i)\n", "0\n1\n2\n"),
    ("stdlib-json", "Standard library", 'import json\nprint(json.dumps({"ok": True}))\n', '{"ok": true}\n'),
    ("functions", "Functions", "def add(a, b):\n    return a + b\n\nprint(add(20, 22))\n", "42\n"),
    ("syntax-error", "Syntax error", "def broken(:\n    pass\n", None),
    ("runtime-error", "Runtime error", "print(1 / 0)\n", None),
    ("missing-module", "Missing module", "import zinia_selftest_module_that_does_not_exist\n", None),
    ("print-then-raise", "Output before an exception",
     'print("Hello from ZiniaPython")\nraise ValueError("Example error")\n', "Hello from ZiniaPython\n"),
    ("stdin", "input() with supplied stdin", 'name = input("Name? ")\nprint("Hi", name)\n', "Name? Hi Ada\n"),
    ("main-guard", "__name__ == '__main__'", 'if __name__ == "__main__":\n    print("main")\n', "main\n"),
    ("sys-exit", "sys.exit(3)", "import sys\nsys.exit(3)\n", ""),
    ("graphics", "Graphics modules zinia_draw and zinia_3d",
     "import zinia_draw as gfx\nimport zinia_3d as scene\ngfx.create_canvas(200, 100)\n"
     "gfx.rectangle(10, 10, 50, 30, color='#ff00aa')\ngfx.circle(100, 50, 20, color='cyan')\n"
     "gfx.text(5, 80, 'ok', size=12)\ngfx.show()\nscene.create_scene()\n"
     "box = scene.add_box(width=2, height=2, depth=2, color='#00ffff')\nbox.rotate(0, 0.5, 0)\n"
     "scene.add_light('ambient', intensity=0.7)\nscene.set_camera(position=(6, 5, 8))\nscene.show()\n"
     "print(gfx.size(), len(scene.objects()))\n", "(200, 100) 2\n"),
]


def check_modules(names=None) -> list[dict]:
    results = []
    for name in names or (REQUIRED_MODULES + EXTRA_MODULES):
        entry = {"module": name, "required": name in REQUIRED_MODULES}
        started = time.perf_counter()
        try:
            module = importlib.import_module(name)
        except BaseException as exc:  # noqa: BLE001 - report every failure mode
            entry["available"] = False
            entry["error"] = f"{type(exc).__name__}: {exc}"
            missing = getattr(exc, "name", None) or name
            entry["help"] = module_info.explain_missing(missing if isinstance(exc, ImportError) else name)
        else:
            entry["available"] = True
            entry["file"] = getattr(module, "__file__", None) or "(built-in)"
            if name in module_info.LIMITED:
                entry["note"] = module_info.LIMITED[name]
        entry["ms"] = round((time.perf_counter() - started) * 1000, 2)
        results.append(entry)
    return results


def _case(case_id, title, passed, **detail):
    return {"id": case_id, "title": title, "passed": bool(passed), **detail}


def _run(code, filename, cwd, **kw):
    return executor.run_script(executor.RunRequest(
        execution_id=f"selftest-{time.perf_counter_ns()}", code=code, filename=filename, cwd=cwd,
        project_root=cwd, capture=True, **kw), user_roots=(cwd,))


def run_script_cases(workdir: str) -> list[dict]:
    out = []
    for case_id, title, source, expected in SCRIPT_CASES:
        path = os.path.join(workdir, f"{case_id.replace('-', '_')}.py")
        stdin = "Ada\n" if case_id == "stdin" else None
        result = _run(source, path, workdir, stdin=stdin)
        stdout = result.get("stdout", "")
        err = result.get("error") or {}
        if case_id == "syntax-error":
            ok = result["status"] == "error" and err.get("category") == "syntax" and err.get("syntax", {}).get("lineno") == 1
        elif case_id == "runtime-error":
            ok = (result["status"] == "error" and err.get("type") == "ZeroDivisionError"
                  and "Traceback (most recent call last)" in err.get("traceback", "")
                  and err.get("location", {}).get("lineno") == 1)
        elif case_id == "missing-module":
            ok = (result["status"] == "error" and err.get("category") == "import"
                  and err.get("missingModule") == "zinia_selftest_module_that_does_not_exist")
        elif case_id == "print-then-raise":
            ok = stdout == expected and err.get("type") == "ValueError" and err.get("location", {}).get("lineno") == 2
        elif case_id == "sys-exit":
            ok = result["status"] == "exit" and result["exitCode"] == 3
        else:
            ok = result["status"] == "ok" and stdout == expected
        out.append(_case(case_id, title, ok, status=result["status"], stdout=stdout[:2000],
                         expected=expected, errorType=err.get("type"), durationMs=result["durationMs"]))
    return out


def run_project_case(workdir: str) -> dict:
    project = os.path.join(workdir, "MyProject")
    os.makedirs(os.path.join(project, "data"), exist_ok=True)
    with open(os.path.join(project, "helpers.py"), "w", encoding="utf-8") as fh:
        fh.write("def greet(name):\n    return f'Hello, {name}!'\n")
    with open(os.path.join(project, "data", "example.json"), "w", encoding="utf-8") as fh:
        fh.write('{"name": "ZiniaPython"}\n')
    main_source = ("import json\nfrom helpers import greet\n"
                   "with open('data/example.json', encoding='utf-8') as fh:\n"
                   "    print(greet(json.load(fh)['name']))\n")
    main = os.path.join(project, "main.py")
    with open(main, "w", encoding="utf-8") as fh:
        fh.write(main_source)
    first = _run(main_source, main, project)
    # Edit the helper and run again: the new version must be imported.
    with open(os.path.join(project, "helpers.py"), "w", encoding="utf-8") as fh:
        fh.write("def greet(name):\n    return f'Hi again, {name}!'\n")
    second = _run(main_source, main, project)
    ok = (first.get("stdout") == "Hello, ZiniaPython!\n" and second.get("stdout") == "Hi again, ZiniaPython!\n")
    return _case("user-modules", "Import a helper module from the project", ok,
                 stdout=[first.get("stdout"), second.get("stdout")], status=[first["status"], second["status"]])


def run_filesystem_case(workdir: str) -> dict:
    code = (
        "import os\n"
        "with open('notes.txt', 'w', encoding='utf-8') as f:\n    f.write('héllo ✓\\n')\n"
        "with open('notes.txt', encoding='utf-8') as f:\n    text = f.read()\n"
        "os.rename('notes.txt', 'renamed.txt')\n"
        "print(text.strip(), os.path.exists('renamed.txt'))\n"
        "os.remove('renamed.txt')\n"
        "print(os.path.exists('renamed.txt'))\n"
    )
    result = _run(code, os.path.join(workdir, "fs_case.py"), workdir)
    ok = result["status"] == "ok" and result.get("stdout") == "héllo ✓ True\nFalse\n"
    return _case("filesystem", "Create, read, rename and delete a file", ok, stdout=result.get("stdout"),
                 status=result["status"])


def run_interrupt_case(workdir: str) -> dict:
    """A busy loop must stop with KeyboardInterrupt when interrupted."""
    if threading.current_thread() is not threading.main_thread():
        return _case("interrupt", "Stop a long-running loop", False, skipped=True,
                     reason="Interrupts are delivered to the interpreter's main thread only.")
    timer = threading.Timer(0.3, _thread.interrupt_main)
    started = time.perf_counter()
    timer.start()
    try:
        result = _run("n = 0\nwhile True:\n    n += 1\n", os.path.join(workdir, "loop.py"), workdir)
    finally:
        timer.cancel()
    elapsed = time.perf_counter() - started
    ok = result["status"] == "interrupted" and elapsed < 10
    return _case("interrupt", "Stop a long-running loop", ok, status=result["status"],
                 seconds=round(elapsed, 3))


def run_all(include_modules: bool = True) -> dict:
    started = time.perf_counter()
    workdir = tempfile.mkdtemp(prefix="zinia-selftest-")
    try:
        cases = run_script_cases(workdir)
        cases.append(run_project_case(workdir))
        cases.append(run_filesystem_case(workdir))
        cases.append(run_interrupt_case(workdir))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    modules = check_modules() if include_modules else []
    required_missing = [m["module"] for m in modules if m["required"] and not m["available"]]
    failed = [c["id"] for c in cases if not c["passed"] and not c.get("skipped")]
    return {
        "python": sys.version,
        "implementation": platform.python_implementation(),
        "platform": sys.platform,
        "machine": platform.machine(),
        "cases": cases,
        "modules": modules,
        "summary": {
            "casesPassed": sum(1 for c in cases if c["passed"]),
            "casesFailed": len(failed),
            "failedCases": failed,
            "modulesAvailable": sum(1 for m in modules if m["available"]),
            "modulesChecked": len(modules),
            "requiredModulesMissing": required_missing,
            "ok": not failed and not required_missing,
            "seconds": round(time.perf_counter() - started, 3),
        },
    }
