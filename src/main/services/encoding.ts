import { app } from 'electron'
import { db } from './database'
import { type ConcreteEncoding, type EncodingId } from '../../shared/encodings'
// 两条纯规则（替换字符检测 / 记忆新鲜度）放在 shared：那边不 import electron，可单测
import { encodingMemoryIsFresh } from '../../shared/encodingMemory'
/**
 * 编解码的**纯实现**搬到了 `services/textCodec.ts`（报告 §6.2：`encoding.ts` 顶层 import
 * electron 与 db，于是"字节有没有被改"这件最核心的正确性进不了 `node --test`）。
 * 这里保留产品语义与**编码记忆**（要读写 `documents` 表与 kv），并把系统语言注入进去。
 */
import { decodeBuffer as decodeBufferPure, encodeText, type DecodeResult } from './textCodec'

export { encodeText }
export type { DecodeResult }

/**
 * ─── 文件编码的判定与编解码 ────────────────────────────────────────────────────
 *
 * ### 为什么解码/编码要分两套
 * Node 内置的 `TextDecoder`（Electron 带完整 ICU）能解很多编码，但 **`TextEncoder` 只支持 UTF-8**，
 * 所以「按原编码写回」这件事用标准库做不到。而 iconv-lite 是纯 JS、无原生编译、体积小、
 * 绝大多数项目都在用的主流库（本项目里 mermaid → d3 → d3-dsv 本来就带着它），所以：
 *   * UTF-8 家族（utf-8 / utf-8-bom）走 Node 内置（快，且和 V8 行为一致）；
 *   * 其余编码的解码与编码都用 iconv-lite。
 */

/**
 * 解码入口（产品侧）：系统语言**由这一层注入** —— `textCodec` 不 import electron，
 * 于是它能被单测直接喂字节（`tests/textCodec.test.mjs`）。
 */
export function decodeBuffer(
  buf: Buffer,
  requested: EncodingId = 'auto',
  remembered?: EncodingId | null
): DecodeResult {
  let locale = 'en-US'
  try {
    locale = app.getLocale() || locale
  } catch {
    /* app 还没 ready 时拿不到，用默认 */
  }
  return decodeBufferPure(buf, requested, remembered, locale)
}

// ─── 每文件编码记忆 ──────────────────────────────────────────────────────────
// **Wave 2 起权威来源是 `documents` 表的 encoding 列**（跟着文件走、两个窗口一致、
// 重启后仍在）。下面这个 kv 表只保留给「文件还没进索引」的极少数情况兜底
// （见 database.migrateFileEncodings：迁移时把能对上的条目搬进 documents，剩下的留在这里）。
const KV_KEY = 'fileEncodings'
/**
 * 「记忆 + 记录时的 mtime」：**过期记忆会骗人**（审计 §2 P1）。
 * 文件被外部换掉（git 切分支 / 同步盘）之后，旧记忆会把合法的 UTF-8 解成乱码，
 * 用户继续编辑再保存就把乱码写回磁盘。所以记忆必须**与它当时的文件版本绑在一起**。
 */
const MTIME_KEY = 'fileEncodingMtimes'
const MAX_REMEMBERED = 200

function normKey(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

function loadMap(): Record<string, ConcreteEncoding> {
  return db.kvGet<Record<string, ConcreteEncoding>>(KV_KEY, {})
}

function loadMtimes(): Record<string, number> {
  return db.kvGet<Record<string, number>>(MTIME_KEY, {})
}

/** 某文件"记下编码时的 mtime"（没有记录 → null） */
function rememberedMtime(filePath: string): number | null {
  const m = loadMtimes()[normKey(filePath)]
  return typeof m === 'number' && Number.isFinite(m) ? m : null
}

/** 把这条记忆（编码 + mtime）整体忘掉：过期的记忆留着只会继续骗人 */
export function forgetEncoding(filePath: string): void {
  const key = normKey(filePath)
  const mtimes = loadMtimes()
  if (key in mtimes) {
    delete mtimes[key]
    db.kvSet(MTIME_KEY, mtimes)
  }
  const map = loadMap()
  if (key in map) {
    delete map[key]
    db.kvSet(KV_KEY, map)
  }
  // documents 那一列也清掉（否则它还是"权威来源"）
  if (db.getDocumentMeta(filePath)) db.setDocumentTextMeta(filePath, { encoding: '' })
}

/**
 * 该文件上次记住的编码（没有则 null）。
 * 先查 documents（权威），再退回 kv 兜底表。
 *
 * @param currentMtimeMs 文件**现在**的 mtime；给了就做新鲜度校验：
 *   与记录时不一致 ⇒ 记忆过期 ⇒ 忘掉它并返回 null（回到判定链重新判）。
 *   这样"文件被外部换成 UTF-8"之后不会被旧记忆解成乱码。
 */
export function getRememberedEncoding(
  filePath: string,
  currentMtimeMs?: number | null
): ConcreteEncoding | null {
  const recorded = rememberedMtime(filePath)
  if (!encodingMemoryIsFresh(recorded, currentMtimeMs)) {
    forgetEncoding(filePath)
    return null
  }
  const meta = db.getDocumentMeta(filePath)
  if (meta?.encoding) return meta.encoding as ConcreteEncoding
  const map = loadMap()
  return map[normKey(filePath)] ?? null
}

/**
 * 记住某文件的编码。
 * 文档已在索引里 → 写 documents（权威）；否则按老办法写 kv 兜底表（重复写入会挪到队尾 = 最近使用）。
 * `mtimeMs` 一并记下：下次打开时据此判断这份记忆有没有过期（见 getRememberedEncoding）。
 */
export function rememberEncoding(
  filePath: string,
  encoding: ConcreteEncoding,
  mtimeMs?: number | null
): void {
  const key = normKey(filePath)
  if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) {
    const mtimes = loadMtimes()
    delete mtimes[key]
    mtimes[key] = mtimeMs
    const keys = Object.keys(mtimes)
    if (keys.length > MAX_REMEMBERED) {
      for (const k of keys.slice(0, keys.length - MAX_REMEMBERED)) delete mtimes[k]
    }
    db.kvSet(MTIME_KEY, mtimes)
  }
  if (db.getDocumentMeta(filePath)) {
    db.setDocumentTextMeta(filePath, { encoding })
    // 顺手把兜底表里的同名条目清掉，避免两处不一致
    const map = loadMap()
    if (map[key]) {
      delete map[key]
      db.kvSet(KV_KEY, map)
    }
    return
  }
  const map = loadMap()
  delete map[key]
  map[key] = encoding
  const keys = Object.keys(map)
  if (keys.length > MAX_REMEMBERED) {
    for (const k of keys.slice(0, keys.length - MAX_REMEMBERED)) delete map[k]
  }
  db.kvSet(KV_KEY, map)
}
