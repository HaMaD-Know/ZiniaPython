"""Desktop development bridge worker (development only - never part of the app).

Started by the Vite dev server when running ``npm run dev:bridge``. It hosts
ZiniaPython's runtime package (python/zinia) in desktop CPython and speaks a
line-based JSON protocol on stdin/stdout, standing in for the iOS host
(ZPInterpreter.m + ZiniaPythonPlugin.swift):

* requests run one at a time on this process' main thread, like the iOS
  interpreter thread;
* ``interrupt`` uses ``_thread.interrupt_main()``, the same KeyboardInterrupt
  mechanism the iOS host triggers with ``PyErr_SetInterruptEx``;
* ``input()`` blocks until the UI answers, as on iOS.

Usage: python dev-bridge-worker.py <repo-root> <workspace-dir> <site-packages-dir>
"""

import json
import os
import queue
import sys
import threading
import time
import types
import _thread

REPO, WORKSPACE, SITE = (os.path.abspath(p) for p in sys.argv[1:4])
# The protocol gets its own copy of fd 1; fd 1 itself is pointed at stderr so
# that C extensions writing straight to stdout cannot corrupt protocol lines.
_proto_fd = os.dup(1)
os.dup2(2, 1)
PROTO = os.fdopen(_proto_fd, "w", encoding="utf-8", buffering=1)
REAL_STDIN = sys.stdin  # bridge.initialize() later replaces sys.stdin
PROTO_LOCK = threading.Lock()
STREAM_NAMES = {1: "stdout", 2: "stderr", 3: "system"}


def send(message):
    line = json.dumps(message, ensure_ascii=True)
    with PROTO_LOCK:
        PROTO.write(line + "\n")
        PROTO.flush()


def event(name, data):
    send({"type": "event", "name": name, "data": data})


class InputState:
    lock = threading.Lock()
    waiting_for = None
    replies = queue.Queue()


def _emit_output(execution_id, stream, text):
    event("output", {"chunks": [{"executionId": execution_id, "stream": STREAM_NAMES.get(stream, "stdout"), "text": text}]})


def _emit_event(name, payload):
    # Same shape as ZiniaPythonPlugin.swift: graphics payloads stay a JSON string.
    event(name, {"payload": payload} if name == "graphics" else json.loads(payload))


def _read_input(execution_id):
    with InputState.lock:
        InputState.waiting_for = execution_id
        while not InputState.replies.empty():
            InputState.replies.get_nowait()
    event("inputRequest", {"executionId": execution_id})
    try:
        kind, text = InputState.replies.get()
    finally:
        with InputState.lock:
            InputState.waiting_for = None
    if kind == "cancel":
        raise KeyboardInterrupt
    return text


class UIState:
    lock = threading.Lock()
    batches = []
    ready = threading.Event()


def _wait_ui(execution_id, timeout):
    # Stand-in for ZPInterpreter's UI event queue.
    with UIState.lock:
        if not UIState.batches:
            UIState.ready.clear()
    if timeout > 0:
        UIState.ready.wait(min(timeout, 5))
    with UIState.lock:
        batches, UIState.batches = UIState.batches, []
        UIState.ready.clear()
    return batches


def _http_get(url, timeout, max_bytes):
    return None  # zinia.packages falls back to urllib on desktop


fake = types.ModuleType("_zinia_native")
fake.emit_output = _emit_output
fake.emit_event = _emit_event
fake.read_input = _read_input
fake.http_get = _http_get
fake.wait_ui = _wait_ui
sys.modules["_zinia_native"] = fake
sys.path.insert(0, os.path.join(REPO, "python"))

from zinia import bridge  # noqa: E402  (must follow the fake native module)
from zinia import errors  # noqa: E402

# This file stands in for native code: keep it out of user tracebacks.
errors.add_library_dir(os.path.dirname(os.path.abspath(__file__)))

State = types.SimpleNamespace(active=None, started=None, info=None)
requests = queue.Queue()


