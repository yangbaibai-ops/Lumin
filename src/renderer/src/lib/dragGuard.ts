// ─── 全局禁用 drag & drop（用户口径：所有组件元素的拖拽行为、样式、动效一起取消）──
//
// 要禁的是 **drag & drop（拖拽放置）**，不是鼠标拖选：
//   * 禁：拖选中的文字去别处插入/移动、拖图片/公式/代码块移动、从资源管理器拖文件进窗口
//     （插入图片、打开文档、设成工作区）、拖拽幽灵图 / 放置指示线 / 拖拽高亮；
//   * 保留：mousedown → mousemove → mouseup 的**文字拖选**、点击、键盘、粘贴（Ctrl+V）、撤销/重做。
//     因此这里**绝不监听鼠标事件**。
//
// 三层一起关（缺一层都会留下一条可走的路）：
//   ① `dragstart` 在 **window 捕获阶段** `preventDefault + stopPropagation` ——
//      浏览器因此不会生成拖拽数据、不会画幽灵图，ProseMirror / CodeMirror / 文件树
//      这些挂在各自 DOM 上的 `dragstart` 也都收不到事件；
//   ② 其余拖放事件（drag / dragenter / dragover / dragleave / drop / dragend）同样在
//      window 捕获阶段拦下，并把握放光标改成 `none` —— 外部文件拖进来时既不会插入内容、
//      也不会打开文件，光标显示"禁止"而不是"可放置"；
//   ③ DOM 侧把天然的拖拽源（`img` / `a[href]` / `video` / `audio` / 带 `draggable` 的元素）
//      的 `draggable` 钉成 `false`，并移除 `data-drag-handle` —— ProseMirror 在选中叶节点时
//      会主动补 `draggable=true`，所以这里用一个 MutationObserver 持续纠偏，而不是只扫一次。
//
// 样式那一半在 `assets/base.css` 的 `* { -webkit-user-drag: none }`，与这里互为兜底：
// 事件拦截保证"拖了也没效果"，`user-drag:none` 保证"根本起不了拖、光标也不暗示可拖"。

/** 需要拦截的拖放事件（一个都不放给页面） */
export const DRAG_EVENTS = [
  'dragstart',
  'drag',
  'dragenter',
  'dragover',
  'dragleave',
  'drop',
  'dragend'
] as const

/** 最小事件目标接口（window；单测里可以传 EventTarget，不依赖浏览器） */
export interface DragGuardTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void
}

function block(e: Event): void {
  e.preventDefault()
  e.stopPropagation()
}

/** 这次拖拽的"数据握把"：能关的都关掉，避免旧浏览器/合成事件留下可放置语义 */
function sealDataTransfer(e: Event, effect: 'none' | null): void {
  const dt = (e as DragEvent).dataTransfer
  if (!dt) return
  try {
    if (effect) dt.effectAllowed = effect
    dt.dropEffect = 'none'
  } catch {
    // 合成事件 / 只读 DataTransfer：拦不住属性也不影响 preventDefault 的结论
  }
}

/**
 * 在 `target`（通常是 `window`）的**捕获阶段**统一拦截全部拖放事件。
 * 返回卸载函数（单测与热更新用；产品里从启动到退出一直挂着）。
 */
export function installDragGuard(target: DragGuardTarget = window): () => void {
  const onStart = (e: Event): void => {
    sealDataTransfer(e, 'none')
    block(e)
  }
  const onOther = (e: Event): void => {
    sealDataTransfer(e, null)
    block(e)
  }
  const handlers: Record<string, EventListener> = {
    dragstart: onStart
  }
  for (const type of DRAG_EVENTS) {
    if (!handlers[type]) handlers[type] = onOther
  }
  // 捕获阶段：`{ capture: true }` 用对象而不是 boolean —— Node 的 EventTarget 在
  // removeEventListener 时只按对象里的 capture 匹配（boolean 形式删不掉，单测里会假活）。
  const options: AddEventListenerOptions = { capture: true }
  for (const type of DRAG_EVENTS) {
    target.addEventListener(type, handlers[type], options)
  }
  return () => {
    for (const type of DRAG_EVENTS) {
      target.removeEventListener(type, handlers[type], options)
    }
  }
}

/**
 * 天然的拖拽源：图片、链接、音视频，以及任何被显式标成 `draggable` 的元素。
 * ProseMirror 的 NodeView / 选中态会给节点补 `draggable=true`，所以这里不是一次性扫描。
 */
const DRAG_SOURCE_SELECTOR =
  'img, a[href], video, audio, pre, [data-node-view-wrapper], .code-block-wrapper, [contenteditable="false"], [draggable]:not([draggable="false"]), [data-drag-handle]'

