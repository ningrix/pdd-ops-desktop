@echo off
chcp 65001 >nul
setlocal
echo ================================================
echo  BlueStacks 残留清理（需要管理员权限）
echo ================================================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [错误] 请右键本文件 -^> "以管理员身份运行"
  pause
  exit /b 1
)

echo [1/4] 停止并删除 BlueStacks 服务
for %%S in (BstkSVC BlueStacksHyperVService) do (
  sc query %%S >nul 2>&1 && (
    net stop %%S >nul 2>&1
    sc delete %%S >nul 2>&1
    echo   已删服务 %%S
  )
)

echo [2/4] 删除程序目录
if exist "C:\Program Files\BlueStacks_nxt" (
  rd /s /q "C:\Program Files\BlueStacks_nxt"
  echo   已删 C:\Program Files\BlueStacks_nxt
) else (
  echo   目录不存在，跳过
)

echo [3/4] 删除桌面快捷方式
if exist "C:\Users\Public\Desktop\BlueStacks 5.lnk" (
  del /f /q "C:\Users\Public\Desktop\BlueStacks 5.lnk"
  echo   已删
)

echo [4/4] 删除注册表
reg delete "HKLM\SOFTWARE\BlueStacks_nxt" /f >nul 2>&1 && echo   已删 HKLM\SOFTWARE\BlueStacks_nxt
reg delete "HKLM\SOFTWARE\WOW6432Node\BlueStacks_nxt" /f >nul 2>&1 && echo   已删 WOW6432Node
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\BlueStacks_nxt" /f >nul 2>&1 && echo   已删卸载项
reg delete "HKCU\SOFTWARE\BlueStacks_nxt" /f >nul 2>&1

echo.
echo ================================================
echo  完成
echo ================================================
pause
