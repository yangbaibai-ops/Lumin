# Bring the isolated Lumin window to top (once) so Chromium keeps drawing frames.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/perf/raise-window.ps1 -Leaf xw-perf-ud
param([string]$Leaf = 'xw-perf-ud')
$ErrorActionPreference = 'Continue'
Add-Type -Namespace PerfWT -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
'@
$cands = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*$Leaf*" -and $_.CommandLine -notlike '*--type=*' }
$proc = $null
foreach ($c in $cands) {
  $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { $proc = $p; break }
}
if (-not $proc) { Write-Host 'NO-WINDOW'; exit 1 }
$h = $proc.MainWindowHandle
if ([PerfWT.U]::IsIconic($h)) { [void][PerfWT.U]::ShowWindow($h, 9); Start-Sleep -Milliseconds 300 }
# -1 = HWND_TOPMOST; SWP_NOSIZE|SWP_NOMOVE|SWP_SHOWWINDOW
[void][PerfWT.U]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0002 -bor 0x0001 -bor 0x0040)
Start-Sleep -Milliseconds 350
Write-Host ("pid=" + $proc.Id + " hwnd=" + $h + " topmost=True iconic=" + [PerfWT.U]::IsIconic($h))
