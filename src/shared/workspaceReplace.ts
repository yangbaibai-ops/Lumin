// ─── 跨文件（工作区级）替换的**纯逻辑**：哪些文件该改、每处替换成什么、谁必须跳过 ──
//
// 为什么单独一层：真正动盘的那部分（读编码、原子写、更新索引）在主进程
// `services/workspaceReplace.ts`；而"判定"与 IO 无关，放这里才能把边界逐条钉在
// `tests/workspaceReplace.test.mjs` 里。判错的后果比单文档替换重得多：一次错配会
// **同时改掉工作区里所有命中它的文件**，而 Ctrl+Z 只能撤回当前编辑器里的那一次。
//
// 三条口径与单文档查找/替换**完全一致**（同一份实现：shared/findReplace.ts）：
//   默认按字面量、正则要显式开、大小写开关照旧、`$1`/`$&` 只在正则模式下展开。
import { isTextFileName } from './textFiles.ts'
import { normPath } from './paths.ts'
import {
  findMatches,
  isValidQuery,
  replaceMatchesEach,
  replacementForMatch,
  type FindOptions
} from './findReplace.ts'
import type { WorkspaceReplaceRequest, WorkspaceReplaceResult } from './types.ts'

/** 参与判定的一个文件：正文由调用方读好，纯函数不碰盘 */
export interface ReplaceCandidateFile {
  path: string
  content: string
}

/** 命中且**会真的改写**的文件 */
export interface ReplaceChange {
  path: string
  /** 替换后的完整内容（行尾/编码由调用方按原文档口径落盘） */
  content: string
  /** 这个文件里替换了多少处 */
  count: number
}

/** 命中了但**绝不写**的文件（原因如实带出来给用户看） */
export interface ReplaceSkip {
  path: string
  count: number
  reason: 'dirty' | 'unsupported'
}

export interface ReplacePlan {
  /** 请求本身不可执行的原因（null = 可以执行；此时 changes 必为空） */
  invalid: WorkspaceReplaceResult['invalid']
  changes: ReplaceChange[]
  skipped: ReplaceSkip[]
  /** changes.length：会被改写的文件数 */
  files: number
  /** Σ change.count：会被替换的处数 */
  occurrences: number
}

/** 逐文件的写盘结果（主进程收集；纯数据，好让"部分成功"的账可单测） */
export interface ReplaceWriteOutcome {
  path: string
  /** 这个文件替换了多少处（失败时是"本来要替换多少处"） */
  count: number
  ok: boolean
  /** ok=false 时的原因（来自异常），逐个报告给用户 */
  reason?: string
}

/** 与查找/替换同一套选项口径 */
function optionsOf(req: WorkspaceReplaceRequest): FindOptions {
  return { caseSensitive: req.caseSensitive, regex: req.regex }
}

/**
 * 「这篇文档的编码表示不了替换后的正文」（只有非 UTF-8 才会发生：GBK 里的 emoji、西里尔字母…）。
 *
 * 主进程据此**不写**这一篇：一次批量替换不该把用户看不见的文件里的字符悄悄换成 `?`
 * （单文档保存是"写盘 + 当场提示改用 UTF-8"；批量操作里没人盯着那些文件，所以这里是拒绝 ——
 * 代价是这一篇没被替换，如实报出来，用户转成 UTF-8 再跑一次即可）。
 *
 * 码值格式定义在这里（唯一真相源）：渲染层用 `parseLossyReason` 取回编码、套既有文案。
 */
export const LOSSY_REASON_PREFIX = 'ENCODING_LOSSY:'

/** 构造「编码有损」的失败原因 */
export function lossyReason(encoding: string): string {
  return `${LOSSY_REASON_PREFIX}${encoding}`
}

/** 从失败原因里解出有损的那个编码；不是这条原因时返回 null */
export function parseLossyReason(reason: string): string | null {
  return reason.startsWith(LOSSY_REASON_PREFIX) ? reason.slice(LOSSY_REASON_PREFIX.length) : null
}

/**
 * 这次请求能不能执行。
 *
 * 空查询**不是**"零个文件命中"，而是一个不可执行的动作：照常往下走会得到
 * 「影响 0 个文件」的确认框，用户点下去什么也没发生 —— 宁可提前说清楚。
 * 正则语法错误同理（见 findReplace.compileQuery 的取舍）。
 */
