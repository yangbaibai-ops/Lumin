// ─── Markdown 粘贴修复：块级解析 + 开放 Slice 闭合 ──────────────────────────
// 问题一：tiptap-markdown 自带的 clipboardTextParser 一律 inline 解析，块级
// 语法（# 标题等）无法成块（其 normalizeInline 只解包第一个 <p>）。
// 问题二（更深）：parseSlice 用 <body> 包裹解析会产出 openStart/openEnd>0 的
// 「开放 Slice」，replaceSelection 把开放边缘并入当前段落——粘贴出的标题被
// 吸进光标所在段落（不是 heading 节点 → 点击不出现标记符、块语义全丢）。
// 修复：
//   - 含换行或以块标记开头（#、>、-、*、+、```、~~~、数字列表、任务、表格）
//     的粘贴 → 块级解析，并把 Slice 显式闭合（openStart/openEnd=0），
//     让每个块成为独立节点；
//   - 单行行内内容（如 **加粗**）→ inline 解析，保持开放 Slice 并入当前段落；
//   - transformPasted 兜底：parseFromClipboard 的 normalizeSiblings/maxOpen
//     后处理会把块 Slice 重新算成开放结构，transformPasted 是插入前最后一
//     道钩子，在此闭合外部粘贴的文本块/引用/列表——编辑器内部复制粘贴的
//     合法开放结构（列表项、部分段落等）不受影响。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { DOMParser as PMDOMParser, Fragment, Slice } from '@tiptap/pm/model'
import type { EditorProps } from '@tiptap/pm/view'
import type { Node as PMNode, ResolvedPos, Slice as PMSlice } from '@tiptap/pm/model'
import type { Mark as PMMark } from '@tiptap/pm/model'
import { styleList } from './inlineMarks'

/** 块标记开头：粘贴以这些字符起头时即使单行也按块解析（单行 '# 标题' 也是块） */
const BLOCK_START = /^(#{1,6}\s|>\s?|[-*+]\s|```|~~~|\d{1,9}[.)]\s|\[[ xX]?\]\s|\|)/

/** 是否走块级解析 */
function needsBlockParse(text: string): boolean {
  const t = text.trim()
  if (t.includes('\n')) return true
  return BLOCK_START.test(t)
}

/** 同 tiptap-markdown：包一层 body 保留首尾空白 */
function elementFromString(value: string): HTMLElement {
  return new window.DOMParser().parseFromString(`<body>${value}</body>`, 'text/html').body
}

/** 块内容首节点闭合白名单：文本块（标题/段落/代码块）+ 引用 + 各类列表 */
function closableBlockName(name: string): boolean {
  return (
    name === 'blockquote' || name === 'bulletList' || name === 'orderedList' || name === 'taskList'
  )
}

/** 去掉 Fragment 内所有文本节点的「粗体」样式（legacy bold + mdStyle 集合里的 bold）。
    注意样式是集合：只把 bold 从集合里摘掉，别的样式（行内代码等）要留着。 */
function stripBoldMarks(frag: Fragment): Fragment {
  let changed = false
  const out: PMNode[] = []
  frag.forEach((child) => {
    if (child.isText) {
      let touched = false
      const kept: PMMark[] = []
      for (const m of child.marks) {
        if (m.type.name === 'bold') {
          touched = true
          continue
        }
        if (m.type.name === 'mdStyle' && styleList(m.attrs.styles).includes('bold')) {
          const rest = styleList(m.attrs.styles).filter((s) => s !== 'bold')
          touched = true
          if (rest.length) kept.push(m.type.create({ styles: rest }))
          continue
        }
        kept.push(m)
      }
      if (touched) {
        changed = true
        out.push(child.mark(kept))
      } else {
        out.push(child)
      }
    } else if (child.isInline) {
      const inner = stripBoldMarks(child.content)
      if (inner !== child.content) {
        changed = true
        out.push(child.copy(inner))
      } else {
        out.push(child)
      }
    } else {
      out.push(child)
    }
  })
  return changed ? Fragment.fromArray(out) : frag
}

/**
 * 标题本身即加粗样式——粘贴内容（HTML 来源的 h1<b>…</b> 或 Markdown 的
 * # **…**）落在标题节点内的 bold 标记一律剥除，源码保持干净的 `# 标题`，
 * 不出现 `# **标题**`。
 */
function stripBoldInHeadings(node: PMNode): PMNode {
  if (node.type.name === 'heading') {
    const content = stripBoldMarks(node.content)
    return content === node.content ? node : node.copy(content)
  }
  if (!node.content.size || node.isText) return node
  let changed = false
  const out: PMNode[] = []
  node.content.forEach((child) => {
    const next = stripBoldInHeadings(child)
    if (next !== child) changed = true
    out.push(next)
  })
  return changed ? node.copy(Fragment.fromArray(out)) : node
}

/** 重建 Slice（保持 openStart/openEnd 结构不变） */
function mapSlice(slice: PMSlice, fn: (node: PMNode) => PMNode): PMSlice {
  const out: PMNode[] = []
  let changed = false
  slice.content.forEach((child) => {
    const next = fn(child)
    if (next !== child) changed = true
    out.push(next)
  })
  return changed ? new Slice(Fragment.fromArray(out), slice.openStart, slice.openEnd) : slice
}

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  addProseMirrorPlugins() {
    const props = {
      clipboardTextParser: (
        text: string,
        $context: ResolvedPos,
        plain: boolean
      ): PMSlice | null => {
        if (plain || !text) return null
        const parser = (
          this.editor.storage as {
            markdown?: { parser?: { parse(text: string, opts?: { inline?: boolean }): string } }
          }
        ).markdown?.parser
        if (!parser) return null
        const block = needsBlockParse(text)
        const html = block ? parser.parse(text) : parser.parse(text, { inline: true })
        const slice = PMDOMParser.fromSchema(this.editor.schema).parseSlice(
          elementFromString(html),
          { preserveWhitespace: true, context: $context } as unknown as Parameters<
            PMDOMParser['parseSlice']
          >[1]
        )
        // 块级粘贴：显式闭合开放边缘（后处理会重新打开，最终由 transformPasted 兜底，
        // 这里闭合保证 parser 输出本身语义正确）
        if (block && (slice.openStart > 0 || slice.openEnd > 0)) {
          return new Slice(slice.content, 0, 0)
        }
        return slice
      },
      transformPasted: (slice: PMSlice): PMSlice => {
        // 1) 标题内 bold 剥除：粘贴标题不携带 **（标题本身即加粗）
        slice = mapSlice(slice, stripBoldInHeadings)
        // 2) 兜底闭合：parseFromClipboard 的 normalizeSiblings/maxOpen 后处理
        // 会把块内容 Slice 重新算成开放结构（openStart≥1），replaceSelection
        // 随之把首个块并入当前段落。transformPasted 是插入前最后一道钩子，
        // 在此把外部粘贴的文本块/引用/列表闭合为独立块；编辑器内部复制粘贴
        // 的合法开放结构（列表项、部分段落等）不受影响
        const first = slice.content.firstChild
        if (!slice.openStart || !first) return slice
        if (!(first.isTextblock || closableBlockName(first.type.name))) return slice
        return new Slice(slice.content, 0, 0)
      }
    }
    return [
      new Plugin({
        key: new PluginKey('markdownPaste'),
        props: props as unknown as EditorProps
      })
    ]
  }
})
