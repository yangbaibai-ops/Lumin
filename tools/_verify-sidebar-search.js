'use strict'
// 验收：Ctrl+F 的**去向** —— 人在左侧栏里就搜文件名，否则照旧搜正文
//
// 用户口径：
//   第八轮：「当在侧边栏点击 ctrl+f 时，请进入侧边栏的搜索而不是文档的搜索和查找。」
//   第九轮（本条，§4.84）：「当在左侧侧边栏区域点击 ctrl+f 时，打开的是侧栏的搜索
//                        而不是当前文档内容的搜索。」——即"侧栏"要按**整个左侧栏**算，
//                        不再只算文件面板内部；"人在侧栏里"也包括**指针停在侧栏上**
//                        （点一下树行之间的空白并不会把焦点挪进面板：焦点还在编辑器里）。
//
// 分流实现：规则在 `src/renderer/src/lib/ctrlFRoute.ts`（纯函数，单测 `tests/ctrlFRoute.test.mjs`），
// 现场判定在 `composables/useAppActions.ts` 的 `ctrlFTargetNow()`，
// 消费端在 `FileTree.vue` 里对 `ui.sidebarSearchTick` 的 watch。
//
// 这条套件同时守着**两个方向**，因为只验一个方向的话，「把 Ctrl+F 整个改成侧栏搜索」
// 也能让断言全绿 —— 那等于把编辑器的查找功能弄丢了：
//   A. 焦点在文件树行 → 侧栏文件名搜索展开并拿到焦点，**正文查找栏不开**；
//   B. 焦点在编辑区   → 正文查找栏开，**侧栏搜索不开**；
//   C. 边界①：焦点在侧栏**页签**上 → 也算"在侧栏里"，走侧栏搜索（§4.84 放宽）；
//   D. 边界②：指针停在侧栏上而焦点在编辑区 → 走侧栏搜索（同上）；
//   E. 边界③：左栏显示**大纲** / 没有工作区 → 仍走正文查找（那时侧栏没有可用的搜索框）。
//
// 按键走**页面内合成 KeyboardEvent**（`window.dispatchEvent`），不用 CDP 真实按键注入：
// 合成事件同样会经过 keymap 服务的 window 捕获监听（`lib/keymap/service.ts`），
// 而真实按键要求被测窗口是 OS 前台 —— 用户自己的 Lumin 在前台时那批断言会假红
// （`tools/lib/harness.js` 的 bringToFront 注释里记着这个坑）。路由判定读的是
// `document.activeElement` / `aside:hover`，与事件从哪来无关，所以这条路径足够真实。
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  connect,
  settle,
  sleep,
  openDocWith,
  waitEditor,
  bringToFront,
  Reporter,
  fatal
} = require('./lib/harness')

/** 合成一次 Ctrl+F（keymap 服务只认带修饰键的组合） */
const CTRL_F = `(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true
  }))
  return 'ok'
})()`

/** 当前状态：两侧的搜索各自开没开、焦点在谁身上 */
const STATE = `(() => {
  const shell = document.querySelector('[data-sidebar-search]')
  const input = document.querySelector('.file-search__input')
  const active = document.activeElement
  const row = document.querySelector('[data-tree-row]')
  return JSON.stringify({
    sidebarOpen: !!shell && shell.className.includes('file-search--open'),
    sidebarFocused: !!input && active === input,
    findOpen: window.__L.store('find').open === true,
    findBarInDom: !!document.querySelector('[data-find-input]'),
    activeTag: active ? active.tagName : null,
    activeInFiles: !!active && typeof active.closest === 'function' && !!active.closest('[data-sidebar-files]'),
    rowFocusable: !!row
  })
})()`

