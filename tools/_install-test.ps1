# ─── 安装 / 卸载 端到端实测（第二轮：验证 P1/P2/P4/P6 修复）───────────────────
# 用法（在仓库根目录）：pwsh -File tools\_install-test.ps1
#
# 设计要点：
#  * 全程**静默**（/S）跑安装与卸载，避免弹窗阻塞；
#  * 被测实例一律用 --user-data-dir 隔离 profile 启动，**不碰**开发者自己的 %APPDATA%\Lumin；
#  * 无论断言是否失败，finally 块都会：卸载应用、清掉桌面快捷方式残留、重建开发者原有的桌面快捷方式；
#  * 输出 PASS/FAIL 表 + 汇总，失败时退出码非 0（可直接作为发布前检查）。
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$setup = Join-Path $repo 'dist\Lumin-1.0.0-setup.exe'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Lumin'
$startMenuLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Lumin.lnk'
$desktopLnk = Join-Path $env:USERPROFILE 'Desktop\Lumin.lnk'
$userData = Join-Path $env:APPDATA 'Lumin'
$fixtureDir = Join-Path $env:TEMP 'lumin-install-test'
$fixture = Join-Path $fixtureDir '安装测试-甲文档.md'
$testProfile = Join-Path $env:TEMP 'lumin-install-test-profile'
$sh = New-Object -ComObject WScript.Shell

