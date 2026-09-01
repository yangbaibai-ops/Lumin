<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import { analyzeDoc, renderBlock, renderMermaidInContainer, replaceBlock, escapeHtml } from '../lib/markdown'
import hljs from 'highlight.js/lib/common'
import { applyBlockFormat, applyBlockInsert } from '../lib/format'
import { serializeBlock, serializeRange, serializePrefix, caretMdOffset } from '../lib/mdSerializer'
import { toggleInlineFormat, unwrapTag, isMetaSpan } from '../lib/domFormat'
import Icon from './Icon.vue'

const files = useFilesStore()
const ui = useUiStore()
const settings = useSettingsStore()

const scrollEl = ref<HTMLElement | null>(null)
const virtualEl = ref<HTMLElement | null>(null)
/** 当前获得焦点的块索引（-1 表示无） */
const editingIdx = ref(-1)
const lastActive = ref(0)
/** 代码块 / Mermaid 的源码编辑态 */
const codeEditIdx = ref(-1)
const codeDraft = ref('')
/** 输入过程中抑制重渲染的缓存（活动块 DOM 为真值源） */
const suppress = ref(false)
const cachedHtml = new Map<number, string>()

const analysis = computed(() => analyzeDoc(files.current?.content ?? ''))
const blocks = computed(() => analysis.value.blocks)
const headings = computed(() => analysis.value.headings)

const rendered = computed(() => {
  const a = analysis.value
  return a.blocks.map((b) =>
    renderBlock(b.text, {
      slugCursor: a.slugCursor,
      headings: a.headings,
      baseDir: files.currentDir
    })
  )
})

function htmlFor(i: number): string {
  if (suppress.value && i === editingIdx.value) return cachedHtml.get(i) ?? rendered.value[i] ?? ''
  return rendered.value[i] ?? ''
}

const isEmpty = computed(() => (files.current?.content ?? '').length === 0)

// ── Mermaid 渲染 ──
async function renderMermaid(): Promise<void> {
  await nextTick()
  if (scrollEl.value) await renderMermaidInContainer(scrollEl.value, settings.effectiveTheme)
}
watch(rendered, () => void renderMermaid())
watch(
  () => settings.effectiveTheme,
  () => {
    if (scrollEl.value) void renderMermaidInContainer(scrollEl.value, settings.effectiveTheme)
  }
)

/**
 * 清理 marked 输出中元素之间的纯空白文本节点。
 * 这些节点处于可编辑区内但会被序列化器忽略，光标落入其中输入会丢失。
 */
function cleanupWhitespaceNodes(root: HTMLElement): void {
  const STRUCTURAL = new Set(['OL', 'UL', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR'])
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const doomed: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) {
    const parent = n.parentElement
    if (!parent) continue
    const isStructuralSpace =
      (STRUCTURAL.has(parent.tagName) || parent === root) &&
      (n.textContent ?? '').trim() === ''
    if (isStructuralSpace) doomed.push(n as Text)
  }
  for (const t of doomed) t.remove()
}
watch(rendered, async () => {
  await nextTick()
  if (scrollEl.value) cleanupWhitespaceNodes(scrollEl.value)
})

// ── DOM 工具 ──
function blockElOf(i: number): HTMLElement | null {
  return scrollEl.value?.querySelector<HTMLElement>(`[data-block="${i}"] .md-block-inner`) ?? null
}
function blockIdxOf(el: HTMLElement): number {
  return Number(el.closest<HTMLElement>('[data-block]')?.dataset.block ?? -1)
}

function placeCaret(node: Node, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

function focusEnd(el: HTMLElement): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node: Node | null = null
  let last: Node | null = null
  while ((node = walker.nextNode())) last = node
  if (last) {
    placeCaret(last, last.textContent?.length ?? 0)
    el.focus()
  } else {
    el.focus()
  }
}

function focusStart(el: HTMLElement): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const first = walker.nextNode()
  if (first) {
    // 任务列表：跳过 checkbox 占位
    placeCaret(first, 0)
    el.focus()
  } else {
    el.focus()
  }
}

function placeCaretStartIn(el: HTMLElement): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node.parentElement?.classList.contains('md-meta')) continue
    placeCaret(node, 0)
    return
  }
  placeCaret(el, 0)
}

// ── 序列化同步（输入防抖）与提交 ──
const syncTimers = new Map<number, ReturnType<typeof setTimeout>>()

function syncBlock(i: number): void {
  const el = blockElOf(i)
  if (!el && codeEditIdx.value !== i) return
  // 代码块原位编辑：草稿即真值源
  let md: string
  if (codeEditIdx.value === i) {
    const lang = codeEditLang.value
    md = '```' + (lang && lang !== 'mermaid' ? lang : 'mermaid') + '\n' + codeDraft.value + '\n```'
  } else {
    md = serializeBlock(el!)
  }
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  if (!block || md === block.text) return
  cachedHtml.set(i, htmlFor(i))
  suppress.value = true
  files.setContent(replaceBlock(content, block, md))
}

function scheduleSync(i: number): void {
  clearTimeout(syncTimers.get(i))
  syncTimers.set(
    i,
    setTimeout(() => {
      syncTimers.delete(i)
      if (editingIdx.value === i) syncBlock(i)
    }, 400)
  )
}

function commitBlock(i: number): void {
  if (i < 0) return
  const el = blockElOf(i)
  if (!el) return
  suppress.value = false
  cachedHtml.delete(i)
  const md = serializeBlock(el)
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  if (block && md !== block.text) {
    files.setContent(replaceBlock(content, block, md))
  }
  editingIdx.value = -1
}

