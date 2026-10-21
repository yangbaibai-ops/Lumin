// ─── AI 回答的轻量 Markdown 渲染模型（纯函数，单测直接跑）────────────────────────
//
// 为什么不用 `v-html` + 现成的 Markdown 库：
//   1. 模型输出是**不可信文本**，拼 HTML 就有注入面；这里所有文本都以 Vue 文本节点
//      插值渲染（`{{ }}`），永远不产生裸 HTML；
//   2. 需求只要「段落、列表、代码块、行内代码；公式按纯文本 + 代码块处理」，
//      一个 200 行的行扫描器足够，也不必把 marked / markdown-it 拉进首屏 chunk
//      （markdown-it 已经在 tiptap-markdown 里，但那是编辑器内核的依赖）。
//
// 支持：ATX 标题、围栏代码块（``` / ~~~，可带语言）、有序/无序列表、
// 引用、分隔线、段落；行内：`code`、**strong**、*em*、~~del~~。
// 公式 `$…$` / `$$…$$` 按纯文本原样显示（不解释成 HTML/KaTeX）。

export type AiInlineKind = 'text' | 'code' | 'strong' | 'em' | 'del'

export interface AiInlineToken {
  kind: AiInlineKind
  text: string
}

export type AiBlock =
  | { type: 'paragraph'; content: string }
  | { type: 'heading'; level: number; content: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; content: string }
  | { type: 'hr' }

const FENCE = /^\s*(```+|~~~+)\s*([\w#+.-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const UL = /^\s*[-*+]\s+(.*)$/
const OL = /^\s*\d{1,9}[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/

/**
 * 把 Markdown 切成块。**流式友好**：未闭合的围栏会把后面的内容都当成代码块
 * （用户看到的是"正在写的代码块"，而不是一闪一闪的解析错误）。
 */
export function parseAiMarkdown(markdown: string): AiBlock[] {
  const src = String(markdown ?? '').replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  const blocks: AiBlock[] = []
  let i = 0

  const pushParagraph = (buf: string[]): void => {
    const content = buf.join('\n').trim()
    if (content) blocks.push({ type: 'paragraph', content })
  }

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    // 围栏代码块（未闭合时一直吃到结尾）
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const lang = fence[2] || ''
      const code: string[] = []
      i += 1
      while (i < lines.length) {
        const close = new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])
        if (close) {
          i += 1
          break
        }
        code.push(lines[i])
        i += 1
      }
      blocks.push({ type: 'code', lang, code: code.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, content: heading[2].trim() })
      i += 1
      continue
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      const buf: string[] = [quote[1]]
      i += 1
      while (i < lines.length) {
        const next = QUOTE.exec(lines[i])
        if (!next) break
        buf.push(next[1])
        i += 1
      }
      blocks.push({ type: 'quote', content: buf.join('\n').trim() })
      continue
    }

    const ul = UL.exec(line)
    const ol = OL.exec(line)
    if (ul || ol) {
      const ordered = !!ol
      const items: string[] = []
      while (i < lines.length) {
        const m = ordered ? OL.exec(lines[i]) : UL.exec(lines[i])
        if (!m) break
        // 续行（缩进的非列表行）并进当前项，保留换行
        let item = m[1]
        i += 1
        while (i < lines.length && lines[i].trim() && !UL.test(lines[i]) && !OL.test(lines[i])) {
          if (/^\s+/.test(lines[i])) {
            item += '\n' + lines[i].trim()
            i += 1
          } else break
        }
        items.push(item.trim())
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // 普通段落：吃到空行或下一个块起点
    const buf: string[] = [line]
    i += 1
    while (i < lines.length) {
      const cur = lines[i]
      if (!cur.trim()) break
      if (
        FENCE.test(cur) ||
        HEADING.test(cur) ||
        HR.test(cur) ||
        QUOTE.test(cur) ||
        UL.test(cur) ||
        OL.test(cur)
      ) {
        break
      }
      buf.push(cur)
      i += 1
    }
    pushParagraph(buf)
  }
  return blocks
}

/**
 * 行内解析：支持 `` `code` ``、`**strong**`、`*em*` / `_em_`、`~~del~~`。
 * 未闭合的标记按普通文本处理（流式时经常发生，不能让它吞掉后文）。
 */
export function parseAiInline(text: string): AiInlineToken[] {
  const src = String(text ?? '')
  const out: AiInlineToken[] = []
  let buf = ''
  let i = 0

  const flush = (): void => {
    if (buf) {
      out.push({ kind: 'text', text: buf })
      buf = ''
    }
  }
  const readUntil = (marker: string, from: number): number => {
    const at = src.indexOf(marker, from)
    return at
  }

  while (i < src.length) {
    const ch = src[i]
    if (ch === '`') {
      const at = src.indexOf('`', i + 1)
      if (at > i + 1) {
        flush()
        out.push({ kind: 'code', text: src.slice(i + 1, at) })
        i = at + 1
        continue
      }
    } else if (ch === '*' && src[i + 1] === '*') {
      const at = readUntil('**', i + 2)
      if (at > i + 2) {
        flush()
        out.push({ kind: 'strong', text: src.slice(i + 2, at) })
        i = at + 2
        continue
      }
    } else if (ch === '~' && src[i + 1] === '~') {
      const at = readUntil('~~', i + 2)
      if (at > i + 2) {
        flush()
        out.push({ kind: 'del', text: src.slice(i + 2, at) })
        i = at + 2
        continue
      }
    } else if (ch === '*' || ch === '_') {
      const marker = ch
      const at = src.indexOf(marker, i + 1)
      if (at > i + 1 && src[i + 1] !== ' ') {
        flush()
        out.push({ kind: 'em', text: src.slice(i + 1, at) })
        i = at + 1
        continue
      }
    }
    buf += ch
    i += 1
  }
  flush()
  return out
}
