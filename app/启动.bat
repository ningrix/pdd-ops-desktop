@echo off
rem ============================================================
rem  PDD Ops Desktop - launcher
rem  NOTE: keep this file ASCII-only. Chinese comments break
rem        under cmd's default GBK codepage and get executed
rem        as commands.
rem ============================================================
setlocal
cd /d "%~dp0"

set "LOG=%~dp0launch.log"
echo [%date% %time%] launcher start, cwd=%CD% >> "%LOG%"
echo     ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%] >> "%LOG%"

rem Must clear ELECTRON_RUN_AS_NODE, otherwise Electron runs as
rem plain Node and the window never appears.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_ENABLE_LOGGING="

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
    echo [first run] installing electron ...
    call npm.cmd install --registry=https://registry.npmmirror.com --no-audit --no-fund
    if errorlevel 1 goto :fail
)

if not exist "%ELECTRON_EXE%" (
    echo [first run] extracting electron binary ...
    pushd node_modules\electron
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    node install.js
    popd
)

if not exist "%ELECTRON_EXE%" goto :fail

echo     launching %ELECTRON_EXE% >> "%LOG%"
rem GPU first; launch.ps1 falls back to --disable-gpu if the process dies at once.
rem Do NOT add --disable-gpu here: it overrides the setting and forces CPU rendering.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
echo     launch.ps1 returned errorlevel=%ERRORLEVEL% >> "%LOG%"
endlocal
exit /b 0

:fail
echo     FAIL: electron binary missing >> "%LOG%"
echo.
echo [ERROR] Electron binary is missing or install failed.
pause
endlocal
exit /b 1
