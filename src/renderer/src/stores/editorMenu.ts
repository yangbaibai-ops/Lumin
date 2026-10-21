import { defineStore } from 'pinia'
import type { Editor } from '@tiptap/core'
import type { EditorMenuAction, EditorMenuSection } from '../lib/editor/menu/types'
import { buildEditorMenuSections } from '../lib/editor/menu/registry'
import { buildEditorMenuActions } from '../lib/editor/menu/actions'
import {
  buildSpellSection,
  replaceSpellRange,
  replaceSpellWord,
  type SpellMenuData
} from '../lib/editor/menu/spell'
import { ignoreZhIssue } from '../lib/editor/zhSpellcheck'
import { readEditorMenuContext } from '../lib/editor/menu/context'
import i18n from '../i18n'
import { useEditorStore } from './editor'
import { useAiStore } from './ai'
import { useUiStore } from './ui'
import { useNotificationsStore } from './notifications'

/**
 * ─── 编辑器右键菜单 store（两级结构）────────────────────────────────────────
 * 一级：分类总览（表格 / 段落 / 格式 / 插入），悬停、→ 或点击展开二级；
 * 二级：该分类下的具体动作（一级标题、二级标题…）。
 *
 * 职责边界：
 *  - 打开时向注册表索取「当前上下文的分区」，每个分区即一个一级分类；
 *  - 维护一级高亮、当前展开的分类、二级高亮；
 *  - 执行动作后关闭菜单并把焦点交还编辑器。
 * 组件只负责渲染与交互，编辑器只负责执行命令，二者通过本 store 交汇。
 */
