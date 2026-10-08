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
 * 「刚敲下收尾 `$`」这一刻能不能**立刻**收成一段行内公式 —— 纯函数，给输入规则用。
 *
 * 为什么要它：行内公式的 mark **只由 markdown 解析产生**（markdown-it 规则 → `<span data-md-math>`
 * → `MdMath`），而 markdown-it 只在「把 markdown 文本读进编辑器」时跑（打开文件 / 粘贴 / 切面）
 * —— **逐键打字不经过它**。于是用户依次敲 `$E=mc^2$` 打完还是一串纯文本（实测，见报告的时间线）。
 * 输入规则要在收尾 `$` 落下那一刻把这段文本收成公式，而「什么算公式」必须与解析**同一套判据**，
 * 否则输入规则与解析会各说各话（`\$` 转义、`$$`、闭合 `$` 后紧跟数字这些边界会漂）。
 *
 * 口径：把 `text` 当作 markdown-it 的 `state.src`，**左到右**扫描（与解析器的推进方式一致：
 * 命中一段就跳过整段继续往后），只有当某段的**收尾下标恰好等于 text.length**（= 刚敲的那个 `$`）
 * 时才算命中。取"最先能配上的那一段"而不是"离光标最近的开括号"：
 * `$a$ b $c$` 这种文本里，收尾 `$` 配的是 `$c`，前面那段已经配过了。
 *
 * @param text **光标之前的整段文本**，末尾就是刚敲下的那个 `$`（它此刻还没进文档）
 * @returns 命中时给出起始下标（相对 `text`）与含定界符的原文；否则 null
 */
export function matchInlineMathAtCaret(text: string): { from: number; raw: string } | null {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x24 /* $ */) continue
    const hit = matchInlineMath(text, i)
    if (!hit) continue
    if (hit.end === text.length) return { from: i, raw: text.slice(i) }
    // 这一段已经配好对了（收尾在光标之前）：跳到它后面继续找，与解析器的 `state.pos` 推进一致
    i = hit.end - 1
  }
  return null
}

/**
 * 一段文本里**所有配平的行内公式区间**（左到右、互不重叠，下标相对 `text`）。
 *
 * 与 `matchInlineMathAtCaret` 同一套推进方式，只是不做"收尾必须在末尾"的限制 —— 它回答的是
 * "这段文本里哪些片段是公式"。第十二轮两个地方用它，都是为了让**编辑器行为与 markdown-it
 * 解析口径一致**：
 *
 *   * **归一化**（`MdMath` 的 `appendTransaction`）：带 `mdMath` mark 但不再配平的文本要摘掉
 *     mark、退回普通文本 —— 用户在公式末尾按删除键把收尾 `$` 删掉后剩下 `$\frac{1}{2}`，
 *     它**不再是公式**：既不该继续画 KaTeX（更不该弹 "Can't use function '$' in math mode"），
 *     而打开文件时 markdown-it 本来也只会把它当普通文本；
 *   * **渲染切分**：相邻的多个 marked 文本节点会被合并成一段（见 mathPreview 的 collectMathHits），
 *     合并后可能出现 `$a$$b$` 这种"一段里两条公式" —— 按这里切出来的区间分别渲染，
 *     与解析器（`$a$` + `$b$` 两条）一致，而不是把中间的 `$` 当数学内容喂给 KaTeX。
 *
 * @returns 命中区间（含定界符），按起点升序；没有公式时是空数组
 */
export function scanInlineMathSpans(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x24 /* $ */) continue
    const hit = matchInlineMath(text, i)
    if (!hit) continue
    out.push({ from: i, to: hit.end })
    i = hit.end - 1
  }
  return out
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
