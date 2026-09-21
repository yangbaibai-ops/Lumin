// ─── 快捷工具栏：项目目录与排序工具函数 ──────────────────────────────────────
// 放在 shared 而不是 renderer：主进程的 defaultSettings 要用默认顺序，单元测试
// 直接 import 这个模块（纯数据 + 纯函数，不碰 DOM，也不引 Vue）。
//
// 三件事在这里一次说清：
//  1. **目录**（TOOLBAR_ITEMS）：工具栏上有哪些项目、叫什么、归在哪个视觉分组。
//     分组只在渲染时决定分隔线的位置 —— 因此「同组内换序」永远是安全的，
//     不会把分隔线插到奇怪的地方（跨组移动在 store 的 move/dropBefore 里被拒绝）。
//  2. **默认顺序**（DEFAULT_TOOLBAR_ITEMS）：目录的自然顺序 = 出厂时的工具栏，
//     也是「恢复默认」写回的值。
//  3. **清洗**（sanitizeToolbarItems）：settings 里存的是一串 id，可能是旧版本
//     留下的、手改坏的、重复的。渲染前一律过一遍，保证界面永远自洽。

/** 视觉分组：同组项目之间不画分隔线，换组才画一条 */
export type ToolbarGroup = 'history' | 'heading' | 'inline' | 'block' | 'insert'

export interface ToolbarItemDef {
  /** 稳定 id，写进 settings.toolbarItems 的就是它 */
  id: string
  group: ToolbarGroup
  /** 图标名（见 renderer/src/components/Icon.vue） */
  icon: string
  /** 提示/无障碍文案的 i18n key；标题 1/2/3 之外都直接复用 editor.* */
  labelKey: string
  /** 标题级别：渲染时补序号，提示文案也带上序号 */
  level?: 1 | 2 | 3
}

/**
 * 工具栏项目目录（顺序即默认顺序）。
 * 注意：这里只登记**可调整的快捷项**；右侧固定的导出/设置等入口不受工具栏开关
 * 以外的控制，也不参与排序，因此不在目录里。
 *
 * ── 第二十五轮的两处删除（按钮去留审计的结论）────────────────────────────────
 *   * `underline`：**唯一语义不可 Markdown 往返的按钮**。它写出的是裸 HTML `<u>`，
 *     重开文档时被 htmlPassthrough 转成字面文本（屏幕上就是 `<u>abc</u>` 这几个字符），
 *     与任何标记样式嵌套还会直接丢掉下划线 —— 属于「能写进文件、读不回来」的数据损坏类。
 *     与其留一个会坏文件的入口，不如先摘掉（要恢复就该做成一等 mark，见 CHANGELOG）。
 *   * `hr`：与「打 `---`/`***` 再回车」完全等价（keymap 的输入规则），
 *     且顶部菜单栏 + 编辑器右键菜单各有一条图形入口，工具栏上占一个 30px 位不划算。
 */
export const TOOLBAR_ITEMS: ToolbarItemDef[] = [
  { id: 'sidebar', group: 'history', icon: 'panel-left', labelKey: 'menu.toggleSidebar' },
  { id: 'undo', group: 'history', icon: 'undo', labelKey: 'editor.undo' },
  { id: 'redo', group: 'history', icon: 'redo', labelKey: 'editor.redo' },

  { id: 'h1', group: 'heading', icon: 'heading', labelKey: 'editor.heading', level: 1 },
  { id: 'h2', group: 'heading', icon: 'heading', labelKey: 'editor.heading', level: 2 },
  { id: 'h3', group: 'heading', icon: 'heading', labelKey: 'editor.heading', level: 3 },

  { id: 'bold', group: 'inline', icon: 'bold', labelKey: 'editor.bold' },
  { id: 'italic', group: 'inline', icon: 'italic', labelKey: 'editor.italic' },
  { id: 'strike', group: 'inline', icon: 'strike', labelKey: 'editor.strike' },
  { id: 'code', group: 'inline', icon: 'code', labelKey: 'editor.inlineCode' },

  { id: 'quote', group: 'block', icon: 'quote', labelKey: 'editor.quote' },
  { id: 'ul', group: 'block', icon: 'list', labelKey: 'editor.ul' },
  { id: 'ol', group: 'block', icon: 'list-ordered', labelKey: 'editor.ol' },
  { id: 'task', group: 'block', icon: 'list-checks', labelKey: 'editor.task' },
  { id: 'codeblock', group: 'block', icon: 'braces', labelKey: 'editor.codeBlock' },

  { id: 'table', group: 'insert', icon: 'table', labelKey: 'editor.table' },
  { id: 'link', group: 'insert', icon: 'link', labelKey: 'editor.link' },
  { id: 'image', group: 'insert', icon: 'image', labelKey: 'editor.image' },
  { id: 'toc', group: 'insert', icon: 'list', labelKey: 'editor.toc' }
]

/** 出厂顺序（= 目录里的自然顺序） */
export const DEFAULT_TOOLBAR_ITEMS: string[] = TOOLBAR_ITEMS.map((it) => it.id)

const BY_ID = new Map(TOOLBAR_ITEMS.map((it) => [it.id, it]))

export function toolbarItemDef(id: string): ToolbarItemDef | undefined {
  return BY_ID.get(id)
}

/** 两个项目是否同组（换序只允许同组内进行） */
export function sameToolbarGroup(a: string, b: string): boolean {
  const da = BY_ID.get(a)
  const db = BY_ID.get(b)
  return !!da && !!db && da.group === db.group
}

/**
 * 清洗一串工具栏 id：
 *  - 丢掉目录里没有的（旧版本残留、手改坏的值）；
 *  - 去掉重复（同一项目只出现一次，保留首次出现的位置）；
 *  - **保留空数组**：空 = 用户主动把项目全部隐藏，必须尊重；
 *    （调用方若要区分「没配过」与「配成空」，看的是 key 是否存在，而不是长度）
 *  - 入参不是数组（undefined / null / 脏数据）时退化为默认顺序。
 */
export function sanitizeToolbarItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TOOLBAR_ITEMS]
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    if (!BY_ID.has(raw)) continue
    if (out.includes(raw)) continue
    out.push(raw)
  }
  return out
}

/**
 * 把一个尚未显示的项目插进列表：落在「出厂顺序里排在它前面、且当前已显示」的最近一项之后；
 * 前面那些都没显示时放到最前面。这样新开启的项目不会莫名跑到工具栏末尾。
 */
export function insertToolbarItemByOrder(items: string[], id: string): string[] {
  if (items.includes(id) || !BY_ID.has(id)) return items
  const next = [...items]
  const at = DEFAULT_TOOLBAR_ITEMS.indexOf(id)
  for (let i = at - 1; i >= 0; i--) {
    const pos = next.indexOf(DEFAULT_TOOLBAR_ITEMS[i])
    if (pos >= 0) {
      next.splice(pos + 1, 0, id)
      return next
    }
  }
  return [id, ...next]
}

/**
 * 同组内把 id 相对 dir（-1 上移 / +1 下移）挪一格。
 * 无法移动（id 不存在、已在同组边界、目标位置是别的组）时原样返回，
 * 调用方因此可以放心在 UI 上直接调用。
 */
export function moveToolbarItem(items: string[], id: string, dir: -1 | 1): string[] {
  const from = items.indexOf(id)
  if (from < 0) return items
  const to = from + dir
  if (to < 0 || to >= items.length) return items
  if (!sameToolbarGroup(id, items[to])) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
