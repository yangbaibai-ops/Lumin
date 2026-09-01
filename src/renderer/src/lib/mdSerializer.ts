// ─── DOM → Markdown 序列化器 ────────────────────────────────────────────────
// 将所见即所得编辑后的块 DOM 精确还原为 Markdown 源码（与 marked 渲染管线对称）
// 覆盖：标题/段落/列表（含任务）/引用/表格/代码块/Mermaid/分割线/目录/行内样式/链接/图片/公式

const INLINE_EL: Record<string, string> = {
  STRONG: '**',
  EM: '*',
  DEL: '~~'
}

/** 行内序列化：文本 / 标记符跳过 / 行内样式 / 链接 / 图片 / 公式 / 换行 */
export function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName
  switch (tag) {
    case 'SPAN': {
      if (el.classList.contains('md-meta')) return '' // 标记符为视觉层
      if (el.classList.contains('md-math')) {
        return `$${el.dataset.tex ?? ''}$`
      }
      break
    }
    case 'STRONG':
    case 'EM':
    case 'DEL': {
      const m = INLINE_EL[tag]
      return m + serializeChildren(el) + m
    }
    case 'CODE': {
      const inner = serializeChildren(el)
      return '`' + inner + '`'
    }
    case 'A': {
      const href = (el.getAttribute('href') ?? '').replace(/[()]/g, (m) => '\\' + m)
      return `[${serializeChildren(el)}](${href})`
    }
    case 'IMG': {
      const alt = el.getAttribute('alt') ?? ''
      const src = el.dataset.src || el.getAttribute('src') || ''
      return `![${alt}](${src})`
    }
    case 'BR':
      // 表格单元格内的换行用 <br> 表示（GFM 单元格不支持真实换行）
      return el.closest('th, td') ? '<br>' : '\n'
  }
  // 其他元素（如 span 装饰、mark 等）→ 递归子内容
  return serializeChildren(el)
}

function serializeChildren(el: Element): string {
  let out = ''
  for (const child of Array.from(el.childNodes)) {
    out += serializeInline(child)
  }
  return out
}

/** 块元素序列化 */
function serializeBlockElement(el: HTMLElement, depth = 0): string {
  const tag = el.tagName
  switch (tag) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const level = Number(tag[1])
      return '#'.repeat(level) + ' ' + serializeChildren(el)
    }
    case 'P':
    case 'DIV':
      return serializeChildren(el)
    case 'UL':
    case 'OL':
      return serializeList(el, depth, tag === 'OL')
    case 'BLOCKQUOTE':
      return serializeQuote(el, depth)
    case 'TABLE':
      return serializeTable(el)
    case 'PRE':
      return serializeCodeBlock(el)
    case 'HR':
      return '---'
  }
  // 未知块级元素（编辑器可能产生 div）→ 按子内容处理
  return serializeChildren(el)
}

function serializeList(el: HTMLElement, depth: number, ordered: boolean): string {
  const pad = '  '.repeat(depth)
  const lines: string[] = []
  const items = Array.from(el.children).filter((c) => c.tagName === 'LI')
  // 有序列表起始序号（marked 输出 start 属性，序列化时还原）
  const start = ordered ? Number(el.getAttribute('start') ?? 1) : 1
  items.forEach((li, idx) => {
    const prefix = ordered ? `${start + idx}. ` : '- '
    let text = ''
    let nested: string[] = []
    const task = li.querySelector(':scope > input[type="checkbox"]')
    if (task) {
      const checked = (task as HTMLInputElement).checked ? 'x' : ' '
      text += `- [${checked}] `
    }
    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const childEl = child as HTMLElement
        if (childEl.tagName === 'UL' || childEl.tagName === 'OL') {
          nested.push(serializeList(childEl, depth + 1, childEl.tagName === 'OL'))
          continue
        }
        if (childEl.tagName === 'INPUT' && childEl.getAttribute('type') === 'checkbox') continue
      }
      text += serializeInline(child)
    }
    lines.push(pad + prefix + text.trimEnd())
    lines.push(...nested)
  })
  return lines.join('\n')
}

function serializeQuote(el: HTMLElement, depth: number): string {
  const prefix = '> '.repeat(depth + 1)
  const parts: string[] = []
  for (const child of Array.from(el.children)) {
    const childEl = child as HTMLElement
    if (childEl.tagName === 'BLOCKQUOTE') {
      parts.push(serializeQuote(childEl, depth + 1))
    } else {
      const text = serializeChildren(childEl)
      for (const line of text.split('\n')) parts.push(prefix + line)
    }
  }
  return parts.join('\n')
}

