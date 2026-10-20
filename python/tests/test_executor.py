import os
import sys
import threading
import _thread

from ziniatest_support import RuntimeTestCase
from zinia import executor


class SpecScriptTests(RuntimeTestCase):
    """Tests 1-8 and 12 from the specification, executed by real CPython."""

    def test_01_hello_world(self):
        r = self.run_code('print("Hello, ZiniaPython!")\n')
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["stdout"], "Hello, ZiniaPython!\n")
        self.assertIsNone(r["error"])

    def test_02_arithmetic(self):
        self.assertEqual(self.run_code("print(2 + 3 * 4)\n")["stdout"], "14\n")

    def test_03_loop(self):
        self.assertEqual(self.run_code("for i in range(3):\n    print(i)\n")["stdout"], "0\n1\n2\n")

    def test_04_standard_library(self):
        r = self.run_code('import json\nprint(json.dumps({"ok": True}))\n')
        import json
        self.assertEqual(json.loads(r["stdout"]), {"ok": True})

    def test_05_functions(self):
        r = self.run_code("def add(a, b):\n    return a + b\n\nprint(add(20, 22))\n")
        self.assertEqual(r["stdout"], "42\n")

    def test_06_syntax_error(self):
        r = self.run_code("def broken(:\n    pass\n")
        self.assertEqual(r["status"], "error")
        err = r["error"]
        self.assertEqual(err["category"], "syntax")
        self.assertEqual(err["type"], "SyntaxError")
        self.assertEqual(err["syntax"]["lineno"], 1)
        self.assertIsNotNone(err["syntax"]["offset"])
        self.assertTrue(err["syntax"]["filename"].endswith("main.py"))
        self.assertIn("SyntaxError", err["traceback"])
        self.assertEqual(r["stdout"], "")

    def test_07_runtime_error_traceback(self):
        r = self.run_code("print(1 / 0)\n")
        err = r["error"]
        self.assertEqual(r["status"], "error")
        self.assertEqual(err["type"], "ZeroDivisionError")
        self.assertEqual(err["category"], "runtime")
        self.assertIn("Traceback (most recent call last):", err["traceback"])
        self.assertIn("print(1 / 0)", err["traceback"])
        self.assertIn("ZeroDivisionError: division by zero", err["traceback"])
        self.assertEqual(err["location"]["lineno"], 1)
        # Frames belonging to ZiniaPython's own executor are hidden.
        self.assertNotIn("executor.py", err["traceback"])

    def test_print_then_raise(self):
        r = self.run_code('print("Hello from ZiniaPython")\nraise ValueError("Example error")\n')
        self.assertEqual(r["stdout"], "Hello from ZiniaPython\n")
        self.assertEqual(r["error"]["type"], "ValueError")
        self.assertEqual(r["error"]["message"], "Example error")
        self.assertEqual(r["error"]["location"]["lineno"], 2)

    def test_08_user_modules(self):
        self.write("helpers.py", "def double(x):\n    return x * 2\n")
        main = "from helpers import double\nprint(double(21))\n"
        self.write("main.py", main)
        r = self.run_code(main)
        self.assertEqual(r["status"], "ok", r["error"])
        self.assertEqual(r["stdout"], "42\n")

    def test_08b_helper_changes_are_picked_up(self):
        self.write("helpers.py", "VALUE = 1\n")
        main = "import helpers\nprint(helpers.VALUE)\n"
        self.assertEqual(self.run_code(main)["stdout"], "1\n")
        self.write("helpers.py", "VALUE = 2\n")
        self.assertEqual(self.run_code(main)["stdout"], "2\n")
        self.assertNotIn("helpers", sys.modules)

    def test_08c_packages_and_subfolders(self):
        self.write("pkg/__init__.py", "")
        self.write("pkg/util.py", "def hi():\n    return 'hi from pkg'\n")
        self.write("scripts/tool.py", "")
        r = self.run_code("from pkg.util import hi\nprint(hi())\n", filename="scripts/tool.py")
        # sys.path[0] is the script's folder and the project root follows it.
        self.assertEqual(r["stdout"], "hi from pkg\n", r["error"])

    def test_09_file_operations_in_working_directory(self):
        code = ("import os\nopen('a.txt','w',encoding='utf-8').write('ünïcode ✓')\n"
                "os.rename('a.txt','b.txt')\nprint(open('b.txt',encoding='utf-8').read())\n"
                "os.remove('b.txt')\nprint(os.listdir('.'))\n")
        r = self.run_code(code)
        self.assertEqual(r["status"], "ok", r["error"])
        self.assertEqual(r["stdout"], "ünïcode ✓\n[]\n")

    def test_12_missing_module(self):
        r = self.run_code("import zinia_no_such_module_xyz\n")
        err = r["error"]
        self.assertEqual(err["category"], "import")
        self.assertEqual(err["type"], "ModuleNotFoundError")
        self.assertEqual(err["missingModule"], "zinia_no_such_module_xyz")
        self.assertIn("No module named", err["traceback"])
        self.assertIn("explanation", err["moduleHelp"])

    def test_known_ios_module_explanation(self):
        r = self.run_code("raise ModuleNotFoundError(\"No module named '_tkinter'\", name='_tkinter')\n")
        self.assertEqual(r["error"]["moduleHelp"]["category"], "native-extension")


