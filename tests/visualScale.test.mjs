// ─── 视觉尺度（字号 / 圆角 / 任意值）的**闭集**门禁（审计 §8 P2）──────────────────
//
// 审计的现场：「字号 20 档、圆角 14 档、Tailwind 任意值 194 处」——问题不是"值多"，
// 而是**没有档位表、也没有任何东西拦住新值**：任何组件都能随手写一个 `text-[12.3px]`，
// 于是档位只会越来越多（本次实测：界面字号 13 档、圆角 16 档、任意值类 **220** 处）。
//
// 这一轮做了两件事，并在本文件里把它们钉住：
//   ① 把用得最多的两档字号收成令牌：`text-ui`(12.5px) / `text-ui-sm`(12px)，共 **68 处**
//      从任意值变成语义类（px 一个都没改）⇒ 任意值总数 **220 → 152**；
//   ② 剩下的值进**闭集**：想加一个新字号/新圆角，必须先改这里的档位表 ——
//      也就是"显式做一次决定"，而不是随手写个新 px。
//
// 口径：只统计**界面尺度**（px）。正文排版那一套是 em（相对 `--editor-size`），
// `inherit` / `0` / `var(--editor-size, 17px)` 也不属于"档位"，分别单独登记。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = path.join(ROOT, 'src/renderer/src/assets')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * **界面字号档位表**（px，从小到大）。
 * 半像素档（11.5 / 12.5 / 13.5）是有意的：中文在小字号下半像素差别很明显（见 SettingsDialog 的历史注释）。
 * `28px` 是「关于」页那个大号标题，单独一档。
 */
const TEXT_TIERS = [
  '9.5px',
  '10.5px',
  '11px',
  '11.5px',
  '12px',
  '12.5px',
  '13px',
  '13.5px',
  '14px',
  '14.5px',
  '15px',
  '18px',
  '28px'
]

/** **圆角档位表**：0 / 2–12px / 22px / 胶囊 / 正圆，另加两条方向性圆角（半开） */
const RADIUS_TIERS = [
  '0',
  '2px',
  '3px',
  '4px',
  '5px',
  '6px',
  '7px',
  '8px',
  '9px',
  '10px',
  '12px',
  '22px',
  '50%',
  '999px',
  '0 12px 12px 0',
  '0 6px 6px 0'
]

/** 字号里不属于"档位"的写法（相对排版 / 继承 / 运行时注入） */
const TEXT_NON_TIER = ['inherit', '0', 'var(--editor-size, 17px)']

/** 任意值类的**上限**（本轮实测 152）。它只能变小：新代码请用令牌或现有档位。 */
const ARBITRARY_CEILING = 152

function walkSrc(acc = [], dir = path.join(ROOT, 'src')) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) walkSrc(acc, f)
    else if (/\.(vue|ts)$/.test(e.name)) acc.push(f)
  }
  return acc
}

/** CSS 里的 font-size / border-radius 取值（排除定义文件 theme.css） */
function cssValues(prop) {
  const out = {}
  for (const f of fs.readdirSync(ASSETS).filter((x) => x.endsWith('.css') && x !== 'theme.css')) {
    const css = strip(fs.readFileSync(path.join(ASSETS, f), 'utf-8'))
    for (const m of css.matchAll(new RegExp(`${prop}:\\s*([^;]+);`, 'g'))) {
      const v = m[1].trim()
      out[v] = (out[v] ?? 0) + 1
    }
  }
  return out
}

/** Tailwind 任意值类（只在模板/组件里） */
function arbitraryClasses(prefix) {
  const out = {}
  for (const f of walkSrc()) {
    const text = strip(fs.readFileSync(f, 'utf-8'))
    for (const m of text.matchAll(new RegExp(`${prefix}-\\[([^\\]]+)\\]`, 'g'))) {
      out[m[1]] = (out[m[1]] ?? 0) + 1
    }
  }
  return out
}

