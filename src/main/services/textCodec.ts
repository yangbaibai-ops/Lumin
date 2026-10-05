// ─── 文本编解码的**纯实现**（报告 §6.2「encoding 没有 IO 单测」的落地）────────────
//
// 为什么从 `services/encoding.ts` 抽出来：那个文件里混着两件事 ——
//   ① **字节 ⇄ 文本的判定与转换**（BOM 嗅探、严格 UTF-8 校验、语言兜底、编解码）；
//   ② **每文件编码记忆**（读写 `documents` 表与 kv，要 `db`）；
// 而 `encoding.ts` 顶层 `import { app } from 'electron'`（拿系统语言）与 `import { db }`，
// 于是"字节有没有被改"这件**写作工具最核心的正确性**在 `node --test` 里根本 import 不进来。
// 抽出来之后：本模块零 electron、零 db、零 IO，`tests/textCodec.test.mjs` 直接喂字节断言。
//
// ⚠️ 行为口径与抽出前**逐字一致**（判定链的顺序就是优先级，见 `decodeBuffer` 的注释）。
// 唯一的接口变化：系统语言不再自己去问 electron，而是**由调用方注入**（`encoding.ts` 传
// `app.getLocale()`）—— 这样测试可以精确构造"中文环境 / 日文环境"两档。
import iconv from 'iconv-lite'
import {
  bomOf,
  iconvName,
  isUtf8Family,
  type ConcreteEncoding,
  type EncodingId
} from '../../shared/encodings.ts'
import { hasReplacementChar } from '../../shared/encodingMemory.ts'

/** BOM 表：id + 字节（嗅探用；顺序即优先级，UTF-32 之类不支持） */
const BOMS: { id: ConcreteEncoding; bytes: number[] }[] = [
  { id: 'utf-8-bom', bytes: [0xef, 0xbb, 0xbf] },
  { id: 'utf-16le', bytes: [0xff, 0xfe] },
  { id: 'utf-16be', bytes: [0xfe, 0xff] }
]

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false
  return true
}

/** 嗅探 BOM（返回编码 id 与 BOM 长度） */
export function sniffBom(buf: Buffer): { id: ConcreteEncoding; length: number } | null {
  for (const b of BOMS) {
    if (startsWith(buf, b.bytes)) return { id: b.id, length: b.bytes.length }
  }
  return null
}

/** 严格 UTF-8 判定：能过就是 UTF-8（`fatal` 下遇到非法序列会抛） */
export function isStrictUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/**
 * 按系统语言给一个「更可能对」的兜底编码（纯函数：locale 由调用方注入）。
 * 没有 BOM、也不是合法 UTF-8 的文件，只能靠环境猜：中文环境大概率 GB18030（GBK 的超集，
 * 也能读 GBK），日文 Shift_JIS，韩文 EUC-KR，俄文 Windows-1251，其余按西欧 Windows-1252。
 */
export function localeFallback(locale: string): ConcreteEncoding {
  const l = (locale || 'en-US').toLowerCase()
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
  /**
   * 解码结果里出现了替换字符 `U+FFFD`（审计 §2 P1：编码往返可能**静默**改字节）。
   * 有它就意味着"打开→保存"不会字节相等（那些字节会被写成 `EF BF BD`），
   * 所以必须让用户看见（状态栏 + 保存提示），而不是让他从 git diff 里发现。
   */
  hadReplacement: boolean
}

/** 文件里那个 BOM 是不是「属于」所选的编码（决定要不要摘掉、写回时装不装） */
export function bomBelongsTo(requested: ConcreteEncoding, bom: ConcreteEncoding): boolean {
  if (bom === 'utf-8-bom') return requested === 'utf-8' || requested === 'utf-8-bom'
  return bom === requested
}

/** 用某个具体编码解码（UTF-8 家族走内置，其余走 iconv-lite） */
export function decodeAs(buf: Buffer, id: ConcreteEncoding): string {
  if (isUtf8Family(id)) return new TextDecoder('utf-8').decode(buf)
  return iconv.decode(buf, iconvName(id))
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
 *
 * `locale` 由调用方注入（`encoding.ts` 传 `app.getLocale()`）—— 本模块不 import electron。
 */
export function decodeBuffer(
  buf: Buffer,
  requested: EncodingId = 'auto',
  remembered?: EncodingId | null,
  locale = 'en-US'
): DecodeResult {
  const bom = sniffBom(buf)
  // 每个分支都要带上 `hadReplacement`（漏一个就等于"这条路上静默改字节没人知道"）
  const out = (text: string, encoding: ConcreteEncoding, hadBom: boolean): DecodeResult => ({
    text,
    encoding,
    hadBom,
    hadReplacement: hasReplacementChar(text)
  })

  // 1) 显式指定：用户的选择优先于 BOM（但属于该编码的 BOM 要摘掉并记住）
  if (requested !== 'auto') {
    const keepBom = bom !== null && bomBelongsTo(requested, bom.id)
    return out(
      decodeAs(keepBom ? buf.subarray(bom.length) : buf, requested),
      requested,
      // 「UTF-8」这一项按语义就是不带 BOM：选它等于顺手把 BOM 去掉
      keepBom && requested !== 'utf-8'
    )
  }

  // 2) BOM
  if (bom) {
    const body = buf.subarray(bom.length)
    if (bom.id === 'utf-16le' || bom.id === 'utf-16be') {
      return out(iconv.decode(body, iconvName(bom.id)), bom.id, true)
    }
    return out(new TextDecoder('utf-8').decode(body), 'utf-8-bom', true)
  }

  // 3) 上次记住的
  if (remembered && remembered !== 'auto') {
    return out(decodeAs(buf, remembered), remembered, false)
  }

  // 4) 严格 UTF-8
  if (isStrictUtf8(buf)) {
    return out(new TextDecoder('utf-8').decode(buf), 'utf-8', false)
  }

  // 5) 系统语言兜底
  const guess = localeFallback(locale)
  try {
    return out(decodeAs(buf, guess), guess, false)
  } catch {
    // 6) 保险：utf-8 有损解码（不会抛）
    return out(new TextDecoder('utf-8').decode(buf), 'utf-8', false)
  }
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