class ExecutionModelTests(RuntimeTestCase):
    def test_working_directory_and_restoration(self):
        before_cwd, before_path, before_argv = os.getcwd(), list(sys.path), list(sys.argv)
        r = self.run_code("import os, sys\nprint(os.getcwd())\nprint(sys.argv[0])\nsys.path.append('/x')\n"
                          "os.chdir('..')\n")
        lines = r["stdout"].splitlines()
        # os.getcwd() reports the resolved path (/private/var/... on macOS and iOS).
        self.assertEqual(os.path.normcase(os.path.realpath(lines[0])), os.path.normcase(os.path.realpath(self.tmp)))
        self.assertTrue(lines[1].endswith("main.py"))
        self.assertEqual(os.getcwd(), before_cwd)
        self.assertEqual(sys.path, before_path)
        self.assertEqual(sys.argv, before_argv)

    def test_main_guard_and_fresh_namespace(self):
        r1 = self.run_code("x = 5\nif __name__ == '__main__':\n    print('main', __file__.endswith('main.py'))\n")
        self.assertEqual(r1["stdout"], "main True\n")
        r2 = self.run_code("print('x' in globals())\n")
        self.assertEqual(r2["stdout"], "False\n")

    def test_untitled_buffer(self):
        r = self.run_code("print(__name__)\nprint('__file__' in globals())\n1/0\n", filename="<untitled-1>")
        self.assertEqual(r["stdout"], "__main__\nFalse\n")
        self.assertIn('File "<untitled-1>", line 3', r["error"]["traceback"])
        self.assertIn("1/0", r["error"]["traceback"])

    def test_unsaved_buffer_lines_in_traceback(self):
        # The file on disk differs from the buffer that runs (unsaved edits).
        self.write("main.py", "print('old version')\n")
        r = self.run_code("x = 1\ny = 0\nprint(x / y)  # unsaved\n")
        self.assertIn("print(x / y)  # unsaved", r["error"]["traceback"])
        self.assertEqual(r["error"]["location"]["lineno"], 3)

    def test_error_location_in_helper_module(self):
        helper = self.write("helpers.py", "def boom():\n    return {}['missing']\n")
        r = self.run_code("import helpers\nhelpers.boom()\n")
        loc = r["error"]["location"]
        # The deepest frame in user code (the helper) is reported, not main.py.
        self.assertEqual(os.path.normcase(loc["filename"]), os.path.normcase(helper))
        self.assertEqual(loc["lineno"], 2)
        self.assertEqual(r["error"]["type"], "KeyError")

    def test_stdin_supplied_and_eof(self):
        r = self.run_code("a = input('A? ')\nb = input()\nprint(a + b)\n", stdin="1\n2\n")
        self.assertEqual(r["stdout"], "A? 12\n")
        r = self.run_code("input()\n")
        self.assertEqual(r["error"]["type"], "EOFError")

    def test_stderr_is_separate(self):
        r = self.run_code("import sys\nprint('out')\nprint('err', file=sys.stderr)\n")
        self.assertEqual(r["stdout"], "out\n")
        self.assertEqual(r["stderr"], "err\n")

    def test_sys_exit_codes(self):
        self.assertEqual(self.run_code("import sys\nsys.exit()\n")["status"], "ok")
        r = self.run_code("import sys\nsys.exit(4)\n")
        self.assertEqual((r["status"], r["exitCode"]), ("exit", 4))
        r = self.run_code("raise SystemExit('bye')\n")
        self.assertEqual((r["status"], r["exitCode"], r["stderr"]), ("exit", 1, "bye\n"))

    def test_output_limit(self):
        r = self.run_code("for i in range(5000):\n    print('x' * 10)\n", output_limit=2000)
        self.assertTrue(r["truncated"])
        self.assertEqual(len(r["stdout"]), 2000)
        self.assertEqual(r["status"], "ok")

    def test_recursion_limit_restored(self):
        before = sys.getrecursionlimit()
        self.run_code("import sys\nsys.setrecursionlimit(50)\n")
        self.assertEqual(sys.getrecursionlimit(), before)

    def test_recursion_error_is_reported(self):
        r = self.run_code("def f():\n    return f()\nf()\n")
        self.assertEqual(r["error"]["type"], "RecursionError")

    def test_missing_working_directory(self):
        r = self.run_code("print(1)\n", cwd=os.path.join(self.tmp, "nope"))
        self.assertEqual(r["error"]["category"], "environment")

    def test_bytes_written_to_stdout_buffer(self):
        r = self.run_code("import sys\nsys.stdout.buffer.write('é\\n'.encode())\n")
        self.assertEqual(r["stdout"], "é\n")

    def test_duration_is_measured(self):
        r = self.run_code("import time\ntime.sleep(0.05)\n")
        self.assertGreaterEqual(r["durationMs"], 45)


