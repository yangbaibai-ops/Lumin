/**
 * ─── 文件编码目录（主/渲染共用）────────────────────────────────────────────────
 * 这里的 `label` 都是**专有名**（UTF-8 / GB18030 / Shift_JIS …），任何语言下都这么写，
 * 所以不进 i18n；只有「自动检测」是描述性文案，走 i18n key `encoding.auto`。
 *
 * `iconv` 是 iconv-lite 的编码名：真正读写字节时用它（见 main/services/encoding.ts）。
 */
export type EncodingId =
  | 'auto'
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le'
  | 'utf-16be'
  | 'gb18030'
  | 'gbk'
  | 'big5'
  | 'shift_jis'
  | 'euc-jp'
  | 'euc-kr'
  | 'windows-1251'
  | 'windows-1252'
  | 'latin1'

/** 可以显式指定的编码（不含「自动检测」） */
export type ConcreteEncoding = Exclude<EncodingId, 'auto'>

export interface EncodingInfo {
  id: ConcreteEncoding
  label: string
  /** iconv-lite 的编码名 */
  iconv: string
  /** 该编码在文件头可能带的 BOM（utf-8-bom 本身就是「utf-8 + 写 BOM」） */
  bom?: 'utf-8' | 'utf-16le' | 'utf-16be'
}

export const ENCODINGS: EncodingInfo[] = [
  { id: 'utf-8', label: 'UTF-8', iconv: 'utf8' },
  { id: 'utf-8-bom', label: 'UTF-8 BOM', iconv: 'utf8', bom: 'utf-8' },
  { id: 'utf-16le', label: 'UTF-16 LE', iconv: 'utf16le', bom: 'utf-16le' },
  { id: 'utf-16be', label: 'UTF-16 BE', iconv: 'utf16-be', bom: 'utf-16be' },
  { id: 'gb18030', label: 'GB18030', iconv: 'gb18030' },
  { id: 'gbk', label: 'GBK', iconv: 'gbk' },
  { id: 'big5', label: 'Big5', iconv: 'big5' },
  { id: 'shift_jis', label: 'Shift_JIS', iconv: 'shift_jis' },
  { id: 'euc-jp', label: 'EUC-JP', iconv: 'euc-jp' },
  { id: 'euc-kr', label: 'EUC-KR', iconv: 'euc-kr' },
  { id: 'windows-1251', label: 'Windows-1251', iconv: 'windows-1251' },
  { id: 'windows-1252', label: 'Windows-1252', iconv: 'windows-1252' },
  { id: 'latin1', label: 'Latin-1', iconv: 'latin1' }
]

/** id → 目录项；未知/`auto` 返回 null */
export function encodingOf(id: EncodingId): EncodingInfo | null {
  return ENCODINGS.find((e) => e.id === id) ?? null
}

/** id → iconv-lite 编码名（`auto` 与未知值回退 utf8） */
export function iconvName(id: EncodingId): string {
  return encodingOf(id)?.iconv ?? 'utf8'
}

/** id → 该编码要写出的 BOM（没有则 null） */
export function bomOf(id: EncodingId): 'utf-8' | 'utf-16le' | 'utf-16be' | null {
  return encodingOf(id)?.bom ?? null
}

/** 是否 UTF-8 家族（utf-8 / utf-8-bom）：这两者可以走 Node 内置编解码 */
export function isUtf8Family(id: EncodingId): boolean {
  return id === 'utf-8' || id === 'utf-8-bom'
}

/** 选择器用的完整列表：自动检测 + 全部具体编码（UI 里顺序即此顺序） */
export function encodingChoices(): EncodingId[] {
  return ['auto', ...ENCODINGS.map((e) => e.id)]
}
