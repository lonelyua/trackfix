# build-exe.ps1 — builds trackfix.exe using Node.js SEA (Single Executable Application)
# Run from the project root on Windows: npm run build:exe
# Requires: Node.js 20+, npm install

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "=== trackfix.exe builder ===" -ForegroundColor Cyan

# 1. Bundle TypeScript + dependencies into a single JS file
Write-Host "`n[1/4] Bundling with esbuild..."
npx esbuild app.ts `
  --bundle `
  --platform=node `
  --outfile=bundle.js `
  --define:__IS_SEA__=true
if ($LASTEXITCODE -ne 0) { exit 1 }

# 2. Generate the SEA blob from the bundle
Write-Host "[2/4] Generating SEA blob..."
node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { exit 1 }

# 3. Copy node.exe → trackfix.exe
Write-Host "[3/4] Copying node.exe → trackfix.exe..."
$nodePath = (Get-Command node).Source
Copy-Item $nodePath trackfix.exe -Force

# 4. Remove the existing signature (required before postject can inject)
#    signtool is part of Windows SDK / Visual Studio Build Tools.
#    If not installed, skip this step — the exe may show a SmartScreen warning.
$signtool = Get-Command signtool -ErrorAction SilentlyContinue
if ($signtool) {
  Write-Host "    Removing signature..."
  signtool remove /s trackfix.exe 2>$null
} else {
  Write-Host "    signtool not found — skipping signature removal (may cause SmartScreen warning)" -ForegroundColor Yellow
}

# 5. Inject the blob into the executable
Write-Host "[4/4] Injecting blob with postject..."
npx postject trackfix.exe NODE_SEA_BLOB sea-prep.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "`nDone. trackfix.exe is ready." -ForegroundColor Green
Write-Host "Place templates/, broken/ and fixed/ next to the exe, then run:"
Write-Host "  trackfix.exe -t 1"
