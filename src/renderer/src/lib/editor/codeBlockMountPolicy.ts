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

/** 离开视口附近后延迟多久才真卸（P3.2）：滚动中"来回滚一点"不该反复挂/卸一次 CM */
export const CODE_UNMOUNT_DELAY_MS = 500

/**
 * 卸载回静态态时记下的 `min-height` 兜底值（纯函数，可单测）。
 *
 * 语义只有一条：**宁可高一点，绝不能矮**。矮了就等于把下面的内容往上抽一下（跳变），
 * 高了最多多一条等宽背景。所以取 `Math.ceil`，非法值（0 / NaN / 负）给 `null`（不设）。
 *
 * 期望值来自 **CM 自己（`.cm-editor`）的高度**，不是 NodeView 外壳的高度 ——
 * 外壳那 2px 边框不属于代码区，记进去会让静态态每次挂/卸都高出 2px。
 *
 * 注：两态"不跳"靠的是排版契约（静态态与 CM 的 padding / 行高 / 换行口径逐项相同，
 * 见 overlays.css 的 `.md-preview pre.cb-static` 与 CodeBlockView 的 cmTheme），
 * 这个兜底在契约成立时恒等于静态态的自然高度。
 */
export function staticFallbackMinHeight(cmHeight: number): number | null {
  return Number.isFinite(cmHeight) && cmHeight > 0 ? Math.ceil(cmHeight) : null
}

/**
 * 折行高度「全量测量」的行数上限（tag `codeblock-wrap-no-fold`，纯函数见下）。
 *
 * 为什么需要全量测量：开启 `EditorView.lineWrapping` 之后，CM 的 `HeightMap` 只对**视口里**
 * 的行拿到真实高度，视口外按字符数估（`HeightOracle.heightForLine`）。浏览器折行是按空格断行、
 * 长串再 `overflow-wrap:anywhere` 断，实际视觉行数会多于估值 —— 实测 150 行 vue 块：
 * 静态 `<pre>` 4025px（精确），CM 先算成 3922px，滚过整块时 3922 → 3963 → 4005 → 4025 一路长高，
 * 每补一行就把页面的滚动位置吃掉一点（一次滚轮 -120 只走了 -99）。这正是
 * `codeblock-mount-no-jump` 要消灭的跳变，只是源头换成了"折行估值修正"。
 *
 * 修法是让 CM 用内部的 `printing` 口径（关闭视口限制）**一次性把全文行高量准**：
 * 之后 heightMap 全是实测值，滚动中不再修正，块高恒定。代价是挂载时渲染一遍全文行
 * （只在块首次进入视口时发生）。行数超过上限的块不做（一次性渲染代价太高），退回
 * 「静态精确高度当 min-height 地板」的兜底 —— 页面高度仍然稳定，只是 CM 内部行位置按估值。
 *
 * 1200 行（≈ 24000px）覆盖常见代码块（几十~几百行）；更大的块退回地板兜底，
 * 不做一次性全文渲染（那是挂载时的同步成本，块越大越不该付）。
 */
export const WARM_MEASURE_MAX_LINES = 1200

/** 该不该为这个块做全量行高测量（纯函数）：行数在 `[1, 上限]` 内才做 */
export function shouldWarmMeasureLines(lines: number): boolean {
  return Number.isFinite(lines) && lines > 0 && lines <= WARM_MEASURE_MAX_LINES
}

/**
 * 挂载 CM 时"把光标放到用户点的那个位置"的偏移（纯函数，可单测）。
 *
 * 入参是 PM 的节点起点 `nodePos` 与选区 `selectionFrom`：`code` 节点的**正文**
 * 从 `nodePos + 1` 开始（`nodePos` 是开标记），所以偏移 = `selectionFrom - nodePos - 1`，
 * 并夹在 `[0, docLength]` 里 —— 选区落在节点边界上（PM 允许 `to === nodePos + nodeSize`）
 * 时不能抛 `RangeError`，宁可落到块尾。
 *
 * 为什么要有这个函数：`focusCmAtEnd()`（块尾 + `scrollIntoView: true`）用在挂载路径上，
 * 会把整页滚到块底（用户报障："点一下 mermaid 下面那行，屏幕跳到大代码块中间"）。
 */
export function caretOffsetInBlock(
  nodePos: number,
  selectionFrom: number,
  docLength: number
): number {
  if (!Number.isFinite(nodePos) || !Number.isFinite(selectionFrom)) return 0
  const raw = Math.floor(selectionFrom - nodePos - 1)
  return Math.min(Math.max(raw, 0), Math.max(0, docLength))
}

type MountListener = (near: boolean) => void

const watchers = new Map<Element, MountListener>()
let observer: IntersectionObserver | null = null

// ─── 滚动活动门（tag `codeblock-mount-no-jump`）────────────────────────────────
//
// 为什么需要：两态的高度契约（静态 `<pre>` 与 CM 逐项同 padding / 同 line-height /
// 同样不换行）已经把「挂载/卸载」的高度差压到一条水平滚动条的厚度（实测 6px：静态态量
// 的是**全文**最长行，CM 只量当前视口渲染的那几十行）。但"切换本身"仍然是一次 DOM 重建，
// 在滚动中发生的任何一次都是可见的抖动源。所以**滚动中一律不切换**：等滚停 180ms 再决定。
//
// 用户交互（点进块 / 光标落进块）**不走这道门**，见 CodeBlockView 的 urgent 判定：
// 让人等 180ms 才拿到可编辑的代码块是不可接受的。

/**
 * 滚动停下多久之后才允许做「静态 ↔ 挂载」的切换（毫秒）。
 *
 * 220ms：滚轮一 tick 的间隔通常 60–120ms，所以连续滚动期间不会出现"刚好停够"的空隙；
 * 而松手后 220ms 内就会把视口里的块挂上，人的感知仍是"滚过去就能点"。再长（>300ms）
 * 会出现"块已经停在眼前、却还是死文本"的观感。
 */
export const CODE_SCROLL_IDLE_MS = 220

let lastScrollAt = Number.NEGATIVE_INFINITY
let scrollListenerInstalled = false

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** 记一次滚动（共享监听器调用；单测可直接喂时间戳） */
export function noteScrollActivity(now: number = nowMs()): void {
  lastScrollAt = now
}

/**
 * 距离「滚动停下」还有多少毫秒（纯函数，`0` = 现在就停在原地）。
 *
 * 从来没滚动过（`lastScrollAt` 是 -Infinity）⇒ 0：首屏打开时块必须立刻挂上。
 */
export function msUntilScrollIdle(now: number, idleMs: number = CODE_SCROLL_IDLE_MS): number {
  if (!Number.isFinite(lastScrollAt)) return 0
  const left = lastScrollAt + idleMs - now
  return left > 0 ? Math.ceil(left) : 0
}

/** 单测用：把滚动活动门复位（模块是单例，用例之间不能串味） */
export function resetScrollActivity(): void {
  lastScrollAt = Number.NEGATIVE_INFINITY
}

/**
 * 装一个**共享的** document 级 scroll 监听（捕获阶段：`.editor-scroll` 不冒泡到
 * document，只有捕获阶段收得到）。只装一次。
 */
function ensureScrollListener(): void {
  if (scrollListenerInstalled || typeof document === 'undefined') return
  scrollListenerInstalled = true
  document.addEventListener('scroll', () => noteScrollActivity(), {
    capture: true,
    passive: true
  })
}

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
  ensureScrollListener()
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
