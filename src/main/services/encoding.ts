import { app } from 'electron'
import iconv from 'iconv-lite'
import { db } from './database'
import {
  bomOf,
  iconvName,
  isUtf8Family,
  type ConcreteEncoding,
  type EncodingId
} from '../../shared/encodings'

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

/** 各类 BOM 的字节；顺序即嗅探顺序 */
const BOMS: { id: ConcreteEncoding; bytes: number[] }[] = [
  { id: 'utf-8-bom', bytes: [0xef, 0xbb, 0xbf] },
  { id: 'utf-16le', bytes: [0xff, 0xfe] },
  { id: 'utf-16be', bytes: [0xfe, 0xff] }
]

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false
  return bytes.every((b, i) => buf[i] === b)
}

/** 按 BOM 嗅探（BOM 是文件自己声明的，权威性最高） */
function sniffBom(buf: Buffer): { id: ConcreteEncoding; length: number } | null {
  for (const b of BOMS) {
    if (startsWith(buf, b.bytes)) return { id: b.id, length: b.bytes.length }
  }
  return null
}

/** 严格 UTF-8 判定：能过就是 UTF-8（`fatal` 下遇到非法序列会抛） */
function isStrictUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/**
 * 按系统语言给一个「更可能对」的兜底编码。
 * 没有 BOM、也不是合法 UTF-8 的文件，只能靠环境猜：中文环境大概率 GB18030（GBK 的超集，
 * 也能读 GBK），日文 Shift_JIS，韩文 EUC-KR，俄文 Windows-1251，其余按西欧 Windows-1252。
 */
function localeFallback(): ConcreteEncoding {
  let locale = 'en-US'
  try {
    locale = app.getLocale() || locale
  } catch {
    /* app 还没 ready 时拿不到，用默认 */
  }
  const l = locale.toLowerCase()
  if (l.startsWith('zh')) return 'gb18030'
  if (l.startsWith('ja')) return 'shift_jis'
  if (l.startsWith('ko')) return 'euc-kr'
  if (l.startsWith('ru')) return 'windows-1251'
  return 'windows-1252'
}

export interface DecodeResult {
  text: string
  /** 实际采用的编码（一定不是 'auto'） */
  encoding: ConcreteEncoding
  /** 文件是否带 BOM（写回时要保持一致） */
  hadBom: boolean
}

/**
 * 解码一个文件缓冲区。**判定链的顺序就是优先级**，逐条说明为什么这样排：
 *
 *  1. **调用方显式指定的具体编码**：用户在「选择编码重新打开」里明确点了某个编码，就必须听他的
 *     —— 这是那个菜单存在的意义。**BOM 也不能挡**：否则对带 BOM 的文件，菜单点了等于没反应
 *     （看着像坏了）。BOM 仍然有用：如果它正好属于所选编码，就把它摘掉并把 `hadBom` 记下来，
 *     写回时补回去；如果与所选编码不符（用户就是要强行换个解释），BOM 那几个字节就按普通字节解，
 *     此时 `hadBom=false`。
 *     顺带一个好处：显式选「UTF-8」正好是**去掉 BOM** 的办法（选 UTF-8 BOM 则相反，保存必然带 BOM）。
 *  2. **BOM 嗅探**：自动模式下 BOM 是文件自己写的声明，比任何猜测都可靠；
 *  3. **该文件上次记住的编码**：同一个文件反复打开时保持一致（kv `fileEncodings`）；
 *  4. **严格 UTF-8 能过 → utf-8**：UTF-8 是当代默认，且「能通过 fatal 校验」是很强的证据；
 *  5. **按系统语言兜底**（zh → GB18030、ja → Shift_JIS、ko → EUC-KR、ru → Windows-1251、其它 → Windows-1252）；
 *  6. **最后兜底 utf-8（有损）**：理论上到不了这里（1252 能解码任意字节），留作保险。
 */
