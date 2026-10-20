"""Entry points called by the native interpreter host.

The host calls exactly two functions, always from its single interpreter
thread and always with the GIL held:

``initialize(config_json) -> str``  once, right after ``Py_InitializeFromConfig``.
``handle(request_json) -> str``     for every request from the IDE.

Both take and return JSON text so the C layer stays small and never has to
understand Python objects. Responses have the shape
``{"ok": true, "result": {...}}`` or ``{"ok": false, "error": {...}}``.
"""

from __future__ import annotations

import json
import os
import platform
import site
import sys
import time

from . import PROTOCOL_VERSION, __version__, errors, executor, native, packages, repl, selftest, streams


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _State:
    initialized = False
    config: dict = {}
    user_roots: set = set()
    repl: repl.ReplSession | None = None
    started_at = 0.0
    output_limit = streams.DEFAULT_OUTPUT_LIMIT


_real_os_exit = os._exit


def _guarded_os_exit(status=0):
    """``os._exit`` would terminate the whole iOS app (and the IDE with it)."""
    sys.stderr.write("[ZiniaPython] os._exit() was intercepted: ending the process would close the app. "
                     "It was treated as sys.exit().\n")
    raise SystemExit(status)


def _require_str(req: dict, key: str, *, optional: bool = False, max_len: int = 50_000_000):
    value = req.get(key)
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise BridgeError("INVALID_ARGUMENT", f"'{key}' must be a string")
    if len(value) > max_len:
        raise BridgeError("INVALID_ARGUMENT", f"'{key}' is too large")
    return value


def _require_dir(req: dict, key: str):
    value = _require_str(req, key, optional=True, max_len=4096)
    if value is None or value == "":
        return None
    if not os.path.isabs(value):
        raise BridgeError("INVALID_ARGUMENT", f"'{key}' must be an absolute path")
    return value


def runtime_info() -> dict:
    ios_ver = None
    if hasattr(platform, "ios_ver"):
        try:
            v = platform.ios_ver()
            ios_ver = {"system": v.system, "release": v.release, "model": v.model, "isSimulator": v.is_simulator}
        except Exception:  # noqa: BLE001
            ios_ver = None
    flags = sys.flags
    return {
        "protocol": PROTOCOL_VERSION,
        "ziniaRuntimeVersion": __version__,
        "pythonVersion": platform.python_version(),
        "pythonVersionFull": sys.version,
        "implementation": platform.python_implementation(),
        "platform": sys.platform,
        "machine": platform.machine(),
        "ios": ios_ver,
        "prefix": sys.prefix,
        "stdlib": os.path.dirname(os.__file__),
        "sysPath": list(sys.path),
        "sitePackages": packages.Config.site_dir,
        "bundledPackages": list(packages.Config.bundled_dirs),
        "workspaceRoot": _State.config.get("workspaceRoot"),
        "utf8Mode": bool(flags.utf8_mode),
        "dontWriteBytecode": bool(sys.dont_write_bytecode),
        "nativeHost": native.AVAILABLE,
        "startedAt": _State.started_at,
        "executionModel": {
            "interpreters": 1,
            "thread": "dedicated",
            "concurrentRuns": False,
            "scriptNamespace": "fresh __main__ per run",
            "replNamespace": "persistent, separate from scripts",
        },
    }


def initialize(config_json: str) -> str:
    try:
        config = json.loads(config_json) if config_json else {}
        if not isinstance(config, dict):
            raise BridgeError("INVALID_ARGUMENT", "configuration must be a JSON object")
        if _State.initialized:
            return json.dumps({"ok": True, "result": runtime_info()})
        _State.config = config
        _State.started_at = time.time()
        _State.output_limit = int(config.get("outputLimit") or streams.DEFAULT_OUTPUT_LIMIT)
        if config.get("installStreams", True):
            streams.install()
        site_dir = config.get("sitePackages")
        bundled = [d for d in (config.get("appPackages"),) if d]
        if site_dir:
            packages.configure(site_dir, bundled)
            errors.add_library_dir(site_dir)
            site.addsitedir(site_dir)  # processes .pth files of installed packages
        for directory in bundled:
            errors.add_library_dir(directory)
            if os.path.isdir(directory):
                site.addsitedir(directory)
        roots = config.get("userRoots") or []
        if config.get("workspaceRoot"):
            roots.append(config["workspaceRoot"])
        _State.user_roots = {r for r in roots if isinstance(r, str) and r}
        if config.get("guardProcessExit", True):
            os._exit = _guarded_os_exit
        home = config.get("workspaceRoot")
        if home and os.path.isdir(home):
            os.chdir(home)
        _State.repl = repl.ReplSession()
        _State.initialized = True
        return json.dumps({"ok": True, "result": runtime_info()})
    except BaseException as exc:  # noqa: BLE001 - must always answer the host
        return json.dumps({"ok": False, "error": {"code": "INIT_FAILED", **errors.format_internal(exc)}})


