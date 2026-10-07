'use strict'
// 验收：**浏览器/Electron 自带功能的取消**（开发者工具的入口 + 刷新族/缩放/查看源码…）
//
// 用户口径（两轮）：
//   * 「取消点击 F12 出现开发者工具的功能，取而代之的是在顶部工具栏中添加一项：
//     '打开开发者工具'，点击就出现开发者工具。」（第三轮）
//   * 「取消 Electron/Chromium 自带但本项目不需要的功能」，点名「按 Ctrl+R 刷新页面」。（第四轮）
//
// 断言分组：
//   A 工具栏里**真的有**那一项（语义锚点 `[data-open-devtools]` + aria-label 来自语言包）
//   B 点击 → 主进程日志 + CDP 的 `/json/list` 里**多出一个 devtools 目标**（真的开起来了）
//   C 再点一次**不报错**（主进程 `isDevToolsOpened()` 分支报 already=true）
//   D DevTools 族（F12 / Ctrl+Shift+I）不再产生 devtools 目标
//   E 查看源码 Ctrl+U 不产生新窗口/新目标
//   F 缩放键（Ctrl+= / Ctrl+- / Ctrl+0）不改变缩放
//   G **应用自己的快捷键仍然有效**（Ctrl+Shift+B 侧栏、Ctrl+, 设置）—— 证明没被误拦
//   H **Ctrl+R / F5 不重载**：页面标记 `window.__reloadProbe` 必须还在（最硬的判据）
//   I 策略与接线的静态守卫（拦截桶、`watchWindowShortcuts` 没回来、缩放的鼠标闸在、清单一处）
//
// 为什么大量用"跨进程"判据：DevTools 是独立窗口、刷新会换掉整棵文档、缩放属于 webContents
// 状态 —— 页面侧要么看不见要么会自证，所以主进程日志（`[shortcuts] blocked …` /
// `[devtools] opened …`）与调试端口的目标列表才是证据。两者都用 `instanceLog()` 读。
//
// 跑法：`node tools/run-suites.js --suite=_verify-devtools.js`（运行器会起隔离实例 + 传日志路径）。
// E/F/G/H 段要**真实按键**：拿不到 OS 焦点时如实 SKIP（不算失败，见 harness 的 ensureFocus 口径）。
const fs = require('fs')
const path = require('path')
const {
  connect,
  settle,
  showToolbar,
  sleep,
  Reporter,
  fatal,
  ensureFocus,
  listTargets,
  instanceLog,
  inject
} = require('./lib/harness')
const { APP_OWNED_COMBOS, blockedShortcut } = require('../src/shared/shortcuts.ts')

