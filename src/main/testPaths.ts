// ─── 验收旁路：把"要弹原生对话框"的落点改成环境变量给的目录 ────────────────────
//
// 原生「另存为」对话框自动化取消不了，没有这条路，导出 / 备份这类功能就只能靠人眼看。
// 口径与 `LUMIN_TRUSTED_PATHS` 一致：**仅在非打包（开发态）实例上生效**，打包产物忽略。
//
// 单独成文件是因为导出（export.ts）与备份（services/*Backup.ts）都要用，
// 各写一份"读环境变量 + 判 isPackaged"迟早会漂。
import { app } from 'electron'

/** 旁路目标目录；null = 正常走对话框 */
export function testOutputDir(): string | null {
  const dir = process.env['LUMIN_EXPORT_DIR']
  return dir && !app.isPackaged ? dir : null
}

/**
 * 打印旁路：`LUMIN_PRINT_DRY_RUN=1` 时**只记账、不弹系统打印对话框**。
 *
 * 为什么需要：`webContents.print({ silent: false })` 弹的是原生对话框，自动化关不掉 ——
 * 「点打印真的走到了打印通路」这条断言否则只能靠人眼看。口径与前一个函数一致：
 * **仅在非打包（开发态）实例上生效**，打包产物忽略（发布版永远真的打印）。
 */
export function printDryRun(): boolean {
  return process.env['LUMIN_PRINT_DRY_RUN'] === '1' && !app.isPackaged
}
