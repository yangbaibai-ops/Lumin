// ─── 「导出启动诊断」的**唯一实现**（设置页 / 帮助菜单 / 状态栏三处共用）──────────────
//
// 背景（用户报「装完启动 5–6 秒」）：我们需要用户机上的分段数据。入口越多越容易拿到，
// 但实现只能有一份 —— 三处各写一次 toast/错误处理，迟早出现「一个入口导出的文件不一样」
// 或「一处失败静默、一处弹错」。
//
// 分工：
//   * 主进程 `app:exportStartupDiagnostics`：弹保存对话框、写文件（`startup.log` 已脱敏，
//     见 shared/startupLog.ts）；自动化验收用 `LUMIN_STARTUP_EXPORT_PATH` 跳过对话框。
//   * 这里：调 IPC + 统一的成功/失败提示。
import i18n from '../i18n'
import { useUiStore } from '../stores/ui'

export type StartupExportResult =
  | { ok: true; path: string; lines: number; bytes: number }
  | { ok: false; canceled?: boolean; error?: string }

/** 导出启动诊断（用户取消保存对话框时不提示错误） */
export async function exportStartupDiagnostics(): Promise<StartupExportResult> {
  const ui = useUiStore()
  const t = i18n.global.t
  try {
    const result = await window.luminAPI.app.exportStartupDiagnostics()
    if (result.ok) {
      ui.toast(
        t('settings.startupDiagnosticsSaved', { path: result.path, lines: result.lines }),
        'success'
      )
    } else if (!result.canceled) {
      ui.toast(t('settings.startupDiagnosticsFailed'), 'error')
    }
    return result
  } catch {
    ui.toast(t('settings.startupDiagnosticsFailed'), 'error')
    return { ok: false, error: 'IPC_FAILED' }
  }
}
