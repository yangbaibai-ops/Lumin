// ─── 启动骨架的移除（#boot-splash 由 index.html 内联，不依赖本模块才能显示）─────────────
//
// 分工：
//   * `index.html` 负责「**在任何 JS 之前**画出来」：纯 HTML + 内联 CSS + data URI 图标；
//   * 本模块负责「什么时候撤」：
//       - `armBootSplashDeadline()` 在入口模块一开始就调用 —— 1500ms 兜底，防止后面
//         `settings.init()` / 会话恢复抛错时骨架永远挡住界面；
//       - `dismissBootSplash()` 在 Vue **挂载并真的出了一帧之后**调用 —— 再等
//         `document.fonts.ready`（避免字体替换时抖一下）+ 双 `requestAnimationFrame`（确保
//         新界面已经进合成器），然后加 `data-state=hidden` 走 200ms opacity 过渡，最后移除节点。
//
// 为什么要双 rAF 而不是 `nextTick`：`nextTick` 只保证 DOM 建好，不保证**绘制**；在慢机器上
// 两者能差一帧以上。骨架是「盖在界面上」的一层，早撤一帧就会露出还没画完的空白。
//
// 人为慢渲染（`LUMIN_BOOT_DELAY_MS`，见 main/index.ts 与 preload）：延迟发生在 `main.ts`
// 的 bootstrap 里，本模块的兜底时限会**加上同样的延迟**，否则 1500ms 到点就把骨架撤了，
// 恰好把「慢渲染时骨架必须一直可见」这条验收变成假的。

/** 骨架节点 id（index.html 与测试共用） */
export const BOOT_SPLASH_ID = 'boot-splash'
/** 淡出时长，必须与 index.html 的 `transition: opacity 200ms` 一致 */
export const BOOT_SPLASH_FADE_MS = 200
/** 强制移除上限：无论渲染层卡在哪一步，1.5s 后都不能再挡住界面 */
export const BOOT_SPLASH_MAX_WAIT_MS = 1500

/**
 * 兜底时限 = 1500ms + 人为慢渲染延迟。
 * 纯函数（有单测）：负数/NaN 一律按 0 处理，避免配置写错把上限变成负数（setTimeout 会当 0，
 * 等于立刻撤掉骨架 —— 那正是白屏）。
 */
export function bootSplashDeadline(delayMs = 0): number {
  const extra = Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0
  return BOOT_SPLASH_MAX_WAIT_MS + extra
}

function splashElement(): HTMLElement | null {
  try {
    return document.getElementById(BOOT_SPLASH_ID)
  } catch {
    return null
  }
}

/** 幂等：先淡出（CSS transition），200ms 后移除节点 */
function hideSplash(el: HTMLElement): void {
  if (el.dataset.state === 'hidden') return
  el.dataset.state = 'hidden'
  window.setTimeout(() => el.remove(), BOOT_SPLASH_FADE_MS)
}

/**
 * 装兜底定时器（入口模块一开头调用）。没有骨架节点时什么都不做 —— 方便单测/异常页面。
 */
export function armBootSplashDeadline(delayMs = 0): void {
  const el = splashElement()
  if (!el) return
  window.setTimeout(() => hideSplash(el), bootSplashDeadline(delayMs))
}

/**
 * Vue 首帧后撤骨架。
 *
 * 顺序：`document.fonts.ready` → rAF → rAF → 淡出。`fonts.ready` 用 then 的两个分支接住，
 * 不让字体加载失败把骨架永远留在屏幕上。
 */
export function dismissBootSplash(): void {
  const el = splashElement()
  if (!el) return
  const drawFrame = (): void => {
    requestAnimationFrame(() => requestAnimationFrame(() => hideSplash(el)))
  }
  const fonts = document.fonts
  if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
    void fonts.ready.then(drawFrame, drawFrame)
  } else {
    drawFrame()
  }
}
