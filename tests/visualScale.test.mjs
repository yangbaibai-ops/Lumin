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
  '0 6px 6px 0',
  // 公式编辑容器（Typora 那种"上半源码 / 下半渲染"的合体盒子）只用**上下**两处方向性圆角：
  // 源码区圆上两角、渲染区圆下两角，中间相接处必须是直角（否则接缝会露白）。px 值仍取自
  // 上面的 3/4px 两档，只是把方向写全 —— 所以登记这两条，而不是新造一档半径。
  '4px 4px 0 0',
  '0 0 3px 3px'
]

/** 字号里不属于"档位"的写法（相对排版 / 继承 / 运行时注入 / 令牌引用） */
const TEXT_NON_TIER = [
  'inherit',
  '0',
  'var(--editor-size, 17px)',
  // 公式源码框顶行那行小字：**引用令牌**而不是新写一个 px（令牌本身就是档位，见 theme.css
  // 的 `@theme` 块：`--text-ui` 12.5px / `--text-ui-sm` 12px）。写 `12px` 会被上面的闭集
  // 放行、写 `var(--text-ui-sm)` 更准确地表达"这是界面小字档"，所以登记这一条。
  'var(--text-ui-sm)'
]

/**
 * 任意值类的**上限**（本轮实测 164）。它只能变小：新代码请用令牌或现有档位。
 *
 * ⚠️ 152 → 155（波次 2，报告 §5.2 P0-1 的窄窗策略）：正文内边距需要两档 `max-[Npx]:` 变体
 * （`max-[900px]:px-8` / `max-[760px]:px-5` / `max-[760px]:pt-7`）—— 断点值本身没有令牌可表达，
 * 而 Tailwind 的具名断点（sm/md/lg）不由我们定义、也不能表达 900/760 这两个值。
 * 这三条是**登记在案**的例外，其它任何新增都还会被这条拦住。
 *
 * ⚠️ 155 → 164（波次 3，命令面板）：面板是**浮层**，尺寸来自它自己的排版（`w-[620px]` /
 * `max-w-[92vw]` / `max-h-[52vh]` / 若干 `text-[11px]`~`text-[14.5px]` 的紧凑档），
 * 其中 `z-[var(--z-modal)]` 是**令牌驱动**、本来就该这么写。
 * 这一档增长是**一次性**的：命令面板已经落地，后续想再加任意值请先把这批收进令牌/档位，
 * 而不是继续抬这个数。
 */
const ARBITRARY_CEILING = 164

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

