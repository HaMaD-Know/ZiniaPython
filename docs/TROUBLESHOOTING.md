# Troubleshooting

## GitHub Actions

| Symptom | Cause and fix |
| --- | --- |
| Workflows don't start | Actions are disabled for the repository. Open **Actions** and enable them, or check *Settings › Actions › General*. |
| `No Xcode 26.x is installed on this runner` | The `macos-26` image changed. Set `XCODE_VERSION` in `build-ios.yml` to a version listed in the runner image README (https://github.com/actions/runner-images). |
| `Python.xcframework is missing` in *Process Python libraries* | The *Fetch pinned CPython iOS framework* step didn't run or failed. Look at its log. |
| `SHA-256 mismatch` | The download was corrupted or the release asset changed. Re-run. If it keeps failing, check the asset on the BeeWare releases page; never just change the checksum without checking. |
| `Building several architectures at once` | Pass `ARCHS=arm64`. The build helper copies one `lib-<arch>` folder. |
| `codesign … errSecInternalComponent` in a signed build | The keychain wasn't unlocked. Check that `import-signing.sh` ran in the same job. |
| `No profile for team … matching …` | The profile doesn't match the bundle identifier or certificate. Check `IOS_BUNDLE_ID`, and that the profile includes the certificate in `IOS_CERTIFICATE_P12_BASE64`. |
| Swift package resolution fails | Temporary GitHub or network problem. Re-run the job. |
| Simulator self-test: report not found | The app crashed before printing. Download **ZiniaPython-build-logs** and read `selftest/selftest-console.log`. Crashes during start-up usually mean the bundle is incomplete; see `verify-app-bundle.sh` output above it. |
| Self-test case fails | The JSON report (`selftest/simulator-selftest.json`) lists the failing case with its output and error type. |
| `check:ios` fails after `npx cap sync` | A Capacitor update changed the project template. The failing check names what is missing; re-apply that part (see BUILDING-IOS.md, "What the Xcode project contains"). |

## Installing on a device

| Symptom | Fix |
| --- | --- |
| "Unable to install" with the unsigned IPA | Expected. Sign it first ([SIGNING.md](SIGNING.md), Path A or B). |
| App opens and closes immediately after re-signing | The re-signing tool didn't sign nested frameworks. Update the tool. |
| "Untrusted Developer" | *Settings › General › VPN & Device Management*, then trust your Apple ID or team. |
| App stops opening after a week | Free Apple ID signatures expire after 7 days. Re-sign and reinstall; files are kept if the bundle identifier stays the same. |
| Developer Mode option is missing | It appears after the first attempt to run a development-signed app (iOS 16+). |

## Runtime does not start

The console shows a diagnostic panel with a code (see the README table). Steps:

1. **Settings › Python runtime** shows the state. If it's *failed*, note the code and message.
2. `STDLIB_MISSING`, `SUPPORT_MISSING` or `FRAMEWORK_MISSING` mean the app was built without the runtime parts. Rebuild through CI and check the *Verify device app bundle* step.
3. `BRIDGE_IMPORT_FAILED` shows a Python traceback from `python/zinia`. That's a bug in the runtime package; run `npm run test:python` on your PC.
4. After any start-up failure, **force-quit the app** before trying again. CPython can't be initialised twice in one process.

## Running code

| Symptom | Explanation |
| --- | --- |
| Run is greyed out | Python is still starting, a script is running, or the runtime failed (see above). In the web preview Run is always disabled. |
| `BUSY` | Another run, REPL entry or package operation is active. Stop it or wait. |
| Stop shows *Stopping…* for a long time | The script is inside a long C operation or ignores `KeyboardInterrupt`. Wait, or force-quit the app. |
| `ModuleNotFoundError` for your own module | Is the file in the same project folder? Projects run with the project folder and the script's folder on `sys.path`. |
| Changes to a helper module aren't picked up | They are, on the next run, if the file was saved. *Save before running* is on by default. |
| `PermissionError` writing a file | Paths are relative to the working directory (*Settings › Running*). The app bundle itself is read-only; write into the project folder. |
| "Output limit reached" | Each run sends at most 2,000,000 characters to the console. The script continues. Write large output to a file instead. |
| Script stopped with "close to the iOS memory limit" | The memory guard stopped it so iOS wouldn't close the app. Process data in smaller pieces. |
| `input()` raises `EOFError` | You pressed **EOF**, or the input came from the REPL (input isn't interactive there). |

## Files

| Symptom | Fix |
| --- | --- |
| "The folder is no longer available" | The opened folder moved, was deleted, or its provider signed out. Use **Open a folder from Files…** again. |
| `NOT_DOWNLOADED` | iCloud is downloading the file. Try again in a moment. |
| "Changed elsewhere" banner | Another app changed the file while you had unsaved edits. Choose **Use the file on disk** or **Keep my version**. |
| Workspace isn't visible in the Files app | Open Files › *Browse* › *On My iPhone* › *ZiniaPython*. It appears after the app has run once. |

## Development on Windows

| Symptom | Fix |
| --- | --- |
| `npm run dev:bridge` shows "Python worker exited" | Python isn't on PATH. Set `ZINIA_PYTHON` to the full path of `python.exe`. |
| First import of a large desktop package is slow in the dev bridge | That's normal on Windows (disk scanning). It only affects the development bridge. |
| `fetch-python-runtime.ps1` fails in `tar` | Make sure `C:\Windows\System32\tar.exe` exists (Windows 10 1803 or later). |
| Shell scripts fail on CI with `$'\r'` errors | They were committed with CRLF line endings. `.gitattributes` prevents this; if it happened anyway, run `git add --renormalize .` and commit. |
