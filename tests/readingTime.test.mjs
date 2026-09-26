// 阅读时长 / 目标字数（src/shared/readingTime.ts）的单测。
//
// 这两条是状态栏的数字，口径漂了没人看得出来：把中文按 200 字/分钟算、或把混排文档
// 用「总字数 ÷ 单一速率」算，界面照样显示一个像模像样的分钟数。所以速率、取整、
// 混排的加法、以及「未设置目标」的判据都钉死在这里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CJK_CHARS_PER_MINUTE,
  LATIN_WORDS_PER_MINUTE,
  measureText,
  readingMinutes,
  readingMinutesOf,
  splitReadingMinutes,
  wordGoalProgress
} from '../src/shared/readingTime.ts'
import { defaultSettings } from '../src/shared/defaults.ts'

test('measureText：中文按字、拉丁按词，分开数（两者不可比，不合并成一个速率用）', () => {
  const m = measureText('中文三个字 hello world')
  assert.equal(m.cjkChars, 5)
  assert.equal(m.latinWords, 2)
  assert.equal(m.words, 7, '状态栏显示的「字数」= 中文数 + 拉丁词数')
})

test('measureText：撇号算同一个词，连字符算分隔（沿用既有字数口径，不是新口径）', () => {
  assert.equal(measureText("don't").latinWords, 1)
  assert.equal(measureText('well-known').latinWords, 2, '`-` 在抹掉的标记表里 ⇒ 连字符断词')
  assert.equal(measureText('a b c').latinWords, 3)
})

test('measureText：Markdown 行内标记先当空白（否则 **加粗** 的星号会被算进去）', () => {
  assert.equal(measureText('**加粗**').cjkChars, 2)
  assert.equal(measureText('# 标题').cjkChars, 2, '井号不算字')
  assert.equal(measureText('- 列表项').cjkChars, 3)
  assert.equal(measureText('| a | b |').latinWords, 2, '表格管道符不算词')
  assert.equal(measureText('[链接](url)').latinWords, 1, '括号不算词（url 仍在）')
})

test('measureText：空串 / 纯空白 / 只有标记 → 三个数都是 0', () => {
  for (const s of ['', '   ', '\n\n', '###', '***', '`~`', '| --- |']) {
    assert.deepEqual(measureText(s), { cjkChars: 0, latinWords: 0, words: 0 }, JSON.stringify(s))
  }
})

