/**
 * ─── 本地历史（保存前的快照）策略（纯函数，可单测）─────────────────────────────
 *
 * 为什么必须有：现在「保存成功即清草稿」，一次误保存（全选删掉再 Ctrl+S、改错一份稿）
 * 就**无法挽回** —— 对写作工具这是信誉问题。所以每次写盘前把**即将被覆盖的那一版**
 * 留一份快照，并给出可查看、可回滚的入口。
 *
 * 设计取舍：
 *   * 只留「即将被覆盖的内容」：回滚想要的正是它；新内容本来就在编辑器里；
 *   * 抽稀：每个文件最多 N 条、超过 M 天且不是该文件最新的几条就丢、全库总量封顶 ——
 *     否则历史表会无限膨胀（写作工具里正文动辄几百 KB）；
 *   * 判定全部放在这个纯函数里：数据库只负责增删，策略可被毫秒级单测覆盖。
 */

export interface HistoryEntryMeta {
  id: number
  path: string
  /** 快照时刻（写盘前的时间戳） */
  savedAt: number
  size: number
  /** 首行摘要（列表里显示；不把正文搬来搬去） */
  preview: string
}

export interface HistoryEntry extends HistoryEntryMeta {
  content: string
}

/** 单文件保留条数上限 */
export const HISTORY_LIMIT_PER_FILE = 30
/** 超过这个年龄的快照会被清掉（但每个文件至少留最新几条） */
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** 全库条数上限（兜底，防止历史表无限增长） */
export const HISTORY_MAX_TOTAL = 2000
/**
 * 全库**字节**上限（审计 §2 P1：以前只按条数封顶，而一条快照可能几百 KB ——
 * 30 条 × 20 篇 × 500KB 就是 300MB，全在 userData 里）。
 * 64MB 足够留住"这几天的几版"，同时把库压在一个可备份的量级。
 */
export const HISTORY_MAX_BYTES = 64 * 1024 * 1024
/** 年龄清理时，每个文件**至少**保留的最新条数 */
export const HISTORY_KEEP_NEWEST_PER_FILE = 3

/**
 * 列表里显示的一行摘要：去掉 Markdown 标记与空白，取前 max 个字符。
 * 与全局搜索的 snippet 不同，这里不求高亮，只要「能认出是哪一版」。
 */
export function historyPreview(content: string, max = 80): string {
  const firstLine =
    content
      .split('\n')
      .map((l) => l.replace(/^[\s>#*+-]+/, '').trim())
      .find((l) => l.length > 0) ?? ''
  const flat = firstLine.replace(/\s+/g, ' ')
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

export interface PruneOptions {
  limitPerFile?: number
  maxAgeMs?: number
  maxTotal?: number
  /** 全库字节上限（`entries[i].bytes` 之和；缺省 `HISTORY_MAX_BYTES`） */
  maxBytes?: number
  keepNewestPerFile?: number
  now?: number
}

/**
 * 算出哪些历史条目该删（返回 id 列表；纯函数，不碰数据库）。
 *
 * 规则（顺序固定，便于解释）：
 *  1. 按时间从新到旧走一遍；
 *  2. 单文件超过 `limitPerFile` → 丢；
 *  3. 太老（超过 `maxAgeMs`）→ 丢，但该文件最新的 `keepNewestPerFile` 条无论如何都留；
 *  4. 全库还超过 `maxTotal` → 丢掉最老的那些（同样已按文件计数保留在前面的）；
 *  5. 全库还超过 `maxBytes` → 从最老的开始丢，直到降到上限以下（**这一条不看**
 *     `keepNewestPerFile`：字节上限是硬闸，否则一份巨大的稿子能一个人撑爆整个库）。
 */
export function planHistoryPrune(
  entries: { id: number; path: string; savedAt: number; bytes?: number }[],
  options: PruneOptions = {}
): number[] {
  const limitPerFile = options.limitPerFile ?? HISTORY_LIMIT_PER_FILE
  const maxAgeMs = options.maxAgeMs ?? HISTORY_MAX_AGE_MS
  const maxTotal = options.maxTotal ?? HISTORY_MAX_TOTAL
  const maxBytes = options.maxBytes ?? HISTORY_MAX_BYTES
  const keepNewest = options.keepNewestPerFile ?? HISTORY_KEEP_NEWEST_PER_FILE
  const now = options.now ?? Date.now()

  const sorted = [...entries].sort((a, b) => b.savedAt - a.savedAt || b.id - a.id)
  const perFile = new Map<string, number>()
  const drop = new Set<number>()
  const kept: { id: number; path: string; savedAt: number; bytes?: number }[] = []

  for (const e of sorted) {
    const seen = perFile.get(e.path) ?? 0
    if (seen >= limitPerFile) {
      drop.add(e.id)
      continue
    }
    if (now - e.savedAt > maxAgeMs && seen >= keepNewest) {
      drop.add(e.id)
      continue
    }
    perFile.set(e.path, seen + 1)
    kept.push(e)
  }

  if (kept.length > maxTotal) {
    for (const e of kept.slice(maxTotal)) drop.add(e.id)
  }

  // 字节上限：kept 已按新→旧排序，从**尾部**（最老）往前丢
  let totalBytes = kept.reduce((n, e) => n + (e.bytes ?? 0), 0)
  const stillKept = kept.filter((e) => !drop.has(e.id))
  for (let i = stillKept.length - 1; i >= 0 && totalBytes > maxBytes; i -= 1) {
    const e = stillKept[i]
    drop.add(e.id)
    totalBytes -= e.bytes ?? 0
  }
  return [...drop]
}
