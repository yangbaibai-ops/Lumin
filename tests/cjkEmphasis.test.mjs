// ─── CJK 强调定界符的 markdown-it 接线（审计 §10 P1「≥80 行 src 文件在 tests 里零引用」）──
//
// `src/renderer/src/lib/editor/cjkEmphasis.ts` 的**纯判定**（`scanDelimsCjk`）已经被
// `tests/inlineMarkers.test.mjs` 钉死了，但真正让「`**「…」**` 能加粗」生效的是本文件的
// **接线**：把 markdown-it 的 emphasis 分词规则换成用我们的 scanDelims。这一层出错，
// inlineMarkerCore 的单测全绿而用户看到的仍然是一整段字面星号。
//
// 所以这里钉三件接线上的事（判据都来自模块自己的注释）：
//   ① **替换**而不是"再加一条"：必须是 `inline.ruler.at('emphasis', …)`；
//   ② **幂等**：`parse.setup` 每次 parse 前都被调用，重复接一次就会叠两层分词；
//   ③ 分词器把 `canSplitWord` 接到 **marker 是不是 `*`** 上（`_` 走完全上游的判定），
//      并把 scanDelims 的结果如实映射成 delimiter 记录（`open`/`close`/`length`/`token`）。
//
// 标点分类用**假 utils**（照 tests/inlineMarkers.test.mjs 的既有口径：ASCII 表与
// markdown-it 的 isMdAsciiPunct 一致，Unicode 只列用例用到的字符）—— 真实 markdown-it 的
// 端到端断言在 CDP 套件里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

// 该模块 import 的是 `'./inlineMarkerCore'`（无扩展名）→ 先装解析钩子再动态 import
installTsExtensionResolve()
const { patchCjkEmphasis } = await import('../src/renderer/src/lib/editor/cjkEmphasis.ts')
const { scanDelimsCjk } = await import('../src/renderer/src/lib/editor/inlineMarkerCore.ts')

const U = {
  isWhiteSpace: (cp) => cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x3000,
  isMdAsciiPunct: (cp) => '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.includes(String.fromCharCode(cp)),
  isPunctCharCode: (cp) => '「」『』（）：；。、，！？—…“”'.includes(String.fromCharCode(cp))
}

/** 假 md：`at` 记录"替换了哪条规则"，`before`/`after` 一并记下来供反例使用 */
function fakeMd() {
  const at = []
  const before = []
  const after = []
  const md = {
    utils: U,
    inline: {
      ruler: {
        at: (name, fn) => at.push({ name, fn }),
        before: (...args) => before.push(args),
        after: (...args) => after.push(args)
      }
    }
  }
  return { md, at, before, after }
}

// ── ① 接入方式 ────────────────────────────────────────────────────────────────
test('patchCjkEmphasis：用 ruler.at 替换 emphasis 规则（不是再加一条 before/after）', () => {
  const { md, at, before, after } = fakeMd()
  patchCjkEmphasis(md)
  assert.equal(at.length, 1)
  assert.equal(at[0].name, 'emphasis', '必须换掉上游那条，否则两条规则会各分一次词')
  assert.equal(typeof at[0].fn, 'function')
  assert.equal(before.length, 0, 'markdown-it 的 emphasis 已经在 ruler 里，用 before 会叠两条')
  assert.equal(after.length, 0)
})

test('patchCjkEmphasis：幂等（同一实例只接一次；parse.setup 每次 parse 前都调）', () => {
  const { md, at } = fakeMd()
  patchCjkEmphasis(md)
  const installed = at[0].fn
  patchCjkEmphasis(md)
  assert.equal(md.__luminCjkEmphasis, true, '幂等标记')
  assert.equal(at.length, 1, '第二次不该再替换一次')
  assert.equal(at[0].fn, installed)
})

test('patchCjkEmphasis：解析器实例缺失/结构不符时安静跳过（不抛）', () => {
  for (const bad of [
    null,
    undefined,
    {},
    { inline: {} },
    { inline: { ruler: {} } },
    { utils: U }
  ]) {
    assert.doesNotThrow(() => patchCjkEmphasis(bad))
  }
  // 有 ruler 但没有 utils：不许注册（scanDelims 会拿到 undefined）
  const at = []
  const noUtils = { inline: { ruler: { at: (n, f) => at.push([n, f]) } } }
  assert.doesNotThrow(() => patchCjkEmphasis(noUtils))
  assert.equal(at.length, 0)
  assert.equal(noUtils.__luminCjkEmphasis, undefined)
})

// ── ② 分词器行为 ──────────────────────────────────────────────────────────────
/** 假 StateInline：只需要 src / pos / posMax / tokens / delimiters / md.utils / push */
function inlineState(src, pos = 0) {
  return {
    src,
    pos,
    posMax: src.length,
    tokens: [],
    delimiters: [],
    md: { utils: U },
    push(type, tag, nesting) {
      const t = { type, tag, nesting, content: '' }
      this.tokens.push(t)
      return t
    }
  }
}

