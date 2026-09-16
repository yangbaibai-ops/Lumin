/**
 * ─── 文档文本规则（纯函数，可单测）────────────────────────────────────────────
 *
 * 「编辑器里的一段内容」与「磁盘上的一份文档」不是一回事，两者之间有几条**成文规则**。
 * 这些规则以前散在渲染层各处（或者干脆没有），结果是「打开→保存」文件会变，
 * 用户看到的是「编辑器偷偷改了我的文件」。集中到这里，谁都能复用、也能被 tests/ 直接测。
 *
 * 规则 1：非空文档以**且仅以**一个换行结尾。
 *   * 为什么必须补：POSIX 文本文件约定、git 的 "\ No newline at end of file" 噪声、
 *     追加内容时的踩踏风险（`cat a b` 会把两行黏在一起）；
 *   * 为什么必须只有**一个**：文末连续空行是纯噪声，序列化器也不该产出 `\n\n\n`；
 *   * 空文档保持空（补一个换行会让「全选删除」后的空文档变成 1 字节文件，
 *     而空白新文档保存成 0 字节更符合直觉）。
 */
export function withFinalNewline(text: string): string {
  if (!text) return text
  return text.replace(/\n+$/, '') + '\n'
}

/**
 * 代码围栏标记：内容里出现连续反引号时，围栏必须比它更长，否则围栏会被内容里的
 * ``` 提前闭合，后面的正文就被解析成代码（**内容损坏**，不是格式差异）。
 * CommonMark 的要求是围栏长度 ≥ 3 且不与内容里的连续反引号冲突。
 */
export function codeFenceFor(content: string): string {
  const runs = content.match(/`+/g)
  let longest = 0
  if (runs) for (const r of runs) longest = Math.max(longest, r.length)
  return '`'.repeat(Math.max(3, longest + 1))
}
