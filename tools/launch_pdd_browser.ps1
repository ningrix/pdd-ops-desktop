# ---------------------------------------------------------------------------
# 启动「拼多多工作浏览器」：独立 profile + CDP 调试端口 9222
# 只需登录一次，之后所有自动化都连这个实例，不再手动粘贴
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    Write-Host "找不到 Chrome，请确认安装路径" -ForegroundColor Red
    exit 1
}

$root    = Split-Path -Parent $PSScriptRoot
$profile = Join-Path $root "work\chrome-pdd-profile"
$null    = New-Item -ItemType Directory -Force -Path $profile

# 端口已被占用 = 已经在跑
$busy = $false
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2 -UseBasicParsing
    $busy = $true
    Write-Host "工作浏览器已在运行：" -ForegroundColor Green
    Write-Host $r.Content
} catch { $busy = $false }

if (-not $busy) {
    Write-Host "启动工作浏览器 ..." -ForegroundColor Cyan
    Write-Host "  profile: $profile"
    $args = @(
        "--remote-debugging-port=9222",
        "--remote-allow-origins=*",
        "--user-data-dir=$profile",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        "https://mms.pinduoduo.com/home/"
    )
    Start-Process -FilePath $chrome -ArgumentList $args
    Start-Sleep -Seconds 4

    for ($i = 0; $i -lt 10; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2 -UseBasicParsing
            Write-Host "✅ 调试端口就绪" -ForegroundColor Green
            Write-Host $r.Content
            break
        } catch { Start-Sleep -Milliseconds 800 }
    }
}

Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "  1. 在弹出的窗口里登录拼多多商家后台（只需这一次）"
Write-Host "  2. 之后跑： python tools\cdp_eval.py work\step2_dump.js"
Write-Host ""
