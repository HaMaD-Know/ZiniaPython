# Packages

Installing a package on iOS is not the same as running `pip install` on a desktop:

- iOS apps can't start other programs, so there's no `pip` process, no `python -m venv`, and no build from source (no compilers, no build subprocesses).
- iOS only loads machine code that was **signed into the app when it was built**. A downloaded `.so` file can't be loaded.

So ZiniaPython handles packages in three stages.

## Stage A – Compatibility check

**Packages › Check** asks PyPI's JSON API about the package (or a specific version) and classifies the release files:

| Verdict | Meaning |
| --- | --- |
| **Can be installed** | A `py3-none-any`-style wheel exists whose `Requires-Python` matches the bundled Python 3.14. |
| **Needs a build-time install** | The package contains compiled code and an **iOS** wheel exists (`…-ios_13_0_arm64_iphoneos.whl`). It can be bundled at build time (Stage C). |
| **Not installable on iOS** (`native-only`) | Compiled wheels exist only for other platforms. The card lists which (Linux, macOS, Windows…). The package would need to be cross-compiled for iOS. |
| **Not installable on iOS** (`sdist-only`) | Only a source archive is published, and building from source isn't possible on iOS. |
| **Python version mismatch** | The only pure wheel requires a different Python. |

The card also shows `Requires-Python`, the dependencies that apply to iOS (environment markers are evaluated with the vendored `packaging` library), the license, and the installed version.

## Stage B – Pure-Python packages on the device

**Install** runs `python/zinia/packages.py` inside the embedded interpreter:

1. **Resolve.** Starting from the requested package, it picks the newest release (or the requested version) that has a compatible pure wheel, then does the same for each `Requires-Dist` that applies (markers evaluated, extras honoured). Already installed, compatible packages are kept. This is a greedy resolver: conflicts are reported, not backtracked. At most 60 packages per install.
2. **Download** each wheel over HTTPS through `URLSession` (the iOS system trust store) and **verify its SHA-256** against PyPI's metadata.
3. **Unpack** into the app-private `Library/Application Support/ZiniaPython/site-packages`:
   - wheels with compiled code (`.so`, `.dylib`, `.pyd`, frameworks) or `Root-Is-Purelib: false` are rejected;
   - absolute paths, `..` segments and anything resolving outside site-packages are rejected (`UNSAFE_PATH`);
   - files go to a staging folder first, so a failed install leaves nothing behind;
   - `.data/purelib` and `.data/platlib` are honoured; `scripts`, `headers` and `data` are skipped (no console scripts on iOS);
   - `INSTALLER` (`ziniapython`), `REQUESTED` and a new `RECORD` are written.
4. A previous version is removed first, and cached modules are dropped, so the next run imports the new code.

**Uninstall** removes exactly the files listed in the package's `RECORD`, never anything outside site-packages, and then empty folders.

Installed packages survive app restarts. They are excluded from iCloud backup because they can be downloaded again. `site.addsitedir()` processes `.pth` files at start-up.

**Network:** checking and installing contact `pypi.org` and `files.pythonhosted.org`. Nothing else in ZiniaPython uses the network.

Checked against live PyPI during development: `six` was installed and uninstalled end to end; `rich` and `requests` were reported installable; `numpy` and `PyYAML` were reported *not installable on iOS*, because their releases contain compiled code only. Results depend on what each project publishes, so the app always checks first.

## Stage C – Native packages

Packages with compiled code (numpy, pandas, Pillow, cryptography, lxml…) must be **compiled for iOS** and **bundled when the app is built**. Then the *Process Python libraries* build phase turns each `.so` into a signed framework.

1. Get iOS wheels for the package, built for CPython 3.14 and both `iphoneos` (arm64) and `iphonesimulator`. Options:
   - wheels published on PyPI with `ios_*` tags (the Stage A check reports *Needs a build-time install*);
   - BeeWare's prebuilt iOS wheels (see the BeeWare and Briefcase documentation for the current package index);
   - building them yourself with BeeWare's `mobile-forge` or with `cibuildwheel` (iOS support was added in version 3.0).
2. Install them into per-platform folders. On a Mac (replace the index URL with the one your wheel source documents):

   ```bash
   python3.14 -m pip install --target python-runtime/app_packages/iphoneos \
     --platform ios_13_0_arm64_iphoneos --only-binary=:all: --python-version 3.14 \
     --extra-index-url https://pypi.anaconda.org/beeware/simple numpy

   python3.14 -m pip install --target python-runtime/app_packages/iphonesimulator \
     --platform ios_13_0_arm64_iphonesimulator --only-binary=:all: --python-version 3.14 \
     --extra-index-url https://pypi.anaconda.org/beeware/simple numpy
   ```

3. Commit those folders (or add the `pip install` lines to the workflow before the build).
4. Build. `install-zinia-runtime.sh` copies the folder matching the platform into `App.app/app_packages`, and `process-python.sh` converts and signs its `.so` files. The packages appear in **Packages** as *built in* and can't be uninstalled from the app.

If a wheel ships a privacy manifest (`<module>.xcprivacy`), the build helper installs it, as App Store rules require.

ZiniaPython doesn't promise that any particular native package works on iOS. Check the package's own iOS support.

## Troubleshooting

| Message | Meaning |
| --- | --- |
| `CHECKSUM_MISMATCH` | The download didn't match PyPI's SHA-256. Nothing was installed. Try again later. |
| `NETWORK` | No connection, or PyPI couldn't be reached. |
| `CONFLICT` | Two packages need incompatible versions of a dependency. Install a compatible version explicitly. |
| `UNSAFE_PATH` | The wheel tried to write outside site-packages and was rejected. |
| `native-only` / `sdist-only` | See Stage C. |
