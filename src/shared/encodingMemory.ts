// ─── 编码往返的诚实性：两条纯规则（审计 §2 P1「编码往返可能静默改字节」）────────
//
// 放在 shared 而不是 `main/services/encoding.ts`：那边 import 了 electron（系统 locale 兜底），
// 单测跑不起来；而这两条规则恰恰是"最容易写错、错了又没人发现"的那类判断：
//   * 解码结果里出现了 `U+FFFD` ⇒ 有字节没解出来（或者内容本身就有替换字符）——
//     必须**告诉用户**，因为"打开→保存"会把那些字节写成 `EF BF BD`，字节数就变了；
//   * 每文件编码记忆必须**附 mtime**：文件被外部换掉（git 切分支 / 同步盘）之后，
//     旧记忆会把合法的 UTF-8 解成乱码，用户继续编辑再保存就把乱码写回磁盘。
//     mtime 变了 ⇒ 记忆过期 ⇒ 回到判定链重新判。
import type { EncodingId } from './encodings'

export const REPLACEMENT_CHAR = '\uFFFD'

/** 解码文本里是否出现替换字符（说明有字节没能解出来，或原文就含它） */
export function hasReplacementChar(text: string): boolean {
  return text.includes(REPLACEMENT_CHAR)
}

/**
 * 记忆是否仍然可信：记的时候那个 mtime 与现在读到的是不是同一个版本。
 * * 任一侧拿不到时间戳（老记录没有 mtime / stat 失败）→ 视为**可信**：
 *   宁可沿用旧行为，也不要因为读不到时间戳就把用户显式选过的编码丢掉；
 * * 容差 1ms（同一版本两次 stat 的小数位波动）。
 */
export function encodingMemoryIsFresh(
  recordedMtimeMs: number | null | undefined,
  currentMtimeMs: number | null | undefined
): boolean {
  if (recordedMtimeMs == null || currentMtimeMs == null) return true
  if (!Number.isFinite(recordedMtimeMs) || !Number.isFinite(currentMtimeMs)) return true
  return Math.abs(recordedMtimeMs - currentMtimeMs) <= 1
}

/**
 * 解码时要不要带上「上次记住的编码」。
 *
 * 用户报障（「切到 GBK 后再点自动检测，仍停在 GBK」）的根因就在这一条：
 * 手动选编码会把 GBK 写进每文件记忆，自动检测又拿这份记忆去解码 ——
 * 判定链永远到不了「严格 UTF-8」那一步，于是磁盘字节明明没变、结果却是 GBK。
 *
 * 口径：
 *   * **显式「自动检测」**（`requested === 'auto'` 且不是打开文件时的软默认）：
 *     必须**忽略**记忆，只看这次从磁盘重新读出的原始字节；
 *   * 打开文件时的软默认（`softDefault`）：记忆仍然优先 —— 这是"同一文件多窗口一致"的来源，
 *     与"重新检测"是两件事。
 */
export function rememberedForRequest(
  requested: EncodingId,
  remembered: EncodingId | null | undefined,
  softDefault: boolean | undefined
): EncodingId | null {
  if (requested === 'auto' && !softDefault) return null
  return remembered ?? null
}

/**
 * 非 UTF-8 编码写盘前的**往返**判断：把文本按目标编码编码再解回来，
 * 与原文不一致 ⇒ 这次写盘会静默改字（典型：GBK 里表示不了的 emoji/西里尔字母被换成 `?`）。
 * 调用方据此提示用户"换 UTF-8 再存"，而不是让他事后从 git diff 里发现。
 */
export function roundTripLossy(text: string, decodedAfterRoundTrip: string): boolean {
  return decodedAfterRoundTrip !== text
}
