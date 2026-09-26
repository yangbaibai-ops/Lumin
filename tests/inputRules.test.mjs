// ─── 附加 InputRules（审计 §10 P1「≥80 行 src 文件在 tests 里零引用」）──────────────
//
// `src/renderer/src/lib/editor/inputRules.ts` 是审计**点名**要补的一个，它此前零引用。
// 两条规则都是"敲下某个字符时改写文档"：`[文字](网址)` 敲 `)` 即成形、任务列表里敲
// `[ ] ` 即把整个列表转成任务列表。这类 handler 写错的用户侧表现是：
//   * `[](url)` 空 label → PM 不允许空文本节点 → 当场抛 RangeError，输入规则被打断；
//   * 不清 storedMarks → 紧接着输入的字被吞进链接里；
//   * 用 `\s` 而不是字面空格 → 列表里按 Enter 时 `[ ]` 被误触发删掉。
//
// 这里**不用真编辑器**（那是 CDP 套件的事）：用真 `Schema` + 真 `EditorState`（都是纯 JS，
// 不碰 DOM），复刻 tiptap `run()` 的调用契约 —— 关键是 handler 拿到的 `state.tr` 必须是
// **同一条**事务（tiptap 用 createChainableState 把事务塞进 state），否则断言的是空气。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { TyporaInputRules } from '../src/renderer/src/lib/editor/inputRules.ts'

const NODES = {
  doc: { content: 'block+' },
  paragraph: { group: 'block', content: 'inline*' },
  text: { group: 'inline' },
  bulletList: { group: 'block', content: 'listItem+' },
  listItem: { content: 'paragraph block*' },
  orderedList: { group: 'block', content: 'listItem+' },
  taskList: { group: 'block', content: 'taskItem+' },
  taskItem: { attrs: { checked: { default: false } }, content: 'paragraph block*' }
}
const schema = new Schema({ nodes: NODES, marks: { link: { attrs: { href: {} } } } })
const noTasks = new Schema({
  nodes: { doc: NODES.doc, paragraph: NODES.paragraph, text: NODES.text },
  marks: { link: { attrs: { href: {} } } }
})
const noLinks = new Schema({
  nodes: {
    doc: NODES.doc,
    paragraph: NODES.paragraph,
    text: NODES.text,
    bulletList: NODES.bulletList,
    listItem: NODES.listItem,
    taskList: NODES.taskList,
    taskItem: NODES.taskItem
  }
})

const { paragraph, bulletList, listItem, orderedList } = schema.nodes

/** `addInputRules` 只用 `this.editor.schema`，所以给个只有 schema 的假实例就够 */
const rulesFor = (s) => TyporaInputRules.config.addInputRules.call({ editor: { schema: s } })
const linkRuleOf = (rules) => rules.find((r) => r.find.test('[文字](https://a.com)'))
const taskRuleOf = (rules) => rules.find((r) => r.find.test('[ ] '))

/**
 * 复刻 tiptap `run()` 的契约：插件先建一条事务，再用 createChainableState 把它交给 handler
 * （见 @tiptap/core 的 inputRulesPlugin）。handler 只改这一条事务，由插件统一 dispatch；
 * 而 `EditorState.tr` 是个 getter，每次取都是**新事务** —— 所以必须把它钉住。
 */
function runHandler(rule, state, match, range) {
  const tr = state.tr
  const chainable = new Proxy(state, { get: (t, p) => (p === 'tr' ? tr : Reflect.get(t, p, t)) })
  const ret = rule.handler({ state: chainable, match, range })
  return { ret, tr, next: tr.steps.length ? state.apply(tr) : state }
}

/** bulletList 里若干个 listItem（各含单个段落；空串 = 空段落） */
const bullet = (...items) =>
  bulletList.create(
    null,
    items.map((t) => listItem.create(null, paragraph.create(null, t ? schema.text(t) : undefined)))
  )

const stateOf = (doc) => EditorState.create({ schema, doc })
const marksOnFirstText = (next) =>
  (next.doc.firstChild.firstChild?.marks ?? []).map((m) => [m.type.name, { ...m.attrs }])

// ── 规则注册：schema 里缺哪一半就少一条规则（不是抛错）────────────────────────
test('注册：link mark 与 taskList/taskItem 都在时两条规则都注册', () => {
  const rules = rulesFor(schema)
  assert.equal(rules.length, 2)
  assert.ok(linkRuleOf(rules), 'Markdown 链接规则')
  assert.ok(taskRuleOf(rules), '任务列表规则')
})

