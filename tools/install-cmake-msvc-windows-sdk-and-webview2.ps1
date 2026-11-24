# install-cmake-msvc-windows-sdk-and-webview2.ps1
#
# One-shot setup for the native SteaMar build (`npm run build:app`), which needs:
#   1. CMake                      (Kitware.CMake - put on PATH)
#   2. Visual Studio 2022 Build Tools, "Desktop development with C++" workload
#        - MSVC v143 compiler
#        - Windows 11 SDK
#   3. WebView2 SDK 1.0.3405.78   (unpacked into the NuGet cache, at the exact
#        path native/CMakeLists.txt hard-requires)
#
# Idempotent: safe to re-run; each step is skipped when already present.
# After it finishes, open a NEW terminal (so cmake is on PATH), then run:
#     npm run build:app
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-cmake-msvc-windows-sdk-and-webview2.ps1

$ErrorActionPreference = 'Stop'

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Error "winget not found. Install 'App Installer' from the Microsoft Store, or install Visual Studio 2022 Build Tools and CMake manually."
}

function Test-VsBuildTools {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022\BuildTools'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools')
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $true }
    }
    return $false
}

Write-Host "==> [1/3] Visual Studio 2022 Build Tools (MSVC + Windows SDK)" -ForegroundColor Cyan
if (Test-VsBuildTools) {
    Write-Host "      already installed - skipping." -ForegroundColor Yellow
} else {
    $vsArgs = @(
        '--quiet', '--wait', '--norestart',
        '--add', 'Microsoft.VisualStudio.Workload.VCTools',
        '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.22621',
        '--includeRecommended'
    )
    winget install --id Microsoft.VisualStudio.2022.BuildTools --override ($vsArgs -join ' ')
    if ($LASTEXITCODE -ne 0) { throw "Visual Studio Build Tools install failed (exit $LASTEXITCODE)." }
}

Write-Host "`n==> [2/3] CMake (Kitware.CMake - adds cmake to PATH)" -ForegroundColor Cyan
if (Get-Command cmake -ErrorAction SilentlyContinue) {
    Write-Host "      cmake already on PATH: $((Get-Command cmake).Source)" -ForegroundColor Yellow
} else {
    winget install --id Kitware.CMake --silent
    if ($LASTEXITCODE -ne 0) { throw "CMake install failed (exit $LASTEXITCODE)." }
}

Write-Host "`n==> [3/3] WebView2 SDK 1.0.3405.78 (NuGet cache)" -ForegroundColor Cyan
$wv2Root   = Join-Path $env:USERPROFILE '.nuget\packages\microsoft.web.webview2\1.0.3405.78'
$wv2Header = Join-Path $wv2Root 'build\native\include\WebView2.h'
if (Test-Path $wv2Header) {
    Write-Host "      already present - skipping." -ForegroundColor Yellow
} else {
    New-Item -ItemType Directory -Force -Path $wv2Root | Out-Null
    $zip = Join-Path $env:TEMP 'microsoft.web.webview2.1.0.3405.78.zip'
    curl.exe -L -o $zip 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.3405.78'
    if ($LASTEXITCODE -ne 0) { throw "WebView2 SDK download failed (exit $LASTEXITCODE)." }
    Expand-Archive -Path $zip -DestinationPath $wv2Root -Force
    Remove-Item $zip -ErrorAction SilentlyContinue
}

Write-Host "`n==> Verify" -ForegroundColor Cyan
$allOk = $true

if (Test-Path $wv2Header) {
    Write-Host "   [ ok ] WebView2 SDK: $wv2Root" -ForegroundColor Green
} else {
    Write-Host "   [FAIL] WebView2.h missing: $wv2Header" -ForegroundColor Red
    $allOk = $false
}

if (Test-VsBuildTools) {
    Write-Host "   [ ok ] Visual Studio 2022 Build Tools present" -ForegroundColor Green
} else {
    Write-Host "   [FAIL] Visual Studio 2022 Build Tools not found" -ForegroundColor Red
    $allOk = $false
}

if ($allOk) {
    Write-Host "`nDone. Open a NEW terminal (so cmake is on PATH), then run:  npm run build:app" -ForegroundColor Cyan
} else {
    Write-Host "`nOne or more checks failed - see the [FAIL] lines above." -ForegroundColor Red
    exit 1
}
