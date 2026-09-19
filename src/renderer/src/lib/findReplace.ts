// ─── 查找 / 替换的纯逻辑（无依赖，可单测）────────────────────────────────────
//
// 编辑器有两个编辑面（WYSIWYG 的 ProseMirror 文档、源码模式的 textarea），
// 「找什么、算不算匹配、下一个是哪个、替换完是什么」这些判定与编辑面无关 ——
// 抽到这里，两边共用同一套语义，也才测得了。
//
// 三个刻意的取舍：
//   1. **默认按字面量**（`escapeRegExp`）：用户搜 `a*b` 就是想找 `a*b`，
//      而不是「a 后面跟任意个字符」。想要正则得显式打开「正则」开关（见 regex 选项）。
//   2. **正则语法错误 = 零匹配**，而不是抛异常或悄悄退回字面量：前者会让输入到一半的
//      模式（`(`）把整栏炸掉，后者会让用户以为自己开的是正则。界面据此显示「表达式无效」。
//   3. 匹配**不跨块**：段落/标题/列表项之间不连起来找。跨块匹配的语义（要不要算上
//      段落之间的空行、换行算不算一个字符）在不同渲染器下不一致，与其猜不如不做。

/** 一段匹配（位置语义由调用方决定：纯文本偏移，或文档位置） */
export interface Match {
  from: number
  to: number
  /**
   * 命中的原文（正则模式下的 `$&`）。
   * 由 `findMatches` 填好 —— 光有 from/to 时调用方还得回原文切一刀，容易切错坐标系。
   */
  whole?: string
  /**
   * 捕获组（下标与 `RegExpExecArray` 对齐：`groups[1]` = `$1`；`groups[0]` = 整段命中）。
   * 未匹配的可选组按规范是 `undefined`，这里统一成空串（替换时插空串比插 "undefined" 正确）。
   */
  groups?: string[]
}

/** 查找选项：大小写 + 是否把查询串当正则 */
export interface FindOptions {
  caseSensitive?: boolean
  regex?: boolean
}

/** 把用户输入当字面量：正则元字符全部转义 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 编译查询串。
 * @returns 正则；查询串为空或**正则语法有误**时返回 null（调用方一律当「零匹配」处理）
 *
 * 用 `u` 标志：这样 `.` 之类按码点走，中文/emoji 不会被拆成半个代理对；
 * 代价是某些「宽松但非法」的转义（`\d` 之外的自造转义）会被拒 —— 拒绝比错配好。
 */
