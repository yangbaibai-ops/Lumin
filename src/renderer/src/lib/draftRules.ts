/**
 * ─── 草稿的键名与「值不值得端给用户」判定（纯函数，可单测）──────────────────────
 *
 * 这块逻辑连续出过三次真 bug（每次都是用户先发现，见手册 §4.44 / §4.45 / §4.49）：
 *   空草稿被当成「有未保存内容」→ 每次开窗都弹横幅；
 *   单独关窗清掉槽位 → 重启后只剩文件夹、文档变成"虚空"未命名；
 *   新窗口认领了别的窗口的草稿 → 按 Ctrl+N 却弹「检测到上次未保存的内容」。
 * 所以判定必须能被 `node --test` 直接钉住，而不要藏在 store 里。
 */

import { untitledDraftKey } from '../../../shared/drafts.ts'
import type { DraftInfo } from '../../../shared/types'
import { samePath } from './pathUtils.ts'

/** 草稿键：有路径按文件；未命名按窗口槽位（同一窗口的未命名缓冲只有一个） */
export function draftKeyFor(path: string | null, sessionSlot: number | null): string {
  if (!path) return untitledDraftKey(sessionSlot)
  return 'file-' + encodeURIComponent(path.toLowerCase())
}

/**
 * 草稿值不值得端给用户（横幅只在这种时候出现）：
 *  1. **内容必须与「马上就要显示的内容」不同** —— 一样就说明没有任何东西可恢复，
 *     弹横幅纯属噪声（历史实现里空草稿也会被写盘，于是每次开新窗口都冒一条假横幅）；
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
  if (!draft || draft.content === content) return false
  if (!path) return true
  if (!samePath(draft.path, path)) return false
  return mtimeMs !== null && draft.savedAt > mtimeMs + 1000
}
