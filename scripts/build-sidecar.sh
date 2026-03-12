#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/sidecar"
OUTPUT_DIR="$ROOT_DIR/addon/bin/darwin-arm64"
OUTPUT_PATH="$OUTPUT_DIR/zph-reranker"
BUILD_PATH="$SIDECAR_DIR/.build/arm64-apple-macosx/release/ZPHReranker"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'error: sidecar builds require macOS\n' >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  printf 'error: sidecar builds currently require Apple Silicon (arm64)\n' >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

swift build \
  --configuration release \
  --arch arm64 \
  --package-path "$SIDECAR_DIR"

if [[ ! -f "$BUILD_PATH" ]]; then
  printf 'error: expected built binary at %s\n' "$BUILD_PATH" >&2
  exit 1
fi

cp "$BUILD_PATH" "$OUTPUT_PATH"
xcrun strip -x "$OUTPUT_PATH"
chmod +x "$OUTPUT_PATH"

printf 'Built sidecar binary:\n'
printf '  output_path=%s\n' "$OUTPUT_PATH"
printf '  note=Bundle this path in the XPI before release packaging.\n'