/** 取被注册进去的那条分词规则 */
function tokenizerOf() {
  const { md, at } = fakeMd()
  patchCjkEmphasis(md)
  return at[0].fn
}

test('分词器：silent（验证模式）直接返回 false 且不消费 —— 与上游 emphasis_tokenize 同构', () => {
  const tokenize = tokenizerOf()
  const s = inlineState('**加粗**')
  assert.equal(tokenize(s, true), false)
  assert.equal(s.pos, 0)
  assert.equal(s.tokens.length, 0)
  assert.equal(s.delimiters.length, 0)
})

test('分词器：既不是 `*` 也不是 `_` 时不认（其它行内规则照常处理）', () => {
  const tokenize = tokenizerOf()
  for (const ch of ['a', '~', '$', '`']) {
    const s = inlineState(`${ch}${ch}text`)
    assert.equal(tokenize(s, false), false, ch)
    assert.equal(s.pos, 0)
  }
})

test('分词器：定界符串整段收成一个 run，逐个 push token 并映射 open/close/length', () => {
  const tokenize = tokenizerOf()
  const s = inlineState('**a**')
  assert.equal(tokenize(s, false), true)
  assert.equal(s.tokens.length, 2, '`**` = 两个 text token')
  assert.deepEqual(
    s.tokens.map((t) => [t.type, t.content, t.nesting]),
    [
      ['text', '*', 0],
      ['text', '*', 0]
    ]
  )
  assert.equal(s.delimiters.length, 2)
  assert.deepEqual(
    s.delimiters.map((d) => ({ marker: d.marker, length: d.length, open: d.open, close: d.close })),
    [
      { marker: 0x2a, length: 2, open: true, close: false },
      { marker: 0x2a, length: 2, open: true, close: false }
    ],
    '行首的 `**`：上一字符按空白处理 ⇒ 能开不能闭（与 scanDelimsCjk 实测一致）'
  )
  // token 下标必须指向刚 push 的那两个 token（markdown-it 的 balance_pairs 靠它回填）
  assert.deepEqual(
    s.delimiters.map((d) => d.token),
    [0, 1]
  )
  assert.deepEqual(
    s.delimiters.map((d) => d.end),
    [-1, -1],
    'end 由后续平衡阶段回填，这里必须留 -1'
  )
  assert.equal(s.pos, 2, 'pos 要跳过整个定界符串')
})

test('分词器：CJK 语境下开定界符能开（标准 CommonMark 口径下不能）—— 本模块存在的理由', () => {
  const tokenize = tokenizerOf()
  const src = '押在了**「保存路径」与「Markdown 保真」**这两件'
  const open = src.indexOf('**')
  // 反例（对照）：同一位置按**不放宽**的口径算 —— 就是标准 CommonMark 的结果
  assert.equal(
    scanDelimsCjk(src, open, src.length, false, U).can_open,
    false,
    '`「` 算标点 ⇒ 后面跟标点的定界符不是 left-flanking（这就是"渲染成字面星号"的成因）'
  )
  const s = inlineState(src, open)
  assert.equal(tokenize(s, false), true)
  assert.equal(s.delimiters[0].open, true, '放宽 CJK 标点后开定界符必须成立')
  assert.equal(s.delimiters.length, 2)
  assert.equal(s.pos, open + 2)
})

test('分词器：`canSplitWord` 接在「marker 是不是 `*`」上 —— 词中 `**` 能开、词中 `__` 不能', () => {
  const tokenize = tokenizerOf()
  const star = inlineState('a**b**c', 1)
  assert.equal(tokenize(star, false), true)
  assert.equal(star.delimiters[0].open, true, '`*` 可以出现在词中')
  assert.equal(star.delimiters[0].marker, 0x2a)

  const underscore = inlineState('a__b__c', 1)
  assert.equal(tokenize(underscore, false), true)
  assert.equal(
    underscore.delimiters[0].open,
    false,
    '`_` 不走放宽（canSplitWord=false）⇒ 词中的 `__` 不能开，与上游一致'
  )
  assert.equal(underscore.delimiters[0].marker, 0x5f)
})

test('分词器：长定界符串（`***`）整段收下，length 而不是 1', () => {
  const tokenize = tokenizerOf()
  const s = inlineState('***x***')
  assert.equal(tokenize(s, false), true)
  assert.equal(s.tokens.length, 3)
  assert.equal(s.delimiters.length, 3)
  assert.ok(s.delimiters.every((d) => d.length === 3))
  assert.equal(s.pos, 3)
})

test('分词器：串尾的定界符把 posMax 之外当空白（`**` 单独一行）', () => {
  const tokenize = tokenizerOf()
  const s = inlineState('**')
  assert.equal(tokenize(s, false), true)
  assert.equal(s.tokens.length, 2)
  assert.deepEqual(
    s.delimiters.map((d) => [d.open, d.close]),
    [
      [false, false],
      [false, false]
    ],
    '前后都是空白 ⇒ 既不能开也不能闭（不构成强调）'
  )
  assert.equal(s.pos, 2)
})
