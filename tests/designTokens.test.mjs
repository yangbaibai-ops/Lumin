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
import { readTextNormalized } from './lib/readTextNormalized.mjs'

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
  '--tree-depth', // 文件树缩进层级（内联 style）
  // 波次 2 的窄窗策略：面板宽度从行内 `width` 换成这两个自定义属性，
  // 好让 `chrome.css` 的 900/760 两档媒体查询用 `min()` 夹住（报告 §5.2 P0-1）
  '--sidebar-w', // 侧栏宽度（AppSidebar 的内联 style，值来自 settings.sidebarWidth）
  '--outline-w' // 右侧大纲宽度（OutlinePanel 的内联 style，值来自 settings.outlineRightWidth）
]

/**
 * 消费端允许的**硬编码颜色上限**。
 * 审计 §8 P2 列过的那一批（开关白钮 `#fff`、任务勾 `#fff`、下拉箭头 `%238a919e`、
 * `--shadow-1` 的 rgba 兜底）已全部收进令牌，所以上限收到 **0**：
 * 新增颜色一律先定义令牌，别再往组件 CSS 里写色值。
 */
const LITERAL_COLOR_CEILING = { hex: 0, rgb: 0 }

test('设计令牌：docs/design-tokens.md 的表与 CSS 一致（改了 CSS 就跑 docs:tokens:write）', () => {
  // 行尾归一：CI 的 Windows 检出是 CRLF，而 renderTokensBlock() 生成的是 LF。
  // 不归一就会"内容一致但字符串不等"—— 本地 LF 工作区全绿、干净克隆假红。
  const doc = readTextNormalized(path.join(ROOT, 'docs/design-tokens.md'))
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
    // **注释先剥掉**：注释里常写"用法示例"（`var(--z-xxx)` 这种），那是文档不是消费点
    const css = fs.readFileSync(path.join(ASSETS, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
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

test('设计令牌：导出模板的 :root 与浅色主题逐条一致（导出件不许自带一套色）', () => {
  /**
   * `src/renderer/src/lib/export.ts` 的 `proseCss` 是一份**独立 HTML** 的排版样式：它拿不到
   * 运行时的 CSS 变量，只能写死字面量。写死没问题，问题在"漂" —— 实测曾有两处：
   * `--code-bg` 是 #f4f5f8 而令牌是 #f1f2f5、`--panel-2` 是 #f0f1f4 而令牌是 #e9ebf0，
   * 于是导出的 PDF/HTML 与编辑器里的观感悄悄不同，而且**没有任何东西会发现**。
   * 口径：导出模板里出现的令牌，值必须等于 theme.css 第一个 `:root` 块（浅色主题）。
   */
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'export.ts'),
    'utf-8'
  )
  const start = src.indexOf('const proseCss = `')
  const block = src.slice(start, src.indexOf('html, body {', start))
  const exportVars = new Map(
    [...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
  )
  assert.ok(exportVars.size >= 15, `只解析到 ${exportVars.size} 个导出令牌，解析口径可能不对`)
  const light = tokens.collectTokens().flatMap((s) => s.blocks)[0]
  assert.ok(light && light.tokens.length >= 20, 'theme.css 的第一个 :root 块没解析出来')
  const norm = (v) =>
    v
      .replace(/\s+/g, '')
      .replace(/(\d)\.(\d)/g, '$1.$2')
      .toLowerCase()
  const problems = []
  for (const [name, value] of exportVars) {
    const token = light.tokens.find((t) => t.name === `--${name}`)
    if (!token) problems.push(`--${name} 在浅色主题里没有对应令牌`)
    else if (norm(token.value) !== norm(value))
      problems.push(`--${name}: 导出=${value} 令牌=${token.value}`)
  }
  assert.deepEqual(problems, [], `导出模板的色值与浅色令牌不一致：${problems.join('；')}`)
})

test('设计令牌：消费端只能减少硬编码颜色，不许新增（新颜色请走令牌）', () => {
  const stats = { hex: [], rgb: [] }
  for (const file of fs.readdirSync(ASSETS).filter((f) => f.endsWith('.css'))) {
    // 定义文件本身就是色值的家（theme.css / sidebar.css 的令牌声明）
    if (tokens.SOURCES.some((s) => s.endsWith('/' + file))) continue
    const css = fs.readFileSync(path.join(ASSETS, file), 'utf-8')
    // **注释先剥掉**：注释里写 "旧值是 #FDECD5"、"底色 rgba(0,0,0,0)" 这类说明是文档，
    // 不是声明 —— 把它们算成"硬编码色"会让上限永远收不到 0（也会逼着人别在注释里提色值）。
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    // 只数个数（把命中位置记下来是为了失败时能一眼看出在哪 —— 这里只留文件名，够用）
    for (const hit of code.matchAll(/#[0-9a-f]{3,8}\b/gi)) stats.hex.push(`${file}:${hit[0]}`)
    stats.rgb.push(...[...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map(() => file))
  }
  assert.ok(
    stats.hex.length <= LITERAL_COLOR_CEILING.hex && stats.rgb.length <= LITERAL_COLOR_CEILING.rgb,
    `消费端硬编码颜色变多了：hex=${stats.hex.length}（上限 ${LITERAL_COLOR_CEILING.hex}）` +
      ` rgb/hsl=${stats.rgb.length}（上限 ${LITERAL_COLOR_CEILING.rgb}）—— 新增颜色请定义令牌。`
  )
})
