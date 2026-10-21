"""Explanations for modules that cannot be imported.

These are *explanations*, not availability claims: whether a module is really
present is always decided by actually importing it (see ``selftest.py``). When
an import fails, this table tells the user the most likely reason, using the
categories below.
"""

from __future__ import annotations

# Reason categories shown in the IDE.
NOT_BUNDLED = "not-bundled"            # not included in the bundled standard library
OS_FEATURE = "os-feature"              # depends on an operating-system feature iOS lacks
NATIVE_EXTENSION = "native-extension"  # needs a compiled extension that is not in the build
IOS_RESTRICTION = "ios-restriction"    # blocked by iOS rules (sandbox, code signing, no processes)
NOT_IMPLEMENTED = "not-implemented"    # could exist, but ZiniaPython's build does not provide it yet
REMOVED = "removed"                    # removed from the Python standard library
THIRD_PARTY = "third-party"            # not part of the standard library at all
UNKNOWN = "unknown"

_KNOWN: dict[str, tuple[str, str]] = {
    "tkinter": (NATIVE_EXTENSION, "Tk (the _tkinter extension and the Tcl/Tk libraries) is not part of the "
                "CPython iOS build. iOS apps cannot open Tk windows."),
    "_tkinter": (NATIVE_EXTENSION, "The Tcl/Tk libraries are not available on iOS."),
    "turtle": (NATIVE_EXTENSION, "turtle draws with tkinter, which is not available on iOS."),
    "turtledemo": (NATIVE_EXTENSION, "turtledemo needs tkinter, which is not available on iOS."),
    "idlelib": (NATIVE_EXTENSION, "IDLE is a tkinter application and is not available on iOS."),
    "curses": (OS_FEATURE, "iOS has no terminal, and the curses library is not part of the iOS build."),
    "_curses": (OS_FEATURE, "iOS has no terminal, and the curses library is not part of the iOS build."),
    "readline": (OS_FEATURE, "GNU readline / libedit is not available on iOS. ZiniaPython's console "
                 "provides its own line editing and history."),
    "dbm.gnu": (NATIVE_EXTENSION, "The GNU dbm library is not part of the CPython iOS build. "
                "Use dbm.sqlite3, dbm.dumb or sqlite3 instead."),
    "_gdbm": (NATIVE_EXTENSION, "The GNU dbm library is not part of the CPython iOS build."),
    "dbm.ndbm": (NATIVE_EXTENSION, "ndbm is not part of the CPython iOS build. Use dbm.sqlite3, dbm.dumb or sqlite3."),
    "_dbm": (NATIVE_EXTENSION, "ndbm is not part of the CPython iOS build."),
    "venv": (IOS_RESTRICTION, "iOS apps cannot create virtual environments or start a separate python "
             "executable. Use the Packages screen to add pure-Python packages."),
    "ensurepip": (IOS_RESTRICTION, "pip cannot be bootstrapped as a separate program on iOS. "
                  "Use the Packages screen to add pure-Python packages."),
    "pip": (IOS_RESTRICTION, "pip is not available on iOS (it relies on subprocesses and build tools). "
            "Use the Packages screen, which installs pure-Python wheels from PyPI."),
    "_posixsubprocess": (IOS_RESTRICTION, "iOS does not allow apps to start subprocesses."),
    "msvcrt": (OS_FEATURE, "Windows-only module."),
    "winreg": (OS_FEATURE, "Windows-only module."),
    "winsound": (OS_FEATURE, "Windows-only module."),
    "_winapi": (OS_FEATURE, "Windows-only module."),
    "_scproxy": (OS_FEATURE, "macOS-only module."),
    "ossaudiodev": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "spwd": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "crypt": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "nis": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "audioop": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "cgi": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "cgitb": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "chunk": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "imghdr": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "mailcap": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "msilib": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "nntplib": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "pipes": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "sndhdr": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "sunau": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "telnetlib": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "uu": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "xdrlib": (REMOVED, "Removed from the standard library in Python 3.13 (PEP 594)."),
    "lib2to3": (REMOVED, "Removed from the standard library in Python 3.13."),
    "distutils": (REMOVED, "Removed from the standard library in Python 3.12 (PEP 632). "
                  "setuptools provides a replacement on desktop systems."),
    "imp": (REMOVED, "Removed in Python 3.12. Use importlib instead."),
    "asynchat": (REMOVED, "Removed in Python 3.12. Use asyncio instead."),
    "asyncore": (REMOVED, "Removed in Python 3.12. Use asyncio instead."),
    "smtpd": (REMOVED, "Removed in Python 3.12."),
}

# Popular third-party packages that contain compiled code. They are not part of
# the standard library and cannot be installed on the device at run time,
# because iOS only loads native code that was signed into the app bundle.
_NATIVE_THIRD_PARTY = {
    "numpy", "pandas", "scipy", "matplotlib", "PIL", "pillow", "torch", "tensorflow", "sklearn",
    "cv2", "lxml", "cryptography", "pydantic_core", "psutil", "grpc", "yaml_c", "ujson", "orjson",
    "Crypto", "nacl", "bcrypt", "zmq", "gevent", "greenlet", "numba", "llvmlite", "shapely",
}

# Modules that import successfully but have documented functional limits.
LIMITED = {
    "subprocess": "iOS does not allow apps to start processes. Python programs started with "
                  "subprocess (python file.py, sys.executable, -m, -c) and os.system run inside the "
                  "app, one after another; other commands raise an error.",
    "multiprocessing": "Importable, but iOS does not allow apps to start subprocesses, so worker "
                       "processes cannot be created. Use threading or concurrent.futures.ThreadPoolExecutor.",
    "webbrowser": "Opens URLs through iOS, outside ZiniaPython.",
    "socket": "Works for outgoing connections. Listening servers only run while the app is in the foreground.",
    "signal": "Signal handlers run on ZiniaPython's interpreter thread; SIGINT is used by the Stop button.",
    "ctypes": "Works, but only for code already loaded into the app; iOS cannot load unsigned libraries.",
}


def explain_missing(module_name: str) -> dict:
    """Return ``{"category": ..., "explanation": ...}`` for a failed import."""
    if not module_name:
        return {"category": UNKNOWN, "explanation": "The module name could not be determined."}
    candidates = [module_name]
    parts = module_name.split(".")
    for i in range(len(parts) - 1, 0, -1):
        candidates.append(".".join(parts[:i]))
    for name in candidates:
        if name in _KNOWN:
            category, text = _KNOWN[name]
            return {"category": category, "explanation": text, "module": name}
    top = parts[0]
    if top in _NATIVE_THIRD_PARTY:
        return {
            "category": THIRD_PARTY,
            "explanation": (f"'{top}' is a third-party package with compiled (native) code. It is not bundled, "
                            "and native code cannot be installed on iOS at run time. It must be compiled for "
                            "iOS and added when the app is built - see docs/PACKAGES.md."),
            "module": top,
        }
    return {
        "category": UNKNOWN,
        "explanation": (f"No module named '{module_name}' was found in the bundled standard library, your "
                        "project folder, or installed packages. If it is your own module, check that the file "
                        "is in the project folder. If it is a pure-Python package from PyPI, install it from "
                        "the Packages screen."),
        "module": module_name,
    }