/** 把焦点放到某个选择器上（不存在返回 false） */
const focusOn = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return false
  el.focus()
  return document.activeElement === el
})()`

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('Ctrl+F 去向：在侧栏文件面板里搜文件名，否则搜正文')

  // ── 夹具：一个真实工作区（文件树里得真有行才能把焦点放上去）──
  const dir = path.join(os.tmpdir(), 'lumin-sidebar-search-ws')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'alpha.md'), '# alpha\n\n正文\n', 'utf-8')
  fs.writeFileSync(path.join(dir, 'beta.md'), '# beta\n\n正文\n', 'utf-8')

  try {
    await ev(`(async () => {
      await window.__L.files().setRoot(${JSON.stringify(dir)})
      const ui = window.__L.ui()
      ui.sidebarVisible = true
      ui.sidebarTab = 'files'
      ui.sidebarFilesView = 'tree'
      window.__L.settings().set('outlineOnRight', false)
      window.__L.store('find').hide()
      return 'ok'
    })()`)
    await openDocWith(app, '# 标题\n\n正文\n', 'ctrl-f-routing.md')
    if (!(await waitEditor(ev))) throw new Error('编辑器未就绪')
    await sleep(1200)

    // ── A. 焦点在文件树行上 ──────────────────────────────────────────────
    await bringToFront(app)
    const rowFocused = await ev(focusOn('[data-tree-row]'))
    await sleep(350) // 让 `aside:focus-within` 把底部那条工具带显示出来（visibility 立刻翻转）
    report.note('焦点落到文件树行 ' + rowFocused)
    await ev(CTRL_F)
    await sleep(500)
    const a = JSON.parse(await ev(STATE))
    report.note('A ' + JSON.stringify(a))
    report.check(
      'ctrl-f-in-file-tree-opens-sidebar-search',
      a.sidebarOpen === true,
      `sidebarOpen=${a.sidebarOpen}（焦点在文件树行时 Ctrl+F 应展开侧栏的文件名搜索）`
    )
    report.check(
      'ctrl-f-in-file-tree-focuses-the-filter-input',
      a.sidebarFocused === true,
      `activeTag=${a.activeTag} / sidebarFocused=${a.sidebarFocused}（光标应直接落在输入框里，能接着打字）`
    )
    report.check(
      'ctrl-f-in-file-tree-does-not-open-document-find',
      a.findOpen === false && a.findBarInDom === false,
      `find.open=${a.findOpen} / 查找栏在 DOM 里=${a.findBarInDom}`
    )

    // 真打一个字：筛选真的生效（不只是「框开了」）
    await app.send('Input.insertText', { text: 'alp' })
    await sleep(500)
    const typed = JSON.parse(
      await ev(`(() => {
        const input = document.querySelector('.file-search__input')
        const rows = [...document.querySelectorAll('[data-tree-row]')].map((r) =>
          r.getAttribute('data-tree-path') || ''
        )
        return JSON.stringify({ value: input ? input.value : null, rows })
      })()`)
    )
    report.note('A-typed ' + JSON.stringify(typed))
    report.check(
      'sidebar-search-actually-filters',
      typed.value === 'alp' &&
        typed.rows.some((p) => p.endsWith('alpha.md')) &&
        !typed.rows.some((p) => p.endsWith('beta.md')),
      JSON.stringify(typed)
    )

    // 再按一次 Ctrl+F：仍然留在侧栏搜索（不该被正文查找栏抢走）
    await ev(CTRL_F)
    await sleep(400)
    const again = JSON.parse(await ev(STATE))
    report.check(
      'ctrl-f-again-still-sidebar-search',
      again.sidebarOpen === true && again.sidebarFocused === true && again.findOpen === false,
      JSON.stringify(again)
    )

    // 清掉筛选条件（否则后面切 tab 时筛选还在）
    await ev(
      `(() => { const i = document.querySelector('.file-search__input'); if (i) i.value = ''; const ev2 = new Event('input', { bubbles: true }); if (i) i.dispatchEvent(ev2); return 'ok' })()`
    )
    await sleep(300)

    // ── B. 焦点在编辑区（正文）───────────────────────────────────────────
    await bringToFront(app)
    const edFocused = await ev(`(() => {
      const ed = window.__L.ed()
      if (!ed) return false
      ed.commands.focus()
      return document.activeElement?.classList?.contains('ProseMirror') === true
    })()`)
    await sleep(350)
    report.note('焦点落到编辑区 ' + edFocused)
    await ev(CTRL_F)
    await sleep(500)
    const b = JSON.parse(await ev(STATE))
    report.note('B ' + JSON.stringify(b))
    report.check(
      'ctrl-f-in-editor-opens-document-find',
      b.findOpen === true,
      `find.open=${b.findOpen}（焦点在正文里时 Ctrl+F 必须还是正文查找）`
    )
    report.check(
      'ctrl-f-in-editor-does-not-open-sidebar-search',
      b.sidebarOpen === false,
      `sidebarOpen=${b.sidebarOpen}`
    )
    await ev(`(() => { window.__L.store('find').hide(); return 'ok' })()`)
    await sleep(300)

    // ── C. 焦点在侧栏**页签**上 → §4.84 起也算"在侧栏里"，走侧栏搜索 ──────────
    // （旧口径把这里判成正文查找：判据是"焦点在 `[data-sidebar-files]` 内吗"，
    //   而页签在它外面。用户第九轮报的就是这一类 —— 侧栏里点一下再按 Ctrl+F 却开了正文查找。）
    await bringToFront(app)
    const headFocused = await ev(focusOn('[data-sidebar-tab="files"]'))
    await sleep(300)
    report.note('焦点落到侧栏页签 ' + headFocused)
    await ev(CTRL_F)
    await sleep(450)
    const c1 = JSON.parse(await ev(STATE))
    report.note('C1 ' + JSON.stringify(c1))
    report.check(
      'ctrl-f-on-sidebar-tab-opens-sidebar-search',
      headFocused === true && c1.sidebarOpen === true && c1.findOpen === false,
      `${JSON.stringify(c1)} / 焦点落在页签上=${headFocused}`
    )
    await ev(`(() => {
      const input = document.querySelector('.file-search__input')
      if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })) }
      window.__L.store('find').hide()
      return 'ok'
    })()`)
    await sleep(400)

    // ── D. 指针停在侧栏上、焦点在编辑区 → 也算"人在侧栏里"，走侧栏搜索 ──────────
    // 这是最常见的那种现场：鼠标在侧栏里点了一下（点的是行之间的空白 → 焦点没挪进面板），
    // 然后按 Ctrl+F。判定里 `pointerInSidebar` 就是为它准备的（见 lib/ctrlFRoute.ts）。
    await bringToFront(app)
    await ev(`(() => {
      const ed = window.__L.ed()
      if (ed) ed.commands.focus()
      return 'ok'
    })()`)
    const barRect = JSON.parse(
      await ev(`(() => {
        const row = document.querySelector('[data-tree-row]')
        if (!row) return JSON.stringify(null)
        const r = row.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) })
      })()`)
    )
    if (barRect) {
      // 真实指针移动：Chromium 才会把 `aside:hover` 置上（合成事件做不到这一点）
      for (const type of ['mouseMoved', 'mouseMoved']) {
        await app.send('Input.dispatchMouseEvent', { type, x: barRect.x, y: barRect.y, buttons: 0 })
        await sleep(120)
      }
    }
    await sleep(300)
    const hovered = await ev(`!!document.querySelector('[data-sidebar-root]:hover')`)
    await ev(CTRL_F)
    await sleep(450)
    const d = JSON.parse(await ev(STATE))
    report.note('D ' + JSON.stringify({ hovered, ...d }))
    report.check(
      'ctrl-f-with-pointer-in-sidebar-opens-sidebar-search',
      hovered === true && d.sidebarOpen === true && d.findOpen === false,
      `指针在侧栏上=${hovered} / sidebarOpen=${d.sidebarOpen} / findOpen=${d.findOpen}`
    )
    await ev(`(() => {
      const input = document.querySelector('.file-search__input')
      if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur() }
      window.__L.store('find').hide()
      return 'ok'
    })()`)
    // 把指针挪回编辑区，免得后面几条被"指针还在侧栏上"影响
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 400, buttons: 0 })
    await sleep(300)

    // ── E. 边界：焦点在大纲条目上 → 仍走正文查找（大纲是正文的导航，不是文件）──
    await ev(`(() => { window.__L.ui().sidebarTab = 'outline'; return 'ok' })()`)
    await sleep(600)
    const outFocused = await ev(focusOn('[data-outline-item]'))
    await sleep(300)
    report.note('焦点落到大纲条目 ' + outFocused)
    await ev(CTRL_F)
    await sleep(450)
    const c2 = JSON.parse(await ev(STATE))
    report.note('E ' + JSON.stringify(c2))
    report.check(
      'ctrl-f-in-outline-stays-document-find',
      outFocused === true && c2.findOpen === true && c2.sidebarOpen === false,
      `${JSON.stringify(c2)} / 焦点落在大纲条目=${outFocused}`
    )
    await ev(`(() => { window.__L.store('find').hide(); return 'ok' })()`)

    // ── E2. 边界：**没有工作区**时 → 仍走正文查找（侧栏里没有文件名搜索这回事）──
    await ev(`(async () => {
      window.__L.ui().sidebarTab = 'files'
      await window.__L.files().setRoot(null)
      return 'ok'
    })()`)
    await sleep(700)
    await bringToFront(app)
    await ev(`(() => {
      const tab = document.querySelector('[data-sidebar-tab="files"]')
      if (tab) tab.focus()
      return 'ok'
    })()`)
    await sleep(300)
    await ev(CTRL_F)
    await sleep(450)
    const c3 = JSON.parse(await ev(STATE))
    report.note('E2 ' + JSON.stringify(c3))
    report.check(
      'ctrl-f-without-workspace-stays-document-find',
      c3.findOpen === true && c3.sidebarOpen === false,
      `${JSON.stringify(c3)}（没有工作区就没有文件名可筛，只能开正文查找）`
    )
    await ev(`(() => { window.__L.store('find').hide(); return 'ok' })()`)
    // 复原工作区，给最后那条提示语断言用
    await ev(
      `(async () => { await window.__L.files().setRoot(${JSON.stringify(dir)}); return 'ok' })()`
    )
    await sleep(700)

    // 提示语里带上快捷键（发现性：不写出来的话没人知道侧栏里也能 Ctrl+F）
    await ev(`(() => { window.__L.ui().sidebarTab = 'files'; return 'ok' })()`)
    await sleep(500)
    const tip = await ev(
      `(() => { const b = document.querySelector('[data-sidebar-search-toggle]'); return b ? b.title : null })()`
    )
    report.check(
      'sidebar-search-tooltip-shows-shortcut',
      typeof tip === 'string' && tip.includes('Ctrl+F'),
      String(tip)
    )
  } finally {
    await ev(
      `(async () => { await window.__L.files().close(); await window.__L.files().setRoot(null); return 'ok' })()`
    ).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }

  app.close()
  process.exit(report.finish())
}

main().catch((e) => fatal(e))
