"""Run the ZiniaPython runtime test-suite on desktop CPython.

    python -I python/tests/run_tests.py

These tests execute real Python code through the same ``zinia`` package that
is bundled into the iOS app. They prove the execution engine's behaviour, but
they do not prove that the iOS build links and starts CPython - that is checked
by the simulator self-test in .github/workflows/build-ios.yml.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # the "python" folder that contains "zinia"
sys.path.insert(0, HERE)


def main() -> int:
    suite = unittest.defaultTestLoader.discover(HERE, pattern="test_*.py", top_level_dir=HERE)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
