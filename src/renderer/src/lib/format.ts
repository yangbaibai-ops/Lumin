// ─── 文本格式化工具（源码编辑器与所见即所得编辑块共用）────────────────────

export interface Selection {
  start: number
  end: number
}

export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'heading'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'task'
  | 'codeBlock'
  | 'link'
  | 'image'
  | 'table'
  | 'hr'
  | 'math'

const INLINE: Record<string, { before: string; after: string; placeholder: string }> = {
  bold: { before: '**', after: '**', placeholder: '加粗文本' },
  italic: { before: '*', after: '*', placeholder: '斜体文本' },
  strike: { before: '~~', after: '~~', placeholder: '删除文本' },
  inlineCode: { before: '`', after: '`', placeholder: 'code' },
  math: { before: '$', after: '$', placeholder: 'E = mc^2' }
}

export interface FormatResult {
  text: string
  start: number
  end: number
}

/** 行内包裹：加粗/斜体/删除线/行内代码/行内公式 */
export function wrapInline(
  text: string,
  sel: Selection,
  action: 'bold' | 'italic' | 'strike' | 'inlineCode' | 'math'
): FormatResult {
  const cfg = INLINE[action]
  const selected = text.slice(sel.start, sel.end)
  const content = selected || cfg.placeholder
  const next = text.slice(0, sel.start) + cfg.before + content + cfg.after + text.slice(sel.end)
  const start = sel.start + cfg.before.length
  const end = start + content.length
  return { text: next, start, end }
}

/** 行首前缀切换：无序/有序/任务列表、引用 */
export function toggleLinePrefix(
  text: string,
  sel: Selection,
  kind: 'ul' | 'ol' | 'task' | 'quote'
): FormatResult {
  const lineStart = text.lastIndexOf('\n', sel.start - 1) + 1
  const lineEndIdx = text.indexOf('\n', sel.end)
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx
  const line = text.slice(lineStart, lineEnd)
  const prefixes: Record<string, string> = {
    ul: '- ',
    ol: '1. ',
    task: '- [ ] ',
    quote: '> '
  }
  const prefix = prefixes[kind]

  let newLine: string
  let delta: number
  if (line.startsWith(prefix)) {
    newLine = line.slice(prefix.length)
    delta = -prefix.length
  } else {
    // 去除已有的同类标记再添加
    const cleaned = line.replace(/^(\s*)([-*+] |\d+\. |- \[[ xX]\] |> )+/, '$1')
    newLine = prefix + cleaned
    delta = prefix.length
  }
  const next = text.slice(0, lineStart) + newLine + text.slice(lineEnd)
  return {
    text: next,
    start: Math.max(lineStart, sel.start + delta),
    end: Math.max(lineStart, sel.end + delta)
  }
}

/** 标题：切换当前行 / 选中块为 # 标题 */
export function toggleHeading(text: string, sel: Selection, level = 2): FormatResult {
  const lineStart = text.lastIndexOf('\n', sel.start - 1) + 1
  const lineEndIdx = text.indexOf('\n', sel.end)
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx
  const line = text.slice(lineStart, lineEnd)
  const marker = '#'.repeat(level) + ' '

  let newLine: string
  if (line.startsWith(marker)) {
    newLine = line.slice(marker.length)
  } else {
    newLine = marker + line.replace(/^#{1,6}\s+/, '')
  }
  const next = text.slice(0, lineStart) + newLine + text.slice(lineEnd)
  return { text: next, start: lineStart, end: lineStart + newLine.length }
}

/** 块级操作：代码块 / 表格 / 分割线 / 链接 / 图片（作用于选中文本或整块） */
export function blockAction(text: string, sel: Selection, action: FormatAction): FormatResult {
  const selected = text.slice(sel.start, sel.end) || text
  switch (action) {
    case 'codeBlock': {
      const next =
        text.slice(0, sel.start) +
        `\`\`\`\n${selected.trim() || 'code'}\n\`\`\`` +
        text.slice(sel.end)
      return { text: next, start: sel.start + 4, end: sel.start + 4 + selected.trim().length }
    }
    case 'table': {
      const snippet = '| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n'
      const next = text.slice(0, sel.start) + snippet + text.slice(sel.end)
      return { text: next, start: sel.start + snippet.length, end: sel.start + snippet.length }
    }
    case 'hr': {
      const snippet = '\n---\n'
      const next = text.slice(0, sel.start) + snippet + text.slice(sel.end)
      return { text: next, start: sel.start + snippet.length, end: sel.start + snippet.length }
    }
    case 'link': {
      const snippet = `[${selected.trim() || '链接文字'}](https://)`
      const next = text.slice(0, sel.start) + snippet + text.slice(sel.end)
      const linkStart = sel.start + snippet.indexOf('https://')
      return { text: next, start: linkStart, end: linkStart + 8 }
    }
    case 'image': {
      const snippet = `![${selected.trim() || '图片描述'}](path/to/image.png)`
      const next = text.slice(0, sel.start) + snippet + text.slice(sel.end)
      return { text: next, start: sel.start + snippet.length, end: sel.start + snippet.length }
    }
    default: {
      return { text, start: sel.start, end: sel.end }
    }
  }
}

/** 块级标题 / 引用 / 列表类操作入口（作用于块文本） */
export function applyBlockFormat(
  blockText: string,
  action: 'heading' | 'quote' | 'ul' | 'ol' | 'task',
  level?: number
): string {
  switch (action) {
    case 'heading':
      return toggleHeading(blockText, { start: 0, end: blockText.length }, level ?? 2).text
    case 'quote':
      return toggleLinePrefix(blockText, { start: 0, end: blockText.length }, 'quote').text
    case 'ul':
      return toggleLinePrefix(blockText, { start: 0, end: blockText.length }, 'ul').text
    case 'ol':
      return toggleLinePrefix(blockText, { start: 0, end: blockText.length }, 'ol').text
    case 'task':
      return toggleLinePrefix(blockText, { start: 0, end: blockText.length }, 'task').text
    default:
      return blockText
  }
}

/** 块级插入操作入口 */
export function applyBlockInsert(
  blockText: string,
  action: 'codeBlock' | 'table' | 'hr' | 'link' | 'image'
): string {
  return blockAction(blockText, { start: 0, end: blockText.length }, action).text
}
