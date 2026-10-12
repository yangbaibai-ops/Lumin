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
 * 选区是否**完全盖住**标识符范围且**至少一端严格超出** —— 也就是"标识符该隐藏"的那一档。
 * 第九十三轮起它**还兼任**"这张图片算被选中"的判据（用户口径：标识符不显示时图片要是选中态），
 * 所以单独抽出来当**唯一判据**用，避免两处各写一套（`revealDecision` 也调它）。
 */
export function selectionCoversSource(sel: RevealSel, img: RevealRange): boolean {
  if (sel.empty) return false
  const covers = sel.from <= img.from && sel.to >= img.to
  const strictlyBeyond = sel.from < img.from || sel.to > img.to
  return covers && strictlyBeyond
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
export function revealDecision(
  sel: RevealSel,
  img: RevealRange,
  opts?: { dragging?: boolean; dragInsideFrom?: number | null }
): 'show' | 'hide' {
  /**
   * 第一百零四轮（**DOM 身份快照**，不碰坐标）：两条既有契约并存，靠"**这次拖动的起点是不是落在这段
   * 源码文本里**"分流 —— `mousedown` 时用 `event.target.closest('[data-img-revealed]')` 取它的
   * `data-img-from`（正文里按下 ⇒ `null`）：
   *   * `dragging && dragInsideFrom === img.from`（在标识符文本上按下）⇒ 一律 `show`
   *     ⇒ 用户能把选区**拖满整个源码**，松手时才按口径隐藏（同时让图片显示为选中 `img-selected`）；
   *   * 其它情况（在正文/别处按下，或记录为空）⇒ 一律 `hide`
   *     —— 第七十五轮防闪口径（㉑①/㉑②）：**即使此时标识符因别的交互已处于显示态**，拖动中也不显示；
   *   * 未拖动 ⇒ 既有口径不变（"覆盖（至少一端超出）"⇒ hide；被包含/恰好等于 ⇒ show）。
   * 纯函数：两档入参由调用方传入 ⇒ 单测覆盖三档。
   */
  if (opts?.dragging) {
    if (opts.dragInsideFrom == null || opts.dragInsideFrom !== img.from) return 'hide'
    const touches = sel.from <= img.to && sel.to >= img.from
    return touches ? 'show' : 'hide'
  }
  if (sel.nodeSel && sel.from === img.from) return 'show'
  if (!sel.empty) {
    // 口径 4（盖住且至少一端超出）⇒ 隐藏；口径 2/3（被包含或恰好等于）⇒ 显示
    if (selectionCoversSource(sel, img)) return 'hide'
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
