#!/usr/bin/env bash
# build-exe.sh — builds trackfix.exe (Windows x64) from Linux
# Usage: npm run build:exe
# Requires: Node.js 20+, osslsigncode
#   sudo apt install osslsigncode

set -euo pipefail

echo "=== trackfix.exe builder (Linux → Windows) ==="

# ---- dependency check ----
if ! command -v osslsigncode &>/dev/null; then
  echo ""
  echo "Error: osslsigncode is required to strip the Node.js signature before injection."
  echo "  sudo apt install osslsigncode"
  exit 1
fi

# ---- resolve Node version ----
NODE_VERSION=$(node --version | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ required (current: v${NODE_VERSION})"
  exit 1
fi

WIN_NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe"

mkdir -p dist

echo ""

# 1. Download the matching Windows binary
echo "[1/5] Downloading Windows node.exe v${NODE_VERSION}..."
curl -fsSL --progress-bar "$WIN_NODE_URL" -o dist/node_win.exe

# 2. Bundle TypeScript + all dependencies into a single JS file
echo "[2/5] Bundling with esbuild..."
npx esbuild app.ts \
  --bundle \
  --platform=node \
  --outfile=dist/bundle.js \
  --define:__IS_SEA__=true

# 3. Generate the SEA blob from the bundle
echo "[3/5] Generating SEA blob..."
node --experimental-sea-config sea-config.json

# 4. Strip the Microsoft signature from node.exe
#    (Windows will refuse to run a PE binary whose signature doesn't match its content)
echo "[4/5] Stripping signature from node.exe..."
rm -f trackfix.exe
osslsigncode remove-signature -in dist/node_win.exe -out trackfix.exe
rm dist/node_win.exe

# 5. Inject the blob into the executable
echo "[5/5] Injecting blob with postject..."
npx postject trackfix.exe NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

echo ""
echo "Done. trackfix.exe is ready."
echo "Place templates/ and broken/ next to the exe, then run:"
echo "  trackfix.exe -t 1"
