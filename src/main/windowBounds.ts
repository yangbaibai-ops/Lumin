// ─── 窗口尺寸的**纯几何规则**（默认尺寸 / 恢复夹取 / 跨 DPI 保持 DIP 尺寸）──
//
// 为什么单独一个文件：这三条都是"用户一眼能看见、但只在特定屏幕配置下才出问题"的判定，
// 埋在 `main/index.ts` 的启动编排里就只能靠人工换显示器验证。做成不 import electron 的
// 纯函数之后，可以用「模拟显示器数组」在 `node --test` 里直接跑（tests/windowBounds.test.mjs）。
//
// 口径（Electron）：
//   * `screen.getAllDisplays()` 的 `bounds` / `workArea`、`BrowserWindow.getBounds()` 都是
//     **DIP**（设备无关像素），不是物理像素；4K@200% 的 workArea 是 1920×1080 左右；
//   * `workArea` 已经扣掉任务栏/停靠栏，默认尺寸只需要在工作区里居中，不要铺满；
//   * 跨显示器拖动时，Windows/Chromium 可能按"物理尺寸不变"重算 DIP 尺寸（于是窗口突然
//     变大/变小）。`preserveDipSize` 的任务是**恢复原来的 DIP 尺寸**，只把坐标夹进新工作区。
//
// ⚠️ 这里不 import electron：显示器枚举与 `setBounds` 留在主进程接线层
// （src/main/windowBoundsGuard.ts），纯函数才能被单测直接覆盖。

import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, type Rect } from './windowPlacement'

export type { Rect }

/** 宽高（最小尺寸、稳定尺寸都用它） */
export interface Size {
  width: number
  height: number
}

/** 默认窗口尺寸的目标比例：工作区的 78% × 82%（左右留白、上下留标题栏与任务栏） */
export const DEFAULT_WIDTH_RATIO = 0.78
export const DEFAULT_HEIGHT_RATIO = 0.82
/** 默认尺寸的下限：再小的屏幕上宁可贴边，也不要小到编辑区不可用 */
export const DEFAULT_MIN_WIDTH = 1100
export const DEFAULT_MIN_HEIGHT = 720
/** 默认尺寸的上限：大屏上不要铺满（留出桌面与其它窗口） */
export const DEFAULT_MAX_WIDTH = 1800
export const DEFAULT_MAX_HEIGHT = 1150

/** 与 windowPlacement.ts 同源的最小窗口尺寸（BrowserWindow 的 minWidth/minHeight） */
export const MIN_WINDOW_SIZE: Size = {
  width: MIN_WINDOW_WIDTH,
  height: MIN_WINDOW_HEIGHT
}

