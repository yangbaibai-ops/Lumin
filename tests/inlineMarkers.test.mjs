// 行内标记模型的纯逻辑单测（src/renderer/src/lib/editor/inlineMarkerCore.ts）。
//
// 为什么要有这一层：行内标记的两个必现缺陷（空光标点加粗得到 `****|`、手打 `**` 包裹后
// 四个 `*` 消失）都出在「纯逻辑」上，却只能在**起了真应用**的 CDP 套件里被发现。把规则
// 拆到无依赖的核心模块后，这里逐条钉死：
//   1. 标记对插入的落点（`**|**` 而不是 `****|`）；
//   2. 归一化替换块内容后的光标落点（顶层段落曾经算出 -1，光标保护整段失效）；
//   3. 手打标记的识别/合并与「字面量化」；
//   4. 冗余嵌套强调（`****x****`）的判定与渲染规则。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPHASIS_MARKUP,
  MARKER_OF,
  blockCaretTarget,
  emphasisDepth,
  isRedundantEmphasis,
  literalSpan,
  markerPairOffsets,
  materializeStyledRun,
  normalizeAtoms,
  patchRedundantEmphasis,
  repairPollutedMarkers,
  reLiftLiteralPairs,
  styleList,
  stylesOf
} from '../src/renderer/src/lib/editor/inlineMarkerCore.ts'

// ─── 小工具：把手写的原子列表归一成紧凑签名，方便断言 ─────────────────────────
const text = (t, styles) => ({ kind: 'text', text: t, styles })
const mark = (t, style, side) => ({ kind: 'marker', text: t, marker: { style, side } })
/** 紧凑签名：`**@start 加粗:bold **@end`；无样式用 `-`，verbatim 用 `~` 前缀 */
function sig(atoms) {
  return atoms
    .map((a) => {
      if (a.kind === 'marker') return `${a.text}@${a.marker?.side}`
      if (a.kind === 'other') return 'other'
      if (a.kind === 'break') return 'break'
      const s = stylesOf(a).join('+') || '-'
      return `${a.verbatim ? '~' : ''}${a.text}:${s}`
    })
    .join(' ')
}
/**
 * 归一化取**返回值**：normalizeAtoms 先对入参做「识别/修复」的就地变换，随后在副本上做
 * 配对与物化，返回值才是最终原子列表（未变化返回 null）。
 */
const norm = (atoms) => normalizeAtoms(atoms) ?? atoms

// ─── 1. 标记对插入的落点 ─────────────────────────────────────────────────────
test('markerPairOffsets：空光标插一对标记 → 光标落在两者正中间（`**|**`）', () => {
  assert.deepEqual(markerPairOffsets(1, '**'), { start: 1, end: 3, caret: 3 })
  // 缺陷回归：归一化后光标曾经漂到「被替换区间的末尾」（用户看到 `****|` / `*|***`），
  // 这里把三个位置的关系钉死：光标恰好是 start 与 end 的中点。
  const pair = markerPairOffsets(7, '**')
  assert.equal(pair.caret - pair.start, '**'.length)
  assert.equal(pair.end - pair.caret, 0)
  assert.equal(pair.end - pair.start, '**'.length)
})

test('markerPairOffsets：各样式标记长度不同（* / ** / ~~ / `）', () => {
  assert.deepEqual(markerPairOffsets(0, MARKER_OF.italic), { start: 0, end: 1, caret: 1 })
  assert.deepEqual(markerPairOffsets(0, MARKER_OF.strike), { start: 0, end: 2, caret: 2 })
  assert.deepEqual(markerPairOffsets(0, MARKER_OF.code), { start: 0, end: 1, caret: 1 })
})

// ─── 2. 归一化后的光标落点 ───────────────────────────────────────────────────
test('blockCaretTarget：顶层段落（blockPos=0）不含「-1」偏差', () => {
  // `<p></p>` 里点加粗 → 文档出现 `****`，光标应落在块内偏移 2（`**|**`）
  assert.equal(blockCaretTarget(0, 2, 4), 3)
  // 缺陷回归：旧实现把锚点算成 before(depth) - 1 = -1，`>= 0` 守卫不成立 → 光标保护
  // 整段失效，PM 把光标映射到被替换区间的末尾（块内偏移 4）。
  assert.notEqual(blockCaretTarget(0, 2, 4), blockCaretTarget(0, 4, 4))
})

