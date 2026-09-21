import { defineStore } from 'pinia'
import {
  findMatches,
  isValidQuery,
  replaceMatchesEach,
  replacementForMatch,
  stepIndex,
  type Match
} from '../lib/findReplace'
import { findInDoc } from '../lib/editor/findInDoc'
import { setFindHit } from '../lib/editor/typoraInlineMarks'
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
 *
 * 两条与入口相关的状态：
 *   * `replaceExpanded`：替换那一行是否展开。Ctrl+F 默认收起（只留查找 + 一个折叠三角），
 *     Ctrl+H / 菜单「替换」默认展开；
 *   * `regex`：查询串是否按正则解释（默认否 —— 字面量搜索才是绝大多数人的预期）。
 */
export type FindSurface = 'wysiwyg' | 'source'

export const useFindStore = defineStore('find', {
  state: () => ({
    open: false,
    query: '',
    replacement: '',
    caseSensitive: false,
    /** 查询串是否按正则表达式解释（`$1` 这类替换语法只在打开它时生效） */
    regex: false,
    /** 替换行是否展开（折叠三角控制；打开方式决定默认值） */
    replaceExpanded: false,
    /** 当前命中下标（-1 = 没有命中） */
    index: -1
  }),
  getters: {
    /** 当前以哪个编辑面为准 */
    surface(state): FindSurface {
      void state
      return useUiStore().editorMode === 'source' ? 'source' : 'wysiwyg'
    },
    /** 传给纯逻辑层的选项（两个 getter 共用一份，避免两处漏传） */
    options(state): { caseSensitive: boolean; regex: boolean } {
      return { caseSensitive: state.caseSensitive, regex: state.regex }
    },
    /**
     * 查询串是否合法。字面量模式永远合法；
     * 正则模式下语法错（如只敲了一个 `(`）会让整栏显示「表达式无效」而不是零匹配的错觉。
     */
    queryValid(state): boolean {
      return isValidQuery(state.query, {
        caseSensitive: state.caseSensitive,
        regex: state.regex
      })
    },
    /** 当前编辑面的全部命中 */
    matches(state): Match[] {
      // 依赖文档的每次事务（编辑器内容变了要重算），也依赖 files 内容（源码面 / 打开文档）
      void useEditorStore().tick
      const files = useFilesStore()
      if (!state.query || !this.queryValid) return []
      const opts = this.options
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
    /**
     * 打开查找栏。
     * @param expandReplace 是否同时展开替换行（Ctrl+H / 菜单「替换」传 true；Ctrl+F 省略）
     */
    show(expandReplace = false): void {
      this.open = true
      this.replaceExpanded = expandReplace
      // 打开时把命中选择到第一个（查询串保留：连续按 Ctrl+F 不该丢掉上次搜的内容）
      this.select(this.query ? 0 : -1)
    },
    /** 打开并直接展开替换行（Ctrl+H） */
    showReplace(): void {
      this.show(true)
    },
    hide(): void {
      this.open = false
      this.index = -1
      // 关掉查找栏 ⇒ 一起摘掉命中高亮（否则那层底色会留在正文里）
      setFindHit(false, -1, -1)
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
    /** 正则开关：切了要重算命中（语法错的表达式在这里会变成「表达式无效 + 零匹配」） */
    toggleRegex(): void {
      this.regex = !this.regex
      this.select(this.matches.length ? 0 : -1)
    },
    /** 折叠/展开替换行（查找栏左侧那个三角） */
    toggleReplace(): void {
      this.replaceExpanded = !this.replaceExpanded
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
      if (!m) {
        // 没有命中（查询串空/无匹配/位置失效）：同步摘掉高亮，避免留一条旧底色
        if (i < 0) setFindHit(this.open, -1, -1)
        return
      }
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
      // 另加一层**常显**高亮（`.find-hit`）：失焦选区太淡，跳转后的那点高亮一闪就没
      if (this.surface === 'wysiwyg') setFindHit(true, m.from, m.to)
    },
    /**
     * 某一处命中该替换成什么文本。
     *
     * 正则模式下按捕获组展开（`$1` / `$&` …），捕获组随 `Match` 一起从匹配层带上来
     * （`findReplace.ts` 的 `Match.groups`）—— 所以**两个编辑面共用这一个判定**，
     * 不需要各自再回原文里数位置（渲染面的文档坐标与纯文本偏移不同源，回原文数必错）。
     */
    textFor(m: Match): string {
      return replacementForMatch(this.replacement, m, this.options)
    },
    /** 替换当前命中（不动其它命中） */
    replaceCurrent(): boolean {
      const m = this.current
      if (!m) return false
      const ui = useUiStore()
      const files = useFilesStore()
      const text = this.textFor(m)
      if (this.surface === 'source') {
        const content = files.current?.content ?? ''
        const next = replaceMatchesEach(content, [m], () => text)
        if (next === content) return false
        files.setContent(next, 'source')
        // 光标停在替换后的文本之后
        const after = m.from + text.length
        const ta = document.querySelector<HTMLTextAreaElement>('textarea.source-editor')
        if (ta) ta.setSelectionRange(after, after)
      } else {
        const store = useEditorStore()
        const ed = store.instance ?? store.editor
        if (!ed) return false
        try {
          ed.chain().insertContentAt({ from: m.from, to: m.to }, text).run()
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
      // 每处的替换文本先算好（正则下各处可能不同：$1 各取各的组）
      const texts = matches.map((m) => this.textFor(m))
      if (this.surface === 'source') {
        const text = files.current?.content ?? ''
        files.setContent(
          replaceMatchesEach(text, matches, (m) => texts[matches.indexOf(m)] ?? ''),
          'source'
        )
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
              tr.doc.type.schema.text(texts[i] ?? this.replacement)
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
