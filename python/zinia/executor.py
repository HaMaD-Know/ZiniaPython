"""Script execution.

Every run gets:

* a fresh ``__main__`` module, so ``if __name__ == "__main__":`` works and no
  globals leak from one run into the next;
* ``sys.argv`` set to the script path;
* ``sys.path[0]`` set to the script's folder, followed by the project root, so
  ``import helpers`` finds ``helpers.py`` next to ``main.py``;
* the requested working directory (the project root by default), because the
  process' current directory is otherwise unrelated to the active file;
* a fresh import of the user's own modules: anything previously imported from
  the workspace is dropped from ``sys.modules`` before and after the run, so
  edits to ``helpers.py`` are picked up the next time.

All runs share one interpreter, executed serially on one thread by the native
host. Interpreter-wide state that a script changes (``sys.path``,
``sys.argv``, the working directory, the recursion limit, the SIGINT handler,
the standard streams, trace/profile hooks) is restored afterwards. State the
script creates elsewhere - threads it started, files it wrote, modules from the
standard library it imported - is not undone.
"""

from __future__ import annotations

import builtins
import importlib
import linecache
import os
import signal
import sys
import threading
import time
import types
from contextlib import contextmanager
from dataclasses import dataclass, field

from . import errors, streams

_PROTECTED_MODULES = {"__main__", "builtins", "sys"}


@dataclass
class RunRequest:
    execution_id: str
    code: str
    filename: str = "<untitled>"
    cwd: str | None = None
    project_root: str | None = None
    args: list[str] = field(default_factory=list)
    stdin: str | None = None
    capture: bool = False
    output_limit: int = streams.DEFAULT_OUTPUT_LIMIT


