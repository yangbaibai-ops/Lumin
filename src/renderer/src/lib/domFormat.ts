// ─── contenteditable 行内格式命令（DOM 选区操作）───────────────────────────
// 用于实时渲染模式下对选区执行加粗/斜体/删除线/行内代码的包裹与取消

export type InlineTag = 'strong' | 'em' | 'del' | 'code'

const MARKERS: Record<InlineTag, string> = {
  strong: '**',
  em: '*',
  del: '~~',
  code: '`'
}

function makeMeta(marker: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'md-meta'
  span.contentEditable = 'false'
  span.textContent = marker
  return span
}

function selectionIn(root: HTMLElement): Range | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  return range
}

/** 取消行内样式（strong/em/del/code → 纯文本 + 移除标记符） */
export function unwrapTag(el: HTMLElement): void {
  const parent = el.parentNode
  if (!parent) return
  // 移除标记符 span，保留内容
  el.querySelectorAll('.md-meta').forEach((m) => m.remove())
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
  parent.normalize()
}

function coversRange(el: HTMLElement, range: Range): boolean {
  const elRange = document.createRange()
  elRange.selectNodeContents(el)
  return (
    elRange.compareBoundaryPoints(Range.START_TO_START, range) <= 0 &&
    elRange.compareBoundaryPoints(Range.END_TO_END, range) >= 0
  )
}

/** 切换选区行内样式；返回是否成功 */
export function toggleInlineFormat(root: HTMLElement, tag: InlineTag): boolean {
  const range = selectionIn(root)
  if (!range) return false
  const sel = window.getSelection()!
  const marker = MARKERS[tag]

  // 折叠选区：插入标记符占位，光标置于中间，直接键入即生效
  if (range.collapsed) {
    const text = document.createTextNode(marker + marker)
    range.insertNode(text)
    range.setStart(text, marker.length)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  }

  // 选区完全位于同一样式内 → 取消样式
  const anc = range.commonAncestorContainer
  const startEl = anc.nodeType === Node.ELEMENT_NODE ? (anc as HTMLElement) : anc.parentElement
  const styled = startEl?.closest<HTMLElement>(tag)
  if (styled && coversRange(styled, range)) {
    const parent = styled.parentNode
    if (!parent) return false
    // 保留光标：在样式元素前放置哨兵
    unwrapTag(styled)
    const sentinel = document.createTextNode('')
    parent.insertBefore(sentinel, null)
    return true
  }

  // 包裹选区
  const fragment = range.extractContents()
  const wrapper = document.createElement(tag)
  wrapper.appendChild(makeMeta(marker))
  wrapper.appendChild(fragment)
  wrapper.appendChild(makeMeta(marker))
  range.insertNode(wrapper)
  const inner = document.createRange()
  inner.selectNodeContents(wrapper)
  sel.removeAllRanges()
  sel.addRange(inner)
  return true
}

/** 删除一个行内样式元素（用于标记符退格删除） */
export function removeStyleElement(el: HTMLElement): void {
  unwrapTag(el)
}

/** 判断节点是否为标记符 */
export function isMetaSpan(node: Node | null): boolean {
  return (
    !!node &&
    node.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).classList.contains('md-meta')
  )
}

/** 在块内按字符顺序遍历可视节点（跳过标记符），返回 { node, offset } 列表 */
export function visibleTextPositions(block: HTMLElement): { node: Node; offset: number }[] {
  const positions: { node: Node; offset: number }[] = []
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (parent?.classList.contains('md-meta')) continue
    positions.push({ node, offset: node.textContent?.length ?? 0 })
  }
  return positions
}
