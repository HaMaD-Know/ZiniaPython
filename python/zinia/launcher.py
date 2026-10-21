"""Run Python programs that a script starts as "subprocesses", inside the app.

iOS does not let apps start processes: on the device ``subprocess.Popen``
raises ``OSError: ios does not support processes`` and ``os.system`` does not
exist. Yet a common way to organise a project is a ``main.py`` that starts the
other files::

    subprocess.run([sys.executable, "other.py", "arg"])
    subprocess.run(["python3", "-m", "tool"], capture_output=True, text=True)
    os.system("python other.py")

``install()`` replaces ``subprocess.Popen`` (which ``run``, ``call``,
``check_call``, ``check_output`` and ``os.popen`` all use) and adds
``os.system``. A command whose program is Python (``python``, ``python3``,
``python3.14``, ``sys.executable``) is run with the same interpreter, in the
calling thread:

- the script, ``-m module`` or ``-c code`` runs as ``__main__`` with its own
  ``sys.argv``, working directory (``cwd=``) and environment (``env=``);
- output goes to the console, or is captured with ``stdout=PIPE`` /
  ``capture_output=True``; ``input=`` and ``stdin=PIPE`` feed ``input()``;
- the return code is 0, the ``sys.exit()`` code, or 1 after an uncaught
  exception, whose traceback goes to the program's stderr;
- modules the program imported from your folders are forgotten afterwards,
  so the next program imports fresh copies, as a new process would.

It is not a separate process: the call returns when the program has finished
(``Popen`` does not run in parallel; ``timeout=`` is not enforced), the
program shares the interpreter with its caller (already-imported modules,
threads, ``zinia_draw`` canvas) and Stop stops both. Any other command (``ls``,
``git``, ``pip``) raises ``OSError`` with an explanation.
"""

from __future__ import annotations

import io
import os
import runpy
import shlex
import subprocess
import sys
import threading
import traceback

from . import errors

_PYTHON_NAMES = ("python", "python3", "py")
MAX_DEPTH = 16
_installed = False
_original_popen = subprocess.Popen
_original_system = getattr(os, "system", None)
_local = threading.local()


class LaunchError(OSError):
    pass


# ---------------------------------------------------------------------------
# command line parsing
# ---------------------------------------------------------------------------

def _is_python(program: str) -> bool:
    if not program:
        return False
    if sys.executable and os.path.normcase(program) == os.path.normcase(sys.executable):
        return True
    name = os.path.basename(program).lower()
    if name.endswith(".exe"):
        name = name[:-4]
    if name in _PYTHON_NAMES:
        return True
    # python3.14, python3.12 ...
    return name.startswith("python3.") and name[len("python3."):].isdigit()


def parse(args, shell: bool = False) -> dict:
    """Turn a command into {"kind": "path"|"module"|"code", "target", "argv"}."""
    if isinstance(args, (str, bytes, os.PathLike)) and not isinstance(args, (list, tuple)):
        text = os.fsdecode(args)
        argv = shlex.split(text) if (shell or " " in text.strip()) else [text]
    else:
        argv = [os.fsdecode(a) for a in args]
    if not argv:
        raise LaunchError(2, "No command given")
    if not _is_python(argv[0]):
        program = os.path.basename(argv[0])
        hint = ("Install packages from the Packages screen instead."
                if program in ("pip", "pip3") or argv[1:2] == ["-m"] and argv[2:3] == ["pip"] else
                "Only Python programs can be started: use [sys.executable, 'file.py', ...] "
                "or 'python file.py', which ZiniaPython runs inside the app.")
        raise LaunchError(45, f"iOS does not let apps start other programs ({program!r}). {hint}")
    rest = argv[1:]
    i = 0
    while i < len(rest):
        opt = rest[i]
        if opt == "-m" and i + 1 < len(rest):
            return {"kind": "module", "target": rest[i + 1], "argv": [rest[i + 1]] + rest[i + 2:]}
        if opt == "-c" and i + 1 < len(rest):
            return {"kind": "code", "target": rest[i + 1], "argv": ["-c"] + rest[i + 2:]}
        if opt.startswith("-m") and len(opt) > 2:
            return {"kind": "module", "target": opt[2:], "argv": [opt[2:]] + rest[i + 1:]}
        if opt.startswith("-c") and len(opt) > 2:
            return {"kind": "code", "target": opt[2:], "argv": ["-c"] + rest[i + 1:]}
        if opt in ("-u", "-B", "-E", "-s", "-S", "-I", "-O", "-OO", "-q", "-b", "-bb", "-P"):
            i += 1  # options without effect here
            continue
        if opt in ("-W", "-X") and i + 1 < len(rest):
            i += 2
            continue
        if opt.startswith(("-W", "-X")):
            i += 1
            continue
        if opt == "-":
            raise LaunchError(22, "Reading a program from stdin ('python -') is not supported")
        if opt.startswith("-") and opt not in ("--",):
            raise LaunchError(22, f"Unsupported python option {opt!r} (supported: script, -m, -c, -u)")
        if opt == "--":
            i += 1
            continue
        return {"kind": "path", "target": opt, "argv": rest[i:]}
    raise LaunchError(22, "Starting an interactive Python is not supported; give a script, -m or -c")


