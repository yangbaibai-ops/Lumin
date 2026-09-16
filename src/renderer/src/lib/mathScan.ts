// ─── 公式的**识别规则**（纯函数，无依赖，可单测）──────────────────────────────
//
// 为什么单独抽出来：markdown-it 的规则写起来是「在 state 上前后挪位置」，很难读也很难测。
// 把「什么算一段公式」这件事抽成两个纯函数，规则只剩搬运位置；边界也终于能被钉住：
//
//   * 行内 `$…$`：不跨行、内容非空、**闭合 `$` 后面不能紧跟数字**
//     —— 否则「价格 $5 和 $6」会被吃成一段公式（这是各家编辑器都踩过的坑）；
//   * 转义：`\$` 不是公式起点（交给反斜杠转义那条规则处理）；
//   * `$$` 一律不当行内公式（块级由另一个函数认领）。
//
// 与「标记文本即源码」模型的关系：公式的**原文始终留在文档里**（markdown 序列化逐字写回），
// 渲染成 KaTeX 只是**视图**（见 mathPreview.ts 的替换装饰）。

/** 行内公式：`$…$`。命中返回这段公式的结束下标（不含）与内容；不是公式返回 null */
export function matchInlineMath(src: string, pos: number): { end: number; content: string } | null {
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return null
  // `$$` 不是行内公式（块级公式自己认领）
  if (pos + 1 < src.length && src[pos + 1] === '$') return null
  // `\$` 不是起点：反斜杠转义那条规则会处理它
  if (pos > 0 && src[pos - 1] === '\\') return null
  let p = pos + 1
  // 起始 `$` 后面不能直接是空白（`$ x$` 不当公式）
  if (p >= src.length || /\s/.test(src[p])) return null
  for (; p < src.length; p++) {
    const ch = src[p]
    if (ch === '\n') return null // 不跨行
    if (ch === '\\') {
      p++ // 跳过被转义的字符（`\$`、`\\`…）
      continue
    }
    if (ch !== '$') continue
    const content = src.slice(pos + 1, p)
    if (!content) return null
    // 闭合 `$` 后面紧跟数字 → 当成普通文本（"价格 $5 和 $6"）
    const next = src[p + 1]
    if (next !== undefined && /[0-9]/.test(next)) continue
    return { end: p + 1, content }
  }
  return null
}

/**
 * 块级公式：从 `startLine` 开始的一行 `$$…`。
 *
 * 两种写法都认：
 *   * 单行 `$$ x = 1 $$`
 *   * 多行 `$$` + 若干行 + `$$`（收尾 `$$` 必须独占一行，前后允许空白）
 * @returns 结束行号（含，0 基）与公式原文（不含分隔符、去掉首尾空行）
 */
export function matchBlockMath(
  lines: string[],
  startLine: number
): { endLine: number; content: string } | null {
  const first = lines[startLine]
  if (first === undefined) return null
  const open = /^\s*\$\$\s?(.*)$/.exec(first)
  if (!open) return null
  const rest = open[1]
  // 单行写法：`$$ … $$`
  const single = /^(.*?)\s*\$\$\s*$/.exec(rest)
  if (single && single[1].trim() !== '') return { endLine: startLine, content: single[1].trim() }
  if (rest.trim() === '' || single) {
    // 多行写法：往下找独占一行的 `$$`
    const body: string[] = []
    if (rest.trim() !== '' && !single) body.push(rest)
    for (let i = startLine + 1; i < lines.length; i++) {
      if (/^\s*\$\$\s*$/.test(lines[i])) {
        return { endLine: i, content: trimBlankEdges(body).join('\n') }
      }
      body.push(lines[i])
    }
    return null // 没有收尾 → 不是公式（按普通文本处理）
  }
  // `$$` 后面还有内容但没有收尾 `$$`：按行内写法理解不了，交给普通文本
  return null
}

/** 去掉首尾的空行（公式内容里的空行保留） */
function trimBlankEdges(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && lines[a].trim() === '') a++
  while (b > a && lines[b - 1].trim() === '') b--
  return lines.slice(a, b)
}