export interface DefaultBoundsOptions {
  /** 最小窗口尺寸（默认 760×520） */
  minSize?: Size
  /** 目标比例（默认 0.78 / 0.82；单测可覆盖） */
  widthRatio?: number
  heightRatio?: number
  /** 目标区间的下限（默认 1100×720） */
  minWidth?: number
  minHeight?: number
  /** 目标区间的上限（默认 1800×1150） */
  maxWidth?: number
  maxHeight?: number
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** 工作区矩形是否可用（拿不到显示器时退回一个保守的 1280×720） */
function safeWorkArea(workArea: Rect): Rect {
  if (
    isFiniteNumber(workArea?.x) &&
    isFiniteNumber(workArea?.y) &&
    isFiniteNumber(workArea?.width) &&
    isFiniteNumber(workArea?.height) &&
    workArea.width > 0 &&
    workArea.height > 0
  ) {
    return workArea
  }
  return { x: 0, y: 0, width: 1280, height: 720 }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/**
 * 默认窗口尺寸：按当前显示器工作区自适应，并居中。
 *
 * 规则（纯函数，验收表格见 tests/windowBounds.test.mjs）：
 *   1. 宽 = clamp(round(workArea.width * 0.78), 1100, 1800)
 *      高 = clamp(round(workArea.height * 0.82), 720, 1150)
 *   2. **不超过工作区**（任务栏窄/小屏时以工作区为准）——
 *      1366×768@100%（工作区 1366×728）⇒ 1100×720；4K@200% 的 DIP 工作区仍是
 *      1920×1080 左右 ⇒ 1498×853（物理像素大不等于 DIP 大，4K@100% 才会顶到 1800×1150）
 *   3. 居中：x = workArea.x + round((workArea.width - width) / 2)，y 同理
 *
 * “不低于最小尺寸”与“不超过工作区”在极小工作区上会冲突（例如 1366×768@150% 只有
 * 911×512 DIP）——这里**以不越界优先**，否则窗口必然伸到屏幕外，右侧按钮永远够不着。
 */
export function computeDefaultBounds(workArea: Rect, opts: DefaultBoundsOptions = {}): Rect {
  const wa = safeWorkArea(workArea)
  const min = opts.minSize ?? MIN_WINDOW_SIZE
  const widthRatio = isFiniteNumber(opts.widthRatio) ? opts.widthRatio : DEFAULT_WIDTH_RATIO
  const heightRatio = isFiniteNumber(opts.heightRatio) ? opts.heightRatio : DEFAULT_HEIGHT_RATIO
  const floorWidth = opts.minWidth ?? DEFAULT_MIN_WIDTH
  const floorHeight = opts.minHeight ?? DEFAULT_MIN_HEIGHT
  const capWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH
  const capHeight = opts.maxHeight ?? DEFAULT_MAX_HEIGHT

  // 先按比例取整，再夹到 [下限, 上限]；最后用工作区尺寸兜底（小屏时下限也放不下）
  const idealWidth = clamp(Math.round(wa.width * widthRatio), floorWidth, capWidth)
  const idealHeight = clamp(Math.round(wa.height * heightRatio), floorHeight, capHeight)
  const width = Math.min(wa.width, Math.max(idealWidth, Math.min(min.width, wa.width)))
  const height = Math.min(wa.height, Math.max(idealHeight, Math.min(min.height, wa.height)))

  return {
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height
  }
}

/**
 * 把一份 bounds 夹回指定工作区，并保证不小于最小窗口。
 *
 * 用于「恢复上次尺寸」：显示器被拔掉 / 分辨率变小 / 上次在 4K 上存的 1800×1150 现在
 * 落到 1366×768 上 —— 直接 setBounds 会让标题栏跑到屏幕外（用户以为程序没开）。
 *
 * 规则：
 *   * 宽/高小于最小尺寸 ⇒ 抬到最小尺寸（工作区比最小尺寸还小则服从工作区）；
 *   * 宽/高大于工作区 ⇒ 收到工作区；
 *   * x/y 夹进 [工作区起点, 工作区终点 - 窗口尺寸] ⇒ **标题栏（y 顶部）一定可见**。
 */
export function clampBoundsToWorkArea(bounds: Rect, workArea: Rect, minSize: Size): Rect {
  const wa = safeWorkArea(workArea)
  const min = minSize ?? MIN_WINDOW_SIZE
  if (
    !isFiniteNumber(bounds?.x) ||
    !isFiniteNumber(bounds?.y) ||
    !isFiniteNumber(bounds?.width) ||
    !isFiniteNumber(bounds?.height)
  ) {
    return computeDefaultBounds(wa, { minSize: min })
  }

  // 工作区小于最小窗口时，有效下限就是工作区本身（否则又会越界）
  const floorWidth = Math.min(wa.width, Math.max(1, Math.round(min.width)))
  const floorHeight = Math.min(wa.height, Math.max(1, Math.round(min.height)))
  const width = Math.min(wa.width, Math.max(Math.round(bounds.width), floorWidth))
  const height = Math.min(wa.height, Math.max(Math.round(bounds.height), floorHeight))

  const x = clamp(Math.round(bounds.x), wa.x, wa.x + wa.width - width)
  const y = clamp(Math.round(bounds.y), wa.y, wa.y + wa.height - height)
  return { x, y, width, height }
}

const safeScale = (scaleFactor: number): number =>
  isFiniteNumber(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1

/**
 * 跨 DPI 时保持 **DIP 尺寸不变**，只把位置换算/夹进新显示器工作区。
 *
 * 场景：用户把窗口从 100% 屏拖到 150% 屏。Windows 若按"物理尺寸不变"重算，窗口的 DIP
 * 尺寸会变成原来的 1/1.5（看着突然变小）；拖回来又突然变大。这里用**拖动前记录的 DIP
 * 尺寸**覆盖当前尺寸，宽度/高度保持不变（只在工作区更小时才缩小），坐标按比例换算后
 * 夹进新工作区 —— 这样跨屏前后窗口在系统里的逻辑大小一致。
 *
 * @param bounds 当前（新显示器坐标下的）bounds；宽度/高度应传**拖动前的稳定 DIP 尺寸**
 * @param prevScaleFactor 拖动前所在显示器的 scaleFactor
 * @param newScaleFactor 新显示器的 scaleFactor
 * @param workArea 新显示器的工作区（DIP）
 * @param minSize 最小窗口尺寸
 */
export function preserveDipSize(
  bounds: Rect,
  prevScaleFactor: number,
  newScaleFactor: number,
  workArea: Rect,
  minSize: Size
): Rect {
  const wa = safeWorkArea(workArea)
  const prev = safeScale(prevScaleFactor)
  const next = safeScale(newScaleFactor)
  const min = minSize ?? MIN_WINDOW_SIZE
  if (
    !isFiniteNumber(bounds?.x) ||
    !isFiniteNumber(bounds?.y) ||
    !isFiniteNumber(bounds?.width) ||
    !isFiniteNumber(bounds?.height)
  ) {
    return computeDefaultBounds(wa, { minSize: min })
  }

  const ratio = prev / next
  // 坐标换算以**新工作区左上角**为锚点：多屏时绝对坐标的原点各不相同，直接乘全局比例
  // 会把窗口甩到别的显示器上。
  const convertedX = wa.x + Math.round((bounds.x - wa.x) * ratio)
  const convertedY = wa.y + Math.round((bounds.y - wa.y) * ratio)
  const width = Math.round(bounds.width)
  const height = Math.round(bounds.height)
  const fitsX = (value: number): boolean => value >= wa.x && value <= wa.x + wa.width - width
  const fitsY = (value: number): boolean => value >= wa.y && value <= wa.y + wa.height - height

  // 换算后仍在工作区内就采用换算值；若换算把原本可见的窗口甩出去（常见于副屏原点
  // 与主屏不一致），保留当前坐标，交给 clamp 只做边界修正。
  const x = fitsX(convertedX) || !fitsX(bounds.x) ? convertedX : bounds.x
  const y = fitsY(convertedY) || !fitsY(bounds.y) ? convertedY : bounds.y

  return clampBoundsToWorkArea({ x, y, width, height }, wa, min)
}

/** 按显示器标识存窗口状态的 key：`display.id@scaleFactor`（A 屏的尺寸不会套到 B 屏） */
export function displayStateKey(display: { id: number; scaleFactor: number }): string {
  const id = isFiniteNumber(display?.id) ? display.id : -1
  const scale = Math.round(safeScale(display?.scaleFactor) * 100) / 100
  return `${id}@${scale}`
}

/** 两个矩形是否几乎相同（容差 1px）：用于防止 setBounds 触发的回环纠正 */
export function rectsClose(a: Rect, b: Rect, tolerance = 1): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}
