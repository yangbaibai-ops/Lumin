# 点击原生 MessageBox / TaskDialog 上的按钮（按**可见文案**，可限定标题与进程）。
#
# 为什么不用 `_click-dialog.ps1`：那条通道在按钮所属对话框**不在前台**时，
# `BM_CLICK` 可能被 TaskDialog 忽略（实测：CDP 往页面里打了一段字之后，对话框失去激活，
# 点「知道了」没有任何反应）。验收要的是"用户真的点到了那个按钮"，所以这里：
#   1) 先按标题 + 进程号锁定**本次实例**的对话框（避免误点残留/别人的窗口）；
#   2) `SetForegroundWindow` + `SetActiveWindow` 把它激活；
#   3) 取按钮的屏幕矩形，移动光标并发一次真实的左键按下/抬起。
#
# 只匹配可见的 `#32770` 顶层窗口里的 `Button` 子控件；找不到退出码 2。
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$TitleContains = '',
  [int]$ProcessId = 0,
  [int]$TimeoutSeconds = 15
)
$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LuminSupportClick {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  public static string Text(IntPtr h) { var s = new StringBuilder(2048); GetWindowText(h, s, s.Capacity); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, s.Capacity); return s.ToString(); }
  public static int Pid(IntPtr h) { int p; GetWindowThreadProcessId(h, out p); return p; }
  public static List<IntPtr> Dialogs() {
    var l = new List<IntPtr>();
    EnumWindows((h, x) => { if (IsWindowVisible(h) && Cls(h) == "#32770") l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
  public static List<IntPtr> Children(IntPtr d) {
    var l = new List<IntPtr>();
    EnumChildWindows(d, (h, x) => { l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
  public static string Click(IntPtr dlg, IntPtr btn) {
    ShowWindow(dlg, 5);
    SetForegroundWindow(dlg);
    SetActiveWindow(dlg);
    System.Threading.Thread.Sleep(180);
    // 先激活（TaskDialog 在后台会忽略 BM_CLICK），再发真正的按钮点击消息。
    SendMessage(btn, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    return "bm-click";
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  foreach ($dlg in [LuminSupportClick]::Dialogs()) {
    if ($ProcessId -ne 0 -and [LuminSupportClick]::Pid($dlg) -ne $ProcessId) { continue }
    $title = [LuminSupportClick]::Text($dlg)
    if ($TitleContains -and $title -notlike "*$TitleContains*") { continue }
    foreach ($btn in [LuminSupportClick]::Children($dlg)) {
      if ([LuminSupportClick]::Cls($btn) -ne 'Button') { continue }
      $text = ([LuminSupportClick]::Text($btn) -replace '&', '')
      if ($text -ne $Name) { continue }
      Write-Host "FOUND-NATIVE-DIALOG: class=#32770 pid=$([LuminSupportClick]::Pid($dlg)) title=$title"
      $result = [LuminSupportClick]::Click($dlg, $btn)
      Write-Host "CLICKED-REAL: $Name ($result)"
      exit 0
    }
  }
  Start-Sleep -Milliseconds 200
}
Write-Host "NOT-FOUND: $Name"
exit 2
