// ─── 改写预览的**行级 diff**（纯函数）────────────────────────────────────────
//
// 只服务 UI：把「原文 vs 新文」按行标成 same / add / del，渲染层据此上色。
// 不追求字符级 diff（改写结果通常是整段重写，行级已经足够可读），
// 也不需要第三方库（硬性约束：不新增依赖）。

export type AiDiffKind = 'same' | 'add' | 'del'

export interface AiDiffRow {
  kind: AiDiffKind
  text: string
}

/** 行数上限：超过就退化成"整段替换"的两块，避免 O(n*m) 在大文档上卡住预览。 */
const MAX_DIFF_LINES = 600

/** 统一换行、保留空行（末尾空行不算一行内容） */
function toLines(text: string): string[] {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 行级 diff（LCS）。返回按"原文顺序优先、新文插入紧随其后"排列的行。
 * 超过 `MAX_DIFF_LINES` 时：原文行全部 del、新文行全部 add（仍然能看出改了什么）。
 */
export function diffLines(before: string, after: string): AiDiffRow[] {
  const a = toLines(before)
  const b = toLines(after)
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text }))
    ]
  }
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows: AiDiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i] })
      i += 1
    } else {
      rows.push({ kind: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) rows.push({ kind: 'del', text: a[i++] })
  while (j < m) rows.push({ kind: 'add', text: b[j++] })
  return rows
}
