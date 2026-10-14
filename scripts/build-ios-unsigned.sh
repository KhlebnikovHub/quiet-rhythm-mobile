#!/usr/bin/env bash
# Build on a real macOS/Xcode host, including Codemagic's Mac mini runner.
# The resulting device IPA is unsigned; Sideloadly signs it on the user's PC.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'iOS compilation requires macOS with Xcode 26+. On Windows, run the ios-unsigned workflow in Codemagic, then download its IPA and install using Sideloadly.' >&2
  exit 2
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_root"
for tool in xcodebuild xcrun npm node python3 ditto shasum; do
  command -v "$tool" >/dev/null || { printf 'Missing build tool: %s\n' "$tool" >&2; exit 2; }
done

# Never clear a user-selected folder. Every attempt has its own output paths.
for directory in artifacts artifacts/ios releases; do
  if [[ -L "$directory" ]]; then
    printf 'Build directory must not be a symbolic link: %s\n' "$directory" >&2
    exit 2
  fi
  mkdir -p "$directory"
done
build_dir="$(mktemp -d "$project_root/artifacts/ios/build.XXXXXX")"
exec > >(tee "$build_dir/build.log") 2>&1
finish() {
  result=$?
  if [[ "$result" -ne 0 ]]; then
    printf '\nBuild failed (exit %s). Logs: %s\n' "$result" "$build_dir"
  fi
}
trap finish EXIT

xcodebuild -version
xcode_major="$(xcodebuild -version | awk 'NR == 1 { split($2, version, "."); print version[1] }')"
if [[ ! "$xcode_major" =~ ^[0-9]+$ ]] || (( xcode_major < 26 )); then
  printf '%s\n' 'Select Xcode 26 or newer. Codemagic uses the version configured in codemagic.yaml.' >&2
  exit 2
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22+ is required");'

printf '\nInstalling locked dependencies...\n'
npm ci
printf '\nBundling the offline editor and copying iOS resources...\n'
npm run build:native
npx --no-install cap sync ios

project="$project_root/ios/App/App.xcodeproj"
archive="$build_dir/QuietRhythm.xcarchive"
package_cache="$build_dir/SourcePackages"

printf '\nResolving Swift packages...\n'
xcodebuild -resolvePackageDependencies \
  -project "$project" -scheme App \
  -clonedSourcePackagesDirPath "$package_cache" \
  2>&1 | tee "$build_dir/packages.log"

# A DEVICE destination is essential. A simulator .app cannot run on an iPhone.
# No -allowProvisioningUpdates, keychain imports, Apple accounts or certificates.
printf '\nArchiving for an iPhone/iPad, without a signing identity...\n'
xcodebuild archive \
  -project "$project" -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  -derivedDataPath "$build_dir/DerivedData" \
  -clonedSourcePackagesDirPath "$package_cache" \
  -resultBundlePath "$build_dir/Archive.xcresult" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= DEVELOPMENT_TEAM= ONLY_ACTIVE_ARCH=NO \
  2>&1 | tee "$build_dir/xcodebuild.log"

app="$archive/Products/Applications/App.app"
if [[ ! -d "$app" ]]; then
  printf 'Xcode did not produce the expected device application: %s\n' "$app" >&2
  exit 1
fi

printf '\nChecking the device platform and bundled offline files...\n'
python3 - "$app" <<'PY'
import json
import pathlib
import plistlib
import sys

app = pathlib.Path(sys.argv[1])
with (app / "Info.plist").open("rb") as file:
    info = plistlib.load(file)
if info.get("DTPlatformName") != "iphoneos" or "iPhoneOS" not in info.get("CFBundleSupportedPlatforms", []):
    raise SystemExit("Archive is not an iPhoneOS device build; do not package a simulator app.")
if info.get("CFBundleExecutable") != "App":
    raise SystemExit("Unexpected executable name in the archived app.")
for filename in ("index.html", "app.js", "core.js", "native.js", "storage.js", "export.js"):
    if not (app / "public" / filename).is_file():
        raise SystemExit(f"Missing bundled offline resource: {filename}")
with (app / "capacitor.config.json").open(encoding="utf-8") as file:
    config = json.load(file)
if config.get("server", {}).get("url"):
    raise SystemExit("A native offline app must not point at a remote server.url.")
print("Verified iPhoneOS app and local editor resources.")
PY
xcrun lipo -verify_arch arm64 "$app/App"
xcrun lipo -info "$app/App" | tee "$build_dir/architecture.log"

# ditto retains framework symlinks and the app's file permissions.
# A signing/export profile is deliberately not requested: this IPA is signed
# locally by Sideloadly, not by xcodebuild -exportArchive or App Store Connect.
payload="$build_dir/package/Payload"
mkdir -p "$payload"
ditto "$app" "$payload/App.app"
temporary_ipa="$build_dir/quiet-rhythm-ios-unsigned.ipa"
ditto -c -k --norsrc --keepParent "$payload" "$temporary_ipa"
python3 - "$temporary_ipa" <<'PY'
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    required = {"Payload/App.app/Info.plist", "Payload/App.app/App", "Payload/App.app/public/index.html"}
    if not required.issubset(archive.namelist()):
        raise SystemExit("IPA is missing its Payload/App.app contents.")
    if archive.testzip() is not None:
        raise SystemExit("IPA ZIP integrity verification failed.")
print("Verified IPA package structure and ZIP integrity.")
PY

output="$project_root/releases/quiet-rhythm-ios-unsigned.ipa"
cp "$temporary_ipa" "$output.tmp"
mv -f "$output.tmp" "$output"
(
  cd "$project_root/releases"
  shasum -a 256 quiet-rhythm-ios-unsigned.ipa > quiet-rhythm-ios-unsigned.ipa.sha256
)
printf '\nCreated: %s\n' "$output"
printf '%s\n' 'Install this IPA with Sideloadly on Windows using your Apple Account. Directly downloading an unsigned IPA onto an iPhone does not install it.'
printf '%s\n' 'A free Apple Account requires refreshing the signature at least every 7 days. No App Store/TestFlight upload was performed.'
