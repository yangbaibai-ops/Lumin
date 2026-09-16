import { defineStore } from 'pinia'
import { findMatches, replaceMatches, stepIndex, type Match } from '../lib/findReplace'
import { findInDoc } from '../lib/editor/findInDoc'
import { useEditorStore } from './editor'
import { useFilesStore } from './files'
import { useUiStore } from './ui'

/**
 * ─── 编辑器内查找 / 替换 ────────────────────────────────────────────────────
 *
 * 两个编辑面共用一份查询状态，但**匹配在各自的坐标系里算**：
 *   * `source`（源码模式）：在 `files.current.content`（= textarea 的值）里找，位置是字符偏移；
 *   * `wysiwyg`（实时渲染 / 分屏）：在 ProseMirror 文档里按块找，位置是**文档位置**。
 * 两边的匹配数可能不同（源码里有 `**` 这类标记字符，而文档里它们是独立的文本片段），
 * 所以计数显示的是**当前编辑面**的结果 —— 这比"显示一个对不上的数字"诚实。
 *
 * 分屏模式下以渲染面为准（它是主编辑面）；源码模式则以 textarea 为准。
 */
export type FindSurface = 'wysiwyg' | 'source'

export const useFindStore = defineStore('find', {
  state: () => ({
    open: false,
    query: '',
    replacement: '',
    caseSensitive: false,
    /** 当前命中下标（-1 = 没有命中） */
    index: -1
  }),
  getters: {
    /** 当前以哪个编辑面为准 */
    surface(state): FindSurface {
      void state
      return useUiStore().editorMode === 'source' ? 'source' : 'wysiwyg'
    },
    /** 当前编辑面的全部命中 */
    matches(state): Match[] {
      // 依赖文档的每次事务（编辑器内容变了要重算），也依赖 files 内容（源码面 / 打开文档）
      void useEditorStore().tick
      const files = useFilesStore()
      if (!state.query) return []
      const opts = { caseSensitive: state.caseSensitive }
      if (this.surface === 'source') {
        return findMatches(files.current?.content ?? '', state.query, opts)
      }
      const store = useEditorStore()
      const ed = store.instance ?? store.editor
      return ed ? findInDoc(ed.state.doc, state.query, opts) : []
    },
    count(): number {
      return this.matches.length
    },
    /** 当前命中（没有则 null） */
    current(): Match | null {
      return this.matches[this.index] ?? null
    }
  },
  actions: {
    show(): void {
      this.open = true
      // 打开时把命中选择到第一个（查询串保留：连续按 Ctrl+F 不该丢掉上次搜的内容）
      this.select(this.query ? 0 : -1)
    },
    hide(): void {
      this.open = false
      this.index = -1
      // 把焦点还给编辑面，用户接着写
      const ed = useEditorStore()
      const ui = useUiStore()
      if (ui.editorMode === 'source') {
        document.querySelector<HTMLTextAreaElement>('textarea.source-editor')?.focus()
      } else {
        ;(ed.instance ?? ed.editor)?.commands.focus()
      }
    },
    toggle(): void {
      if (this.open) this.hide()
      else this.show()
    },
    setQuery(q: string): void {
      this.query = q
      // 换了查询串就从头开始（与主流编辑器一致）
      this.select(this.matches.length ? 0 : -1)
    },
    setReplacement(r: string): void {
      this.replacement = r
    },
    toggleCase(): void {
      this.caseSensitive = !this.caseSensitive
      this.select(this.matches.length ? 0 : -1)
    },
    /** 前进/后退（循环），并把选中落到编辑面上 */
    step(delta: number): void {
      const next = stepIndex(this.matches.length, this.index, delta)
      this.select(next)
    },
    /** 选中第 i 个命中（-1 只更新下标，不动编辑面） */
    select(i: number): void {
      this.index = i
      const m = this.matches[i]
      if (!m) return
      if (this.surface === 'source') {
        const ta = document.querySelector<HTMLTextAreaElement>('textarea.source-editor')
        if (!ta) return
        // 同样不 focus：聚焦 textarea 会把焦点从查找输入框抢走（下一个 Enter 就废了）；
        // setSelectionRange 不需要焦点也能设置选区，滚动照样生效
        ta.setSelectionRange(m.from, m.to)
        // 粗略滚动到命中行（textarea 没有 scrollIntoView）
        const line = ta.value.slice(0, m.from).split('\n').length
        const lh = ta.scrollHeight / Math.max(1, ta.value.split('\n').length)
        ta.scrollTop = Math.max(0, (line - 3) * lh)
        return
      }
      const store = useEditorStore()
      const ed = store.instance ?? store.editor
      if (!ed) return
      try {
        // **刻意不 focus**：查找栏的输入框要保持焦点，否则下一次 Enter 会落到正文里
        // （「下一个」是 Enter 触发的，焦点一跑就变成在文档里敲回车 —— 实测把整段写坏）。
        // 不聚焦时编辑器仍会画出选区与命中高亮（主流编辑器就是这个行为）。
        ed.chain().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run()
      } catch {
        /* 位置非法（文档刚变）时只留下标 */
      }
    },
    /** 替换当前命中（不动其它命中） */
    replaceCurrent(): boolean {
      const m = this.matches[this.index]
      if (!m) return false
      const ui = useUiStore()
      const files = useFilesStore()
      if (this.surface === 'source') {
        const text = files.current?.content ?? ''
        const next = replaceMatches(text, [m], this.replacement)
        if (next === text) return false
        files.setContent(next, 'source')
        // 光标停在替换后的文本之后
        const after = m.from + this.replacement.length
        const ta = document.querySelector<HTMLTextAreaElement>('textarea.source-editor')
        if (ta) ta.setSelectionRange(after, after)
      } else {
        const store = useEditorStore()
        const ed = store.instance ?? store.editor
        if (!ed) return false
        try {
          ed.chain().insertContentAt({ from: m.from, to: m.to }, this.replacement).run()
        } catch {
          return false
        }
      }
      void ui
      // 内容变了，命中列表随之重算；下标保持在同一位置附近
      this.index = Math.min(this.index, Math.max(0, this.matches.length - 1))
      return true
    },
    /** 替换全部命中；返回替换的处数 */
    replaceAll(): number {
      const matches = this.matches
      if (!matches.length) return 0
      const files = useFilesStore()
      if (this.surface === 'source') {
        const text = files.current?.content ?? ''
        files.setContent(replaceMatches(text, matches, this.replacement), 'source')
      } else {
        const store = useEditorStore()
        const ed = store.instance ?? store.editor
        if (!ed) return 0
        // 一次事务里**从后往前**替换：前面的位置不会因为后面的改动而失效，
        // 而且整批替换在撤销栈里是一步（Ctrl+Z 一次退回）
        ed.commands.command(({ tr }) => {
          for (let i = matches.length - 1; i >= 0; i--) {
            tr.replaceWith(
              matches[i].from,
              matches[i].to,
              tr.doc.type.schema.text(this.replacement)
            )
          }
          return true
        })
      }
      this.index = -1
      return matches.length
    }
  }
})
