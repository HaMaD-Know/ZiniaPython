import os
import shutil
import tempfile
import unittest
import uuid

from zinia import executor, streams


class RuntimeTestCase(unittest.TestCase):
    """Base class: a temporary project folder and helpers to run code in it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zinia-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self._streams = streams.redirected()
        self._streams.__enter__()
        self.addCleanup(self._streams.__exit__, None, None, None)

    def write(self, relative, text):
        path = os.path.join(self.tmp, relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def run_code(self, code, filename="main.py", **kwargs):
        path = filename if os.path.isabs(filename) or filename.startswith("<") else os.path.join(self.tmp, filename)
        request = executor.RunRequest(
            execution_id=kwargs.pop("execution_id", uuid.uuid4().hex),
            code=code, filename=path, cwd=kwargs.pop("cwd", self.tmp),
            project_root=kwargs.pop("project_root", self.tmp), capture=True, **kwargs)
        return executor.run_script(request, user_roots=(self.tmp,))
