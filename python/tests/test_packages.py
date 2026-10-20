import hashlib
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

from zinia import packages


def build_wheel(directory, name, version, files, *, tag="py3-none-any", requires=(), purelib=True,
                extra_entries=()):
    dist = f"{name.replace('-', '_')}-{version}"
    filename = f"{dist}-{tag}.whl"
    path = os.path.join(directory, filename)
    meta = [f"Metadata-Version: 2.1", f"Name: {name}", f"Version: {version}", "Summary: test package"]
    meta += [f"Requires-Dist: {r}" for r in requires]
    with zipfile.ZipFile(path, "w") as zf:
        for rel, text in files.items():
            zf.writestr(rel, text)
        for rel, text in extra_entries:
            zf.writestr(rel, text)
        zf.writestr(f"{dist}.dist-info/METADATA", "\n".join(meta) + "\n")
        zf.writestr(f"{dist}.dist-info/WHEEL",
                    f"Wheel-Version: 1.0\nRoot-Is-Purelib: {'true' if purelib else 'false'}\nTag: {tag}\n")
        zf.writestr(f"{dist}.dist-info/RECORD", "")
    return path


class WheelInstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zinia-pkg-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.site = os.path.join(self.tmp, "site-packages")
        packages.configure(self.site, [])
        sys.path.insert(0, self.site)
        self.addCleanup(lambda: self.site in sys.path and sys.path.remove(self.site))

    def test_install_import_uninstall(self):
        wheel = build_wheel(self.tmp, "zinia-demo-pkg", "1.2.0",
                            {"zinia_demo_pkg/__init__.py": "VALUE = 'installed'\n",
                             "zinia_demo_pkg/sub.py": "X = 1\n"})
        result = packages.install_wheel_file(wheel)
        self.assertEqual((result["name"], result["version"]), ("zinia-demo-pkg", "1.2.0"))
        importlib.invalidate_caches()
        mod = importlib.import_module("zinia_demo_pkg")
        self.assertEqual(mod.VALUE, "installed")
        listing = packages.list_installed()["packages"]
        self.assertEqual([(p["name"], p["version"], p["installer"]) for p in listing],
                         [("zinia-demo-pkg", "1.2.0", "ziniapython")])
        self.assertEqual(packages.installed_version("Zinia_Demo.Pkg"), "1.2.0")
        sys.modules.pop("zinia_demo_pkg", None)
        removed = packages.uninstall("zinia-demo-pkg")
        self.assertGreaterEqual(removed["removedFiles"], 2)
        self.assertEqual(os.listdir(self.site), [])

    def test_upgrade_replaces_old_files(self):
        old = build_wheel(self.tmp, "upg", "1.0", {"upg/__init__.py": "", "upg/old.py": ""})
        packages.install_wheel_file(old)
        new = build_wheel(self.tmp, "upg", "2.0", {"upg/__init__.py": ""})
        packages.install_wheel_file(new)
        self.assertFalse(os.path.exists(os.path.join(self.site, "upg", "old.py")))
        self.assertEqual(packages.installed_version("upg"), "2.0")

    def test_path_traversal_is_rejected(self):
        wheel = build_wheel(self.tmp, "evil", "1.0", {"evil/__init__.py": ""},
                            extra_entries=[("../outside.py", "boom")])
        with self.assertRaises(packages.PackageError) as ctx:
            packages.install_wheel_file(wheel)
        self.assertEqual(ctx.exception.code, "UNSAFE_PATH")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "outside.py")))
        self.assertFalse(any(n.startswith(".zinia-staging") for n in os.listdir(self.site)))

    def test_absolute_path_is_rejected(self):
        wheel = build_wheel(self.tmp, "evil2", "1.0", {"evil2/__init__.py": ""},
                            extra_entries=[("/etc/evil.py", "boom")])
        with self.assertRaises(packages.PackageError):
            packages.install_wheel_file(wheel)

    def test_native_code_is_rejected(self):
        wheel = build_wheel(self.tmp, "nat", "1.0", {"nat/__init__.py": "", "nat/_speed.cpython-314-iphoneos.so": "x"})
        with self.assertRaises(packages.PackageError) as ctx:
            packages.install_wheel_file(wheel)
        self.assertEqual(ctx.exception.code, packages.NATIVE_ONLY)

    def test_platform_wheel_is_rejected(self):
        wheel = build_wheel(self.tmp, "plat", "1.0", {"plat/__init__.py": ""},
                            tag="cp314-cp314-ios_13_0_arm64_iphoneos", purelib=False)
        with self.assertRaises(packages.PackageError):
            packages.install_wheel_file(wheel)

    def test_data_scripts_are_skipped(self):
        wheel = build_wheel(self.tmp, "tool", "1.0", {"tool/__init__.py": ""},
                            extra_entries=[("tool-1.0.data/scripts/tool", "#!python\n"),
                                           ("tool-1.0.data/purelib/tool_extra.py", "Y = 2\n")])
        result = packages.install_wheel_file(wheel)
        self.assertIn("tool-1.0.data/scripts/tool", result["skipped"])
        self.assertTrue(os.path.exists(os.path.join(self.site, "tool_extra.py")))

    def test_uninstall_unknown(self):
        with self.assertRaises(packages.PackageError) as ctx:
            packages.uninstall("not-installed-anything")
        self.assertEqual(ctx.exception.code, "NOT_INSTALLED")

    def test_invalid_names(self):
        for bad in ("", "../x", "a b", "x" * 200, "-lead"):
            with self.assertRaises(packages.PackageError):
                packages.validate_name(bad)


