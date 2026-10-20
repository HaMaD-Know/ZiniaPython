"""Interactive console session backed by the embedded interpreter.

The REPL keeps its own namespace between submissions. It is deliberately
separate from script runs: running a script never changes REPL variables, and
resetting the REPL never touches the editor or project files.

Two input modes are supported:

``line``  - classic interactive mode. The IDE sends the accumulated lines; if
            the statement is incomplete (``for x in y:``) the result is
            ``incomplete`` and the IDE shows a ``...`` continuation prompt.
``block`` - a whole multi-line block is executed at once; if its last
            statement is an expression its value is displayed, like a
            notebook cell.
"""

from __future__ import annotations

import __future__
import ast
import builtins
import codeop
import importlib
import os
import sys
import time
import types

from . import errors, executor, graphics, streams

_FUTURE_MASK = 0
for _name in __future__.all_feature_names:
    _FUTURE_MASK |= getattr(__future__, _name).compiler_flag


class ReplSession:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.module = types.ModuleType("__main__")
        self.module.__dict__.update({"__builtins__": builtins, "__doc__": None})
        self.compiler = codeop.CommandCompiler()
        self.counter = 0
        self.created = time.time()

    @property
    def namespace(self) -> dict:
        return self.module.__dict__

    def _compile(self, source: str, mode: str, filename: str):
        """Return a list of code objects, or None if more input is needed."""
        if mode == "line":
            code = self.compiler(source, filename, "single")
            return None if code is None else [code]
        tree = ast.parse(source, filename, "exec")
        flags = self.compiler.compiler.flags & _FUTURE_MASK
        codes = []
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = tree.body.pop()
        if tree.body:
            codes.append(compile(tree, filename, "exec", flags=flags, dont_inherit=True))
        if last is not None:
            interactive = ast.Interactive(body=[last])
            codes.append(compile(interactive, filename, "single", flags=flags, dont_inherit=True))
        return codes

    def execute(self, *, execution_id: str, source: str, mode: str = "line",
                cwd: str | None = None, project_root: str | None = None,
                capture: bool = False, output_limit: int = streams.DEFAULT_OUTPUT_LIMIT,
                user_roots=()) -> dict:
        if mode not in ("line", "block"):
            raise ValueError(f"unknown REPL mode: {mode!r}")
        sink = streams.ExecutionSink(execution_id, capture=capture, output_limit=output_limit)
        self.counter += 1
        filename = f"<input-{self.counter}>"
        status = "ok"
        error = None
        exit_code = None
        started = time.perf_counter()

        with streams.activate(sink), executor.interpreter_state_guard():
            try:
                codes = self._compile(source, mode, filename)
            except (SyntaxError, ValueError, OverflowError) as exc:
                self.counter -= 1
                status = "error"
                error = errors.describe(exc, user_files=(filename,))
                codes = []
            else:
                if codes is None:
                    self.counter -= 1
                    return {"executionId": execution_id, "status": "incomplete", "durationMs": 0.0,
                            "error": None, "exitCode": None, "outputChars": 0, "truncated": False}
            if codes:
                executor.register_source(filename, source)
                if cwd and os.path.isdir(cwd):
                    os.chdir(cwd)
                if project_root and project_root not in sys.path:
                    sys.path.insert(0, project_root)
                sys.modules["__main__"] = self.module
                importlib.invalidate_caches()
                try:
                    for code in codes:
                        exec(code, self.namespace)
                except SystemExit as exc:
                    exit_code = errors.exit_code_of(exc)
                    status = "exit"
                except KeyboardInterrupt as exc:
                    status = "interrupted"
                    error = errors.describe(exc, user_files=(filename,))
                except BaseException as exc:  # noqa: BLE001
                    status = "error"
                    error = errors.describe(exc, user_files=(filename,))
                finally:
                    graphics.end_run()  # show what the statement drew (the scene itself is kept)
                # Keep the source registered so later tracebacks that pass
                # through functions defined here can still show their lines.

        result = {
            "executionId": execution_id,
            "status": status,
            "exitCode": exit_code,
            "durationMs": round((time.perf_counter() - started) * 1000.0, 3),
            "error": error,
            "outputChars": sink.chars,
            "truncated": sink.truncated,
        }
        if capture:
            result["stdout"] = sink.text(1)
            result["stderr"] = sink.text(2)
        return result

    def describe(self) -> dict:
        names = sorted(k for k in self.namespace if not k.startswith("__"))
        return {"submissions": self.counter, "names": names[:200], "createdAt": self.created}
