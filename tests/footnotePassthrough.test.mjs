// ─── 脚注原样透传 `patchFootnoteRules`（审计 §10 P1「≥80 行 src 文件在 tests 里零引用」）──
//
// `src/renderer/src/lib/editor/footnotePassthrough.ts` 是**修 bug 的那一层**：以前脚注
// `[^1]` / `[^1]: 正文` 完全没处理，markdown-it 把定义行当"链接引用定义"吃掉 ——
// 整行消失、正文被搬进链接目标、未配对的 `[^2]` 被转义成 `\[^2\]`。三条都是"内容被改写"。
//
// 它属于 `markdownRulePatches.test.mjs` 那一类（给 markdown-it 套规则），所以照那份的写法：
// 用**假 md 实例**接住注册，再直接调被注册进去的规则函数。这里钉住四件只有运行时才暴露的事：
//   ① **锚点名字**：行内的锚点必须是 `link`。markdown-it 的行内 ruler 里**没有** `reference`
//      这条规则，写成 `reference` 会当场抛 "Cannot find rule"、整个编辑器起不来；
//   ② **幂等**：`parse.setup` 每次 parse 前都被调用，重复注册会叠规则；
//   ③ **块级续行的边界**：只吃「空行 + ≥2 空格缩进」的续行，遇到顶格正文行必须停，
//      否则脚注定义会把后面整篇文档吞进去；
//   ④ **渲染出口要转义**：原文进 `data-*` 的 `<span>`/`<pre>`，不转义就是 HTML 注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FootnoteDef,
  MdFootnote,
  patchFootnoteRules
} from '../src/renderer/src/lib/editor/footnotePassthrough.ts'

/** 假 md：只实现 patchFootnoteRules 用到的三个成员，并把注册调用记下来 */
function fakeMd() {
  const inline = []
  const block = []
  const md = {
    inline: { ruler: { before: (name, rule, fn) => inline.push({ anchor: name, rule, fn }) } },
    block: { ruler: { before: (name, rule, fn) => block.push({ anchor: name, rule, fn }) } },
    renderer: { rules: {} }
  }
  return { md, inline, block }
}

// ── ① 规则注册 ────────────────────────────────────────────────────────────────
test('注册锚点：行内挂 `link`（不是行内 ruler 里不存在的 `reference`），块级挂 `reference`', () => {
  const { md, inline, block } = fakeMd()
  patchFootnoteRules(md)
  assert.equal(inline.length, 1)
  assert.equal(inline[0].rule, 'lumin_footnote_ref')
  assert.equal(
    inline[0].anchor,
    'link',
    '行内锚错成 reference 会抛 Cannot find rule，编辑器直接起不来'
  )
  assert.notEqual(inline[0].anchor, 'reference')
  assert.equal(block.length, 1)
  assert.equal(block[0].rule, 'lumin_footnote_def')
  assert.equal(
    block[0].anchor,
    'reference',
    '块级必须排在 reference 之前，否则定义行被链接引用定义吃掉'
  )
  assert.equal(typeof inline[0].fn, 'function')
  assert.equal(typeof block[0].fn, 'function')
})

test('重复调用只注册一次（parse.setup 每次 parse 前都会调）', () => {
  const { md, inline, block } = fakeMd()
  patchFootnoteRules(md)
  const { fn: first } = inline[0]
  patchFootnoteRules(md)
  assert.equal(md.__luminFootnoteRules, true, '幂等标记')
  assert.equal(inline.length, 1, '第二次不该再注册一条')
  const { fn: second } = inline[0]
  assert.equal(second, first)
  assert.equal(block.length, 1)
})

test('拿不到 markdown-it 实例时安静返回（解析器不可用是既有兜底路径，不许抛）', () => {
  /** 空实现：这些"结构不符"的假实例只需要成员存在，不需要行为 */
  const noop = () => undefined
  for (const bad of [
    null,
    undefined,
    {},
    { inline: {} },
    { inline: { ruler: { before: noop } } }, // 缺 block
    { inline: { ruler: { before: noop } }, block: { ruler: { before: noop } } }, // 缺 renderer.rules
    { inline: { ruler: { before: noop } }, block: { ruler: { before: noop } }, renderer: {} }
  ]) {
    assert.doesNotThrow(() => patchFootnoteRules(bad))
  }
})