test('measureText：与重构前的内联实现逐字一致（字数口径不许在重构里漂）', () => {
  // 这是 files.ts / database.ts 原来的那一行正则（现在两处都改成调 measureText）。
  // 保留它作对照：任何"顺手改一下字符类"的改动都会在这里变红。
  const legacyWordCount = (content) => {
    const text = content.replace(/[#>*`_~[\]()!|-]/g, ' ').trim()
    if (!text) return 0
    const zh = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
    const words = (text.match(/[a-zA-Z0-9_]+(?:['’-][a-zA-Z0-9_]+)*/g) || []).length
    return zh + words
  }
  const corpus = [
    '',
    '   \n\n  ',
    '# 标题\n\n正文一段。\n',
    '**加粗**与*斜体*，还有 `code` 和 > 引用',
    "It's a well-known fact: 3 items, don't panic.\n",
    '```js\nconst a = 1\n```\n',
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    '- [ ] 待办\n- [x] 完成\n',
    '汉字\u3400扩展A',
    'emoji 😀 与符号 —— …',
    'a'.repeat(500)
  ]
  for (const s of corpus) {
    assert.equal(measureText(s).words, legacyWordCount(s), JSON.stringify(s.slice(0, 40)))
  }
})

test('readingMinutes：空文档（或只剩标记）0 分钟', () => {
  assert.equal(readingMinutes(''), 0)
  assert.equal(readingMinutes('   \n\n'), 0)
  assert.equal(readingMinutes('###'), 0)
})

test('readingMinutesOf：与 readingMinutes 同一份算法（渲染层走前者，只数一次）', () => {
  // 渲染层不能为了阅读时长再把全文扫一遍（状态栏每敲一键都要重算），
  // 所以走"吃已数好的量"的 readingMinutesOf；两个入口必须给出同一个数。
  for (const s of ['', '中'.repeat(400), 'word '.repeat(201).trim(), '中文 mixed 3 words']) {
    assert.equal(
      readingMinutesOf(measureText(s)),
      readingMinutes(s),
      JSON.stringify(s.slice(0, 30))
    )
  }
  assert.equal(readingMinutesOf({ cjkChars: 400, latinWords: 0, words: 400 }), 1)
  assert.equal(readingMinutesOf({ cjkChars: 0, latinWords: 0, words: 0 }), 0)
})

test('readingMinutes：中文 400 字 = 1 分钟，401 字 = 2 分钟（向上取整）', () => {
  assert.equal(CJK_CHARS_PER_MINUTE, 400, '中文速率写在常量里，改速率要连着改这条断言')
  assert.equal(readingMinutes('中'.repeat(400)), 1)
  assert.equal(readingMinutes('中'.repeat(401)), 2)
  assert.equal(readingMinutes('中'.repeat(800)), 2)
  assert.equal(readingMinutes('中'.repeat(801)), 3)
})

test('readingMinutes：拉丁 200 词 = 1 分钟，201 词 = 2 分钟', () => {
  assert.equal(LATIN_WORDS_PER_MINUTE, 200, '拉丁速率写在常量里，改速率要连着改这条断言')
  assert.equal(readingMinutes('word '.repeat(200).trim()), 1)
  assert.equal(readingMinutes('word '.repeat(201).trim()), 2)
})

test('readingMinutes：混排时两种速率**分别计时再相加**（能区分「总数 ÷ 单一速率」）', () => {
  // 1200 中文字（3 分钟）+ 600 个拉丁词（3 分钟）= 6 分钟。
  // 若误按"总字数 1800 ÷ 200"算会得到 9 —— 这条断言就是为了拦住那种算法。
  const text = '中'.repeat(1200) + ' ' + 'word '.repeat(600).trim()
  assert.equal(readingMinutes(text), 6)
  // 另一个两头都刚好整除的例子：200 字（0.5）+ 100 词（0.5）= 1
  assert.equal(readingMinutes('中'.repeat(200) + ' ' + 'word '.repeat(100).trim()), 1)
})

test('readingMinutes：非空至少 1 分钟（40 个字的便签不该显示「0 分钟」）', () => {
  assert.equal(readingMinutes('中'), 1)
  assert.equal(readingMinutes('a'), 1)
})

test('splitReadingMinutes：拆成「几小时几分钟」（拼哪国话由界面决定，这里只管数字）', () => {
  assert.deepEqual(splitReadingMinutes(0), { hours: 0, minutes: 0 })
  assert.deepEqual(splitReadingMinutes(59), { hours: 0, minutes: 59 })
  assert.deepEqual(splitReadingMinutes(60), { hours: 1, minutes: 0 })
  assert.deepEqual(splitReadingMinutes(61), { hours: 1, minutes: 1 })
  assert.deepEqual(splitReadingMinutes(125), { hours: 2, minutes: 5 })
  assert.deepEqual(splitReadingMinutes(2.7), { hours: 0, minutes: 2 }, '小数向下取整')
  assert.deepEqual(splitReadingMinutes(-5), { hours: 0, minutes: 0 })
  assert.deepEqual(splitReadingMinutes(Number.NaN), { hours: 0, minutes: 0 })
})

test('wordGoalProgress：goal <= 0 / NaN = 未设置（状态栏那一格不渲染）', () => {
  for (const goal of [0, -1, Number.NaN]) {
    const g = wordGoalProgress(500, goal)
    assert.equal(g.set, false, `goal=${goal}`)
    assert.equal(g.reached, false)
    assert.equal(g.ratio, 0)
  }
})

test('wordGoalProgress：达成判定与比例（不钳到 100%，超额是有用信息）', () => {
  const before = wordGoalProgress(0, 1000)
  assert.deepEqual(before, { set: true, ratio: 0, reached: false })
  const almost = wordGoalProgress(999, 1000)
  assert.equal(almost.reached, false)
  assert.equal(almost.ratio, 0.999)
  const exact = wordGoalProgress(1000, 1000)
  assert.equal(exact.reached, true, '刚好达标就算达成')
  assert.equal(exact.ratio, 1)
  const over = wordGoalProgress(1500, 1000)
  assert.equal(over.reached, true)
  assert.equal(over.ratio, 1.5, '超额时比例要 > 1（钳到 1 会让 100% 与 300% 看起来一样）')
})

test('defaultSettings.wordGoal：出厂 0 = 不设目标（默认不该凭空多出状态栏那一格）', () => {
  assert.equal(defaultSettings.wordGoal, 0)
})
