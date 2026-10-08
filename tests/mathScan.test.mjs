// 公式识别规则（src/renderer/src/lib/mathScan.ts）的单测。
//
// 这层判错的后果很具体：**把普通文本吃成公式**（"价格 $5 和 $6" 整段变公式，
// 渲染成乱码数学），或者**该是公式的地方不认**（KaTeX 白装）。所以两边都钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchBlockMath,
  matchInlineMath,
  matchInlineMathAtCaret,
  scanInlineMathSpans
} from '../src/renderer/src/lib/mathScan.ts'
import { hasBlockMathText } from '../src/renderer/src/lib/editor/mathPaste.ts'

const inline = (s) => matchInlineMath(s, s.indexOf('$'))

test('行内公式：基本识别（结束下标与内容）', () => {
  assert.deepEqual(inline('$E = mc^2$'), { end: 10, content: 'E = mc^2' })
  assert.deepEqual(inline('公式 $x_1 + y_2$ 结束'), { end: 14, content: 'x_1 + y_2' })
})

test('不在 `$` 位置上、空内容、跨行 → 都不是公式', () => {
  assert.equal(matchInlineMath('abc', 0), null)
  assert.equal(inline('$$'), null, '$$ 是块级')
  assert.equal(inline('$ x$'), null, '起始 $ 后不能是空白')
  assert.equal(inline('$\nx$'), null, '不跨行')
  assert.equal(matchInlineMath('x$', 1), null, '没有闭合')
})

test('闭合 $ 后面紧跟数字 → 不当公式（"价格 $5 和 $6" 那种）', () => {
  assert.equal(inline('$5 和 $6'), null)
  assert.equal(inline('$a$1'), null)
})

test('转义：`\\$` 不是公式起点，公式内的 `\\$` 不当作闭合', () => {
  assert.equal(matchInlineMath('\\$x$', 1), null, '前一个字符是反斜杠 → 不是起点')
  // `$a \$ b$` 里的 `\$` 是被转义的美元符号，闭合在最后那个 `$`
  assert.deepEqual(inline('$a \\$ b$'), { end: 8, content: 'a \\$ b' })
})

test('块级公式：多行写法', () => {
  const lines = ['块级：', '', '$$', '\\int_0^1 x^2 dx = \\frac{1}{3}', '$$', '', '后面']
  assert.deepEqual(matchBlockMath(lines, 2), {
    endLine: 4,
    content: '\\int_0^1 x^2 dx = \\frac{1}{3}'
  })
})

test('块级公式：单行写法', () => {
  assert.deepEqual(matchBlockMath(['$$ x = 1 $$'], 0), { endLine: 0, content: 'x = 1' })
})

test('块级公式：内容里的空行保留，首尾空行去掉', () => {
  const lines = ['$$', '', 'a = 1', '', 'b = 2', '', '$$']
  assert.deepEqual(matchBlockMath(lines, 0), { endLine: 6, content: 'a = 1\n\nb = 2' })
})

test('块级公式：没有收尾 `$$` 就不算（按普通文本处理）', () => {
  assert.equal(matchBlockMath(['$$', 'a = 1', '正文'], 0), null)
})

test('块级公式：`$$` 开头的行但不是公式时返回 null', () => {
  assert.equal(matchBlockMath(['$$$ 三块钱'], 0), null, '`$$$` 不是 `$$ ` 开头')
  assert.equal(matchBlockMath(['正文'], 0), null)
})

// ─── 「刚敲下收尾 `$`」的判定（输入规则用；第十轮）────────────────────────────────
//
// 这一层判错的后果同样是具体的：要么"打完 `$E=mc^2$` 什么都不出现"（用户的报障），
// 要么"输入规则自己发明一套边界"（与解析规则漂开）。所以正反两面都钉。
test('光标判定：*恰好在收尾 `$` 上*才算命中，下标与原文都要对', () => {
  assert.deepEqual(matchInlineMathAtCaret('$E=mc^2$'), { from: 0, raw: '$E=mc^2$' })
  assert.deepEqual(matchInlineMathAtCaret('文字 $x_1$'), { from: 3, raw: '$x_1$' })
  // 末尾这个 `$` 之前已经没有"还没配过对"的开括号了 ⇒ 不成公式（不会硬把它当收尾）
  assert.equal(matchInlineMathAtCaret('文字 $x_1$ 尾巴$'), null)
})

