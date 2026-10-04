// 验收：快捷工具栏的空白区右键菜单 + 显隐/排序设置（设置›编辑器›快捷工具栏）
//
// 跑法：需先以调试端口启动实例（`--remote-debugging-port=9222`，见 README / 手册 §4.23），
// 脚本会连上第一个页面并直接操作真实界面（右键菜单真的弹、按钮真的被点、工具栏真的消失）。
//
// 断言分组：
//   A 空白区右键 → 一级两项（关闭工具栏 / 调整工具项），按钮上右键不弹工具栏菜单
//   B 「调整工具项」悬停 → 二级勾选列表（已显示带勾），点一项即从工具栏移除（settings 同步）
//   C 「关闭工具栏」→ 工具栏从 DOM 消失（且右键菜单一并收起）
//   D 关闭状态下的两个恢复入口：视图菜单 + 设置里的开关
//   E 设置›编辑器 的快捷工具栏区块：开关、上移（同组）、隐藏/加入、恢复默认
//   F 编辑区右键菜单宽度收紧，且没有窄到不可用
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
}

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails
      throw new Error(
        `EXC ${d.exception?.description ?? d.text} @EXPR: ${String(expr).replace(/\s+/g, ' ').slice(0, 300)}`
      )
    }
    return r.result?.result?.value
  }
  /** 与 ev 相同，但失败时把「是哪个探针炸的」一并打出来（给套件自己定位用） */
  const evAt = async (label, expr) => {
    try {
      return await ev(expr)
    } catch (e) {
      console.log(`!! probe failed at ${label}: ${e.message.split('\n')[0]}`)
      throw e
    }
  }
  return { ws, ready, send, ev, evAt }
}

/**
 * 取 Pinia 实例的表达式片段（插进字符串里的 JS）。
 * 与既有套件（_verify-editor-menu.js）同一套取法：provides 里那个带 _s: Map 的对象就是 pinia。
 */
const PINIA = `(() => {
  const app = document.querySelector('#app').__vue_app__
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => {
    const p = app._context.provides[s]
    return !!p && typeof p === 'object' && p._s instanceof Map
  })
  return app._context.provides[sym]
})()`

