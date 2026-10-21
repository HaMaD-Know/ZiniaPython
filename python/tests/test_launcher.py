"""Starting other Python programs (subprocess / os.system) without processes.

The launcher is only installed where processes are unavailable (iOS). Here it
is forced on, so desktop CPython behaves like the app.
"""

import os
import subprocess
import sys

from ziniatest_support import RuntimeTestCase
from zinia import launcher


class LauncherTests(RuntimeTestCase):
    def setUp(self):
        super().setUp()
        self.assertTrue(launcher.install(force=True))
        self.addCleanup(launcher.uninstall)
        self.write("helper.py", "VALUE = 'v1'\n")
        self.write("other.py",
                   "import sys, helper\n"
                   "print('other', sys.argv[1:], helper.VALUE, __name__)\n"
                   "print('hello', input())\n"
                   "sys.exit(3)\n")
        self.write("crash.py", "def f():\n    return 1 / 0\nf()\n")

    def run_main(self, code):
        r = self.run_code(code)
        self.assertEqual(r["status"], "ok", r["error"] and r["error"]["traceback"])
        return r["stdout"]

    def test_run_with_arguments_input_and_capture(self):
        out = self.run_main(
            "import subprocess, sys\n"
            "r = subprocess.run([sys.executable, 'other.py', 'a b', 'c'], input='Ada\\n',"
            " capture_output=True, text=True)\n"
            "print(repr(r.stdout), r.returncode)\n")
        self.assertEqual(out, "\"other ['a b', 'c'] v1 __main__\\nhello Ada\\n\" 3\n")

    def test_output_goes_to_the_console_when_not_captured(self):
        out = self.run_main("import subprocess\n"
                            "print('rc', subprocess.call(['python3', '-c', 'print(\"from child\")']))\n")
        self.assertEqual(out, "from child\nrc 0\n")

    def test_os_system_and_popen(self):
        out = self.run_main("import os\n"
                            "print(os.system('python -c \"print(1+1)\"'))\n"
                            "with os.popen('python -c \"print(2+2)\"') as f:\n"
                            "    print(f.read().strip())\n"
                            "print(os.system('python -c \"import sys; sys.exit(2)\"') >> 8)\n")
        self.assertEqual(out, "2\n0\n4\n2\n")

    def test_python_name_variants_and_module_and_bytes(self):
        out = self.run_main("import subprocess, sys\n"
                            "for exe in ('python', 'python3', 'python3.14', sys.executable, '/usr/bin/python3'):\n"
                            "    print(subprocess.check_output([exe, '-c', 'print(7)']))\n"
                            "print(subprocess.run([sys.executable, '-m', 'helper']).returncode)\n")
        self.assertEqual(out, "b'7\\n'\n" * 5 + "0\n")

    def test_shell_string_and_popen_communicate(self):
        out = self.run_main("import subprocess\n"
                            "print(subprocess.run('python other.py x', shell=True, input='Bo',"
                            " capture_output=True, text=True).stdout.splitlines()[-1])\n"
                            "p = subprocess.Popen(['python', 'other.py'], stdin=subprocess.PIPE,"
                            " stdout=subprocess.PIPE, text=True)\n"
                            "out, err = p.communicate('Cy\\n')\n"
                            "print(out.splitlines()[-1], p.returncode, err)\n")
        self.assertEqual(out, "hello Bo\nhello Cy 3 None\n")

    def test_crash_missing_file_and_check(self):
        out = self.run_main(
            "import subprocess\n"
            "r = subprocess.run(['python', 'crash.py'], capture_output=True, text=True)\n"
            "lines = r.stderr.strip().splitlines()\n"
            "print(r.returncode, lines[-1], 'crash.py' in lines[1], 'runpy' in r.stderr)\n"
            "print(subprocess.run(['python', 'nope.py'], capture_output=True, text=True).returncode)\n"
            "try:\n"
            "    subprocess.check_call(['python', 'crash.py'], stderr=subprocess.DEVNULL)\n"
            "except subprocess.CalledProcessError as e:\n"
            "    print('raised', e.returncode)\n")
        self.assertEqual(out, "1 ZeroDivisionError: division by zero True False\n2\nraised 1\n")

    def test_other_commands_explain_the_ios_limit(self):
        r = self.run_code("import subprocess\nsubprocess.run(['ls', '-l'])\n")
        self.assertEqual(r["status"], "error")
        self.assertIn("iOS does not let apps start other programs", r["error"]["message"])
        r = self.run_code("import subprocess\nsubprocess.run(['pip', 'install', 'x'])\n")
        self.assertIn("Packages screen", r["error"]["message"])

    def test_caller_state_is_restored(self):
        out = self.run_main(
            "import subprocess, sys, os\n"
            "argv, cwd, path = list(sys.argv), os.getcwd(), list(sys.path)\n"
            "os.makedirs('sub', exist_ok=True)\n"
            "subprocess.run([sys.executable, '-c', 'import os; print(os.path.basename(os.getcwd()))'], cwd='sub')\n"
            "subprocess.run([sys.executable, '-c', 'import os; print(os.environ.get(\"ZT\"))'], env={'ZT': 'set'})\n"
            "print(sys.argv == argv, os.getcwd() == cwd, sys.path == path, 'ZT' in os.environ,"
            " sys.modules['__main__'].__dict__ is globals())\n")
        self.assertEqual(out, "sub\nset\nTrue True True False True\n")

    def test_modules_imported_by_the_program_are_fresh_next_time(self):
        out = self.run_main(
            "import subprocess, sys\n"
            "run = lambda: subprocess.run([sys.executable, 'other.py'], input='x', capture_output=True,"
            " text=True).stdout.split()[2]\n"
            "first = run()\n"
            "open('helper.py', 'w').write(\"VALUE = 'v2'\\n\")\n"
            "print(first, run(), 'helper' in sys.modules)\n")
        self.assertEqual(out, "v1 v2 False\n")

    def test_runaway_recursion_is_limited(self):
        self.write("loop.py", "import subprocess, sys\n"
                              "sys.exit(subprocess.run([sys.executable, 'loop.py']).returncode)\n")
        r = self.run_code("import subprocess, sys\nprint(subprocess.run([sys.executable, 'loop.py'],"
                          " capture_output=True, text=True).returncode)\n")
        self.assertEqual(r["status"], "ok", r["error"])
        self.assertEqual(r["stdout"], "1\n")

    def test_stop_stops_the_caller_too(self):
        self.write("spin.py", "raise KeyboardInterrupt\n")
        r = self.run_code("import subprocess, sys\nsubprocess.run([sys.executable, 'spin.py'])\nprint('after')\n")
        self.assertEqual(r["status"], "interrupted")
        self.assertEqual(r["stdout"], "")

    def test_only_installed_where_needed(self):
        launcher.uninstall()
        self.assertIs(subprocess.Popen, launcher._original_popen)
        self.assertEqual(launcher.install(), launcher.needed())
        self.assertFalse(launcher.needed() and sys.platform != "ios")
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "other.py")))