# ---------------------------------------------------------------------------
# running a program in-process
# ---------------------------------------------------------------------------

class _Tee(io.TextIOBase):
    """A text stream for the child's stdout/stderr."""

    def __init__(self, target=None, collect: bool = False):
        self.target = target
        self.collect = io.StringIO() if collect else None

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if self.collect is not None:
            self.collect.write(text)
        elif self.target is not None:
            self.target.write(text)
        return len(text)

    def flush(self):
        if self.target is not None and hasattr(self.target, "flush"):
            self.target.flush()

    @property
    def encoding(self):
        return "utf-8"


def _user_roots(cwd: str, script: str | None) -> tuple:
    roots = {cwd}
    if script:
        roots.add(os.path.dirname(os.path.abspath(script)))
    return tuple(roots)


def run_program(command: dict, *, cwd=None, env=None, stdin_text=None, stdout=None, stderr=None) -> int:
    """Run a parsed command as __main__; returns its exit code.

    ``stdout``/``stderr`` are text streams (None: the caller's own).
    ``stdin_text``: None keeps the caller's stdin, a str replaces it.
    """
    depth = getattr(_local, "depth", 0)
    if depth >= MAX_DEPTH:
        raise LaunchError(11, f"Programs started each other more than {MAX_DEPTH} levels deep")
    from . import executor  # late import: executor imports this module

    saved = {
        "argv": sys.argv, "path": list(sys.path), "cwd": os.getcwd(), "main": sys.modules.get("__main__"),
        "stdin": sys.stdin, "stdout": sys.stdout, "stderr": sys.stderr, "environ": dict(os.environ),
    }
    work_dir = os.path.abspath(os.fspath(cwd)) if cwd is not None else saved["cwd"]
    script = None
    if command["kind"] == "path":
        script = os.path.join(work_dir, os.path.expanduser(command["target"]))
        if not os.path.exists(script):
            # What CPython itself prints for a missing script, exit status 2.
            (stderr or sys.stderr).write(
                f"python: can't open file {script!r}: [Errno 2] No such file or directory\n")
            return 2
    before = set(sys.modules)
    code = 0
    _local.depth = depth + 1
    try:
        if not os.path.isdir(work_dir):
            raise FileNotFoundError(2, "No such directory", work_dir)
        os.chdir(work_dir)
        if env is not None:
            os.environ.clear()
            os.environ.update({os.fsdecode(k): os.fsdecode(v) for k, v in env.items()})
        if stdin_text is not None:
            sys.stdin = io.StringIO(stdin_text)
        if stdout is not None:
            sys.stdout = stdout
        if stderr is not None:
            sys.stderr = stderr
        try:
            if command["kind"] == "path":
                sys.argv = list(command["argv"])  # argv[0] as given, like CPython
                sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
                runpy.run_path(script, run_name="__main__")
            elif command["kind"] == "module":
                sys.argv = list(command["argv"])
                sys.path.insert(0, work_dir)
                runpy.run_module(command["target"], run_name="__main__", alter_sys=True)
            else:
                sys.argv = list(command["argv"])
                sys.path.insert(0, "")
                exec(compile(command["target"], "<string>", "exec"), {"__name__": "__main__", "__builtins__": __builtins__})
        except SystemExit as exc:
            code = errors.exit_code_of(exc)
            if exc.code is not None and not isinstance(exc.code, int):
                sys.stderr.write(f"{exc.code}\n")
        except KeyboardInterrupt:
            raise  # Stop ends the caller too
        except BaseException as exc:  # noqa: BLE001 - report like a crashed process
            sys.stderr.write(_program_traceback(exc))
            code = 1
        finally:
            for stream in (sys.stdout, sys.stderr):
                try:
                    stream.flush()
                except Exception:  # noqa: BLE001
                    pass
    finally:
        _local.depth = depth
        sys.stdin, sys.stdout, sys.stderr = saved["stdin"], saved["stdout"], saved["stderr"]
        sys.argv = saved["argv"]
        sys.path[:] = saved["path"]
        if saved["main"] is not None:
            sys.modules["__main__"] = saved["main"]
        if env is not None:
            os.environ.clear()
            os.environ.update(saved["environ"])
        try:
            os.chdir(saved["cwd"])
        except OSError:
            pass
        # Like a finished process: forget the user modules it imported, so the
        # next program gets fresh ones. Modules the caller imported stay.
        _forget_new_user_modules(before, _user_roots(work_dir, script), executor)
    return code


