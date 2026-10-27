#!/bin/bash
# Builds the depleted-capture helper into native/bin/. Needs the Xcode Command Line
# Tools (xcode-select --install). UNIVERSAL=1 builds arm64 + x86_64, which needs full Xcode.
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "native/build.sh: skipping, the capture helper only builds on macOS"
  exit 0
fi

cd "$(dirname "$0")/DepletedCapture"
archs=()
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  archs=(--arch arm64 --arch x86_64)
fi

swift build -c release "${archs[@]}"
bin_dir="$(swift build -c release "${archs[@]}" --show-bin-path)"

mkdir -p ../bin
cp "$bin_dir/depleted-capture" ../bin/depleted-capture
codesign --force --sign - ../bin/depleted-capture
echo "Built native/bin/depleted-capture ($(lipo -archs ../bin/depleted-capture))"
