"""Turn Python exceptions into structured diagnostics for the IDE."""

from __future__ import annotations

import os
import sys
import sysconfig
import traceback

from . import module_info

_PACKAGE_DIR = os.path.normcase(os.path.dirname(os.path.abspath(__file__))) + os.sep
# The graphics modules live next to the package (importable as plain
# ``zinia_draw`` / ``zinia_3d``) but are runtime code, not the user's.
_RUNTIME_MODULES = tuple(
    os.path.normcase(os.path.join(os.path.dirname(_PACKAGE_DIR.rstrip(os.sep)), name))
    for name in ("zinia_draw.py", "zinia_3d.py"))


def stdlib_dir() -> str:
    """Folder of the standard library.

    Not ``os.__file__``: in CPython's embedded iOS build ``os`` and other core
    modules are frozen into the interpreter and have no ``__file__``.
    """
    try:
        path = sysconfig.get_path("stdlib")
        if path and os.path.isdir(path):
            return path
    except Exception:  # noqa: BLE001
        pass
    for name in ("json", "email", "logging"):  # packages, never frozen
        module = sys.modules.get(name) or __import__(name)
        file = getattr(module, "__file__", None)
        if file:
            return os.path.dirname(os.path.dirname(os.path.abspath(file)))
    return sys.prefix


def _stdlib_dirs() -> tuple[str, ...]:
    dirs = set()
    for key in ("stdlib", "platstdlib", "purelib", "platlib"):
        try:
            path = sysconfig.get_path(key)
        except Exception:  # noqa: BLE001 - sysconfig raises on some embedded layouts (seen on iOS)
            path = None
        if path:
            dirs.add(os.path.normcase(os.path.abspath(path)) + os.sep)
    dirs.add(os.path.normcase(os.path.abspath(stdlib_dir())) + os.sep)
    return tuple(dirs)


_STDLIB_DIRS = _stdlib_dirs()
_EXTRA_LIBRARY_DIRS: list[str] = []


def add_library_dir(path: str) -> None:
    """Treat ``path`` (for example installed packages) as library code."""
    if path:
        normalized = os.path.normcase(os.path.abspath(path)) + os.sep
        if normalized not in _EXTRA_LIBRARY_DIRS:
            _EXTRA_LIBRARY_DIRS.append(normalized)


def is_internal(filename: str) -> bool:
    """True for frames that belong to ZiniaPython's own runtime code."""
    if not filename or filename.startswith("<"):
        return False
    path = os.path.normcase(os.path.abspath(filename))
    return path.startswith(_PACKAGE_DIR) or path in _RUNTIME_MODULES


def is_library(filename: str) -> bool:
    if not filename or filename.startswith("<frozen"):
        return True
    if filename.startswith("<"):
        return False
    path = os.path.normcase(os.path.abspath(filename))
    return (any(path.startswith(d) for d in _STDLIB_DIRS)
            or any(path.startswith(d) for d in _EXTRA_LIBRARY_DIRS) or is_internal(filename))


def _strip_internal(exc: BaseException) -> None:
    """Drop traceback entries that point into ZiniaPython's own code.

    Leading entries are the runner itself. Trailing entries are inside the
    runtime (for example a zinia_draw argument check), so the traceback ends
    at the user's line that called it. When the program was stopped, trailing
    library frames (wherever the program happened to be waiting) are dropped
    as well.
    """
    tb = exc.__traceback__
    while tb is not None and is_internal(tb.tb_frame.f_code.co_filename):
        tb = tb.tb_next
    exc.__traceback__ = tb
    if tb is None:
        return
    trailing = is_library if isinstance(exc, KeyboardInterrupt) else is_internal
    last_kept = None
    entry = tb
    while entry is not None:
        if not trailing(entry.tb_frame.f_code.co_filename):
            last_kept = entry
        entry = entry.tb_next
    if last_kept is not None:
        last_kept.tb_next = None
    elif isinstance(exc, KeyboardInterrupt):
        # Stopped while the runtime itself was waiting (for example listening
        # for touches after the script's last line): no user frame to show.
        exc.__traceback__ = None


def _type_name(exc: BaseException) -> str:
    cls = type(exc)
    module = cls.__module__
    if module in ("builtins", "__main__", None):
        return cls.__qualname__
    return f"{module}.{cls.__qualname__}"


def category_for(exc: BaseException) -> str:
    if isinstance(exc, SyntaxError):
        return "syntax"
    if isinstance(exc, ImportError):
        return "import"
    if isinstance(exc, KeyboardInterrupt):
        return "interrupt"
    if isinstance(exc, SystemExit):
        return "exit"
    if isinstance(exc, MemoryError):
        return "memory"
    return "runtime"


def describe(exc: BaseException, *, user_files: tuple[str, ...] = ()) -> dict:
    """Build the structured error object returned to the IDE."""
    _strip_internal(exc)
    te = traceback.TracebackException.from_exception(exc)
    text = "".join(te.format())
    frames = []
    for fs in te.stack:
        frames.append({
            "filename": fs.filename,
            "lineno": fs.lineno,
            "endLineno": getattr(fs, "end_lineno", None),
            "colno": getattr(fs, "colno", None),
            "name": fs.name,
            "line": fs.line or "",
            "isLibrary": is_library(fs.filename),
        })

    info: dict = {
        "type": _type_name(exc),
        "message": str(exc),
        "category": category_for(exc),
        "traceback": text,
        "frames": frames,
    }

    if isinstance(exc, SyntaxError):
        info["message"] = exc.msg or str(exc)
        info["syntax"] = {
            "filename": exc.filename,
            "lineno": exc.lineno,
            "offset": exc.offset,
            "endLineno": getattr(exc, "end_lineno", None),
            "endOffset": getattr(exc, "end_offset", None),
            "text": (exc.text or "").rstrip("\n"),
        }
        info["location"] = {"filename": exc.filename, "lineno": exc.lineno, "colno": exc.offset}
    else:
        # Prefer the deepest frame in the user's own code (where the error
        # actually happened, possibly inside a helper module); fall back to
        # the deepest frame of the file that was run.
        location = None
        for frame in reversed(frames):
            if not frame["isLibrary"]:
                location = frame
                break
        if location is None:
            normalized_user = {os.path.normcase(os.path.abspath(f)) for f in user_files
                               if f and not f.startswith("<")}
            for frame in reversed(frames):
                fn = frame["filename"]
                if fn in user_files or (not fn.startswith("<")
                                        and os.path.normcase(os.path.abspath(fn)) in normalized_user):
                    location = frame
                    break
        if location is not None:
            info["location"] = {"filename": location["filename"], "lineno": location["lineno"],
                                "colno": location.get("colno")}

    if isinstance(exc, ModuleNotFoundError):
        name = exc.name or ""
        info["missingModule"] = name
        info["moduleHelp"] = module_info.explain_missing(name)
    elif isinstance(exc, SystemExit):
        info["exitCode"] = exit_code_of(exc)
    return info


def exit_code_of(exc: SystemExit) -> int:
    code = exc.code
    if code is None:
        return 0
    if isinstance(code, bool):
        return int(code)
    if isinstance(code, int):
        return code
    return 1


def format_internal(exc: BaseException) -> dict:
    """Describe a failure inside ZiniaPython itself (not the user's code)."""
    return {
        "type": _type_name(exc),
        "message": str(exc),
        "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        "python": sys.version,
    }