$results = @()
function C([string]$name, [bool]$cond, [string]$detail) {
  $script:results += (($(if ($cond) { 'PASS' } else { 'FAIL' })) + ' ' + $name + ' | ' + $detail)
}
function RegDefault([string]$path) { (Get-ItemProperty $path -ErrorAction SilentlyContinue).'(default)' }
function UserDataCounts {
  $files = (Get-ChildItem $userData -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $drafts = (Get-ChildItem (Join-Path $userData 'drafts') -File -ErrorAction SilentlyContinue | Measure-Object).Count
  return @{ files = $files; drafts = $drafts }
}

if (-not (Test-Path $setup)) { Write-Host "缺少安装包: $setup（先跑 npm run build:win）"; exit 2 }

# ── 基线 ──
$base = UserDataCounts
$baseMd = RegDefault 'HKCU:\Software\Classes\.md'
$baseMarkdown = RegDefault 'HKCU:\Software\Classes\.markdown'
Write-Host "BASE userData files=$($base.files) drafts=$($base.drafts)  .md='$baseMd'  .markdown='$baseMarkdown'"
Write-Host "SETUP bytes=$((Get-Item $setup).Length) sha256=$((Get-FileHash $setup -Algorithm SHA256).Hash)"

New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
[System.IO.File]::WriteAllText($fixture, "# 安装测试标题`n`n这是安装测试用的中文正文。`n", (New-Object System.Text.UTF8Encoding($false)))
Remove-Item $testProfile -Recurse -Force -ErrorAction SilentlyContinue
$installed = $false

try {
  # ── 1) 静默安装 ──
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
  $sw.Stop()
  $installed = $true
  C 'install-exit-0' ($p.ExitCode -eq 0) "exit=$($p.ExitCode) 耗时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s"

  # ── 2) 安装产物与注册表 ──
  $exe = Join-Path $installDir 'Lumin.exe'
  C 'installed-exe-present' (Test-Path $exe) "exe=$((Get-Item $exe -ErrorAction SilentlyContinue).Length) bytes"

  $unKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like '*Lumin*' } | Select-Object -First 1
  $u = if ($unKey) { Get-ItemProperty $unKey.PSPath } else { $null }
  C 'publisher-is-real-author' ($u -and $u.Publisher -eq 'yang_bai_bai' -and $u.Publisher -notlike '*example.com*') "Publisher='$($u.Publisher)'"
  C 'install-location-non-empty' ($u -and $u.InstallLocation) "InstallLocation='$($u.InstallLocation)'"
  Write-Host "UNINSTALL-ENTRY key=$($unKey.PSChildName) DisplayName='$($u.DisplayName)' Version='$($u.DisplayVersion)' EstimatedSize=$([math]::Round($u.EstimatedSize/1024,1))MB"

  $prog = RegDefault 'HKCU:\Software\Classes\.md'
  $cmd = (Get-ItemProperty 'HKCU:\Software\Classes\Markdown\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
  C 'md-associated-to-progid' ($prog -eq 'Markdown') ".md='$prog'"
  C "md-open-command-points-to-exe" ($cmd -like '*Lumin.exe*%1*') "cmd='$cmd'"
  C 'markdown-ext-associated' ((RegDefault 'HKCU:\Software\Classes\.markdown') -eq 'Markdown') ".markdown='$(RegDefault 'HKCU:\Software\Classes\.markdown')'"
  C 'shortcuts-created' ((Test-Path $startMenuLnk) -and (Test-Path $desktopLnk)) "start=$((Test-Path $startMenuLnk)) desktop=$((Test-Path $desktopLnk))"

  # ── 3) 以裸路径启动打包版（同时触发 AUMID 幂等补写）──
  $env:LUMIN_DEBUG_PORT = '9229'
  Remove-Item (Join-Path $env:TEMP 'lumin-taskbar.log') -Force -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $exe -ArgumentList "--user-data-dir=$testProfile", '--remote-debugging-port=9229', $fixture -PassThru
  Start-Sleep -Seconds 10
  $title = $null
  try { $title = (@(Invoke-RestMethod 'http://127.0.0.1:9229/json/list' -TimeoutSec 5 | Where-Object { $_.type -eq 'page' })[0]).title } catch { }
  C 'packaged-opens-bare-path-file' ($title -like '*安装测试-甲文档*') "窗口标题='$title'"
  Stop-Process -Name Lumin -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3

  # ── 4) 快捷方式 AUMID ──
  # 断言用**应用自己的自检日志**：它走 Electron 的 shell.readShortcutLink（与 Windows shell 同一条 API），
  # 比在 .lnk 原始字节里搜字符串可靠 —— 第一轮正是栽在字节搜索上（见文档 P4 更正）。
  $taskbarLog = Join-Path $env:TEMP 'lumin-taskbar.log'
  $aumidLine = @(Get-Content $taskbarLog -ErrorAction SilentlyContinue) | Where-Object { $_ -match 'aumid' } | Select-Object -Last 1
  C 'shortcut-aumid-present' ($aumidLine -match 'com\.lumin\.app') "log: $aumidLine"
  $byteHit = $false
  if (Test-Path $startMenuLnk) {
    $byteHit = ([System.Text.Encoding]::Unicode.GetString([System.IO.File]::ReadAllBytes($startMenuLnk))) -match 'com\.lumin\.app'
  }
  Write-Host "INFO 原始字节搜索命中=$byteHit（仅观察；与日志不一致时以日志为准，见 P4 更正）"
  if (Test-Path $startMenuLnk) {
    $l = $sh.CreateShortcut($startMenuLnk)
    C 'shortcut-kept-installer-target' ($l.TargetPath -like '*\Programs\Lumin\Lumin.exe') "target=$($l.TargetPath) args='$($l.Arguments)'"
  } else {
    C 'shortcut-kept-installer-target' $false '开始菜单快捷方式不存在'
  }

  Write-Host 'TASKBAR-LOG:'
  Get-Content (Join-Path $env:TEMP 'lumin-taskbar.log') -ErrorAction SilentlyContinue | Where-Object { $_ -match 'shortcut|aumid' } | ForEach-Object { Write-Host ('  ' + $_) }

  # ── 5) 静默卸载 ──
  $un = Join-Path $installDir 'Uninstall Lumin.exe'
  $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
  $p2 = Start-Process -FilePath $un -ArgumentList '/currentuser', '/S' -PassThru -Wait
  $sw2.Stop()
  Start-Sleep -Seconds 3
  $installed = $false
  C 'uninstall-exit-0' ($p2.ExitCode -eq 0) "exit=$($p2.ExitCode) 耗时=$([math]::Round($sw2.Elapsed.TotalSeconds,1))s"

  # ── 6) 卸载后的清理（P1 的核心断言）──
  C 'install-dir-removed' (-not (Test-Path $installDir)) "残留文件数=$((Get-ChildItem $installDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count)"
  C 'shortcuts-removed' ((-not (Test-Path $startMenuLnk)) -and (-not (Test-Path $desktopLnk))) "start=$((Test-Path $startMenuLnk)) desktop=$((Test-Path $desktopLnk))"
  C 'progid-removed' (-not (Test-Path 'HKCU:\Software\Classes\Markdown')) 'HKCU\Software\Classes\Markdown'
  $afterMd = RegDefault 'HKCU:\Software\Classes\.md'
  $afterMarkdown = RegDefault 'HKCU:\Software\Classes\.markdown'
  C 'md-default-value-cleared' (-not $afterMd) ".md='$afterMd'（修复前是 Markdown）"
  C 'markdown-default-value-cleared' (-not $afterMarkdown) ".markdown='$afterMarkdown'"
  C 'uninstall-entry-removed' (-not (Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like '*Lumin*' })) '无 Lumin 卸载项'
  $after = UserDataCounts
  C 'user-data-untouched' (($after.files -eq $base.files) -and ($after.drafts -eq $base.drafts)) "before=$($base.files)/$($base.drafts) after=$($after.files)/$($after.drafts)"
} finally {
  # ── 收尾：保证不留下已安装状态、不留测试痕迹，并复原开发者原有桌面快捷方式 ──
  Stop-Process -Name Lumin -Force -ErrorAction SilentlyContinue
  if ($installed -and (Test-Path (Join-Path $installDir 'Uninstall Lumin.exe'))) {
    Start-Process -FilePath (Join-Path $installDir 'Uninstall Lumin.exe') -ArgumentList '/currentuser', '/S' -Wait -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }
  Remove-Item $testProfile -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $fixtureDir -Recurse -Force -ErrorAction SilentlyContinue
  # 桌面上原有的 Lumin.lnk 指向项目文件夹，会被安装器覆盖并在卸载时删除 —— 按原样重建
  $d = $sh.CreateShortcut($desktopLnk)
  $d.TargetPath = $repo
  $d.WorkingDirectory = $repo
  $d.Description = 'Lumin 项目文件夹'
  $d.Save()
  # 兜底：万一卸载器没清干净扩展名默认值，这里手工清（并把结果标注出来）
  foreach ($ext in 'md', 'markdown') {
    $v = RegDefault "HKCU:\Software\Classes\.$ext"
    if ($v) {
      & reg.exe delete "HKCU\Software\Classes\.$ext" /ve /f | Out-Null
      Write-Host "CLEANUP 手工清除了 .$ext 的残留默认值 '$v'（说明修复未生效！）"
    }
  }
}

Write-Host ''
$results | ForEach-Object { Write-Host $_ }
$failed = @($results | Where-Object { $_ -like 'FAIL*' }).Count
Write-Host "--- $($results.Count - $failed)/$($results.Count) PASS"
if ($failed -gt 0) { exit 1 }
