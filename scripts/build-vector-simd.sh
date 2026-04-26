#!/bin/bash
# Build vector-simd shared library for the current platform.
#
# Targets:
#   - linux/amd64 (production KonarServer): AVX2 + FMA via gcc
#   - darwin/arm64 (dev macOS Apple Silicon): scalar fallback via clang
#
# The output filename includes os+arch so both binaries can coexist
# in the repo and we pick the right one at runtime.
#
# Usage:
#   ./scripts/build-vector-simd.sh              # auto-detect host
#   ./scripts/build-vector-simd.sh linux-amd64  # cross-compile-ish

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/../packages/api/src/services/rag/vector-simd.c"
OUT_DIR="${SCRIPT_DIR}/../packages/api/src/services/rag"

TARGET="${1:-auto}"

if [ "$TARGET" = "auto" ]; then
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64)   TARGET=linux-amd64 ;;
    Darwin/arm64)   TARGET=darwin-arm64 ;;
    Darwin/x86_64)  TARGET=darwin-amd64 ;;
    *)              echo "unsupported host: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
  esac
fi

echo "Building vector-simd for $TARGET"

case "$TARGET" in
  linux-amd64)
    OUT="${OUT_DIR}/vector-simd.linux-amd64.so"
    gcc -O3 -mavx2 -mfma -shared -fPIC -o "$OUT" "$SRC"
    ;;
  darwin-arm64)
    OUT="${OUT_DIR}/vector-simd.darwin-arm64.dylib"
    clang -O3 -shared -fPIC -arch arm64 -o "$OUT" "$SRC"
    ;;
  darwin-amd64)
    OUT="${OUT_DIR}/vector-simd.darwin-amd64.dylib"
    clang -O3 -mavx2 -mfma -shared -fPIC -arch x86_64 -o "$OUT" "$SRC"
    ;;
  *)
    echo "unknown target: $TARGET" >&2
    exit 1
    ;;
esac

echo "Built: $OUT ($(du -h "$OUT" | cut -f1))"