test('blockCaretTarget：偏移越界钳到块内容两端（替换后内容可能变短）', () => {
  assert.equal(blockCaretTarget(0, 9, 4), 5, '超出内容长度 → 落到块尾')
  assert.equal(blockCaretTarget(0, -3, 4), 1, '负偏移 → 落到块首')
  // 嵌套块（引用/列表项）：块起点不是 0
  assert.equal(blockCaretTarget(12, 2, 4), 15)
})

// ─── 3. 手打标记的识别 / 合并 / 字面量化 ──────────────────────────────────────
test('识别手打标记：**粗**、*斜*、~~删~~、`码` 各自成构造（含段落中间）', () => {
  const cases = [
    ['**加粗**', '**@start 加粗:bold **@end'],
    ['*斜体*', '*@start 斜体:italic *@end'],
    ['~~删除线~~', '~~@start 删除线:strike ~~@end'],
    ['`行内代码`', '`@start 行内代码:code `@end'],
    ['段落。**加粗**', '段落。:- **@start 加粗:bold **@end'],
    ['**粗**与**粗**', '**@start 粗:bold **@end 与:- **@start 粗:bold **@end']
  ]
  for (const [input, expect] of cases) {
    const atoms = [text(input)]
    assert.equal(sig(norm(atoms)), expect, input)
  }
})

test('半成品标记不识别：`**5*` / `*5` 保持纯文本（不误配成斜体）', () => {
  for (const input of ['**5*', '*5', '**', '****', '*x**']) {
    const atoms = [text(input)]
    assert.equal(normalizeAtoms(atoms), null, `${input} 不该被识别成构造`)
    assert.equal(sig(atoms), `${input}:-`, input)
  }
})

test('标记不配对（**5*）→ 整段字面量：内容去样式、标记降级 literal', () => {
  const atoms = [mark('**', 'bold', 'start'), text('5', ['bold']), mark('*', 'italic', 'end')]
  assert.equal(sig(norm(atoms)), '**@literal 5:- *@literal')
})

test('缺一侧标记（回车切段的产物）→ 按起始标记补齐 end', () => {
  const atoms = [mark('**', 'bold', 'start'), text('5', ['bold'])]
  assert.equal(sig(norm(atoms)), '**@start 5:bold **@end')
})

test('无标记的纯样式正文（解析/粘贴产物）→ 按样式栈物化一对标记', () => {
  const atoms = [text('加粗', ['bold'])]
  assert.equal(sig(norm(atoms)), '**@start 加粗:bold **@end')
})

test('嵌套样式按样式栈物化：粗体里的行内代码不写坏外层构造', () => {
  const atoms = [text('a', ['bold']), text('b', ['bold', 'code']), text('c', ['bold'])]
  assert.equal(sig(norm(atoms)), '**@start a:bold `@start b:bold+code `@end c:bold **@end')
})

test('repairPollutedMarkers：边界打字粘连的 `2**` 拆回普通文本 + 干净标记', () => {
  const atoms = [mark('2**', 'bold', 'start'), text('5', ['bold']), mark('**', 'bold', 'end')]
  assert.equal(repairPollutedMarkers(atoms), true)
  assert.equal(sig(atoms), '2:- **@start 5:bold **@end')
})

test('repairPollutedMarkers：end 侧同理（`**2` → 标记本体 + 尾部普通文本）', () => {
  const atoms = [mark('**', 'bold', 'start'), text('5', ['bold']), mark('**2', 'bold', 'end')]
  assert.equal(repairPollutedMarkers(atoms), true)
  assert.equal(sig(atoms), '**@start 5:bold **@end 2:-')
})

test('reLiftLiteralPairs：两侧字面量重新围住无样式正文 → 还原成样式构造', () => {
  const atoms = [mark('**', 'bold', 'literal'), text('5'), mark('**', 'bold', 'literal')]
  assert.equal(reLiftLiteralPairs(atoms), true)
  assert.equal(sig(atoms), '**@start 5:bold **@end')
})