def reader():
    for raw in REAL_STDIN:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = msg.get("type")
        if kind == "interrupt":
            execution_id = msg.get("executionId")
            mechanism = "none"
            if execution_id and execution_id == State.active:
                with InputState.lock:
                    waiting = InputState.waiting_for == execution_id
                if waiting:
                    InputState.replies.put(("cancel", None))
                    mechanism = "input-cancelled"
                else:
                    _thread.interrupt_main()
                    UIState.ready.set()  # wake an animation loop waiting for UI events
                    mechanism = "keyboard-interrupt"
            send({"type": "response", "id": msg["id"], "ok": True,
                  "result": {"interrupted": mechanism != "none", "mechanism": mechanism}})
        elif kind == "ui":
            accepted = bool(State.active) and msg.get("executionId") == State.active
            if accepted:
                with UIState.lock:
                    UIState.batches.append(str(msg.get("events") or "[]"))
                    del UIState.batches[:-600]
                UIState.ready.set()
            send({"type": "response", "id": msg["id"], "ok": True, "result": {"accepted": accepted}})
        elif kind == "input":
            accepted = False
            with InputState.lock:
                if InputState.waiting_for and InputState.waiting_for == msg.get("executionId"):
                    InputState.replies.put(("text" if msg.get("text") is not None else "eof", msg.get("text")))
                    accepted = True
            send({"type": "response", "id": msg["id"], "ok": True, "result": {"accepted": accepted}})
        elif kind == "request":
            requests.put(msg)
    requests.put(None)


OPS = {
    "execute": "execute", "executeFile": "executeFile", "replExecute": "repl", "resetInterpreter": "reset",
    "runSelfTest": "selftest", "checkModules": "modules", "listPackages": "packages.list",
    "analyzePackage": "packages.analyze", "installPackage": "packages.install",
    "uninstallPackage": "packages.uninstall",
}


def handle(method, options):
    if method == "ping":
        return {"pong": True, "pluginVersion": "dev-bridge", "compiledPythonVersion": sys.version.split()[0],
                "interpreterState": "ready" if State.info else "not-initialized"}
    if method == "initialize":
        if State.info is None:
            started = time.perf_counter()
            reply = json.loads(bridge.initialize(json.dumps({
                "workspaceRoot": WORKSPACE, "sitePackages": SITE, "userRoots": [WORKSPACE], "installStreams": True,
            })))
            if not reply["ok"]:
                raise RuntimeError(reply["error"].get("message", "initialize failed"))
            State.info = dict(reply["result"], devBridge=True, startupMs=(time.perf_counter() - started) * 1000,
                              interpreterState="ready", interruptSupport="keyboard-interrupt")
        return State.info
    if method == "getRuntimeInfo":
        return dict(State.info or {}, busy=State.active is not None)
    op = OPS.get(method)
    if op is None:
        raise LookupError(f"unknown method {method}")
    request = dict(options, op=op)
    for js_key, py_key in (("workingDirectory", "cwd"),):
        if js_key in request:
            request[py_key] = request.pop(js_key)
    State.active = request.get("executionId")
    try:
        reply = json.loads(bridge.handle(json.dumps(request)))
    finally:
        State.active = None
    if not reply["ok"]:
        error = reply["error"]
        raise BridgeFailure(error.get("code", "INTERNAL"), error.get("message", "error"), error)
    return reply["result"]


class BridgeFailure(Exception):
    def __init__(self, code, message, data):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


def main():
    threading.Thread(target=reader, daemon=True, name="dev-bridge-reader").start()
    send({"type": "ready"})
    while True:
        msg = requests.get()
        if msg is None:
            break
        started = time.perf_counter()
        try:
            result = handle(msg["method"], msg.get("options") or {})
            if isinstance(result, dict) and msg["method"] in OPS:
                result.setdefault("wallTimeMs", (time.perf_counter() - started) * 1000)
            send({"type": "response", "id": msg["id"], "ok": True, "result": result})
        except BridgeFailure as exc:
            send({"type": "response", "id": msg["id"], "ok": False,
                  "error": {"message": exc.message, "code": exc.code, "data": exc.data}})
        except KeyboardInterrupt:
            send({"type": "response", "id": msg["id"], "ok": False, "error": {"message": "Interrupted", "code": "INTERRUPTED"}})
        except Exception as exc:  # noqa: BLE001
            send({"type": "response", "id": msg["id"], "ok": False, "error": {"message": str(exc), "code": "INTERNAL"}})


if __name__ == "__main__":
    main()
