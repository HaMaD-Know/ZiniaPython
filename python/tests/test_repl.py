import uuid

from ziniatest_support import RuntimeTestCase
from zinia.repl import ReplSession


class ReplTests(RuntimeTestCase):
    def setUp(self):
        super().setUp()
        self.repl = ReplSession()

    def send(self, source, mode="line"):
        return self.repl.execute(execution_id=uuid.uuid4().hex, source=source, mode=mode,
                                 cwd=self.tmp, project_root=self.tmp, capture=True, user_roots=(self.tmp,))

    def test_expression_value_is_displayed(self):
        self.assertEqual(self.send("1 + 1")["stdout"], "2\n")

    def test_state_persists_between_submissions(self):
        self.assertEqual(self.send("x = 40")["stdout"], "")
        self.assertEqual(self.send("x + 2")["stdout"], "42\n")

    def test_incomplete_block_then_complete(self):
        r = self.send("for i in range(2):")
        self.assertEqual(r["status"], "incomplete")
        r = self.send("for i in range(2):\n    print(i)\n")
        self.assertEqual((r["status"], r["stdout"]), ("ok", "0\n1\n"))

    def test_block_mode_displays_last_expression(self):
        r = self.send("a = 3\nb = 4\na * b", mode="block")
        self.assertEqual(r["stdout"], "12\n")

    def test_traceback_and_recovery(self):
        r = self.send("1/0")
        self.assertEqual(r["error"]["type"], "ZeroDivisionError")
        self.assertIn('File "<input-', r["error"]["traceback"])
        self.assertEqual(self.send("'still here'")["stdout"], "'still here'\n")

    def test_syntax_error(self):
        r = self.send("x = = 1")
        self.assertEqual(r["error"]["category"], "syntax")

    def test_reset_clears_namespace(self):
        self.send("secret = 1")
        self.repl.reset()
        r = self.send("secret")
        self.assertEqual(r["error"]["type"], "NameError")

    def test_underscore_holds_last_result(self):
        self.send("6 * 7")
        self.assertEqual(self.send("_")["stdout"], "42\n")

    def test_import_project_module(self):
        self.write("tools.py", "def f():\n    return 'tool'\n")
        self.assertEqual(self.send("import tools; tools.f()")["stdout"], "'tool'\n")

    def test_exit_is_reported_not_fatal(self):
        r = self.send("raise SystemExit(2)")
        self.assertEqual((r["status"], r["exitCode"]), ("exit", 2))
        self.assertEqual(self.send("1")["stdout"], "1\n")