;(async () => {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const pages = (await get('/json/list')).filter((t) => t.type === 'page')
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  await w.send('Page.bringToFront')
  await w.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const { ev, evAt, send } = w

  async function mouse(type, x, y, button, clicks) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: button || 'none',
      buttons: type === 'mouseMoved' ? 0 : button === 'right' ? 2 : button === 'left' ? 1 : 0,
      clickCount: clicks || 1
    })
  }
  async function rightClick(x, y) {
    await mouse('mouseMoved', x, y)
    await mouse('mousePressed', x, y, 'right')
    await mouse('mouseReleased', x, y, 'right')
    await sleep(450)
  }
  /** 分几步移动：菜单的悬停意图/安全区判定依赖真实的 pointermove 序列 */
  async function hover(x, y) {
    for (let i = 0; i < 6; i++) {
      await mouse('mouseMoved', x + i, y + (i % 2))
      await sleep(45)
    }
    await sleep(500)
  }
  async function click(x, y) {
    await mouse('mouseMoved', x, y)
    await mouse('mousePressed', x, y, 'left')
    await mouse('mouseReleased', x, y, 'left')
    await sleep(420)
  }
  /**
   * 根据文本 / aria-label / 选择器找元素中心点。
   * `scrollIntoView` 必须打开：设置面板里的行可能远在视口下方（实测 y=1310），
   * 而 CDP 的鼠标事件只作用于视口坐标 —— 不先滚进来就会「点了个空气」，
   * 表现为「点了但设置没变」的假失败。
   */
  const pointOf = (selectorJs, scrollIntoView) =>
    ev(`(() => {
      const el = ${selectorJs}
      if (!el) return JSON.stringify({ found: false })
      if (${scrollIntoView === false ? 'false' : 'true'}) el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return JSON.stringify({
        found: true,
        disabled: !!el.disabled,
        inViewport: r.top >= 0 && r.bottom <= innerHeight,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2)
      })
    })()`).then(JSON.parse)

  // ── 探针 ──────────────────────────────────────────────────────────────────
  const TOOLBAR = `(() => {
    const bar = document.querySelector('[data-editor-toolbar]')
    if (!bar) return JSON.stringify({ found: false })
    const cls = (d) => d.className?.toString?.() || ''
    const spacer = [...bar.children].find((el) => cls(el).includes('flex-1'))
    const sr = spacer ? spacer.getBoundingClientRect() : null
    return JSON.stringify({
      found: true,
      buttons: [...bar.querySelectorAll('button[title]')].map((b) => b.getAttribute('title')),
      itemCount: bar.querySelectorAll('[data-toolbar-item]').length,
      blank: sr ? { x: Math.round(sr.left + 6), y: Math.round(sr.top + sr.height / 2) } : null
    })
  })()`

  // 面板定位走**语义锚点**而不是 Tailwind 生成的 z-[NNN] 类名：
  // 一级面板 = [role=menu][aria-label=toolbar-menu]，子菜单 = [role=menu][aria-label=submenu]
  const PANEL = `document.querySelector('[role="menu"][aria-label="toolbar-menu"]')`
  /**
   * 二级面板：**不能按字面量 aria-label="submenu" 找** —— 那个标签现在走语言包
   * （`t('common.submenu')`：中文界面渲染成「子菜单」），而"把界面文案写死在模板里"
   * 正是报告 §5.4 P2-2 要修的问题。判据改成结构性的：第一个 menu 面板是 toolbar-menu，
   * 另一个就是它弹出的子面板。
   */
  const SUBPANEL = `[...document.querySelectorAll('[role="menu"]')].find((p) => p.getAttribute('aria-label') !== 'toolbar-menu')`
  const CTX = `(() => {
    const panel = ${PANEL}
    const sub = ${SUBPANEL}
    const read = (p) =>
      [...p.querySelectorAll('button')].map((b) => ({
        text: b.textContent.trim(),
        // 勾选态用 aria-checked（语义属性）判定，不靠 Tailwind 的 text-accent 类名
        checked: b.getAttribute('aria-checked') === 'true' || !!b.querySelector('.text-accent'),
        hasSub: b.getAttribute('aria-haspopup') === 'menu'
      }))
    return JSON.stringify({
      count: (panel ? 1 : 0) + (sub ? 1 : 0),
      items: panel ? read(panel) : [],
      sub: sub ? read(sub) : []
    })
  })()`

  const STATE = `(() => {
    const pinia = ${PINIA}
    const st = pinia._s.get('settings')
    const ui = pinia._s.get('ui')
    return JSON.stringify({
      visible: st.toolbarVisible,
      items: st.toolbarItems,
      settingsOpen: ui.settingsOpen,
      section: ui.settingsSection,
      ctxMenu: !!ui.contextMenu
    })
  })()`

  const setSettings = (patch) =>
    ev(`(() => {
      const pinia = ${PINIA}
      const patch = ${JSON.stringify(patch)}
      for (const k of Object.keys(patch)) pinia._s.get('settings').set(k, patch[k])
      return 'ok'
    })()`)

  const closePanels = () =>
    ev(`(() => {
      const pinia = ${PINIA}
      pinia._s.get('ui').closeContextMenu()
      pinia._s.get('ui').closeSettings()
      pinia._s.get('editorMenu').close()
      return 'ok'
    })()`)

  await ev(
    `(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`
  )
  await sleep(600)

  // 这个套件会真的改全局设置：先把用户原值记下来，结束时还回去
  const original = JSON.parse(await evAt('STATE', STATE))
  let fatal = null
  try {
    await setSettings({ toolbarVisible: true, toolbarItems: original.items })
    await sleep(600)

    // ── A. 空白区右键 ──────────────────────────────────────────────────────
    const t0 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
    console.log(
      'A-TOOLBAR ' + JSON.stringify({ found: t0.found, blank: t0.blank, n: t0.buttons?.length })
    )
    c('toolbar-found', t0.found === true)
    c('toolbar-has-blank-area', !!t0.blank, JSON.stringify(t0.blank))

    await rightClick(t0.blank.x, t0.blank.y)
    const menuA = JSON.parse(await evAt('CTX', CTX))
    const stateAfterOpen = JSON.parse(await evAt('STATE', STATE))
    console.log('A-MENU ' + JSON.stringify(menuA.items) + ' ctx=' + stateAfterOpen.ctxMenu)
    c('blank-right-click-opens-menu', menuA.count >= 1, 'panels=' + menuA.count)
    c(
      'menu-has-two-options',
      menuA.items.map((x) => x.text).join('|') === '关闭工具栏|调整工具项',
      menuA.items.map((x) => x.text).join('|')
    )
    c('adjust-item-has-submenu-caret', menuA.items[1]?.hasSub === true)

    // 按钮上右键不弹工具栏菜单（交给项目自身）
    const firstBtn = await pointOf(
      `document.querySelector('[data-editor-toolbar] button[data-toolbar-item]')`
    )
    await closePanels()
    await sleep(300)
    await rightClick(firstBtn.x, firstBtn.y)
    const onBtn = JSON.parse(await evAt('CTX', CTX))
    c('item-right-click-does-not-open-toolbar-menu', onBtn.count === 0, JSON.stringify(onBtn.items))

    // 表格 / 代码块按钮各自由一个组件渲染，模板是「容器 div + Teleport 弹层」两个根节点：
    // 属性无法自动继承，`data-toolbar-item` 必须手动挂到容器上（defineOptions inheritAttrs:false
    // + v-bind="$attrs"）。漏挂的话右键会被当成空白区、并且控制台每次都冒 Vue 警告。
    const attrProbe = JSON.parse(
      await evAt(
        'TOOLBAR-ATTR',
        `(() => {
          const bar = document.querySelector('[data-editor-toolbar]')
          const find = (kw) =>
            [...bar.querySelectorAll('button')].find((b) =>
              (b.getAttribute('title') || '').includes(kw)
            )
          const read = (b) =>
            b
              ? {
                  title: b.getAttribute('title'),
                  parentTag: b.parentElement.tagName,
                  marked: !!b.closest('[data-toolbar-item]'),
                  attrs: [...b.parentElement.attributes].map((a) => a.name)
                }
              : null
          return JSON.stringify({ table: read(find('表格')), code: read(find('代码块')) })
        })()`
      )
    )
    console.log('A-ATTR ' + JSON.stringify(attrProbe))
    c(
      'table-codeblock-buttons-carry-data-toolbar-item',
      [attrProbe.table, attrProbe.code].every((x) => x && x.marked && x.attrs.includes('data-toolbar-item')),
      JSON.stringify(attrProbe)
    )
    // 真的在表格按钮上右键：必须被当成「项目上」，不能弹工具栏空白区菜单
    const tableBtn = await pointOf(
      `(() => {
        const bar = document.querySelector('[data-editor-toolbar]')
        return [...bar.querySelectorAll('button')].find((b) =>
          (b.getAttribute('title') || '').includes('表格')
        )
      })()`
    )
    await closePanels()
    await sleep(300)
    await rightClick(tableBtn.x, tableBtn.y)
    const onTableBtn = JSON.parse(await evAt('CTX', CTX))
    c(
      'table-button-right-click-not-blank-area',
      onTableBtn.count === 0,
      JSON.stringify(onTableBtn.items)
    )

    // ── B. 二级：悬停「调整工具项」→ 勾选列表 ────────────────────────────────
    await closePanels()
    await sleep(300)
    const t1 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
    await rightClick(t1.blank.x, t1.blank.y)
    const adjustPos = await pointOf(
      `[...document.querySelectorAll('[role="menu"][aria-label="toolbar-menu"] button')].find((x) => x.textContent.includes('调整工具项'))`
    )
    await hover(adjustPos.x, adjustPos.y)
    const menuB = JSON.parse(await evAt('CTX', CTX))
    console.log('B-SUB n=' + menuB.sub.length + ' ' + JSON.stringify(menuB.sub.slice(0, 4)))
    c('submenu-opens-on-hover', menuB.sub.length > 10, 'n=' + menuB.sub.length)
    c(
      'submenu-lists-item-names',
      menuB.sub.some((x) => x.text === '加粗') && menuB.sub.some((x) => x.text === '标题 1'),
      JSON.stringify(menuB.sub.slice(0, 3))
    )
    c(
      'submenu-all-shown-are-checked',
      menuB.sub.filter((x) => x.checked).length === menuB.sub.length,
      'checked=' + menuB.sub.filter((x) => x.checked).length + '/' + menuB.sub.length
    )
    c(
      'submenu-unchecked-are-listed-last',
      menuB.sub.findIndex((x) => !x.checked) === -1 ||
        menuB.sub.findIndex((x) => !x.checked) > menuB.sub.findIndex((x) => x.checked)
    )

    // 点「加粗」→ settings 与工具栏一起少一项
    const boldPos = await pointOf(
      `[...document.querySelectorAll('[role="menu"][data-context-submenu] button')].find((x) => x.textContent.trim() === '加粗')`
    )
    await click(boldPos.x, boldPos.y)
    await sleep(600)
    const afterToggle = JSON.parse(await evAt('STATE', STATE))
    const t2 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
    console.log('B-AFTER ' + JSON.stringify({ items: afterToggle.items?.slice(0, 6) }))
    c(
      'toggle-off-removes-from-settings',
      !afterToggle.items.includes('bold'),
      JSON.stringify(afterToggle.items)
    )
    c(
      'toggle-off-removes-button',
      !t2.buttons.some((x) => x === '加粗'),
      JSON.stringify(t2.buttons)
    )
    c(
      'toggle-off-keeps-others',
      t2.buttons.some((x) => x === '斜体'),
      JSON.stringify(t2.buttons)
    )

    // 再点回来（同一菜单的勾选项应当能恢复）
    const t2b = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
    await rightClick(t2b.blank.x, t2b.blank.y)
    const adjust2 = await pointOf(
      `[...document.querySelectorAll('[role="menu"][aria-label="toolbar-menu"] button')].find((x) => x.textContent.includes('调整工具项'))`
    )
    await hover(adjust2.x, adjust2.y)
    const boldBack = await pointOf(
      `[...document.querySelectorAll('[role="menu"][data-context-submenu] button')].find((x) => x.textContent.trim() === '加粗')`
    )
    await click(boldBack.x, boldBack.y)
    await sleep(600)
    const afterRestore = JSON.parse(await evAt('STATE', STATE))
    c(
      'toggle-on-adds-back',
      afterRestore.items.includes('bold'),
      JSON.stringify(afterRestore.items.slice(0, 6))
    )

    // ── C. 关闭工具栏 ──────────────────────────────────────────────────────
    await setSettings({ toolbarItems: original.items })
    await sleep(500)
    const t3 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
    await rightClick(t3.blank.x, t3.blank.y)
    const hidePos = await pointOf(
      `[...document.querySelectorAll('[role="menu"][aria-label="toolbar-menu"] button')].find((x) => x.textContent.includes('关闭工具栏'))`
    )
    await click(hidePos.x, hidePos.y)
    await sleep(700)
    const hiddenState = JSON.parse(await evAt('STATE', STATE))
    const t4 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
    const menusAfter = JSON.parse(await evAt('CTX', CTX))
    console.log(
      'C-HIDDEN ' +
        JSON.stringify({ visible: hiddenState.visible, toolbar: t4.found, menus: menusAfter.count })
    )
    c('hide-sets-visible-false', hiddenState.visible === false)
    c('toolbar-removed-from-dom', t4.found === false)
    c('context-menu-closed-after-pick', menusAfter.count === 0)

    // ── D. 两个恢复入口 ────────────────────────────────────────────────────
    // D1 应用内视图菜单：Alt+V → 「显示快捷工具栏」
    for (const [key, code, vk, mods] of [
      ['Alt', 'AltLeft', 18, 1],
      ['v', 'KeyV', 86, 1]
    ]) {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        modifiers: mods
      })
    }
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      modifiers: 1
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Alt',
      code: 'AltLeft',
      windowsVirtualKeyCode: 18
    })
    await sleep(600)
    const entry = await pointOf(
      `[...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().includes('显示快捷工具栏'))`
    )
    console.log('D-MENU-ENTRY ' + JSON.stringify(entry))
    c('view-menu-has-toolbar-toggle', entry.found === true)
    if (entry.found) {
      await click(entry.x, entry.y)
      await sleep(600)
      const back = JSON.parse(await evAt('STATE', STATE))
      const t5 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
      c('view-menu-entry-restores-toolbar', back.visible === true && t5.found === true)
    } else {
      c('view-menu-entry-restores-toolbar', false, 'skip: 入口未找到')
    }

    // D2 设置里的开关（先关掉再打开）
    await setSettings({ toolbarVisible: false })
    await sleep(500)
    await ev(`(() => { ${PINIA}._s.get('ui').openSettings('editor'); return 'ok' })()`)
    await sleep(800)
    const sw = await ev(`(() => {
      const el = document.querySelector('[data-setting-toolbar-switch]')
      if (!el) return JSON.stringify({ found: false })
      const r = el.getBoundingClientRect()
      return JSON.stringify({
        found: true,
        on: el.className.toString().includes('on'),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2)
      })
    })()`).then(JSON.parse)
    console.log('D-SETTINGS-SWITCH ' + JSON.stringify(sw))
    c('settings-section-present', sw.found === true)
    c('settings-switch-reflects-off', sw.found === true && sw.on === false, JSON.stringify(sw))
    if (sw.found) {
      await click(sw.x, sw.y)
      await sleep(600)
      const back2 = JSON.parse(await evAt('STATE', STATE))
      const t6 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
      c('settings-switch-restores-toolbar', back2.visible === true && t6.found === true)
    } else {
      c('settings-switch-restores-toolbar', false, 'skip: 开关未找到')
    }

    // ── E. 设置区块里的排序 / 隐藏 / 加入 / 恢复默认 ──────────────────────────
    // ⚠️ 本轮起「调整工具项」整段**默认折叠**（用户口径：该折叠的折叠），所以先展开它。
    const foldOpen = await ev(`(() => {
      const d = document.querySelector('[data-setting-toolbar-fold]')
      if (!d) return 'no-fold'
      d.open = true
      return d.open === true ? 'opened' : 'failed'
    })()`)
    await sleep(300)
    c('toolbar-items-fold-present-and-opens', foldOpen === 'opened', String(foldOpen))

    // E1 上移：拿**组内非首位**的项（斜体）验证与上一项互换；
    //    组内首位（加粗 / 一级标题 / 引用 / 表格）的上移必须是禁用的 —— 那是设计，不是缺陷。
    const beforeMove = JSON.parse(await evAt('STATE', STATE))
    const MOVE_ID = 'italic'
    const idxMove = beforeMove.items.indexOf(MOVE_ID)
    const prevId = beforeMove.items[idxMove - 1]
    const upPos = await ev(`(() => {
      const row = document.querySelector('[data-setting-toolbar-item="${MOVE_ID}"]')
      if (!row) return JSON.stringify({ found: false, why: 'no-row' })
      const btns = [...row.querySelectorAll('button')].map((x) => ({ al: x.getAttribute('aria-label'), disabled: !!x.disabled }))
      const b = [...row.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '上移一位')
      if (!b) return JSON.stringify({ found: false, why: 'no-up-button', btns })
      b.scrollIntoView({ block: 'center' })
      const r = b.getBoundingClientRect()
      return JSON.stringify({ found: true, disabled: !!b.disabled, btns, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`).then(JSON.parse)
    console.log('E-MOVE-UP ' + JSON.stringify(upPos))
    c('settings-row-has-move-buttons', upPos.found === true, JSON.stringify({ why: upPos.why }))
    if (upPos.found && !upPos.disabled) {
      await click(upPos.x, upPos.y)
      await sleep(500)
      const afterMove = JSON.parse(await evAt('STATE', STATE))
      c(
        'move-up-swaps-with-previous',
        afterMove.items.indexOf(MOVE_ID) === idxMove - 1 && afterMove.items[idxMove] === prevId,
        JSON.stringify({ before: beforeMove.items.slice(0, 9), after: afterMove.items.slice(0, 9) })
      )
    } else {
      c('move-up-swaps-with-previous', false, 'skip: 按钮不可用 ' + JSON.stringify(upPos))
    }

    // E1b 组内首位的上移必须是禁用的（同组换序的边界，UI 上要看得出来）。
    // 先恢复出厂顺序：上一步把斜体换到了加粗前面，此时加粗已不是组内首位。
    await setSettings({ toolbarItems: original.items })
    await sleep(500)
    const groupFirst = await ev(`(() => {
      const row = document.querySelector('[data-setting-toolbar-item="bold"]')
      if (!row) return JSON.stringify({ found: false })
      const b = [...row.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '上移一位')
      return JSON.stringify({ found: true, disabled: !!b.disabled })
    })()`).then(JSON.parse)
    c(
      'group-first-item-cannot-move-up',
      groupFirst.found === true && groupFirst.disabled === true,
      JSON.stringify(groupFirst)
    )

    // E2 隐藏 + 按目录顺序加回
    const hideBtn = await pointOf(
      `[...(document.querySelector('[data-setting-toolbar-item="toc"]')?.querySelectorAll('button') ?? [])].find((x) => x.getAttribute('aria-label') === '从工具栏移除')`
    )
    c('settings-row-toc-has-hide-button', hideBtn.found === true)
    if (hideBtn.found) {
      await click(hideBtn.x, hideBtn.y)
      await sleep(500)
    }
    const afterHide = JSON.parse(await evAt('STATE', STATE))
    const t7 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
    c(
      'settings-hide-removes-item',
      !afterHide.items.includes('toc'),
      JSON.stringify(afterHide.items.slice(-4))
    )
    c(
      'settings-hide-reflects-in-toolbar',
      !t7.buttons.some((x) => x === '目录'),
      JSON.stringify(t7.buttons.slice(-5))
    )

    const addPos = await pointOf(
      `[...(document.querySelector('[data-setting-toolbar-hidden-item="toc"]')?.querySelectorAll('button') ?? [])].find((x) => x.getAttribute('aria-label') === '加入工具栏')`
    )
    c('hidden-list-shows-removed-item', addPos.found === true)
    if (addPos.found) {
      await click(addPos.x, addPos.y)
      await sleep(500)
      const afterAdd = JSON.parse(await evAt('STATE', STATE))
      const expectedAt = original.items.indexOf('toc')
      c(
        'settings-add-restores-in-catalog-order',
        afterAdd.items.includes('toc') &&
          afterAdd.items.indexOf('toc') ===
            afterAdd.items.filter((x) => original.items.indexOf(x) < expectedAt).length,
        JSON.stringify({ at: afterAdd.items.indexOf('toc'), expected: expectedAt })
      )
    } else {
      c('settings-add-restores-in-catalog-order', false, 'skip: 未找到加入按钮')
    }

    // E3 恢复默认
    await setSettings({ toolbarItems: ['bold'] })
    await sleep(500)
    const resetPos = await pointOf(`document.querySelector('[data-setting-toolbar-reset]')`)
    await click(resetPos.x, resetPos.y)
    await sleep(700)
    const afterReset = JSON.parse(await evAt('STATE', STATE))
    console.log('E-RESET n=' + afterReset.items.length)
    c(
      'reset-restores-full-catalog-order',
      afterReset.items.length > 15 &&
        afterReset.items.includes('bold') &&
        afterReset.items.includes('toc'),
      JSON.stringify(afterReset.items)
    )
    const t8 = JSON.parse(await evAt('TOOLBAR', TOOLBAR))
    c('reset-reflects-in-toolbar', t8.found === true && t8.itemCount > 10, 'items=' + t8.itemCount)

    // ── F. 编辑区右键菜单宽度 ───────────────────────────────────────────────
    await closePanels()
    await sleep(400)
    const dp = await ev(`(() => {
      const pinia = ${PINIA}
      const ed = pinia._s.get('editor').instance
      if (!ed) return JSON.stringify({ found: false })
      let pos = null
      ed.state.doc.descendants((n, p) => { if (pos === null && n.type.name === 'paragraph') pos = p })
      if (pos === null) return JSON.stringify({ found: false })
      const co = ed.view.coordsAtPos(Math.min(pos + 1, ed.state.doc.content.size))
      return JSON.stringify({ found: true, x: Math.round(co.left + 20), y: Math.round(co.bottom - 3) })
    })()`).then(JSON.parse)
    c('editor-click-point-found', dp.found === true)
    if (dp.found) {
      await rightClick(dp.x, dp.y)
      const m = await ev(`(() => {
        const p = document.querySelector('.ecm-panel')
        if (!p) return JSON.stringify({ found: false })
        const r = p.getBoundingClientRect()
        return JSON.stringify({ found: true, w: Math.round(r.width), h: Math.round(r.height) })
      })()`).then(JSON.parse)
      console.log('F-EDITOR-MENU ' + JSON.stringify(m))
      // 收紧前是 min 268 / max 320；这里同时卡住「确实变窄」与「没有窄到挤坏」
      c('editor-menu-narrower-than-before', m.found === true && m.w <= 272, JSON.stringify(m))
      c('editor-menu-still-usable-width', m.found === true && m.w >= 200, JSON.stringify(m))
      await ev(`(() => { ${PINIA}._s.get('editorMenu').close(); return 'ok' })()`)
    } else {
      c('editor-menu-narrower-than-before', false, 'skip: 没有可用段落')
      c('editor-menu-still-usable-width', false, 'skip')
    }
  } catch (e) {
    fatal = e
  } finally {
    // 还回用户原来的设置并关掉一切浮层
    await ev(`(() => {
      const pinia = ${PINIA}
      const st = pinia._s.get('settings')
      st.$patch({ toolbarVisible: ${JSON.stringify(original.visible)}, toolbarItems: ${JSON.stringify(original.items)} })
      st.persist()
      pinia._s.get('ui').closeContextMenu()
      pinia._s.get('ui').closeSettings()
      return 'ok'
    })()`).catch(() => {})
    await sleep(400)
    console.log('RESTORED ' + (await evAt('STATE', STATE).catch(() => 'n/a')))
    fs.rmSync(path.join(os.tmpdir(), 'lumin-toolbar-ws'), { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w.ws.close()
  if (fatal) throw fatal
  if (failed) process.exit(1)
})().catch((e) => {
  // 中途炸掉时也要把已经拿到的断言打出来（否则只剩一句 ERROR，定位不到是第几段）
  console.error('ERROR ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
