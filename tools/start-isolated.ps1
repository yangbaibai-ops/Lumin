# 起一个「干净的隔离实例」：确保调试端口空闲 → 删数据目录 → 启动 → 校验确实是新实例
#
# 这是**跑 CDP 套件的标准入口**（tools/run-suites.js 也是调它）。要点：
#   * 数据目录用 `--user-data-dir` 指到临时目录，**绝不碰用户自己的 `%APPDATA%\lumin`**；
#   * 起之前按 user-data-dir 精确杀掉本套件的旧实例，避免套件连到上一个实例的窗口上
#     （那是「同一套件两次结果不一样」最常见的原因）。**注意**：Electron 的
#     `--user-data-dir` 用的是 8.3 短路径（`ALICE~1`），直接字符串比对会漏杀，
#     实测因此对着**旧构建**跑了一整轮验收 —— 所以这里把两边都 Resolve-Path 成长路径再比；
#   * 默认直接加载 `out/renderer` 的构建产物（`-NoDevServer` 现在是默认行为）：
#     构建产物才是用户拿到的东西，dev server 反而会让套件行为随 HMR 状态漂移。
#     只有少数 `import('/src/...')` 的老套件才需要 `-RendererUrl http://localhost:5173`。
#
# 退出码：0 = READY；2 = 端口被占（有别的实例在用）；3 = 实例没起来。
#
# 本文件必须存成 **UTF-8 with BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本时
# 按 ANSI 解码，中文注释里的多字节序列会撞出引号，直接语法错误（实测踩过）。
param(
  [string]$UserData = "$env:TEMP\lumin-ud",
  [string]$RendererUrl = '',
  [switch]$NoDevServer,
  [int]$Port = 9222,
  # 只清理本套件的旧实例、不启动新实例（tools/run-suites.js 在每轮开始/结束时用它收尾）
  [switch]$CleanupOnly
)
$ErrorActionPreference = 'Continue'

# TCP 层判端口：Get-NetTCPConnection 在受限权限/受限语言模式下会静默返回空，
# 那会让「端口被占」判成空闲，于是新实例绑不上调试端口、套件却连到旧实例上。
function Test-Port([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $p)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-LongPath([string]$p) {
  try { return (Resolve-Path -LiteralPath $p -ErrorAction Stop).Path } catch { return $p }
}

$target = Get-LongPath $UserData
$leaf = Split-Path -Leaf $UserData

function Get-OurInstances {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object {
    $cmd = $_.CommandLine
    if (-not $cmd) { return $false }
    # 认 --user-data-dir 的路径（长/短两种写法都认），并兜一层「叶子目录名」匹配
    if ($cmd -match '--user-data-dir="?([^"\s]+)') {
      $given = Get-LongPath $matches[1]
      if ($given -eq $target) { return $true }
    }
    return $cmd -like "*$leaf*"
  }
}

# 1) 杀掉本套件的旧实例
for ($i = 0; $i -lt 12; $i++) {
  $ours = @(Get-OurInstances)
  if ($ours.Count -eq 0 -and -not (Test-Port $Port)) { break }
  foreach ($p in $ours) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 700
}
if (Test-Port $Port) {
  Write-Host "DEBUG-PORT-BUSY: $Port 仍被占用但没有可识别的本套件实例 —— 可能是别的 Electron 实例在用，先处理再跑（否则套件会连到它上面）"
  exit 2
}

# 只清理：杀掉旧实例、删数据目录，不启动（run-suites 用它做每轮前后的收尾）
if ($CleanupOnly) {
  if (Test-Path $UserData) { & cmd.exe /c rmdir /s /q "$UserData" 2>$null }
  Write-Host 'CLEANED'
  exit 0
}

# 2) 干净数据目录
# 用 cmd 的 rmdir 而不是 Remove-Item：实例刚被杀掉时目录里可能还有句柄，
# Remove-Item 会一直重试（整套脚本就卡在这里，实测卡过 7 分钟）；rmdir 失败就失败，立刻返回。
if (Test-Path $UserData) {
  & cmd.exe /c rmdir /s /q "$UserData" 2>$null
}

# 3) 启动（stdout/stderr 落文件：验收脚本要读主进程的自检日志，例如 [taskbar] 跳转列表注册结果）
if ($NoDevServer -or [string]::IsNullOrWhiteSpace($RendererUrl)) {
  Remove-Item Env:\ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
} else {
  $env:ELECTRON_RENDERER_URL = $RendererUrl
}
$env:LUMIN_DEBUG_PORT = "$Port"
# 测试期的**信任路径**：路径授权闸（src/main/services/pathGrants）默认只放行
# 工作区 / 用户选过 / 会话说 / 打开过 / 拖入的路径，而套件习惯"自己造夹具再直接 openPath"。
# 这里把 %TEMP% 声明成信任范围 —— 只在**未打包**实例上生效（打包产物忽略该变量，
# 见 grantTrustedPathsFromEnv 的说明），且隔离实例本来就只用临时数据目录。
$env:LUMIN_TRUSTED_PATHS = $env:TEMP
# 日志按 user-data-dir 分文件：同一台机器上并行跑两套隔离实例时不会互相抢句柄
$outLog = Join-Path $env:TEMP ("lumin-instance-" + $leaf + "-out.log")
$errLog = Join-Path $env:TEMP ("lumin-instance-" + $leaf + "-err.log")
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
# 主进程自检日志（taskbar 等）也清掉，保证验收脚本读到的是本次实例写的内容
Remove-Item (Join-Path $env:TEMP 'lumin-taskbar.log') -Force -ErrorAction SilentlyContinue
# 两种调用方式都支持：直接执行 .ps1（有 $PSScriptRoot）或 Invoke-Expression 内容（用当前目录）
$root = if ($PSScriptRoot) { (Resolve-Path "$PSScriptRoot\..").Path } else { (Get-Location).Path }
Start-Process -FilePath (Join-Path $root 'node_modules\.bin\electron.cmd') -ArgumentList '.', "--user-data-dir=$UserData" -WorkingDirectory $root -RedirectStandardOutput $outLog -RedirectStandardError $errLog

# 4) 等调试端口起来（旧实例已按数据目录杀干净，这里连到的就是本次新实例）
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
if (-not $ok) {
  Write-Host "INSTANCE-NOT-READY (stdout=$outLog stderr=$errLog)"
  exit 3
}
# 首帧之后的**稳定期**：套件在页面 side 要量布局/挂载/焦点，而这些东西要等一次真正的布局+绘制。
# 3s 在空闲机器上够，机器忙时（用户在用同一个桌面 / 同时跑别的实例）会不够 ——
# 表现是"某些套件随机假红"：代码块全静态（viewport 高度还没算出来）、focused=false、按键没落地。
# 5s 是折中：不显著拖慢矩阵（每套件多 2s），但把这类假红压掉。
Start-Sleep -Seconds 5
$pages = @((Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2) | Where-Object { $_.type -eq 'page' })
Write-Host ("ISOLATED-READY pages=" + $pages.Count + " titles=" + (($pages | ForEach-Object { $_.title }) -join ','))
if ($pages.Count -ne 1) { Write-Host 'WARN: 窗口数不为 1（可能是旧实例残留）' }
exit 0