def _op_execute(req: dict) -> dict:
    code = _require_str(req, "code")
    filename = _require_str(req, "filename", optional=True, max_len=4096) or "<untitled>"
    cwd = _require_dir(req, "cwd")
    project_root = _require_dir(req, "projectRoot")
    stdin = _require_str(req, "stdin", optional=True)
    args = req.get("args") or []
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise BridgeError("INVALID_ARGUMENT", "'args' must be a list of strings")
    run = executor.RunRequest(
        execution_id=_require_str(req, "executionId", max_len=128),
        code=code, filename=filename, cwd=cwd, project_root=project_root, args=args, stdin=stdin,
        capture=bool(req.get("capture")), output_limit=int(req.get("outputLimit") or _State.output_limit))
    return executor.run_script(run, user_roots=_State.user_roots | set(req.get("userRoots") or []))


def _op_execute_file(req: dict) -> dict:
    path = _require_str(req, "path", max_len=4096)
    if not os.path.isabs(path):
        raise BridgeError("INVALID_ARGUMENT", "'path' must be an absolute path")
    try:
        with open(path, encoding="utf-8") as fh:
            code = fh.read()
    except OSError as exc:
        raise BridgeError("FILE_ERROR", f"Cannot read {path}: {exc.strerror or exc}") from exc
    except UnicodeDecodeError as exc:
        raise BridgeError("FILE_ERROR", f"{path} is not valid UTF-8 text") from exc
    req = dict(req, code=code, filename=path)
    if not req.get("cwd"):
        req["cwd"] = req.get("projectRoot") or os.path.dirname(path)
    return _op_execute(req)


def _op_repl(req: dict) -> dict:
    assert _State.repl is not None
    mode = req.get("mode") or "line"
    if mode not in ("line", "block"):
        raise BridgeError("INVALID_ARGUMENT", "'mode' must be 'line' or 'block'")
    return _State.repl.execute(
        execution_id=_require_str(req, "executionId", max_len=128),
        source=_require_str(req, "source"), mode=mode,
        cwd=_require_dir(req, "cwd"), project_root=_require_dir(req, "projectRoot"),
        capture=bool(req.get("capture")), output_limit=_State.output_limit, user_roots=_State.user_roots)


def _op_reset(req: dict) -> dict:
    """Soft restart: new REPL namespace and a clean import state for user code.

    A true interpreter restart (Py_FinalizeEx + Py_Initialize) is not offered:
    many extension modules do not support re-initialisation in one process.
    """
    assert _State.repl is not None
    _State.repl.reset()
    removed = executor.purge_user_modules(_State.user_roots | set(req.get("userRoots") or []))
    streams.ensure_installed()
    import gc
    collected = gc.collect()
    home = _State.config.get("workspaceRoot")
    if home and os.path.isdir(home):
        os.chdir(home)
    return {"replReset": True, "modulesForgotten": removed, "objectsCollected": collected}


def _op_packages(op: str, req: dict) -> dict:
    try:
        if op == "packages.list":
            return packages.list_installed()
        if op == "packages.analyze":
            return packages.analyze(_require_str(req, "name", max_len=200),
                                    _require_str(req, "version", optional=True, max_len=100))
        if op == "packages.install":
            return packages.install(_require_str(req, "name", max_len=200),
                                    _require_str(req, "version", optional=True, max_len=100))
        if op == "packages.uninstall":
            return packages.uninstall(_require_str(req, "name", max_len=200))
    except packages.PackageError as exc:
        raise BridgeError(exc.code, exc.message) from exc
    raise BridgeError("UNKNOWN_OP", f"Unknown operation {op}")


def _dispatch(req: dict) -> dict:
    op = req.get("op")
    if op == "execute":
        return _op_execute(req)
    if op == "executeFile":
        return _op_execute_file(req)
    if op == "repl":
        return _op_repl(req)
    if op == "reset":
        return _op_reset(req)
    if op == "info":
        return runtime_info()
    if op == "selftest":
        return selftest.run_all(include_modules=req.get("modules", True))
    if op == "modules":
        names = req.get("names")
        if names is not None and not (isinstance(names, list) and all(isinstance(n, str) for n in names)):
            raise BridgeError("INVALID_ARGUMENT", "'names' must be a list of strings")
        return {"modules": selftest.check_modules(names)}
    if isinstance(op, str) and op.startswith("packages."):
        return _op_packages(op, req)
    raise BridgeError("UNKNOWN_OP", f"Unknown operation {op!r}")


def handle(request_json: str) -> str:
    try:
        if not _State.initialized:
            raise BridgeError("NOT_INITIALIZED", "The runtime has not been initialised")
        req = json.loads(request_json)
        if not isinstance(req, dict):
            raise BridgeError("INVALID_ARGUMENT", "request must be a JSON object")
        result = _dispatch(req)
        return json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str)
    except BridgeError as exc:
        return json.dumps({"ok": False, "error": {"code": exc.code, "message": exc.message}}, ensure_ascii=False)
    except KeyboardInterrupt:
        return json.dumps({"ok": False, "error": {"code": "INTERRUPTED", "message": "Interrupted"}})
    except BaseException as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "error": {"code": "INTERNAL", **errors.format_internal(exc)}},
                          ensure_ascii=False, default=str)
    finally:
        streams.ensure_installed()
