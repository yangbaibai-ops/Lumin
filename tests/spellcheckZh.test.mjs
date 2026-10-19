// ─── 中文拼写检查（启发式）：规则命中 / 不误报 / 装饰范围 / 菜单 / 语言清单 ────
//
// 这里钉住的是"能证明的行为"，不是实现细节：
//   * 规则命中给 from/to/message/suggestions，叠词与正常搭配**必须是 0 命中**；
//   * Decoration 只建在正文 Textblock 里（代码块/公式/行内代码一律不建）；
//   * 中文选项固定第一项；多选语义与设置卡/状态栏共用；
//   * 防抖 400–600ms、命中上限 500 条。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import {
  checkChinese,
  ZH_MAX_ISSUES,
  ZH_RECOMPUTE_DEBOUNCE_MS
} from '../src/shared/spellcheckZh.ts'
import {
  buildSpellcheckLanguageOptions,
  isChineseSpellcheckEnabled,
  isChineseSpellcheckLanguage,
  toggleSpellcheckLanguage
} from '../src/shared/spellcheck.ts'
import { setZhSpellcheckEnabled } from '../src/renderer/src/lib/editor/zhSpellcheckBridge.ts'
import { buildZhDecorations, scanZhDoc } from '../src/renderer/src/lib/editor/zhSpellcheck.ts'
import { buildSpellSection } from '../src/renderer/src/lib/editor/menu/spell.ts'

// ── 规则 ①：虚词连续重复 ─────────────────────────────────────────────────────
test('重复字：的的 命中给 from/to/message/suggestion（相对文本偏移）', () => {
  const issues = checkChinese('这是我们的的文档。')
  const hit = issues.find((issue) => issue.kind === 'repeat-char')
  assert.ok(hit, '应命中「的的」')
  assert.deepEqual({ from: hit.from, to: hit.to }, { from: 4, to: 6 })
  assert.equal(hit.message, '『的的』可能重复')
  assert.deepEqual(hit.suggestions, ['的'])
  assert.equal(hit.advisory, false)
})

test('重复字：叠词不误报（人人 常常 渐渐 爸爸 星星 ⇒ 0）', () => {
  assert.deepEqual(checkChinese('人人 常常 渐渐 爸爸 星星'), [])
})

test('重复字：正常固定说法不误报（的的确确 / 和和美美 / 是是非非）', () => {
  assert.deepEqual(checkChinese('的的确确 和和美美 是是非非'), [])
})

// ── 规则 ②：常见词连续重复 ───────────────────────────────────────────────────
test('重复词：我们我们 命中；动词重叠（研究研究）不误报', () => {
  const hit = checkChinese('我们我们去').find((issue) => issue.kind === 'repeat-word')
  assert.ok(hit)
  assert.equal(hit.message, '『我们我们』可能重复')
  assert.deepEqual(hit.suggestions, ['我们'])
  assert.deepEqual(checkChinese('研究研究 商量商量 打扫打扫 一个一个'), [])
})

// ── 规则 ③：半角标点 / 成对符号 ─────────────────────────────────────────────
test('半角标点：中文句里的半角逗号命中，文件名/小数/URL 不误报', () => {
  const hit = checkChinese('你好,世界').find((issue) => issue.kind === 'halfwidth-punctuation')
  assert.ok(hit)
  assert.deepEqual({ from: hit.from, to: hit.to }, { from: 2, to: 3 })
  assert.deepEqual(hit.suggestions, ['，'])
  assert.deepEqual(checkChinese('文件.txt 3.14 1,000 http://a.b/c'), [])
})

test('成对符号：缺闭符号/缺开符号/嵌套错位各自命中，正常配对不误报', () => {
  const missingClose = checkChinese('（测试').find((issue) => issue.kind === 'unbalanced-pair')
  assert.ok(missingClose?.message.includes('没有对应'))
  const missingOpen = checkChinese('测试）').find((issue) => issue.kind === 'unbalanced-pair')
  assert.ok(missingOpen?.message.includes('缺少对应'))
  const nested = checkChinese('「（测试」）').find(
    (issue) => issue.kind === 'unbalanced-pair' && issue.message.includes('嵌套错位')
  )
  assert.ok(nested)
  assert.deepEqual(checkChinese('《标题》「引用」（括号）'), [])
})

// ── 规则 ④：高置信易错词 ────────────────────────────────────────────────────
test('易错词：在次→再次 / 做为→作为 / 帐号→账号 / 部份→部分 / 须要→需要', () => {
  const pairs = [
    ['在次', '再次'],
    ['做为', '作为'],
    ['帐号', '账号'],
    ['部份', '部分'],
    ['须要', '需要']
  ]
  for (const [wrong, right] of pairs) {
    const hit = checkChinese(`我们在${wrong}确认`).find((issue) => issue.kind === 'confusable')
    assert.ok(hit, `应命中 ${wrong}`)
    assert.deepEqual(hit.suggestions, [right])
  }
})

test('易错词：在次日 / 台风登陆 这类正常词义不误报；登陆账号命中', () => {
  assert.deepEqual(checkChinese('在次日'), [])
  assert.deepEqual(checkChinese('台风登陆了'), [])
  const hit = checkChinese('请登陆账号').find((issue) => issue.kind === 'confusable')
  assert.ok(hit)
  assert.deepEqual(hit.suggestions, ['登录'])
})

test('易错词：其它→其他 可配置风格；其它风格时 0 命中', () => {
  const hit = checkChinese('其它').find((issue) => issue.kind === 'confusable')
  assert.deepEqual(hit.suggestions, ['其他'])
  assert.deepEqual(checkChinese('其它', { otherStyle: 'its' }), [])
})

