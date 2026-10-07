import { defineStore } from 'pinia'
import type { Editor } from '@tiptap/core'
import type { MenuUsageEntry } from '../../../shared/types'
import type { EditorMenuAction, EditorMenuSection } from '../lib/editor/menu/types'
import { buildEditorMenuSections } from '../lib/editor/menu/registry'
import { buildEditorMenuActions } from '../lib/editor/menu/actions'
import { readEditorMenuContext } from '../lib/editor/menu/context'
import i18n from '../i18n'
import { useEditorStore } from './editor'
import { useUiStore } from './ui'
import { useNotificationsStore } from './notifications'

/**
 * ─── 编辑器右键菜单 store（两级结构）────────────────────────────────────────
 * 一级：分类总览（最近使用 / 表格 / 段落 / 格式 / 插入），悬停、→ 或点击展开二级；
 * 二级：该分类下的具体动作（一级标题、二级标题…）。
 *
 * 职责边界：
 *  - 打开时向注册表索取「当前上下文的分区」，每个分区即一个一级分类；
 *  - 维护一级高亮、当前展开的分类、二级高亮；
 *  - 执行动作后写一次使用记录（SQLite），并同步内存缓存。
 * 组件只负责渲染与交互，编辑器只负责执行命令，二者通过本 store 交汇。
 */
export const useEditorMenuStore = defineStore('editorMenu', {
  state: () => ({
    open: false,
    x: 0,
    y: 0,
    sections: [] as EditorMenuSection[],
    /** 一级（分类）高亮索引 */
    activeIndex: 0,
    /** 已展开的二级菜单所属分类 id；null = 未展开 */
    activeSectionId: null as string | null,
    /** 二级高亮索引 */
    activeSubIndex: 0,
    /** 使用记录：actionId → 条目（最近使用排序见 getter recentIds） */
    usage: {} as Record<string, MenuUsageEntry>,
    usageReady: false
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
    /** 最近使用的动作 id（最多 12 条候选，真正展示数量由注册表决定） */
    recentIds(state): string[] {
      return Object.values(state.usage)
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .slice(0, 12)
        .map((u) => u.actionId)
    }
  },
  actions: {
    /** 启动时从 SQLite 恢复使用记录（跨会话保留） */
    async hydrate(): Promise<void> {
      try {
        const rows = await window.luminAPI.menuUsage.list(50)
        this.usage = Object.fromEntries(rows.map((r) => [r.actionId, r]))
      } catch {
        /* 数据库不可用时退化为「无最近使用」，不影响菜单可用性 */
      } finally {
        this.usageReady = true
      }
    },

    /** 组装分区：读取当前编辑器上下文 + 注入依赖（对话框、失败提示、i18n） */
    buildSections(): EditorMenuSection[] {
      // store 里的 instance 经 Vue 响应式包装后，类型上丢了 Editor 的私有成员
      // （css/className/editorView…）；运行时它就是 markRaw 的原始实例，故此处断言
      const editor = useEditorStore().instance as Editor | null
      if (!editor) return []
      const ui = useUiStore()
      const notifications = useNotificationsStore()
      const actions = buildEditorMenuActions({
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
        promptLink: (req) => ui.promptLink(req)
      })
      return buildEditorMenuSections(readEditorMenuContext(editor), actions, this.recentIds)
    },

    /** 在视口坐标 (x, y) 打开菜单（默认只展开一级总览，不自动展开任何分类） */
    openAt(x: number, y: number): void {
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

    /** 执行动作并关闭菜单；成功执行会记一次使用频次 */
    async run(action: EditorMenuAction): Promise<void> {
      this.close()
      if (action.disabled) return
      const executed = await action.run()
      if (executed === false) return
      try {
        const entry = await window.luminAPI.menuUsage.bump(action.id)
        this.usage = { ...this.usage, [action.id]: entry }
      } catch {
        /* 记录失败不影响功能 */
      }
      if (action.refocus !== false) useEditorStore().instance?.commands.focus()
    },

    /** 执行二级菜单里当前高亮的动作（Enter） */
    async runSubActive(): Promise<void> {
      const item = this.activeSectionItems[this.activeSubIndex]
      if (item) await this.run(item)
    },

    /** 清空全部使用记录（菜单里的「清除最近使用」） */
    async clearUsage(): Promise<void> {
      this.usage = {}
      await window.luminAPI.menuUsage.reset().catch(() => {})
    },

    /** 忘记单个动作的使用记录 */
    async forget(actionId: string): Promise<void> {
      const next = { ...this.usage }
      delete next[actionId]
      this.usage = next
      await window.luminAPI.menuUsage.forget(actionId).catch(() => {})
    }
  }
})
