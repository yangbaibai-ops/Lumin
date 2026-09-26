// ─── 窗口位置/尺寸的**纯规则**（从 main/index.ts 抽出来，审计 §6 P2「大文件与职责混杂」）──
//
// 为什么值得单独一个文件：`main/index.ts` 是 644 行的启动编排（单实例、会话恢复、协议、菜单、
// 生命周期……），里面混着两条**用户看得见、却没人测**的判定：
//   ① **窗口不要恢复到屏幕外**：显示器拆掉/换分辨率/笔记本外接屏拔掉之后，
//      上次保存的坐标可能落在任何显示器的工作区之外 —— 恢复上去就是"打开程序没窗口"；
//   ② **小于最小尺寸的记录不采用**（`minWidth/minHeight` 是 940×600），否则窗口一起来就被夹，
//      用户看到的是一个"每次都变位置"的窗口。
// 两条都是纯几何，抽出来后可以用假显示器阵列直接算 —— 不必起 Electron。
//
// ⚠️ 这里**不 import electron**：显示器的枚举（`screen.getAllDisplays()`）留在 index.ts，
// 传进来的只是工作区矩形数组。纯函数 → `node --test` 直接跑（tests/windowPlacement.test.mjs）。

/** 一个矩形（窗口 bounds 或显示器工作区都用它） */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口的最小尺寸（与 `BrowserWindow` 的 minWidth/minHeight 同源：见 index.ts 的 createWindow） */
export const MIN_WINDOW_WIDTH = 940
export const MIN_WINDOW_HEIGHT = 600

/**
 * 矩形是否与任一工作区**相交**（哪怕只露出一角）。
 *
 * 判定用严格不等号：只在边上"贴住"（`s.x + s.width === a.x`）不算相交 ——
 * 那种情况下窗口一个像素都看不到，恢复上去等于没开。
 */
export function intersectsAnyWorkArea(rect: Rect, areas: readonly Rect[]): boolean {
  return areas.some(
    (a) =>
      rect.x < a.x + a.width &&
      rect.x + rect.width > a.x &&
      rect.y < a.y + a.height &&
      rect.y + rect.height > a.y
  )
}

/** 保存过的窗口记录（`isMaximized` 只是"还原时要不要最大化"，不参与位置判定） */
export interface SavedWindow extends Rect {
  isMaximized: boolean
}

/**
 * 这份保存记录还能不能用：尺寸不小于最小窗口，且与某个显示器工作区相交。
 * `areas` 为空（拿不到显示器，理论上不该发生）时按"不能用"处理 —— 退回默认尺寸比恢复到屏幕外安全。
 */
export function canRestoreWindow(
  saved: SavedWindow | null | undefined,
  areas: readonly Rect[],
  min: { width: number; height: number } = { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT }
): boolean {
  if (!saved) return false
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return false
  if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return false
  if (saved.width < min.width || saved.height < min.height) return false
  return intersectsAnyWorkArea(saved, areas)
}

/**
 * 关窗时该往 kv 里写什么。
 *
 * **为什么不是"直接存 getBounds()"**：最大化状态下 `getBounds()` 给的是**被撑满的屏幕矩形**，
 * 存下来之后下次先按这个大尺寸建窗（用户会看到窗口"从全屏缩回"的一下），再叠加 `isMaximized`
 * → 两步跳变。Electron 为此给了 `getNormalBounds()`：它返回"如果现在还原，会回到的那个矩形"。
 * 所以规则是：**最大化时存 normalBounds，非最大化时存 bounds**；`isMaximized` 单独记，
 * 供下次还原后决定要不要再最大化。
 *
 * 纯函数（调用方把两个矩形取好传进来）—— 这条规则此前埋在 `saveWindowState` 里没人测。
 */
export function windowStateFor(input: {
  bounds: Rect
  normalBounds: Rect
  isMaximized: boolean
}): SavedWindow {
  const b = input.isMaximized ? input.normalBounds : input.bounds
  return { x: b.x, y: b.y, width: b.width, height: b.height, isMaximized: input.isMaximized }
}
