# 点击原生对话框上的按钮（按可见文案）。
#
# 为什么需要它：无响应/崩溃提示是 **Electron 主进程的原生** `dialog.showMessageBox`
# （异步、非阻塞主进程，但按钮不在 DOM 里，CDP 点不到）。端到端验收要分别走
# 「等待」与「重新加载并恢复」两条路，只能在这一层点。
#
# 两条通道：
#   1) UI Automation 按 Name + Button 找；
#   2) 退路：Win32 EnumWindows 找 `#32770` 对话框，EnumChildWindows 按按钮文案找，
#      发 BM_CLICK。Electron 39 的 MessageBox 在部分机器上不进 UIA 树（实测），
#      所以第 2 条不是可选项。
#
# 只匹配**可见顶层对话框**里的按钮；找不到退出码 2。
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$TimeoutSeconds = 15
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LuminDialog {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static List<IntPtr> Dialogs() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(64); GetClassName(h, cls, cls.Capacity);
      if (cls.ToString() == "#32770") list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Buttons(IntPtr dialog) {
    var list = new List<IntPtr>();
    EnumChildWindows(dialog, (h, l) => {
      var cls = new StringBuilder(64); GetClassName(h, cls, cls.Capacity);
      if (cls.ToString() == "Button") list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) {
    var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString();
  }
  public static bool Click(IntPtr h) { SendMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); return true; }
}
'@
Add-Type -TypeDefinition $code -Language CSharp

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  # 1) UI Automation
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $nameCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $typeCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $cond = New-Object System.Windows.Automation.AndCondition($nameCond, $typeCond)
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($el) {
    try {
      $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pattern.Invoke()
      Write-Host "CLICKED-UIA: $Name"
      exit 0
    } catch {
      Write-Host "UIA-FOUND-NOT-INVOKABLE: $Name"
    }
  }

  # 2) Win32 dialog fallback
  foreach ($dlg in [LuminDialog]::Dialogs()) {
    # 取证：Electron 的原生 MessageBox 是标准 `#32770` 窗口（验收报告里要这个类名）
    Write-Host "FOUND-NATIVE-DIALOG: class=#32770 title=$([LuminDialog]::Text($dlg))"
    foreach ($btn in [LuminDialog]::Buttons($dlg)) {
      $text = [LuminDialog]::Text($btn)
      if (($text -replace '&', '') -eq $Name) {
        [void][LuminDialog]::Click($btn)
        Write-Host "CLICKED-WIN32: $Name"
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 300
}
Write-Host "NOT-FOUND: $Name"
exit 2
