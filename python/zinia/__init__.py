"""ZiniaPython runtime support package.

This package is bundled into the iOS app at ``<App.app>/app/zinia`` and is
imported by the native interpreter host (``ZPInterpreter.m``) right after
CPython has been initialised. It owns everything that is easier and safer to
express in Python than in C:

* routing ``sys.stdout`` / ``sys.stderr`` / ``sys.stdin`` to the IDE,
* running scripts with a predictable working directory and import path,
* turning exceptions into structured diagnostics,
* the interactive REPL session,
* the runtime self-test, and
* the pure-Python package installer.

The same code runs unchanged on desktop CPython, which is how the test suite
in ``python/tests`` exercises it on Windows, Linux and macOS.
"""

__version__ = "1.0.0"
PROTOCOL_VERSION = 1
