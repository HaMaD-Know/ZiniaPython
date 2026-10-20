#!/usr/bin/env bash
# Imports an Apple signing certificate and provisioning profile from GitHub
# secrets into a temporary keychain on the runner, and writes the values the
# signed build needs to $GITHUB_ENV. Nothing is written to the repository.
#
# Required environment (from repository secrets):
#   IOS_CERTIFICATE_P12_BASE64   base64 of the .p12 (certificate + private key)
#   IOS_CERTIFICATE_PASSWORD     password of the .p12
#   IOS_PROVISIONING_PROFILE_BASE64  base64 of the .mobileprovision
set -euo pipefail

: "${IOS_CERTIFICATE_P12_BASE64:?missing}" "${IOS_CERTIFICATE_PASSWORD:?missing}" "${IOS_PROVISIONING_PROFILE_BASE64:?missing}"

WORK="$RUNNER_TEMP/signing"
mkdir -p "$WORK"
KEYCHAIN="$WORK/zinia-build.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"

echo "$IOS_CERTIFICATE_P12_BASE64" | base64 --decode > "$WORK/certificate.p12"
echo "$IOS_PROVISIONING_PROFILE_BASE64" | base64 --decode > "$WORK/profile.mobileprovision"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$WORK/certificate.p12" -P "$IOS_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN"
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

security cms -D -i "$WORK/profile.mobileprovision" > "$WORK/profile.plist"
UUID=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$WORK/profile.plist")
NAME=$(/usr/libexec/PlistBuddy -c 'Print :Name' "$WORK/profile.plist")
TEAM=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$WORK/profile.plist")
APP_ID=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$WORK/profile.plist")
BUNDLE_ID="${APP_ID#*.}"
for DIR in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    mkdir -p "$DIR"
    cp "$WORK/profile.mobileprovision" "$DIR/$UUID.mobileprovision"
done

IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN" | head -n 1 | sed -E 's/.*"(.+)"/\1/')
if [ -z "$IDENTITY" ]; then
    echo "::error::The certificate in IOS_CERTIFICATE_P12_BASE64 has no usable signing identity"
    exit 1
fi
if [[ "$BUNDLE_ID" == *"*"* ]]; then
    BUNDLE_ID="${IOS_BUNDLE_ID:-com.ziniapython.ide}"
fi

{
    echo "SIGN_KEYCHAIN=$KEYCHAIN"
    echo "SIGN_PROFILE_NAME=$NAME"
    echo "SIGN_PROFILE_UUID=$UUID"
    echo "SIGN_TEAM_ID=$TEAM"
    echo "SIGN_BUNDLE_ID=$BUNDLE_ID"
    echo "SIGN_IDENTITY=$IDENTITY"
} >> "$GITHUB_ENV"
echo "Imported '$IDENTITY'; profile '$NAME' for $BUNDLE_ID (team $TEAM)"
rm -f "$WORK/certificate.p12"
