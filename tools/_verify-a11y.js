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

  // ── 侧栏底部那条工具带（搜索 + 树/列表）：默认隐藏、悬停侧栏才出现 ────────────
  // 用户口径：平时收起来，鼠标放到侧边栏上才显示。
  // 它同时是一条**可访问性**问题：`visibility:hidden` 的元素不可聚焦，如果只有 `:hover`
  // 一个显示条件，纯键盘用户就永远够不到搜索与视图切换 —— 所以这里连键盘那条路一起验。
  const TOOLS = `(() => {
    const el = document.querySelector('[data-sidebar-filetools]')
    if (!el) return JSON.stringify({ missing: true })
    const cs = getComputedStyle(el)
    const btn = el.querySelector('[data-sidebar-search-toggle]')
    const r = btn ? btn.getBoundingClientRect() : null
    return JSON.stringify({
      visibility: cs.visibility,
      opacity: Number(cs.opacity),
      height: Math.round(el.getBoundingClientRect().height),
      toggleRect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null
    })
  })()`

  // 先把指针挪到窗口右上角（远离侧栏），确保量到的是「没有悬停」的初始态
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 900,
    y: 400,
    button: 'none',
    buttons: 0
  })
  await ev(`(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'ok' })()`)
  await sleep(400)
  const hidden = JSON.parse(await ev(TOOLS))
  report.check(
    'sidebar-tools-hidden-by-default',
    hidden.visibility === 'hidden' && hidden.opacity === 0 && hidden.height > 0,
    JSON.stringify(hidden)
  )

  // 真实指针移到侧栏上 → 显示（且仍然占位：高度不变 ⇒ 上面的树不会跳）
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 100,
    y: 300,
    button: 'none',
    buttons: 0
  })
  await sleep(400)
  const hovered = JSON.parse(await ev(TOOLS))
  report.check(
    'sidebar-tools-visible-on-hover',
    hovered.visibility === 'visible' && hovered.opacity === 1 && hovered.height === hidden.height,
    JSON.stringify(hovered)
  )

  // 键盘路径：指针移开（隐藏）后把焦点放进侧栏（树行）→ 工具带必须重新可见，
  // 否则 `visibility:hidden` 让它既不可见也不可聚焦 = 纯键盘用户拿不到这两个控件。
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 900,
    y: 400,
    button: 'none',
    buttons: 0
  })
  await sleep(400)
  const left = JSON.parse(await ev(TOOLS))
  const focused = await ev(`(() => {
    const row = document.querySelector('aside [data-tree-root] [role="treeitem"], aside .tree-label')
    if (!row) return 'no-row'
    const el = row.closest('[tabindex]') || row
    el.focus?.()
    return document.activeElement === el || document.activeElement?.closest('aside') ? 'ok' : 'no-focus'
  })()`)
  await sleep(350)
  const viaKeyboard = JSON.parse(await ev(TOOLS))
  report.check(
    'sidebar-tools-visible-when-sidebar-focused',
    left.visibility === 'hidden' && focused === 'ok' && viaKeyboard.visibility === 'visible',
    JSON.stringify({ afterLeave: left.visibility, focused, viaKeyboard: viaKeyboard.visibility })
  )

  // ── 开关：必须有 role="switch" + aria-checked（审计 §8：10 处手写里 7 处两者都缺）──────
  // ⚠️ 开关全在设置页里，而设置页是 `v-if` 的整页浮层 —— 不先打开它，量到的就是 0 个。
  // 打开后**轮询等它挂载**（固定 sleep 在这类大组件上不稳：第一版就是等 600ms 后量到 0 个假红）。
  // ⚠️ 设置页一次只渲染**当前页签**（`v-if="tabShown(...)"`），所以分两个页签量：
  // 通用 7 个开关 + 编辑器 2 个（同步滚动 / 代码块行号），合起来才是全部 9 个。
  const measureSwitches = async (section) => {
    await ev(`(() => { window.__L.ui().openSettings('${section}'); return 'ok' })()`)
    for (let i = 0; i < 20; i++) {
      await sleep(150)
      if (await ev(`!!document.querySelector('[data-settings-page] .switch')`)) break
    }
    return JSON.parse(
      await ev(`(() => {
        const all = [...document.querySelectorAll('.switch')]
        const real = all.filter((el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'switch')
        const missingRole = all.filter((el) => el.getAttribute('role') !== 'switch' && el.tagName === 'BUTTON')
        const missingChecked = real.filter((el) => !['true', 'false'].includes(el.getAttribute('aria-checked') || ''))
        const missingName = real.filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('title')))
        return JSON.stringify({
          section: '${section}',
          total: all.length,
          real: real.length,
          missingRole: missingRole.length,
          missingChecked: missingChecked.length,
          missingName: missingName.length,
          sample: real.slice(0, 3).map((el) => el.getAttribute('aria-checked'))
        })
      })()`)
    )
  }
  const general = await measureSwitches('general')
  const editorTab = await measureSwitches('editor')
  await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)
  await sleep(300)
  const switches = {
    general,
    editor: editorTab,
    realCount: general.real + editorTab.real,
    missingRole: general.missingRole + editorTab.missingRole,
    missingChecked: general.missingChecked + editorTab.missingChecked,
    missingName: general.missingName + editorTab.missingName
  }
  report.check(
    'switches-declare-role-and-state',
    switches.realCount >= 9 &&
      switches.missingRole === 0 &&
      switches.missingChecked === 0 &&
      switches.missingName === 0,
    JSON.stringify(switches)
  )

  // ── 浮层：三个都要有 role="dialog" + aria-modal（读屏器才会说"弹出了对话框"）─────
  const overlay = async (openExpr, sel) => {
    await ev(openExpr)
    await sleep(400)
    const r = JSON.parse(
      await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)})
        if (!el) return JSON.stringify({ missing: true })
        return JSON.stringify({
          role: el.getAttribute('role'),
          modal: el.getAttribute('aria-modal'),
          label: !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))
        })
      })()`)
    )
    await ev(`(() => { window.__L.ui().closeGlobalSearch?.(); window.__L.ui().confirmState && window.__L.ui().resolveConfirm(false); window.__L.ui().localHistory.open = false; return 'ok' })()`)
    await sleep(300)
    return r
  }
  const gs = await overlay(
    `(() => { window.__L.ui().openGlobalSearch(); return 'ok' })()`,
    '[role="dialog"][aria-modal="true"]'
  )
  await ev(
    `(() => { window.__L.ui().confirm({ title: 'x', body: 'y' }); return 'ok' })()`
  )
  await sleep(400)
  const confirmDialog = JSON.parse(
    await ev(`(() => {
      const el = [...document.querySelectorAll('[aria-modal="true"]')].pop()
      return JSON.stringify({ role: el?.getAttribute('role') ?? null, label: !!(el?.getAttribute('aria-label')) })
    })()`)
  )
  await ev(`(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(false); return 'ok' })()`)
  await sleep(300)
  report.check(
    'overlays-declare-dialog-semantics',
    gs.role === 'dialog' && gs.modal === 'true' && gs.label === true && confirmDialog.role === 'dialog' && confirmDialog.label === true,
    JSON.stringify({ globalSearch: gs, confirm: confirmDialog })
  )

  // ── live region：状态栏保存态与通知带都必须可被播报 ──────────────────────────
  // 通知带是 `v-if="active"` 的（没有通知时整块不存在），所以先造一条通知再看
  await ev(
    `(() => { window.__L.notifications().notify({ level: 'info', title: 'a11y probe' }); return 'ok' })()`
  )
  await sleep(600)
  const live = JSON.parse(
    await ev(`(() => {
      const liveEls = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')]
      return JSON.stringify({
        count: liveEls.length,
        hasStatusBar: !!document.querySelector('footer [aria-live], [aria-live="polite"]'),
        hasNotificationStrip: !!document.querySelector('[data-notification-center][role="status"]'),
        tags: liveEls.map((el) => el.getAttribute('aria-live') || el.getAttribute('role')).slice(0, 4)
      })
    })()`)
  )
  report.check(
    'has-live-regions',
    live.count >= 2 && live.hasNotificationStrip === true && live.hasStatusBar === true,
    JSON.stringify(live)
  )

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
