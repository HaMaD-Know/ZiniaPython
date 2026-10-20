"""Controlled installer for pure-Python packages.

Why not pip? On iOS there is no separate ``python`` executable and apps may not
start subprocesses, so pip's normal mode of operation (and any build from
source) is unavailable. iOS also refuses to load native code that was not
signed into the app when it was built, so packages with compiled extensions
can never be installed at run time.

What this module does instead:

1. ``analyze``   - reads PyPI's JSON API and classifies a release:
                   pure-Python wheel / iOS binary wheel / other native wheels /
                   source distribution only / Python-version mismatch.
2. ``install``   - resolves dependencies (greedy, newest compatible version),
                   downloads ``py3-none-any`` style wheels only, verifies their
                   SHA-256 against PyPI, and unpacks them into the app-private
                   site-packages directory with path-traversal checks.
3. ``uninstall`` - removes exactly the files listed in the wheel's RECORD,
                   refusing anything outside site-packages.

Network access happens only when the user asks for one of these operations.
Inside the app, downloads go through ``URLSession`` via ``native.http_get``.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import importlib
import importlib.metadata
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

from . import native
from ._vendor.packaging.markers import default_environment
from ._vendor.packaging.requirements import InvalidRequirement, Requirement
from ._vendor.packaging.specifiers import InvalidSpecifier, SpecifierSet
from ._vendor.packaging.tags import Tag, sys_tags
from ._vendor.packaging.utils import (InvalidWheelFilename, canonicalize_name,
                                      parse_wheel_filename)
from ._vendor.packaging.version import InvalidVersion, Version

PYPI_BASE = "https://pypi.org/pypi"
MAX_METADATA_BYTES = 25 * 1024 * 1024
MAX_WHEEL_BYTES = 60 * 1024 * 1024
MAX_UNPACKED_BYTES = 400 * 1024 * 1024
MAX_DEPENDENCIES = 60
INSTALLER_NAME = "ziniapython"
_NAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$")
_NATIVE_SUFFIXES = (".so", ".dylib", ".pyd", ".dll", ".a", ".framework", ".fwork")

# Verdicts reported to the IDE.
INSTALLABLE = "installable"
NATIVE_IOS_WHEEL = "native-ios-wheel"
NATIVE_ONLY = "native-only"
SDIST_ONLY = "sdist-only"
PYTHON_MISMATCH = "python-mismatch"
NO_FILES = "no-files"
NOT_FOUND = "not-found"


class PackageError(Exception):
    def __init__(self, code: str, message: str, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, **self.details}


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------

class Config:
    site_dir: str | None = None
    bundled_dirs: tuple[str, ...] = ()
    fetcher = None  # test hook: callable(url, max_bytes) -> (status, bytes)


def configure(site_dir: str, bundled_dirs=()) -> None:
    os.makedirs(site_dir, exist_ok=True)
    Config.site_dir = os.path.abspath(site_dir)
    Config.bundled_dirs = tuple(os.path.abspath(d) for d in bundled_dirs if d)


def _site_dir() -> str:
    if not Config.site_dir:
        raise PackageError("NOT_CONFIGURED", "The package directory has not been configured.")
    return Config.site_dir


def _progress(operation: str, package: str, stage: str, message: str, **extra) -> None:
    payload = {"operation": operation, "package": package, "stage": stage, "message": message,
               "time": time.time(), **extra}
    native.emit_event("packageProgress", json.dumps(payload))


def validate_name(name: str) -> str:
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise PackageError("INVALID_NAME", f"'{name}' is not a valid Python package name.")
    return name


# --------------------------------------------------------------------------
# networking
# --------------------------------------------------------------------------

def _fetch(url: str, max_bytes: int) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise PackageError("INSECURE_URL", f"Refusing to download over a non-HTTPS URL: {url}")
    if Config.fetcher is not None:
        status, body = Config.fetcher(url, max_bytes)
    else:
        reply = native.http_get(url, 60.0, max_bytes)
        if reply is not None:
            status, body = reply
        else:
            status, body = _urllib_fetch(url, max_bytes)
    if status == 404:
        raise PackageError(NOT_FOUND, f"Not found on PyPI: {url}")
    if status != 200:
        raise PackageError("HTTP_ERROR", f"PyPI returned HTTP {status} for {url}", status=status)
    if len(body) > max_bytes:
        raise PackageError("TOO_LARGE", f"Download exceeds the {max_bytes // (1024 * 1024)} MB limit: {url}")
    return body


def _urllib_fetch(url: str, max_bytes: int):
    request = urllib.request.Request(url, headers={"User-Agent": "ZiniaPython-IDE (+package installer)",
                                                   "Accept": "application/json, */*"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - https enforced above
            body = response.read(max_bytes + 1)
            return response.status, body
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except (urllib.error.URLError, OSError) as exc:
        raise PackageError("NETWORK", f"Network error while contacting PyPI: {exc}") from exc


def fetch_project(name: str, version: str | None = None) -> dict:
    quoted = urllib.parse.quote(name)
    url = f"{PYPI_BASE}/{quoted}/json" if version is None else f"{PYPI_BASE}/{quoted}/{urllib.parse.quote(version)}/json"
    try:
        body = _fetch(url, MAX_METADATA_BYTES)
    except PackageError as exc:
        if exc.code == NOT_FOUND:
            what = name if version is None else f"{name} {version}"
            raise PackageError(NOT_FOUND, f"'{what}' was not found on PyPI.") from None
        raise
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackageError("BAD_METADATA", f"PyPI returned unreadable metadata for {name}.") from exc


# --------------------------------------------------------------------------
# compatibility analysis
# --------------------------------------------------------------------------

def _python_version() -> Version:
    return Version(".".join(str(p) for p in sys.version_info[:3]))


def pure_tags() -> set[Tag]:
    """Tags of wheels this interpreter can use without native code."""
    tags = {t for t in sys_tags() if t.platform == "any" and t.abi == "none"}
    major = sys.version_info[0]
    tags.add(Tag(f"py{major}", "none", "any"))
    return tags


def _classify_file(file_info: dict, pure: set[Tag]) -> dict:
    filename = file_info.get("filename", "")
    entry = {
        "filename": filename,
        "url": file_info.get("url"),
        "size": file_info.get("size"),
        "sha256": (file_info.get("digests") or {}).get("sha256"),
        "yanked": bool(file_info.get("yanked")),
        "requiresPython": file_info.get("requires_python"),
        "kind": "other",
    }
    if filename.endswith(".whl"):
        try:
            _, _, _, tags = parse_wheel_filename(filename)
        except InvalidWheelFilename:
            entry["kind"] = "invalid-wheel"
            return entry
        platforms = sorted({t.platform for t in tags})
        entry["platforms"] = platforms
        if any(t in pure for t in tags):
            entry["kind"] = "pure-wheel"
        elif all(t.platform == "any" for t in tags):
            entry["kind"] = "other-python-wheel"  # for example py2-only
        elif any(t.platform.startswith("ios_") for t in tags):
            entry["kind"] = "ios-wheel"
        else:
            entry["kind"] = "native-wheel"
    elif filename.endswith((".tar.gz", ".zip", ".tar.bz2")):
        entry["kind"] = "sdist"
    return entry


def _requires_python_ok(spec: str | None) -> bool:
    if not spec:
        return True
    try:
        return SpecifierSet(spec).contains(_python_version(), prereleases=True)
    except InvalidSpecifier:
        return True  # unreadable metadata: let the install attempt decide


def _platform_family(platform: str) -> str:
    for prefix, label in (("manylinux", "Linux"), ("musllinux", "Linux (musl)"), ("linux", "Linux"),
                          ("macosx", "macOS"), ("win", "Windows"), ("ios", "iOS"), ("android", "Android")):
        if platform.startswith(prefix):
            return label
    return platform


def classify_release(files: list[dict]) -> dict:
    pure = pure_tags()
    classified = [_classify_file(f, pure) for f in files]
    live = [f for f in classified if not f["yanked"]]
    kinds = {f["kind"] for f in live}
    families = sorted({_platform_family(p) for f in live if f["kind"] in ("native-wheel", "ios-wheel")
                       for p in f.get("platforms", [])})
    pure_files = [f for f in live if f["kind"] == "pure-wheel"]
    compatible_pure = [f for f in pure_files if _requires_python_ok(f.get("requiresPython"))]

    if compatible_pure:
        verdict, reason = INSTALLABLE, "A pure-Python wheel is available and can be installed on this device."
    elif pure_files:
        verdict, reason = PYTHON_MISMATCH, (
            f"The pure-Python wheel requires a different Python version than the bundled Python "
            f"{sys.version_info[0]}.{sys.version_info[1]}.")
    elif "ios-wheel" in kinds:
        verdict, reason = NATIVE_IOS_WHEEL, (
            "This release contains compiled code. An iOS build exists on PyPI, but iOS only loads native "
            "code that is signed into the app, so it must be added when the app is built "
            "(see docs/PACKAGES.md, 'Native packages').")
    elif "native-wheel" in kinds:
        verdict, reason = NATIVE_ONLY, (
            "This release contains compiled code for " + ", ".join(families or ["other platforms"]) +
            " only. It would have to be cross-compiled for iOS and bundled when the app is built.")
    elif "sdist" in kinds:
        verdict, reason = SDIST_ONLY, (
            "Only a source distribution is published. Building packages from source is not possible on "
            "iOS (no compilers or build subprocesses), so it cannot be installed on the device.")
    else:
        verdict, reason = NO_FILES, "No installable files were found for this release."
    return {"verdict": verdict, "reason": reason, "files": classified, "platformFamilies": families,
            "wheel": compatible_pure[0] if compatible_pure else None}


def _evaluate_dependencies(requires_dist, extras=()) -> list[dict]:
    deps = []
    env = default_environment()
    for raw in requires_dist or []:
        try:
            req = Requirement(raw)
        except InvalidRequirement:
            deps.append({"requirement": raw, "applies": False, "invalid": True})
            continue
        applies = True
        if req.marker is not None:
            candidates = [""] + list(extras)
            applies = any(req.marker.evaluate({**env, "extra": e}) for e in candidates)
        deps.append({"requirement": str(req), "name": req.name, "applies": applies})
    return deps


def analyze(name: str, version: str | None = None) -> dict:
    name = validate_name(name)
    data = fetch_project(name, version)
    info = data.get("info") or {}
    files = data.get("urls") or []
    analysis = classify_release(files)
    installed = installed_version(name)
    return {
        "name": info.get("name") or name,
        "version": info.get("version") or version,
        "summary": info.get("summary") or "",
        "homePage": info.get("home_page") or (info.get("project_urls") or {}).get("Homepage") or "",
        "license": info.get("license_expression") or info.get("license") or "",
        "requiresPython": info.get("requires_python") or "",
        "pythonCompatible": _requires_python_ok(info.get("requires_python")),
        "dependencies": _evaluate_dependencies(info.get("requires_dist")),
        "installedVersion": installed,
        **{k: v for k, v in analysis.items() if k != "wheel"},
        "selectedWheel": analysis["wheel"]["filename"] if analysis["wheel"] else None,
    }


# --------------------------------------------------------------------------
# resolution
# --------------------------------------------------------------------------

def _candidate_versions(project: dict, req: Requirement, explicit: bool) -> list[Version]:
    releases = project.get("releases")
    versions = []
    if isinstance(releases, dict) and releases:
        raw_versions = list(releases.keys())
    else:
        raw_versions = [(project.get("info") or {}).get("version")]
    for raw in raw_versions:
        if not raw:
            continue
        try:
            v = Version(raw)
        except InvalidVersion:
            continue
        allow_pre = explicit or bool(req.specifier.prereleases)
        if v.is_prerelease and not allow_pre:
            continue
        if req.specifier and not req.specifier.contains(v, prereleases=True):
            continue
        versions.append(v)
    versions.sort(reverse=True)
    return versions


def _choose_release(name: str, req: Requirement, explicit: bool):
    project = fetch_project(name)
    canonical_versions = _candidate_versions(project, req, explicit)
    if not canonical_versions:
        raise PackageError("NO_MATCHING_VERSION", f"No release of {name} matches '{req.specifier or 'any'}'.")
    releases = project.get("releases") or {}
    last_analysis = None
    for version in canonical_versions[:40]:
        raw_key = next((k for k in releases if _same_version(k, version)), None)
        files = releases.get(raw_key) if raw_key else None
        if files is None:
            files = fetch_project(name, str(version)).get("urls") or []
        analysis = classify_release(files)
        last_analysis = analysis
        if analysis["wheel"] is not None:
            detail = fetch_project(name, str(version))
            return version, analysis["wheel"], (detail.get("info") or {}).get("requires_dist") or []
        if canonical_versions.index(version) == 0 and analysis["verdict"] != PYTHON_MISMATCH:
            # The newest matching release is not installable for a structural
            # reason (native code, sdist only): older releases almost always
            # share it, so report it instead of walking the whole history.
            raise PackageError(analysis["verdict"], f"{name} {version}: {analysis['reason']}",
                               verdict=analysis["verdict"], package=name, version=str(version))
    verdict = last_analysis["verdict"] if last_analysis else NO_FILES
    raise PackageError(verdict, f"No installable pure-Python release of {name} was found "
                       f"for Python {sys.version_info[0]}.{sys.version_info[1]}.", verdict=verdict, package=name)


def _same_version(raw: str, version: Version) -> bool:
    try:
        return Version(raw) == version
    except InvalidVersion:
        return False


def resolve(name: str, version: str | None = None) -> list[dict]:
    """Return the install plan: a list of {name, version, wheel, requested}."""
    name = validate_name(name)
    if version:
        try:
            Version(version)
        except InvalidVersion as exc:
            raise PackageError("INVALID_VERSION", f"'{version}' is not a valid version.") from exc
        root = Requirement(f"{name}=={version}")
    else:
        root = Requirement(name)
    env = default_environment()
    plan: dict[str, dict] = {}
    queue: list[tuple[Requirement, tuple[str, ...], bool, str | None]] = [(root, (), True, None)]
    while queue:
        req, extras, requested, parent = queue.pop(0)
        key = canonicalize_name(req.name)
        if key in plan:
            chosen = Version(plan[key]["version"])
            if req.specifier and not req.specifier.contains(chosen, prereleases=True):
                raise PackageError("CONFLICT", f"Dependency conflict: {parent or 'request'} needs {req}, "
                                   f"but {plan[key]['name']} {chosen} was selected.")
            continue
        if not requested:
            existing = installed_version(req.name, include_bundled=True)
            if existing is not None:
                try:
                    if not req.specifier or req.specifier.contains(Version(existing), prereleases=True):
                        continue
                except InvalidVersion:
                    continue
        if len(plan) >= MAX_DEPENDENCIES:
            raise PackageError("TOO_MANY_DEPENDENCIES",
                               f"More than {MAX_DEPENDENCIES} packages would be installed; aborting.")
        _progress("install", req.name, "resolve", f"Resolving {req}")
        chosen_version, wheel, requires_dist = _choose_release(req.name, req, explicit=requested and bool(version))
        plan[key] = {"name": req.name, "version": str(chosen_version), "wheel": wheel,
                     "requested": requested, "requiredBy": parent}
        for raw in requires_dist:
            try:
                dep = Requirement(raw)
            except InvalidRequirement:
                continue
            if dep.marker is not None:
                candidates = [""] + list(req.extras)
                if not any(dep.marker.evaluate({**env, "extra": e}) for e in candidates):
                    continue
            queue.append((dep, tuple(dep.extras), False, f"{req.name} {chosen_version}"))
    return list(plan.values())


# --------------------------------------------------------------------------
# installation
# --------------------------------------------------------------------------

def _safe_join(base: str, relative: str) -> str:
    """Join ``relative`` to ``base`` and refuse anything that escapes it."""
    if not relative or "\x00" in relative:
        raise PackageError("UNSAFE_PATH", f"Invalid path in archive: {relative!r}")
    if relative.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", relative):
        raise PackageError("UNSAFE_PATH", f"Absolute path in archive: {relative!r}")
    parts = re.split(r"[\\/]+", relative)
    if any(p in ("..",) for p in parts):
        raise PackageError("UNSAFE_PATH", f"Path traversal in archive: {relative!r}")
    target = os.path.realpath(os.path.join(base, *[p for p in parts if p not in ("", ".")]))
    base_real = os.path.realpath(base)
    if os.path.commonpath([target, base_real]) != base_real:
        raise PackageError("UNSAFE_PATH", f"Archive path escapes the package directory: {relative!r}")
    return target


def _record_hash(data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def install_wheel_file(wheel_path: str, *, requested: bool = True, site_dir: str | None = None) -> dict:
    """Unpack a pure-Python wheel into ``site_dir`` (default: configured dir)."""
    site = site_dir or _site_dir()
    filename = os.path.basename(wheel_path)
    try:
        dist_name, version, _, tags = parse_wheel_filename(filename)
    except InvalidWheelFilename as exc:
        raise PackageError("INVALID_WHEEL", f"Not a valid wheel file name: {filename}") from exc
    if not any(t.platform == "any" for t in tags):
        raise PackageError(NATIVE_ONLY, f"{filename} is a platform-specific wheel; only pure-Python "
                           "wheels can be installed on iOS.")
    try:
        archive = zipfile.ZipFile(wheel_path)
    except zipfile.BadZipFile as exc:
        raise PackageError("INVALID_WHEEL", f"{filename} is not a valid zip archive.") from exc

    with archive:
        entries = [i for i in archive.infolist() if not i.is_dir()]
        total = sum(i.file_size for i in entries)
        if total > MAX_UNPACKED_BYTES:
            raise PackageError("TOO_LARGE", f"{filename} unpacks to more than "
                               f"{MAX_UNPACKED_BYTES // (1024 * 1024)} MB.")
        dist_info = next((n.split("/")[0] for n in archive.namelist()
                          if n.endswith(".dist-info/WHEEL") and n.count("/") == 1), None)
        if dist_info is None:
            raise PackageError("INVALID_WHEEL", f"{filename} has no .dist-info/WHEEL file.")
        wheel_meta = archive.read(f"{dist_info}/WHEEL").decode("utf-8", "replace")
        if re.search(r"^Root-Is-Purelib:\s*false", wheel_meta, re.IGNORECASE | re.MULTILINE):
            raise PackageError(NATIVE_ONLY, f"{filename} declares itself as platform-specific "
                               "(Root-Is-Purelib: false).")
        for info in entries:
            lowered = info.filename.lower()
            if lowered.endswith(_NATIVE_SUFFIXES) or ".framework/" in lowered:
                raise PackageError(NATIVE_ONLY, f"{filename} contains compiled code ({info.filename}); "
                                   "iOS cannot load native code installed at run time.")
        data_prefix = f"{dist_info[:-len('.dist-info')]}.data/"

        # Remove a previous version first so stale modules do not linger.
        previous = _find_distribution(str(dist_name), site)
        if previous is not None:
            _remove_distribution(previous, site)

        staging = os.path.join(site, f".zinia-staging-{uuid.uuid4().hex}")
        os.makedirs(staging)
        written: list[tuple[str, str, int]] = []
        skipped: list[str] = []
        try:
            for info in entries:
                name = info.filename
                relative = name
                if name.startswith(data_prefix):
                    rest = name[len(data_prefix):]
                    scheme, _, inner = rest.partition("/")
                    if scheme in ("purelib", "platlib") and inner:
                        relative = inner
                    else:
                        skipped.append(name)  # scripts/headers/data have no place in an iOS app
                        continue
                if relative.endswith(".dist-info/RECORD") and relative.startswith(dist_info + "/"):
                    continue  # rewritten below
                target = _safe_join(staging, relative)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                data = archive.read(info)
                with open(target, "wb") as fh:
                    fh.write(data)
                written.append((relative.replace("\\", "/"), _record_hash(data), len(data)))

            meta_dir = _safe_join(staging, dist_info)
            os.makedirs(meta_dir, exist_ok=True)
            extra_files = {"INSTALLER": f"{INSTALLER_NAME}\n"}
            if requested:
                extra_files["REQUESTED"] = ""
            for fname, content in extra_files.items():
                data = content.encode("utf-8")
                with open(os.path.join(meta_dir, fname), "wb") as fh:
                    fh.write(data)
                written.append((f"{dist_info}/{fname}", _record_hash(data), len(data)))
            record_buffer = io.StringIO()
            writer = csv.writer(record_buffer, lineterminator="\n")
            for path, digest, size in written:
                writer.writerow([path, digest, size])
            writer.writerow([f"{dist_info}/RECORD", "", ""])
            with open(os.path.join(meta_dir, "RECORD"), "w", encoding="utf-8", newline="") as fh:
                fh.write(record_buffer.getvalue())

            # Move the staged tree into place.
            for root, _dirs, files in os.walk(staging):
                for fname in files:
                    source = os.path.join(root, fname)
                    relative = os.path.relpath(source, staging)
                    target = _safe_join(site, relative)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    os.replace(source, target)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    importlib.invalidate_caches()
    _forget_modules(site)
    return {"name": str(dist_name), "version": str(version), "files": len(written), "skipped": skipped}


def _forget_modules(site: str) -> None:
    prefix = os.path.normcase(os.path.realpath(site)) + os.sep
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None)
        if isinstance(file, str) and os.path.normcase(os.path.realpath(file)).startswith(prefix):
            sys.modules.pop(name, None)


def install(name: str, version: str | None = None) -> dict:
    site = _site_dir()
    _progress("install", name, "start", f"Preparing to install {name}")
    plan = resolve(name, version)
    installed = []
    with tempfile.TemporaryDirectory(prefix="zinia-wheels-") as tmp:
        for step in plan:
            wheel = step["wheel"]
            url = wheel["url"]
            expected = wheel.get("sha256")
            _progress("install", step["name"], "download", f"Downloading {wheel['filename']}",
                      size=wheel.get("size"))
            body = _fetch(url, MAX_WHEEL_BYTES)
            if expected:
                actual = hashlib.sha256(body).hexdigest()
                if actual != expected:
                    raise PackageError("CHECKSUM_MISMATCH", f"SHA-256 mismatch for {wheel['filename']}: "
                                       f"expected {expected}, got {actual}.")
            safe_filename = os.path.basename(wheel["filename"])
            path = os.path.join(tmp, safe_filename)
            with open(path, "wb") as fh:
                fh.write(body)
            _progress("install", step["name"], "unpack", f"Installing {step['name']} {step['version']}")
            result = install_wheel_file(path, requested=step["requested"], site_dir=site)
            installed.append({**result, "requiredBy": step["requiredBy"], "requested": step["requested"]})
    _progress("install", name, "done", f"Installed {', '.join(i['name'] + ' ' + i['version'] for i in installed)}")
    return {"installed": installed}


# --------------------------------------------------------------------------
# inventory and removal
# --------------------------------------------------------------------------

def _find_distribution(name: str, path: str):
    key = canonicalize_name(name)
    for dist in importlib.metadata.distributions(path=[path]):
        dist_name = dist.metadata["Name"] if dist.metadata else None
        if dist_name and canonicalize_name(dist_name) == key:
            return dist
    return None


def _remove_distribution(dist, site: str) -> list[str]:
    removed = []
    site_real = os.path.realpath(site)
    files = list(dist.files or [])
    dirs = set()
    for entry in files:
        relative = str(entry)
        try:
            target = _safe_join(site_real, relative)
        except PackageError:
            continue  # never delete outside site-packages
        if os.path.isfile(target) or os.path.islink(target):
            os.remove(target)
            removed.append(relative)
        parent = os.path.dirname(target)
        while parent and os.path.realpath(parent) != site_real and parent.startswith(site_real):
            dirs.add(parent)
            parent = os.path.dirname(parent)
    for directory in sorted(dirs, key=len, reverse=True):
        cache = os.path.join(directory, "__pycache__")
        if os.path.isdir(cache):
            shutil.rmtree(cache, ignore_errors=True)
        try:
            os.rmdir(directory)
        except OSError:
            pass  # not empty: shared with another distribution
    meta = getattr(dist, "_path", None)
    if meta is None:
        meta_dirs = {str(f).split("/")[0] for f in files if str(f).split("/")[0].endswith(".dist-info")}
        meta = os.path.join(site_real, meta_dirs.pop()) if len(meta_dirs) == 1 else None
    if meta is not None and os.path.isdir(str(meta)):
        meta_real = os.path.realpath(str(meta))
        if os.path.dirname(meta_real) == site_real:
            shutil.rmtree(meta_real, ignore_errors=True)
    return removed


def uninstall(name: str) -> dict:
    name = validate_name(name)
    site = _site_dir()
    dist = _find_distribution(name, site)
    if dist is None:
        for bundled in Config.bundled_dirs:
            if os.path.isdir(bundled) and _find_distribution(name, bundled) is not None:
                raise PackageError("BUNDLED_PACKAGE", f"{name} is bundled with the app and cannot be removed.")
        raise PackageError("NOT_INSTALLED", f"{name} is not installed.")
    version = dist.version
    removed = _remove_distribution(dist, site)
    importlib.invalidate_caches()
    _forget_modules(site)
    _progress("uninstall", name, "done", f"Removed {name} {version}")
    return {"name": name, "version": version, "removedFiles": len(removed)}


def installed_version(name: str, include_bundled: bool = False):
    dirs = [Config.site_dir] if Config.site_dir else []
    if include_bundled:
        dirs += list(Config.bundled_dirs)
    for directory in dirs:
        if directory and os.path.isdir(directory):
            dist = _find_distribution(name, directory)
            if dist is not None:
                return dist.version
    return None


def list_installed() -> dict:
    result = []
    sources = []
    if Config.site_dir:
        sources.append(("user", Config.site_dir))
    sources += [("bundled", d) for d in Config.bundled_dirs]
    for source, directory in sources:
        if not os.path.isdir(directory):
            continue
        for dist in importlib.metadata.distributions(path=[directory]):
            meta = dist.metadata
            if not meta or not meta["Name"]:
                continue
            installer = (dist.read_text("INSTALLER") or "").strip()
            result.append({
                "name": meta["Name"],
                "version": dist.version,
                "summary": meta["Summary"] or "",
                "source": source,
                "installer": installer,
                "requested": dist.read_text("REQUESTED") is not None,
                "requires": list(dist.requires or []),
            })
    result.sort(key=lambda d: (d["source"], canonicalize_name(d["name"])))
    return {"packages": result, "siteDir": Config.site_dir, "bundledDirs": list(Config.bundled_dirs)}
