// ─── CDP 套件共用的颜色关系原语（tools/lib/color.js）自检 ──────────────────────
//
// 为什么值得单独一测：套件里的「关系」全部经这层现算（纸比外壳亮、代码块与纸可辨、
// 正文对比度 ≥7:1）。这层算错了，套件会**看起来是绿的**——量错的绿比红的更危险。
// 另外 `SURFACE_PROBE` 是一段塞进页面的**字符串**表达式：模板字面量里少写一个反斜杠
// （`\(` → `(`）就会拼出非法正则，而那种错要等真跑 CDP 才炸。这里先解析一遍兜住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const c = require(join(ROOT, 'tools', 'lib', 'color.js'))

test('parseColor：认得计算样式的四种写法', () => {
  assert.deepEqual(c.parseColor('rgb(252, 252, 251)'), { r: 252, g: 252, b: 251, a: 1 })
  assert.deepEqual(c.parseColor('rgba(99, 102, 241, 0.1)'), { r: 99, g: 102, b: 241, a: 0.1 })
  assert.deepEqual(c.parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 })
  assert.deepEqual(c.parseColor('#fcfcfb'), { r: 252, g: 252, b: 251, a: 1 })
  assert.deepEqual(c.parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 })
  // color-mix 的产物：分量是 0–1 的 sRGB 浮点，可带 alpha
  const srgb = c.parseColor('color(srgb 0.988 0.988 0.984)')
  assert.ok(Math.abs(srgb.r - 251.94) < 0.01 && srgb.a === 1)
  const srgbA = c.parseColor('color(srgb 0.35 0.36 0.38 / 0.07)')
  assert.ok(Math.abs(srgbA.r - 89.25) < 0.01 && srgbA.a === 0.07)
  assert.equal(c.parseColor('不是颜色'), null)
})

test('over：前景 alpha 合到底色上（合完不透明）', () => {
  // accent-soft 0.1 压在近白纸上
  const mixed = c.over('rgba(99, 102, 241, 0.1)', 'rgb(252, 252, 251)')
  assert.ok(mixed.a === 1)
  assert.ok(Math.abs(mixed.r - (99 * 0.1 + 252 * 0.9)) < 0.01)
  // 不透明前景原样返回
  assert.deepEqual(c.over('#123456', '#ffffff'), { r: 18, g: 52, b: 86, a: 1 })
})

test('contrast：两端锚点与 WCAG 定义一致', () => {
  assert.ok(Math.abs(c.contrast('#000000', '#ffffff') - 21) < 1e-9)
  assert.ok(Math.abs(c.contrast('#ffffff', '#ffffff') - 1) < 1e-9)
  // 顺序无关
  assert.equal(c.contrast('#123456', '#ffffff'), c.contrast('#ffffff', '#123456'))
  // 带 alpha 的前景按「合到背景上」再比：同一色不透明与半透明之间必须仍然可算
  const v = c.contrast('rgba(0, 0, 0, 0.5)', '#ffffff')
  assert.ok(v > 1 && v < 21)
})

test('sameColor：容差 1/255，够吸掉 color(srgb …) 的取整差', () => {
  assert.ok(c.sameColor('rgb(252, 252, 251)', '#fcfcfb'))
  assert.ok(c.sameColor('color(srgb 0.988 0.988 0.984)', 'rgb(252, 252, 251)'))
  assert.ok(!c.sameColor('#fcfcfb', '#f2f3f7'))
  assert.ok(!c.sameColor('rgba(99, 102, 241, 0.1)', 'rgba(99, 102, 241, 0.2)'))
  assert.ok(!c.sameColor(null, '#fff'))
})

test('SURFACE_PROBE：页面侧表达式必须能通过 JS 解析（模板字面量转义陷阱）', () => {
  assert.doesNotThrow(() => new Function(`return (${c.SURFACE_PROBE})`))
  // 关键正则真的落在字符串里（少一个反斜杠就会拼成非法/语义错的正则）
  assert.ok(c.SURFACE_PROBE.includes('/^rgba?[(]([^)]*)[)]$/'), 'rgb/rgba 解析正则丢了')
  assert.ok(
    c.SURFACE_PROBE.includes('/^color\\(srgb\\s+([^)]*)\\)$/'),
    'color(srgb …) 解析正则丢了'
  )
  // 结构：整支表达式必须恰好是 JSON.stringify(IIFE) —— 少一个右括号、多一层 stringify
  // （双重编码：套件 readJson 会解出字符串，字段全 undefined）都只有真跑起来才炸
  assert.ok(c.SURFACE_PROBE.startsWith('JSON.stringify((() => {'))
  assert.ok(c.SURFACE_PROBE.endsWith('})())'))
  assert.equal(
    (c.SURFACE_PROBE.match(/JSON\.stringify\(/g) || []).length,
    1,
    'SURFACE_PROBE 里出现了多层 JSON.stringify（双重编码）'
  )
})
