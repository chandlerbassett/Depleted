#!/bin/bash
# Signs a built Depleted.app for release, the way electron-builder used to during packaging:
# every Mach-O file and nested bundle first (deepest first), then the app, all with the
# hardened runtime, a secure timestamp and build/entitlements.mac.plist.
#
# The release workflow runs this in its signing job, which holds the Developer ID
# certificate but never installs npm packages: only this script and Apple's tools run
# there. Usage: build/signApp.sh <Depleted.app> <identity, or - for ad-hoc> <entitlements>
set -euo pipefail

app="$1"
identity="$2"
entitlements="$3"

[[ -d "$app" && "$app" == *.app ]] || { echo "signApp: $app is not an app bundle" >&2; exit 1; }
[[ -f "$entitlements" ]] || { echo "signApp: $entitlements not found" >&2; exit 1; }

# Ad-hoc signatures can't carry a secure timestamp
timestamp=(--timestamp)
[[ "$identity" == "-" ]] && timestamp=(--timestamp=none)

sign() {
  codesign --sign "$identity" --force "${timestamp[@]}" --options runtime --entitlements "$entitlements" "$1"
}

# Nested bundles (helper apps, frameworks) and loose Mach-O files (dylibs, ShipIt,
# chrome_crashpad_handler, the capture helper). Symlinks are skipped: they point at files
# found here anyway. Lines are "<depth> <path>", sorted deepest first so everything inside
# a bundle is signed before the bundle.
items="$(mktemp)"
trap 'rm -f "$items"' EXIT
while IFS= read -r -d '' path; do
  if [[ -d "$path" ]]; then
    echo "$path"
  elif [[ "$(file -b "$path")" == Mach-O* ]]; then
    echo "$path"
  fi
done < <(find "$app/Contents" \( -type d \( -name '*.app' -o -name '*.framework' \) -o -type f \) -print0) |
  awk -F/ '{ print NF, $0 }' | sort -rn -k1,1 -s | cut -d' ' -f2- > "$items"

count=0
while IFS= read -r path; do
  sign "$path"
  count=$((count + 1))
done < "$items"

sign "$app"
echo "signApp: signed $count nested items and $(basename "$app") with ${identity}"
codesign --verify --deep --strict --verbose=2 "$app"