function onBlockFocusIn(i: number, e: FocusEvent): void {
  editingIdx.value = i
  lastActive.value = i
  const el = e.currentTarget as HTMLElement
  cachedHtml.set(i, rendered.value[i] ?? '')
  if (ui.typewriterMode) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

function onBlockFocusOut(i: number, e: FocusEvent): void {
  const el = e.currentTarget as HTMLElement
  const next = e.relatedTarget as Node | null
  if (next && el.contains(next)) return
  commitBlock(i)
}

function onBlockInput(i: number): void {
  scheduleSync(i)
}

// ── beforeinput：段落 / 退格删除标记符 / 粘贴 ──
function onBeforeInput(i: number, e: InputEvent): void {
  const el = e.currentTarget as HTMLElement
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const range = sel.getRangeAt(0)

  if (e.inputType === 'insertParagraph') {
    // 代码块内回车：在光标处插入 '\n' 文本，随后把光标放到 pre 末尾
    // （code 元素之后）——后续输入会干净地追加到代码末尾
    const inCode = elementFromNode(range.startContainer)?.closest<HTMLElement>('pre.code-wrap')
    if (inCode) {
      e.preventDefault()
      range.insertNode(document.createTextNode('\n'))
      const sel = window.getSelection()
      if (sel) {
        const r2 = document.createRange()
        r2.setStart(inCode, inCode.childNodes.length)
        r2.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r2)
      }
      return
    }
    handleEnter(i, el, range, e)
    return
  }
  if (e.inputType === 'deleteContentBackward') {
    // 代码块内退格：交给浏览器（原地编辑代码文本）
    const inCode = elementFromNode(range.startContainer)?.closest<HTMLElement>('pre.code-wrap')
    if (inCode) return
    const prev = previousVisibleNode(el, range)
    // 标题标记符前退格 → 去标题（Typora 行为）
    if (
      prev &&
      prev.nodeType === Node.ELEMENT_NODE &&
      (prev as HTMLElement).classList.contains('md-heading-marker')
    ) {
      e.preventDefault()
      const heading = (prev as HTMLElement).parentElement
      if (heading) deHeadingEl(heading as HTMLElement)
      return
    }
    if (isMetaSpan(prev)) {
      e.preventDefault()
      const styled = (prev as HTMLElement).parentElement
      if (styled) unwrapTag(styled)
      return
    }
    // 列表项内容起点退格（Typora 语义：合并到上一项 / 首项去列表 / 空项删除）
    const startLi = atListItemStart(range)
    if (startLi) {
      e.preventDefault()
      backspaceAtListItemStart(i, el, startLi)
      return
    }
    if (prev === null && i > 0) {
      // 块首退格 → 与上一块合并（结构块只移动光标，不合并）
      e.preventDefault()
      mergeWithPrev(i)
      return
    }
    return
  }
  if (e.inputType === 'deleteContentForward') {
    const inCode = elementFromNode(range.startContainer)?.closest<HTMLElement>('pre.code-wrap')
    if (inCode) return
    const next = nextVisibleNode(el, range)
    if (isMetaSpan(next)) {
      e.preventDefault()
      const styled = (next as HTMLElement).parentElement
      if (styled) unwrapTag(styled)
      return
    }
    // 列表项内容终点 Delete（Typora 语义：合并下一项 / 空项删除）
    const endLi = atListItemEnd(range)
    if (endLi) {
      e.preventDefault()
      deleteAtListItemEnd(i, el, endLi)
      return
    }
    if (next === null && i < blocks.value.length - 1) {
      // 块末 Delete → 与下一块合并（结构块只移动光标，不合并）
      e.preventDefault()
      mergeWithNext(i)
    }
    return
  }
  if (e.inputType === 'insertFromPaste') {
    e.preventDefault()
    const text = e.dataTransfer?.getData('text/plain') ?? ''
    if (!text) return
    // 多行文本：以 <br> 分隔插入（Chromium 的 execCommand('insertText') 会丢弃换行后的内容）
    const parts = text.split('\n')
    const frag = document.createDocumentFragment()
    parts.forEach((part, idx) => {
      if (idx > 0) frag.appendChild(document.createElement('br'))
      if (part) frag.appendChild(document.createTextNode(part))
    })
    range.deleteContents()
    range.insertNode(frag)
    // insertNode 后 range 的边界会包裹插入内容，直接以 range 末端作为光标位置
    const r2 = document.createRange()
    r2.setStart(range.endContainer, range.endOffset)
    r2.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r2)
    return
  }
}

/** 块内可见叶子节点（文本 / 标记符 / 图片 / 公式），按文档顺序 */
function orderedVisibleNodes(block: HTMLElement): Node[] {
  const nodes: Node[] = []
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n.parentElement?.classList.contains('md-meta')) continue
      nodes.push(n)
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement
      if (
        el.classList.contains('md-meta') ||
        el.tagName === 'IMG' ||
        el.classList.contains('md-math')
      ) {
        nodes.push(el)
      }
    }
  }
  return nodes
}

function previousVisibleNode(block: HTMLElement, range: Range): Node | null {
  const nodes = orderedVisibleNodes(block)
  const idx = nodes.indexOf(range.startContainer)
  if (idx < 0) return null
  if (range.startOffset > 0) return range.startContainer
  return idx > 0 ? nodes[idx - 1] : null
}

function nextVisibleNode(block: HTMLElement, range: Range): Node | null {
  const nodes = orderedVisibleNodes(block)
  const idx = nodes.indexOf(range.startContainer)
  if (idx < 0) return null
  const len = range.startContainer.textContent?.length ?? 0
  if (range.startOffset < len) return range.startContainer
  return idx + 1 < nodes.length ? nodes[idx + 1] : null
}

// ── 列表项边界语义（Typora 标准行为矩阵）───────────────────────────────

/** 光标是否位于某个 li 内容的起点（相对该 li 自身的可见节点） */
function atListItemStart(range: Range): HTMLElement | null {
  const li = elementFromNode(range.startContainer)?.closest<HTMLElement>('li')
  if (!li) return null
  const nodes = orderedVisibleNodes(li)
  if (!nodes.length) return li // 空项
  return range.startContainer === nodes[0] && range.startOffset === 0 ? li : null
}

