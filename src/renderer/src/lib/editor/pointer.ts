// ─── 鼠标语义：Ctrl/Cmd+左键与链接交互（Typora 同款）───────────────────────
//
// 1) PM 内置 selectNodeModifier（Win: ctrlKey / Mac: metaKey）：Ctrl/Cmd+左键
//    会把光标所在文本块 NodeSelection 整选（.ProseMirror-selectednode 全选框）
//    ——Typora 没有，须拦截：非链接处 Ctrl/Cmd+左键退化为普通光标落点。
// 2) 链接（Typora 官方行为）：
//    - Ctrl/Cmd + 左键点击链接 → 交给系统默认浏览器打开（shell.openExternal）；
//    - 普通左键点击链接（不按修饰键）→ 该链接「原地展开」为可编辑源码形态：
//      `[` 与 `](网址)` 等新增字符以浅灰（linkSource/syntax）呈现、**原文链接
//      标签保持链接外观（主题色 + 下边框）**、光标停在点击处且不自动选中任何
//      文本（Typora md-raw-inline 同款）。光标移出展开区（或按 Esc / 编辑器
//      失焦）自动折叠还原为链接——往返序列化恒等于 `[文字](网址)`。
//
// 实现要点：
// - 展开不是「整体替换成一段纯文本」，而是把原 label 上的 link mark 换成
//   linkSource(part:'label')（保留其内 mdStyle/mdMarker 等标记，序列化各 mark
//   的 open/close 均为空 → 输出仍是原 label 字符），在两侧补 linkSource
//   (part:'syntax') 的 `[`、`](url)` 文本——因此标签可见样式不变、其余灰显；
// - 折叠：把展开区整体文本解析回 `[label](url)`，以 link mark 重建 label，
//   内部 `**` 等由派生归一化（typoraInlineMarks）自动还原；
// - 自动折叠在 appendTransaction 里按「光标是否仍在展开区」判定，一次折叠
//   一个区域、无循环；mousedown 内同步 dispatch 会导致 PM DOM 不重建
//   （须 setTimeout(0) 延后），且展开前先落光标再展开以保持“点到哪光标在哪”。
import { Extension, Mark } from '@tiptap/core'
import type { RawCommands } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, NodeSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'

// 自定义命令类型声明（tiptap v3 命令合并，命名空间形式）
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    typoraPointer: {
      collapseLinkSources: () => ReturnType
    }
  }
}

/** 链接展开区标记（attrs.part）：
    - part:'label' → 原链接文字，保留链接外观（.md-link-source：主题色 + 下边框）；
    - part:'syntax' → `[`、`](`、网址、`)` 等新增字符（.md-link-syntax：浅灰）。
    序列化 open/close 为空且不转义，保证展开期间文档源码与折叠后、与磁盘一致。
    注意：PM 的 mark 渲染必须有 toDOM（renderHTML）——缺省会抛
    `mark.type.spec.toDOM is not a function`，事务进了 state 但 DOM 构建中断
    （视图停在旧 DOM，状态与视图失同步）。 */
export const LinkSource = Mark.create({
  name: 'linkSource',
  addAttributes() {
    return {
      part: { default: 'label' },
      href: { default: '' }
    }
  },
  renderHTML({ HTMLAttributes }) {
    const part = HTMLAttributes.part === 'syntax' ? 'syntax' : 'label'
    return ['span', { class: part === 'syntax' ? 'md-link-syntax' : 'md-link-source' }, 0]
  },
  parseHTML() {
    // DOM → 文档回读还原 linkSource（避免 DOMObserver 把 span 解析回纯文本，
    // 与文档比对不一致触发 readDOMChange 回写循环）
    return [
      { tag: 'span.md-link-source', priority: 60, getAttrs: () => ({ part: 'label', href: '' }) },
      { tag: 'span.md-link-syntax', priority: 60, getAttrs: () => ({ part: 'syntax', href: '' }) }
    ]
  },
  addStorage() {
    return { markdown: { serialize: { open: () => '', close: () => '', escape: false } } }
  }
})

const pluginKey = new PluginKey('typora-pointer-link')

interface TextRun {
  from: number // 起点（含）
  to: number // 终点（不含）
  href?: string
}