// ── ② 渲染出口 ────────────────────────────────────────────────────────────────
test('渲染规则：原文包进 data-* 前必须转义（否则正文里的标签直接进 DOM）', () => {
  const { md } = fakeMd()
  patchFootnoteRules(md)
  assert.equal(
    md.renderer.rules.lumin_footnote_ref([{ content: '[^1] & <x> "q" \'s\'' }], 0),
    '<span data-md-footnote>[^1] &amp; &lt;x&gt; &quot;q&quot; &#39;s&#39;</span>'
  )
  assert.equal(
    md.renderer.rules.lumin_footnote_def([{ content: '[^1]: 正文 & <i>' }], 0),
    '<pre data-md-footnote-def>[^1]: 正文 &amp; &lt;i&gt;</pre>\n'
  )
})

// ── ③ 行内规则 ────────────────────────────────────────────────────────────────
const inlineState = (src, pos = 0) => ({
  src,
  pos,
  tokens: [],
  push(type, tag, nesting) {
    const t = { type, tag, nesting, content: '' }
    this.tokens.push(t)
    return t
  }
})

test('行内规则：`[^label]` 原样收成一个 token 并前进（逐字写回的前提）', () => {
  const { md, inline } = fakeMd()
  patchFootnoteRules(md)
  const fn = inline[0].fn
  const s = inlineState('引用[^1] 后面的正文')
  s.pos = 2
  assert.equal(fn(s, false), true)
  assert.equal(s.tokens.length, 1)
  assert.equal(s.tokens[0].content, '[^1]', '取到的必须是原文而不是解析结果')
  assert.equal(s.pos, 2 + 4, 'pos 必须跳过整段，否则 markdown-it 会重复扫描')
})

test('行内规则：silent 模式只回答"这里有没有"（不 push、不前进 —— 与上游一致）', () => {
  const { md, inline } = fakeMd()
  patchFootnoteRules(md)
  const fn = inline[0].fn
  const s = inlineState('[^1]')
  assert.equal(fn(s, true), true)
  assert.equal(s.tokens.length, 0)
  assert.equal(s.pos, 0)
})

test('行内规则：不是脚注就返回 false（空 label / label 里有换行都不算）', () => {
  const { md, inline } = fakeMd()
  patchFootnoteRules(md)
  const fn = inline[0].fn
  assert.equal(fn(inlineState('普通正文 [x](y)'), false), false)
  assert.equal(fn(inlineState('[^] 空 label'), false), false)
  assert.equal(fn(inlineState('[^a\nb] label 里有换行'), false), false)
})

// ── ④ 块级规则 ────────────────────────────────────────────────────────────────
/** 假 StateBlock：只需要 bMarks / eMarks / tShift / src / line / push */
function blockState(lines) {
  const src = lines.join('\n')
  const bMarks = []
  const eMarks = []
  const tShift = []
  let offset = 0
  for (const line of lines) {
    bMarks.push(offset)
    eMarks.push(offset + line.length)
    tShift.push(line.length - line.trimStart().length)
    offset += line.length + 1
  }
  return {
    src,
    bMarks,
    eMarks,
    tShift,
    line: 0,
    tokens: [],
    push(type, tag, nesting) {
      const t = { type, tag, nesting, content: '', map: [] }
      this.tokens.push(t)
      return t
    }
  }
}

const LINES = ['[^1]: 第一条脚注的正文。', '  续行一', '', '  续行二', '', '正文段落']