/** 光标是否位于某个 li 内容的终点 */
function atListItemEnd(range: Range): HTMLElement | null {
  const li = elementFromNode(range.startContainer)?.closest<HTMLElement>('li')
  if (!li) return null
  const nodes = orderedVisibleNodes(li)
  if (!nodes.length) return li // 空项
  const last = nodes[nodes.length - 1]
  const len = last.textContent?.length ?? 0
  return range.startContainer === last && range.startOffset === len ? li : null
}

/** 列表项内容起点退格：合并上一项 / 首项去列表 / 空项删除 */
function backspaceAtListItemStart(i: number, el: HTMLElement, li: HTMLElement): void {
  // 空项 → 删除该项
  if ((li.textContent ?? '').trim() === '') {
    deleteEmptyItemAtCaret(i, el, li)
    return
  }
  const prev = li.previousElementSibling as HTMLElement | null
  if (prev && prev.tagName === 'LI') {
    joinWithPreviousItem(li, prev)
  } else {
    delistItemAtCaret(i, el, li)
  }
}

/** 列表项内容终点 Delete：合并下一项 / 空项删除；无下一项时交回块级规则 */
function deleteAtListItemEnd(i: number, el: HTMLElement, li: HTMLElement): void {
  if ((li.textContent ?? '').trim() === '') {
    deleteEmptyItemAtCaret(i, el, li)
    return
  }
  const next = li.nextElementSibling as HTMLElement | null
  if (next && next.tagName === 'LI') {
    joinWithNextItem(li, next)
  } else {
    // 列表块末：仅移动光标到下一块起点，不合并
    const nextBlock = blockElOf(i + 1)
    if (nextBlock) focusStart(nextBlock)
  }
}

/** DOM 级：把 li 的内容并入上一项，光标置于连接点 */
function joinWithPreviousItem(li: HTMLElement, prev: HTMLElement): void {
  const boundary = document.createTextNode('')
  prev.appendChild(boundary)
  while (li.firstChild) prev.appendChild(li.firstChild)
  li.remove()
  placeCaret(boundary, 0)
  const block = prev.closest<HTMLElement>('.md-block-inner')
  if (block) scheduleSync(blockIdxOf(block))
}

/** DOM 级：把下一项的内容并入当前项，光标置于连接点 */
function joinWithNextItem(li: HTMLElement, next: HTMLElement): void {
  const boundary = document.createTextNode('')
  li.appendChild(boundary)
  while (next.firstChild) li.appendChild(next.firstChild)
  next.remove()
  placeCaret(boundary, 0)
  const block = li.closest<HTMLElement>('.md-block-inner')
  if (block) scheduleSync(blockIdxOf(block))
}

/** 首项去列表：去掉光标行的列表前缀（该行变为普通文本，其余项仍为列表） */
function delistItemAtCaret(i: number, el: HTMLElement, li: HTMLElement): void {
  const md = serializeBlock(el)
  const target = findLineOfElementInMd(md, li, /^\s*([-*+]\s*|\d+[.)]\s*)/)
  if (target < 0) return
  const lines = md.split('\n')
  const stripped = lines[target].replace(/^\s*([-*+]\s*|\d+[.)]\s*)/, '')
  lines[target] = stripped
  const newText = lines.join('\n').trimEnd() + '\n\n'
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  if (!block) return
  files.setContent(replaceBlock(content, block, newText))
  suppress.value = false
  cachedHtml.delete(i)
  editingIdx.value = -1
  void nextTick(() => {
    const back = blockElOf(i)
    if (back) focusStart(back)
  })
}

/** 删除空列表项（若为唯一项则整块变为空段落） */
function deleteEmptyItemAtCaret(i: number, el: HTMLElement, li: HTMLElement): void {
  const md = serializeBlock(el)
  const target = findLineOfElementInMd(md, li, /^\s*([-*+]\s*|\d+[.)]\s*)/)
  if (target < 0) return
  const lines = md.split('\n')
  lines.splice(target, 1)
  const newText = lines.join('\n').trimEnd() + '\n\n'
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  if (!block) return
  files.setContent(replaceBlock(content, block, newText))
  suppress.value = false
  cachedHtml.delete(i)
  editingIdx.value = -1
  void nextTick(() => {
    const back = blockElOf(i)
    if (back) focusEnd(back)
  })
}

