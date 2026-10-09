// ─── 图片语法的逐字写回（第五十三轮 P0：`![]()` 落盘变成 `!\[\]()`）─────────────
//
// 缺陷：用户手打的 `![]()` 在文档里是**裸文本**，prosemirror-markdown 的 `esc()` 会转义
// `[` / `]` ⇒ 保存后变成 `!\[\]()`（再解析又读回字面括号，每保存一次多一层反斜杠）。
//
// 为什么这层要有**纯函数**证据（而不是只靠 CDP 套件）：转义发生在 markdown **写出器**里，
// 与浏览器/PM 视图无关。这里用真的 `prosemirror-markdown` 序列化器把机制钉死，再用
// 归一化核的纯函数钉住"只对图片语法生效、别的字符一个不动"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from 'prosemirror-model'
import { MarkdownSerializer } from 'prosemirror-markdown'
import {
  hasImageSyntax,
  imageSyntaxSpans,
  literalizeImageAtoms,
  literalizeStrayAtoms,
  normalizeAtoms
} from '../src/renderer/src/lib/editor/inlineMarkerCore.ts'

// ── ① 机制：真的 prosemirror-markdown 序列化器 ────────────────────────────────
// 最小 schema：doc / paragraph / text + 一个「逐字写回」mark（与仓库的 MdMarker /
// MdCodeLiteral 同配置：空包裹 + escape:false）。写出器只保留 text 规则。
function makeSerializer() {
  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph+' },
      paragraph: { content: 'text*', toDOM: () => ['p', 0] },
      text: {}
    },
    marks: {
      // 与 MdMarker / MdCodeLiteral 的 addStorage().markdown.serialize 完全同形
      verbatim: { toDOM: () => ['span', 0] }
    }
  })
  const serializer = new MarkdownSerializer(
    {
      paragraph(state, node) {
        state.renderInline(node)
        state.closeBlock(node)
      },
      text(state, node) {
        state.text(node.text)
      }
    },
    { verbatim: { open: () => '', close: () => '', escape: false } }
  )
  return { schema, serializer }
}

/** 把一段文字（可带逐字 mark）序列化成 markdown */
function roundTrip(text, verbatim) {
  const { schema, serializer } = makeSerializer()
  const node = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text(text, verbatim ? [schema.marks.verbatim.create()] : [])
    ])
  ])
  return serializer.serialize(node)
}

test('红：裸文本的 `![]()` 会被 prosemirror-markdown 转义成 `!\\[\\]()`（缺陷本身）', () => {
  assert.equal(roundTrip('![]()', false), '!\\[\\]()')
  assert.equal(roundTrip('![alt](url)', false), '!\\[alt\\](url)')
})

test('绿：带上逐字写回 mark（escape:false + 空包裹）后逐字节不变', () => {
  assert.equal(roundTrip('![]()', true), '![]()')
  assert.equal(roundTrip('![alt](url)', true), '![alt](url)')
  assert.equal(roundTrip('前 ![]() 后', true), '前 ![]() 后')
  assert.equal(roundTrip('![a](x) ![b](y(z))', true), '![a](x) ![b](y(z))')
})

// ── ② 判据：只认图片语法 ──────────────────────────────────────────────────────
test('imageSyntaxSpans：认 `![]()` / `![alt](url)`，索引覆盖整段语法', () => {
  assert.deepEqual(imageSyntaxSpans('![]()'), [{ from: 0, to: 5 }])
  assert.deepEqual(imageSyntaxSpans('![alt](url)'), [{ from: 0, to: 11 }])
  assert.deepEqual(imageSyntaxSpans('![](x)'), [{ from: 0, to: 6 }])
  assert.deepEqual(imageSyntaxSpans('前![]()后'), [{ from: 1, to: 6 }])
  assert.deepEqual(imageSyntaxSpans('![a](x)\n'), [{ from: 0, to: 7 }])
  assert.equal(imageSyntaxSpans('![a](x) ![b](y)').length, 2)
})

test('imageSyntaxSpans：普通链接、带空格、未闭合、标记字符都不算图片语法', () => {
  const notImage = [
    '[文本](url)', // 普通链接：没有 `!`
    '![] ()', // `]` 与 `(` 之间有空格 —— markdown-it 也不当图片
    '![a] (x)',
    '![a](x', // 未闭合
    '[]()',
    '****',
    '~~~~',
    '前文 ![alt](url 后文'
  ]
  for (const src of notImage) {
    assert.equal(imageSyntaxSpans(src).length, 0, '不该认成图片语法：' + JSON.stringify(src))
    assert.equal(hasImageSyntax(src), false, 'hasImageSyntax 不该命中：' + JSON.stringify(src))
  }
  assert.equal(hasImageSyntax('![]()'), true)
  assert.equal(hasImageSyntax('前 ![alt](url) 后'), true)
  // 行内代码里的图片语法由原子层的 `styles.includes('code')` 守卫拦下（不靠文本层判）
  assert.equal(imageSyntaxSpans('`![a](x)`').length, 1)
})

