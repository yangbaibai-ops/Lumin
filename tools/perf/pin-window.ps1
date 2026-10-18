# Keep the isolated window at the top of the topmost band while it is being measured.
# Why: Chromium stops rAF for occluded windows in some environments; a one-shot
# SetWindowPos can be overtaken by another always-on-top window (parallel test runs).
param([string]$Leaf = 'xw-perf-ud', [string]$StopFile = '')
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace PerfPin -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
'@
while ($true) {
  if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
  $cands = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*$Leaf*" -and $_.CommandLine -notlike '*--type=*' }
  foreach ($c in $cands) {
    $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $h = $p.MainWindowHandle
    if ($h -eq 0) { continue }
    if ([PerfPin.U]::IsIconic($h)) { [void][PerfPin.U]::ShowWindow($h, 9) }
    # HWND_TOPMOST + SWP_NOSIZE|SWP_NOMOVE|SWP_SHOWWINDOW
    [void][PerfPin.U]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0002 -bor 0x0001 -bor 0x0040)
  }
  Start-Sleep -Milliseconds 700
}