test('Tailwind 任意值总数只减不增（本轮上限 155）', () => {
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

test('圆角：命名工具类（rounded / rounded-lg / …）也是闭集', () => {
  /**
   * 为什么连"命名档"也要管：`rounded-lg` / `rounded-2xl` / `rounded-full` 的**字面量**不在源码里
   * （Tailwind 自己展开成 px / 9999px），静态闭集看不到它们 —— 于是"加一个新圆角档"可以绕过
   * `RADIUS_TIERS`（比如 `rounded-3xl` = 24px 就没人拦）。这里把**在用的命名档**也收成闭集：
   * 新增一档必须先登记，顺便回答"它展开成多少 px、要不要进 RADIUS_TIERS"。
   * 运行时那一半见 `tools/_verify-visual-scale.js` 的 V5（真的量计算值）。
   */
  const NAMED = [
    'rounded',
    'rounded-sm',
    'rounded-md',
    'rounded-lg',
    'rounded-xl',
    'rounded-2xl',
    'rounded-full'
  ]
  const used = new Set()
  for (const f of walkSrc()) {
    const text = fs.readFileSync(f, 'utf-8')
    for (const m of text.matchAll(
      /(?<![\w-])rounded(-(?:none|xs|sm|md|lg|xl|2xl|3xl|4xl|full))?(?![\w-])/g
    )) {
      used.add(m[0])
    }
  }
  const extra = [...used].filter((c) => !NAMED.includes(c)).sort()
  assert.deepEqual(
    extra,
    [],
    `出现了没登记的命名圆角档：${extra.join(', ')}（先确认它展开成多少 px，再决定是否进 RADIUS_TIERS）`
  )
  const unused = NAMED.filter((c) => !used.has(c))
  assert.deepEqual(unused, [], `这些命名圆角档已经没人用了：${unused.join(', ')}（请删掉）`)
})

/**
 * ─── 窄窗两档断点（报告 §5.2 P0-1「全仓零宽度断点」）────────────────────────────
 *
 * 报告点名的现象：`@media` 全仓只有 7 处且**全是** `prefers-reduced-motion`，一条宽度断点都没有；
 * 侧栏硬钳 200–420、右侧大纲 160–420 ⇒ 窄窗下正文被挤到 200–340px；而窗口最小尺寸还是 940×600
 * —— 1366×768 @150% 缩放的可用逻辑尺寸只有 911×512，"最小窗口"比屏幕还大（右边缘永远够不着）。
 *
 * 这条守卫把"两档断点 + 最小尺寸"钉住：断点值一共出现在四处
 * （`chrome.css` / `TyporaEditor.vue` 的内边距变体 / `main/windowPlacement.ts` 的常量 /
 * `_verify-a11y.js` 的窄窗断言），改一处就得四处对齐。
 */
test('窄窗策略：900/760 两档断点存在，且最小窗口尺寸与之配套', () => {
  const chrome = fs.readFileSync(path.join(ASSETS, 'chrome.css'), 'utf-8')
  assert.match(
    chrome,
    /\.sidebar-root\s*\{[^}]*width:\s*var\(--sidebar-w/,
    '侧栏宽度要走 --sidebar-w'
  )
  assert.match(
    chrome,
    /\[data-outline-panel\]\s*\{[^}]*width:\s*var\(--outline-w/,
    '右侧大纲宽度要走 --outline-w'
  )
  assert.match(chrome, /@media \(max-width: 900px\)/, '缺 900px 那一档')
  assert.match(chrome, /@media \(max-width: 760px\)/, '缺 760px 那一档')
  assert.match(
    chrome,
    /@media \(max-width: 760px\)[\s\S]*?\.sidebar-root\s*\{[^}]*width:\s*min\(var\(--sidebar-w/,
    '760px 档要让侧栏收窄（min(var(--sidebar-w), 34vw)）'
  )
  assert.match(
    chrome,
    /@media \(max-width: 900px\)[\s\S]*?\[data-outline-panel\]\s*\{[^}]*width:\s*min\(var\(--outline-w/,
    '900px 档要让右侧大纲收窄（min(var(--outline-w), 22vw)）'
  )

  // 正文内边距：窄窗必须让位（Tailwind 的 max-[Npx]: 变体）
  const editor = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/components/editor/TyporaEditor.vue'),
    'utf-8'
  )
  assert.match(editor, /max-\[900px\]:px-8/, '900px 档要把正文内边距降到 32px')
  assert.match(editor, /max-\[760px\]:px-5/, '760px 档要把正文内边距降到 20px')

  // 最小尺寸：与 windowPlacement.ts 同源，且不能再回到"比小屏还大"的 940
  const placement = fs.readFileSync(path.join(ROOT, 'src/main/windowPlacement.ts'), 'utf-8')
  const w = Number(/export const MIN_WINDOW_WIDTH = (\d+)/.exec(placement)?.[1])
  const h = Number(/export const MIN_WINDOW_HEIGHT = (\d+)/.exec(placement)?.[1])
  assert.equal(w, 760, '最小宽度应为 760（1366×768 @150% 的可用宽度是 911）')
  assert.equal(h, 520, '最小高度应为 520（同上，可用高度 512）')
  const index = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf-8')
  assert.match(
    index,
    /minWidth:\s*MIN_WINDOW_WIDTH/,
    'index.ts 必须用常量而不是字面量（两处不同源就会出现"窗口一起来就被夹"）'
  )
  assert.doesNotMatch(index, /minWidth:\s*940/, '不许再写回 940 字面量')
})
