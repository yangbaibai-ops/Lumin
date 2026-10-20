// ─── 命令面板的纯函数层（过滤 / 排序 / 选择移动）────────────────────────────────
//
// 为什么把这几件事从组件里拿出来：命令面板的核心是「输入 → 候选顺序」这条规则，
// 而它在组件里只能靠真窗口 + 真按键才验得到（`tools/_verify-command-palette.js` 那层）。
// 抽成不碰 DOM、不碰 store、不碰 i18n 的纯函数之后，**排序规则本身**可以用毫秒级单测钉住
// （`tests/commandPalette.test.mjs`），CDP 那一层就只负责"面板真的开/关、键盘真的走"。
//
// 这一层刻意不认识业务：文案由调用方给（`labelOf`），因为标题是 i18n 键解析出来的，
// 而语言包在运行时才装载（见 renderer/src/i18n/index.ts 的动态 import）。

export interface CommandPaletteItem {
  /** 稳定 id（套件与设置界面按它定位，不要改名） */
  id: string
  /** 标题 i18n 键（与菜单/快捷键共用同一批键，保证文案一致） */
  labelKey: string
  /** 分组 i18n 键（可选）：结果列表里按它显示分节标题 */
  groupKey?: string
  /** 图标名（见 components/Icon.vue 的注册表） */
  icon?: string
  /** 额外可搜词（不翻译；用来补上"用户会怎么称呼它"） */
  keywords?: string[]
  /** 生效键位（展示用，由调用方从快捷键服务读；null = 未绑定） */
  keys?: string | null
  run: () => void | Promise<void>
}

/** 一句话查询的规范化：去首尾空白 + 折成小写（过滤与排序共用同一份口径） */
export function normalizeQuery(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
}

/**
 * 匹配位置（下标，越小越靠前）；-1 = 没命中。
 *
 * 只看**一个**事实：查询是不是候选文本的子串。前缀/子串的差别不在这里判 ——
 * 它由 `matchRank` 统一给分，免得两个函数各写一套"什么算更匹配"。
 */
export function matchIndex(text: string, query: string): number {
  if (!query) return 0
  // 一律 `indexOf`，不构造正则：`(`, `[`, `*`, `\` 这些字符在查询里是**字面量**，
  // 拼进正则轻则匹配不到、重则抛 SyntaxError（"特殊字符不炸正则"那条断言守的就是这里）。
  return text.toLowerCase().indexOf(query)
}

/** 命中的**档次**（越小越靠前）：0 = 整串前缀，1 = 词/分段开头，2 = 只是子串 */
export function matchRank(text: string, query: string): number {
  const at = matchIndex(text, query)
  if (at < 0) return -1
  if (at === 0) return 0
  // `Ctrl+Shift+P` / `file.save-as` / `全局 搜索` 这类文本的"分段开头"也算前缀级：
  // 用户敲 `save` 时想找的是 `file.saveAs`，不该输给正文里恰好含 save 的别的命令。
  const prev = text.charAt(at - 1)
  return /[\s\-_./+·]/.test(prev) ? 1 : 2
}

/**
 * 过滤 + 排序。返回**新数组**（不排序入参，调用方可能持有常量清单）。
 *
 * 排序键（依次比较）：档次 → 命中位置 → 候选列表里的原序。
 * 最后那条"原序"是**稳定性**的来源：同分候选保持命令表的声明顺序，
 * 于是「空查询列出全部」与「输入后同分项」都不会因为排序实现变化而乱跳。
 */
export function filterCommands<T extends CommandPaletteItem>(
  items: readonly T[],
  rawQuery: unknown,
  labelOf: (item: T) => string
): T[] {
  const query = normalizeQuery(rawQuery)
  if (!query) return items.slice()
  const scored: { item: T; rank: number; at: number; order: number }[] = []
  for (let order = 0; order < items.length; order += 1) {
    const item = items[order]
    // 候选文本 = 标题 + id + 额外关键词。id 是英文（`file.saveAs`），
    // 于是英文界面之外的输入法用户也能用命令 id 找到它。
    const texts = [labelOf(item), item.id, ...(item.keywords ?? [])]
    let best = -1
    let bestAt = -1
    for (const text of texts) {
      const rank = matchRank(text, query)
      if (rank < 0) continue
      const at = matchIndex(text, query)
      if (best < 0 || rank < best || (rank === best && at < bestAt)) {
        best = rank
        bestAt = at
      }
    }
    if (best >= 0) scored.push({ item, rank: best, at: bestAt, order })
  }
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at || a.order - b.order)
  return scored.map((s) => s.item)
}

/**
 * 当前高亮项的下标：钳到 `[0, total - 1]`；`total` 为 0 时返回 **-1**（没有候选）。
 *
 * `-1` 在这个模块里只有一个含义：**结果为空**。为此"下标越界"（比如结果集缩小之后
 * 旧下标还在 5）会先落到边界上，而不是也变成 -1 —— 否则"上一项是第 5 条"和
 * "一条都没有"在下游分不开（`selectionChanged` 正是靠这个区分）。
 */
export function clampIndex(index: number, total: number): number {
  if (total <= 0) return -1
  if (!Number.isFinite(index) || index < 0) return 0
  return Math.min(Math.floor(index), total - 1)
}

/** 当前高亮是不是「第一项都还没选」（空列表，或调用方给的 -1） */
function hasSelection(index: number, total: number): boolean {
  return total > 0 && Number.isFinite(index) && index >= 0
}

/**
 * ↑/↓ 移动高亮。**到两端就停在原地**（不回卷）。
 *
 * 为什么不循环：命令面板的结果条数随输入变化，回卷会让人"按了 ↓ 却跳回第一行"时
 * 分不清是自己多按了一下还是列表变了；VS Code / 主流编辑器的同类面板到端即停。
 */
export function moveSelection(index: number, delta: number, total: number): number {
  if (total <= 0) return -1
  // 还没有高亮（刚打开 / 刚输入完）时，第一次 ↓ 落到第一项、第一次 ↑ 落到最后一项 ——
  // 这是各家命令面板的一致手感，也让"从 -1 起步"不需要调用方特殊处理。
  if (!hasSelection(index, total)) return delta >= 0 ? 0 : total - 1
  return clampIndex(Math.floor(index) + delta, total)
}

/**
 * 高亮项是否**真的换了行**。回车要用它判断"要不要先等渲染再执行"，
 * 而"结果集缩小后下标被钳住"这类情况不算换行（否则每次回车都白等一帧）。
 */
export function selectionChanged(prev: number, next: number, total: number): boolean {
  if (total <= 0) return false
  return (
    hasSelection(prev, total) !== hasSelection(next, total) ||
    clampIndex(prev, total) !== clampIndex(next, total)
  )
}
