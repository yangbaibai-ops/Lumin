/**
 * ─── 文档文本小工具（纯函数，可单测）─────────────────────────────────────────
 * 从 `stores/files.ts` 里抽出来的：这些是**规则**（新建文档用什么编码/行尾、
 * 编码怎么显示、历史时间怎么格式化），不是状态，放在 store 里既测不了也容易被改坏。
 */

import { encodingOf, type ConcreteEncoding, type EncodingId } from '../../../shared/encodings.ts'
import { isEol, type Eol } from '../../../shared/eol.ts'

/** 未命名文档的编码：设置里选了具体编码就用它，'auto' 时当作 utf-8（新文件没得猜） */
export function untitledEncoding(defaultEncoding: EncodingId): ConcreteEncoding {
  return defaultEncoding === 'auto' ? 'utf-8' : defaultEncoding
}

/** 未命名文档的行尾：设置里的默认值（新文件没有「原本的行尾」）；非法值退回 LF */
export function untitledEol(defaultEol: unknown): Eol {
  return isEol(defaultEol) ? defaultEol : 'lf'
}

/** 编码 id → 给用户看的名字（专有名，不走 i18n） */
export function encodingLabel(id: ConcreteEncoding): string {
  return encodingOf(id)?.label ?? id
}

/** 历史条目的时间戳 → 本地可读时间（列表与 toast 共用） */
export function formatHistoryTime(savedAt: number): string {
  const d = new Date(savedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
