// ─── 链接图片的**并排几何策略**（纯函数，可单测）──────────────────────────────
//
// 用户报障（README 徽章）：静态渲染是 `p > a > img`（第一张，链接）与 `p > img`
// （后三张，裸图）；点击后图片节点被换成原文文本，视图改由 widget 画图。
// 要让"初始 / 点击后 / 再点"三态的几何逐项相同，widget 必须与静态共用**同一套**
// 相邻外边距口径。静态 CSS 的实际口径（`markdown.css`）是：
//   * `p > img:not(:only-child) + img` ⇒ 后一张吃 0.6em；
//   * 但链接图是 `<a>`，`p > a + img` 这条被更专一的 `margin-inline: 0` 压掉
//     ⇒ **链接图后面那一张不吃 0.6em**（实测 5.03px，只是空格）。
//
// 这个模块只回答两个问题（不碰 DOM、不读样式）：
//   1. 本张图前面要不要 0.6em？= 有前一张，且前一张**不是**链接图。
//   2. 本张图是链接图吗？（链接图后面的间隙由 CSS 的 :not(.img-widget--linked) 排除）
//
// 三态之所以能一致：装饰在**初始文档**上就算好这两个布尔值，点击只改变"由谁画图"，
// 不改变答案；widget 再把答案落到 `<img class="img-gap-before">` 上。

/** 图片源码上"是否有链接"的最小形状（`ImgSource` 的子集） */
export interface LinkBearing {
  /** 链接属性（`href` 等）；没有链接 ⇒ null */
  link: Record<string, string> | null
}

/**
 * 本张图前面是否要 0.6em。
 * @param prev 同一块里的上一张图；没有 ⇒ false
 */
export function imageGapBefore(prev: LinkBearing | null | undefined): boolean {
  return !!prev && !prev.link
}

/**
 * 链接属性归一化：只保留非空值，且至少有一个属性才算链接。
 * @param attrs mark.attrs（PM 的 Attr 对象）
 */
export function linkAttrsOf(
  attrs: Record<string, unknown> | null | undefined
): Record<string, string> | null {
  if (!attrs) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null && v !== '') out[k] = String(v)
  }
  return Object.keys(out).length ? out : null
}
