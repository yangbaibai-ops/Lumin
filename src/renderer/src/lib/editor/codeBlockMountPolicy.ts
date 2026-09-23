// ─── 代码块 CM 挂载策略（F 项 / 自查报告 O2 虚拟化）────────────────────────────
//
// 要解决的问题：`CodeBlockView.vue` 是**每个代码块一个 Vue NodeView + 一个完整的
// CodeMirror `EditorView`**。实测 500 个围栏的文档打开 22.8s、常驻 1.4GB；1500 个围栏
// 打开 >185s（纯散文 572k 字符只要 2.24s ⇒ 瓶颈是**块数**而不是字符数）。CPU 剖面里
// `eq` 41% + StyleModule `mount` 32% 全花在「每块建一个 CM」上。
//
// 做法（施工图见桌面《Lumin-F项实施方案-代码块CM虚拟化.md》）——三态：
//   A. mermaid 态（沿用现状）
//   B. **已挂载态**：视口附近 / 选区所在 / 刚点过 → 建 CM（就是现在这套）
//   C. **静态态**：其余 → `<pre class="cb-static">` 纯文本 + CSS 行号，**不建 CM**
//
// 这个模块只做两件事，都不碰 DOM 细节：
//   1. `shouldMountCm()` —— **纯函数**判定（可单测）；
//   2. 一个**共享的** IntersectionObserver（不是每块一个）：按块登记/注销，
//      相交结果回调给组件。
//
// 为什么观察根用默认视口就够了：IntersectionObserver 的相交矩形会被**所有祖先**裁剪，
// 所以「在自己那个滚动容器里被滚出去」的块同样算不相交 —— 分屏下两个 pane 不需要
// 各建一个 observer（风险 R8 的对策）。

/** 视口上下各提前挂载的距离（约两屏）：提前挂上，避免快速滚动时频繁挂/卸 */
export const CODE_MOUNT_MARGIN_PX = 600

/**
 * 静态态要不要做**语法高亮**（P2，施工图给的回滚开关）。
 *
 * `false` ⇒ 静态态退回纯等宽文本（虚拟化刚落地时的行为）。留这个开关是因为静态态高亮
 * 依赖「语言解析器已登记」这条前提（见 lib/editor/staticHighlight.ts），万一某个语言包
 * 在静态态解析出问题，改这一个常量就能退回上一阶段，不必回滚整轮。
 *
 * 实测代价（1500 围栏的文档，同一构建只切这个常量，各起一个全新隔离实例）：
 * 开 3013ms / RSS 1030MB，关 2958ms / RSS 1036MB ⇒ **约 55ms、内存无差**（RSS 差异在噪声内）。
 */
export const STATIC_HIGHLIGHT = true

/**
 * 该不该为这个代码块建 CodeMirror（纯函数）。
 *
 * 三个条件任一成立就挂：
 *   * `near` 视口附近（含边距）—— 常规滚动；
 *   * `selectionInside` 选区/光标就在这个块里 —— **永远挂载**，它同时解决「按键路由」
 *     与「用户正在打字」两类问题（也保证不会在打字中途把 CM 卸掉）；
 *   * `activated` 用户刚点过这个块（点开即挂，P3 用）。
 */
export function shouldMountCm(input: {
  near: boolean
  selectionInside: boolean
  activated: boolean
}): boolean {
  return input.near || input.selectionInside || input.activated
}

type MountListener = (near: boolean) => void

const watchers = new Map<Element, MountListener>()
let observer: IntersectionObserver | null = null

function ensureObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  if (observer) return observer
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const cb = watchers.get(entry.target)
        if (cb) cb(entry.isIntersecting)
      }
    },
    { rootMargin: `${CODE_MOUNT_MARGIN_PX}px 0px ${CODE_MOUNT_MARGIN_PX}px 0px` }
  )
  return observer
}

/**
 * 观察一个代码块容器；相交状态变化时回调 `cb(near)`。返回取消函数。
 *
 * ⚠️ 没有 `IntersectionObserver`（老环境/测试宿主）时**直接回调 `near = true`**：
 * 宁可不省这点成本，也不能让代码块不可编辑。
 */
export function watchCodeBlockMount(el: Element, cb: MountListener): () => void {
  const obs = ensureObserver()
  if (!obs) {
    cb(true)
    return () => {}
  }
  watchers.set(el, cb)
  obs.observe(el)
  return () => {
    watchers.delete(el)
    obs.unobserve(el)
  }
}
