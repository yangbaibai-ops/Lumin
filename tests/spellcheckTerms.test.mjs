// ─── 拼写检查：内置术语表 + 中文语言名白名单 + 真错词回归对照 ─────────────────
//
// 用户报障：README 里的产品名 `Lumin` 与语言名 `简体中文` 被画红波浪线。
// 这里钉住三件事，避免"改一个词表顺手把真错词也放过去"：
//   ① 术语表必须完整（用户点名的产品名/技术名/语言名一个不少）且干净
//      （无空项、无重复、不含 `teh` 这类真错词）；
//   ② 中文启发式检查对语言名 0 命中；白名单只豁免"整条命中落在词内"的项，
//      词外的 `我们的的` 仍然照报；
//   ③ 白名单本身是有效的（用 `做为` 做对照：默认报、列进白名单后不报）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findTermSpans,
  isSpellcheckTerm,
  normalizeTerm,
  SPELLCHECK_TERMS,
  ZH_ALLOW_TERMS
} from '../src/shared/spellcheckTerms.ts'
import { checkChinese } from '../src/shared/spellcheckZh.ts'

/** 用户点名的必含项（少一个就说明词表被误删） */
const REQUIRED_TERMS = [
  'Lumin',
  'Markdown',
  'Mermaid',
  'KaTeX',
  'Tiptap',
  'ProseMirror',
  'CodeMirror',
  'WYSIWYG',
  'Electron',
  'Vue',
  'shields',
  'TypeScript',
  'JSON',
  'YAML',
  'macOS',
  'Linux',
  'Windows',
  '中文',
  '简体',
  '繁體'
]

test('术语表完整性：点名项齐全、无空项/空白、无重复（大小写不敏感）', () => {
  for (const term of REQUIRED_TERMS) {
    assert.ok(SPELLCHECK_TERMS.includes(term), `术语表缺少 ${term}`)
  }
  const keys = SPELLCHECK_TERMS.map(normalizeTerm)
  assert.equal(new Set(keys).size, SPELLCHECK_TERMS.length, '术语表有重复项（大小写不敏感）')
  for (const term of SPELLCHECK_TERMS) {
    assert.ok(term.length > 0, '术语表不能有空串')
    assert.equal(term, term.trim(), `术语 ${JSON.stringify(term)} 首尾有空白`)
    // Chromium 的自定义词典按"一个词"存：带空格会被拆开，反而产生新的波浪线
    assert.ok(!/\s/.test(term), `术语 ${JSON.stringify(term)} 不能含空白`)
  }
})

test('术语整词匹配：Lumin 命中、Luminosity 不命中（不做子串放行）', () => {
  assert.equal(isSpellcheckTerm('Lumin'), true)
  assert.equal(isSpellcheckTerm('lumin'), true, '大小写不敏感（用户词典同口径）')
  assert.equal(isSpellcheckTerm(' Lumin '), true)
  assert.equal(isSpellcheckTerm('Luminosity'), false)
  assert.equal(isSpellcheckTerm('简体中文'), true)
  assert.equal(isSpellcheckTerm('简体中'), false)
})

test('真错词不在术语表里（回归对照：teh / recieve 仍由 Chromium 判错）', () => {
  for (const typo of ['teh', 'recieve', 'adress']) {
    assert.equal(isSpellcheckTerm(typo), false, `真错词 ${typo} 不该进术语表`)
  }
  assert.deepEqual(findTermSpans('teh and recieve', SPELLCHECK_TERMS), [])
})

test('中文白名单：语言名 0 命中（简体中文 / 繁體中文 / English）', () => {
  for (const name of [
    '简体中文',
    '繁體中文',
    'English',
    'English | 简体中文',
    '简体中文、繁體中文'
  ]) {
    assert.deepEqual(checkChinese(name), [], `语言名不该被中文规则命中：${name}`)
  }
  for (const name of ['中文', '简体', '繁體', '简体中文', '繁體中文', 'English']) {
    assert.ok(ZH_ALLOW_TERMS.includes(name), `中文白名单缺少语言名 ${name}`)
  }
})

test('白名单只豁免"整段落在词内"的命中：词外真错词仍报', () => {
  // `做为` 默认被易错词规则命中；把同一区间列进白名单后不报 —— 证明豁免来自白名单
  assert.ok(checkChinese('做为').some((issue) => issue.kind === 'confusable'))
  assert.deepEqual(checkChinese('做为', { allowTerms: ['做为'] }), [])

  const text = '简体中文 我们的的'
  const hits = checkChinese(text)
  assert.deepEqual(
    hits.map((issue) => ({ kind: issue.kind, text: text.slice(issue.from, issue.to) })),
    [{ kind: 'repeat-char', text: '的的' }],
    '语言名不能被豁免逻辑顺带放过；旁边的真错词必须还在'
  )
  // 显式清空白名单也不会凭空多报语言名（说明语言名本身不触发规则，白名单只是兜底）
  assert.deepEqual(checkChinese('简体中文', { allowTerms: [] }), [])
})

test('中文真错词回归：我们的的 / 在次 / 登陆账号 仍然命中', () => {
  const repeat = checkChinese('我们的的')
  assert.equal(repeat.length, 1)
  assert.equal(repeat[0].kind, 'repeat-char')
  assert.deepEqual(repeat[0].suggestions, ['的'])
  assert.ok(checkChinese('在次确认').some((issue) => issue.kind === 'confusable'))
  assert.ok(checkChinese('请登陆账号').some((issue) => issue.kind === 'confusable'))
})

test('术语区间：拉丁词要求词边界，中文语言名按子串（简体中文版 里的简体中文仍豁免）', () => {
  assert.deepEqual(findTermSpans('Vuex and Vue', ['Vue']), [[9, 12]])
  assert.deepEqual(findTermSpans('简体中文版', ['简体中文']), [[0, 4]])
  // 重叠词都收（简体中文 同时含 简体 与 中文）；过滤只看是否被任一段覆盖
  const spans = findTermSpans('简体中文', ['简体中文', '中文', '简体'])
  for (const span of [
    [0, 4],
    [2, 4],
    [0, 2]
  ]) {
    assert.ok(spans.some(([from, to]) => from === span[0] && to === span[1]))
  }
})