def _forget_new_user_modules(before: set, roots, executor) -> None:
    prefixes = executor._root_prefixes(roots)
    if not prefixes:
        return
    for name in set(sys.modules) - before:
        module = sys.modules.get(name)
        file = getattr(module, "__file__", None)
        if name == "__main__" or name == "zinia" or name.startswith("zinia.") or not isinstance(file, str):
            continue
        if executor._norm(file).startswith(prefixes) or executor._resolved(file).startswith(prefixes):
            sys.modules.pop(name, None)


def _program_traceback(exc: BaseException) -> str:
    """The traceback a crashed `python script.py` would print: from the script on."""
    tb = exc.__traceback__
    while tb is not None and (errors.is_internal(tb.tb_frame.f_code.co_filename)
                              or tb.tb_frame.f_code.co_filename.endswith(("runpy.py", "<frozen runpy>"))):
        tb = tb.tb_next
    return "".join(traceback.format_exception(type(exc), exc, tb))


# ---------------------------------------------------------------------------
# subprocess.Popen replacement
# ---------------------------------------------------------------------------

def _to_text(data, text_mode, encoding, errors_mode):
    if data is None:
        return None
    if isinstance(data, str):
        return data
    return bytes(data).decode(encoding or "utf-8", errors_mode or "strict")


