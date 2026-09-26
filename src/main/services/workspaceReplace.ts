// ─── 主进程：跨文件（工作区级）替换的**IO 编排** ──────────────────────────────
//
// 判定那一半在 `shared/workspaceReplace.ts`（纯函数、有单测）；这里只做三件事：
//   1. **候选集**：库里已索引、且**确实在当前工作区内**的 Markdown 文档。
//      复用全文索引那份清单（`workspaceIndex` 在建索引时走过的就是同一批文件），
//      不再扫一遍目录树；再过一道 `pathGuard.isInside` —— 库里的路径可能来自别的目录
//      （用户直接打开过的外部文档），跨文件替换只能落在工作区之内。
//   2. **读盘**：按**打开文件时的那一套**解（`getRememberedEncoding` 的每文件记忆 + 新鲜度
//      校验，见 services/encoding）—— 与 `file:read` 同一条判定链，于是"编辑器里看到的内容"
//      与"替换时读到的内容"必然一致。读不出内容的文件当失败逐条报告；
//      **已从磁盘消失的文件**（ENOENT）只是索引里的陈账，不当失败。
//   3. **落盘**：逐文件走 `fileOps.writeFile` 的原子写（同目录临时文件 + fsync + rename），
//      并按路径串行化（`serializeWrite`）—— 与 `file:write` 同一套纪律，不会和另一个窗口的
//      保存互相盖。写完把新正文写回索引（`indexDocumentForSearch`）与文档的编码/行尾/BOM
//      元数据（`setDocumentTextMeta`），留下的库状态与一次正常保存一致。
//
// 编码 / 行尾 / BOM **按原样回写**：批量替换不该顺手把 GBK 文档变成 UTF-8、
// 也不该把 CRLF 拍成 LF（读的时候是 LF 归一的内存形态，写的时候按原 EOL 展开）。
import path from 'path'
import { stat } from 'fs/promises'
import * as fileOps from '../fileOps'
import { isInside } from '../pathGuard'
import { db } from './database'
import { decodeBuffer, encodeText, getRememberedEncoding } from './encoding'
import { serializeWrite } from './writeQueue'
import { isMarkdownFile } from '../../shared/docExt'
import { isUtf8Family } from '../../shared/encodings'
import { roundTripLossy } from '../../shared/encodingMemory'
import {
  lossyReason,
  planWorkspaceReplace,
  replaceInvalidReason,
  summarizeReplaceRun,
  type ReplaceCandidateFile,
  type ReplaceChange,
  type ReplacePlan,
  type ReplaceWriteOutcome
} from '../../shared/workspaceReplace'
import type { WorkspaceReplaceRequest, WorkspaceReplaceResult } from '../../shared/types'
import type { ConcreteEncoding } from '../../shared/encodings'
import type { Eol } from '../../shared/eol'

/** 并发读多少篇：串行在几千篇的工作区上太慢，全放出去又会让机械盘抖成一片 */
const READ_CONCURRENCY = 8
/** 工作区里最多处理多少篇候选（极端工作区下别让一次点击跑成无底洞） */
const MAX_CANDIDATES = 5000

/** 让出事件循环（同步的 DB 写入与正则匹配之间必须给主进程喘气的机会） */
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** 一篇候选文档读盘后的落盘元数据（原编码 / 原行尾 / 原 BOM） */
interface ReadMeta {
  encoding: ConcreteEncoding
  eol: Eol
  hadBom: boolean
}

/** 读盘不需要的失败：文件已经不在索引里了（删掉/改名/临时不可达），不是"替换失败" */
function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 异常 → 一句能给用户看的原因（错误码如 PARENT_MISSING 由渲染层再本地化，见 lib/errors.ts） */
function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
 * 这次写盘会不会把正文里表示不了的字符换成 `?`（只有非 UTF-8 编码才可能）。
 *
 * 判据与 `file:write` 的往返比对**同一份实现**（`roundTripLossy` + `encodeText`/`decodeBuffer`）：
 * "编码往返可能静默改字节"这件事不该因为换了个入口（批量替换）就没人管。
 */
