import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'

/**
 * ─── 插入 / 编辑链接（工具栏按钮与编辑器右键菜单**共用这一份实现**）────────────
 *
 * 用户口径（本轮）：
 *   * **有选区**：点「插入链接」→ 弹窗**只要链接**（锚文字 = 选中的文字，不再让人重复输入）；
 *   * **无选区**：弹窗要**锚文字 + 链接**两个输入；锚文字留空 → 以链接地址作锚文字
 *     （Markdown 里 `[地址](地址)` 是最省事又能看出指向的形态；要写别的再填一格就行）；
 *   * **光标在既有链接上**：同一个弹窗进入「编辑」语义（预填地址与锚文字，并给「移除链接」）。
 *
 * 为什么单独一个模块、而不是在 Toolbar 与 actions.ts 里各写一遍：这两处此前各有一份实现，
 * 已经漂移过（一处预填 `https://`、一处不预填，且都只弹一个字段）。链接的"选区→锚文字"
 * 规则只该有一份，否则下一轮改口径必然只改到一半。
 *
 * 与**内核**的边界：链接 mark 的协议白名单/URL 校验仍然由 Link 扩展的 `setLink` 负责
 * （`editor.can().setLink()` 是它的干跑形态），本模块不自己写一套协议判定；
 * 「把一段文字变成带 link mark 的文本」这一原语与 `lib/editor/inputRules.ts` 的
 * markdown 链接输入规则**同源**（`schema.text(label, [linkType.create({href})])`）。
 */

/** 弹窗标题的 i18n 键：有既有链接 = 编辑，否则 = 插入 */
export type LinkTitleKey = 'editorMenu.linkPrompt' | 'editorMenu.linkEditPrompt'

/** 交给宿主（ui store）去弹的那个对话框需要的一切 */
export interface LinkDialogRequest {
  titleKey: LinkTitleKey
  /**
   * 是否需要「锚文字」输入框。
   * false = 有选区：锚文字就是选中的文字，弹窗里**不该**再出现第二个输入框。
   */
  withAnchor: boolean
  /** 是否显示「移除链接」（光标/选区落在既有链接上） */
  canRemove: boolean
  /** 锚文字预填（编辑既有链接 = 原链接文字；插入新链接 = 空） */
  anchor: string
  /** 链接地址预填（编辑既有链接 = 原 href；插入新链接 = 空，靠 placeholder 提示 https://） */
  url: string
  /** 有选区时的选中文字（只读展示用；无选区时为空串） */
  selectionText: string
  /**
   * 提交前的地址校验。宿主在弹窗里就地调用它，好让"不支持这个协议"这种错**留在弹窗里**，
   * 而不是关掉弹窗后什么都不发生。实现复用 Link 扩展的白名单（见 `isAcceptableHref`）。
   */
  validate: (url: string) => boolean
}

export type LinkDialogResult =
  { action: 'apply'; anchor: string; url: string } | { action: 'remove' }

/** 宿主注入的"弹一个链接对话框"（工具栏走 ui store；动作目录走依赖注入） */
export type LinkAsker = (req: LinkDialogRequest) => Promise<LinkDialogResult | null>

/** 文档里一段连续、同 href 的链接文本（绝对位置，`to` 不含） */
interface LinkRun {
  from: number
  to: number
  href: string
}

interface LinkContext {
  /** 有选区（非空选区） */
  hasSelection: boolean
  selectionText: string
  /** 光标/选区所在的整条链接；不在链接上则为 null */
  run: LinkRun | null
}

/**
 * 找出 `pos` 处那条链接的完整范围（文本块内连续同 href 的文本节点合并）。
 * 不用 `getMarkRange`：它按「光标右侧的节点」取 mark，光标停在链接**末尾**时取不到，
 * 而"插入完链接光标正停在末尾、再按一次想改它"恰恰是最常见的路径。
 * 口径：`from <= pos <= to` 都算在这条链接上（贴任一端也算 —— 见上面的说明）。
 */
function linkRunAt(doc: PMNode, pos: number): LinkRun | null {
  let found: LinkRun | null = null
  doc.descendants((node, blockPos) => {
    if (found || !node.isTextblock) return
    if (pos < blockPos || pos > blockPos + node.nodeSize) return
    let cur: LinkRun | null = null
    node.forEach((child, offset) => {
      const abs = blockPos + 1 + offset
      const mark = child.isText ? child.marks.find((m) => m.type.name === 'link') : undefined
      if (!mark) {
        cur = null
        return
      }
      const href = typeof mark.attrs.href === 'string' ? mark.attrs.href : ''
      if (cur && cur.to === abs && cur.href === href) cur.to = abs + child.nodeSize
      else cur = { from: abs, to: abs + child.nodeSize, href }
      if (pos >= cur.from && pos <= cur.to) found = cur
    })
  })
  return found
}

/** 当前选区/光标处的链接上下文（弹窗要预填什么、要不要锚文字输入框，全由它决定） */
function readLinkContext(editor: Editor): LinkContext {
  const state = editor.state
  const { from, to, empty } = state.selection
  const hasSelection = !empty
  return {
    hasSelection,
    // 跨块选区用空格连接（与弹窗里那行只读提示一致）
    selectionText: hasSelection ? state.doc.textBetween(from, to, ' ') : '',
    run: linkRunAt(state.doc, from)
  }
}