/** 收集文档内连续命中某 mark 的文本区间（相邻同 href 文本节点合并——
    展开区 label/syntax 各节点同 href，合并为整段 [..](url) 供折叠回读） */
function collectMarkRuns(doc: PMNode, markName: string): TextRun[] {
  const runs: TextRun[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    let cur: TextRun | null = null
    node.content.forEach((child, offset) => {
      if (!child.isText) {
        cur = null
        return
      }
      const m = child.marks.find((mk) => mk.type.name === markName)
      if (!m) {
        cur = null
        return
      }
      const href = m.attrs.href as string | undefined
      const abs = pos + 1 + offset
      if (cur && cur.to === abs && (cur.href ?? '') === (href ?? '')) {
        cur.to = abs + child.nodeSize
      } else {
        cur = { from: abs, to: abs + child.nodeSize, href }
        runs.push(cur)
      }
    })
  })
  return runs
}

function runAt(doc: PMNode, pos: number, markName: string): TextRun | null {
  return collectMarkRuns(doc, markName).find((r) => pos >= r.from && pos < r.to) ?? null
}

/** 展开：link mark → linkSource(part:'label')（保留 label 内其他标记），
    两侧补 `[`、`](url)`（part:'syntax'）。不改变选区——PM 自动把光标按步骤
    映射进展开后的 label，光标停在被点击处、不做任何选中。 */
function expandRun(view: { state: import('@tiptap/pm/state').EditorState; dispatch: (tr: import('@tiptap/pm/state').Transaction) => void }, run: TextRun): void {
  const { state } = view
  const schema = state.schema
  const linkMark = schema.marks.link
  const ls = schema.marks.linkSource
  const href = run.href ?? ''
  const { from, to } = run
  const tr = state.tr
  // 1) label 换标：去掉 link、盖上 linkSource(label)
  tr.removeMark(from, to, linkMark)
  tr.addMark(from, to, ls.create({ part: 'label', href }))
  // 2) 前置 '['、后置 '](' + href + ')'，均为 syntax 灰显
  tr.insert(from, schema.text('[', [ls.create({ part: 'syntax', href })]))
  tr.insert(to + 1, schema.text('](' + href + ')', [ls.create({ part: 'syntax', href })]))
  view.dispatch(tr)
}

/** 折叠：解析展开区当前整体文本为 `[label](url)` → 以 link mark 重建 label
    （内部 `**` 等由派生归一化还原）；解析失败（用户改残）→ 仅去掉 linkSource
    标记保留原文。 */
function collapseRun(tr: import('@tiptap/pm/state').Transaction, doc: PMNode, run: TextRun): void {
  const schema = doc.type.schema
  const raw = doc.textBetween(run.from, run.to, '')
  const lb = raw.lastIndexOf('](')
  const ok = raw.startsWith('[') && lb > 0 && raw.endsWith(')')
  if (ok) {
    const label = raw.slice(1, lb)
    const href = raw.slice(lb + 2, raw.length - 1)
    tr.replaceWith(run.from, run.to, schema.text(label, [schema.marks.link.create({ href })]))
  } else {
    tr.removeMark(run.from, run.to, schema.marks.linkSource)
  }
}

/** 折叠全部展开区（Esc / 失焦 / 点击他处后由 appendTransaction 调用）；
    返回是否需要派发。caretInside=true 时即使光标仍在展开区也强制折叠 */
function collapseAll(
  state: import('@tiptap/pm/state').EditorState,
  dispatch: ((tr: import('@tiptap/pm/state').Transaction) => void) | undefined,
  caretInside = false
): boolean {
  const runs = collectMarkRuns(state.doc, 'linkSource')
  if (!runs.length) return false
  if (!dispatch) return true
  const sel = state.selection
  const tr = state.tr
  // 逆序替换，位置稳定
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    if (!caretInside && sel.from >= r.from && sel.from <= r.to) continue // 光标仍在展开区
    collapseRun(tr, state.doc, r)
  }
  if (!tr.docChanged) return false
  // 光标按步骤映射（在折叠区内的位置映射到新 label 内），无需手工设置
  dispatch(tr)
  return true
}