test('注册：schema 没有 taskList/taskItem 时只给链接规则（提前返回，不抛）', () => {
  const rules = rulesFor(noTasks)
  assert.equal(rules.length, 1)
  assert.ok(linkRuleOf(rules))
  assert.equal(taskRuleOf(rules), undefined)
})

test('注册：schema 没有 link mark 时只给任务列表规则', () => {
  const rules = rulesFor(noLinks)
  assert.equal(rules.length, 1)
  assert.ok(taskRuleOf(rules))
  assert.equal(linkRuleOf(rules), undefined)
})

// ── 任务列表 ─────────────────────────────────────────────────────────────────
test('任务列表正则：三种写法都认，`*` 与双空格不认', () => {
  const rule = taskRuleOf(rulesFor(schema))
  for (const ok of ['[ ] ', '[x] ', '[X] ']) assert.equal(rule.find.test(ok), true, ok)
  assert.equal(rule.find.test('[*] '), false)
  assert.equal(rule.find.test('[  ] '), false)
})

test('任务列表正则：结尾必须是**字面空格** —— `[ ]\\n` 不许匹配（否则列表里按 Enter 会误触发）', () => {
  const rule = taskRuleOf(rulesFor(schema))
  assert.equal(rule.find.test('[ ]\n'), false, 'core 会用 \\n 重放输入规则，\\s 会在这里变成 true')
  assert.equal(
    /^\[([ xX]?)\]\s$/.test('[ ]\n'),
    true,
    '对照：写成 \\s 就会匹配（这就是那条例外注释的由来）'
  )
})

test('任务列表 handler：`[ ]` 把整个 bulletList 转成 taskList，剥掉标记文本，光标落在项内', () => {
  const doc = schema.nodes.doc.create(null, [bullet('[ ]')])
  const state = stateOf(doc)
  const rule = taskRuleOf(rulesFor(schema))
  const { ret, tr, next } = runHandler(rule, state, rule.find.exec('[ ] '), { from: 3, to: 3 })
  assert.notEqual(ret, null, '必须返回非 null，否则 tiptap 会当作"这条规则没命中"')
  assert.ok(tr.steps.length > 0)
  const top = next.doc.firstChild
  assert.equal(top.type.name, 'taskList', '整个列表被替换成任务列表')
  assert.equal(top.firstChild.type.name, 'taskItem')
  assert.equal(top.firstChild.attrs.checked, false)
  assert.equal(top.firstChild.textContent, '', '开头的 `[ ]` 文本被剥掉')
  assert.equal(next.selection.from, 3, '光标落在转换后目标项的段落内')
})

test('任务列表 handler：`[x]` / `[X]` 转成已勾选（大小写不敏感），标记文本同样剥掉', () => {
  for (const raw of ['[x]', '[X]']) {
    const doc = schema.nodes.doc.create(null, [bullet(raw)])
    const state = stateOf(doc)
    const rule = taskRuleOf(rulesFor(schema))
    const { next } = runHandler(rule, state, rule.find.exec(`${raw} `), { from: 3, to: 3 })
    const item = next.doc.firstChild.firstChild
    assert.equal(item.attrs.checked, true, raw)
    assert.equal(item.textContent, '')
  }
})