// ── 规则 ⑤：中英空格（默认关闭、advisory） ─────────────────────────────────
test('中英空格：默认不检查；打开后被标记 advisory 且不给自动修正', () => {
  assert.deepEqual(checkChinese('中文English'), [])
  const issues = checkChinese('中文English', { checkSpacing: true })
  const hit = issues.find((issue) => issue.kind === 'cjk-spacing')
  assert.ok(hit)
  assert.equal(hit.advisory, true)
  assert.equal(hit.suggestions, undefined)
})

// ── 上限 / 防抖常量 ─────────────────────────────────────────────────────────
test('命中上限 500 条；防抖在 400–600ms 之间', () => {
  assert.equal(ZH_MAX_ISSUES, 500)
  assert.ok(ZH_RECOMPUTE_DEBOUNCE_MS >= 400 && ZH_RECOMPUTE_DEBOUNCE_MS <= 600)
  assert.equal(checkChinese('的的，'.repeat(600)).length, ZH_MAX_ISSUES)
})

// ── Decoration：只在正文 ────────────────────────────────────────────────────
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    codeBlock: { content: 'text*', group: 'block', code: true, marks: '' },
    mathBlock: { content: 'text*', group: 'block', atom: true },
    text: { group: 'inline' }
  },
  marks: { code: {} }
})

const paragraph = (...content) => schema.node('paragraph', null, content)
const text = (value, marks) => schema.text(value, marks)

test('Decoration：代码块/公式/行内代码里的「我们的的」不产生任何命中', () => {
  setZhSpellcheckEnabled(true)
  try {
    const excluded = schema.node('doc', null, [
      schema.node('codeBlock', null, [text('我们的的')]),
      schema.node('mathBlock', null, [text('我们的的')]),
      paragraph(text('行内'), text('我们的的', [schema.marks.code.create()]))
    ])
    assert.deepEqual(scanZhDoc(excluded), [])
  } finally {
    setZhSpellcheckEnabled(false)
  }
})

test('Decoration：只给正文命中建装饰，命中范围落在正文 Textblock 内', () => {
  setZhSpellcheckEnabled(true)
  try {
    const doc = schema.node('doc', null, [
      paragraph(text('这是我们的的文档。')),
      schema.node('codeBlock', null, [text('代码里的的')]),
      schema.node('mathBlock', null, [text('公式里的的')])
    ])
    const { issues, decorations } = buildZhDecorations(doc)
    assert.equal(issues.length, 1, '排除区域内不应产生命中')
    assert.equal(issues[0].text, '的的')
    const found = decorations.find()
    assert.equal(found.length, 1)
    // 第一个段落的正文从位置 1 开始；「的的」在段内偏移 4 → 文档位置 5
    assert.deepEqual({ from: found[0].from, to: found[0].to }, { from: 5, to: 7 })
  } finally {
    setZhSpellcheckEnabled(false)
  }
})

// ── 语言清单：中文第一项 / 多选语义 ─────────────────────────────────────────
test('语言列表：第一项固定中文（简体），系统清单里的 zh 不重复', () => {
  const options = buildSpellcheckLanguageOptions(['de-DE', 'zh-CN', 'en-US', 'aa'])
  assert.equal(options[0], 'zh')
  assert.equal(options.filter((code) => isChineseSpellcheckLanguage(code)).length, 1)
  // 其后：常见语言优先（en-US 在 de-DE 前），其余字母序
  assert.deepEqual(options, ['zh', 'en-US', 'de-DE', 'aa'])
  assert.deepEqual(buildSpellcheckLanguageOptions([]), ['zh'])
})

test('多选语义：中文可与 en-US 同选；不能把最后一个取消', () => {
  assert.deepEqual(toggleSpellcheckLanguage(['zh'], 'en-US'), ['zh', 'en-US'])
  assert.deepEqual(toggleSpellcheckLanguage(['zh', 'en-US'], 'zh'), ['en-US'])
  assert.equal(toggleSpellcheckLanguage(['zh'], 'zh'), null)
  assert.equal(isChineseSpellcheckEnabled(true, ['zh', 'en-US']), true)
  assert.equal(isChineseSpellcheckEnabled(false, ['zh']), false)
  assert.equal(isChineseSpellcheckEnabled(true, ['en-US']), false)
})

// ── 右键菜单：中文分区的结构 / 点击落地 ─────────────────────────────────────
const handlers = () => {
  const calls = []
  return {
    calls,
    replace: (range, word) => calls.push(['replace', range, word]),
    addToDictionary: (word) => calls.push(['add', word]),
    ignore: (key) => calls.push(['ignore', key])
  }
}

test('中文右键分区：显示 message、只给修正 + 忽略本次（没有添加到词典）', () => {
  const h = handlers()
  const section = buildSpellSection(
    {
      word: '的的',
      message: '『的的』可能重复',
      suggestions: ['的'],
      range: { from: 5, to: 7 },
      source: 'zh',
      issueKey: 'fp-1'
    },
    h
  )
  assert.ok(section)
  assert.equal(section.labelKey, 'editorMenu.zhSpell')
  assert.equal(section.message, '『的的』可能重复')
  assert.deepEqual(
    section.items.map((item) => item.id),
    ['spell.suggest.0', 'spell.ignore']
  )
  section.items[0].run()
  section.items[1].run()
  assert.deepEqual(h.calls, [
    ['replace', { from: 5, to: 7 }, '的'],
    ['ignore', 'fp-1']
  ])
})