test('字号：界面尺度的档位是一个**闭集**（加新档要先改这张表）', () => {
  const css = Object.keys(cssValues('font-size')).filter((v) => /^[\d.]+px$/.test(v))
  const tw = Object.keys(arbitraryClasses('text')).filter((v) => /^[\d.]+px$/.test(v))
  const actual = new Set([...css, ...tw])
  const allowed = new Set(TEXT_TIERS)
  const extra = [...actual].filter((v) => !allowed.has(v)).sort()
  assert.deepEqual(
    extra,
    [],
    `出现了档位表之外的字号：${extra.join(', ')}\n` +
      '要么改用现有档位（令牌 `text-ui` / `text-ui-sm` 或上表里的值），' +
      '要么把它加进 tests/visualScale.test.mjs 的 TEXT_TIERS 并在 theme.css 里说明用途。'
  )
  // 反向：档位表里不该留已经没人用的值（否则表会慢慢变成"历史遗留清单"）
  const unused = TEXT_TIERS.filter((v) => !actual.has(v))
  assert.deepEqual(unused, [], `档位表里这些值已经没人用了：${unused.join(', ')}（请删掉）`)
})

test('字号：主力两档已经收成令牌（不再有 text-[12.5px] / text-[12px]）', () => {
  const leftovers = []
  for (const f of walkSrc()) {
    const text = fs.readFileSync(f, 'utf-8')
    if (text.includes('text-[12.5px]'))
      leftovers.push(`${path.relative(ROOT, f)} → text-[12.5px]（改 text-ui）`)
    if (text.includes('text-[12px]'))
      leftovers.push(`${path.relative(ROOT, f)} → text-[12px]（改 text-ui-sm）`)
  }
  assert.deepEqual(leftovers, [], `这两档已经收进令牌，别再写任意值：\n${leftovers.join('\n')}`)
})

test('字号：两个令牌定义在 @theme 里，且值就是那两档', () => {
  const css = fs.readFileSync(path.join(ASSETS, 'theme.css'), 'utf-8')
  const theme = /@theme\s*\{([^}]*)\}/.exec(css)
  assert.ok(theme, 'theme.css 里找不到 @theme 块')
  assert.match(theme[1], /--text-ui:\s*12\.5px;/)
  assert.match(theme[1], /--text-ui-sm:\s*12px;/)
})

test('圆角：档位也是闭集', () => {
  const css = Object.keys(cssValues('border-radius'))
  const tw = Object.keys(arbitraryClasses('rounded'))
  const actual = new Set([...css, ...tw])
  const allowed = new Set(RADIUS_TIERS)
  const extra = [...actual].filter((v) => !allowed.has(v)).sort()
  assert.deepEqual(
    extra,
    [],
    `出现了档位表之外的圆角：${extra.join(', ')}\n` +
      '要么改用现有档位，要么加进 tests/visualScale.test.mjs 的 RADIUS_TIERS 并说明用途。'
  )
  const unused = RADIUS_TIERS.filter((v) => !actual.has(v))
  assert.deepEqual(unused, [], `档位表里这些圆角已经没人用了：${unused.join(', ')}（请删掉）`)
})

test('字号里的非档位写法被显式登记（inherit / 0 / 运行时注入 / em 正文排版），没有别的例外', () => {
  const nonTier = Object.keys(cssValues('font-size')).filter((v) => !/^[\d.]+px$/.test(v))
  const extra = nonTier.filter(
    (v) =>
      !TEXT_NON_TIER.includes(v) &&
      // em 系是**正文排版**（相对 --editor-size），本来就该用相对单位，不参与界面档位
      !/^[\d.]+em$/.test(v)
  )
  assert.deepEqual(extra, [], `这些 font-size 写法既不是档位、也没登记过：${extra.join(', ')}`)
})

test('Tailwind 任意值总数只减不增（本轮 220 → 152）', () => {
  let total = 0
  for (const f of walkSrc()) {
    const m = fs.readFileSync(f, 'utf-8').match(/[a-z-]+-\[[^\]]+\]/g)
    total += m ? m.length : 0
  }
  assert.ok(
    total <= ARBITRARY_CEILING,
    `任意值类从 ${ARBITRARY_CEILING} 涨到了 ${total} —— 新样式请用令牌或现有档位（这条上限只能往下调）`
  )
})
