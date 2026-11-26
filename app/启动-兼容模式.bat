@echo off
rem ============================================================
rem  PDD Ops Desktop - compatibility launcher (ASCII only)
rem  Use this only if the normal launcher crashes or the window
rem  stays black. It forces software rendering (--disable-gpu),
rem  which is slower but works on old/broken display drivers.
rem ============================================================
setlocal
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_ENABLE_LOGGING="
set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
    echo [ERROR] electron binary missing. Run the normal launcher first.
    pause
    exit /b 1
)

echo Starting in compatibility mode (GPU disabled)...
start "" "%ELECTRON_EXE%" --no-sandbox --disable-gpu .
endlocal
exit /b 0
