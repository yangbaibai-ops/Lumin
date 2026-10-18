// ─── 拼写检查：语言清单规则 / 菜单建议构建 / 设置持久化 ─────────────────────
//
// 这些都是**纯函数**（不碰 Electron、不碰 DOM），所以能在毫秒级单测里钉住：
//   * 可选项只来自 availableSpellCheckerLanguages，常见语言前置、其余字母序；
//   * 用户选过的语言若已不可用会降级（不能出现"开着却一个词典都没加载"）；
//   * 右键建议最多 5 条、去重、无错词时**不产生分区**（菜单结构不变）；
//   * 开关/语言能穿过设置归一与设置文件往返（重启后仍是同一份）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMON_SPELLCHECK_LANGUAGES,
  MAX_SPELL_SUGGESTIONS,
  resolveSpellcheckLanguages,
  sanitizeSpellcheckLanguages,
  sortSpellcheckLanguages
} from '../src/shared/spellcheck.ts'
import { buildSpellSection, findWordRange } from '../src/renderer/src/lib/editor/menu/spell.ts'
import { defaultSettings } from '../src/shared/defaults.ts'
import { normalizeSettings } from '../src/shared/settingsSchema.ts'
import {
  buildSettingsFile,
  parseSettingsFile,
  serializeSettingsFile
} from '../src/shared/settingsFile.ts'

// ── 语言清单：过滤 / 排序 ────────────────────────────────────────────────────
test('语言排序：常见语言按用户点名顺序在前，其余按字母序，重复项被去掉', () => {
  const sorted = sortSpellcheckLanguages([
    'zz',
    'de-DE',
    'fr-FR',
    'aa',
    'en-US',
    'en-GB',
    'de',
    'de-DE',
    ''
  ])
  assert.deepEqual(sorted, ['en-US', 'en-GB', 'de-DE', 'de', 'fr-FR', 'aa', 'zz'])
  // 用户点名的 11 个变体都必须在常见表里、且相对顺序一致（基础代码紧随其后是允许的扩展）
  const specified = [
    'en-US',
    'en-GB',
    'de-DE',
    'fr-FR',
    'es-ES',
    'pt-BR',
    'it-IT',
    'nl-NL',
    'pl-PL',
    'ru-RU',
    'uk-UA'
  ]
  const indices = specified.map((code) => COMMON_SPELLCHECK_LANGUAGES.indexOf(code))
  assert.ok(
    indices.every((i) => i >= 0),
    '点名的常见语言必须都在优先表里'
  )
  assert.deepEqual(
    indices,
    [...indices].sort((a, b) => a - b),
    '优先表必须保持点名顺序'
  )
  // 中文/日文不在优先表里（Chromium 没有这两种词典）
  assert.ok(!COMMON_SPELLCHECK_LANGUAGES.some((c) => /^(zh|ja)/i.test(c)))
})

test('语言清单不写死：可用清单里没有的语言不会凭空出现', () => {
  assert.deepEqual(sortSpellcheckLanguages(['fr-FR']), ['fr-FR'])
  assert.deepEqual(sortSpellcheckLanguages([]), [])
  // 中文/日文只有在系统真的给了的时候才会出现（当前 Windows 清单里没有）
  assert.deepEqual(sortSpellcheckLanguages(['ja-JP', 'zh-CN']), ['ja-JP', 'zh-CN'])
})

test('只有当前可用的语言会被保留（换机器后旧选择自动失效）', () => {
  assert.deepEqual(
    sanitizeSpellcheckLanguages(['de-DE', 'xx-XX', 'en-US', 'de-DE'], ['en-US', 'de-DE']),
    ['de-DE', 'en-US']
  )
  assert.deepEqual(sanitizeSpellcheckLanguages(['xx-XX'], ['en-US']), [])
})

test('生效语言：用户没选时按"界面语言 → en-US → 常见语言 → 第一个可用"降级', () => {
  const available = ['fr-FR', 'de-DE', 'en-US']
  assert.deepEqual(resolveSpellcheckLanguages([], available, ['zh-CN']), ['en-US'])
  assert.deepEqual(resolveSpellcheckLanguages([], available, ['fr-FR']), ['fr-FR'])
  // 用户选的已不可用 ⇒ 退回默认，而不是留一个空清单
  assert.deepEqual(resolveSpellcheckLanguages(['xx-XX'], available, []), ['en-US'])
  // 只提供不常见语言时用第一个可用项
  assert.deepEqual(resolveSpellcheckLanguages([], ['af', 'bg'], []), ['af'])
  // 平台完全没有词典 ⇒ 空数组（界面如实提示"不可用"）
  assert.deepEqual(resolveSpellcheckLanguages([], [], []), [])
})

// ── 右键菜单：建议构建 ──────────────────────────────────────────────────────
const handlers = () => {
  const calls = []
  return {
    calls,
    replace: (range, word) => calls.push(['replace', range, word]),
    addToDictionary: (word) => calls.push(['add', word]),
    ignore: (word) => calls.push(['ignore', word])
  }
}