class InterruptTests(RuntimeTestCase):
    """Test 11: a long-running script stops when interrupted."""

    def test_11_busy_loop_is_interrupted(self):
        self.assertIs(threading.current_thread(), threading.main_thread())
        timer = threading.Timer(0.2, _thread.interrupt_main)
        timer.start()
        try:
            r = self.run_code("while True:\n    pass\n")
        finally:
            timer.cancel()
        self.assertEqual(r["status"], "interrupted")
        self.assertEqual(r["error"]["category"], "interrupt")
        # The interpreter is still usable afterwards.
        self.assertEqual(self.run_code("print('alive')\n")["stdout"], "alive\n")

    def test_script_cannot_disable_stop_permanently(self):
        import signal
        original = signal.getsignal(signal.SIGINT)
        self.run_code("import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\n")
        self.assertIs(signal.getsignal(signal.SIGINT), original)


class PurgeTests(RuntimeTestCase):
    def test_purge_only_user_modules(self):
        self.write("mymod.py", "X = 1\n")
        sys.path.insert(0, self.tmp)
        try:
            import mymod  # noqa: F401
        finally:
            sys.path.remove(self.tmp)
        removed = executor.purge_user_modules([self.tmp])
        self.assertIn("mymod", removed)
        self.assertIn("json", sys.modules)

    def test_purge_matches_symlinked_and_resolved_paths(self):
        # Like /var -> /private/var on Apple platforms: the root is given in one
        # form and the module was imported through the other.
        real = os.path.join(self.tmp, "real")
        alias = os.path.join(self.tmp, "alias")
        os.makedirs(real)
        try:
            os.symlink(real, alias, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("creating symlinks is not permitted here")
        with open(os.path.join(real, "aliasmod.py"), "w", encoding="utf-8") as fh:
            fh.write("X = 1\n")
        sys.path.insert(0, real)
        try:
            import aliasmod  # noqa: F401
        finally:
            sys.path.remove(real)
        self.assertIn("aliasmod", executor.purge_user_modules([alias]))
