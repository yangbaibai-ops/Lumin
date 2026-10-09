// ─── 链接语法的逐字写回（第五十五轮：把第五十三轮的图片口径扩到完整链接）──────────
//
// 缺陷：一次输入 `[文本](url)`（输入规则正确地放弃转换）后，字面文本落盘被
// prosemirror-markdown 的 `esc()` 转义成 `\[文本\](url)` —— 字符不丢但源码漂移。
// 修法沿用第五十三轮的逐字载体（`escape:false`），但**判据要足够窄**：
// 只有「`[...](非空目标)`」才算，`[TODO]` / `[1]` / `[文本]` / `[文本] ()` 一律不动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from 'prosemirror-model'
import { MarkdownSerializer } from 'prosemirror-markdown'
import {
  hasImageSyntax,
  hasLinkSyntax,
  imageSyntaxSpans,
  linkSyntaxSpans,
  literalizeLinkSyntaxAtoms,
  literalizeStrayAtoms,
  normalizeAtoms
} from '../src/renderer/src/lib/editor/inlineMarkerCore.ts'

// ── ① 机制：真的 prosemirror-markdown 序列化器（与第五十三轮同一套最小 schema）──
function makeSerializer() {
  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph+' },
      paragraph: { content: 'text*', toDOM: () => ['p', 0] },
      text: {}
    },
    marks: { verbatim: { toDOM: () => ['span', 0] } }
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

function roundTrip(text, verbatim) {
  const { schema, serializer } = makeSerializer()
  const node = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text(text, verbatim ? [schema.marks.verbatim.create()] : [])
    ])
  ])
  return serializer.serialize(node)
}

test('红：裸文本的链接语法会被转义（`[文本](url)` → `\\[文本\\](url)`）', () => {
  assert.equal(roundTrip('[文本](url)', false), '\\[文本\\](url)')
  assert.equal(roundTrip('前[文本](url)后', false), '前\\[文本\\](url)后')
})

test('绿：贴了逐字载体（escape:false + 空包裹）后逐字节不变', () => {
  for (const src of ['[文本](url)', '前[文本](url)后', '[a](https://x.test/p) 和 [b](q)']) {
    assert.equal(roundTrip(src, true), src, src)
  }
})

// ── ② 判据：窄边界（用户要的那几条）──────────────────────────────────────────
test('linkSyntaxSpans：只认「[label](非空目标)」与图片语法', () => {
  // 注意：`[文本](url)` 的字符数是 9（中文字符算 1 个码元）
  assert.deepEqual(linkSyntaxSpans('[文本](url)'), [{ from: 0, to: 9 }])
  assert.deepEqual(linkSyntaxSpans('前[文本](url)后'), [{ from: 1, to: 10 }])
  assert.deepEqual(
    linkSyntaxSpans('![]()'),
    [{ from: 0, to: 5 }],
    '空目标也是**图片**语法（选图按钮夹具）'
  )
  assert.equal(linkSyntaxSpans('[a](x) [b](y(z))').length, 2, '目标里允许成对括号')
})

test('linkSyntaxSpans：`[TODO]`/`[1]`/`[文本]`/空目标/带空格 一律不算（窄边界）', () => {
  for (const src of [
    '[TODO]',
    '[1]',
    '[文本]',
    '[TODO] 后面还有字',
    '[文本]()', // 目标为空 ⇒ 不是链接
    '[文本] (url)', // `]` 后必须紧跟 `(`
    '[文本](a b)', // 目标里有空白
    '[文本](a', // 未闭合
    '[]()', // 空 label + 空目标
    '****',
    '~~~~'
  ]) {
    assert.equal(linkSyntaxSpans(src).length, 0, '不该认成链接语法：' + JSON.stringify(src))
    assert.equal(hasLinkSyntax(src), false, 'hasLinkSyntax 不该命中：' + JSON.stringify(src))
  }
  // 图片口径未被放宽：`[文本](url)` 仍**不是**图片语法
  assert.equal(imageSyntaxSpans('[文本](url)').length, 0)
  assert.equal(hasImageSyntax('![]()'), true, '图片触发器仍认空目标（选图夹具）')
  assert.equal(hasLinkSyntax('![]()'), true)
})