// ── ③ 归一化：原子切分只动图片语法那一段 ─────────────────────────────────────
const textAtom = (text, extra = {}) => ({ kind: 'text', text, ...extra })
const shape = (list) =>
  list.map((a) => (a.kind === 'marker' ? 'm:' + a.text + ':' + a.marker?.side : 't:' + a.text))

test('literalizeImageAtoms：无样式正文 → 图片段变成 literal 标记原子（逐字写回）', () => {
  const atoms = [textAtom('前![]()后')]
  assert.equal(literalizeImageAtoms(atoms), true)
  assert.deepEqual(shape(atoms), ['t:前', 'm:![]():literal', 't:后'])
  // 幂等：第二遍不再改动（appendTransaction 靠这个收敛）
  assert.equal(literalizeImageAtoms(atoms), false)
})

test('literalizeImageAtoms：用户报的那一条（`![]()` 独立成原子时整体变 literal）', () => {
  const atoms = [textAtom('![]()')]
  assert.equal(literalizeImageAtoms(atoms), true)
  assert.deepEqual(shape(atoms), ['m:![]():literal'])

  const atoms2 = [textAtom('![alt](url)')]
  assert.equal(literalizeImageAtoms(atoms2), true)
  assert.equal(atoms2[0].kind, 'marker')
  assert.equal(atoms2[0].text, '![alt](url)')
})

test('literalizeImageAtoms：带样式的图片语法走 verbatim（MdEscape 那一档），不丢样式', () => {
  const atoms = [textAtom('![alt](url)', { styles: ['bold'] })]
  assert.equal(literalizeImageAtoms(atoms), true)
  assert.equal(atoms.length, 1)
  assert.equal(atoms[0].verbatim, true)
  assert.deepEqual(atoms[0].styles, ['bold'])
})

test('literalizeImageAtoms：行内代码正文一律不动（它本来就逐字写回）', () => {
  const code = [textAtom('![alt](url)', { styles: ['code'] })]
  assert.equal(literalizeImageAtoms(code), false)
  assert.equal(code[0].verbatim, undefined)
  assert.equal(code.length, 1)
})

// ── ④ 回归：`~~~~` / `****` 的老行为一个字节不变 ──────────────────────────────
test('回归：孤立标记字符（`****` / `~~~~`）仍走原来的字面量化，不被图片通道碰', () => {
  assert.equal(hasImageSyntax('****'), false)
  assert.equal(hasImageSyntax('~~~~'), false)

  const atoms = [textAtom('****')]
  assert.equal(literalizeImageAtoms(atoms), false)
  // 原有的字面量化照旧：`****` → literal 标记原子（序列化逐字写回，实测行为）
  assert.equal(literalizeStrayAtoms(atoms), true)
  assert.equal(atoms[0].kind, 'marker')
  assert.equal(atoms[0].marker?.side, 'literal')
  assert.equal(atoms[0].text, '****')

  const tilde = [textAtom('~~~~')]
  assert.equal(literalizeStrayAtoms(tilde), true)
  assert.equal(tilde[0].marker?.side, 'literal')
  assert.equal(tilde[0].text, '~~~~')
})

test('回归：`****` 与图片语法同段时各走各的通道，互不吞并', () => {
  const atoms = [textAtom('****![]()****')]
  assert.equal(literalizeImageAtoms(atoms), true)
  assert.deepEqual(shape(atoms), ['t:****', 'm:![]():literal', 't:****'])
  assert.equal(literalizeStrayAtoms(atoms), true)
  assert.deepEqual(shape(atoms), ['m:****:literal', 'm:![]():literal', 'm:****:literal'])
})

test('回归：normalizeAtoms 对 `****`/`~~~~` 的产出与老行为一致', () => {
  // ⚠️ normalizeAtoms 返回**新数组**（内部 `out = atoms.slice()`，不回写传入的数组），
  // 所以断言要拿返回值，别拿入参。
  // 注：`[文本](url)` 在第五十五轮**有意**改成走逐字写回（源码漂移修复），所以不再列在这里 ——
  // 它的新口径由 `tests/linkSyntaxLiteral.test.mjs` 钉住。
  const expected = {
    '****': ['m:****:literal'],
    '~~~~': ['m:~~~~:literal'],
    普通文字: ['t:普通文字']
  }
  for (const [src, want] of Object.entries(expected)) {
    const out = normalizeAtoms([textAtom(src)]) ?? [textAtom(src)]
    assert.deepEqual(shape(out), want, 'normalizeAtoms 对 ' + JSON.stringify(src) + ' 的产出变了')
  }
})

test('回归：normalizeAtoms 把图片语法交给 literal 通道（新行为，红→绿）', () => {
  const out = normalizeAtoms([textAtom('![]()')])
  assert.notEqual(out, null)
  assert.deepEqual(shape(out), ['m:![]():literal'])
  // 混在正文里也只动图片那一段
  const out2 = normalizeAtoms([textAtom('前![]()后')])
  assert.deepEqual(shape(out2), ['t:前', 'm:![]():literal', 't:后'])
})
