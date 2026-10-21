import type { EditorMenuAction, EditorMenuContext, EditorMenuProvider } from './types'
import { AI_MENU_PRESETS } from '../../../../../shared/aiMenu.ts'

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
            [
              'clipboard.copy',
              'clipboard.cut',
              'clipboard.paste',
              'clipboard.pastePlain',
              'clipboard.selectAll'
            ],
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
    // 代码块里也出场：**只**保留「段落（上方/下方）」这两项 —— 它们正是为了
    // 「代码块在文档开头/末尾、外面没有可点位置」而存在的（插在代码块这个顶层
    // 兄弟的前后，不进代码块内部）。其余插入项在代码块里没有意义，不出现。
    {
      id: 'insert',
      sortOrder: 50,
      when: () => true,
      build: (ctx) => [
        {
          id: 'insert',
          labelKey: 'editorMenu.section.insert',
          variant: 'list',
          items: ctx.inCodeBlock
            ? pick(actions, ['insert.paragraphAbove', 'insert.paragraphBelow'])
            : pick(
                actions,
                [
                  'insert.link',
                  'insert.image',
                  'insert.table',
                  'insert.hr',
                  'insert.toc',
                  'insert.paragraphAbove',
                  'insert.paragraphBelow'
                ],
                {
                  // 表格不能嵌套：已在表格内时禁用「插入表格」
                  'insert.table': { disabled: ctx.inTable }
                }
              )
        }
      ]
    },

    // ── AI 子菜单：任何场景都出场（正文 / 表格 / 代码块里都可能想优化或解释）──
    // 它是一个和「表格 / 段落 / 格式 / 插入」同级的**一级分类**，悬停/→ 展开二级；
    // 五项的顺序与文案来自 shared/aiMenu.ts（与快捷键、store 共用同一份）。
    {
      id: 'ai',
      sortOrder: 60,
      when: () => true,
      build: () => [
        {
          id: 'ai',
          labelKey: 'editorMenu.section.ai',
          variant: 'list',
          items: pick(
            actions,
            AI_MENU_PRESETS.map((p) => `ai.${p.kind}`)
          )
        }
      ]
    }
  ]
}