function wouldBeLossy(content: string, encoding: ConcreteEncoding, hadBom: boolean): boolean {
  if (isUtf8Family(encoding)) return false
  try {
    const back = decodeBuffer(encodeText(content, encoding, hadBom), encoding).text
    return roundTripLossy(content, back)
  } catch {
    return true // 编都编不出来：同样属于"这次写盘会改字"
  }
}

/** 工作区根（唯一数据源与 `fileOps.assertWorkspacePath` 一致：SQLite kv） */
function workspaceRoot(): string | null {
  return db.kvGet<{ root: string | null }>('workspace', { root: null }).root
}

/**
 * 候选文档：库里已索引 + 在当前工作区内 + 是 Markdown/纯文本。
 * 索引里可能有同一路径的两种大小写（不同来源写入），这里按小写去重。
 */
function candidatePaths(root: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of db.listDocumentPaths()) {
    if (out.length >= MAX_CANDIDATES) break
    if (!isMarkdownFile(p)) continue
    if (!isInside(root, p)) continue
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

interface ReadResult {
  files: ReplaceCandidateFile[]
  /** 路径（小写）→ 落盘用的元数据 */
  metas: Map<string, ReadMeta>
  /** 读不到的文档（已从磁盘消失的不算） */
  failures: ReplaceWriteOutcome[]
}

/**
 * 按 `READ_CONCURRENCY` 有界并发读完候选文档。
 *
 * 读失败分两类：文件已经不在了（ENOENT）→ 只是索引陈账，静默跳过；
 * 其他（权限、占用、编码炸）→ 记进 failures，逐个报给用户。
 */
async function readCandidates(paths: readonly string[]): Promise<ReadResult> {
  const files: ReplaceCandidateFile[] = []
  const metas = new Map<string, ReadMeta>()
  const failures: ReplaceWriteOutcome[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= paths.length) return
      const p = paths[i]
      try {
        /**
         * 与 `file:read` 同一条判定链：先 stat 拿当前 mtime，再问"上次记住的编码还算不算数"
         * （文件被 git 切分支 / 同步盘换掉之后 mtime 会变，那时旧记忆必须作废 —— 否则会把
         * 合法的 UTF-8 按旧编码解成乱码，替换命中后**把乱码写回磁盘**）。
         * `remembered` 交给 decodeBuffer 当第三条优先级的兜底，BOM 仍然压过记忆。
         */
        const currentMtimeMs = await stat(p).then(
          (st) => st.mtimeMs,
          () => null
        )
        const remembered = getRememberedEncoding(p, currentMtimeMs)
        const info = await fileOps.readFileInfo(p, 'auto', remembered)
        files.push({ path: p, content: info.content })
        metas.set(p.toLowerCase(), {
          encoding: info.encoding,
          eol: info.eol,
          hadBom: info.hadBom
        })
      } catch (err) {
        if (isGone(err)) continue
        failures.push({ path: p, count: 0, ok: false, reason: reasonOf(err) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker))
  // 并发读完的顺序不确定：按路径排一次，让用户看到的计划/失败列表是稳定的
  files.sort((a, b) => a.path.localeCompare(b.path))
  failures.sort((a, b) => a.path.localeCompare(b.path))
  return { files, metas, failures }
}

export interface ReplaceRunOptions {
  /** true = 只统计"会影响 N 个文件 / M 处"，一个字节都不写 */
  dryRun: boolean
  /** 写盘前的历史快照（复用 `ipc.ts` 保存路径里的同一份实现，注入进来而不是 import ipc） */
  beforeWrite?: (filePath: string, encoding: ConcreteEncoding, eol: Eol) => Promise<void>
}

/**
 * 跑一次跨文件替换。**不抛**：所有失败都进返回值，由界面如实报告。
 *
 * 读盘会跑两趟（预览一趟、真正替换一趟）：确认框必须在动盘**之前**给出"N 个文件 / M 处"，
 * 而命中与否只有读到正文才知道。两趟读换"绝不悄悄改"是划算的；代价在注释里说清，
 * 而不是用缓存计划换来一个"确认框里的数字与真实写入不一致"的隐患。
 */
export async function runWorkspaceReplace(
  req: WorkspaceReplaceRequest,
  opts: ReplaceRunOptions
): Promise<WorkspaceReplaceResult> {
  const root = workspaceRoot()
  if (!root) {
    return {
      invalid: 'no-workspace',
      files: 0,
      occurrences: 0,
      written: 0,
      writtenOccurrences: 0,
      skippedDirty: [],
      skippedUnsupported: [],
      failures: [],
      applied: false
    }
  }
  // 空查询 / 正则语法错：**先判、再读盘**（否则整个索引白读一遍，只为了得到"不可执行"）
  const invalid = replaceInvalidReason(req)
  if (invalid) {
    return summarizeReplaceRun(
      { invalid, changes: [], skipped: [], files: 0, occurrences: 0 },
      [],
      false
    )
  }

  const read = await readCandidates(candidatePaths(root))
  const planned = planWorkspaceReplace(read.files, req, { dirtyPaths: req.dirtyPaths })
  /**
   * 编码有损的文档**不进写入清单**（见 wouldBeLossy）：预览与真改走的是同一段判定，
   * 所以确认框里的「N 个文件 / M 处」就是真会写的数字，而不是"计划里算上、写的时候跳过"。
   */
  const changes: ReplaceChange[] = []
  const outcomes: ReplaceWriteOutcome[] = [...read.failures]
  for (const change of planned.changes) {
    const meta = read.metas.get(change.path.toLowerCase())
    if (meta && wouldBeLossy(change.content, meta.encoding, meta.hadBom)) {
      outcomes.push({
        path: change.path,
        count: change.count,
        ok: false,
        reason: lossyReason(meta.encoding)
      })
      continue
    }
    changes.push(change)
  }
  const plan: ReplacePlan = {
    ...planned,
    changes,
    files: changes.length,
    occurrences: changes.reduce((n, c) => n + c.count, 0)
  }
  // 干跑 / 没有任何文件需要改：都不落盘（applied=false）
  if (opts.dryRun || !plan.changes.length) {
    return summarizeReplaceRun(plan, outcomes, false)
  }

  for (const change of plan.changes) {
    /** changes 里的每一篇都读成功过（见上）；这里的兜底只为类型收敛，不改变行为 */
    const meta = read.metas.get(change.path.toLowerCase()) ?? {
      encoding: 'utf-8' as ConcreteEncoding,
      eol: 'lf' as Eol,
      hadBom: false
    }
    try {
      await serializeWrite(change.path, async () => {
        // 本地历史：写盘前把**即将被覆盖的那一版**留一份快照（与 Ctrl+S 同一条路）
        await opts.beforeWrite?.(change.path, meta.encoding, meta.eol)
        const mtimeMs = await fileOps.writeFile(
          change.path,
          change.content,
          meta.encoding,
          meta.hadBom,
          meta.eol
        )
        // 索引与元数据跟着走：搜索、下一次替换、以及"外部是否改过"的判据都必须是磁盘上的新状态
        db.indexDocumentForSearch(change.path, path.basename(change.path), change.content, mtimeMs)
        db.setDocumentTextMeta(change.path, {
          encoding: meta.encoding,
          eol: meta.eol,
          hadBom: meta.hadBom
        })
      })
      outcomes.push({ path: change.path, count: change.count, ok: true })
    } catch (err) {
      outcomes.push({
        path: change.path,
        count: change.count,
        ok: false,
        reason: reasonOf(err)
      })
    }
    await yieldToLoop()
  }
  return summarizeReplaceRun(plan, outcomes, true)
}