// ── ③ 归一化：只切语法区间，其余文本一个字符不动 ──────────────────────────────
const textAtom = (text, extra = {}) => ({ kind: 'text', text, ...extra })
const shape = (list) =>
  list.map((a) => (a.kind === 'marker' ? 'm:' + a.text + ':' + a.marker?.side : 't:' + a.text))

test('literalizeLinkSyntaxAtoms：`[文本](url)` 整段变 literal（逐字写回），幂等', () => {
  const atoms = [textAtom('[文本](url)')]
  assert.equal(literalizeLinkSyntaxAtoms(atoms), true)
  assert.deepEqual(shape(atoms), ['m:[文本](url):literal'])
  assert.equal(literalizeLinkSyntaxAtoms(atoms), false, '第二遍不再改动（appendTransaction 收敛）')
})

test('literalizeLinkSyntaxAtoms：混在正文里只切那一段', () => {
  const atoms = [textAtom('前[文本](url)后')]
  assert.equal(literalizeLinkSyntaxAtoms(atoms), true)
  assert.deepEqual(shape(atoms), ['t:前', 'm:[文本](url):literal', 't:后'])
})

test('literalizeLinkSyntaxAtoms：带样式走 verbatim；代码跨度与挂别的 mark 的不动', () => {
  const styled = [textAtom('[文本](url)', { styles: ['bold'] })]
  assert.equal(literalizeLinkSyntaxAtoms(styled), true)
  assert.equal(styled[0].verbatim, true)
  assert.deepEqual(styled[0].styles, ['bold'])

  const code = [textAtom('[文本](url)', { styles: ['code'] })]
  assert.equal(literalizeLinkSyntaxAtoms(code), false)
  assert.equal(code[0].verbatim, undefined)

  const linked = [textAtom('[文本](url)', { otherMarks: [{}] })]
  assert.equal(literalizeLinkSyntaxAtoms(linked), false, '挂着别的 mark 时切了会丢 mark')
})

// ── ④ 回归：图片语法、`****`/`~~~~` 不变 ────────────────────────────────────
test('回归：`[TODO]`/`[1]`/`[文本]` 在 normalizeAtoms 里产出与老行为一致（不被动）', () => {
  for (const src of ['[TODO]', '[1]', '[文本]', '[TODO] 后面还有字']) {
    const out = normalizeAtoms([textAtom(src)]) ?? [textAtom(src)]
    assert.deepEqual(shape(out), ['t:' + src], src + ' 不该被改动')
  }
})

test('回归：图片语法（`![]()` / `![alt](url)`）与孤立标记字符行为不变', () => {
  // ⚠️ normalizeAtoms 返回**新数组**（不回写入参），断言要拿返回值
  const img = normalizeAtoms([textAtom('![]()')])
  assert.deepEqual(shape(img), ['m:![]():literal'])

  const img2 = normalizeAtoms([textAtom('![alt](url)')])
  assert.deepEqual(shape(img2), ['m:![alt](url):literal'])

  const stars = [textAtom('****')]
  assert.equal(literalizeLinkSyntaxAtoms(stars), false, '标记字符不走链接通道')
  assert.equal(literalizeStrayAtoms(stars), true)
  assert.equal(stars[0].marker?.side, 'literal')
  assert.equal(stars[0].text, '****')

  const mixed = [textAtom('****[文本](url)****')]
  assert.equal(literalizeLinkSyntaxAtoms(mixed), true)
  assert.equal(literalizeStrayAtoms(mixed), true)
  assert.deepEqual(shape(mixed), ['m:****:literal', 'm:[文本](url):literal', 'm:****:literal'])
})

test('回归：代码跨度里的链接语法文本本身不动（代码本来就逐字写回）', () => {
  const atoms = [textAtom('[文本](url)', { styles: ['code'] })]
  const out = normalizeAtoms(atoms) ?? atoms
  // 造型上会被物化成 `` ` `` 标记 + 原文（代码跨度的既有行为），关键是**原文一字不改**
  assert.equal(
    out.some((a) => a.kind === 'text' && a.text === '[文本](url)'),
    true,
    '代码跨度里的原文必须原样保留'
  )
  assert.equal(
    out.some((a) => a.kind === 'text' && a.verbatim === true),
    false,
    '不该给它贴 verbatim（代码跨度本来就 escape:false）'
  )
})
