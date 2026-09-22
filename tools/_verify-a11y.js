'use strict'
// 验收：无障碍基线（自查报告 O5）
//
// 判据（都在真实页面上量）：
//   1. **icon-only 按钮必须有可访问名**：没有可见文字时，至少要有 `aria-label` 或 `title`
//      （本轮之前是靠人工零散补的：工具栏、清除按钮…这条把它变成断言）；
//   2. `aria-pressed` / `aria-expanded` 这类状态属性必须与真实状态一致（抽查分段控件与折叠三角）；
//   3. 页面语言与主题类必须在根元素上（读屏器与样式都靠它）。
//
// 跑法：node tools/run-suites.js --suite=_verify-a11y.js
const { connect, settle, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')
const os = require('os')
const path = require('path')
const fs = require('fs')

const MD = '# 无障碍\n\n正文一段。\n'

/** 扫描全窗口的可交互元素，返回"没有可访问名的 icon-only 按钮"清单 */
const SCAN = `JSON.stringify((() => {
  const nameOf = (el) => {
    const label = (el.getAttribute('aria-label') || '').trim()
    const title = (el.getAttribute('title') || '').trim()
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    return { label, title, text }
  }
  const root = document.documentElement
  const buttons = [...document.querySelectorAll('button, [role="button"]')]
  const naked = []
  for (const b of buttons) {
    const n = nameOf(b)
    if (n.text) continue                       // 有可见文字就够了
    if (n.label || n.title) continue           // 有 aria-label 或 title 也行
    const r = b.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue // 不可见的（display:none）跳过
    naked.push({ cls: String(b.className).slice(0, 60), html: b.outerHTML.slice(0, 120) })
  }
  const seg = document.querySelector('aside .seg')
  const segBtns = seg ? [...seg.querySelectorAll('.seg-btn')] : []
  return {
    buttonCount: buttons.length,
    naked,
    lang: root.getAttribute('lang'),
    theme: [...root.classList].filter((c) => c.startsWith('theme-')),
    segPressed: segBtns.map((b) => b.getAttribute('aria-selected')),
    segLabels: segBtns.map((b) => (b.getAttribute('aria-label') || '').trim()),
    disclosure: (() => {
      const d = document.querySelector('[data-find-disclosure]')
      return d ? d.getAttribute('aria-expanded') : 'no-find-bar'
    })()
  }
})())`

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const report = new Reporter('无障碍基线')
  const { ev } = app
  await openDocWith(app, MD, 'a11y.md')
  await sleep(1200)
  // 打开一个工作区：侧栏的「树 / 列表」分段控件只在有工作区时才渲染，
  // 不建工作区这条断言就退化成"空数组也通过"（等于没测）。
  const ws = path.join(os.tmpdir(), 'lumin-a11y-ws')
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'a.md'), MD, 'utf-8')
  await ev(`(async () => { await window.__L.files().setRoot(${JSON.stringify(ws)}); return 'ok' })()`)
  await sleep(900)
  // 让工具栏/侧栏都在，覆盖面最大
  await ev(`(() => { const ui = window.__L.ui(); ui.sidebarVisible = true; ui.sidebarTab = 'files'; window.__L.settings().set('toolbarVisible', true); return 'ok' })()`)
  await sleep(600)

  const m = JSON.parse(await ev(SCAN))
  report.check(
    'icon-only 按钮都有可访问名（aria-label 或 title）',
    m.naked.length === 0,
    `扫了 ${m.buttonCount} 个按钮，缺名 ${m.naked.length} 个：${JSON.stringify(m.naked.slice(0, 6))}`
  )
  report.check('根元素有 lang', !!m.lang, String(m.lang))
  report.check('根元素有主题类', m.theme.length === 1, JSON.stringify(m.theme))
  report.check(
    '侧栏分段控件：每个段都有 aria-label 且 aria-selected 齐全',
    m.segLabels.length === 2 && m.segLabels.every(Boolean) && m.segPressed.every((v) => v === 'true' || v === 'false'),
    JSON.stringify({ labels: m.segLabels, selected: m.segPressed })
  )

  // 折叠三角的 aria-expanded 要跟真实状态一致（打开查找栏 → true）
  await ev(`(() => { const f = window.__L.store('find'); f.show(true); return 'ok' })()`)
  await sleep(500)
  const open = JSON.parse(await ev(SCAN))
  report.check('查找栏展开后 aria-expanded=true 且每段仍有名', open.disclosure === 'true', String(open.disclosure))
  report.check('打开查找栏后仍无缺名按钮', open.naked.length === 0, JSON.stringify(open.naked.slice(0, 6)))
  await ev(`(() => { window.__L.store('find').hide(); return 'ok' })()`)
  await sleep(300)

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
