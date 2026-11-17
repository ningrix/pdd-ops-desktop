# Safe restart / stop for PDD upload console.
#
# WHY THIS SCRIPT EXISTS:
#   "taskkill /F" kills Electron immediately, so session.flushStorageData()
#   inside before-quit never runs and cookies are never written to disk.
#   Result: login state is lost and every shop must be re-scanned.
#   This script asks the window to close first, waits for a clean exit,
#   and only force-kills as a last resort - with a loud warning.
#
# IMPORTANT: this file is intentionally pure ASCII.
#   Windows PowerShell 5.1 reads BOM-less files as the ANSI codepage (GBK),
#   so any Chinese text here would be mangled into a parse error.
#   Same lesson as the launcher .bat in app\.
#
# USAGE:
#   Restart (with debug port):  .\tools\restart-app.ps1
#   Restart (no debug port):    .\tools\restart-app.ps1 -NoDebug
#   Stop only:                  .\tools\restart-app.ps1 -StopOnly

param(
    [switch]$StopOnly,
    [switch]$NoDebug,
    [int]$GraceSeconds = 25,
    [int]$DebugPort = 9333
)

$ErrorActionPreference = 'Stop'
$appDir = (Resolve-Path (Join-Path $PSScriptRoot '..\app')).Path
$exe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'

function Get-AppProcs {
    $all = Get-Process electron -ErrorAction SilentlyContinue
    if (-not $all) { return @() }
    $out = @()
    foreach ($p in $all) {
        try {
            if ($p.Path -and ($p.Path.StartsWith($appDir, 'OrdinalIgnoreCase'))) { $out += $p }
        } catch { }
    }
    return $out
}

$procs = @(Get-AppProcs)
if ($procs.Count -eq 0) {
    Write-Host '[i] App is not running.' -ForegroundColor DarkGray
} else {
    Write-Host ("[1] Asking window(s) to close normally ({0} process(es))..." -f $procs.Count) -ForegroundColor Cyan
    foreach ($p in $procs) {
        try { $null = $p.CloseMainWindow() } catch { }
    }

    # Wait for a self-exit. before-quit -> flushStorageData() runs in this window.
    $deadline = (Get-Date).AddSeconds($GraceSeconds)
    $clean = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        if (@(Get-AppProcs).Count -eq 0) { $clean = $true; break }
    }

    if ($clean) {
        Write-Host '[2] Exited cleanly. Login state has been flushed to disk.' -ForegroundColor Green
    } else {
        Write-Host '[2] WARNING: window did not exit in time; about to force kill.' -ForegroundColor Yellow
        Write-Host '    Force killing can lose cookies -> you may need to re-scan QR codes.' -ForegroundColor Yellow
        Write-Host '    Press Ctrl+C now to abort and close the window manually instead.' -ForegroundColor Yellow
        Start-Sleep -Seconds 4
        foreach ($p in @(Get-AppProcs)) { try { $p.Kill() } catch { } }
        Start-Sleep -Seconds 2
        Write-Host '[3] Force killed.' -ForegroundColor DarkYellow
    }
}

if ($StopOnly) {
    Write-Host 'Stop only; not restarting.' -ForegroundColor DarkGray
    exit 0
}

# ---- Launch ----
if (-not (Test-Path $exe)) {
    Write-Host "electron.exe not found: $exe" -ForegroundColor Red
    Write-Host 'Run "npm install" inside app\ first.' -ForegroundColor Red
    exit 1
}

# If ELECTRON_RUN_AS_NODE=1 leaks into the environment, electron degrades into
# plain Node (ipcMain undefined). Must be removed explicitly.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$argList = @('--no-sandbox', '--disable-gpu')
if (-not $NoDebug) { $argList += "--remote-debugging-port=$DebugPort" }
$argList += '.'

Write-Host '[4] Starting app...' -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $appDir | Out-Null
Start-Sleep -Seconds 14

$running = @(Get-AppProcs)
if ($running.Count -gt 0) {
    $ids = ($running | ForEach-Object { $_.Id }) -join ','
    Write-Host ("    OK - started (PID {0})" -f $ids) -ForegroundColor Green
    if (-not $NoDebug) {
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 5 -UseBasicParsing
            Write-Host "    Debug port $DebugPort is ready" -ForegroundColor DarkGray
        } catch {
            Write-Host "    Debug port $DebugPort not responding (app still usable)" -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host '    FAILED to start. Check app\launch.log' -ForegroundColor Red
    exit 1
}