// ── Enter：列表拆分 / 表格换行 / 块拆分 ──
function elementFromNode(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

/** DOM 级去标题（Typora：在 # 标记符处退格 → 标题变段落） */
function deHeadingEl(h: HTMLElement): void {
  const parent = h.parentNode
  if (!parent) return
  h.querySelectorAll('.md-meta').forEach((m) => m.remove())
  const p = document.createElement('p')
  while (h.firstChild) p.appendChild(h.firstChild)
  parent.replaceChild(p, h)
  parent.normalize()
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  const first = walker.nextNode()
  if (first) placeCaret(first, 0)
  else placeCaret(p, 0)
  scheduleSync(blockIdxOf(p))
}

/** 标题行末回车 → 去标题并另起新段落（Typora 行为） */
function deHeadingAtCaret(i: number, el: HTMLElement): void {
  const prefix = caretMdOffset(el)
  const md = serializeBlock(el)
  const lineStart = md.lastIndexOf('\n', prefix - 1) + 1
  const lineEndIdx = md.indexOf('\n', prefix)
  const lineEnd = lineEndIdx === -1 ? md.length : lineEndIdx
  const line = md.slice(lineStart, lineEnd)
  const stripped = line.replace(/^\s*#{1,6}\s*/, '')
  const newText = md.slice(0, lineStart) + stripped + md.slice(lineEnd) + '\n\n'
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  if (!block) return
  files.setContent(replaceBlock(content, block, newText))
  suppress.value = false
  cachedHtml.delete(i)
  editingIdx.value = -1
  void nextTick(() => {
    const nextEl = blockElOf(i + 1)
    if (nextEl) focusStart(nextEl)
    else virtualEl.value?.focus()
  })
}

function handleEnter(i: number, el: HTMLElement, range: Range, e: InputEvent): void {
  const li = elementFromNode(range.startContainer)?.closest<HTMLElement>('li')
  if (li) {
    const nested = li.querySelector('ul, ol')
    if (nested && nested.contains(range.startContainer)) return // 嵌套列表内交给浏览器
    // 空列表项回车 → 退出列表（Typora 行为）
    if ((li.textContent ?? '').trim() === '') {
      e.preventDefault()
      exitListAtCaret(i, el, li)
      return
    }
    e.preventDefault()
    splitListItem(li, range)
    return
  }
  const cell = elementFromNode(range.startContainer)?.closest<HTMLElement>('th, td')
  if (cell) {
    e.preventDefault()
    document.execCommand('insertLineBreak')
    return
  }
  const quote = elementFromNode(range.startContainer)?.closest<HTMLElement>('blockquote')
  if (quote) {
    // 空引用行回车 → 退出引用块（Typora 行为）
    const lineEl = caretQuoteLineEl(range, quote)
    if (lineEl && (lineEl.textContent ?? '').trim() === '') {
      e.preventDefault()
      exitQuoteAtCaret(i, el, quote, lineEl)
      return
    }
    // 非空引用行：默认行为（Chromium 插入新的引用行，序列化器可还原）
    return
  }
  // 标题：光标在行末 → 去标题（Typora）；行中 → 拆分为 标题 + 段落
  const heading = elementFromNode(range.startContainer)?.closest<HTMLElement>('h1, h2, h3, h4, h5, h6')
  if (heading && !cell && !li && range.collapsed) {
    // 在标题元素内部比较光标位置（# 前缀由元素类型产生，不计入内容偏移）
    const hFull = document.createRange()
    hFull.selectNodeContents(heading)
    const innerLen = serializeRange(hFull).length
    const innerBefore = serializePrefix(heading, range.startContainer, range.startOffset).length
    if (innerBefore >= innerLen) {
      e.preventDefault()
      deHeadingAtCaret(i, el)
      return
    }
  }
  e.preventDefault()
  splitBlockAtCaret(i, el)
}

function splitListItem(li: HTMLElement, range: Range): void {
  const list = li.parentElement
  if (!list) return
  const newLi = document.createElement('li')
  const tail = document.createRange()
  tail.setStart(range.startContainer, range.startOffset)
  tail.setEndAfter(li)
  const frag = tail.extractContents()
  newLi.appendChild(frag)
  const isTask = !!li.parentElement?.querySelector('li > input[type="checkbox"]')
  if (isTask) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.disabled = true
    newLi.prepend(box, document.createTextNode(' '))
  }
  list.insertBefore(newLi, li.nextSibling)
  // Typora 光标语义：
  // - 行中拆分 → 光标落在新项开头
  // - 行末拆分 → 新项为空，光标必须落在新项（空项）中，继续输入即新行圆点
  // - 行首拆分 → 原项变空，光标留在原项
  const origEmpty = (li.textContent ?? '').trim() === ''
  const target = origEmpty ? li : newLi
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  let first: Node | null = null
  let n: Node | null
  while ((n = walker.nextNode())) {
    if (n.parentElement?.classList.contains('md-meta')) continue
    first = n
    break
  }
  if (first) {
    placeCaret(first, 0)
  } else {
    // 空项：插入空文本节点作为光标锚点，保证后续输入落在该项内
    const empty = document.createTextNode('')
    target.appendChild(empty)
    placeCaret(empty, 0)
  }
  const block = list.closest<HTMLElement>('.md-block-inner')
  if (block) scheduleSync(blockIdxOf(block))
}

/** 光标所在引用行元素（空行判断 + 退出定位共用） */
function caretQuoteLineEl(range: Range, quote: HTMLElement): HTMLElement | null {
  const node = range.startContainer
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
  if (!el || !quote.contains(el)) return null
  return el.closest<HTMLElement>('p, div, h1, h2, h3, h4, h5, h6, li') ?? quote
}

/**
 * 按 DOM 结构定位光标行在 md 中的行号。
 * 注意：不能使用 caretMdOffset（行内样式/列表/引用的标记符前缀会造成偏移），
 * 这里以「光标行元素在父容器块级子元素中的序号」对齐 md 行。
 */
function findLineOfElementInMd(md: string, lineEl: HTMLElement, markerRe: RegExp): number {
  const container = lineEl.parentElement
  if (!container) return -1
  const siblings = Array.from(container.children).filter((c) =>
    ['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName)
  )
  const idx = siblings.indexOf(lineEl)
  if (idx < 0) return -1
  const lines = md.split('\n')
  let k = 0
  for (let li = 0; li < lines.length; li++) {
    if (markerRe.test(lines[li])) {
      if (k === idx) return li
      k++
    }
  }
  return -1
}

/** 空引用行回车 → 移除该引用行并另起普通段落 */
function exitQuoteAtCaret(i: number, el: HTMLElement, _quote: HTMLElement, lineEl: HTMLElement): void {
  const md = serializeBlock(el)
  const target = findLineOfElementInMd(md, lineEl, /^\s*>/)
  if (target < 0) return
  const lines = md.split('\n')
  if (!/^\s*>\s*$/.test(lines[target])) return
  lines.splice(target, 1)
  const newText = lines.join('\n').trimEnd() + '\n\n'
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  if (!block) return
  files.setContent(replaceBlock(content, block, newText))
  suppress.value = false
  cachedHtml.delete(i)
  editingIdx.value = -1
  void nextTick(() => {
    const nextEl = blockElOf(i + 1)
    if (nextEl) focusStart(nextEl)
    else virtualEl.value?.focus()
  })
}

/** 空列表项回车 → 移除该项并退出列表（Typora 行为） */
function exitListAtCaret(i: number, el: HTMLElement, li: HTMLElement): void {
  const md = serializeBlock(el)
  const target = findLineOfElementInMd(md, li, /^\s*([-*+]\s*|\d+[.)]\s*)/)
  if (target < 0) return
  const lines = md.split('\n')
  // 注意：整块序列化会 trimEnd，行尾空格可能被裁掉，空项行需容忍无尾随空格
  if (!/^\s*([-*+]\s*|\d+[.)]\s*)$/.test(lines[target])) return
  lines.splice(target, 1)
  const newText = lines.join('\n').trimEnd() + '\n\n'
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  if (!block) return
  files.setContent(replaceBlock(content, block, newText))
  suppress.value = false
  cachedHtml.delete(i)
  editingIdx.value = -1
  void nextTick(() => {
    const nextEl = blockElOf(i + 1)
    if (nextEl) focusStart(nextEl)
    else virtualEl.value?.focus()
  })
}

