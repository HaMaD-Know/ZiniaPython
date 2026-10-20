"""Regenerates tests/fixtures/python-errors.json from real CPython.

    python -I scripts/generate-error-fixtures.py

The frontend tests render these structured errors. Generating them with the
real zinia executor (instead of writing them by hand) keeps the UI tests
honest about what the runtime actually produces.
"""

import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from zinia import executor, streams  # noqa: E402

CASES = {
    "syntax": "def broken(:\n    pass\n",
    "runtime": "print(1 / 0)\n",
    "missingModule": "import zinia_missing_fixture\n",
}


def main() -> None:
    out = {"python": sys.version.split()[0]}
    with tempfile.TemporaryDirectory() as tmp, streams.redirected():
        for name, code in CASES.items():
            path = os.path.join(tmp, "main.py").replace("\\", "/")
            result = executor.run_script(executor.RunRequest(
                execution_id=name, code=code, filename="/workspace/MyProject/main.py",
                cwd=tmp, project_root=tmp, capture=True))
            error = result["error"]
            # Use a stable, iOS-like path so the fixture does not depend on this machine.
            out[name] = json.loads(json.dumps(error).replace(path, "/workspace/MyProject/main.py"))
    target = os.path.join(ROOT, "tests", "fixtures", "python-errors.json")
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