/**
 * 光标落在「链接源码展开态」里时先折叠回真正的链接。
 *
 * 为什么需要：本应用**普通左键点一下链接就会把它展开成 `[文字](网址)` 源码**
 * （见 `lib/editor/pointer.ts`），此时光标周围的 mark 是 `linkSource` 而不是 `link` ——
 * 直接按"新插入一条"处理，会把新文字插进 `[文字](网址)` 中间，把源码构造拆坏。
 * 折叠用的就是内核既有命令（Esc 与它同一个），不另写一份展开区解析。
 */
function collapseExpandedLinkSource(editor: Editor): void {
  const state = editor.state
  const from = state.selection.from
  let inside = false
  state.doc.nodesBetween(Math.max(0, from - 1), from + 1, (node) => {
    if (node.isText && node.marks.some((m) => m.type.name === 'linkSource')) inside = true
  })
  if (inside) editor.commands.collapseLinkSources()
}

/**
 * 地址是否可接受 —— **复用 Link 扩展的白名单**（`javascript:` 这类会被它挡掉，
 * 与旧的 `setLink` 路径完全同一条判定，见 `tools/_verify-link-open.js` 的
 * `editor-rejects-javascript-link`）。
 *
 * 用 `can()` 干跑：它不落文档，只回答"这条命令会不会成功"。
 */
function isAcceptableHref(editor: Editor, href: string): boolean {
  try {
    return editor.can().setLink({ href }) === true
  } catch {
    return false
  }
}

/** 把 `[anchor](url)` 写成文档里的一段带 link mark 的文本（插入新链接 / 改既有链接都用它） */
function applyLinkedText(
  editor: Editor,
  anchor: string,
  url: string,
  run: LinkRun | null
): boolean {
  const { state, view } = editor
  const linkType = state.schema.marks.link
  if (!linkType) return false
  const from = run ? run.from : state.selection.from
  const to = run ? run.to : state.selection.to
  const tr = state.tr
  // 与 inputRules.ts 的 markdown 链接同一条原语：整段替换为「带 link mark 的文字」
  tr.replaceWith(from, to, state.schema.text(anchor, [linkType.create({ href: url })]))
  tr.setSelection(TextSelection.create(tr.doc, from + anchor.length))
  // 必须清 storedMarks：光标停在带 mark 文本右边界时 PM 会沿用该处的 mark，紧接着输入的字
  // 会被吞进链接里（inputRules.ts 同一处坑，那里的注释也记着这条）
  tr.setStoredMarks([])
  view.dispatch(tr)
  view.focus()
  return true
}

/** 移除链接：锚文字留下、链接消失（有选区时按整条链接算） */
function removeLink(editor: Editor, ctx: LinkContext): boolean {
  const run = ctx.run
  if (!run) return false
  if (ctx.hasSelection) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return true
  }
  const { state, view } = editor
  const label = state.doc.textBetween(run.from, run.to, ' ')
  if (!label) return false
  const tr = state.tr
  tr.replaceWith(run.from, run.to, state.schema.text(label))
  tr.setSelection(TextSelection.create(tr.doc, run.from + label.length))
  tr.setStoredMarks([])
  view.dispatch(tr)
  view.focus()
  return true
}

/**
 * 「插入链接」的完整流程：读上下文 → 弹窗（宿主注入）→ 落到文档。
 *
 * @returns 是否真的改动了文档（动作目录拿它决定要不要记一次使用频次）
 */
export async function insertOrEditLink(editor: Editor, ask: LinkAsker): Promise<boolean> {
  collapseExpandedLinkSource(editor)
  const ctx = readLinkContext(editor)
  const textAtLink = ctx.run ? editor.state.doc.textBetween(ctx.run.from, ctx.run.to, ' ') : ''
  const editing = !!ctx.run
  const res = await ask({
    titleKey: editing ? 'editorMenu.linkEditPrompt' : 'editorMenu.linkPrompt',
    // 有选区 = 锚文字已经确定（选中的文字），弹窗里不再出现第二个输入框
    withAnchor: !ctx.hasSelection,
    canRemove: editing,
    anchor: editing && !ctx.hasSelection ? textAtLink : '',
    url: ctx.run ? ctx.run.href : '',
    selectionText: ctx.selectionText,
    validate: (url) => isAcceptableHref(editor, url)
  })
  if (!res) return false
  if (res.action === 'remove') return removeLink(editor, ctx)
  const url = res.url.trim()
  if (!url) return false
  // 与旧路径同一条协议白名单；弹窗里 `validate` 已经拦过一道，这里是第二道（防宿主漏判）
  if (!isAcceptableHref(editor, url)) return false
  if (ctx.hasSelection) {
    // 有选区：锚文字 = 选中的文字，直接走既有命令（它自己会带白名单校验）
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    return true
  }
  // 无选区：锚文字留空 → 以链接地址作锚文字
  const anchor = res.anchor.trim() || url
  return applyLinkedText(editor, anchor, url, ctx.run)
}
