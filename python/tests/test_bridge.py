import json
import os
import shutil
import tempfile
import unittest

from zinia import bridge, selftest, streams


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="zinia-bridge-")
        cls.workspace = os.path.join(cls.tmp, "Workspace")
        os.makedirs(cls.workspace)
        cls.saved_cwd = os.getcwd()
        cls.saved_exit = os._exit
        reply = json.loads(bridge.initialize(json.dumps({
            "workspaceRoot": cls.workspace,
            "sitePackages": os.path.join(cls.tmp, "site-packages"),
            "installStreams": False,
        })))
        assert reply["ok"], reply
        cls.info = reply["result"]

    @classmethod
    def tearDownClass(cls):
        os.chdir(cls.saved_cwd)
        os._exit = cls.saved_exit
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self._streams = streams.redirected()
        self._streams.__enter__()
        self.addCleanup(self._streams.__exit__, None, None, None)

    def call(self, **request):
        return json.loads(bridge.handle(json.dumps(request)))

    def test_runtime_info(self):
        self.assertEqual(self.info["implementation"], "CPython")
        self.assertTrue(self.info["utf8Mode"] in (True, False))
        self.assertEqual(self.info["workspaceRoot"], self.workspace)
        self.assertEqual(self.info["executionModel"]["concurrentRuns"], False)

    def test_execute_round_trip(self):
        reply = self.call(op="execute", executionId="e1", code="print('hi')", capture=True,
                          filename=os.path.join(self.workspace, "a.py"), cwd=self.workspace)
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["result"]["stdout"], "hi\n")

    def test_execute_file(self):
        path = os.path.join(self.workspace, "f.py")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("print('from file', __file__.endswith('f.py'))\n")
        reply = self.call(op="executeFile", executionId="e2", path=path, capture=True)
        self.assertEqual(reply["result"]["stdout"], "from file True\n")

    def test_invalid_arguments(self):
        reply = self.call(op="execute", executionId="e3", code=123)
        self.assertEqual(reply["error"]["code"], "INVALID_ARGUMENT")
        reply = self.call(op="execute", executionId="e3", code="1", cwd="relative/path")
        self.assertEqual(reply["error"]["code"], "INVALID_ARGUMENT")
        reply = self.call(op="bogus")
        self.assertEqual(reply["error"]["code"], "UNKNOWN_OP")
        self.assertEqual(json.loads(bridge.handle("not json"))["error"]["code"], "INTERNAL")

    def test_repl_and_reset(self):
        self.assertTrue(self.call(op="repl", executionId="r1", source="z = 9")["ok"])
        reply = self.call(op="repl", executionId="r2", source="z", capture=True)
        self.assertEqual(reply["result"]["stdout"], "9\n")
        self.assertTrue(self.call(op="reset")["result"]["replReset"])
        reply = self.call(op="repl", executionId="r3", source="z", capture=True)
        self.assertEqual(reply["result"]["error"]["type"], "NameError")

    def test_os_exit_is_guarded(self):
        reply = self.call(op="execute", executionId="e4", code="import os\nos._exit(7)\n", capture=True,
                          filename="<t>", cwd=self.workspace)
        result = reply["result"]
        self.assertEqual((result["status"], result["exitCode"]), ("exit", 7))
        self.assertIn("os._exit() was intercepted", result["stderr"])

    def test_module_check(self):
        reply = self.call(op="modules", names=["json", "zinia_definitely_missing"])
        mods = {m["module"]: m for m in reply["result"]["modules"]}
        self.assertTrue(mods["json"]["available"])
        self.assertFalse(mods["zinia_definitely_missing"]["available"])

    def test_packages_list_empty(self):
        reply = self.call(op="packages.list")
        self.assertEqual(reply["result"]["packages"], [])


class SelfTestTests(unittest.TestCase):
    def test_selftest_cases_pass_on_desktop_cpython(self):
        with streams.redirected():
            report = selftest.run_all(include_modules=True)
        failed = [c for c in report["cases"] if not c["passed"]]
        self.assertEqual(failed, [], json.dumps(failed, indent=2))
        self.assertEqual(report["summary"]["requiredModulesMissing"], [])
