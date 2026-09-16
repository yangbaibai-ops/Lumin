// ─── 查找 / 替换的纯逻辑（无依赖，可单测）────────────────────────────────────
//
// 编辑器有两个编辑面（WYSIWYG 的 ProseMirror 文档、源码模式的 textarea），
// 「找什么、算不算匹配、下一个是哪个、替换完是什么」这些判定与编辑面无关 ——
// 抽到这里，两边共用同一套语义，也才测得了。
//
// 两个刻意的取舍：
//   1. **查询串一律按字面量**（`escapeRegExp`）：用户搜 `a*b` 就是想找 `a*b`，
//      而不是「a 后面跟任意个字符」。想要正则的话那是另一个功能（高级查找）。
//   2. 匹配**不跨块**：段落/标题/列表项之间不连起来找。跨块匹配的语义（要不要算上
//      段落之间的空行、换行算不算一个字符）在不同渲染器下不一致，与其猜不如不做。

/** 一段匹配（位置语义由调用方决定：纯文本偏移，或文档位置） */
export interface Match {
  from: number
  to: number
}

/** 把用户输入当字面量：正则元字符全部转义 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在纯文本里找**全部**匹配（按出现顺序，互不重叠） */
export function findMatches(
  text: string,
  query: string,
  opts: { caseSensitive?: boolean } = {}
): Match[] {
  if (!text || !query) return []
  const re = new RegExp(escapeRegExp(query), opts.caseSensitive ? 'g' : 'gi')
  const out: Match[] = []
  for (;;) {
    const m = re.exec(text)
    if (!m) break
    out.push({ from: m.index, to: m.index + m[0].length })
    // 空匹配（query 非空时不会发生）也要推进，避免死循环
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

/** 在一组片段里找匹配，返回**文档位置**（片段之间不跨越 —— 调用方按块传入） */
export function findInRuns(
  runs: TextRun[],
  query: string,
  opts: { caseSensitive?: boolean } = {}
): Match[] {
  const { text, posOf } = runsToText(runs)
  return findMatches(text, query, opts).map((m) => ({ from: posOf[m.from], to: posOf[m.to] }))
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
 * 替换命中的匹配（**从后往前**改，前面的位置就不会失效）。
 * @returns 替换后的文本；匹配越界/倒序时原样返回（脏数据不该让整篇文本被改坏）
 */
export function replaceMatches(text: string, matches: Match[], replacement: string): string {
  const valid = matches.filter((m) => m.from >= 0 && m.to <= text.length && m.to >= m.from)
  if (valid.length !== matches.length) return text
  let out = text
  for (let i = valid.length - 1; i >= 0; i--) {
    out = out.slice(0, valid[i].from) + replacement + out.slice(valid[i].to)
  }
  return out
}
