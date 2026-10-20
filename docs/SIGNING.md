# Signing and installing

iOS installs only apps that are **signed** with a certificate Apple trusts, using a provisioning profile that allows the device. The two kinds of CI output are therefore different things:

| Output | Installable? |
| --- | --- |
| `ZiniaPython-unsigned.ipa` | **No**, not as it is. It proves the app compiles and contains the runtime. It must be signed first (Path A). |
| `ZiniaPython-signed.ipa` | Yes, on the devices the provisioning profile allows (Path B). |

Neither output installs "on any iPhone".

---

## Path A – no paid account, Windows PC

Use this if you have only a free Apple ID.

1. Run **Build iOS** and download the `ZiniaPython-unsigned-ipa` artifact. Unzip it to get `ZiniaPython-unsigned.ipa`.
2. Sign and install it with a **re-signing tool that runs on Windows**, for example **Sideloadly** (https://sideloadly.io) or **AltStore** (https://altstore.io). Both are third-party tools, not made by Apple or by this project. Read their own instructions. Typically:
   - install iTunes and iCloud for Windows from Apple's website (the non-Microsoft-Store versions, if the tool asks for them);
   - connect the iPhone or iPad with a cable and tap **Trust** on the device;
   - choose the IPA, sign in with your Apple ID in the tool, and start the installation.
3. On iOS 16 or newer, turn on **Settings › Privacy & Security › Developer Mode** and restart the device when asked.
4. Trust the developer profile at **Settings › General › VPN & Device Management**.

Things to know:

- Apps signed with a **free** Apple ID **expire after 7 days**. Re-sign them with the same tool to keep using the app. Your files stay in place if the bundle identifier doesn't change.
- A free account can have only a few sideloaded apps at a time.
- Re-signing tools must sign the nested frameworks too. ZiniaPython contains `Python.framework` plus about 70 small frameworks (one per compiled standard-library module). Current versions of these tools sign nested frameworks; if an install fails with a signature error, update the tool.
- Your Apple ID password goes into the third-party tool. Use an app-specific password if the tool supports one, and read its privacy information.

## Path B – Apple Developer Program, signed IPA from CI

Use this with a paid Apple Developer Program membership (individual or organisation).

### 1. Create the signing assets (once)

On https://developer.apple.com/account:

1. **Identifiers** › add an App ID with an explicit bundle identifier, for example `com.yourname.ziniapython`. No special capabilities are needed.
2. **Devices** › register the UDID of each iPhone or iPad that should install the app. This is needed for ad hoc and development builds; Finder or Apple Configurator shows the UDID.
3. **Certificates** › create an **Apple Distribution** certificate (for ad hoc and App Store) or an **Apple Development** certificate. Creating one requires a certificate signing request (CSR). Without a Mac you can make one with OpenSSL (installed with Git for Windows):

   ```bash
   openssl req -new -newkey rsa:2048 -nodes -keyout zinia.key -out zinia.csr -subj "/emailAddress=you@example.com/CN=Your Name/C=US"
   ```

   Upload `zinia.csr`, download the `.cer`, then combine it with the key into a `.p12`:

   ```bash
   openssl x509 -inform der -in distribution.cer -out distribution.pem
   openssl pkcs12 -export -legacy -inkey zinia.key -in distribution.pem -out zinia.p12
   ```

   Pick a strong export password. (`-legacy` produces a .p12 that macOS keychains import reliably; if your OpenSSL doesn't know the option, leave it out.)
4. **Profiles** › create an **Ad Hoc** profile (or Development) for your App ID, certificate and devices. Download the `.mobileprovision`.

Keep `zinia.key`, `zinia.p12` and the profile **outside the repository**. `.gitignore` blocks these file types, but don't rely on that alone.

### 2. Add the GitHub secrets

Repository › **Settings › Secrets and variables › Actions › New repository secret**:

| Secret | Value |
| --- | --- |
| `IOS_CERTIFICATE_P12_BASE64` | the `.p12` file, base64-encoded |
| `IOS_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `IOS_PROVISIONING_PROFILE_BASE64` | the `.mobileprovision` file, base64-encoded |
| `IOS_BUNDLE_ID` | optional: the bundle identifier, used if the profile is a wildcard profile |

Base64-encode a file in PowerShell and copy it to the clipboard:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\zinia.p12")) | Set-Clipboard
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\ZiniaPython_AdHoc.mobileprovision")) | Set-Clipboard
```

### 3. Run the workflow

**Actions › Build iOS › Run workflow**. Choose an **export method**: `release-testing` for ad hoc, or `debugging` for a development profile. When the secrets exist, the workflow:

1. imports the certificate into a temporary keychain (`scripts/ci/import-signing.sh`, removed afterwards);
2. reads the team, profile name and bundle identifier from the profile;
3. sets manual signing on the **App target only** (`scripts/ci/configure-signing.mjs`; Swift package targets keep their own settings);
4. runs `xcodebuild archive` and `-exportArchive`, and uploads **`ZiniaPython-signed-ipa`**.

The bundle identifier in the profile overrides `com.ziniapython.ide` for that build. To make it permanent, change `appId` in `capacitor.config.ts` and `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project.

### 4. Install the signed IPA

On Windows, use one of:

- **Apple Devices** (Microsoft Store, from Apple) or iTunes: connect the device and drag the IPA onto it, where supported.
- An ad hoc distribution service or MDM.
- A re-signing or installer tool from Path A (an already-signed IPA installs without re-signing).

On a Mac you can also use Xcode (*Window › Devices and Simulators › +*) or Apple Configurator.

### App Store / TestFlight

Exporting with `app-store-connect` produces an IPA you can upload with Transporter (on a Mac) or the App Store Connect API. App Review rules apply. According to the CPython documentation, CPython's iOS build applies an App Store compliance patch to the standard library automatically. Privacy manifests for OpenSSL aren't included in the pinned runtime; see LICENSES.md, "Redistribution notes". You remain responsible for your listing and privacy disclosures.

## Development builds on a Mac

Open `ios/App/App.xcodeproj`, select your team under **Signing & Capabilities** (automatic signing), connect your device and press Run. A free Apple ID works here as well, with the same 7-day limit.

## Security checklist

- Never commit certificates, private keys, profiles or passwords.
- Store them only as GitHub secrets. Workflow logs mask secrets; the scripts never print them.
- Revoke the certificate on developer.apple.com if a `.p12` leaks.
- Pull requests from forks don't receive secrets, so they build only the unsigned IPA.
