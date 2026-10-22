/**
 * ─── 草稿的键名与「值不值得端给用户」判定（纯函数，可单测）──────────────────────
 *
 * 这块逻辑连续出过三次真 bug（每次都是用户先发现，见手册 §4.44 / §4.45 / §4.49）：
 *   空草稿被当成「有未保存内容」→ 每次开窗都弹横幅；
 *   单独关窗清掉槽位 → 重启后只剩文件夹、文档变成"虚空"未命名；
 *   新窗口认领了别的窗口的草稿 → 按 Ctrl+N 却弹「检测到上次未保存的内容」。
 * 所以判定必须能被 `node --test` 直接钉住，而不要藏在 store 里。
 *
 * ─── 本轮（用户报障：第一次打开文档就弹「未保存的文档 + 未保存的草稿」）──────────
 * 用户口径：**没改过就不该有草稿/提示**。两条口径在这里收口：
 *   1. 内容比较一律用**归一化**（`sameDocumentText`：CRLF/尾随空行不算差异），
 *      不是逐字节 `===`。旧实现里草稿内容只差一个尾随换行也会被判成"可恢复"，
 *      于是旧版本留下的假草稿会在**第一次打开**时变成一条横幅。
 *   2. 打开文件时对旧草稿做一次**处置**（`planDraftOnOpen`）：
 *      内容与磁盘一致 / 不比磁盘新 ⇒ 直接清掉；只有"真的不同 + 确实更新"才留给用户。
 *      清掉而不是留着：那份草稿没有任何恢复价值，留着只会在下次打开时再被判一次。
 */

import { fileDraftKey, untitledDraftKey } from '../../../shared/drafts.ts'
import type { DraftInfo } from '../../../shared/types'
import { sameDocumentText } from '../../../shared/documentText.ts'
import { samePath } from './pathUtils.ts'

/** 草稿键：有路径按文件；未命名按窗口槽位（同一窗口的未命名缓冲只有一个） */
export function draftKeyFor(path: string | null, sessionSlot: number | null): string {
  if (!path) return untitledDraftKey(sessionSlot)
  // 键的构造放在 shared：主进程的草稿 GC 靠 `file-` 前缀认"有磁盘正本"，两处必须一致
  return fileDraftKey(path)
}

/** 打开文件时怎么处置盘上的旧草稿 */
export type DraftOnOpen =
  /** 没有草稿（或它不是这一篇的：不碰，避免误删别人的正文） */
  | 'none'
  /** 真的比磁盘新且内容不同 ⇒ 端给用户决定恢复/丢弃 */
  | 'keep'
  /** 没有任何恢复价值（内容与磁盘一致 / 不比磁盘新 / 空草稿）⇒ 删掉 */
  | 'purge'

/**
 * 打开一份文档时，盘上那份同键草稿该怎么处置。
 *
 * 判据顺序（每条都对应一种"假草稿"来源）：
 *  1. **未命名缓冲区**（没有磁盘正本）：与空白缓冲一致 / 空草稿 ⇒ `purge`，
 *     只有非空内容才值得恢复（没有 mtime 可比）；
 *  2. 路径不符（哈希键理论撞键）⇒ `none`：**不删**，那可能是另一篇的正文
 *     （顺序必须在"内容一致"之前：否则会拿本篇磁盘内容当依据删掉别人的草稿）；
 *  3. **归一化后与磁盘一致** ⇒ `purge`。打开/模式切换/旧版本曾把序列化结果写进草稿，
 *     内容与磁盘只差尾随换行/CRLF —— 这就是「第一次打开却提示未保存草稿」的主因；
 *  4. 拿不到磁盘 mtime ⇒ `none`：没法证明草稿更新，先不打扰、也不删除（保守）；
 *  5. 磁盘上的才是正本：草稿不比它新（含 1s 容差）⇒ `purge` —— 留着也没有恢复价值。
 *
 * @param content 马上要显示的内容（磁盘读出来的原文）
 * @param mtimeMs 磁盘 mtime；`null` = 未落盘 / 读不到
 */
export function planDraftOnOpen(
  draft: DraftInfo | null,
  content: string,
  path: string | null,
  mtimeMs: number | null
): DraftOnOpen {
  if (!draft) return 'none'
  if (!path) {
    if (sameDocumentText(draft.content, content)) return 'purge'
    return draft.content.trim() ? 'keep' : 'purge'
  }
  if (!samePath(draft.path, path)) return 'none'
  if (sameDocumentText(draft.content, content)) return 'purge'
  if (mtimeMs === null) return 'none'
  return (draft.savedAt ?? 0) > mtimeMs + 1000 ? 'keep' : 'purge'
}

/**
 * 草稿值不值得端给用户（横幅只在这种时候出现）：
 *  1. **内容必须与「马上就要显示的内容」不同**（归一化口径）—— 一样就说明没有任何东西
 *     可恢复，弹横幅纯属噪声（历史实现里空草稿也会被写盘，于是每次开新窗口都冒一条假横幅）；
 *  2. 未命名缓冲区（没有磁盘正本）只要内容不同就值得恢复；
 *  3. 有磁盘文件时再看时间：磁盘上的才是正本，草稿不比它新就不该顶掉它
 *     （留 1s 容差 —— 文件系统时间戳与本地时钟本就不完全同源）；
 *  4. 键名对文件名里的 `.`/`_` 会折叠，理论上存在撞键，故再核对一次草稿记的路径。
 */
export function restorableDraft(
  draft: DraftInfo | null,
  content: string,
  path: string | null,
  mtimeMs: number | null
): boolean {
  return planDraftOnOpen(draft, content, path, mtimeMs) === 'keep'
}
