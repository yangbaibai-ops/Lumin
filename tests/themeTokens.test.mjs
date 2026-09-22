// ─── 三主题「两段式表面」令牌的不变量（chrome 灰 / paper 白）─────────────────────
//
// 为什么要有这层单元测试（而不是只靠 CDP 套件量计算样式）：
//
//   1. **纸色有两个消费方**：渲染层 `style.css` 的 `--paper` 和主进程窗口底色
//      （`src/shared/theme.ts` → `themeBackground()`）。主进程读不到 CSS，只能镜像；
//      镜像一旦漂移，启动瞬间就会先闪一块别的颜色（正是「防闪白」要消灭的那一下）。
//      这里把两边逐主题钉死。
//   2. **套件里尽量只留关系型断言**：所以「纸比外壳亮」「代码块底色与纸可辨」
//      「正文对纸对比度 ≥ 7:1」这些**不变量**放在这里用纯数值判定（毫秒级、无 Electron），
//      CDP 套件那边只复核真实计算样式确实兑现了同样的关系。
//
// 数值口径：WCAG 相对亮度 + 对比度（sRGB，见 WCAG 2.1 定义）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PAPER_BY_THEME } from '../src/shared/theme.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * 令牌的读取口径：**把 assets 下所有 CSS 分片按 style.css 的 @import 顺序拼起来**看。
 *
 * 为什么不是只读 style.css：自查报告 S2 把那份 2398 行的单文件按语义拆成了
 * theme/base/components/markdown/editor/sidebar/chrome/overlays 八片，style.css 只剩 @import。
 * 按入口的 @import 顺序拼装，既能继续断言「令牌就在包里」，也不会因为下一次再拆文件而假红。
 */
function readAllCss() {
  const dir = join(ROOT, 'src/renderer/src/assets')
  const entry = readFileSync(join(dir, 'style.css'), 'utf-8')
  const order = [...entry.matchAll(/@import\s+'\.\/([\w.-]+\.css)'/g)].map((m) => m[1])
  const files = order.length
    ? order
    : readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'style.css')
  return files.map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n')
}
const CSS = readAllCss()

/** 取出某个主题块的令牌表（注释先剥掉，块内没有嵌套大括号） */
function themeTokens(name) {
  const m = new RegExp(`\\.theme-${name}\\s*\\{([^}]*)\\}`).exec(CSS)
  assert.ok(m, `CSS 分片里找不到 .theme-${name} 的令牌块`)
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '')
  const out = {}
  for (const t of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[t[1]] = t[2].trim()
  return out
}

const THEMES = ['light', 'dark', 'sepia']
const TOKENS = Object.fromEntries(THEMES.map((t) => [t, themeTokens(t)]))

function hex(v) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v).trim())
  assert.ok(m, `不是合法的 hex 色值：${v}`)
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

