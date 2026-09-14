# tools/run-verify.ps1 - foreground the Electron window, then run the CDP verification matrix.
# Windows PowerShell 5.1 compatible (ASCII only).
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinFgV {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@ -ErrorAction Stop

$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Host 'NO_ELECTRON_WINDOW'; exit 3 }
[WinFgV]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 300
[WinFgV]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 400

& node tools/verify-tiptap.js
exit $LASTEXITCODE