test('任务列表 handler：`[ ] `/`[x] ` 敲在**非首项**时，改的是那一项（回归：曾恒取首项）', () => {
  /**
   * 这是一条**回归测试**：改前 `inputRules.ts` 用 `$from.index(itemDepth)` 当"第几个列表项"，
   * 而实测（下面两句 probe 断言就是当时的证据）`index(itemDepth)` 返回的是**该项内第几个子节点**
   * （段落，恒为 0），真正需要的"第几个列表项"在 `itemDepth - 1` 那一层。
   * 后果：`[ ] ` 敲在列表**非首项**时，整个列表照转成 taskList，但用户敲的那一项留着字面 `[ ]`
   * 也没被勾选，反而**另一个项**被勾上（单元素列表碰巧正确，所以一直没暴露）。
   * 现在断言的是修好之后的正确行为。
   */
  const rule = taskRuleOf(rulesFor(schema))
  // 机制佐证：同一个光标位置上，两种下标各是多少（用真 PM 的 ResolvedPos 算）
  const probe = schema.nodes.doc.create(null, [bullet('第一条', '[ ]', '第三条')])
  let textPos = -1
  probe.descendants((n, cp) => {
    if (textPos < 0 && n.isText && n.text === '[ ]') textPos = cp + 1
  })
  const $from = probe.resolve(textPos)
  assert.equal($from.index(2), 0, '$from.index(itemDepth)：item 内第几个子节点（段落）→ 恒为 0')
  assert.equal($from.index(1), 1, '真正需要的"第几个列表项"在 itemDepth - 1 这一层')

  const three = schema.nodes.doc.create(null, [bullet('第一条', '[ ]', '第三条')])
  const threeState = stateOf(three)
  const { next } = runHandler(rule, threeState, rule.find.exec('[ ] '), { from: 0, to: 0 })
  const top = next.doc.firstChild
  assert.equal(top.type.name, 'taskList', '列表类型照转')
  assert.equal(top.childCount, 3, '项数与顺序都不变')
  assert.deepEqual(
    top.content.content.map((it) => [it.textContent, it.attrs.checked]),
    [
      ['第一条', false],
      ['', false], // ← 目标项（第二项）：标记被剥掉、勾选态按语法
      ['第三条', false]
    ]
  )

  // 同一判据更刺眼的一面：`[x]` 敲在第二项 → 勾上的必须是**第二项**
  const check = schema.nodes.doc.create(null, [bullet('第一条', '[x]', '第三条')])
  const { next: afterCheck } = runHandler(rule, stateOf(check), rule.find.exec('[x] '), {
    from: 0,
    to: 0
  })
  assert.deepEqual(
    afterCheck.doc.firstChild.content.content.map((it) => [it.textContent, it.attrs.checked]),
    [
      ['第一条', false],
      ['', true], // ← 用户敲的那一项
      ['第三条', false]
    ]
  )

  // 歧义防护：前面已有一项字面就是 `[ ]` 时，取**离光标最近**的那一处
  const ambiguous = schema.nodes.doc.create(null, [bullet('[ ]', '[ ]', '第三条')])
  // 光标放到第二个候选的文本末尾（真实场景：用户正在第二项里敲字）
  let second = null
  let seen = 0
  ambiguous.descendants((n, cp) => {
    if (n.isText && n.text === '[ ]') {
      seen += 1
      if (seen === 2) second = cp + 1 + n.text.length
    }
    return true
  })
  const ambState = EditorState.create({
    schema,
    doc: ambiguous,
    selection: TextSelection.create(ambiguous, second)
  })
  const { next: afterAmbiguous } = runHandler(rule, ambState, rule.find.exec('[ ] '), {
    from: 0,
    to: 0
  })
  const ambTop = afterAmbiguous.doc.firstChild
  assert.deepEqual(
    ambTop.content.content.map((it) => [it.textContent, it.attrs.checked]),
    [
      ['[ ]', false], // 第一项保持字面（不是本次落点）
      ['', false], // ← 光标所在的那一项被剥掉标记
      ['第三条', false]
    ],
    '两个候选文本完全相同时，靠"离光标最近"区分'
  )
})

test('任务列表 handler：前面还有别的块时，光标偏移要把前面的节点算进去（caret 累加）', () => {
  const lead = paragraph.create(null, schema.text('前言'))
  const doc = schema.nodes.doc.create(null, [lead, bullet('[ ]')])
  const state = stateOf(doc)
  const rule = taskRuleOf(rulesFor(schema))
  const { next } = runHandler(rule, state, rule.find.exec('[ ] '), { from: 0, to: 0 })
  assert.equal(next.doc.childCount, 2)
  assert.equal(next.doc.child(0).type.name, 'paragraph')
  assert.equal(next.doc.child(0).textContent, '前言', '目标之前的块原样保留')
  assert.equal(next.doc.child(1).type.name, 'taskList')
  // 1（doc 内容起点）+ 前言的 nodeSize(4) + 1（taskList 开标签）+ 1（taskItem 开标签）= 7
  assert.equal(next.selection.from, 7)
  assert.equal(next.selection.$from.parent.type.name, 'paragraph')
  assert.equal(next.selection.$from.parent.textContent, '')
})