/** 读主进程日志（GUI 子系统里主进程没有控制台，这是唯一可读的出口） */
function readLog(logPath) {
  if (!logPath) return ''
  try {
    return fs.readFileSync(logPath, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * 主进程日志里所有 `[devtools] opened window=N already=…` 行 → `{ windowId, already }`。
 *
 * 为什么读它：主进程开的 DevTools 是**独立窗口**，页面侧看不见也摸不到，
 * 而 `contextBridge` 暴露的 API 对象是**只读**的（不能 monkey-patch 来计数 ——
 * 第一版就是这么拿到一个恒空的计数数组、断言假红而 DevTools 其实已经开起来了）。
 */
function readOpenedLines(logPath) {
  const out = []
  for (const m of readLog(logPath).matchAll(/\[devtools\] opened window=(\d+) already=(true|false)/g)) {
    out.push({ windowId: Number(m[1]), already: m[2] === 'true' })
  }
  return out
}

/**
 * 主进程日志里所有 `[shortcuts] blocked <组合键> (<理由>)` 行。
 * 这是"这条键**真的**被主进程拦下了"的取证点（而不是"策略函数返回了非空"这种自证）。
 */
function readBlockedLines(logPath) {
  const out = []
  for (const m of readLog(logPath).matchAll(/\[shortcuts\] blocked (\S+) \(([a-z-]+)\)/g)) {
    out.push({ combo: m[1], reason: m[2] })
  }
  return out
}

/** 调试端口上的全部目标（含 devtools 自己的窗口） */
async function targets() {
  try {
    return await listTargets()
  } catch {
    return []
  }
}

/** 「开发者工具开着」的判据：目标是 devtools 页，或 URL 是 devtools:// */
const isDevToolsTarget = (t) => t.type === 'devtools' || /^devtools:\/\//.test(String(t.url ?? ''))

async function devToolsTargets() {
  return (await targets()).filter(isDevToolsTarget)
}

/** 等到 devtools 目标出现（返回目标数组；超时返回最后一次结果） */
async function waitDevTools(ms = 6000) {
  const end = Date.now() + ms
  for (;;) {
    const found = await devToolsTargets()
    if (found.length) return found
    if (Date.now() > end) return found
    await sleep(200)
  }
}

/** 等到 devtools 目标消失 */
async function waitNoDevTools(ms = 6000) {
  const end = Date.now() + ms
  for (;;) {
    const found = await devToolsTargets()
    if (!found.length) return found
    if (Date.now() > end) return found
    await sleep(200)
  }
}

/**
 * 按一个组合键（真实的 Input.dispatchKeyEvent，会走主进程的 `before-input-event`）。
 * `modifiers` 位标志：Alt=1 / Ctrl=2 / Meta=4 / Shift=8（Chromium DevTools Protocol）。
 */
async function pressCombo(app, { key, code, vk, modifiers = 0, settleMs = 500 }) {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(settleMs)
}

const CTRL = 2
const SHIFT = 8
/** 常用组合键的参数表（vk = Windows 虚拟键码，Chromium 靠它把按键送进主进程） */
const COMBO = {
  ctrlR: { key: 'r', code: 'KeyR', vk: 82, modifiers: CTRL },
  f5: { key: 'F5', code: 'F5', vk: 116 },
  ctrlShiftI: { key: 'I', code: 'KeyI', vk: 73, modifiers: CTRL | SHIFT },
  ctrlU: { key: 'u', code: 'KeyU', vk: 85, modifiers: CTRL },
  zoomIn: { key: '=', code: 'Equal', vk: 187, modifiers: CTRL },
  zoomOut: { key: '-', code: 'Minus', vk: 189, modifiers: CTRL },
  zoomReset: { key: '0', code: 'Digit0', vk: 48, modifiers: CTRL },
  // 应用自己的两个键（证明没被误拦）：切换侧栏 / 打开设置
  appSidebar: { key: 'B', code: 'KeyB', vk: 66, modifiers: CTRL | SHIFT },
  appSettings: { key: ',', code: 'Comma', vk: 188, modifiers: CTRL },
  // 专注模式（用户点名要确认的那条：F11 被拦 ≠ 应用没有全屏/专注入口）
  appFocus: { key: 'F', code: 'KeyF', vk: 70, modifiers: CTRL | SHIFT }
}

/** 按一次 F12 */
async function pressF12(app) {
  await pressCombo(app, { key: 'F12', code: 'F12', vk: 123, settleMs: 1200 })
}

/** 确保 DevTools 是关着的（用被测应用自己的 IPC，不 kill 进程、也不碰 target）：返回是否已关 */
async function ensureClosed(app) {
  await app.ev(`(async () => await window.luminAPI.app.closeDevTools())()`)
  await waitNoDevTools(4000)
  return (await devToolsTargets()).length === 0
}

/** 页面侧的缩放读数（键盘缩放会同时改这两处） */
const ZOOM_PROBE = `(() => {
  return JSON.stringify({
    dpr: window.devicePixelRatio,
    scale: window.visualViewport ? window.visualViewport.scale : null,
    // 顺带记一个布局度量：真的整页缩放时它也会跟着变（比 dpr 更贴近"版式被搞坏"）
    barHeight: (document.querySelector('[data-editor-toolbar]') || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height
  })
})()`

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('SKIP: 没有可用窗口')
    return 0
  }
  const { ev, send } = app
  const report = new Reporter('浏览器自带功能：DevTools 入口 / 刷新族 / 缩放 / 查看源码 / 不误伤应用键')

  // 工具栏出厂是收起的（见 harness.showToolbar 的说明），先显式打开
  const shown = await showToolbar(app)
  report.check('toolbar-visible', shown === true)

  // ── A. 工具栏里真的有那一项 ────────────────────────────────────────────────
  // ⚠️ 工具栏根节点是 `overflow-x-auto`：窄窗口下**右边的固定入口会横向溢到可视区之外**，
  // CDP 点击会落到窗口外（表现为"点了没反应"）——所以先 scrollIntoView，再取坐标；
  // `inViewport` 也把左右两边一起判（漏判左右正是本套件第一次跑时的假红原因）。
  const probe = await ev(`(() => {
    const bar = document.querySelector('[data-editor-toolbar]')
    if (!bar) return JSON.stringify({ bar: false })
    const btn = bar.querySelector('[data-open-devtools]')
    if (!btn) return JSON.stringify({ bar: true, found: false })
    btn.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const r = btn.getBoundingClientRect()
    const labels = [btn.getAttribute('aria-label'), btn.getAttribute('title')].filter(Boolean)
    return JSON.stringify({
      bar: true,
      found: true,
      inViewport:
        r.width > 0 &&
        r.height > 0 &&
        r.top >= 0 &&
        r.bottom <= innerHeight &&
        r.left >= 0 &&
        r.right <= innerWidth,
      center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      rect: {
        left: Math.round(r.left),
        right: Math.round(r.right),
        innerWidth,
        scrollLeft: Math.round(bar.scrollLeft)
      },
      // 语义锚点：不看具体的语言文案（矩阵前面的套件可能把语言留在 en-US / ru-RU）
      labels,
      hasIcon: !!btn.querySelector('svg')
    })
  })()`).then(JSON.parse)
  console.log('A-BUTTON ' + JSON.stringify(probe))
  report.check('toolbar-has-open-devtools-button', probe.found === true, JSON.stringify(probe))
  report.check(
    'button-has-accessible-name-from-i18n',
    Array.isArray(probe.labels) && probe.labels.length === 2 && probe.labels[0] === probe.labels[1],
    JSON.stringify(probe.labels)
  )
  report.check('button-has-icon', probe.hasIcon === true)
  report.check(
    'button-reachable-in-viewport',
    probe.inViewport === true,
    JSON.stringify({ center: probe.center, rect: probe.rect })
  )

  // ── B. 点击 → IPC 真的被调用 ──────────────────────────────────────────────
  const logPath = instanceLog()
  const beforeTargets = await targets()
  const beforeLog = readOpenedLines(logPath)

  if (probe.found && probe.inViewport) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: probe.center.x,
      y: probe.center.y,
      button: 'none'
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: probe.center.x,
      y: probe.center.y,
      button: 'left',
      clickCount: 1
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: probe.center.x,
      y: probe.center.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(600)

    // B1. 真的开起来了：CDP 目标里多出 devtools
    const opened = await waitDevTools()
    const afterTargets = await targets()
    console.log(
      'B-TARGETS before=' +
        beforeTargets.length +
        ' after=' +
        afterTargets.length +
        ' devtools=' +
        JSON.stringify(opened.map((t) => ({ type: t.type, url: String(t.url).slice(0, 60) })))
    )
    report.check(
      'click-opens-devtools-target',
      opened.length >= 1 && afterTargets.length > beforeTargets.length,
      JSON.stringify({ before: beforeTargets.length, after: afterTargets.length })
    )

    // B2. 主进程确实收到了这次 IPC（日志行）
    const afterLog = readOpenedLines(logPath)
    console.log('B-MAIN-LOG ' + JSON.stringify({ path: logPath, before: beforeLog, after: afterLog }))
    if (!logPath) {
      // 手工起实例（没走 run-suites）时拿不到实例日志：如实 SKIP，不伪造 FAIL
      report.skip('click-reaches-main-ipc', '没有 LUMIN_INSTANCE_LOG，读不到实例日志')
      report.skip('second-click-reports-already-open', '同上')
    } else {
      report.check(
        'click-reaches-main-ipc',
        afterLog.length === beforeLog.length + 1 && afterLog[afterLog.length - 1].already === false,
        JSON.stringify({
          before: beforeLog.length,
          after: afterLog.length,
          last: afterLog[afterLog.length - 1]
        })
      )
    }

    // ── C. 再点一次：主进程走 isDevToolsOpened 分支，报 already=true ────────────
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: probe.center.x,
      y: probe.center.y,
      button: 'left',
      clickCount: 1
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: probe.center.x,
      y: probe.center.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(700)
    const log2 = readOpenedLines(logPath)
    const dtTargets2 = await devToolsTargets()
    console.log(
      'C-AFTER-SECOND-CLICK ' + JSON.stringify({ log: log2, devtoolsTargets: dtTargets2.length })
    )
    if (logPath) {
      report.check(
        'second-click-reports-already-open',
        log2.length === afterLog.length + 1 && log2[log2.length - 1].already === true,
        JSON.stringify({ last: log2[log2.length - 1] })
      )
    }
    report.check(
      'second-click-keeps-exactly-one-devtools',
      dtTargets2.length === 1,
      'devtools 目标数 = ' + dtTargets2.length
    )

    // 收尾：关掉 DevTools（别把独立窗口留在桌面上，也别影响后面的断言）
    const closed = await ensureClosed(app)
    report.check('devtools-can-be-closed', closed === true)
  } else {
    // 按钮不存在/不可见时，后面几段的**前提**就不成立：如实 SKIP，不伪造 FAIL
    for (const name of [
      'click-opens-devtools-target',
      'click-reaches-main-ipc',
      'second-click-reports-already-open',
      'second-click-keeps-exactly-one-devtools',
      'devtools-can-be-closed'
    ]) {
      report.skip(name, '工具栏里没有可点的「打开开发者工具」按钮')
    }
  }

  // ── D~H 段都要真实按键：先取焦点（拿不到就如实跳过这几段）─────────────────────
  const focused = await ensureFocus(app)
  report.note('真实按键段：focused=' + focused)
  const keySections = async () => {
    // ── D. DevTools 族：F12 与 Ctrl+Shift+I 都不再产生 devtools 目标 ──────────
    const dtBefore = await devToolsTargets()
    report.check(
      'precondition-no-devtools-before-keys',
      dtBefore.length === 0,
      JSON.stringify(dtBefore.map((t) => t.url))
    )
    await pressF12(app)
    const afterF12 = await devToolsTargets()
    console.log('D1-F12 devtoolsTargets=' + afterF12.length)
    report.check(
      'f12-does-not-open-devtools',
      afterF12.length === 0,
      'F12 之后多出了 devtools 目标：' + JSON.stringify(afterF12.map((t) => t.url))
    )
    // Ctrl+Shift+I：以前它由**原生菜单 role: 'toggleDevTools' 的默认加速键**触发，
    // 现在被 before-input-event 拦下（正好验证"拦也能拦住菜单加速键"这条机制）
    await pressCombo(app, COMBO.ctrlShiftI)
    const afterCSI = await devToolsTargets()
    console.log('D2-CtrlShiftI devtoolsTargets=' + afterCSI.length)
    report.check(
      'ctrl-shift-i-does-not-open-devtools',
      afterCSI.length === 0,
      'Ctrl+Shift+I 之后多出了 devtools 目标：' + JSON.stringify(afterCSI.map((t) => t.url))
    )

    // D3. F7（caret browsing）与 F11（浏览器全屏）：判据是"主进程真的拦下了"
    //（F11 在 Electron 里未必有默认行为，所以这里不假装测到了"没进全屏"；
    // 应用自己的专注模式走 Mod+Shift+F，见 G 段）
    await pressCombo(app, { key: 'F7', code: 'F7', vk: 118 })
    await pressCombo(app, { key: 'F11', code: 'F11', vk: 122 })
    const blockedF7F11 = readBlockedLines(logPath).filter(
      (l) => l.combo === 'F7' || l.combo === 'F11'
    )
    console.log('D3-F7F11 blocked=' + JSON.stringify(blockedF7F11))
    report.check(
      'f7-f11-blocked-in-main-process',
      blockedF7F11.some((l) => l.combo === 'F7' && l.reason === 'caret-browsing') &&
        blockedF7F11.some((l) => l.combo === 'F11' && l.reason === 'fullscreen'),
      JSON.stringify(blockedF7F11)
    )

    // ── E. 查看源码 Ctrl+U：不许产生新窗口/新目标 ─────────────────────────────
    const tBeforeU = (await targets()).length
    await pressCombo(app, COMBO.ctrlU)
    const tAfterU = await targets()
    const blockedU = readBlockedLines(logPath).filter((l) => l.combo === 'Ctrl+U')
    console.log(
      'E-CTRL-U targets=' + tBeforeU + '->' + tAfterU.length + ' blocked=' + JSON.stringify(blockedU)
    )
    report.check(
      'ctrl-u-does-not-open-view-source',
      tAfterU.length === tBeforeU,
      JSON.stringify({ before: tBeforeU, after: tAfterU.length })
    )
    report.check(
      'ctrl-u-blocked-in-main-process',
      blockedU.some((l) => l.reason === 'view-source'),
      JSON.stringify(blockedU)
    )

    // ── F. 缩放键：devicePixelRatio / visualViewport.scale 都不许变 ────────────
    const zoom0 = JSON.parse(await ev(ZOOM_PROBE))
    await pressCombo(app, { ...COMBO.zoomIn, settleMs: 400 })
    await pressCombo(app, { ...COMBO.zoomOut, settleMs: 400 })
    await pressCombo(app, { ...COMBO.zoomReset, settleMs: 600 })
    const zoom1 = JSON.parse(await ev(ZOOM_PROBE))
    const zoomBlocked = readBlockedLines(logPath).filter((l) => l.reason === 'zoom')
    console.log(
      'F-ZOOM before=' + JSON.stringify(zoom0) + ' after=' + JSON.stringify(zoom1) +
        ' blocked=' + JSON.stringify(zoomBlocked)
    )
    report.check(
      'zoom-keys-do-not-change-zoom',
      zoom1.dpr === zoom0.dpr && zoom1.scale === zoom0.scale,
      JSON.stringify({ before: zoom0, after: zoom1 })
    )
    report.check(
      'zoom-keys-blocked-in-main-process',
      zoomBlocked.length >= 3,
      '三条缩放键都应留下 [shortcuts] blocked 记录：' + JSON.stringify(zoomBlocked)
    )

    // F2. Ctrl+滚轮（缩放的第二条路）：`zoom-changed` 那道闸 —— 也要求读数不变。
    // 鼠标事件要落在**内容区**（工具栏上会被 `overflow-x-auto` 吃掉）：正文段落中心。
    const wheelPoint = await ev(`(() => {
      const ed = window.__L && window.__L.ed()
      if (!ed) return JSON.stringify({ found: false })
      let pos = null
      ed.state.doc.descendants((n, p) => { if (pos === null && n.type.name === 'paragraph') pos = p })
      if (pos === null) return JSON.stringify({ found: false })
      const co = ed.view.coordsAtPos(Math.min(pos + 1, ed.state.doc.content.size))
      return JSON.stringify({ found: true, x: Math.round(co.left + 40), y: Math.round(co.bottom - 4) })
    })()`).then(JSON.parse)
    if (wheelPoint.found) {
      for (const deltaY of [-120, -120, 120]) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: wheelPoint.x,
          y: wheelPoint.y,
          deltaX: 0,
          deltaY,
          modifiers: CTRL
        })
        await sleep(250)
      }
      const zoom2 = JSON.parse(await ev(ZOOM_PROBE))
      console.log('F2-CTRL-WHEEL before=' + JSON.stringify(zoom0) + ' after=' + JSON.stringify(zoom2))
      report.check(
        'ctrl-wheel-does-not-change-zoom',
        zoom2.dpr === zoom0.dpr && zoom2.scale === zoom0.scale,
        JSON.stringify({ before: zoom0, after: zoom2 })
      )
    } else {
      report.skip('ctrl-wheel-does-not-change-zoom', '找不到可落鼠标的内容区坐标')
    }

    // ── G. 应用自己的快捷键**仍然有效**（这是"没被误拦"的运行时证据）───────────
    const sidebar0 = await ev('window.__L.ui().sidebarVisible')
    await pressCombo(app, { ...COMBO.appSidebar, settleMs: 500 })
    const sidebar1 = await ev('window.__L.ui().sidebarVisible')
    console.log('G-CTRL-SHIFT-B ' + JSON.stringify({ before: sidebar0, after: sidebar1 }))
    report.check(
      'app-shortcut-ctrl-shift-b-still-works',
      sidebar1 === !sidebar0,
      JSON.stringify({ before: sidebar0, after: sidebar1 })
    )
    // 还原侧栏状态（别把状态留给后面的套件）
    await pressCombo(app, { ...COMBO.appSidebar, settleMs: 500 })
    const sidebar2 = await ev('window.__L.ui().sidebarVisible')
    report.check('app-shortcut-sidebar-restored', sidebar2 === sidebar0, JSON.stringify({ sidebar2 }))

    const settings0 = await ev('window.__L.ui().settingsOpen')
    await pressCombo(app, { ...COMBO.appSettings, settleMs: 800 })
    const settings1 = await ev('window.__L.ui().settingsOpen')
    console.log('G-CTRL-COMMA ' + JSON.stringify({ before: settings0, after: settings1 }))
    report.check(
      'app-shortcut-ctrl-comma-still-works',
      settings1 === true && settings0 === false,
      JSON.stringify({ before: settings0, after: settings1 })
    )
    await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)

    // 专注模式（Mod+Shift+F）仍然有效 —— 这是用户点名要确认的那条：
    // 「F11（浏览器全屏）也要拦，但若应用自己有全屏/专注模式入口，那条必须仍然有效」
    const focus0 = await ev('window.__L.ui().focusMode')
    await pressCombo(app, { ...COMBO.appFocus, settleMs: 500 })
    const focus1 = await ev('window.__L.ui().focusMode')
    console.log('G-CTRL-SHIFT-F ' + JSON.stringify({ before: focus0, after: focus1 }))
    report.check(
      'app-shortcut-ctrl-shift-f-focus-mode-still-works',
      focus1 === !focus0,
      JSON.stringify({ before: focus0, after: focus1 })
    )
    // 还原（别把专注模式留给后面的断言/套件）
    await pressCombo(app, { ...COMBO.appFocus, settleMs: 500 })
    const focus2 = await ev('window.__L.ui().focusMode')
    report.check('app-shortcut-focus-mode-restored', focus2 === focus0, JSON.stringify({ focus2 }))

    // ── H. 刷新族：Ctrl+R / F5 **不重载**（页面标记必须还在）───────────────────
    // 判据为什么最硬：重载会把整棵文档换掉，`window.__reloadProbe` 随之消失。
    // 页面在重载的瞬间求值可能抛「上下文已销毁」——那同样说明"重载了"，如实记为不是 alive。
    const readProbe = async () => {
      try {
        return { value: await ev(`window.__reloadProbe ?? 'GONE'`) }
      } catch (e) {
        return { value: 'GONE', error: String(e && e.message ? e.message : e).slice(0, 120) }
      }
    }
    for (const [name, combo] of [
      ['ctrl-r', COMBO.ctrlR],
      ['f5', COMBO.f5]
    ]) {
      await ev(`(() => { window.__reloadProbe = 'alive'; return 'ok' })()`)
      await pressCombo(app, { ...combo, settleMs: 900 })
      const after = await readProbe()
      const blocked = readBlockedLines(logPath).filter((l) => l.reason === 'reload')
      console.log(
        'H-' + name + ' probe=' + JSON.stringify(after) + ' blocked=' + JSON.stringify(blocked)
      )
      report.check(
        name + '-does-not-reload-the-page',
        after.value === 'alive',
        '页面标记消失了（说明真的重载了）：' + JSON.stringify(after)
      )
      report.check(
        name + '-blocked-in-main-process',
        blocked.some((l) => l.combo.toLowerCase().includes(name === 'ctrl-r' ? 'ctrl+r' : 'f5')),
        JSON.stringify(blocked)
      )
    }
    // 这一段之后页面状态可能已经被上一条（若失败）清掉：把 pinia 访问器补回来，别影响收尾
    await inject(app.ev).catch(() => false)
  }

  if (focused) {
    await keySections()
  } else {
    for (const name of [
      'precondition-no-devtools-before-keys',
      'f12-does-not-open-devtools',
      'ctrl-shift-i-does-not-open-devtools',
      'f7-f11-blocked-in-main-process',
      'ctrl-u-does-not-open-view-source',
      'ctrl-u-blocked-in-main-process',
      'zoom-keys-do-not-change-zoom',
      'zoom-keys-blocked-in-main-process',
      'ctrl-wheel-does-not-change-zoom',
      'app-shortcut-ctrl-shift-b-still-works',
      'app-shortcut-sidebar-restored',
      'app-shortcut-ctrl-comma-still-works',
      'app-shortcut-ctrl-shift-f-focus-mode-still-works',
      'app-shortcut-focus-mode-restored',
      'ctrl-r-does-not-reload-the-page',
      'ctrl-r-blocked-in-main-process',
      'f5-does-not-reload-the-page',
      'f5-blocked-in-main-process'
    ]) {
      report.skip(name, '窗口拿不到 OS 焦点（CDP 注入的真实按键会丢）')
    }
  }

  // ── I. 策略与接线的静态守卫（页面里 monkey-patch 不了 contextBridge，只能读源码）────
  const reason = (input) => blockedShortcut(input)
  const policy = {
    f12: reason({ type: 'keyDown', key: 'F12' }),
    ctrlShiftI: reason({ type: 'keyDown', key: 'i', control: true, shift: true }),
    ctrlR: reason({ type: 'keyDown', key: 'r', control: true }),
    f5: reason({ type: 'keyDown', key: 'F5' }),
    ctrlU: reason({ type: 'keyDown', key: 'u', control: true }),
    zoom: reason({ type: 'keyDown', key: '=', control: true }),
    f7: reason({ type: 'keyDown', key: 'F7' }),
    f11: reason({ type: 'keyDown', key: 'F11' }),
    // 应用自己的键（必须放行）
    print: reason({ type: 'keyDown', key: 'p', control: true }),
    find: reason({ type: 'keyDown', key: 'f', control: true }),
    focusMode: reason({ type: 'keyDown', key: 'f', control: true, shift: true }),
    bold: reason({ type: 'keyDown', key: 'b', control: true }),
    italic: reason({ type: 'keyDown', key: 'i', control: true })
  }
  console.log('I-POLICY ' + JSON.stringify(policy))
  report.check(
    'policy-blocks-browser-family',
    policy.f12 === 'devtools' &&
      policy.ctrlShiftI === 'devtools' &&
      policy.ctrlR === 'reload' &&
      policy.f5 === 'reload' &&
      policy.ctrlU === 'view-source' &&
      policy.zoom === 'zoom' &&
      policy.f7 === 'caret-browsing' &&
      policy.f11 === 'fullscreen',
    JSON.stringify(policy)
  )
  report.check(
    'policy-leaves-app-keys-alone',
    policy.print === null &&
      policy.find === null &&
      policy.focusMode === null &&
      policy.bold === null &&
      policy.italic === null,
    JSON.stringify(policy)
  )
  report.check(
    'policy-owns-the-full-app-key-list',
    Array.isArray(APP_OWNED_COMBOS) && APP_OWNED_COMBOS.includes('Mod+P') &&
      APP_OWNED_COMBOS.includes('Mod+Shift+F'),
    'APP_OWNED_COMBOS 至少要含 Mod+P（打印）与 Mod+Shift+F（专注模式）'
  )

  const root = path.join(__dirname, '..')
  const mainSrc = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf-8')
  report.check(
    'main-no-longer-calls-watchWindowShortcuts',
    !/^\s*optimizer\.watchWindowShortcuts\(/m.test(mainSrc),
    'main/index.ts 里还在整包挂 watchWindowShortcuts → DevTools/刷新的键盘入口会一起回来'
  )
  report.check(
    'main-wires-explicit-shortcut-policy',
    mainSrc.includes('blockedShortcut(input)') && mainSrc.includes('comboLabel(input)')
  )
  report.check(
    'main-no-more-dev-shortcuts',
    !mainSrc.includes('devShortcut('),
    'devShortcut（开发态保留 Ctrl+R/F5/F11）已按新口径删除，不许回来'
  )
  report.check(
    'main-gates-mouse-zoom',
    mainSrc.includes('setVisualZoomLevelLimits(1, 1)') &&
      mainSrc.includes(`on('zoom-changed'`) &&
      mainSrc.includes('setZoomFactor(1)'),
    'Ctrl+滚轮/捏合缩放的两道闸（限制 + 复位）必须在'
  )

  const toolbarSrc = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'src', 'components', 'Toolbar.vue'),
    'utf-8'
  )
  report.check(
    'toolbar-button-calls-openDevTools-api',
    toolbarSrc.includes('data-open-devtools') &&
      toolbarSrc.includes(`t('toolbar.openDevTools')`) &&
      toolbarSrc.includes('window.luminAPI.app.openDevTools()'),
    '工具栏那枚按钮必须真的调 window.luminAPI.app.openDevTools()'
  )

  const ipcSrc = fs.readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf-8')
  report.check(
    'main-registers-openDevTools-ipc-detached',
    ipcSrc.includes(`ipcMain.handle('app:openDevTools'`) && ipcSrc.includes(`mode: 'detach'`),
    '主进程必须注册 app:openDevTools 并用 mode: detach（内嵌会挤坏布局）'
  )

  // 打印键：**故意不拦**（应用自己绑了 Mod+P → 「打印…」）。这里只做静态确认，
  // 不在自动化里真按 Ctrl+P —— 那会真的走到 `webContents.print()`（原生打印对话框）。
  const keymapSrc = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'src', 'composables', 'useKeymap.ts'),
    'utf-8'
  )
  report.check(
    'app-still-owns-ctrl-p-print',
    keymapSrc.includes(`defaultKeys: 'Mod+P'`) && policy.print === null,
    'Ctrl+P 是应用自己的打印键：不许拦（详见 shortcuts.ts 的说明）'
  )

  await ensureClosed(app)

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