class InProcessPopen:
    """Enough of subprocess.Popen for run(), call(), check_output() and os.popen()."""

    def __init__(self, args, bufsize=-1, executable=None, stdin=None, stdout=None, stderr=None,
                 preexec_fn=None, close_fds=True, shell=False, cwd=None, env=None,
                 universal_newlines=None, startupinfo=None, creationflags=0, restore_signals=True,
                 start_new_session=False, pass_fds=(), *, user=None, group=None, extra_groups=None,
                 encoding=None, errors=None, text=None, umask=-1, pipesize=-1, process_group=None):
        self.args = args
        command_line = [executable] + list(args)[1:] if executable and not isinstance(args, (str, bytes)) else args
        self._command = parse(command_line, shell=shell)
        self.text_mode = bool(text or universal_newlines or encoding or errors)
        self.encoding = encoding
        self.errors = errors
        self._stdin_spec, self._stdout_spec, self._stderr_spec = stdin, stdout, stderr
        self._cwd, self._env = cwd, env
        self.pid = -1  # there is no separate process
        self.returncode = None
        self._out = self._err = None
        self.stdin = io.StringIO() if (stdin == subprocess.PIPE and self.text_mode) else (
            io.BytesIO() if stdin == subprocess.PIPE else None)
        self.stdout = _LazyPipe(self, "out") if stdout == subprocess.PIPE else None
        self.stderr = _LazyPipe(self, "err") if stderr == subprocess.PIPE else None
        if stdin != subprocess.PIPE:
            self._run(None)

    # -- running
    def _stream(self, spec, name, merged_into=None):
        if spec == subprocess.PIPE:
            return _Tee(collect=True)
        if spec == subprocess.DEVNULL:
            return _Tee()
        if spec == subprocess.STDOUT and merged_into is not None:
            return merged_into
        if spec is None:
            return None  # the caller's console
        if isinstance(spec, int):
            raise LaunchError(22, "Passing file descriptors is not supported; use PIPE or a file object")
        if hasattr(spec, "write"):
            if isinstance(spec, io.TextIOBase) or "b" not in getattr(spec, "mode", "w"):
                return _Tee(target=spec)
            return _Tee(target=_BinaryWriter(spec))
        raise LaunchError(22, f"Unsupported stream {spec!r}")

    def _run(self, input_data):
        if self.returncode is not None:
            return
        stdin_text = None
        if self._stdin_spec == subprocess.PIPE:
            pending = self.stdin.getvalue() if self.stdin is not None else ""
            stdin_text = _to_text(pending, True, self.encoding, self.errors) + (
                _to_text(input_data, True, self.encoding, self.errors) or "")
        elif self._stdin_spec == subprocess.DEVNULL:
            stdin_text = ""
        elif hasattr(self._stdin_spec, "read"):
            stdin_text = _to_text(self._stdin_spec.read(), True, self.encoding, self.errors)
        out = self._stream(self._stdout_spec, "stdout")
        err = self._stream(self._stderr_spec, "stderr", merged_into=out)
        self.returncode = run_program(self._command, cwd=self._cwd, env=self._env,
                                      stdin_text=stdin_text, stdout=out, stderr=err)
        self._out = self._collected(out) if self._stdout_spec == subprocess.PIPE else None
        self._err = self._collected(err) if self._stderr_spec == subprocess.PIPE else None

    def _collected(self, stream):
        text = stream.collect.getvalue() if stream is not None and stream.collect is not None else ""
        if self.text_mode:
            return text.replace("\r\n", "\n")
        return text.encode(self.encoding or "utf-8", self.errors or "strict")

    # -- Popen API
    def communicate(self, input=None, timeout=None):  # noqa: A002 - Popen's own name
        self._run(input)
        out, err = self._out, self._err
        self._out = self._err = None
        if self.stdout is not None:
            self.stdout.close()
        if self.stderr is not None:
            self.stderr.close()
        return out, err

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self._run(None)
        return self.returncode

    def send_signal(self, sig):
        pass  # the program has already finished

    def terminate(self):
        pass

    def kill(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.wait()
        return False

    def __repr__(self):
        return f"<InProcessPopen: returncode: {self.returncode} args: {self.args!r}>"


class _BinaryWriter:
    def __init__(self, raw):
        self.raw = raw

    def write(self, text):
        self.raw.write(text.encode("utf-8"))

    def flush(self):
        self.raw.flush()


class _LazyPipe:
    """p.stdout / p.stderr: reading runs the program first (when stdin was a PIPE)."""

    def __init__(self, popen: InProcessPopen, which: str):
        self._popen = popen
        self._which = which
        self._buffer = None
        self.closed = False

    def _data(self):
        if self._buffer is None:
            self._popen._run(None)
            data = self._popen._out if self._which == "out" else self._popen._err
            if self._which == "out":
                self._popen._out = None
            else:
                self._popen._err = None
            if data is None:
                data = "" if self._popen.text_mode else b""
            self._buffer = io.StringIO(data) if isinstance(data, str) else io.BytesIO(data)
        return self._buffer

    def read(self, *args):
        return self._data().read(*args)

    def readline(self, *args):
        return self._data().readline(*args)

    def readlines(self, *args):
        return self._data().readlines(*args)

    def __iter__(self):
        return iter(self._data())

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def system(command) -> int:
    """os.system() for Python commands: output goes to the console."""
    try:
        code = run_program(parse(command, shell=True))
    except LaunchError as exc:
        sys.stderr.write(f"{exc.strerror}\n")
        return 127 << 8
    return (code & 0xFF) << 8  # a POSIX wait status, like os.system


# ---------------------------------------------------------------------------
# installation
# ---------------------------------------------------------------------------

def needed() -> bool:
    """True where the platform cannot start processes (iOS)."""
    return not getattr(subprocess, "_can_fork_exec", True)


def install(force: bool = False) -> bool:
    """Route Python "subprocesses" through the in-process launcher (iOS only unless forced)."""
    global _installed
    if _installed or not (force or needed()):
        return _installed
    subprocess.Popen = InProcessPopen
    os.system = system
    _installed = True
    return True


def uninstall() -> None:
    global _installed
    subprocess.Popen = _original_popen
    if _original_system is not None:
        os.system = _original_system
    elif hasattr(os, "system"):
        del os.system
    _installed = False