test('建议构建：最多 5 条、去重、建议在前动作在后', () => {
  const h = handlers()
  const section = buildSpellSection(
    {
      word: 'teh',
      suggestions: ['the', 'eh', 'tech', 'tee', 'tea', 'ten', 'the', ''],
      range: { from: 1, to: 4 }
    },
    h
  )
  assert.ok(section)
  assert.equal(section.variant, 'spell')
  assert.equal(section.word, 'teh')
  assert.equal(section.labelKey, 'editorMenu.spellSuggestions')
  const suggestions = section.items.filter((i) => i.kind === 'suggestion')
  assert.equal(suggestions.length, MAX_SPELL_SUGGESTIONS)
  assert.deepEqual(
    suggestions.map((i) => i.label),
    ['the', 'eh', 'tech', 'tee', 'tea']
  )
  assert.deepEqual(
    suggestions.map((i) => i.id),
    ['spell.suggest.0', 'spell.suggest.1', 'spell.suggest.2', 'spell.suggest.3', 'spell.suggest.4']
  )
  const actions = section.items.filter((i) => i.kind === 'action')
  assert.deepEqual(
    actions.map((i) => i.id),
    ['spell.addToDictionary', 'spell.ignore']
  )
  assert.equal(actions[1].hintKey, 'editorMenu.spellIgnoreHint', '忽略要讲清"不消除下划线"')
})

test('建议点击：替换到错词范围；添加到词典/忽略各自落到主进程 IPC 处理器', () => {
  const h = handlers()
  const section = buildSpellSection(
    { word: 'teh', suggestions: ['the'], range: { from: 5, to: 8 } },
    h
  )
  section.items.find((i) => i.kind === 'suggestion').run()
  section.items.find((i) => i.id === 'spell.addToDictionary').run()
  section.items.find((i) => i.id === 'spell.ignore').run()
  assert.deepEqual(h.calls, [
    ['replace', { from: 5, to: 8 }, 'the'],
    ['add', 'teh'],
    ['ignore', 'teh']
  ])
})

test('没有错词 ⇒ 不产生分区（右键菜单结构与行为保持原样）', () => {
  assert.equal(buildSpellSection(null, handlers()), null)
  assert.equal(buildSpellSection({ word: '', suggestions: [], range: null }, handlers()), null)
  assert.equal(
    buildSpellSection({ word: '   ', suggestions: ['the'], range: null }, handlers()),
    null
  )
})

test('定位不到词范围时建议项被禁用（不是静默无效）', () => {
  const section = buildSpellSection({ word: 'teh', suggestions: ['the'], range: null }, handlers())
  assert.equal(section.items.find((i) => i.kind === 'suggestion').disabled, true)
})

test('findWordRange：找离右键位置最近的出现处；优先边界完整的词', () => {
  const docOf = (text, start = 1) => ({
    descendants(cb) {
      cb({ isText: true, text }, start)
      return true
    }
  })
  const text = 'teh recieve teh'
  // 'teh' 在 0..2 与 12..14（文档位置各 +1）
  assert.deepEqual(findWordRange(docOf(text), 2, 'teh'), { from: 1, to: 4 })
  assert.deepEqual(findWordRange(docOf(text), 14, 'teh'), { from: 13, to: 16 })
  // 'tehran' 里的 teh 不是完整词 ⇒ 选后面那个完整的
  assert.deepEqual(findWordRange(docOf('tehran teh'), 2, 'teh'), { from: 8, to: 11 })
  assert.equal(findWordRange(docOf(text), 2, 'nope'), null)
})

// ── 设置持久化 ──────────────────────────────────────────────────────────────
test('默认值：拼写检查默认开启、语言留空 = 自动（不写死语言清单）', () => {
  assert.equal(defaultSettings.spellcheckEnabled, true)
  assert.deepEqual(defaultSettings.spellcheckLanguages, [])
})

test('设置归一：开关与语言透过 kv 往返保持不变（重启后仍是同一份）', () => {
  const { settings, changed } = normalizeSettings(
    { ...defaultSettings, spellcheckEnabled: false, spellcheckLanguages: ['de-DE'] },
    defaultSettings
  )
  assert.equal(changed, false, '形状没变就不该每次启动都写回')
  assert.equal(settings.spellcheckEnabled, false)
  assert.deepEqual(settings.spellcheckLanguages, ['de-DE'])
})

test('设置文件往返：拼写检查设置能导出/导入（换机器也带走）', () => {
  const payload = serializeSettingsFile(
    buildSettingsFile({
      ...defaultSettings,
      spellcheckEnabled: false,
      spellcheckLanguages: ['de-DE', 'en-US']
    })
  )
  const parsed = parseSettingsFile(payload)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.patch.spellcheckEnabled, false)
  assert.deepEqual(parsed.patch.spellcheckLanguages, ['de-DE', 'en-US'])
})