export function compileQuery(query: string, opts: FindOptions = {}): RegExp | null {
  if (!query) return null
  const source = opts.regex ? query : escapeRegExp(query)
  const flags = opts.caseSensitive ? 'gu' : 'giu'
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

/** 查询串是否合法（界面用它显示「表达式无效」；字面量模式永远合法） */
export function isValidQuery(query: string, opts: FindOptions = {}): boolean {
  if (!query) return true
  return compileQuery(query, opts) !== null
}

/**
 * 在纯文本里找**全部**匹配（按出现顺序，互不重叠）。
 *
 * 零长匹配（`a*`、`(?:)` 这类）要多一步：把 `lastIndex` 往前推一个字符，
 * 否则 `exec` 永远停在原地 —— 这正是 `RegExp.exec` 的经典死循环。
 */
export function findMatches(text: string, query: string, opts: FindOptions = {}): Match[] {
  if (!text || !query) return []
  const re = compileQuery(query, opts)
  if (!re) return []
  const out: Match[] = []
  for (;;) {
    const m = re.exec(text)
    if (!m) break
    // 捕获组随匹配一起带走（`$1` 这类替换语法靠它，见 expandGroups）
    const groups: string[] = []
    for (let i = 0; i < m.length; i++) groups.push(m[i] ?? '')
    out.push({ from: m.index, to: m.index + m[0].length, whole: m[0], groups })
    if (m[0].length === 0) re.lastIndex += 1
  }
  return out
}

/**
 * 「文本片段 + 它在文档里的起始位置」。
 *
 * 为什么需要它：文档里一段文字可能被拆成多个文本节点（不同 mark、行内 HTML 原件、
 * 图片这种非文本行内节点），而位置必须落在**文档坐标**上才能选中/替换。
 */
export interface TextRun {
  from: number
  text: string
}

/** 把若干片段拼成一份文本 + 「第 i 个字符在文档里的位置」映射（末尾多一位，便于取 to） */
export function runsToText(runs: TextRun[]): { text: string; posOf: number[] } {
  let text = ''
  const posOf: number[] = []
  for (const run of runs) {
    for (let i = 0; i < run.text.length; i++) posOf.push(run.from + i)
    text += run.text
  }
  // 末尾哨兵：最后一个字符之后的位置
  posOf.push(runs.length ? runs[runs.length - 1].from + runs[runs.length - 1].text.length : 0)
  return { text, posOf }
}

/**
 * 在一组片段里找匹配，返回**文档位置**（片段之间不跨越 —— 调用方按块传入）。
 *
 * 注意把 `whole` / `groups` 一起带上：渲染面的替换靠它们展开 `$1`（`replacementForMatch`）。
 * 只映射 from/to 的话正则替换会静默退化成字面量 —— 实测 `(be)(ta)` + `$2$1` 会替换成 `ta`，
 * 看着「替换成功了」，其实是捕获组全空。
 */
export function findInRuns(runs: TextRun[], query: string, opts: FindOptions = {}): Match[] {
  const { text, posOf } = runsToText(runs)
  return findMatches(text, query, opts).map((m) => ({
    ...m,
    from: posOf[m.from],
    to: posOf[m.to]
  }))
}

/**
 * 循环步进：`count` 个匹配里从 `current` 走 `delta` 步。
 * 没有匹配返回 -1；越过末尾回到开头（查找栏的「下一个」在末尾要绕回第一个，主流编辑器都这样）。
 */
export function stepIndex(count: number, current: number, delta: number): number {
  if (count <= 0) return -1
  const base = current < 0 || current >= count ? (delta > 0 ? -1 : 0) : current
  return (((base + delta) % count) + count) % count
}

/**
 * 按捕获组展开替换串（`$1` / `$&` / `$$` …）。
 *
 * 只认**能从匹配本身算出来**的记号：`$$` `$&` `$0` `$1..$99`。
 * `$\``（命中前）与 `$'`（命中后）**不支持** —— 它们要整篇文本 + 命中在其中的位置，
 * 而渲染面的文档坐标与纯文本偏移不同源（同一个下标在两边指的是不同位置），
 * 给一个「大部分时候对」的实现比不支持更坏。这两个记号原样保留。
 *
 * 规范外的写法（`$9` 但只有 1 个组、`$x`）**原样保留** —— 用户写的替换串不该被悄悄吃掉。
 */
export function expandGroups(replacement: string, match: Match): string {
  const groups = match.groups ?? []
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (whole, token: string) => {
    if (token === '$') return '$'
    if (token === '&') return match.whole ?? groups[0] ?? ''
    const n = Number(token)
    // 两位数字优先整体（`$10` → 第 10 组），不存在时退回一位（`$1` + 字面 "0"）—— 与规范一致
    if (n > 0 && n < groups.length) return groups[n]
    const one = Number(token[0])
    if (one > 0 && one < groups.length) return groups[one] + token.slice(1)
    return whole
  })
}

/**
 * 算出一处匹配的替换文本：字面量模式原样返回，正则模式按捕获组展开。
 * `replacement` 里出现 `$1` 而当前没开正则时**不当语法**（等于用户就想插 `$1`）。
 */
export function replacementForMatch(
  replacement: string,
  match: Match,
  opts: FindOptions = {}
): string {
  if (!opts.regex) return replacement
  return expandGroups(replacement, match)
}

/**
 * 替换命中的匹配（**从后往前**改，前面的位置就不会失效）。
 *
 * 正则模式下每处可能替换成不同文本（`$1` 各取各的组），所以用 `replacementAt` 逐处算；
 * 字符面（textarea）走这一条，渲染面走 ProseMirror 事务（见 stores/find.ts）。
 *
 * @returns 替换后的文本；匹配越界/倒序时原样返回（脏数据不该让整篇文本被改坏）
 */
export function replaceMatches(text: string, matches: Match[], replacement: string): string {
  return replaceMatchesEach(text, matches, () => replacement)
}

/** 同上，但每处可以用**不同的**替换文本（正则捕获组） */
export function replaceMatchesEach(
  text: string,
  matches: Match[],
  replacementAt: (m: Match) => string
): string {
  const valid = matches.filter((m) => m.from >= 0 && m.to <= text.length && m.to >= m.from)
  if (valid.length !== matches.length) return text
  let out = text
  for (let i = valid.length - 1; i >= 0; i--) {
    out = out.slice(0, valid[i].from) + replacementAt(valid[i]) + out.slice(valid[i].to)
  }
  return out
}