export function replaceInvalidReason(
  req: WorkspaceReplaceRequest
): WorkspaceReplaceResult['invalid'] {
  if (!req.query.trim()) return 'empty-query'
  if (req.regex && !isValidQuery(req.query, { regex: true })) return 'invalid-regex'
  return null
}

/**
 * 一篇文档的替换结果。**纯函数**。
 *
 * `changed` 是给调用方的写盘判据：命中但替换后内容与原文逐字相同（`a` → `a`）时
 * `changed=false` —— 写它等于白白改一次 mtime（外部改动检测、历史快照都会跟着动）。
 */
export function planFileReplace(
  content: string,
  req: WorkspaceReplaceRequest
): { count: number; content: string; changed: boolean } {
  const opts = optionsOf(req)
  const matches = findMatches(content, req.query, opts)
  if (!matches.length) return { count: 0, content, changed: false }
  const next = replaceMatchesEach(content, matches, (m) =>
    replacementForMatch(req.replacement, m, opts)
  )
  return { count: matches.length, content: next, changed: next !== content }
}

/**
 * 整个候选集合的替换计划：**哪些文件该改、哪些必须跳过**。
 *
 * `dirtyPaths` = 「已打开且有未保存修改」的文档（脏标记只有渲染层知道）：它们的磁盘版本
 * 与用户屏幕上看到的东西**不是同一份**，写盘等于把用户正在编辑的内容从他眼皮底下换掉
 * （而且他下一次 Ctrl+S 会把旧内容再覆盖回来）。所以这类文档一律只跳过、不写，并如实列出。
 *
 * 非 Markdown / 非纯文本（图片、PDF…）同样不碰 —— 即使索引里混进了它们的路径。
 */
export function planWorkspaceReplace(
  files: readonly ReplaceCandidateFile[],
  req: WorkspaceReplaceRequest,
  opts: { dirtyPaths?: readonly string[] } = {}
): ReplacePlan {
  const invalid = replaceInvalidReason(req)
  if (invalid) return { invalid, changes: [], skipped: [], files: 0, occurrences: 0 }
  // 路径归一后比较：Windows 大小写不敏感，`C:\Ws\A.md` 与 `c:\ws\a.md` 是同一个文件
  const dirty = new Set((opts.dirtyPaths ?? []).map(normPath))
  const changes: ReplaceChange[] = []
  const skipped: ReplaceSkip[] = []
  let occurrences = 0
  for (const file of files) {
    const hit = planFileReplace(file.content, req)
    // 只改命中它的文件：没命中连"跳过"都不算（列出来只会变成噪音）
    if (!hit.count) continue
    if (!isTextFileName(file.path)) {
      skipped.push({ path: file.path, count: hit.count, reason: 'unsupported' })
      continue
    }
    if (dirty.has(normPath(file.path))) {
      skipped.push({ path: file.path, count: hit.count, reason: 'dirty' })
      continue
    }
    if (!hit.changed) continue
    changes.push({ path: file.path, content: hit.content, count: hit.count })
    occurrences += hit.count
  }
  return { invalid: null, changes, skipped, files: changes.length, occurrences }
}

/**
 * 把「计划 + 逐文件写盘结果」结算成回给渲染层的账。
 *
 * 「部分成功」必须如实（审计口径）：`written` 只数**真的落盘成功**的文件，失败的逐个带上
 * 原因 —— 绝不用计划数冒充结果，否则用户以为 5 篇都改了，实际只改了 3 篇。
 * 干跑（`applied=false`）时 `written` 恒为 0，`files`/`occurrences` 是"将会影响多少"。
 */
export function summarizeReplaceRun(
  plan: ReplacePlan,
  outcomes: readonly ReplaceWriteOutcome[],
  applied: boolean
): WorkspaceReplaceResult {
  const ok = outcomes.filter((o) => o.ok)
  return {
    invalid: plan.invalid,
    files: plan.files,
    occurrences: plan.occurrences,
    written: applied ? ok.length : 0,
    writtenOccurrences: applied ? ok.reduce((n, o) => n + o.count, 0) : 0,
    skippedDirty: plan.skipped.filter((s) => s.reason === 'dirty').map((s) => s.path),
    skippedUnsupported: plan.skipped.filter((s) => s.reason === 'unsupported').map((s) => s.path),
    failures: outcomes.filter((o) => !o.ok).map((o) => ({ path: o.path, reason: o.reason ?? '' })),
    applied
  }
}
