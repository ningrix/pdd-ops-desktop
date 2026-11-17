@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo ============================================
echo  拼多多工作浏览器 - 一键启动
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch_pdd_browser.ps1"
echo.
echo 现在读取店内商品 ...
echo.
python "%~dp0cdp_eval.py" "%~dp0..\work\pdd_list_result.js"
echo.
pause