export function decodeBuffer(
  buf: Buffer,
  requested: EncodingId = 'auto',
  remembered?: EncodingId | null
): DecodeResult {
  const bom = sniffBom(buf)

  // 1) 显式指定：用户的选择优先于 BOM（但属于该编码的 BOM 要摘掉并记住）
  if (requested !== 'auto') {
    const keepBom = bom !== null && bomBelongsTo(requested, bom.id)
    return {
      text: decodeAs(keepBom ? buf.subarray(bom.length) : buf, requested),
      encoding: requested,
      // 「UTF-8」这一项按语义就是不带 BOM：选它等于顺手把 BOM 去掉
      hadBom: keepBom && requested !== 'utf-8'
    }
  }

  // 2) BOM
  if (bom) {
    const body = buf.subarray(bom.length)
    if (bom.id === 'utf-16le' || bom.id === 'utf-16be') {
      return { text: iconv.decode(body, iconvName(bom.id)), encoding: bom.id, hadBom: true }
    }
    return { text: new TextDecoder('utf-8').decode(body), encoding: 'utf-8-bom', hadBom: true }
  }

  // 3) 上次记住的
  if (remembered && remembered !== 'auto') {
    return { text: decodeAs(buf, remembered), encoding: remembered, hadBom: false }
  }

  // 4) 严格 UTF-8
  if (isStrictUtf8(buf)) {
    return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8', hadBom: false }
  }

  // 5) 系统语言兜底
  const guess = localeFallback()
  try {
    return { text: decodeAs(buf, guess), encoding: guess, hadBom: false }
  } catch {
    // 6) 保险：utf-8 有损解码（不会抛）
    return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8', hadBom: false }
  }
}

/** 文件里那个 BOM 是不是「属于」所选的编码（决定要不要摘掉、写回时装不装） */
function bomBelongsTo(requested: ConcreteEncoding, bom: ConcreteEncoding): boolean {
  if (bom === 'utf-8-bom') return requested === 'utf-8' || requested === 'utf-8-bom'
  return bom === requested
}

/** 用某个具体编码解码（UTF-8 家族走内置，其余走 iconv-lite） */
function decodeAs(buf: Buffer, id: ConcreteEncoding): string {
  if (isUtf8Family(id)) return new TextDecoder('utf-8').decode(buf)
  return iconv.decode(buf, iconvName(id))
}

// ─── 每文件编码记忆 ──────────────────────────────────────────────────────────
// **Wave 2 起权威来源是 `documents` 表的 encoding 列**（跟着文件走、两个窗口一致、
// 重启后仍在）。下面这个 kv 表只保留给「文件还没进索引」的极少数情况兜底
// （见 database.migrateFileEncodings：迁移时把能对上的条目搬进 documents，剩下的留在这里）。
const KV_KEY = 'fileEncodings'
const MAX_REMEMBERED = 200

function normKey(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

function loadMap(): Record<string, ConcreteEncoding> {
  return db.kvGet<Record<string, ConcreteEncoding>>(KV_KEY, {})
}

/**
 * 该文件上次记住的编码（没有则 null）。
 * 先查 documents（权威），再退回 kv 兜底表。
 */
export function getRememberedEncoding(filePath: string): ConcreteEncoding | null {
  const meta = db.getDocumentMeta(filePath)
  if (meta?.encoding) return meta.encoding as ConcreteEncoding
  const map = loadMap()
  return map[normKey(filePath)] ?? null
}

/**
 * 记住某文件的编码。
 * 文档已在索引里 → 写 documents（权威）；否则按老办法写 kv 兜底表（重复写入会挪到队尾 = 最近使用）。
 */
export function rememberEncoding(filePath: string, encoding: ConcreteEncoding): void {
  const key = normKey(filePath)
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

/**
 * 按编码把文本编成字节，并按需补 BOM。
 * `utf-8-bom` 视作「utf-8 + 写 BOM」；`keepBom` 由调用方按文件的 hadBom 传进来，
 * 这样「原样写回」不会平白多出或少掉一个 BOM。
 * UTF-16 **总是**写 BOM：没有 BOM 的 UTF-16 文件几乎无法被别的软件识别，所以哪怕用户是从
 * 无 BOM 的 UTF-8 切过来的，也给它补上（这是「选 UTF-16」这个动作的合理预期）。
 */
export function encodeText(text: string, encoding: ConcreteEncoding, keepBom: boolean): Buffer {
  const target: ConcreteEncoding = encoding === 'utf-8-bom' ? 'utf-8' : encoding
  const body = isUtf8Family(target)
    ? Buffer.from(text, 'utf-8')
    : iconv.encode(text, iconvName(target))

  const isUtf16 = target === 'utf-16le' || target === 'utf-16be'
  // utf-8-bom 这个「编码本身」就意味着要写 BOM；其余按 keepBom（UTF-16 例外，见上）
  const wantBom = encoding === 'utf-8-bom' || isUtf16 || keepBom
  const bomBytes = wantBom ? (bomOf(target) ?? bomOf(encoding)) : null
  if (!bomBytes) return body

  const prefix =
    bomBytes === 'utf-8'
      ? Buffer.from([0xef, 0xbb, 0xbf])
      : bomBytes === 'utf-16le'
        ? Buffer.from([0xff, 0xfe])
        : Buffer.from([0xfe, 0xff])
  return Buffer.concat([prefix, body])
}
