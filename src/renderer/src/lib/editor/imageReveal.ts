/**
 * 图片这条线的**纯判据**（无 DOM、无 View、无副作用）—— 契约见 `docs/image-behavior.md` 第 3 节。
 *
 * 为什么单独一个文件：这些判据是"用户口径"的**唯一落点**，必须能被单测直接钉住
 * （`tests/imageReveal.test.mjs`）。`imageToolbar.ts` 只负责把它们接到 PM 的生命周期上，
 * 不再自己留一份 —— 早期"两套互相覆盖的条件"就是在同一个文件里长出来的。
 */

/** 一次"按下"的登记最多活多久（毫秒）。到期即视为已清理。 */
export const PENDING_TTL = 900

/** 选区快照（判据只认这四个数，不认 PM 的对象） */
export interface RevealSel {
  from: number
  to: number
  empty: boolean
  nodeSel: boolean
}

/** 标识符/图片源码的范围 */
export interface RevealRange {
  from: number
  to: number
}

/**
 * 标识符该显示还是隐藏（`docs/image-behavior.md` 第 3 节的表）：
 *   1) `NodeSelection` 正好盖住它 ⇒ 显示（点图片 = 选中这张图）；
 *   2) **空光标**与它有交集（含边界）⇒ 显示（点图片后光标落在 `from` 边界要能显示）；
 *   3) 非空选区**被它完全包含**（含恰好等于）⇒ 显示（"在标识符内部拖动 / 选中全部"）；
 *   4) 非空选区的**其它任何交集**（两端都超出、一端在外一端在内、由外侧拖入）⇒ 隐藏
 *      —— 用户第七十五轮口径：从别处拖动连续选文字时不许出现标识符（防闪烁）；
 *   5) 无交集 ⇒ 隐藏。
 */
export function revealDecision(sel: RevealSel, img: RevealRange): 'show' | 'hide' {
  if (sel.nodeSel && sel.from === img.from) return 'show'
  if (!sel.empty) {
    const contained = sel.from >= img.from && sel.to <= img.to
    return contained ? 'show' : 'hide'
  }
  const intersects = sel.from <= img.to && sel.to >= img.from
  return intersects ? 'show' : 'hide'
}

/**
 * 登记的"按下"是否已过期（第 9 节的自愈契约）。
 * `at` 是按下时刻的时间戳；`now` 默认取当前时间（便于单测注入）。
 */
export function isPendingExpired(at: number, now: number = Date.now()): boolean {
  return now - at > PENDING_TTL
}