test('块级规则：`[^label]: …` 连同「空行 + 缩进」的续行整段原样收下', () => {
  const { md, block } = fakeMd()
  patchFootnoteRules(md)
  const s = blockState(LINES)
  assert.equal(block[0].fn(s, 0, LINES.length, false), true)
  assert.equal(s.tokens.length, 1)
  assert.equal(s.tokens[0].type, 'lumin_footnote_def')
  assert.equal(s.tokens[0].content, LINES.slice(0, 4).join('\n'), '原文整段（含空行）逐字保留')
  assert.deepEqual(
    s.tokens[0].map,
    [0, 4],
    'map 要覆盖到最后一个续行，否则 markdown-it 的行映射与正文错位'
  )
  assert.equal(s.line, 4, '必须把 s.line 推到定义之后，下一轮块级规则从正文开始')
})

test('块级规则：续行必须 ≥2 空格缩进 —— 顶格行一定停（否则脚注会吞掉后面的正文）', () => {
  const { md, block } = fakeMd()
  patchFootnoteRules(md)
  const oneSpace = ['[^a]: 正文', ' 单空格续行', '正文段落']
  const s1 = blockState(oneSpace)
  assert.equal(block[0].fn(s1, 0, oneSpace.length, false), true)
  assert.equal(s1.tokens[0].content, '[^a]: 正文')
  assert.equal(s1.line, 1)

  const flush = ['[^a]: 正文', '正文段落']
  const s2 = blockState(flush)
  assert.equal(block[0].fn(s2, 0, flush.length, false), true)
  assert.equal(s2.tokens[0].content, '[^a]: 正文')
  assert.deepEqual(s2.tokens[0].map, [0, 1])
})

test('块级规则：不是定义行就返回 false（`[^1]` 缺冒号、普通段落都不算）', () => {
  const { md, block } = fakeMd()
  patchFootnoteRules(md)
  const fn = block[0].fn
  const plain = blockState(['正文段落', '[^1]: 后面才是定义'])
  assert.equal(fn(plain, 0, plain.src.split('\n').length, false), false)
  assert.equal(plain.tokens.length, 0)
  const noColon = blockState(['[^1] 缺冒号'])
  assert.equal(fn(noColon, 0, 1, false), false)
})

test('块级规则：silent 模式只说"是"，不改 s.line 也不 push', () => {
  const { md, block } = fakeMd()
  patchFootnoteRules(md)
  const s = blockState(LINES)
  assert.equal(block[0].fn(s, 0, LINES.length, true), true)
  assert.equal(s.tokens.length, 0)
  assert.equal(s.line, 0)
})

// ── ⑤ 序列化契约（"原样写回"那一半）──────────────────────────────────────────
test('FootnoteDef 序列化：source 逐字写出（只剥掉末尾换行，收尾交给 closeBlock）', () => {
  const storage = FootnoteDef.config.addStorage()
  // 解析钩子必须挂在**节点**的 storage 上（挂在 mark 上实测不会被 tiptap-markdown 调用，
  // 那次跑出来与没打补丁逐字节相同）——这里直接把钩子喂给假 md，验证它真的会注册两条规则
  const wired = fakeMd()
  storage.markdown.parse.setup(wired.md)
  assert.equal(wired.inline.length, 1, 'setup 必须真的把行内规则注册出去')
  assert.equal(wired.block.length, 1)
  const writes = []
  let closed = null
  storage.markdown.serialize(
    { write: (t) => writes.push(t), closeBlock: (n) => (closed = n) },
    { attrs: { source: '[^1]: 正文\n  续行\n' } }
  )
  assert.equal(writes.join(''), '[^1]: 正文\n  续行')
  assert.deepEqual(closed, { attrs: { source: '[^1]: 正文\n  续行\n' } })
  assert.equal(FootnoteDef.config.addAttributes().source.default, '')
})

test('MdFootnote 序列化：open/close 为空且不转义（`[^1]` 逐字写回，不许变成 `\\[^1\\]`）', () => {
  const storage = MdFootnote.config.addStorage()
  assert.equal(storage.markdown.serialize.escape, false)
  assert.equal(storage.markdown.serialize.open(), '')
  assert.equal(storage.markdown.serialize.close(), '')
})
