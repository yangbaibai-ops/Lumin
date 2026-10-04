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
const {
  connect,
  settle,
  sleep,
  openDocWith,
  pressKey,
  ensureFocus,
  Reporter,
  fatal
} = require('./lib/harness')
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
  /**
   * 侧栏「文件 / 大纲」页签（报告 §5.2 P1-5）。
   *
   * ⚠️ 这条以前量错了控件：断言写的是 aside .seg .seg-btn，而那其实是**文件树里的**
   * 树/列表分段控件（SegmentedControl.vue）—— 顶部页签当时是裸 button 元素，
   * 既没有 role=tablist/tab 也没有 aria-selected，却在报告里显示"已覆盖"。
   * 现在两处各量一次：页签按 ARIA tabs 口径，分段控件照旧。
   * （注意：这里不许出现反引号 —— 整段是模板字符串，反引号会当场截断它。）
   */
  const tabs = [...document.querySelectorAll('[data-sidebar-tablist] [role="tab"]')]
  const tablist = document.querySelector('[data-sidebar-tablist]')
  const panels = [...document.querySelectorAll('[role="tabpanel"]')]
  return {
    buttonCount: buttons.length,
    naked,
    lang: root.getAttribute('lang'),
    theme: [...root.classList].filter((c) => c.startsWith('theme-')),
    segPressed: segBtns.map((b) => b.getAttribute('aria-selected')),
    segLabels: segBtns.map((b) => (b.getAttribute('aria-label') || '').trim()),
    tablistRole: tablist ? tablist.getAttribute('role') : null,
    tabCount: tabs.length,
    tabSelected: tabs.map((b) => b.getAttribute('aria-selected')),
    tabIndexes: tabs.map((b) => b.getAttribute('tabindex')),
    tabControls: tabs.map((b) => b.getAttribute('aria-controls')),
    panelIds: panels.map((p) => p.id),
    panelLabelledBy: panels.map((p) => p.getAttribute('aria-labelledby')),
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
    '文件树里的树/列表分段控件：每个段都有名且 aria-selected 齐全',
    m.segLabels.length === 2 && m.segLabels.every(Boolean) && m.segPressed.every((v) => v === 'true' || v === 'false'),
    JSON.stringify({ labels: m.segLabels, selected: m.segPressed })
  )
  /**
   * 侧栏顶部页签（报告 §5.2 P1-5）：role=tablist → role=tab + aria-selected + roving tabindex，
   * 并且每个 tab 都指向真实存在的 tabpanel（aria-controls ↔ id ↔ aria-labelledby 闭环）。
   * 这条以前量的是上面那个分段控件，页签本身零覆盖。
   */
  report.check(
    '侧栏页签有 tabs 语义：tablist/tab/aria-selected/roving tabindex',
    m.tablistRole === 'tablist' &&
      m.tabCount === 2 &&
      m.tabSelected.filter((v) => v === 'true').length === 1 &&
      m.tabSelected.every((v) => v === 'true' || v === 'false') &&
      m.tabIndexes.filter((v) => v === '0').length === 1 &&
      m.tabIndexes.every((v) => v === '0' || v === '-1'),
    JSON.stringify({
      role: m.tablistRole,
      count: m.tabCount,
      selected: m.tabSelected,
      tabindex: m.tabIndexes
    })
  )
  report.check(
    '侧栏页签指向的 tabpanel 存在且回指页签（aria-controls ↔ id ↔ aria-labelledby）',
    m.tabControls.every((id) => m.panelIds.includes(id)) &&
      m.tabControls.every((id) => m.panelLabelledBy.some((lb) => lb === id.replace('panel', 'tab'))),
    JSON.stringify({ controls: m.tabControls, panels: m.panelIds, labelledBy: m.panelLabelledBy })
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

  // ── 文件树：行的键盘动作（审计 §8「重命名 / 删除只能鼠标」）─────────────────
  // 判据：焦点落在某一行上时，F2 进就地重命名、Esc 退出；Shift+F10 唤出上下文菜单，
  // 菜单有名字、↑↓ 有键盘高亮、Esc 关闭后焦点**回到那一行**（否则键盘用户掉到 body）。
  const focusRow = `(() => {
    const row = [...document.querySelectorAll('[data-tree-row]')].find((r) =>
      (r.dataset.treePath || '').endsWith('a.md')
    )
    if (!row) return 'no-row'
    row.focus()
    return document.activeElement === row ? 'ok' : 'no-focus'
  })()`
  const rowFocused = await ev(focusRow)
  report.check('tree-row-focusable', rowFocused === 'ok', String(rowFocused))

  // 下面这一段要**真实按键**（F2 / Shift+F10 / Delete / 方向键）：先把焦点抢回来。
  // 窗口不在前台时 CDP 注入的按键会丢（清单 §10 的 flaky 表），拿不到就如实 SKIP。
  if (!(await ensureFocus(app))) {
    report.skip('文件树/分隔条键盘段', '被测窗口拿不到 OS 焦点（真实按键会丢）')
    return report.finish()
  }

  await pressKey(app.send, { key: 'F2', code: 'F2', vk: 113 })
  await sleep(400)
  const renaming = JSON.parse(
    await ev(`(() => {
      const input = document.querySelector('[data-tree-row] input')
      return JSON.stringify({
        hasInput: !!input,
        focused: !!input && document.activeElement === input,
        value: input ? input.value : null,
        selected: input ? input.selectionEnd : null
      })
    })()`)
  )
  report.check(
    'tree-F2-starts-rename',
    renaming.hasInput && renaming.focused && renaming.value === 'a.md',
    JSON.stringify(renaming)
  )
  await pressKey(app.send, { key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(350)
  const renameCancelled = await ev(`!document.querySelector('[data-tree-row] input')`)
  report.check('tree-Esc-cancels-rename', renameCancelled === true, String(renameCancelled))

  // Shift+F10：唤出本行的菜单（key=ContextMenu 那条路走同一个 openMenuAt）
  await ev(focusRow)
  await pressKey(app.send, { key: 'F10', code: 'F10', vk: 121, modifiers: 8 })
  await sleep(500)
  const menu = JSON.parse(
    await ev(`(() => {
      const panel = document.querySelector('[role="menu"]')
      if (!panel) return JSON.stringify({ open: false })
      const items = [...panel.querySelectorAll('[role="menuitem"]')]
      return JSON.stringify({
        open: true,
        label: panel.getAttribute('aria-label') || '',
        count: items.length,
        tabbable: items.filter((el) => el.getAttribute('tabindex') !== '-1').length,
        focusedPanel: document.activeElement === panel
      })
    })()`)
  )
  report.check(
    'tree-ShiftF10-opens-labelled-menu',
    menu.open === true &&
      menu.count >= 3 &&
      menu.label.includes('a.md') &&
      menu.tabbable === 0 &&
      menu.focusedPanel === true,
    JSON.stringify(menu)
  )

  // ↑↓ 键盘高亮：默认没有高亮，第一次 ↓ 落到第一项，再 ↓ 落到第二项。
  // ⚠️ 判据必须按**类名分词**比对：菜单项本来就带 `hover:bg-panel-2`，
  // 用 `className.includes('bg-panel-2')` 会把它算成高亮（第一版就是这么假红的）。
  const LIT = `(() => {
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
    const lit = items
      .map((el, i) => (el.className.split(/\\s+/).includes('bg-panel-2') ? i : -1))
      .filter((i) => i >= 0)
    return JSON.stringify({ lit, labels: items.map((el) => el.textContent.trim()) })
  })()`
  await pressKey(app.send, { key: 'ArrowDown', code: 'ArrowDown', vk: 40 })
  await sleep(250)
  const highlighted = JSON.parse(await ev(LIT))
  await pressKey(app.send, { key: 'ArrowDown', code: 'ArrowDown', vk: 40 })
  await sleep(250)
  const moved = JSON.parse(await ev(LIT))
  report.check(
    'tree-menu-arrowdown-highlights',
    highlighted.lit.length === 1 && highlighted.lit[0] === 0 && moved.lit.length === 1 && moved.lit[0] === 1,
    JSON.stringify({ first: highlighted, second: moved })
  )

  // Esc：关菜单并把焦点还给那一行
  await pressKey(app.send, { key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(350)
  const restored = JSON.parse(
    await ev(`(() => {
      const row = [...document.querySelectorAll('[data-tree-row]')].find((r) =>
        (r.dataset.treePath || '').endsWith('a.md')
      )
      return JSON.stringify({
        menuGone: !document.querySelector('[role="menu"]'),
        focusBack: !!row && document.activeElement === row
      })
    })()`)
  )
  report.check(
    'tree-menu-esc-closes-and-restores-focus',
    restored.menuGone === true && restored.focusBack === true,
    JSON.stringify(restored)
  )

  // Delete：走确认框（这里只开、只关，不真的删掉夹具）
  await pressKey(app.send, { key: 'Delete', code: 'Delete', vk: 46 })
  await sleep(500)
  const delDialog = JSON.parse(
    await ev(`(() => {
      const el = [...document.querySelectorAll('[aria-modal="true"]')].pop()
      return JSON.stringify({ dialog: !!el, text: el ? el.textContent.trim().slice(0, 40) : '' })
    })()`)
  )
  await ev(`(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(false); return 'ok' })()`)
  await sleep(300)
  report.check('tree-Delete-asks-confirmation', delDialog.dialog === true, JSON.stringify(delDialog))

  // ── 分隔条：role="separator" + 方向键调宽（此前是纯鼠标）────────────────────
  const SEP = `(() => {
    const side = document.querySelector('[data-sidebar-resize]')
    const outline = document.querySelector('[data-outline-resize]')
    const desc = (el) =>
      el
        ? {
            role: el.getAttribute('role'),
            orientation: el.getAttribute('aria-orientation'),
            label: (el.getAttribute('aria-label') || '').trim(),
            now: Number(el.getAttribute('aria-valuenow')),
            min: Number(el.getAttribute('aria-valuemin')),
            max: Number(el.getAttribute('aria-valuemax')),
            tab: el.getAttribute('tabindex')
          }
        : null
    return JSON.stringify({ sidebar: desc(side), outline: desc(outline) })
  })()`
  const seps = JSON.parse(await ev(SEP))
  report.check(
    'separators-declare-role-and-range',
    seps.sidebar?.role === 'separator' &&
      seps.sidebar.orientation === 'vertical' &&
      !!seps.sidebar.label &&
      seps.sidebar.tab === '0' &&
      seps.sidebar.now >= seps.sidebar.min &&
      seps.sidebar.now <= seps.sidebar.max,
    JSON.stringify(seps.sidebar)
  )
  await ev(`(() => { document.querySelector('[data-sidebar-resize]').focus(); return 'ok' })()`)
  const widthBefore = Number(await ev(`window.__L.settings().sidebarWidth`))
  await pressKey(app.send, { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
  await sleep(400)
  const widthAfter = Number(await ev(`window.__L.settings().sidebarWidth`))
  report.check(
    'sidebar-resize-arrow-keys',
    widthAfter === widthBefore + 16,
    JSON.stringify({ before: widthBefore, after: widthAfter })
  )
  // Home/End 到边界（同时验证钳位与 aria-valuenow 同步）
  await pressKey(app.send, { key: 'End', code: 'End', vk: 35 })
  await sleep(400)
  const clamped = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector('[data-sidebar-resize]')
      return JSON.stringify({ width: window.__L.settings().sidebarWidth, now: Number(el.getAttribute('aria-valuenow')) })
    })()`)
  )
  report.check(
    'sidebar-resize-clamped-and-reported',
    clamped.width === 420 && clamped.now === 420,
    JSON.stringify(clamped)
  )
  await pressKey(app.send, { key: 'Home', code: 'Home', vk: 36 })
  await sleep(400)
  report.check(
    'sidebar-resize-home-min',
    Number(await ev(`window.__L.settings().sidebarWidth`)) === 200,
    String(await ev(`window.__L.settings().sidebarWidth`))
  )

  // ── 专注模式：进去之后必须还有一个**看得见、够得着**的退出出口（报告 §5.2 P0-2）──
  // 背景：专注模式会把整条快捷工具栏 `v-if` 卸载，而专注开关就在那条工具栏里 —— 原来的
  // 注释声称"状态栏「专注」也能切回来"，而状态栏里并没有这个入口，鼠标用户等于进去出不来。
  await ev(`(() => { window.__L.ui().focusMode = true; return 'ok' })()`)
  await sleep(500)
  const fx = JSON.parse(
    await ev(`(() => {
      const btn = document.querySelector('[data-focus-exit]')
      if (!btn) return JSON.stringify({ missing: true })
      const cs = getComputedStyle(btn)
      const r = btn.getBoundingClientRect()
      return JSON.stringify({
        missing: false,
        visible: cs.visibility === 'visible' && cs.display !== 'none',
        opacity: Number(cs.opacity),
        w: Math.round(r.width),
        h: Math.round(r.height),
        label: (btn.getAttribute('aria-label') || '').trim()
      })
    })()`)
  )
  report.check(
    'focus-mode-keeps-a-visible-exit',
    fx.missing === false && fx.visible === true && fx.opacity > 0.2 && fx.w > 40 && fx.h > 16,
    JSON.stringify(fx) + ' —— 专注模式必须留一枚可见的退出胶囊（工具栏里的那枚已随工具栏一起卸载）'
  )
  report.check(
    'focus-exit-has-accessible-name',
    typeof fx.label === 'string' && fx.label.length > 0,
    JSON.stringify({ label: fx.label })
  )
  await ev(`(() => { document.querySelector('[data-focus-exit]').click(); return 'ok' })()`)
  await sleep(400)
  report.check(
    'focus-exit-button-leaves-focus-mode',
    (await ev(`String(window.__L.ui().focusMode)`)) === 'false' &&
      (await ev(`String(!!document.querySelector('[data-focus-exit]'))`)) === 'false',
    '点了退出胶囊之后应回到普通视图，胶囊本身也应消失'
  )

  // ── 状态栏 `⋯` 浮层的菜单语义（报告 §5.2 P1-2）：role=menu + menuitem + Esc 关闭并还焦点 ──
  await ev(`(() => { document.querySelector('[data-status-more]').click(); return 'ok' })()`)
  await sleep(400)
  const statusMenu = JSON.parse(
    await ev(`(() => {
      const box = document.querySelector('[data-status-more-menu]')
      if (!box) return JSON.stringify({ missing: true })
      const items = [...box.querySelectorAll('[role="menuitem"]')]
      return JSON.stringify({
        missing: false,
        role: box.getAttribute('role'),
        label: (box.getAttribute('aria-label') || '').trim(),
        items: items.length,
        focusedIsItem: items.includes(document.activeElement)
      })
    })()`)
  )
  report.check(
    'status-more-is-a-menu-with-items',
    statusMenu.missing === false && statusMenu.role === 'menu' && statusMenu.items >= 5 && !!statusMenu.label,
    JSON.stringify(menu)
  )
  report.check(
    'status-more-opens-on-first-item',
    statusMenu.focusedIsItem === true,
    JSON.stringify({ focusedIsItem: statusMenu.focusedIsItem })
  )
  // Esc：关掉浮层并把焦点还给 `⋯` 触发按钮（ARIA menu 的标准行为）
  await ev(`(() => {
    const box = document.querySelector('[data-status-more-menu]')
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'ok'
  })()`)
  await sleep(400)
  report.check(
    'status-more-escape-closes-and-refocuses',
    (await ev(`String(!!document.querySelector('[data-status-more-menu]'))`)) === 'false' &&
      (await ev(
        `String(document.activeElement === document.querySelector('[data-status-more]'))`
      )) === 'true',
    'Esc 之后浮层应关闭，且焦点回到 `⋯` 按钮'
  )

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
