# tools/fg-run.ps1 <node-script> [args...] - foreground Electron, then run a node script.
param([Parameter(Mandatory=$true)][string]$Script, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinFgR {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@ -ErrorAction Stop
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Host 'NO_ELECTRON_WINDOW'; exit 3 }
[WinFgR]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 300
[WinFgR]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
& node $Script @Rest
exit $LASTEXITCODE