/** WCAG 相对亮度 */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度（亮/暗自动排序，≥1） */
function contrast(a, b) {
  const [x, y] = [luminance(hex(a)), luminance(hex(b))]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const f = (n) => n.toFixed(3)

test('窗口底色（shared/theme.ts）与 style.css 的 --paper 逐主题一致', () => {
  for (const t of THEMES) {
    assert.equal(
      PAPER_BY_THEME[t].toLowerCase(),
      TOKENS[t]['--paper'].toLowerCase(),
      `${t}：窗口底色 ${PAPER_BY_THEME[t]} ≠ 纸色 ${TOKENS[t]['--paper']}（启动会闪一下别的颜色）`
    )
  }
})

test('不变量①：纸比外壳（chrome）亮 —— 三主题都成立', () => {
  for (const t of THEMES) {
    const paper = TOKENS[t]['--paper']
    const chrome = TOKENS[t]['--app']
    assert.ok(
      luminance(hex(paper)) > luminance(hex(chrome)),
      `${t}：纸 ${paper} 不比外壳 ${chrome} 亮（L ${f(luminance(hex(paper)))} vs ${f(luminance(hex(chrome)))}）`
    )
    // 只差 1/255 那种「数值上成立、肉眼上糊成一片」也要拦下
    assert.ok(
      contrast(paper, chrome) >= 1.03,
      `${t}：纸与外壳对比度只有 ${f(contrast(paper, chrome))}:1，两段式看不出来`
    )
  }
})

test('不变量②：面板（--panel/--elevate）不比纸暗；能更亮时必须更亮', () => {
  for (const t of THEMES) {
    for (const key of ['--panel', '--elevate']) {
      const panel = TOKENS[t][key]
      const paper = TOKENS[t]['--paper']
      const L = { panel: luminance(hex(panel)), paper: luminance(hex(paper)) }
      // 底线：面板**永远不能比纸暗**（否则浮层看起来像凹进去的洞）
      assert.ok(
        L.panel >= L.paper,
        `${t}：${key}=${panel} 比纸 ${paper} 暗（L ${f(L.panel)} vs ${f(L.paper)}）`
      )
      // 浅色主题的纸是**纯白**（用户口径）：#ffffff 已是亮度上限，这一档明度差不存在，
      // 浮层改由 1px --edge 边框 + --shadow-2 投影立起来（所有对话框/菜单/气泡都带这两样）。
      // 因此只要求「同色」，但**必须真的是纯白** —— 否则说明纸被改成了近白又没同步这条例外。
      if (t === 'light') {
        assert.equal(paper.toLowerCase(), '#ffffff', `light：纸应为纯白，实际 ${paper}`)
        assert.equal(panel.toLowerCase(), '#ffffff', `light：${key} 应同为纯白，实际 ${panel}`)
        continue
      }
      // 深色 / sepia：纸刻意压暗就是为了给面板留出「再亮一档」，这里必须**严格更亮**
      assert.ok(L.panel > L.paper, `${t}：${key}=${panel} 不比纸 ${paper} 亮（浮层会只剩边框可辨）`)
    }
  }
})

test('正文对纸的对比度 ≥ 7:1（三主题）', () => {
  const seen = {}
  for (const t of THEMES) {
    const c = contrast(TOKENS[t]['--ink'], TOKENS[t]['--paper'])
    seen[t] = Number(c.toFixed(2))
    assert.ok(
      c >= 7,
      `${t}：正文 ${TOKENS[t]['--ink']} 对纸 ${TOKENS[t]['--paper']} 只有 ${f(c)}:1`
    )
  }
  // 印在报告里，方便人工核对「最好 ≥ 12:1」
  console.log('ink/paper 对比度 ' + JSON.stringify(seen))
})

test('承载「比纸略灰」的面在白纸上仍可辨识（代码块 / 表头 / 分隔线 / 引用色条）', () => {
  const seen = {}
  for (const t of THEMES) {
    const paper = TOKENS[t]['--paper']
    const probe = {
      codeBg: TOKENS[t]['--code-bg'],
      panel2: TOKENS[t]['--panel-2'],
      edge: TOKENS[t]['--edge'],
      edgeStrong: TOKENS[t]['--edge-strong']
    }
    seen[t] = Object.fromEntries(
      Object.entries(probe).map(([k, v]) => [k, Number(contrast(v, paper).toFixed(3))])
    )
    assert.ok(
      contrast(probe.codeBg, paper) >= 1.05,
      `${t}：代码块底色 ${probe.codeBg} 与纸 ${paper} 只差 ${f(contrast(probe.codeBg, paper))}:1`
    )
    assert.ok(
      contrast(probe.panel2, paper) >= 1.08,
      `${t}：表头/悬停底色 ${probe.panel2} 与纸 ${paper} 只差 ${f(contrast(probe.panel2, paper))}:1`
    )
    assert.ok(
      contrast(probe.edge, paper) >= 1.1,
      `${t}：分隔线 ${probe.edge} 在纸上只有 ${f(contrast(probe.edge, paper))}:1（会像掉了块）`
    )
    assert.ok(
      contrast(probe.edgeStrong, paper) >= 1.25,
      `${t}：引用色条 ${probe.edgeStrong} 在纸上只有 ${f(contrast(probe.edgeStrong, paper))}:1`
    )
  }
  console.log('面/纸对比度 ' + JSON.stringify(seen))
})
