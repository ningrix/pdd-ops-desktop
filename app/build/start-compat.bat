@echo off
rem ============================================================
rem  Compatibility launcher.
rem  Use this if double-clicking the desktop shortcut does nothing.
rem  It clears Node/Electron env vars injected by IDEs or sandboxes,
rem  and explicitly disables the Chromium sandbox and GPU.
rem  Keep this file ASCII-only.
rem ============================================================
setlocal
cd /d "%~dp0"
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="
start "" "PDD Ops Desktop.exe" --no-sandbox --disable-gpu
endlocal
exit /b 0
