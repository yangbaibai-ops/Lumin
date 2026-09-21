import type {
  EditorMenuAction,
  EditorMenuContext,
  EditorMenuProvider,
  EditorMenuSection
} from './types'

/**
 * ─── 内置提供者 ──────────────────────────────────────────────────────────────
 * 每个提供者回答两个问题：这种场景我要不要出现（when）、出现时给哪些分区（build）。
 * 新增能力（如「数学公式」「批注」「脚注」）＝新增一个提供者并注册，
 * 菜单组件与 store 一行都不用改——这就是「易拓展」的落点。
 */

/** 按 id 取动作；缺失时抛错便于开发期立刻发现拼写错误，而不是静默少一项 */
function pick(
  actions: Record<string, EditorMenuAction>,
  ids: string[],
  patch: Record<string, Partial<EditorMenuAction>> = {}
): EditorMenuAction[] {
  return ids.map((id) => {
    const base = actions[id]
    if (!base) throw new Error(`[editorMenu] unknown action: ${id}`)
    return { ...base, ...(patch[id] ?? {}) }
  })
}

export function createDefaultProviders(
  actions: Record<string, EditorMenuAction>
): EditorMenuProvider[] {
  return [
    // ── 顶部横向常用行：剪贴板与基础操作 ─────────────────────────────────
    {
      id: 'clipboard',
      sortOrder: 10,
      when: () => true,
      build: (ctx: EditorMenuContext) => [
        {
          id: 'clipboard',
          variant: 'toolbar',
          items: pick(
            actions,
            ['clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'clipboard.selectAll'],
            {
              'clipboard.copy': { disabled: !ctx.hasSelection },
              'clipboard.cut': { disabled: !ctx.hasSelection }
            }
          )
        }
      ]
    },

    // ── 表格：右键在表格里时才出现（位置最靠前的场景分区）────────────────
    {
      id: 'table',
      sortOrder: 20,
      when: (ctx) => ctx.inTable && !!ctx.table,
      build: (ctx) => {
        const info = ctx.table
        return [
          {
            id: 'table',
            labelKey: 'editorMenu.section.table',
            variant: 'list',
            items: pick(
              actions,
              [
                'table.rowAbove',
                'table.rowBelow',
                'table.colBefore',
                'table.colAfter',
                'table.toggleHeader',
                'table.deleteRow',
                'table.deleteCol',
                'table.delete'
              ],
              {
                // 只有一行时不能删行、只有一列时不能删列（禁用而不是隐藏，位置稳定）
                'table.deleteRow': { disabled: (info?.rows ?? 0) <= 1 },
                'table.deleteCol': { disabled: (info?.cols ?? 0) <= 1 }
              }
            )
          }
        ]
      }
    },

    // ── 段落：正文/标题/列表/引用/代码块；代码块内只保留「转为正文」────────
    {
      id: 'paragraph',
      sortOrder: 30,
      when: () => true,
      build: (ctx) =>
        ctx.inCodeBlock
          ? [
              {
                id: 'paragraph',
                labelKey: 'editorMenu.section.paragraph',
                variant: 'list',
                items: pick(actions, ['paragraph.text'])
              }
            ]
          : [
              {
                id: 'paragraph',
                labelKey: 'editorMenu.section.paragraph',
                variant: 'list',
                items: pick(actions, [
                  'paragraph.text',
                  'paragraph.h1',
                  'paragraph.h2',
                  'paragraph.h3',
                  'paragraph.quote',
                  'paragraph.bulletList',
                  'paragraph.orderedList',
                  'paragraph.taskList',
                  'paragraph.codeBlock'
                ])
              }
            ]
    },

    // ── 格式（行内标记）──────────────────────────────────────────────────
    {
      id: 'format',
      sortOrder: 40,
      when: (ctx) => !ctx.inCodeBlock,
      build: () => [
        {
          id: 'format',
          labelKey: 'editorMenu.section.format',
          variant: 'list',
          items: pick(actions, [
            'format.bold',
            'format.italic',
            'format.strike',
            'format.inlineCode'
          ])
        }
      ]
    },

    // ── 插入 ─────────────────────────────────────────────────────────────
    {
      id: 'insert',
      sortOrder: 50,
      when: (ctx) => !ctx.inCodeBlock,
      build: (ctx) => [
        {
          id: 'insert',
          labelKey: 'editorMenu.section.insert',
          variant: 'list',
          items: pick(
            actions,
            ['insert.link', 'insert.image', 'insert.table', 'insert.hr', 'insert.toc'],
            {
              // 表格不能嵌套：已在表格内时禁用「插入表格」
              'insert.table': { disabled: ctx.inTable }
            }
          )
        }
      ]
    }
  ]
}

/**
 * 纯函数版「最近使用」分区：由使用记录（SQLite）+ 当前上下文可用的动作集合推导。
 * 放在这里而不是提供者里，是因为它依赖持久化数据、且对所有场景通用。
 * 只保留「当前上下文下确实可用」的动作——表格操作不会在普通段落里冒出来。
 */
export function buildRecentSection(
  recentIds: string[],
  available: EditorMenuAction[]
): EditorMenuSection | null {
  const availableById = new Map(available.map((a) => [a.id, a]))
  const seen = new Set<string>()
  const items: EditorMenuAction[] = []
  for (const id of recentIds) {
    const action = availableById.get(id)
    if (!action || action.disabled || seen.has(id)) continue
    seen.add(id)
    items.push(action)
    if (items.length >= 5) break
  }
  if (!items.length) return null
  return { id: 'recent', labelKey: 'editorMenu.section.recent', variant: 'list', items }
}