def _norm(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _is_real_path(filename: str) -> bool:
    return bool(filename) and not filename.startswith("<") and os.path.isabs(filename)


def _root_prefixes(roots) -> tuple[str, ...]:
    """Both the given and the symlink-resolved form of each root.

    On Apple platforms the same folder is reachable as /var/... and
    /private/var/...; a module may have been imported through either form.
    """
    prefixes = set()
    for root in roots:
        if not root:
            continue
        for form in (os.path.abspath(root), os.path.realpath(root)):
            prefixes.add(os.path.normcase(form).rstrip("\\/") + os.sep)
    return tuple(prefixes)


_resolved_cache: dict[str, str] = {}


def _resolved(path: str) -> str:
    """Symlink-resolved, normalised path; cached because it is asked for every
    imported module on every run and module locations rarely change."""
    cached = _resolved_cache.get(path)
    if cached is None:
        cached = os.path.normcase(os.path.realpath(path))
        if len(_resolved_cache) > 20_000:
            _resolved_cache.clear()
        _resolved_cache[path] = cached
    return cached


def purge_user_modules(roots) -> list[str]:
    """Remove modules imported from any of ``roots`` from ``sys.modules``."""
    prefixes = _root_prefixes(roots)
    if not prefixes:
        return []
    removed = []
    for name, module in list(sys.modules.items()):
        if name in _PROTECTED_MODULES or name == "zinia" or name.startswith("zinia."):
            continue
        if module is None:
            continue
        locations = []
        file = getattr(module, "__file__", None)
        if isinstance(file, str):
            locations.append(file)
        else:
            path = getattr(module, "__path__", None)
            try:
                locations.extend(p for p in (path or []) if isinstance(p, str))
            except TypeError:
                pass
        for loc in locations:
            if _norm(loc).startswith(prefixes) or _resolved(loc).startswith(prefixes):
                sys.modules.pop(name, None)
                removed.append(name)
                break
    if removed:
        importlib.invalidate_caches()
    return removed


@contextmanager
def interpreter_state_guard():
    """Restore interpreter-wide settings a user script may have changed."""
    saved_cwd = os.getcwd()
    saved_path = list(sys.path)
    saved_argv = list(sys.argv)
    saved_main = sys.modules.get("__main__")
    saved_recursion = sys.getrecursionlimit()
    saved_trace = sys.gettrace()
    saved_profile = sys.getprofile()
    saved_dont_write = sys.dont_write_bytecode
    # Never write __pycache__ folders into the user's project, and never trust
    # timestamp-based bytecode for files that are edited seconds apart.
    sys.dont_write_bytecode = True
    saved_sigint = None
    on_main_thread = threading.current_thread() is threading.main_thread()
    if on_main_thread:
        try:
            saved_sigint = signal.getsignal(signal.SIGINT)
        except (ValueError, OSError):  # pragma: no cover
            saved_sigint = None
    try:
        yield
    finally:
        try:
            os.chdir(saved_cwd)
        except OSError:
            pass
        sys.path[:] = saved_path
        sys.argv = saved_argv
        if saved_main is not None:
            sys.modules["__main__"] = saved_main
        else:
            sys.modules.pop("__main__", None)
        if sys.getrecursionlimit() != saved_recursion:
            sys.setrecursionlimit(saved_recursion)
        sys.dont_write_bytecode = saved_dont_write
        sys.settrace(saved_trace)
        sys.setprofile(saved_profile)
        threading.settrace(None)  # type: ignore[arg-type]
        threading.setprofile(None)  # type: ignore[arg-type]
        if on_main_thread and saved_sigint is not None:
            try:
                if signal.getsignal(signal.SIGINT) is not saved_sigint:
                    signal.signal(signal.SIGINT, saved_sigint)
            except (ValueError, OSError, TypeError):  # pragma: no cover
                pass
        streams.ensure_installed()


def register_source(filename: str, code: str) -> None:
    """Let tracebacks show the exact source that ran, even if unsaved."""
    lines = code.splitlines(keepends=True)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    # A ``None`` mtime marks the entry as not backed by a file, so
    # linecache.checkcache() keeps it instead of re-reading the disk copy.
    linecache.cache[filename] = (len(code), None, lines, filename)


def _system_exit(exc: SystemExit, sink: streams.ExecutionSink) -> int:
    code = errors.exit_code_of(exc)
    if exc.code is not None and not isinstance(exc.code, int):
        sink.write(2, f"{exc.code}\n")
    return code


def run_script(req: RunRequest, *, user_roots=()) -> dict:
    """Execute ``req.code`` as a script and return a structured result."""
    sink = streams.ExecutionSink(req.execution_id, capture=req.capture,
                                 output_limit=req.output_limit, stdin=req.stdin)
    filename = req.filename or "<untitled>"
    real_file = _is_real_path(filename)
    cwd = req.cwd or (os.path.dirname(filename) if real_file else None) or os.getcwd()
    if not os.path.isdir(cwd):
        return {
            "executionId": req.execution_id,
            "status": "error",
            "exitCode": None,
            "durationMs": 0.0,
            "error": {
                "type": "FileNotFoundError",
                "message": f"Working directory does not exist: {cwd}",
                "category": "environment",
                "traceback": f"ZiniaPython could not start the run: working directory does not exist: {cwd}\n",
                "frames": [],
            },
            "outputChars": 0,
            "truncated": False,
        }

    script_dir = os.path.dirname(filename) if real_file else cwd
    roots = {r for r in (*user_roots, req.project_root, script_dir) if r}

    status = "ok"
    exit_code = None
    error = None
    started = time.perf_counter()

    with streams.activate(sink), interpreter_state_guard():
        purge_user_modules(roots)
        main = types.ModuleType("__main__")
        main.__dict__.update({
            "__builtins__": builtins,
            "__file__": filename if real_file else None,
            "__cached__": None,
            "__spec__": None,
            "__loader__": None,
            "__package__": None,
        })
        if not real_file:
            del main.__dict__["__file__"]
        sys.modules["__main__"] = main
        sys.argv = [filename] + [str(a) for a in req.args]
        front = [script_dir]
        if req.project_root and _norm(req.project_root) != _norm(script_dir):
            front.append(req.project_root)
        sys.path[:] = front + [p for p in sys.path if p not in front and p != ""]
        os.chdir(cwd)
        register_source(filename, req.code)
        importlib.invalidate_caches()
        try:
            try:
                code_obj = compile(req.code, filename, "exec", dont_inherit=True)
            except (SyntaxError, ValueError, OverflowError) as exc:
                status = "error"
                error = errors.describe(exc, user_files=(filename,))
            else:
                try:
                    exec(code_obj, main.__dict__)
                except SystemExit as exc:
                    exit_code = _system_exit(exc, sink)
                    status = "ok" if exit_code == 0 else "exit"
                except KeyboardInterrupt as exc:
                    status = "interrupted"
                    error = errors.describe(exc, user_files=(filename,))
                except BaseException as exc:  # noqa: BLE001 - user code may raise anything
                    status = "error"
                    error = errors.describe(exc, user_files=(filename,))
        except KeyboardInterrupt as exc:
            # Stop arrived during set-up or tear-down rather than inside the script.
            status = "interrupted"
            error = errors.describe(exc, user_files=(filename,))
        finally:
            linecache.cache.pop(filename, None)
            purge_user_modules(roots)

    duration_ms = (time.perf_counter() - started) * 1000.0
    result = {
        "executionId": req.execution_id,
        "status": status,
        "exitCode": exit_code,
        "durationMs": round(duration_ms, 3),
        "error": error,
        "outputChars": sink.chars,
        "truncated": sink.truncated,
    }
    if req.capture:
        result["stdout"] = sink.text(1)
        result["stderr"] = sink.text(2)
    return result
