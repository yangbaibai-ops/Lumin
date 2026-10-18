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

function neutralize(el: Element): void {
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
  if (el.matches?.(DRAG_SOURCE_SELECTOR)) neutralize(el)
  el.querySelectorAll?.(DRAG_SOURCE_SELECTOR).forEach(neutralize)
}

/**
 * 把 DOM 里的拖拽源钉成不可拖：启动时全量扫一遍，之后只处理新增子树与
 * `draggable` / `data-drag-handle` 的属性变化（打字产生的文本节点不会触发扫描）。
 */
export function installNonDraggableDom(root: Document = document): () => void {
  sweep(root.documentElement)
  const observer = new MutationObserver((records) => {
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
