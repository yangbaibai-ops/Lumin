// ─── 浅色主题「白色配色」回归守卫 ──────────────────────────────────────────────
//
// 用户报障（原话）：「应用的浅色模式怎么变成黄色的了，请恢复成白色配色的。」
//
// 根因是上一轮把浅色纸/外壳/启动骨架一起调暖了：
//   --paper #fbfaf6（暖白）、--app #f4f3ee（暖灰）、--panel-2 #e9e8e2、
//   --edge #e3e2dc、--edge-strong #d2d1ca、--code-bg #f1f0ea；
// 窗口 backgroundColor 与 index.html 的 --boot-paper 也跟着镜像成 #fbfaf6。
// 这一轮全部回到中性白（--paper #ffffff / --app #fafafa），暖色只保留在 sepia 主题。
//
// 这条测试比 `themeTokens.test.mjs` 更"贴用户观感"：它检查浅色关键表面令牌的
// **通道极差**（max-min 很小 = 没有色相偏黄），以后谁再把纸调暖会当场红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PAPER_BY_THEME, PREVIEW_BY_THEME, paperForTheme } from '../src/shared/theme.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSS = readFileSync(join(ROOT, 'src/renderer/src/assets/theme.css'), 'utf-8')
const HTML = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf-8')

/** 取某个主题块的令牌表（注释先剥掉，块内没有嵌套大括号） */
function tokensOf(theme) {
  const m = new RegExp(`\\.theme-${theme}\\s*\\{([^}]*)\\}`).exec(CSS)
  assert.ok(m, `theme.css 里找不到 .theme-${theme}`)
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '')
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()])
  )
}
const LIGHT = tokensOf('light')
const DARK = tokensOf('dark')
const SEPIA = tokensOf('sepia')

const rgb = (hex) => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
/** 通道极差：0 = 纯中性灰；很小 = 肉眼看不出色相 */
const chroma = (hex) => {
  const [r, g, b] = rgb(hex)
  return Math.max(r, g, b) - Math.min(r, g, b)
}

test('浅色纸 / 外壳 / 窗口底色 / 启动骨架 = 白色系且同源', () => {
  assert.equal(PAPER_BY_THEME.light, '#ffffff')
  assert.equal(LIGHT['--paper'].toLowerCase(), '#ffffff')
  assert.equal(paperForTheme('light', true), '#ffffff', '显式浅色不跟随系统')
  assert.equal(paperForTheme('light', false), '#ffffff')
  assert.equal(paperForTheme('auto', false), '#ffffff')
  assert.equal(LIGHT['--app'].toLowerCase(), '#fafafa')
  assert.equal(PREVIEW_BY_THEME.light.paper, '#ffffff')
  assert.equal(PREVIEW_BY_THEME.light.shell, '#fafafa')
  assert.match(HTML, /--boot-paper:\s*#ffffff/i, '启动骨架也必须铺纯白')
})

test('浅色关键表面没有暖色相（通道极差 ≤ 10）：不再泛黄', () => {
  for (const token of [
    '--app',
    '--paper',
    '--panel',
    '--panel-2',
    '--elevate',
    '--edge',
    '--edge-strong',
    '--code-bg'
  ]) {
    const value = LIGHT[token].toLowerCase()
    assert.match(value, /^#[0-9a-f]{6}$/, `${token} 不是 6 位 hex：${value}`)
    assert.ok(
      chroma(value) <= 10,
      `${token}=${value} 通道极差 ${chroma(value)}（>10 会看出明显色相）`
    )
  }
})

test('旧的暖白色值已被清掉（只允许出现在注释历史里）', () => {
  for (const old of ['#fbfaf6', '#f4f3ee', '#e9e8e2', '#e3e2dc', '#d2d1ca', '#f1f0ea']) {
    assert.equal(
      CSS.toLowerCase().includes(old),
      false,
      `theme.css 仍残留暖白值 ${old}（用户报障的黄色来源）`
    )
  }
})

test('深色与羊皮纸未被改坏', () => {
  assert.equal(DARK['--app'].toLowerCase(), '#2b2e33')
  assert.equal(DARK['--paper'].toLowerCase(), '#35383d')
  assert.equal(PAPER_BY_THEME.dark, '#35383d')
  // 羊皮纸的暖色是**有意为之**，本轮保留
  assert.equal(SEPIA['--app'].toLowerCase(), '#f1e9d5')
  assert.equal(SEPIA['--paper'].toLowerCase(), '#faf4e4')
  assert.equal(PAPER_BY_THEME.sepia, '#faf4e4')
  assert.ok(chroma(SEPIA['--paper']) > 6, '羊皮纸必须保持暖色（不能被一并改白）')
})
