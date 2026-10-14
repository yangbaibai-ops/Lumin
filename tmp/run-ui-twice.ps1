# 两次「干净新实例 + _verify-image-ui.js」：userData 名不含 lumin，端口 9357/9358
$ErrorActionPreference = 'Continue'
Set-Location 'D:\code_workspace\Lumin'
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Run-One([string]$ud, [int]$port, [string]$out) {
  Write-Host "=== RUN ud=$ud port=$port start=$(Get-Date -Format HH:mm:ss) ==="
  & powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-isolated.ps1 -UserData $ud -Port $port 2>&1 | Select-Object -Last 2
  $env:LUMIN_DEBUG_PORT = "$port"
  node tools\_verify-image-ui.js *> $out
  $code = $LASTEXITCODE
  Write-Host "=== RUN ud=$ud exit=$code ==="
  Get-Content $out -Tail 3
  & powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-isolated.ps1 -UserData $ud -Port $port -CleanupOnly 2>&1 | Select-Object -Last 1
  Start-Sleep -Seconds 3
}

Run-One "$env:TEMP\xw-ui1-ud" 9357 'tmp\ui-suite-run1.log'
Run-One "$env:TEMP\xw-ui2-ud" 9358 'tmp\ui-suite-run2.log'
Write-Host '=== BOTH RUNS DONE ==='
