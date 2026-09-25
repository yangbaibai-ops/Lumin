// 设计令牌：清单不手写、主题要齐、消费端不许再冒硬编码色（审计 §8 P2「没有设计令牌文档」/
// 「token 未覆盖的硬编码色」）。
//
// 令牌表由 `tools/doc-tokens.js` 从 CSS 抽出来写进 `docs/design-tokens.md`，
// 这条测试守住四件**会悄悄漂**的事：
//   ① 表与 CSS 一致（不一致 → 跑 npm run docs:tokens:write）；
//   ② 同一声明块里没有重复令牌（后面的值会静默覆盖前面的 —— 排查起来极痛）；
//   ③ **三个主题的令牌集合完全一致**（少一个 = 那个主题下漏色，靠肉眼发现不了）；
//   ④ 消费端（组件样式）不许再新增硬编码颜色，且 `var(--x)` 都必须有出处
//      （运行时由 JS/内联样式提供的少数几个显式登记，见 RUNTIME_TOKENS）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const ASSETS = path.join(ROOT, 'src/renderer/src/assets')

const tokens = require(path.join(ROOT, 'tools/doc-tokens.js'))

/** 运行时由 JS / 内联样式写入的 CSS 变量（不是"漏定义"，是**另一半真相**） */
const RUNTIME_TOKENS = [
  '--split-left', // 分屏比例（EditorView 的内联 style）
  '--editor-font', // 设置：字体（stores/settings.applyAll）
  '--editor-size', // 设置：字号
  '--editor-lh', // 设置：行高
  '--toc-depth', // 目录缩进层级（内联 style）
  '--tree-depth' // 文件树缩进层级（内联 style）
]

/**
 * 消费端允许的**硬编码颜色上限**（当前实测值）。
 * 它们不是"待办"，而是历史遗留：新增颜色一律走令牌。这条断言的意义是
 * **只能减少、不能增加** —— 想加一个就必须先减一个（或把这次改动写进 CHANGELOG 之前先想清楚）。
 */
const LITERAL_COLOR_CEILING = { hex: 7, rgb: 4 }

test('设计令牌：docs/design-tokens.md 的表与 CSS 一致（改了 CSS 就跑 docs:tokens:write）', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/design-tokens.md'), 'utf-8')
  const a = doc.indexOf(tokens.BEGIN)
  const b = doc.indexOf(tokens.END)
  assert.ok(a >= 0 && b > a, 'docs/design-tokens.md 里没有 tokens 标记块')
  assert.equal(
    doc.slice(a, b + tokens.END.length),
    tokens.renderTokensBlock(),
    '令牌表过期了 —— 跑 npm run docs:tokens:write 重算'
  )
  const total = tokens.collectTokens().flatMap((s) => s.blocks.flatMap((x) => x.tokens)).length
  assert.ok(total >= 100, `令牌总数只有 ${total}，是不是解析口径把 CSS 漏掉了？`)
})

test('设计令牌：同一声明块里不许重复定义（后面的值会静默覆盖前面的）', () => {
  const dupes = []
  for (const src of tokens.collectTokens()) {
    for (const block of src.blocks) {
      const seen = new Set()
      for (const t of block.tokens) {
        if (seen.has(t.name)) dupes.push(`${src.file} ${block.selector} ${t.name}`)
        seen.add(t.name)
      }
    }
  }
  assert.deepEqual(dupes, [], `这些令牌被重复定义：${dupes.join(', ')}`)
})

test('设计令牌：三个主题的令牌集合完全一致（少一个就是那个主题下漏色）', () => {
  const blocks = tokens
    .collectTokens()
    .flatMap((s) => s.blocks)
    .filter((b) => /\.theme-/.test(b.selector))
  assert.ok(
    blocks.length >= 3,
    `主题块只找到 ${blocks.length} 个：${blocks.map((b) => b.selector)}`
  )
  const sets = blocks.map((b) => ({
    selector: b.selector,
    names: new Set(b.tokens.map((t) => t.name))
  }))
  const base = sets[0]
  for (const s of sets.slice(1)) {
    const missing = [...base.names].filter((n) => !s.names.has(n))
    const extra = [...s.names].filter((n) => !base.names.has(n))
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${s.selector} 与 ${base.selector} 的令牌集合不一致（missing=${missing.join(',')} extra=${extra.join(',')}）`
    )
  }
})

test('设计令牌：消费端的 var(--x) 都有出处（运行时注入的几个显式登记）', () => {
  const defined = new Set(
    tokens.collectTokens().flatMap((s) => s.blocks.flatMap((b) => b.tokens.map((t) => t.name)))
  )
  const dangling = new Set()
  for (const file of fs.readdirSync(ASSETS).filter((f) => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(ASSETS, file), 'utf-8')
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)/gi)) {
      if (!defined.has(m[1]) && !RUNTIME_TOKENS.includes(m[1])) dangling.add(m[1])
    }
  }
  assert.deepEqual(
    [...dangling],
    [],
    `这些变量既没有定义、也不在运行时注入名单里（多半是拼错了）：${[...dangling].join(', ')}`
  )
})

test('设计令牌：消费端只能减少硬编码颜色，不许新增（新颜色请走令牌）', () => {
  const stats = { hex: [], rgb: [] }
  for (const file of fs.readdirSync(ASSETS).filter((f) => f.endsWith('.css'))) {
    // 定义文件本身就是色值的家（theme.css / sidebar.css 的令牌声明）
    if (tokens.SOURCES.some((s) => s.endsWith('/' + file))) continue
    const css = fs.readFileSync(path.join(ASSETS, file), 'utf-8')
    // 只数个数（把命中位置记下来是为了失败时能一眼看出在哪 —— 这里只留文件名，够用）
    for (const hit of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) stats.hex.push(`${file}:${hit[0]}`)
    stats.rgb.push(...[...css.matchAll(/\b(?:rgba?|hsla?)\(/g)].map(() => file))
  }
  assert.ok(
    stats.hex.length <= LITERAL_COLOR_CEILING.hex && stats.rgb.length <= LITERAL_COLOR_CEILING.rgb,
    `消费端硬编码颜色变多了：hex=${stats.hex.length}（上限 ${LITERAL_COLOR_CEILING.hex}）` +
      ` rgb/hsl=${stats.rgb.length}（上限 ${LITERAL_COLOR_CEILING.rgb}）—— 新增颜色请定义令牌。`
  )
})
