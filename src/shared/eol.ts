/**
 * ─── 行尾（EOL）规则（纯函数，可单测）──────────────────────────────────────────
 *
 * 为什么要有这一层：编辑器内部（Tiptap/ProseMirror、markdown 序列化器）只产出 `\n`。
 * 如果磁盘上本来是 CRLF，那么「打开 → 动一下 → 保存」会把**每一行**的行尾都换掉 ——
 * 在 git 里就是整文件 diff（`git diff --ignore-cr-at-eol` 之前一片红）。
 * 所以行尾必须和编码一样，成为**文档级元数据**：打开时判定一次，写回时按它还原。
 *
 * 内存约定：**内存里的文本一律是 LF**（打开时归一），落盘时按文档记录的 EOL 展开。
 * 这样只有一个真相：编辑器怎么改都不会污染行尾，行尾由文档属性决定。
 *
 * 混合行尾（同一文件里 CRLF 与 LF 混用）没有「正确答案」：按**占多数**的那种判定，
 * 保存时会统一成它（并会在状态栏看到行尾标记）。这条写进文档，避免被当成 bug。
 */

export type Eol = 'lf' | 'crlf'

/** UI 里的展示顺序（切换按钮按这个顺序轮换） */
export const EOL_OPTIONS: Eol[] = ['lf', 'crlf']

export function isEol(value: unknown): value is Eol {
  return value === 'lf' || value === 'crlf'
}

export function eolLabel(eol: Eol): string {
  return eol === 'crlf' ? 'CRLF' : 'LF'
}

/** 另一种行尾（状态栏点击轮换用） */
export function otherEol(eol: Eol): Eol {
  return eol === 'crlf' ? 'lf' : 'crlf'
}

/**
 * 判定文本的行尾：数 CRLF 与「单独的 LF」，取多的那种。
 * 空文本/没有换行 → `lf`（当代默认，也是我们内存里的形态）。
 */
export function detectEol(text: string): Eol {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf += 1
    else lf += 1
  }
  return crlf > lf ? 'crlf' : 'lf'
}

/** 归一为 LF（内存形态）：CRLF 与孤立的 CR 都变成 LF */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 按目标行尾展开（落盘形态）；幂等：已经是目标形态时不改动 */
export function toEol(text: string, eol: Eol): string {
  const lf = toLf(text)
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}

/**
 * 行尾是否与记录一致。用来回答「这次保存会不会改到行尾」——
 * 一致时不做事，避免混合行尾文件被无意义地重写。
 */
export function hasUniformEol(text: string, eol: Eol): boolean {
  return toEol(text, eol) === text
}