def _file(filename, url=None, sha256=None, requires_python=None, yanked=False):
    return {"filename": filename, "url": url or f"https://files.example.org/{filename}",
            "digests": {"sha256": sha256 or "0" * 64}, "requires_python": requires_python,
            "yanked": yanked, "size": 100}


class FakePyPI:
    def __init__(self):
        self.projects = {}
        self.blobs = {}
        self.requests = []

    def add(self, name, version, files, requires_dist=(), requires_python=None):
        project = self.projects.setdefault(name, {"info": {"name": name}, "releases": {}})
        project["releases"][version] = files
        project["info"].update({"version": version, "requires_python": requires_python})
        project.setdefault("versions", {})[version] = {
            "info": {"name": name, "version": version, "requires_dist": list(requires_dist),
                     "requires_python": requires_python, "summary": f"{name} summary"},
            "urls": files}

    def __call__(self, url, max_bytes):
        self.requests.append(url)
        if url in self.blobs:
            return 200, self.blobs[url]
        prefix = packages.PYPI_BASE + "/"
        if not url.startswith(prefix):
            return 404, b""
        parts = url[len(prefix):].split("/")
        project = self.projects.get(parts[0])
        if project is None:
            return 404, b""
        if len(parts) == 2:  # /name/json
            latest = project["info"]["version"]
            body = {"info": project["versions"][latest]["info"], "urls": project["releases"][latest],
                    "releases": project["releases"]}
        else:
            entry = project["versions"].get(parts[1])
            if entry is None:
                return 404, b""
            body = entry
        return 200, json.dumps(body).encode()


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zinia-resolve-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.site = os.path.join(self.tmp, "site-packages")
        packages.configure(self.site, [])
        self.pypi = FakePyPI()
        packages.Config.fetcher = self.pypi
        self.addCleanup(setattr, packages.Config, "fetcher", None)

    def publish_wheel(self, name, version, files, requires_dist=()):
        path = build_wheel(self.tmp, name, version, files, requires=requires_dist)
        with open(path, "rb") as fh:
            data = fh.read()
        url = f"https://files.example.org/{os.path.basename(path)}"
        self.pypi.blobs[url] = data
        self.pypi.add(name, version, [_file(os.path.basename(path), url, hashlib.sha256(data).hexdigest())],
                      requires_dist=requires_dist)

    def test_classification(self):
        cases = {
            packages.INSTALLABLE: [_file("a-1.0-py3-none-any.whl")],
            packages.NATIVE_IOS_WHEEL: [_file("a-1.0-cp314-cp314-ios_13_0_arm64_iphoneos.whl"),
                                        _file("a-1.0-cp314-cp314-manylinux_2_17_x86_64.whl")],
            packages.NATIVE_ONLY: [_file("a-1.0-cp314-cp314-win_amd64.whl"),
                                   _file("a-1.0-cp314-cp314-macosx_11_0_arm64.whl"), _file("a-1.0.tar.gz")],
            packages.SDIST_ONLY: [_file("a-1.0.tar.gz")],
            packages.PYTHON_MISMATCH: [_file("a-1.0-py3-none-any.whl", requires_python="<3.0")],
            packages.NO_FILES: [],
        }
        for verdict, files in cases.items():
            with self.subTest(verdict=verdict):
                self.assertEqual(packages.classify_release(files)["verdict"], verdict)
        native = packages.classify_release(cases[packages.NATIVE_ONLY])
        self.assertEqual(native["platformFamilies"], ["Windows", "macOS"])

    def test_yanked_files_are_ignored(self):
        result = packages.classify_release([_file("a-1.0-py3-none-any.whl", yanked=True), _file("a-1.0.tar.gz")])
        self.assertEqual(result["verdict"], packages.SDIST_ONLY)

    def test_install_with_dependencies(self):
        self.publish_wheel("leafpkg", "1.0", {"leafpkg/__init__.py": "LEAF = True\n"})
        self.publish_wheel("rootpkg", "2.0", {"rootpkg/__init__.py": "import leafpkg\n"},
                           requires_dist=["leafpkg>=1.0", "neverpkg; python_version < '3.0'",
                                          "extrapkg; extra == 'speed'"])
        result = packages.install("rootpkg")
        names = sorted((i["name"], i["version"], i["requested"]) for i in result["installed"])
        self.assertEqual(names, [("leafpkg", "1.0", False), ("rootpkg", "2.0", True)])
        self.assertEqual(packages.installed_version("leafpkg"), "1.0")
        self.assertFalse(any("neverpkg" in u or "extrapkg" in u for u in self.pypi.requests))

    def test_analyze_reports_dependencies(self):
        self.publish_wheel("rootpkg", "2.0", {"rootpkg/__init__.py": ""}, requires_dist=["leafpkg>=1.0"])
        info = packages.analyze("rootpkg")
        self.assertEqual(info["verdict"], packages.INSTALLABLE)
        self.assertEqual(info["dependencies"][0]["name"], "leafpkg")
        self.assertTrue(info["dependencies"][0]["applies"])

    def test_checksum_mismatch(self):
        self.publish_wheel("tampered", "1.0", {"tampered/__init__.py": ""})
        url = next(u for u in self.pypi.blobs if "tampered" in u)
        self.pypi.blobs[url] = self.pypi.blobs[url] + b"x"
        with self.assertRaises(packages.PackageError) as ctx:
            packages.install("tampered")
        self.assertEqual(ctx.exception.code, "CHECKSUM_MISMATCH")
        self.assertIsNone(packages.installed_version("tampered"))

    def test_native_package_is_reported_not_installed(self):
        self.pypi.add("fastthing", "3.0", [_file("fastthing-3.0-cp314-cp314-manylinux_2_17_x86_64.whl")])
        with self.assertRaises(packages.PackageError) as ctx:
            packages.install("fastthing")
        self.assertEqual(ctx.exception.code, packages.NATIVE_ONLY)
        self.assertEqual(os.listdir(self.site), [])

    def test_not_found(self):
        with self.assertRaises(packages.PackageError) as ctx:
            packages.analyze("nonexistentpkg")
        self.assertEqual(ctx.exception.code, packages.NOT_FOUND)

    def test_https_required(self):
        with self.assertRaises(packages.PackageError) as ctx:
            packages._fetch("http://pypi.org/pypi/x/json", 100)
        self.assertEqual(ctx.exception.code, "INSECURE_URL")


@unittest.skipUnless(os.environ.get("ZINIA_NETWORK_TESTS") == "1", "set ZINIA_NETWORK_TESTS=1 to query real PyPI")
class LivePyPITests(unittest.TestCase):
    def test_analyze_real_packages(self):
        self.assertEqual(packages.analyze("six")["verdict"], packages.INSTALLABLE)
        self.assertIn(packages.analyze("numpy")["verdict"], (packages.NATIVE_ONLY, packages.NATIVE_IOS_WHEEL))