/** 拆块时配平行内标记符：head 中未闭合的 ** / * / ~~ / ` 在两侧补全（Typora 行为） */
function balanceInline(headIn: string, restIn: string): [string, string] {
  let head = headIn
  let rest = restIn
  const pairs: { marker: string; count: number }[] = []
  for (const marker of ['~~', '`']) {
    pairs.push({ marker, count: (head.match(new RegExp(escRe(marker), 'g')) || []).length })
  }
  const dbl = (head.match(/\*\*/g) || []).length
  const stars = (head.match(/\*/g) || []).length - dbl * 2
  pairs.push({ marker: '**', count: dbl })
  pairs.push({ marker: '*', count: stars })
  for (const { marker, count } of pairs) {
    if (count % 2 === 1) {
      head += marker
      rest = marker + rest
    }
  }
  return [head, rest]
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitBlockAtCaret(i: number, el: HTMLElement): void {
  const prefix = caretMdOffset(el)
  const md = serializeBlock(el)
  const head = md.slice(0, prefix)
  const rest = md.slice(prefix)
  const [balHead, balRest] = balanceInline(head, rest)
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  if (!block) return
  const newText = balRest ? `${balHead}\n\n${balRest}` : `${balHead}\n\n`
  files.setContent(replaceBlock(content, block, newText))
  suppress.value = false
  cachedHtml.delete(i)
  editingIdx.value = -1
  void nextTick(() => {
    const nextEl = blockElOf(i + 1)
    if (nextEl) focusStart(nextEl)
    else virtualEl.value?.focus() // 尾部空行被解析器省略 → 落到虚尾块继续写作
  })
}

function mergeWithPrev(i: number): void {
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const cur = a.blocks[i]
  const prev = a.blocks[i - 1]
  if (!cur || !prev) return
  const curEl = blockElOf(i)
  const curMd = curEl ? serializeBlock(curEl) : cur.text
  // 结构块不合并：光标移到上一块末尾
  if (isStructuralBlock(curMd) || isStructuralBlock(prev.text)) {
    const prevEl = blockElOf(i - 1)
    if (prevEl) focusEnd(prevEl)
    return
  }
  const lines = content.split('\n')
  // 空段落块：直接删除该空行
  if (curMd.trim() === '') {
    lines.splice(cur.start, 1)
    const nextContent = lines.join('\n')
    files.setContent(nextContent)
    suppress.value = false
    cachedHtml.delete(i)
    editingIdx.value = -1
    void nextTick(() => {
      const el = blockElOf(i - 1)
      if (el) focusEnd(el)
    })
    return
  }
  const joined = `${prev.text.trimEnd()}\n${curMd.trimStart()}`
  lines.splice(prev.start, cur.end - prev.start, ...joined.split('\n'))
  const nextContent = lines.join('\n')
  files.setContent(nextContent)
  suppress.value = false
  cachedHtml.delete(i)
  editingIdx.value = -1
  void nextTick(() => {
    // 合并后两个块变成一个块，光标置于合并点（上一块末尾）
    const a2 = analyzeDoc(nextContent)
    const idx = a2.blocks.findIndex((b) => b.start <= prev.start && b.end > prev.start)
    const el = blockElOf(idx >= 0 ? idx : i - 1)
    if (el) focusEnd(el)
  })
}

/** 结构块检测：列表 / 引用 / 代码 / 表格 / 公式 / 分割线 / 目录不参与跨块文本合并 */
function isStructuralBlock(md: string): boolean {
  const first = md.trimStart()
  return (
    /^\s*([-*+]\s|\d+[.)]\s|>|```|~~~|\$\$|\|)/.test(first) ||
    /^\s*---\s*$/.test(first) ||
    /^\s*\[TOC\]\s*$/i.test(first)
  )
}

/** 块末 Delete → 与下一块合并（Typora 行为；结构块只移动光标不合并） */
function mergeWithNext(i: number): void {
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const cur = a.blocks[i]
  const next = a.blocks[i + 1]
  if (!cur || !next) return
  const curEl = blockElOf(i)
  const curMd = curEl ? serializeBlock(curEl) : cur.text
  // 结构块（列表/引用/代码/表格等）不合并，仅移动光标到下一块起点
  if (isStructuralBlock(curMd) || isStructuralBlock(next.text)) {
    const nextEl = blockElOf(i + 1)
    if (nextEl) focusStart(nextEl)
    return
  }
  const lines = content.split('\n')
  // 下一块为空段落：直接删除其空行
  if (next.text.trim() === '') {
    lines.splice(next.start, 1)
    const nextContent = lines.join('\n')
    files.setContent(nextContent)
    suppress.value = false
    cachedHtml.delete(i)
    editingIdx.value = -1
    void nextTick(() => {
      const el = blockElOf(i)
      if (el) focusEnd(el)
    })
    return
  }
  const joined = `${curMd.trimEnd()}\n${next.text.trimStart()}`
  lines.splice(cur.start, next.end - cur.start, ...joined.split('\n'))
  const nextContent = lines.join('\n')
  files.setContent(nextContent)
  suppress.value = false
  cachedHtml.delete(i)
  editingIdx.value = -1
  void nextTick(() => {
    const a2 = analyzeDoc(nextContent)
    const idx = a2.blocks.findIndex((b) => b.start <= cur.start && b.end > cur.start)
    const el = blockElOf(idx >= 0 ? idx : i)
    if (el) focusEnd(el)
  })
}

// ── 虚尾块（文档末尾持续写作区）──
function onVirtualFocusIn(): void {
  editingIdx.value = blocks.value.length
  lastActive.value = blocks.value.length
}

function onVirtualInput(): void {
  const el = virtualEl.value
  if (!el) return
  const md = serializeBlock(el)
  if (!md.trim()) return
  const content = files.current?.content ?? ''
  const sep = content ? '\n\n' : ''
  files.setContent(content + sep + md)
  editingIdx.value = -1
  void nextTick(() => {
    el.innerHTML = ''
    const newIdx = analyzeDoc(files.current?.content ?? '').blocks.length - 1
    const real = blockElOf(newIdx)
    editingIdx.value = newIdx
    if (real) focusEnd(real)
  })
}

function onVirtualBlur(): void {
  void onVirtualInput()
}

function onVirtualKeydown(e: KeyboardEvent): void {
  const el = virtualEl.value
  if (!el) return
  if (e.key === 'Backspace' && (el.textContent ?? '').length === 0 && blocks.value.length) {
    e.preventDefault()
    const last = blockElOf(blocks.value.length - 1)
    if (last) focusEnd(last)
    return
  }
  if (e.key === 'ArrowUp') {
    const sel = window.getSelection()
    if (sel?.anchorOffset === 0) {
      e.preventDefault()
      const last = blockElOf(blocks.value.length - 1)
      if (last) focusEnd(last)
    }
  }
}

function onBlockKeydown(i: number, e: KeyboardEvent): void {
  // 代码块内 Tab → 插入两个空格（Typora 行为）
  if (e.key === 'Tab') {
    const sel = window.getSelection()
    const anchor = sel?.rangeCount ? sel.getRangeAt(0).startContainer : null
    const anchorEl = anchor
      ? anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor.parentElement
      : null
    if (anchorEl?.closest('pre.code-wrap')) {
      e.preventDefault()
      document.execCommand('insertText', false, '  ')
      return
    }
    const cell = anchorEl?.closest<HTMLElement>('th, td') ?? null
    if (cell) {
      e.preventDefault()
      const row = cell.parentElement as HTMLTableRowElement
      const cells = Array.from(row.children)
      const idx = cells.indexOf(cell)
      const nextCell = (e.shiftKey ? cells[idx - 1] : cells[idx + 1]) as HTMLElement | undefined
      if (nextCell) {
        // contenteditable 中 td 无法通过 focus() 聚焦，直接放置光标即可
        placeCaretStartIn(nextCell)
      } else {
        // 到行尾 → 跳下一行首单元格
        const table = cell.closest('table')
        const rows = Array.from(table?.querySelectorAll('tr') ?? [])
        const rowIdx = rows.indexOf(row)
        const targetRow = rows[rowIdx + (e.shiftKey ? -1 : 1)]
        if (targetRow) {
          const target = (e.shiftKey
            ? targetRow.children[targetRow.children.length - 1]
            : targetRow.children[0]) as HTMLElement | undefined
          if (target) placeCaretStartIn(target)
        }
      }
      return
    }
  }
  // 末块末尾向下 → 虚尾块
  if (e.key === 'ArrowDown' && i === blocks.value.length - 1) {
    const sel = window.getSelection()
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0)
      const el = e.currentTarget as HTMLElement
      const end = document.createRange()
      end.selectNodeContents(el)
      end.collapse(false)
      if (range.compareBoundaryPoints(Range.START_TO_START, end) === 0) {
        e.preventDefault()
        virtualEl.value?.focus()
      }
    }
  }
}

// ── 容器点击：任务框 / 公式 / 代码块 / 链接 ──
function onContainerClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  // 代码块：点击进入原位编辑（高亮层 + 透明 textarea 叠层，样式保持不变）
  const pre = target.closest('pre.code-wrap')
  if (pre) {
    e.preventDefault()
    startCodeEdit(blockIdxOf(pre as HTMLElement), 'code')
    return
  }
  const link = target.closest('a')
  if (link) {
    const href = link.getAttribute('href') || ''
    if (href.startsWith('#')) {
      e.preventDefault()
      const h = headings.value.find((x) => x.id === href.slice(1))
      if (h) {
        const el = scrollEl.value?.querySelector(`[data-block="${h.blockIndex}"]`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    } else if ((e.ctrlKey || e.metaKey || e.button === 1) && /^https?:\/\//i.test(href)) {
      e.preventDefault()
      window.luminAPI.shell.openExternal(href)
    }
    return
  }
  const math = target.closest('.md-math')
  if (math) {
    e.preventDefault()
    onMathClick(math as HTMLElement)
    return
  }
  const mermaid = target.closest('.md-mermaid')
  if (mermaid) {
    e.preventDefault()
    startCodeEdit(blockIdxOf(mermaid as HTMLElement), 'mermaid')
    return
  }
  const box = target.closest('input[type="checkbox"]')
  if (box) {
    e.preventDefault()
    toggleTask(box as HTMLInputElement)
    return
  }
  // 点击块间空白：聚焦最近编辑的块或虚尾块
  if (target.closest('.md-preview') && !target.closest('[data-block]')) {
    const idx = Math.min(lastActive.value, blocks.value.length - 1)
    const el = blockElOf(idx)
    if (el) {
      const rect = el.getBoundingClientRect()
      const below = e.clientY > rect.bottom
      if (below && idx === blocks.value.length - 1) {
        virtualEl.value?.focus()
      } else {
        el.focus()
      }
    } else {
      virtualEl.value?.focus()
    }
  }
}

// ── 公式点击 → 行内编辑 LaTeX 源码 ──
function onMathClick(span: HTMLElement): void {
  const input = document.createElement('input')
  input.className = 'md-math-input'
  input.value = span.dataset.tex ?? ''
  span.dataset.editing = 'true'
  span.replaceChildren(input)
  input.focus()
  input.select()
  const done = (): void => {
    span.dataset.tex = input.value
    delete span.dataset.editing
    const i = blockIdxOf(span)
    commitBlock(i)
  }
  input.addEventListener('blur', () => done())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      input.blur()
    }
  })
}

// ── 代码块 / Mermaid → 原位编辑（高亮层 + 透明 textarea）──
const codeEditLang = ref('')

/** 代码编辑态的实时高亮 HTML（textarea 透明文字，颜色由底层高亮层提供） */
const highlightedCode = computed(() => {
  const lang = codeEditLang.value
  if (lang && lang !== 'mermaid' && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(codeDraft.value, { language: lang }).value
    } catch {
      return escapeHtml(codeDraft.value)
    }
  }
  return escapeHtml(codeDraft.value)
})

function startCodeEdit(i: number, kind: 'code' | 'mermaid'): void {
  if (i < 0) return
  codeEditIdx.value = i
  if (kind === 'mermaid') {
    codeEditLang.value = 'mermaid'
    codeDraft.value = blocks.value[i]?.text ?? ''
  } else {
    const pre = scrollEl.value?.querySelector<HTMLElement>(`[data-block="${i}"] pre.code-wrap`)
    codeEditLang.value = pre?.dataset.lang ?? ''
    codeDraft.value = pre?.dataset.code
      ? decodeURIComponent(pre.dataset.code)
      : (blocks.value[i]?.text ?? '')
  }
  void nextTick(() => {
    const ta = scrollEl.value?.querySelector<HTMLTextAreaElement>('textarea.code-edit-input')
    ta?.focus()
    ta?.setSelectionRange(ta.value.length, ta.value.length)
  })
}

function commitCodeEdit(): void {
  const i = codeEditIdx.value
  if (i < 0) return
  codeEditIdx.value = -1
  const lang = codeEditLang.value
  codeEditLang.value = ''
  const content = files.current?.content ?? ''
  const a = analyzeDoc(content)
  const block = a.blocks[i]
  const md = '```' + (lang && lang !== 'mermaid' ? lang : 'mermaid') + '\n' + codeDraft.value + '\n```'
  if (block && md !== block.text) {
    files.setContent(replaceBlock(content, block, md))
  }
}

function onCodeKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
    e.preventDefault()
    ;(e.target as HTMLTextAreaElement).blur()
    return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    const ta = e.target as HTMLTextAreaElement
    ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end')
  }
}

// ── 任务切换 ──
function toggleTask(box: HTMLInputElement): void {
  const blockEl = box.closest<HTMLElement>('[data-block]')
  if (!blockEl) return
  const idx = Number(blockEl.dataset.block)
  const b = blocks.value[idx]
  if (!b) return
  const boxIndex = Array.from(blockEl.querySelectorAll('input[type="checkbox"]')).indexOf(box)
  const lines = b.text.split('\n')
  let seen = 0
  const next = lines
    .map((line) => {
      const m = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+/)
      if (m && seen++ === boxIndex) {
        const to = m[2].trim() ? ' ' : 'x'
        return line.replace(/\[([ xX])\]/, `[${to}]`)
      }
      return line
    })
    .join('\n')
  files.setContent(replaceBlock(files.current?.content ?? '', b, next))
}

// ── 标记符显隐：光标 / 选区与行内样式交互 ──
let revealRaf = 0
function updateReveal(): void {
  cancelAnimationFrame(revealRaf)
  revealRaf = requestAnimationFrame(() => {
    const root = scrollEl.value
    if (!root) return
    root.querySelectorAll('.md-reveal').forEach((n) => n.classList.remove('md-reveal'))
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || codeEditIdx.value >= 0) return
    const range = sel.getRangeAt(0)
    const activeBlock = root.querySelector<HTMLElement>(
      `[data-block="${editingIdx.value}"] .md-block-inner`
    )
    if (!activeBlock || !activeBlock.contains(range.commonAncestorContainer)) return
    const styleds = Array.from(
      activeBlock.querySelectorAll<HTMLElement>('strong, em, del, code')
    ).filter((s) => !s.closest('pre'))
    if (range.collapsed) {
      // 光标位于样式元素内部 → 显示其标记符；标题显示 # 标记符；表格单元格显示 | 标记符
      const node = range.startContainer
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
      const styled = el?.closest<HTMLElement>('strong, em, del, code')
      if (styled && !styled.closest('pre')) styled.classList.add('md-reveal')
      const heading = el?.closest<HTMLElement>('h1, h2, h3, h4, h5, h6')
      if (heading) heading.classList.add('md-reveal')
      const cell = el?.closest<HTMLElement>('th, td')
      if (cell) cell.classList.add('md-reveal')
    } else {
      // 选区与样式元素相交 → 显示其标记符
      for (const styled of styleds) {
        const sRange = document.createRange()
        sRange.selectNodeContents(styled)
        if (rangesIntersect(sRange, range)) styled.classList.add('md-reveal')
      }
    }
    updateCursor(activeBlock)
  })
}

function rangesIntersect(a: Range, b: Range): boolean {
  return (
    a.compareBoundaryPoints(Range.START_TO_END, b) <= 0 &&
    b.compareBoundaryPoints(Range.START_TO_END, a) <= 0
  )
}

function updateCursor(activeBlock: HTMLElement): void {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const range = sel.getRangeAt(0)
  const mdPrefix = serializePrefix(activeBlock, range.startContainer, range.startOffset)
  const lineStart = mdPrefix.lastIndexOf('\n')
  const idx = editingIdx.value
  const line = (blocks.value[idx]?.start ?? 0) + mdPrefix.split('\n').length
  const col = mdPrefix.length - lineStart
  ui.cursor = { line, col }
}

onMounted(() => {
  document.addEventListener('selectionchange', updateReveal)
})
onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', updateReveal)
  cancelAnimationFrame(revealRaf)
  for (const t of syncTimers.values()) clearTimeout(t)
})

// ── 滚动：大纲联动 ──
let outlineTimer: ReturnType<typeof setTimeout> | null = null
function onScroll(): void {
  if (outlineTimer) return
  outlineTimer = setTimeout(() => {
    outlineTimer = null
    const el = scrollEl.value
    if (!el) return
    const tops = Array.from(el.querySelectorAll<HTMLElement>('[data-heading]')).map((h) => ({
      idx: Number((h.closest('[data-block]') as HTMLElement)?.dataset.block ?? -1),
      top: h.getBoundingClientRect().top - el.getBoundingClientRect().top
    }))
    let active = -1
    for (const t of tops) {
      if (t.top <= 90) active = t.idx
      else break
    }
    if (active >= 0) ui.setActiveHeading(active)
  }, 80)
}

// ── 工具栏格式命令 ──
const INLINE_MAP = { bold: 'strong', italic: 'em', strike: 'del', inlineCode: 'code' } as const

watch(
  () => ui.formatCmd,
  (cmd) => {
    if (!cmd) return
    const i = editingIdx.value >= 0 && editingIdx.value < blocks.value.length
      ? editingIdx.value
      : Math.min(lastActive.value, blocks.value.length - 1)
    const el = blockElOf(i)
    if (!el) return
    const focused = el === document.activeElement || el.contains(document.activeElement)

    if (cmd.action in INLINE_MAP) {
      const tag = INLINE_MAP[cmd.action as keyof typeof INLINE_MAP]
      if (focused) {
        toggleInlineFormat(el, tag)
        return
      }
      // 未聚焦：聚焦块并将光标置于末尾后插入标记符占位
      focusEnd(el)
      void nextTick(() => toggleInlineFormat(el, tag))
      return
    }

    if (cmd.action === 'math') {
      focusEnd(el)
      void nextTick(() => {
        const sel = window.getSelection()
        const range = sel?.getRangeAt(0)
        if (!range) return
        const text = document.createTextNode('$x$')
        range.insertNode(text)
        range.setStart(text, 1)
        range.setEnd(text, 2)
        sel!.removeAllRanges()
        sel!.addRange(range)
      })
      return
    }

    // 块级操作：以当前 DOM 为真值源序列化 → Markdown 变换 → 重渲染
    const md = serializeBlock(el)
    const content = files.current?.content ?? ''
    const a = analyzeDoc(content)
    const block = a.blocks[i]
    if (!block) return
    let next: string
    if (['heading', 'quote', 'ul', 'ol', 'task'].includes(cmd.action)) {
      next = applyBlockFormat(md, cmd.action as 'heading' | 'quote' | 'ul' | 'ol' | 'task', 2)
    } else {
      next = applyBlockInsert(md, cmd.action as 'codeBlock' | 'table' | 'hr' | 'link' | 'image')
    }
    suppress.value = false
    cachedHtml.delete(i)
    files.setContent(replaceBlock(content, block, next))
    void nextTick(() => {
      const newEl = blockElOf(i)
      if (newEl) focusStart(newEl)
    })
  }
)

// ── 大纲跳转 ──
watch(
  () => ui.scrollToHeadingTick,
  () => {
    const idx = ui.headingToScroll
    if (idx == null) return
    const el = scrollEl.value?.querySelector(`[data-block="${idx}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
)

defineExpose({ scrollEl, blocks, headings })

function isHeading(i: number): boolean {
  return rendered.value[i].startsWith('<h')
}
</script>

<template>
  <div
    ref="scrollEl"
    class="h-full overflow-y-auto overflow-x-hidden"
    @click="onContainerClick"
    @scroll.passive="onScroll"
  >
    <div
      class="md-preview relative mx-auto px-6 pt-10 pb-40 transition-all duration-300"
      :class="ui.focusMode ? 'max-w-[760px]' : 'max-w-[880px]'"
    >
      <!-- 空文档占位 -->
      <div
        v-if="isEmpty && editingIdx === -1"
        class="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 select-none text-ink-3"
        style="animation: lm-breathe 2.4s ease-in-out infinite"
      >
        <div class="flex flex-col items-center gap-3">
          <Icon name="sparkles" :size="30" :stroke-width="1.4" class="opacity-60" />
          <span class="text-[14px] tracking-wide">{{ $t('editor.placeholder') }}</span>
        </div>
      </div>

      <template v-for="(_, i) in blocks" :key="i">
        <div class="md-block" :data-block="i">
          <!-- 代码块原位编辑：高亮层 + 透明 textarea（样式不变，输入逻辑原生可靠） -->
          <div v-if="codeEditIdx === i" class="code-edit-box mt-1">
            <pre class="code-edit-highlight" aria-hidden="true"><code class="hljs" v-html="highlightedCode" /></pre>
            <textarea
              v-model="codeDraft"
              class="code-edit-input"
              spellcheck="false"
              @keydown="onCodeKeydown"
              @input="scheduleSync(i)"
              @blur="commitCodeEdit"
            />
          </div>
          <div
            v-else
            class="md-block-inner"
            :data-heading="isHeading(i) ? 'true' : undefined"
            contenteditable="true"
            spellcheck="false"
            :data-placeholder="$t('editor.placeholder')"
            v-html="htmlFor(i)"
            @focusin="onBlockFocusIn(i, $event)"
            @focusout="onBlockFocusOut(i, $event)"
            @input="onBlockInput(i)"
            @beforeinput="onBeforeInput(i, $event)"
            @keydown="onBlockKeydown(i, $event)"
          />
        </div>
      </template>

      <!-- 虚尾块：文档末尾持续写作 -->
      <div class="md-block md-block-virtual" :data-block="blocks.length">
        <div
          ref="virtualEl"
          class="md-block-inner"
          contenteditable="true"
          spellcheck="false"
          :data-placeholder="$t('editor.continue')"
          @focusin="onVirtualFocusIn"
          @focusout="onVirtualBlur"
          @input="onVirtualInput"
          @keydown="onVirtualKeydown"
        />
      </div>
    </div>
  </div>
</template>
