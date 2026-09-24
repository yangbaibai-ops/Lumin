// ─── 滚动侦测：该点亮大纲/目录里的哪一条 ───────────────────────────────────────
//
// 判定「当前读到哪一节」的规则，**纯函数**（不碰 DOM，有单测 `tests/scrollSpy.test.mjs`）。
//
// 为什么单独抽出来：这条规则有两个边界，靠"读代码"很难确认，必须能被枚举用例钉住 ——
//   ① 常规规则：**判定线**（滚动容器上沿往下 `SCROLL_SPY_OFFSET_PX`）之上最后一个标题。
//   ② 末尾补偿（用户两轮报障的那条）：文档最后几节很短时，它们的标题**永远压不到判定线上**
//      —— 因为容器已经滚到底、滚不动了。没有补偿规则，这几节要么永远点不亮（旧行为：高亮停在
//      倒数第四），要么一到底就跳到最后一个（补丁式 bottom clamp：**跳过**中间那两节）。
//      这里改成**按剩余滚动距离等分**：从「最后一个能压线的标题」压线那一刻起，到滚到底为止，
//      这段距离平分给「它 + 后面那几个」，依次点亮，滚到底正好是最后一个。
//
// 坐标说明：输入是**当前滚动位置下**相对容器上沿的偏移；内部先换算成**文档坐标**
// （`文档位置 = 相对偏移 + scrollTop`）再算 —— 第一版直接用相对偏移推「滚到底时能压线的
// 最后一个」，在不可滚动 / 标题已越过判定线的情形会算出负的起点，于是把高亮甩到最后一条
// （单测当场抓到这个），文档坐标没有这个问题。
//
// 术语（手册 §4.33.1 有完整说明）：这是 **scroll spy**（滚动侦测）；② 属于它的
// **末屏边界**（end-of-document / last-section edge case），做法叫**尾部等分**
// （proportional tail mapping —— 没有官方单一名字；社区里常见的 bottom clamp 会跳过中间项）。

/** 判定线：滚动容器上沿往下这么多像素（落在它上面的最后一个标题 = 当前章节） */
export const SCROLL_SPY_OFFSET_PX = 90

export interface ScrollSpyInput {
  /** 各标题（按文档顺序）**相对滚动容器上沿**的偏移，当前滚动位置下的实测值 */
  tops: readonly number[]
  /** 当前 scrollTop */
  scrollTop: number
  /** 最大可滚动距离：`scrollHeight - clientHeight`（0 = 不可滚动） */
  maxScroll: number
  /** 判定线偏移，默认 `SCROLL_SPY_OFFSET_PX`（测试里可调） */
  offset?: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * 返回应该高亮的标题下标（-1 = 这一屏还没有任何标题越过判定线）。
 *
 * 单调性（有单测守着）：`scrollTop` 增大时返回值**只增不减** —— 否则滚动过程中高亮会来回跳。
 */
export function activeHeadingIndex(input: ScrollSpyInput): number {
  const { tops, scrollTop, maxScroll } = input
  const offset = input.offset ?? SCROLL_SPY_OFFSET_PX
  const n = tops.length
  if (n === 0) return -1

  const S = Math.max(0, maxScroll)
  /** 该标题正好压在判定线上时的 scrollTop（文档坐标 − 判定线） */
  const activateAt = (i: number): number => tops[i] + scrollTop - offset

  // ① 常规规则：判定线之上最后一个标题
  let idx = -1
  while (idx + 1 < n && activateAt(idx + 1) <= scrollTop) idx += 1

  // ② 末尾补偿：先找「滚到底时能压线的最后一个标题」
  let lastReachable = -1
  while (lastReachable + 1 < n && activateAt(lastReachable + 1) <= S) lastReachable += 1

  if (lastReachable >= n - 1) return idx // 全部都能压线 ⇒ 常规规则就够
  if (lastReachable < 0) {
    // 极端：滚到底也没有任何标题能压线（标题都挤在末尾、滚动范围又很小）。
    // 不可滚动时**不参与**（否则短文档一进来就点亮第一条）：短文档保持常规规则。
    if (S <= 0) return idx
    return Math.max(idx, Math.min(n - 1, Math.floor(clamp01(scrollTop / S) * n)))
  }

  const start = Math.max(0, activateAt(lastReachable)) // 这一段等分区间的起点
  if (scrollTop <= start) return idx

  // 把 [start, S] 平分给「最后能压线的那条」+ 后面追不上的那几条
  const shares = n - lastReachable
  const frac = clamp01((scrollTop - start) / Math.max(1, S - start))
  const tail = lastReachable + Math.min(shares - 1, Math.floor(frac * shares))
  return Math.max(idx, tail)
}