test('光标判定：与解析同口径的左到右配对（前面已配好的那段不算）', () => {
  // `$a$ b $c$`：收尾 `$` 配的是 `$c`，不是 `$a`
  assert.deepEqual(matchInlineMathAtCaret('$a$ b $c$'), { from: 6, raw: '$c$' })
  // 已被吃掉的那一段后面还有开括号、但没闭合 ⇒ 不成公式
  assert.equal(matchInlineMathAtCaret('$a$ b $c'), null)
})

test('光标判定：边界与解析规则逐条一致（`\\$` / `$$` / 起始空白 / 收尾后紧跟数字）', () => {
  assert.equal(matchInlineMathAtCaret('\\$x$'), null, '`\\$` 不是起点')
  assert.equal(matchInlineMathAtCaret('$$'), null, '`$$` 是块级')
  assert.equal(matchInlineMathAtCaret('$ x$'), null, '起始 `$` 后不能是空白')
  assert.equal(matchInlineMathAtCaret('$a$1'), null, '收尾 `$` 后紧跟数字 → 不算')
  assert.equal(matchInlineMathAtCaret('$E=mc^2'), null, '没有收尾 `$`')
  assert.equal(matchInlineMathAtCaret('$\nx$'), null, '不跨行')
  // 与解析同口径：`$5 和 $6$` 这一段在两侧都成立（收尾 `$` 后面没有数字）
  assert.deepEqual(matchInlineMathAtCaret('$5 和 $6$'), { from: 0, raw: '$5 和 $6$' })
})

// ─── 「这段文本里哪些片段是配平的公式」（第十二轮：归一化 + 渲染切分用）──────────────
test('配平扫描：只交出**成对**的区间，不配平的部分一律不认', () => {
  assert.deepEqual(scanInlineMathSpans('$E=mc^2$'), [{ from: 0, to: 8 }])
  assert.deepEqual(scanInlineMathSpans('前面 $a$ 后面 $b$'), [
    { from: 3, to: 6 },
    { from: 10, to: 13 }
  ])
  // 用户在公式末尾按删除键删掉收尾 `$` 之后的两种残形：都不是公式
  assert.deepEqual(scanInlineMathSpans('$E=mc^2'), [], '删掉收尾 $ ⇒ 不配平')
  assert.deepEqual(scanInlineMathSpans('E=mc^2$'), [], '删掉开头 $ ⇒ 不配平')
  assert.deepEqual(scanInlineMathSpans('$'), [], '只剩一个 $')
  assert.deepEqual(scanInlineMathSpans('$$'), [], '$$ 是块级')
  assert.deepEqual(scanInlineMathSpans('$ x$'), [], '起始 $ 后不能是空白')
  assert.deepEqual(scanInlineMathSpans('$a$1'), [], '收尾 $ 后紧跟数字 → 不算')
})

test('配平扫描：相邻的两条公式切得开（`$a$$b$` 是两条，不是一条带 $ 的数学）', () => {
  assert.deepEqual(scanInlineMathSpans('$a$$b$'), [
    { from: 0, to: 3 },
    { from: 3, to: 6 }
  ])
  // 中间那条 `$` 被删之后：前半仍是公式，后半退回普通文本（与 markdown-it 一致）
  assert.deepEqual(scanInlineMathSpans('$a$b$'), [{ from: 0, to: 3 }])
})

// ─── 粘贴时"纯文本里有没有块级公式"（第十三轮：mathPaste 用）────────────────────────
test('粘贴判定：纯文本里出现 `$$…$$` 才算有块级公式（普通文本里的单个 `$` 不算）', () => {
  assert.equal(hasBlockMathText('前面\n\n$$\nx = 1\n$$\n\n后面'), true)
  assert.equal(hasBlockMathText('$$\na = 1\nb = 2\n$$'), true)
  assert.equal(hasBlockMathText('价格 $5 和 $6'), false, '行内 $ 不算块级公式')
  assert.equal(hasBlockMathText('$E = mc^2$'), false, '单行行内公式不算块级')
  assert.equal(hasBlockMathText('$$\n没有收尾'), false, '没有收尾 `$$` 不算')
  assert.equal(hasBlockMathText('普通段落。'), false)
})
