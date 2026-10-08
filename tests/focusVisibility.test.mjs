// 焦点可见性守卫（清单 §8 P1「全仓 `outline: none` 15 处，却只有 4 条 `:focus-visible`」）。
//
// 为什么值得一条专门的测试：`outline: none` 是**静默的**可访问性回归 —— 视觉上什么都不会变，
// 只有键盘用户会发现"我不知道焦点在哪"。而它又特别容易被顺手加上（去掉浏览器默认描边是常见需求），
// 所以口径必须是"每一处 `outline: none` 都要能说出它的焦点环在哪"，而不是靠人记。
//
// 判定：
//   ① 该选择器自己就是焦点规则（`:focus` / `:focus-visible` / `:focus-within`），或
//   ② 在 ALLOW 里登记了"替代焦点提示"，且写清理由，或
//   ③ 断言失败 —— 请补焦点环，而不是往 ALLOW 里塞。
// ALLOW 是**自清理**的：选择器不存在了（或已经自己有了焦点规则）就必须从表里删掉，否则红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ASSETS = path.join(ROOT, 'src', 'renderer', 'src', 'assets')

/**
 * 允许"去掉默认描边但不额外画环"的地方，每条都要有理由。
 * 判据是**用户能不能看见焦点**，不是"有没有写 CSS"。
 */
const ALLOW = new Map([
  // 以下都是"打字面"：光标本身就是焦点指示，且加外框会破坏所见即所得
  ['editor.css|.md-block .md-raw', '源码/原始块打字面：插入符即焦点指示'],
  ['editor.css|.md-block-inner', '块内打字面：插入符即焦点指示'],
  ['components.css|.source-editor', '分屏源码栏（CodeMirror）：`.cm-focused` 有自己的样式'],
  ['overlays.css|.mermaid-source-input', 'mermaid 源码输入框：插入符即焦点指示'],
  [
    'overlays.css|.md-math-editor__src',
    '公式源码书写面（第九轮用户口径「尽量不要出现书写区域的边框」）：焦点提示落在**容器**的 ' +
      '`.md-math-editor:focus-within`（细边框加深一档）＋插入符本身'
  ],
  [
    'sidebar.css|.tree-rename-input',
    '就地重命名输入框：行上有 `.is-renaming` 底色（用户明确要求不要边框）'
  ],
  // 以下有"父层 focus-within / 语义高亮"提供的可见焦点提示
  ['base.css|.settings-search__input', '父层 `.settings-search:focus-within` 画了边框'],
  ['chrome.css|.ProseMirror-selectednode', '节点选中态样式（不是焦点态，也不可聚焦）'],
  ['overlays.css|.ecm-panel', '编辑器右键菜单面板（role=menu）：条目高亮即焦点提示']
])

/**
 * 一个选择器自己是不是焦点规则。
 * 除标准伪类外，还认 CodeMirror 的焦点**类** `.cm-focused`（编辑器焦点态是它自己加的类，
 * 不是伪类；环由 CM 主题给出。
 */
const isFocusSelector = (sel) => /:(focus|focus-visible|focus-within)|\.cm-focused\b/.test(sel)

/** 同文件里有没有"以该选择器开头 + 焦点伪类"的规则 */
function hasFocusRule(text, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${esc}[^{},]*(:focus|:focus-visible|:focus-within)`).test(text)
}

function outlineNoneRules() {
  const out = []
  for (const f of fs.readdirSync(ASSETS).filter((x) => x.endsWith('.css'))) {
    const text = fs.readFileSync(path.join(ASSETS, f), 'utf-8')
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/outline\s*:\s*none/.test(m[2])) continue
      for (const raw of m[1].trim().split(',')) {
        const sel = raw.trim().split('\n').pop().trim()
        if (sel) out.push({ file: f, sel, text })
      }
    }
  }
  return out
}

test('每一处 outline: none 都要能说出焦点环在哪（否则键盘用户看不见焦点）', () => {
  const rules = outlineNoneRules()
  assert.ok(rules.length >= 10, `只扫到 ${rules.length} 条 outline:none，扫描口径可能不对`)
  const unexplained = rules
    .filter((r) => !isFocusSelector(r.sel) && !hasFocusRule(r.text, r.sel))
    .filter((r) => !ALLOW.has(`${r.file}|${r.sel}`))
    .map((r) => `${r.file} → ${r.sel}`)
  assert.deepEqual(
    unexplained,
    [],
    `这些地方去掉了默认描边却没有焦点提示，请补 :focus-visible，或在 ALLOW 里写明理由：${unexplained.join('；')}`
  )
})

test('ALLOW 是自清理的：已经不成立（或选择器已消失）的登记必须删掉', () => {
  const rules = outlineNoneRules()
  const live = new Set(rules.map((r) => `${r.file}|${r.sel}`))
  const stale = []
  for (const [key, why] of ALLOW) {
    if (!live.has(key)) {
      // 选择器没了：要么删登记，要么它已经补上了焦点环
      stale.push(`${key}（登记理由：${why}）`)
      continue
    }
    const r = rules.find((x) => `${x.file}|${x.sel}` === key)
    if (r && !isFocusSelector(r.sel) && !hasFocusRule(r.text, r.sel)) continue
    stale.push(`${key}（已经自己有了焦点规则，登记成多余）`)
  }
  assert.deepEqual(stale, [], `ALLOW 里这些条目该删了：${stale.join('；')}`)
})

test('全局搜索的输入行必须有 focus-within 焦点环（它的 input 是 outline-none）', () => {
  /**
   * Tailwind 的 `outline-none` 写在 .vue 里，扫不到上面的 CSS 规则 —— 于是单列一条：
   * 该输入框靠**所在行**的 `focus-within:border-accent` 给出可见焦点提示。
   */
  const vue = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'components', 'GlobalSearch.vue'),
    'utf-8'
  )
  assert.ok(vue.includes('outline-none'), '输入框的 outline-none 被移除了？那这条守卫可以简化')
  assert.match(
    vue,
    /focus-within:border-accent/,
    'GlobalSearch 的输入框去了默认描边却没有 focus-within 焦点环（键盘用户看不见焦点）'
  )
})

test('滑杆（.range）必须显式写焦点环：它是层外规则，base 的兜底压不住', () => {
  const css = fs.readFileSync(path.join(ASSETS, 'components.css'), 'utf-8')
  assert.match(
    css,
    /\.range:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/,
    '.range 缺 :focus-visible 焦点环（设置页 4 个滑杆键盘聚焦会完全看不见）'
  )
})
