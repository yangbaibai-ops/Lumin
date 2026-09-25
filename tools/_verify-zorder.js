'use strict'
// ─── 验收：浮层叠放顺序（z-index 令牌真的到了 DOM，顺序也真的成立）────────────────
//
// 审计 §8 P2 的现场：`z-index` 散成 17 处模板字面量 + 5 处 CSS 字面量，谁压谁只能靠 grep。
// 上一轮把它们收进 `theme.css` 的 `:root`（`--z-*`），`tests/zIndexStack.test.mjs` 守住
// "没有字面量 + 顺序递增"这两条**静态**不变量；这条套件补**运行时**那一半：
// 令牌真的被浏览器解析成数字了吗？四个真实浮层的计算值是不是就是文档里写的那些？
//
// 为什么值得单独一条：静态检查只能证明"我们没写字面量"，证明不了"写进去的 var() 在模板里真的生效"
//（Tailwind 的任意值类名一旦拼错，类名会静静地不生成任何规则，浮层就掉回 auto）。
const { connect, settle, sleep, openDocWith, waitEditor, Reporter, fatal } = require('./lib/harness')

/** 文档里的顺序表（与 theme.css 的 :root 块一致） */
const STACK = {
  '--z-grip': 20,
  '--z-chip': 30,
  '--z-dialog': 70,
  '--z-tooltip': 90,
  '--z-popover': 100,
  '--z-page': 120,
  '--z-search': 140,
  '--z-modal': 150,
  '--z-modal-sub': 151,
  '--z-critical': 160,
  '--z-critical-sub': 161,
  '--z-editor-menu': 170,
  '--z-editor-menu-sub': 171,
  '--z-tooltip-global': 9999
}

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('浮层叠放顺序（z-index 令牌 → 计算样式）')

  // ── Z1 令牌本身：:root 上的自定义属性取得到，且与文档表一致 ──
  const tokens = JSON.parse(
    await ev(`(() => {
      const cs = getComputedStyle(document.documentElement)
      const out = {}
      for (const name of ${JSON.stringify(Object.keys(STACK))}) {
        out[name] = cs.getPropertyValue(name).trim()
      }
      return JSON.stringify(out)
    })()`)
  )
  const wrong = Object.entries(STACK).filter(([k, v]) => String(v) !== tokens[k])
  report.note('tokens ' + JSON.stringify(tokens))
  report.check(
    'Z1 :root 上的 --z-* 都能取到，且值等于文档里的顺序表',
    wrong.length === 0,
    `不一致：${JSON.stringify(wrong)}`
  )

  // ── Z2 CSS/模板里用令牌的那一类（侧栏宽度手柄 = 20；它一直在，不依赖"侧栏是不是收起"）──
  const handle = await ev(`(() => {
    const el = document.querySelector('[data-sidebar-resize]')
    return el ? getComputedStyle(el).zIndex : null
  })()`)
  report.check(
    'Z2 侧栏宽度手柄的计算 z-index = 20（--z-grip 生效）',
    handle === '20',
    String(handle)
  )

  // ── Z3~Z6：四个真实浮层 ──
  const settings = await ev(`(async () => {
    window.__L.ui().openSettings()
    for (let i = 0; i < 40 && !document.querySelector('.settings-page'); i++) await new Promise((r) => setTimeout(r, 100))
    const el = document.querySelector('.settings-page')
    return el ? getComputedStyle(el).zIndex : null
  })()`)
  report.check('Z3 设置整页的计算 z-index = 120（--z-page）', settings === '120', String(settings))
  await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)

  const search = await ev(`(async () => {
    window.__L.ui().openGlobalSearch()
    for (let i = 0; i < 40 && !document.querySelector('[role="dialog"][aria-modal="true"]'); i++) await new Promise((r) => setTimeout(r, 100))
    // 全局搜索那个 fixed 遮罩层：它是 z-[var(--z-search)] 的直接承载者
    const el = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.className.includes('z-[var(--z-search)]'))
    return el ? getComputedStyle(el).zIndex : null
  })()`)
  report.check('Z4 全局搜索面板的计算 z-index = 140（--z-search）', search === '140', String(search))
  await ev(`(() => { window.__L.ui().closeGlobalSearch(); return 'ok' })()`)

  const modal = await ev(`(() => {
    const ui = window.__L.ui()
    ui.confirm({ title: 'z-order probe', body: 'probe' })
    return null
  })()`)
  await sleep(400)
  const modalZ = await ev(`(() => {
    const el = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.className.includes('z-[var(--z-modal)]'))
    return el ? getComputedStyle(el).zIndex : null
  })()`)
  report.check('Z5 确认框（ModalHost）的计算 z-index = 150（--z-modal）', modalZ === '150', String(modalZ))
  await ev(`(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(false); return 'ok' })()`)
  await sleep(200)

  await openDocWith(app, '# z-order\n', 'zorder.md')
  await waitEditor(ev)
  const history = await ev(`(async () => {
    await window.__L.ui().openLocalHistory(window.__L.files().current?.path ?? 'C:/tmp/zorder.md')
    for (let i = 0; i < 40 && !document.querySelector('.local-history'); i++) await new Promise((r) => setTimeout(r, 100))
    // 本地历史浮层的根：带 --z-dialog 类名的那个（没有语义类，按类名找）
    const el = [...document.querySelectorAll('div')].find((d) => typeof d.className === 'string' && d.className.includes('z-[var(--z-dialog)]'))
    return el ? getComputedStyle(el).zIndex : null
  })()`)
  report.check('Z6 本地历史浮层的计算 z-index = 70（--z-dialog）', history === '70', String(history))
  await ev(`(() => { window.__L.ui().closeLocalHistory(); return 'ok' })()`)

  // ── Z7 顺序：把量到的四个值按文档顺序比一遍 ──
  const measured = { dialog: Number(history), page: Number(settings), search: Number(search), modal: Number(modalZ) }
  report.note('measured ' + JSON.stringify(measured))
  report.check(
    'Z7 实测顺序：本地历史(70) < 设置整页(120) < 全局搜索(140) < 确认框(150)',
    measured.dialog < measured.page &&
      measured.page < measured.search &&
      measured.search < measured.modal,
    JSON.stringify(measured)
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
