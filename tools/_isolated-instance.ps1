# 起一个「干净的隔离实例」：确保 9222 空闲 → 删数据目录 → 启动 → 校验确实是新实例
param(
  [string]$UserData = "$env:TEMP\lumin-keymap-userdata",
  [string]$RendererUrl = 'http://localhost:5173',
  [int]$Port = 9222
)
$ErrorActionPreference = 'Continue'

function Test-Port([int]$p) {
  (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
}

# 1) 杀掉本套件的旧实例（按 user-data-dir 精确匹配，绝不碰用户自己的实例）
for ($i = 0; $i -lt 10; $i++) {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like "*$UserData*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (-not (Test-Port $Port)) { break }
  Start-Sleep -Seconds 2
}
if (Test-Port $Port) {
  Write-Host "DEBUG-PORT-BUSY: $Port 仍被占用，先处理占用进程再跑（避免套件连到旧实例）"
  return
}

# 2) 干净数据目录
Remove-Item $UserData -Recurse -Force -ErrorAction SilentlyContinue

# 3) 启动
$env:ELECTRON_RENDERER_URL = $RendererUrl
$env:LUMIN_DEBUG_PORT = "$Port"
# 两种调用方式都支持：直接执行 .ps1（有 $PSScriptRoot）或 Invoke-Expression 内容（用当前目录）
$root = if ($PSScriptRoot) { (Resolve-Path "$PSScriptRoot\..").Path } else { (Get-Location).Path }
Start-Process -FilePath (Join-Path $root 'node_modules\.bin\electron.cmd') -ArgumentList '.', "--user-data-dir=$UserData" -WorkingDirectory $root

# 4) 等调试端口起来，并校验只有 1 个窗口（= 全新实例，而不是别的实例留下的窗口）
$deadline = (Get-Date).AddSeconds(40)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
    $pages = @($list | Where-Object { $_.type -eq 'page' })
    if ($pages.Count -ge 1) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { Write-Host 'INSTANCE-NOT-READY'; return }
Start-Sleep -Seconds 3
$pages = @((Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2) | Where-Object { $_.type -eq 'page' })
Write-Host ("ISOLATED-READY pages=" + $pages.Count + " titles=" + (($pages | ForEach-Object { $_.title }) -join ','))
if ($pages.Count -ne 1) { Write-Host 'WARN: 窗口数不为 1（可能是旧实例残留）' }
