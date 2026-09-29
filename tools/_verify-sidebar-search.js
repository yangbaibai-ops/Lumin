'use strict'
// 验收：Ctrl+F 的**去向** —— 人在侧栏的文件面板里就搜文件名，否则照旧搜正文
//
// 用户口径（第八轮）：
//   「当在侧边栏点击 ctrl+f 时，请进入侧边栏的搜索而不是文档的搜索和查找。」
//
// 也就是：同一个 Ctrl+F 必须按**焦点在哪儿**分流，而不是永远开右上角那条查找栏。
// 分流实现见 `composables/useAppActions.ts` 的 `find` 分支（判定容器 `[data-sidebar-files]`）
// 与 `FileTree.vue` 里对 `ui.sidebarSearchTick` 的消费。
//
// 这条套件同时守着**两个方向**，因为只验一个方向的话，「把 Ctrl+F 整个改成侧栏搜索」
// 也能让断言全绿 —— 那等于把编辑器的查找功能弄丢了：
//   A. 焦点在文件树行 → 侧栏文件名搜索展开并拿到焦点，**正文查找栏不开**；
//   B. 焦点在编辑区   → 正文查找栏开，**侧栏搜索不开**；
//   C. 边界：焦点在侧栏**页签**上 / 侧栏的大纲页签 → 仍走正文查找。
//
// 按键走**页面内合成 KeyboardEvent**（`window.dispatchEvent`），不用 CDP 真实按键注入：
// 合成事件同样会经过 keymap 服务的 window 捕获监听（`lib/keymap/service.ts`），
// 而真实按键要求被测窗口是 OS 前台 —— 用户自己的 Lumin 在前台时那批断言会假红
// （`tools/lib/harness.js` 的 bringToFront 注释里记着这个坑）。路由判定读的是
// `document.activeElement`，与事件从哪来无关，所以这条路径足够真实。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, sleep, openDocWith, waitEditor, bringToFront, Reporter, fatal } =
  require('./lib/harness')

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
    await ev(`(() => { const i = document.querySelector('.file-search__input'); if (i) i.value = ''; const ev2 = new Event('input', { bubbles: true }); if (i) i.dispatchEvent(ev2); return 'ok' })()`)
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

    // ── C. 边界：焦点在侧栏**页签**上（不是文件面板里）→ 仍走正文查找 ──────
    // （改造前这里点的是"侧栏头部的工作区按钮"；本轮那一行整行去掉了 —— 文件夹名改成
    //   目录树的顶层节点，页签成了侧栏里最靠上的可聚焦控件，于是边界用例跟着换成它。
    //   要点不变：`[data-sidebar-files]` **之外**的侧栏区域不该抢走 Ctrl+F。）
    await bringToFront(app)
    const headFocused = await ev(focusOn('[data-sidebar-tab="files"]'))
    await sleep(300)
    report.note('焦点落到侧栏页签 ' + headFocused)
    await ev(CTRL_F)
    await sleep(450)
    const c1 = JSON.parse(await ev(STATE))
    report.note('C1 ' + JSON.stringify(c1))
    report.check(
      'ctrl-f-on-sidebar-tab-stays-document-find',
      headFocused === true && c1.findOpen === true && c1.sidebarOpen === false,
      `${JSON.stringify(c1)} / 焦点落在页签上=${headFocused}`
    )
    await ev(`(() => { window.__L.store('find').hide(); return 'ok' })()`)
    await sleep(300)

    // ── C. 边界：焦点在大纲条目上 → 仍走正文查找（大纲是正文的导航，不是文件）──
    await ev(`(() => { window.__L.ui().sidebarTab = 'outline'; return 'ok' })()`)
    await sleep(600)
    const outFocused = await ev(focusOn('[data-outline-item]'))
    await sleep(300)
    report.note('焦点落到大纲条目 ' + outFocused)
    await ev(CTRL_F)
    await sleep(450)
    const c2 = JSON.parse(await ev(STATE))
    report.note('C2 ' + JSON.stringify(c2))
    report.check(
      'ctrl-f-in-outline-stays-document-find',
      outFocused === true && c2.findOpen === true && c2.sidebarOpen === false,
      `${JSON.stringify(c2)} / 焦点落在大纲条目=${outFocused}`
    )
    await ev(`(() => { window.__L.store('find').hide(); return 'ok' })()`)

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
    await ev(`(async () => { await window.__L.files().close(); await window.__L.files().setRoot(null); return 'ok' })()`).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }

  app.close()
  process.exit(report.finish())
}

main().catch((e) => fatal(e))
