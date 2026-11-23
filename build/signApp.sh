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
# found here anyway. Paths are read NUL-separated and kept in an array, never split on
# lines, and a path with a control character (a newline could otherwise turn one path
# into two signing targets) stops the script. Signed deepest first, so everything inside
# a bundle is signed before the bundle.
items=()
depths=()
max_depth=0
while IFS= read -r -d '' path; do
  if [[ "$path" == *[[:cntrl:]]* ]]; then
    echo "signApp: a path in the app has a control character in its name" >&2
    exit 1
  fi
  if [[ -d "$path" ]] || [[ "$(file -b "$path")" == Mach-O* ]]; then
    slashes="${path//[^\/]/}"
    items+=("$path")
    depths+=("${#slashes}")
    if ((${#slashes} > max_depth)); then max_depth=${#slashes}; fi
  fi
done < <(find "$app/Contents" \( -type d \( -name '*.app' -o -name '*.framework' \) -o -type f \) -print0)

count=0
for ((depth = max_depth; depth >= 0; depth--)); do
  for i in "${!items[@]}"; do
    if [[ "${depths[$i]}" == "$depth" ]]; then
      sign "${items[$i]}"
      count=$((count + 1))
    fi
  done
done

sign "$app"
echo "signApp: signed $count nested items and $(basename "$app") with ${identity}"
codesign --verify --deep --strict --verbose=2 "$app"
