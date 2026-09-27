// ─── 真打印机打印：选项映射 + 结果归类（纯函数，零依赖）───────────────────────
//
// 审计 §7 第 18 条把「打印」判成半成品：PDF 导出有页码 / 页眉页脚 / 分页规则，
// 但**真打印机**没有入口（`webContents.print(` 全仓 0 命中）。补齐这条能力时，
// 唯一能自动验证的就是本模块的两条映射 —— 真正的打印要弹系统对话框、要有一台真打印机，
// CI 与开发机上跑不了（见交付报告「未验证的部分」）：
//
//   1. `buildPrintOptions`：把设置里的 PDF 页面尺寸 / 边距（毫米）映射成
//      `webContents.print()` 的选项（`A4`/`A5`/`Letter` 同名直通，边距换算成像素）；
//   2. `classifyPrintResult`：把 Chromium 回调的 `(success, failureReason)` 归类成
//      `ok` / `cancelled` / `failed` —— **用户取消是正常路径**，不能报成错误，
//      而 `failureReason` 必须原样透传给用户（不能替换成一句笼统的"打印失败"）。
//
// 与 `renderer/src/lib/exportPayload.ts` 同一个套路：本模块**零依赖**（不 import types，
// 免得 shared/types 与本模块互相引用），可以被主进程、渲染层与 node:test 直接 import。
// 页边距的单位换算说明见 `mmToCssPx`。

/** 与 `AppSettings['export']['pdf']['pageSize']` 的字面量集合一致（刻意不 import） */
export type PrintPageSize = 'A4' | 'A5' | 'Letter'

export interface PrintOptionsInput {
  /**
   * 系统打印机的**设备名**（Electron 的 `deviceName`，形如 `Brother_QL_820NWB`，
   * 不是界面上那个友好名）。只有 `silent: true` 的静默打印会真的用到它：本应用走
   * 系统打印对话框（`silent: false`），打印机由用户在对话框里选 —— 这个参数留着是为了
   * 「以后加静默打印」时不改签名，也让单测能钉住"空设备名不该出现在选项里"。
   */
  deviceName?: string
  pageSize: PrintPageSize
  /** 页边距，单位**毫米**（与设置里那个 PDF 边距同一个值，默认 24mm） */
  margins: number
}

/** `webContents.print()` 的选项子集（字段名与 Electron 的 `WebContentsPrintOptions` 一致） */
export interface PrintOptions {
  /** 永远 false：弹系统打印对话框，让用户选打印机 / 份数 / 页面范围 / 纸张 */
  silent: false
  /** 正文里有代码块底色、表格表头底色、图片：不打背景等于把这些都丢掉 */
  printBackground: true
  pageSize: PrintPageSize
  /** 只有 `marginType: 'custom'` 才会读 top/bottom/left/right（Electron 的约定） */
  margins: { marginType: 'custom'; top: number; bottom: number; left: number; right: number }
  /** 只在给了**非空**设备名时带上这个键：空串在 Electron 里等于"没指定" */
  deviceName?: string
}

/** CSS 参考像素 / 英寸（96dpi） */
const CSS_PX_PER_INCH = 96
const MM_PER_INCH = 25.4

/**
 * 毫米 → 像素。
 *
 * 为什么是 96dpi 而不是打印机的物理 dpi：Electron 把 `print()` 的 margins 记作
 * 「pixels」（见 electron.d.ts 的 `Margins`），Chromium 内部按 CSS 参考像素处理；
 * 用 96dpi 换算至少与页面自己的 CSS 尺度自洽（20mm ≈ 76px）。
 *
 * ⚠️ **未在真机上验证**：`silent: false` 时最终边距由系统打印对话框里的设置决定，
 * 这里给的是初始值。真机验收时要确认「设置 → 导出 → 页边距 24mm」与打印结果的
 * 上下左右留白大致相符（见交付报告）。
 */
export function mmToCssPx(mm: number): number {
  return Math.round((mm * CSS_PX_PER_INCH) / MM_PER_INCH)
}

/**
 * 设置的 PDF 页面尺寸 + 边距 → `webContents.print()` 选项。
 *
 * 非有限值 / 负数的边距一律按 0 处理（不让 IPC 那头的坏值变成 Electron 的崩溃面）。
 */
export function buildPrintOptions(input: PrintOptionsInput): PrintOptions {
  const mm = Number.isFinite(input.margins) ? Math.max(0, input.margins) : 0
  const px = mmToCssPx(mm)
  const options: PrintOptions = {
    silent: false,
    printBackground: true,
    pageSize: input.pageSize,
    margins: { marginType: 'custom', top: px, bottom: px, left: px, right: px }
  }
  const deviceName = input.deviceName?.trim()
  if (deviceName) options.deviceName = deviceName
  return options
}

/** 打印结果三态：`ok` 已交给打印机 / `cancelled` 用户在对话框里取消 / `failed` 真失败 */
export type PrintOutcome = 'ok' | 'cancelled' | 'failed'

export interface PrintResult {
  status: PrintOutcome
  /**
   * Chromium 回报的失败原因，**原样透传**（`ok` 时归一成空串）。
   * 已知取值见 electron.d.ts：`Invalid printer settings` / `Print job canceled` /
   * `Print job failed`。这里不做翻译：它是诊断信息，渲染层按需展示。
   */
  failureReason: string
}

/**
 * 取消的判定：Chromium 报的是 `Print job canceled`（美式拼写），但不同平台 / 版本可能给
 * `cancelled`；用户取消与"没装打印机"必须区分开 —— 前者是正常路径，弹错误通知是错的。
 */
const CANCEL_PATTERN = /cancel/i

/**
 * `webContents.print()` 回调 → 可读结果。
 *
 * 注意 `success === false && failureReason === ''` 的情况：Chromium 文档里列出的失败原因
 * 都不是空串，所以空原因归到 `failed`（如实回报 > 猜成取消），渲染层会补一句
 * 「打印系统没有给出失败原因」而不是显示一条空通知。
 */
export function classifyPrintResult(success: boolean, failureReason?: string | null): PrintResult {
  if (success) return { status: 'ok', failureReason: '' }
  const reason = (failureReason ?? '').trim()
  return { status: CANCEL_PATTERN.test(reason) ? 'cancelled' : 'failed', failureReason: reason }
}