export const TyporaPointer = Extension.create({
  name: 'typoraPointer',
  addCommands() {
    // 运行时平铺返回（CommandManager 直接展开顶层键）；类型经声明合并拍平
    return {
      /** 折叠当前所有链接展开区（Esc/失焦调用） */
      collapseLinkSources: () => ({ state, dispatch }: {
        state: import('@tiptap/pm/state').EditorState
        dispatch: (tr: import('@tiptap/pm/state').Transaction) => void
      }) => collapseAll(state, dispatch, true)
    } as unknown as Partial<RawCommands>
  },
  addKeyboardShortcuts() {
    return {
      // Esc：退出链接源码编辑态，还原为链接
      Escape: () => this.editor.commands.collapseLinkSources()
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        appendTransaction: (_transactions, _oldState, newState) => {
          try {
            // 光标移出展开区 → 自动折叠还原为链接
            const runs = collectMarkRuns(newState.doc, 'linkSource')
            if (!runs.length) return null
            const sel = newState.selection
            if (runs.every((r) => sel.from >= r.from && sel.from <= r.to)) return null
            const tr = newState.tr
            for (let i = runs.length - 1; i >= 0; i--) {
              const r = runs[i]
              if (sel.from >= r.from && sel.from <= r.to) continue
              collapseRun(tr, newState.doc, r)
            }
            return tr.docChanged ? tr : null
          } catch {
            return null
          }
        },
        // 文本块（段落/标题等）绝不允许成为 NodeSelection（会把整段套上
        // .ProseMirror-selectednode 的紫色框——Typora 无此交互）。一旦有
        // 事务试图选中文本块，降级为普通文本光标（节点级整选仅保留给
        // 图片等叶子节点）。注意 filterTransaction 先于 dispatch 应用。
        filterTransaction(tr) {
          const sel = tr.selection
          if (sel instanceof NodeSelection && sel.node && sel.node.isTextblock) {
            try {
              tr.setSelection(TextSelection.near(tr.doc.resolve(sel.from)))
            } catch {
              /* 落点非法则保持原样（由 PM 兜底） */
            }
          }
          return true
        },
        props: {
          handleDOMEvents: {
            // 失焦：若有展开区先折叠（再让 blur 正常发生）
            blur(view) {
              collapseAll(view.state, (tr) => view.dispatch(tr), true)
              return false
            },
            mousedown(view, event) {
              if (event.button !== 0) return false
              const mod = event.ctrlKey || event.metaKey
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
              const ppos = pos ? pos.pos : -1
              const linkRun = ppos >= 0 ? runAt(view.state.doc, ppos, 'link') : null

              if (mod) {
                // Ctrl/Cmd+左键：链接 → 系统浏览器打开；非链接 → 普通光标落点
                if (linkRun?.href) {
                  event.preventDefault()
                  if (typeof window !== 'undefined' && window.luminAPI?.shell?.openExternal) {
                    window.luminAPI.shell.openExternal(linkRun.href)
                  }
                  return true
                }
                event.preventDefault()
                if (ppos >= 0) {
                  const sel = TextSelection.near(view.state.doc.resolve(ppos))
                  if (!view.state.selection.eq(sel)) {
                    view.dispatch(view.state.tr.setSelection(sel))
                  }
                }
                view.focus()
                return true
              }

              // 普通左键：点击链接 → 展开源码。
              // 注意：不能在 mousedown 事件回调里同步 dispatch（实测 PM 的
              // DOM 不随事务重建，视图停留旧 DOM），用 setTimeout(0) 延后；
              // 且需先落光标（点到哪光标在哪）再展开，避免选区留在旧位置
              if (linkRun && ppos >= 0) {
                event.preventDefault()
                setTimeout(() => {
                  if (view.isDestroyed) return
                  const sel = TextSelection.near(view.state.doc.resolve(ppos))
                  if (!view.state.selection.eq(sel)) {
                    view.dispatch(view.state.tr.setSelection(sel))
                  }
                  const cur = runAt(view.state.doc, ppos, 'link')
                  if (cur) expandRun(view, cur)
                  view.focus()
                }, 0)
                return true
              }
              return false
            }
          }
        }
      })
    ]
  }
})