test('已是字面量的标记不再重提升 / 不乱配（`****` 原样留着）', () => {
  const atoms = [mark('****', 'bold', 'literal')]
  assert.equal(normalizeAtoms(atoms), null)
  assert.equal(sig(atoms), '****@literal')
})

test('归一化是幂等的：识别一次之后再跑一遍不改动（手打/加载都靠它稳定）', () => {
  for (const input of ['**加粗**', '*斜体*', '~~删除线~~', '`行内代码`', '段落。**加粗**']) {
    const first = [text(input)]
    const once = sig(norm(first))
    const second = norm(first.map((a) => ({ ...a })))
    assert.equal(sig(second), once, `${input} 第二遍结果必须一致`)
  }
})

test('materializeStyledRun：不透明行内内容（链接/HTML/公式）夹在中间也不让构造闭合', () => {
  const other = { kind: 'other', node: undefined }
  const atoms = [text('前', ['bold']), other, text('后', ['bold'])]
  materializeStyledRun(atoms, 0)
  assert.equal(sig(atoms), '**@start 前:bold other 后:bold **@end')
})

test('styleList：去重 + 按固定顺序（bold→strike→italic→code），非法值丢弃', () => {
  assert.deepEqual(styleList(['code', 'bold', 'code', 'nope']), ['bold', 'code'])
  assert.deepEqual(styleList('italic bold'), ['bold', 'italic'])
  assert.deepEqual(styleList(undefined), [])
})

// ─── 4. 冗余嵌套强调（`****x****` 不许掉字符）────────────────────────────────
/** markdown-it 的 token 流是扁平的：按真实形状手搓，供渲染规则判定 */
const toks = (...types) => types.map((type) => ({ type }))

const STRONG = EMPHASIS_MARKUP[0]
const EM = EMPHASIS_MARKUP[1]
const STRIKE = EMPHASIS_MARKUP[2]

test('emphasisDepth：扁平 token 流还原嵌套深度', () => {
  const t = toks('strong_open', 'strong_open', 'text', 'strong_close', 'strong_close')
  assert.equal(emphasisDepth(t, 0, STRONG.open, STRONG.close), 0)
  assert.equal(emphasisDepth(t, 1, STRONG.open, STRONG.close), 1)
  assert.equal(emphasisDepth(t, 3, STRONG.open, STRONG.close), 2)
  assert.equal(emphasisDepth(t, 4, STRONG.open, STRONG.close), 1)
})

test('isRedundantEmphasis：只有「同类嵌套」的内层才算冗余', () => {
  const nested = toks('strong_open', 'strong_open', 'text', 'strong_close', 'strong_close')
  assert.equal(isRedundantEmphasis(nested, 0, STRONG.open, STRONG.close), false, '外层开')
  assert.equal(isRedundantEmphasis(nested, 1, STRONG.open, STRONG.close), true, '内层开')
  assert.equal(isRedundantEmphasis(nested, 3, STRONG.open, STRONG.close), true, '内层闭')
  assert.equal(isRedundantEmphasis(nested, 4, STRONG.open, STRONG.close), false, '外层闭')

  // `***x***`：em 与 strong **不同类**，都不是冗余（走原路径，样式集合里两个样式并存）
  const mixed = toks('em_open', 'strong_open', 'text', 'strong_close', 'em_close')
  assert.equal(isRedundantEmphasis(mixed, 0, EM.open, EM.close), false)
  assert.equal(isRedundantEmphasis(mixed, 1, STRONG.open, STRONG.close), false)
  assert.equal(isRedundantEmphasis(mixed, 3, STRONG.open, STRONG.close), false)

  // 相邻但不嵌套：`**a**b**c**`
  const apart = toks(
    'strong_open',
    'text',
    'strong_close',
    'text',
    'strong_open',
    'text',
    'strong_close'
  )
  assert.equal(isRedundantEmphasis(apart, 4, STRONG.open, STRONG.close), false)

  // 嵌套斜体 `*a *b* c*`
  const em = toks('em_open', 'text', 'em_open', 'text', 'em_close', 'text', 'em_close')
  assert.equal(isRedundantEmphasis(em, 0, EM.open, EM.close), false)
  assert.equal(isRedundantEmphasis(em, 2, EM.open, EM.close), true)

  // 嵌套删除线 `~~a ~~b~~ c~~`
  const st = toks('s_open', 'text', 's_open', 'text', 's_close', 'text', 's_close')
  assert.equal(isRedundantEmphasis(st, 2, STRIKE.open, STRIKE.close), true)
})