export const useEditorMenuStore = defineStore('editorMenu', {
  state: () => ({
    open: false,
    x: 0,
    y: 0,
    sections: [] as EditorMenuSection[],
    /** 本次右键的拼写信息（null = 没有拼错；不会从上一次右键残留） */
    spell: null as SpellMenuData | null,
    /** 一级（分类）高亮索引 */
    activeIndex: 0,
    /** 已展开的二级菜单所属分类 id；null = 未展开 */
    activeSectionId: null as string | null,
    /** 二级高亮索引 */
    activeSubIndex: 0
  }),
  getters: {
    /** 顶部横向常用行（剪贴板） */
    toolbarSection(state): EditorMenuSection | null {
      return state.sections.find((s) => s.variant === 'toolbar') ?? null
    },
    /** 一级分类：每个分类对应一个二级菜单 */
    categories(state): EditorMenuSection[] {
      return state.sections.filter((s) => s.variant === 'list')
    },
    /** 当前展开的分类 */
    activeSection(state): EditorMenuSection | null {
      return this.categories.find((s) => s.id === state.activeSectionId) ?? null
    },
    /** 二级菜单里的动作 */
    activeSectionItems(): EditorMenuAction[] {
      return this.activeSection?.items ?? []
    },
    /** 顶部的拼写建议分区（只有命中错词时才有） */
    spellSection(state): EditorMenuSection | null {
      return state.sections.find((s) => s.variant === 'spell') ?? null
    },
    /** 建议词（纯数据，点击即替换） */
    spellSuggestions(): EditorMenuAction[] {
      return (this.spellSection?.items ?? []).filter((i) => i.kind === 'suggestion')
    },
    /** 「添加到词典」/「忽略」 */
    spellActions(): EditorMenuAction[] {
      return (this.spellSection?.items ?? []).filter((i) => i.kind !== 'suggestion')
    }
  },
  actions: {
    /**
     * 构建**全部**动作（未按上下文裁剪）。
     *
     * 抽出来是为了应用菜单 / 快捷键也能按 id 执行同一条命令（`runById`）——否则
     * 「插入表格」会变成快捷键一份实现、右键菜单一份实现，用户看到的行为迟早分叉。
     */
    buildActions() {
      // store 里的 instance 经 Vue 响应式包装后，类型上丢了 Editor 的私有成员
      // （css/className/editorView…）；运行时它就是 markRaw 的原始实例，故此处断言
      const editor = useEditorStore().instance as Editor | null
      if (!editor) return {}
      const ui = useUiStore()
      const notifications = useNotificationsStore()
      return buildEditorMenuActions({
        editor,
        prompt: (opts) =>
          ui.prompt(
            i18n.global.t(opts.titleKey),
            i18n.global.t(opts.placeholderKey),
            opts.value ?? ''
          ),
        notifyError: (titleKey, body) => {
          void notifications.notify({ level: 'error', title: i18n.global.t(titleKey), body })
        },
        // 链接对话框：形状随选区变（有选区只有链接一栏），所以走 ui 上那份独立状态，
        // 而不是上面那个"单输入框"的 prompt
        promptLink: (req) => ui.promptLink(req),
        // AI 子菜单：来源文本 / 打开右侧栏 / prompt / 发送都收在 ai store 的同一入口
        runAi: (kind) => useAiStore().askFromMenu(kind)
      })
    },

    /** 组装分区：读取当前编辑器上下文 + 注入依赖（对话框、失败提示、i18n） */
    buildSections(): EditorMenuSection[] {
      // store 里的 instance 经 Vue 响应式包装后，类型上丢了 Editor 的私有成员
      // （css/className/editorView…）；运行时它就是 markRaw 的原始实例，故此处断言
      const editor = useEditorStore().instance as Editor | null
      if (!editor) return []
      const actions = this.buildActions()
      const sections = buildEditorMenuSections(readEditorMenuContext(editor), actions)
      /**
       * 拼写建议放在**最顶部**（用户口径）：建议词 → 添加到词典 → 忽略。
       * 没有错词时 `buildSpellSection` 返回 null，sections 原样返回 ——
       * 这保证"没有拼写错误时菜单行为完全不变"。
       */
      const spellSection = buildSpellSection(this.spell, {
        replace: (range, word) => {
          // 中文修正是纯文本替换（tr.insertText）：一个事务，Ctrl+Z 一次还原
          if (this.spell?.source === 'zh') replaceSpellRange(editor, range, word)
          else replaceSpellWord(editor, range, word)
        },
        addToDictionary: (word) => {
          void window.luminAPI.spell.addWord(word)
        },
        ignore: (key) => {
          // 中文按命中指纹忽略（不改文档）；英文仍走 Chromium 会话忽略表
          if (this.spell?.source === 'zh') {
            if (this.spell.issueKey) ignoreZhIssue({ fingerprint: this.spell.issueKey })
          } else {
            void window.luminAPI.spell.ignoreWord(key)
          }
        }
      })
      return spellSection ? [spellSection, ...sections] : sections
    },

    /**
     * 按动作 id 执行一条命令（应用菜单 / 快捷键用）。
     *
     * 与右键菜单 `run()` 的差别只有一点：这里没有"先 close 菜单"的步骤。
     * 动作的 `false` 返回值（用户取消、没有编辑器）不当作错误，交给调用方忽略。
     */
    async runById(id: string): Promise<boolean> {
      const action = (this.buildActions() as Record<string, EditorMenuAction | undefined>)[id]
      if (!action || action.disabled) return false
      const ok = await action.run()
      if (ok !== false && action.refocus !== false) {
        useEditorStore().instance?.commands.focus()
      }
      return ok !== false
    },

    /** 在视口坐标 (x, y) 打开菜单（默认只展开一级总览，不自动展开任何分类） */
    openAt(x: number, y: number, spell: SpellMenuData | null = null): void {
      // 先落拼写状态再构建分区：`buildSections` 读的就是 this.spell。
      // 每次打开都显式覆盖（包括 null），绝不会读到上一次右键的残留。
      this.spell = spell
      const sections = this.buildSections()
      if (!sections.length) return
      this.sections = sections
      this.x = x
      this.y = y
      this.activeIndex = 0
      this.activeSectionId = null
      this.activeSubIndex = 0
      this.open = true
    },

    close(): void {
      this.open = false
      this.sections = []
      this.spell = null
      this.activeIndex = 0
      this.activeSectionId = null
      this.activeSubIndex = 0
    },

    /** 一级高亮（只移动高亮，展开由 hover / → / 点击触发） */
    setActive(index: number): void {
      const total = this.categories.length
      if (!total) return
      this.activeIndex = (index + total) % total
    },

    moveActive(delta: number): void {
      this.setActive(this.activeIndex + delta)
    },

    /** 展开某个分类的二级菜单（重复展开同一分类时保留其二级高亮） */
    openSection(id: string): void {
      if (this.activeSectionId === id) return
      this.activeSectionId = id
      this.activeSubIndex = 0
    },

    closeSection(): void {
      this.activeSectionId = null
      this.activeSubIndex = 0
    },

    /** 二级高亮 */
    setSubActive(index: number): void {
      const total = this.activeSectionItems.length
      if (!total) return
      this.activeSubIndex = (index + total) % total
    },

    moveSubActive(delta: number): void {
      this.setSubActive(this.activeSubIndex + delta)
    },

    /** 执行动作并关闭菜单 */
    async run(action: EditorMenuAction): Promise<void> {
      this.close()
      if (action.disabled) return
      const executed = await action.run()
      if (executed === false) return
      if (action.refocus !== false) useEditorStore().instance?.commands.focus()
    },

    /** 执行二级菜单里当前高亮的动作（Enter） */
    async runSubActive(): Promise<void> {
      const item = this.activeSectionItems[this.activeSubIndex]
      if (item) await this.run(item)
    }
  }
})