/**
 * **ProseMirror 管理的 DOM 一律不碰**（`iterPasteFreezeTables` 真因，实测）。
 *
 * 事故：给 `<a href>` 写 `draggable="false"` 之后，PM 的 `DOMObserver` 把这次**属性
 * 变更**当成"外部程序改了我的 DOM"（PM 只认自己渲染出来的属性）⇒ `updateState`
 * 重渲染这一段 ⇒ `draggable` 被重建掉 ⇒ 我们再写一次 …… 于是形成
 * `MutationObserver → updateState → updateChildren → renderDescs → MutationObserver`
 * 的死循环：实测 2.5 s 内 observer 回调 **9451 次**、主线程永不返回（CDP 全超时，
 * `Debugger.pause` 也进不去）。触发门槛低得吓人：一篇只有**两个链接**的文档就够了
 * （一个链接时 PM 的重渲染恰好不重建属性，两个以上才进环），所以它表现成"随机卡死"。
 *
 * 为什么可以安全跳过：编辑器内的"不可拖"本来就不靠属性 ——
 * ① `installDragGuard` 在 window **捕获阶段** 对 `dragstart` 做 `preventDefault +
 *    stopPropagation`（浏览器根本不会开始拖拽，也无法把拖拽数据交给外部）；
 * ② `assets/base.css` 的 `* { -webkit-user-drag: none }`。
 * 属性纠偏只对**编辑器之外**的 DOM（文件树、侧栏、弹层）仍然生效。
 */
function insideEditor(el: Element): boolean {
  try {
    return !!(el.closest && el.closest('.ProseMirror'))
  } catch {
    return true
  }
}

function neutralize(el: Element): void {
  if (insideEditor(el)) return
  if (el.hasAttribute('data-drag-handle')) el.removeAttribute('data-drag-handle')
  if (el.getAttribute('draggable') === 'false') return
  try {
    // HTMLElement 上走属性（会同步写 `draggable="false"`）；SVG / 其它元素只写属性
    if (el instanceof HTMLElement) el.draggable = false
    else el.setAttribute('draggable', 'false')
  } catch {
    el.setAttribute('draggable', 'false')
  }
}

function sweep(node: Node): void {
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as Element
  if (insideEditor(el)) return
  if (el.matches?.(DRAG_SOURCE_SELECTOR)) neutralize(el)
  el.querySelectorAll?.(DRAG_SOURCE_SELECTOR).forEach(neutralize)
}

/**
 * 把 DOM 里的拖拽源钉成不可拖：启动时全量扫一遍，之后只处理新增子树与
 * `draggable` / `data-drag-handle` 的属性变化（打字产生的文本节点不会触发扫描）。
 */
export function installNonDraggableDom(root: Document = document): () => void {
  sweep(root.documentElement)
  /**
   * 熔断（第二道，纯兜底）：即使将来又有谁往编辑器 DOM 里写属性，也不能让 observer
   * 回调把主线程占死。1 秒内超过 `MAX_CALLBACKS_PER_WINDOW` 次回调 ⇒ 丢弃本轮记录
   * 并冷却 1 秒（丢弃的只是"把 draggable 钉成 false"这层兜底，事件拦截与 CSS 仍在）。
   * 冷却只影响编辑器之外的 DOM 纠偏；诊断值挂 `window.__LDRAGGUARD`，e2e 可断言。
   */
  const MAX_CALLBACKS_PER_WINDOW = 600
  const stats = { callbacks: 0, dropped: 0, trips: 0, lastTrip: 0 }
  try {
    ;(window as unknown as { __LDRAGGUARD?: typeof stats }).__LDRAGGUARD = stats
  } catch {
    /* 非浏览器环境（单测）：没有 window 也无所谓 */
  }
  let windowStart = 0
  let windowCount = 0
  const observer = new MutationObserver((records) => {
    const now = Date.now()
    if (now - windowStart > 1000) {
      windowStart = now
      windowCount = 0
    }
    windowCount += 1
    stats.callbacks += 1
    if (windowCount > MAX_CALLBACKS_PER_WINDOW) {
      stats.dropped += records.length
      if (stats.trips === 0 || now - stats.lastTrip > 5000) {
        stats.trips += 1
        stats.lastTrip = now
        // 可见但不吵：连一次就够定位了（下一次卡死先看这条）。
        // ASCII 诊断（控制台不是界面文案，界面提示一律走语言包）
        try {
          console.warn(
            `[lumin] dragGuard: ${windowCount} MutationObserver callbacks/s - dropped this batch (something is rewriting editor DOM repeatedly)`
          )
        } catch {
          /* ignore */
        }
      }
      return
    }
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target as Element
        if (el.matches?.(DRAG_SOURCE_SELECTOR)) neutralize(el)
        continue
      }
      record.addedNodes.forEach(sweep)
    }
  })
  observer.observe(root.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    // contenteditable 常常在节点插入后才由 ProseMirror 补上（NodeView），也要跟着纠偏
    attributeFilter: ['draggable', 'data-drag-handle', 'contenteditable']
  })
  return () => observer.disconnect()
}