test('literalSpan：逐字写回的载体用的是 mdEscape 的 span 形状（escape:false）', () => {
  assert.equal(literalSpan('**'), '<span class="md-escape" data-md-escape="true">**</span>')
})

/** 用假 markdown-it 渲染一条 token 流：上游兜底 = 真实标签 */
function renderWithPatch(tokens) {
  const md = { renderer: { rules: {} } }
  patchRedundantEmphasis(md)
  const tagOf = {
    strong_open: '<strong>',
    strong_close: '</strong>',
    em_open: '<em>',
    em_close: '</em>',
    s_open: '<s>',
    s_close: '</s>'
  }
  const self = { renderToken: (_t, idx) => tagOf[tokens[idx].type] ?? '' }
  const rules = md.renderer.rules
  let html = ''
  tokens.forEach((tok, idx) => {
    if (tok.type === 'text') html += 'x'
    else html += rules[tok.type](tokens, idx, {}, {}, self)
  })
  return html
}

test('渲染规则：`****x****` 里冗余的那对 `**` 落成字面文本（四个星号全部留住）', () => {
  const html = renderWithPatch(
    toks('strong_open', 'strong_open', 'text', 'strong_close', 'strong_close')
  )
  assert.equal(
    html,
    '<strong>' + literalSpan('**') + 'x' + literalSpan('**') + '</strong>',
    '外层仍是真标签（提供粗体样式），内层那对写成逐字文本'
  )
  // 关键：星号一个不少（4 个），且没被当标签吃掉
  assert.equal((html.match(/\*/g) ?? []).length, 4)
})

test('渲染规则：不嵌套的强调一字不改（`**x**` / `***x***` / 相邻两段）', () => {
  assert.equal(renderWithPatch(toks('strong_open', 'text', 'strong_close')), '<strong>x</strong>')
  assert.equal(
    renderWithPatch(toks('em_open', 'strong_open', 'text', 'strong_close', 'em_close')),
    '<em><strong>x</strong></em>'
  )
  assert.equal(
    renderWithPatch(
      toks('strong_open', 'text', 'strong_close', 'text', 'strong_open', 'text', 'strong_close')
    ),
    '<strong>x</strong>x<strong>x</strong>'
  )
})

test('渲染规则：嵌套三层（`**a ****b**** c**`）—— 里层两对全留字面', () => {
  const html = renderWithPatch(
    toks(
      'strong_open',
      'text',
      'strong_open',
      'strong_open',
      'text',
      'strong_close',
      'strong_close',
      'text',
      'strong_close'
    )
  )
  assert.equal(
    html,
    '<strong>x' +
      literalSpan('**') +
      literalSpan('**') +
      'x' +
      literalSpan('**') +
      literalSpan('**') +
      'x</strong>'
  )
})

test('渲染规则：重复打补丁是幂等的（parse.setup 每次 parse 都会调用）', () => {
  const md = { renderer: { rules: {} } }
  patchRedundantEmphasis(md)
  const first = md.renderer.rules.strong_open
  patchRedundantEmphasis(md)
  assert.equal(md.renderer.rules.strong_open, first)
})

test('渲染规则：保留上游已有的渲染规则（别的扩展先包过一层）', () => {
  const md = { renderer: { rules: {} } }
  md.renderer.rules.strong_open = () => 'UPSTREAM'
  patchRedundantEmphasis(md)
  const rule = md.renderer.rules.strong_open
  const flat = toks('strong_open', 'text', 'strong_close')
  assert.equal(rule(flat, 0, {}, {}, { renderToken: () => 'FALLBACK' }), 'UPSTREAM')
  const nested = toks('strong_open', 'strong_open', 'text', 'strong_close', 'strong_close')
  assert.equal(rule(nested, 1, {}, {}, { renderToken: () => 'FALLBACK' }), literalSpan('**'))
})
