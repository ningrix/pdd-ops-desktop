# PDD Ops Desktop - GPU-first launcher (ASCII only).
#
# Why this file exists:
#   Turning GPU off makes every animation/scroll/composite fall back to CPU,
#   which is the main reason the UI felt laggy. We now start with hardware
#   acceleration ON and only fall back to --disable-gpu if the process dies
#   right after launch (old/broken display drivers).
#
# Called by ..\启动.bat. Safe to run directly:
#   powershell -NoProfile -ExecutionPolicy Bypass -File app\launch.ps1

param(
    [int]$GraceSeconds = 9
)

$ErrorActionPreference = 'SilentlyContinue'
$AppDir = $PSScriptRoot
$exe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) {
    Write-Host "[ERROR] electron.exe not found: $exe"
    exit 1
}

# These two variables break Electron startup when they leak in from a shell.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

function Get-AppProcs {
    $out = @()
    foreach ($p in @(Get-Process electron -ErrorAction SilentlyContinue)) {
        try {
            if ($p.Path -and $p.Path.StartsWith($AppDir, 'OrdinalIgnoreCase')) { $out += $p }
        } catch { }
    }
    return $out
}

function Start-App([string[]]$extra) {
    $argList = @('--no-sandbox') + $extra + @('.')
    Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $AppDir | Out-Null
}

Start-App @()
Start-Sleep -Seconds $GraceSeconds
if (@(Get-AppProcs).Count -gt 0) {
    Write-Host '[ok] started (hardware acceleration ON)'
    exit 0
}

Write-Host '[warn] app exited right after launch; retrying without GPU'
Start-App @('--disable-gpu')
Start-Sleep -Seconds $GraceSeconds
if (@(Get-AppProcs).Count -gt 0) {
    Write-Host '[ok] started in compat mode (GPU disabled)'
    exit 0
}

Write-Host '[ERROR] app failed to start. Check app\launch.log'
exit 1
