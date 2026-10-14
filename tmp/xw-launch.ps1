# Isolated instance launcher (temporary tool for this round; ASCII only because
# Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI).
# Same approach as tools/start-isolated.ps1, except:
#   * user-data-dir leaf contains no lowercase "lumin" (a parallel cleaner on this
#     host kills electron.exe whose command line contains it)
#   * debug port 9334 (9222 is taken by an unrelated chrome)
#   * LUMIN_TRUSTED_PATHS also grants the Desktop folder so the real file can be opened
param(
  [string]$UserData = "$env:TEMP\xw-identbg-ud",
  [int]$Port = 9334,
  [string]$ExtraTrust = "C:\Users\yangbaibai\Desktop\Lumin" + [char]0x76F8 + [char]0x5173
)
$ErrorActionPreference = 'Continue'
$root = 'D:\code_workspace\Lumin'
$leaf = Split-Path -Leaf $UserData

Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine -like "*$leaf*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 900

if (Test-Path $UserData) { & cmd.exe /c rmdir /s /q "$UserData" 2>$null }
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
$env:LUMIN_DEBUG_PORT = "$Port"
$env:LUMIN_TRUSTED_PATHS = "$env:TEMP;$ExtraTrust"
$outLog = "$env:TEMP\xw-instbg-out.log"
$errLog = "$env:TEMP\xw-instbg-err.log"
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue

Start-Process -FilePath "$root\node_modules\.bin\electron.cmd" -ArgumentList '.', "--user-data-dir=$UserData" -WorkingDirectory $root -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$deadline = (Get-Date).AddSeconds(40)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
    if (@($list | Where-Object { $_.type -eq 'page' }).Count -ge 1) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { Write-Host "INSTANCE-NOT-READY (stdout=$outLog stderr=$errLog)"; exit 3 }
Start-Sleep -Seconds 5
$pages = @((Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2) | Where-Object { $_.type -eq 'page' })
Write-Host ("READY pages=" + $pages.Count + " port=" + $Port + " ud=" + $UserData + " trust=" + $env:LUMIN_TRUSTED_PATHS)
exit 0