function serializeTable(table: HTMLElement): string {
  const rows: string[][] = []
  const aligns: (string | null)[] = []
  for (const row of Array.from(table.querySelectorAll('tr'))) {
    const cells: string[] = []
    for (const cell of Array.from(row.children)) {
      cells.push(serializeChildren(cell).trim())
      if (row.parentElement?.tagName === 'THEAD') {
        const align = cell.getAttribute('align') || (cell as HTMLElement).style.textAlign || null
        aligns.push(align)
      }
    }
    rows.push(cells)
  }
  if (!rows.length) return ''
  const colCount = rows[0].length
  const header = rows[0]
  const body = rows.slice(1)
  const sep = aligns
    .slice(0, colCount)
    .map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'))
    .join(' | ')
  const lines = [`| ${header.join(' | ')} |`, `| ${sep} |`]
  for (const row of body) {
    const cells = row.concat(new Array(Math.max(0, colCount - row.length)).fill(''))
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}

function serializeCodeBlock(pre: HTMLElement): string {
  // Mermaid 占位容器
  if (pre.classList.contains('md-mermaid') || pre.querySelector('.md-mermaid')) {
    const holder = pre.classList.contains('md-mermaid') ? pre : pre.querySelector('.md-mermaid')
    if (holder) {
      const code = decodeURIComponent((holder as HTMLElement).dataset.mermaid ?? '')
      return '```mermaid\n' + code + '\n```'
    }
  }
  const lang = pre.dataset.lang || ''
  // 代码块可原地编辑：以当前 DOM 文本为真值源（高亮 span 只提供颜色）
  // 跳过语言角标；浏览器插入的 div/br 还原为换行
  let raw = ''
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        raw += child.textContent ?? ''
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement
        if (el.classList.contains('code-lang')) continue
        if (el.tagName === 'BR' || el.tagName === 'DIV') {
          raw += '\n'
          continue
        }
        walk(el)
      }
    }
  }
  walk(pre)
  return '```' + lang + '\n' + raw + '\n```'
}

/** 将块容器序列化为 Markdown 源码 */
export function serializeBlock(root: HTMLElement): string {
  const parts: string[] = []
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? '').replace(/\n/g, '')
      if (text) parts.push(text)
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as HTMLElement
    if (el.classList.contains('md-mermaid')) {
      parts.push(serializeCodeBlock(el))
      continue
    }
    if (el.classList.contains('md-toc')) {
      parts.push('[TOC]')
      continue
    }
    if (el.tagName === 'DIV' && el.classList.contains('md-math-block')) {
      parts.push('$$\n' + (el.dataset.tex ?? '') + '\n$$')
      continue
    }
    parts.push(serializeBlockElement(el))
  }
  return parts.join('\n').trimEnd()
}

/** 序列化一个 Range 覆盖的内容（用于光标位置计算 / 块拆分） */
export function serializeRange(range: Range): string {
  const fragment = range.cloneContents()
  let out = ''
  for (const child of Array.from(fragment.childNodes)) {
    out += serializeInline(child)
  }
  return out
}

/**
 * 从块起点到光标位置的前缀序列化。
 * 与 serializeRange 的关键区别：光标位于行内样式元素内部时，
 * 不会为该元素补上闭合标记符（否则偏移量会被虚增）。
 */
export function serializePrefix(root: HTMLElement, endContainer: Node, endOffset: number): string {
  let out = ''
  let done = false

  const visit = (node: Node): void => {
    if (done) return
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === endContainer) {
        out += (node.textContent ?? '').slice(0, endOffset)
        done = true
      } else {
        out += node.textContent ?? ''
      }
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.classList.contains('md-meta')) return
    const tag = el.tagName
    if (tag === 'STRONG' || tag === 'EM' || tag === 'DEL') {
      const marker = tag === 'STRONG' ? '**' : tag === 'EM' ? '*' : '~~'
      out += marker
      el.childNodes.forEach(visit)
      if (!done) out += marker
      return
    }
    if (tag === 'CODE' && !el.closest('pre')) {
      out += '`'
      el.childNodes.forEach(visit)
      if (!done) out += '`'
      return
    }
    if (tag === 'A') {
      out += '['
      el.childNodes.forEach(visit)
      if (!done) out += `](${el.getAttribute('href') ?? ''})`
      return
    }
    if (tag === 'IMG') {
      out += `![${el.getAttribute('alt') ?? ''}](${el.dataset.src || el.getAttribute('src') || ''})`
      return
    }
    if (el.classList.contains('md-math')) {
      out += `$${el.dataset.tex ?? ''}$`
      return
    }
    if (tag === 'BR') {
      out += '\n'
      return
    }
    // 容器元素（p/span/div 等）→ 递归子内容
    el.childNodes.forEach(visit)
  }

  root.childNodes.forEach(visit)
  return out
}

/** 计算从块起点到光标处的 Markdown 偏移 */
export function caretMdOffset(blockRoot: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return 0
  const range = sel.getRangeAt(0)
  if (!blockRoot.contains(range.startContainer)) return 0
  return serializePrefix(blockRoot, range.startContainer, range.startOffset).length
}
