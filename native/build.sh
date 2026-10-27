#!/bin/bash
# Builds the depleted-capture helper (arm64) into native/bin/. Needs the Xcode Command
# Line Tools (xcode-select --install).
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "native/build.sh: skipping, the capture helper only builds on macOS"
  exit 0
fi

cd "$(dirname "$0")/DepletedCapture"
swift build -c release --arch arm64
bin_dir="$(swift build -c release --arch arm64 --show-bin-path)"

mkdir -p ../bin
cp "$bin_dir/depleted-capture" ../bin/depleted-capture
identity="$(node -p "require('../../build/signingIdentity.js').signingIdentity()")"
codesign --force --sign "$identity" ../bin/depleted-capture
echo "Built native/bin/depleted-capture ($(lipo -archs ../bin/depleted-capture))"