test('任务列表 handler：匹配文本不是该列表项的**第一个段落**开头时不转换（返回 null）', () => {
  const item = listItem.create(null, [
    paragraph.create(null, schema.text('前缀')),
    paragraph.create(null, schema.text('[ ]'))
  ])
  const doc = schema.nodes.doc.create(null, [bulletList.create(null, [item])])
  const state = stateOf(doc)
  const rule = taskRuleOf(rulesFor(schema))
  const { ret, tr } = runHandler(rule, state, rule.find.exec('[ ] '), { from: 0, to: 0 })
  assert.equal(ret, null)
  assert.equal(tr.steps.length, 0, '判定不通过时一个字都不许改')
})

test('任务列表 handler：有序列表不转换（只认 bulletList）', () => {
  const item = listItem.create(null, paragraph.create(null, schema.text('[ ]')))
  const doc = schema.nodes.doc.create(null, [orderedList.create(null, [item])])
  const state = stateOf(doc)
  const rule = taskRuleOf(rulesFor(schema))
  const { ret, tr } = runHandler(rule, state, rule.find.exec('[ ] '), { from: 0, to: 0 })
  assert.equal(ret, null)
  assert.equal(tr.steps.length, 0)
})

// ── Markdown 链接 ────────────────────────────────────────────────────────────
test('链接正则：label 里不许有方括号/换行，href 里不许有空白与圆括号', () => {
  const rule = linkRuleOf(rulesFor(schema))
  assert.equal(rule.find.test('[文字](https://a.com)'), true)
  assert.equal(rule.find.test('[a](b c)'), false, 'href 里有空白')
  assert.equal(rule.find.test('[a](b(c))'), false, 'href 里有圆括号')
  assert.equal(rule.find.test('[a[b]](x)'), false, 'label 里有方括号')
  assert.equal(rule.find.test('[a\nb](x)'), false, 'label 里有换行')
})

test('链接 handler：敲下 `)` 把 `[label](href)` 折成带 link mark 的文本，光标落到链接之后', () => {
  const raw = '[文字](https://a.com' // 文档里此刻还没有最后那个 `)`
  const doc = schema.nodes.doc.create(null, [paragraph.create(null, schema.text(raw))])
  const state = stateOf(doc)
  const rule = linkRuleOf(rulesFor(schema))
  const { ret, tr, next } = runHandler(rule, state, rule.find.exec(`${raw})`), { from: 1, to: 1 })
  assert.notEqual(ret, null)
  assert.ok(tr.steps.length > 0)
  assert.equal(next.doc.textContent, '文字', '整段 `[label](href)` 被替换成 label')
  assert.deepEqual(marksOnFirstText(next), [['link', { href: 'https://a.com' }]])
  assert.equal(next.selection.from, 1 + '文字'.length, '光标在链接之后（继续输入不再是链接）')
  assert.deepEqual(next.storedMarks, [], '必须清掉 storedMarks，否则紧接着输入的字被吞进链接')
})

test('链接 handler：空 label（`[](url)`）不生成链接也不抛（PM 不允许空文本节点）', () => {
  const raw = '[](https://a.com'
  const doc = schema.nodes.doc.create(null, [paragraph.create(null, schema.text(raw))])
  const state = stateOf(doc)
  const rule = linkRuleOf(rulesFor(schema))
  const { ret, tr, next } = runHandler(rule, state, rule.find.exec(`${raw})`), { from: 1, to: 1 })
  assert.equal(ret, null, '返回 null 表示"这次不处理"，保持字面不发散')
  assert.equal(tr.steps.length, 0, '不许对文档做任何改动（改了就抛 RangeError）')
  assert.equal(next.doc.textContent, raw)
})

test('链接 handler：range.from 与文档内容对不上时宁可不动（Chromium 的 from 可能落后一位）', () => {
  const raw = 'z[a](x'
  const doc = schema.nodes.doc.create(null, [paragraph.create(null, schema.text(raw))])
  const state = stateOf(doc)
  const rule = linkRuleOf(rulesFor(schema))
  // 正确的 range.from 是 2（`[` 的位置）；这里故意传 1
  assert.equal(state.doc.textBetween(2, 2 + 5), '[a](x', '对照：正确起点上是完整的待替换原文')
  const { ret, tr } = runHandler(rule, state, rule.find.exec(`${raw})`), { from: 1, to: 1 })
  assert.equal(ret, null)
  assert.equal(tr.steps.length, 0)
})
