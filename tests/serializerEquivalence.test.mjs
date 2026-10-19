// ─── 序列化快路径的**语义等价**（回归防线）──────────────────────────────────────
//
// 为什么单独一个文件：`atBlank()` 的补丁装在 `MarkdownSerializerState.prototype` 上，
// 一起装就再也拿不到上游实现做基准了。所以这里**先**用未打补丁的原型把一批文档的
// 序列化结果取下来，**再**装补丁、再序列化一遍，逐字节对比。
//
// 这条测试是为"上一版把列表/引用压平"那次事故补的：上一版只验了"atBlank 对一个字符串
// 的返回值"，没有验"完整文档的输出"，于是 `text()` 之后误判成行首导致的
// `- 甲- 乙`、`> 一> 二` 一路漏到线上（本轮真因之外的第二个数据保真缺陷）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MarkdownSerializerState, defaultMarkdownSerializer, schema } from 'prosemirror-markdown'
import { installFastMarkdownSerializer } from '../src/renderer/src/lib/editor/serializerFastPath.ts'

const {
  doc,
  paragraph,
  blockquote,
  bullet_list,
  ordered_list,
  list_item,
  heading,
  code_block,
  horizontal_rule
} = schema.nodes
const t = (s) => schema.text(s)
const p = (...xs) =>
  paragraph.create(
    null,
    xs.filter(Boolean).map((x) => (typeof x === 'string' ? t(x) : x))
  )
const li = (...blocks) => list_item.create(null, blocks)

/** 代表性文档：标题 / 嵌套列表 / 多段引用 / 行内标记 / 代码块 / 分割线 */
const docs = [
  doc.create(null, [heading.create({ level: 1 }, t('标题')), p('正文')]),
  doc.create(null, [
    heading.create({ level: 2 }, t('列表')),
    bullet_list.create(null, [li(p('甲')), li(p('乙')), li(p('丙'))])
  ]),
  doc.create(null, [
    bullet_list.create(null, [
      li(p('一级'), bullet_list.create(null, [li(p('二级')), li(p('二级 b'))])),
      li(p('另一支'))
    ])
  ]),
  doc.create(null, [ordered_list.create({ order: 1 }, [li(p('一')), li(p('二')), li(p('三'))])]),
  doc.create(null, [blockquote.create(null, [p('引用一'), p('引用二')]), p('引用之后')]),
  doc.create(null, [
    p(
      '带 ',
      schema.text('粗', [schema.marks.strong.create()]),
      ' 与 ',
      schema.text('码', [schema.marks.code.create()])
    ),
    p('第二段')
  ]),
  doc.create(null, [
    code_block.create({ params: 'js' }, t('const a = 1\nconst b = 2')),
    p('代码块之后')
  ]),
  doc.create(null, [horizontal_rule.create(), p('分割线之后')]),
  // 混合：标题 + 列表 + 引用 + 段落（最容易暴露换行判定错）
  doc.create(null, [
    heading.create({ level: 3 }, t('混合')),
    bullet_list.create(null, [li(p('a')), li(p('b'))]),
    blockquote.create(null, [p('q1'), p('q2')]),
    p('尾巴')
  ])
]

const serialize = (d) => {
  const state = new MarkdownSerializerState(
    defaultMarkdownSerializer.nodes,
    defaultMarkdownSerializer.marks,
    {}
  )
  state.renderContent(d)
  return state.out
}

test('打补丁前后的完整序列化输出逐字节一致（嵌套列表/引用/任务/代码块/分割线）', () => {
  // 1) 基准：还没装补丁（模块 import 不会自动安装）
  const baseline = docs.map(serialize)

  // 2) 装补丁
  installFastMarkdownSerializer()

  // 3) 逐个对比
  docs.forEach((d, i) => {
    const patched = serialize(d)
    assert.equal(patched, baseline[i], `第 ${i + 1} 篇输出不一致`)
  })
})

test('列表项 / 引用段之间必须有换行（上一版事故的直接断言）', () => {
  installFastMarkdownSerializer()
  const list = serialize(docs[1])
  assert.match(list, /\* 甲\n\n?\* 乙/, `列表项必须分行，实际：${JSON.stringify(list)}`)
  const quote = serialize(docs[4])
  assert.match(quote, /> 引用一\n>(\n| )/, `引用段必须分行，实际：${JSON.stringify(quote)}`)
  assert.ok(!/- 甲- 乙/.test(list), '列表项不允许粘在一行')
})
