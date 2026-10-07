'use strict'
// 验收：**浏览器/Electron 自带功能的取消**（开发者工具的入口 + 刷新族/缩放/查看源码…）
//
// 用户口径（三轮）：
//   * 「取消点击 F12 出现开发者工具的功能，取而代之的是在顶部工具栏中添加一项：
//     '打开开发者工具'，点击就出现开发者工具。」（第三轮）
//   * 「取消 Electron/Chromium 自带但本项目不需要的功能」，点名「按 Ctrl+R 刷新页面」。（第四轮）
//   * 「并不是在编辑快捷工具栏中，而是在应用的顶部栏中的'帮助'里添加。」（第五轮 ——
//     入口从编辑区快捷工具栏**搬到顶部栏「帮助」菜单**，那枚工具栏按钮已移除）
//
// 断言分组：
//   A 入口在**顶部栏 → 帮助**里：`[data-menu-item="menu.openDevTools"]`（语言无关的语义锚点），
//     并且**反向**断言编辑区快捷工具栏里**不再有**那枚按钮（防止两边都留）
//   B 真实点击路径：点「帮助」→ 点该项 → 主进程日志 + CDP `/json/list` 多出一个 devtools 目标
//   C 再点一次**不报错**（主进程 `isDevToolsOpened()` 分支报 already=true）
//   D DevTools 族（F12 / Ctrl+Shift+I）不再产生 devtools 目标 + F7/F11 留下被拦日志
//   E 查看源码 Ctrl+U 不产生新窗口/新目标
//   F 缩放键（Ctrl+= / Ctrl+- / Ctrl+0）与 Ctrl+滚轮不改变缩放
//   G **应用自己的快捷键仍然有效**（Ctrl+Shift+B 侧栏 / Ctrl+, 设置 / Ctrl+Shift+F 专注模式）
//   H **Ctrl+R / F5 不重载**：页面标记 `window.__reloadProbe` 必须还在（最硬的判据）
//   I 策略与接线的静态守卫（拦截桶、`watchWindowShortcuts` 没回来、缩放的鼠标闸在、入口只在一处）
//
// 为什么大量用"跨进程"判据：DevTools 是独立窗口、刷新会换掉整棵文档、缩放属于 webContents
// 状态 —— 页面侧要么看不见要么会自证，所以主进程日志（`[shortcuts] blocked …` /
// `[devtools] opened …`）与调试端口的目标列表才是证据。两者都用 `instanceLog()` 读。
//
// 跑法：`node tools/run-suites.js --suite=_verify-devtools.js`（运行器会起隔离实例 + 传日志路径）。
// D~H 段要**真实按键**：拿不到 OS 焦点时如实 SKIP（不算失败，见 harness 的 ensureFocus 口径）。
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

/** 顶部栏「帮助」一级按钮 / 菜单项锚点（都是语义锚点，不按本地化文字找） */
const HELP_GROUP = '[data-topmenu-group="h"]'
const HELP_DEVTOOLS_ITEM = '[data-menu-item="menu.openDevTools"]'

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

/** 点页面坐标（真实鼠标：move → press → release） */
async function clickPoint(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}

/**
 * 取某个选择器的中心点（不存在返回 null）。
 * 用 `JSON.stringify(selector)` 把选择器注入页面表达式 —— 页面侧那段代码里**不能有反引号**
 * （它在 Node 的模板字符串里）。
 */
async function centerOfSelector(ev, selector) {
  const raw = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      text: (el.textContent || '').trim()
    })
  })()`)
  return raw ? JSON.parse(raw) : null
}

/**
 * 走一遍**真实点击路径**：点顶部栏的「帮助」一级按钮 → 点下拉里的目标项。
 *
 * 为什么不用 `window.__L` 直接调 store/命令（那样更"稳"）：这一条验收的对象就是
 * 「用户点得到吗」—— 菜单是 Teleport 到 body 的浮层，`onDocDown` 会用
 * `.topmenu-root` / `.topmenu-drop` 判定"是不是菜单内部"，这些**只有真实点击才走得到**。
 */
async function clickHelpMenuItem(app, itemSelector, settleMs = 600) {
  const { ev, send } = app
  const group = await centerOfSelector(ev, HELP_GROUP)
  if (!group) return { ok: false, why: 'NO_HELP_GROUP' }
  await clickPoint(send, group.x, group.y)
  await sleep(350)
  const item = await centerOfSelector(ev, itemSelector)
  if (!item) return { ok: false, why: 'NO_MENU_ITEM', group }
  await clickPoint(send, item.x, item.y)
  await sleep(settleMs)
  return { ok: true, group, item }
}

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('SKIP: 没有可用窗口')
    return 0
  }
  const { ev, send } = app
  const report = new Reporter(
    '浏览器自带功能：DevTools 入口（顶部栏 → 帮助）/ 刷新族 / 缩放 / 查看源码 / 不误伤应用键'
  )

  // 工具栏出厂是收起的（见 harness.showToolbar 的说明），先显式打开 —— 本段要用它做
  // **反向断言**（"编辑区快捷工具栏里不再有那枚按钮"），工具栏必须真的在才说明问题。
  const shown = await showToolbar(app)
  report.check('toolbar-visible', shown === true)

  // ── A. 入口在「顶部栏 → 帮助」里，且工具栏里**不再有** ──────────────────────
  const anchors = await ev(`(() => {
    const bar = document.querySelector('[data-editor-toolbar]')
    return JSON.stringify({
      toolbarPresent: !!bar,
      toolbarHasOldButton: !!(bar && bar.querySelector('[data-open-devtools]')),
      // 菜单没展开时该项不该游离在 DOM 里（证明它在菜单里，而不是别处的全局元素）
      itemBeforeOpen: !!document.querySelector('[data-menu-item="menu.openDevTools"]'),
      helpButton: !!document.querySelector('[data-topmenu-group="h"]')
    })
  })()`).then(JSON.parse)
  console.log('A-ANCHORS ' + JSON.stringify(anchors))
  report.check('toolbar-present-for-reverse-check', anchors.toolbarPresent === true)
  report.check(
    'toolbar-no-longer-has-open-devtools-button',
    anchors.toolbarPresent === true && anchors.toolbarHasOldButton === false,
    '编辑区快捷工具栏里还留着一枚「打开开发者工具」按钮（用户要求它只在顶部栏帮助里）'
  )
  report.check('topmenu-has-help-group', anchors.helpButton === true)
  report.check(
    'help-item-not-rendered-before-open',
    anchors.itemBeforeOpen === false,
    '菜单没展开时该项就已经在 DOM 里 —— 它可能不在帮助菜单内部'
  )

  // 展开帮助，确认目标项**在这个下拉里**（锚点 = i18n 键，与语言无关）
  const logPath = instanceLog()
  const beforeTargets = await targets()
  const beforeLog = readOpenedLines(logPath)
  const help = await centerOfSelector(ev, HELP_GROUP)
  report.check('help-group-clickable', !!help, JSON.stringify(help))
  if (help) {
    await clickPoint(send, help.x, help.y)
    await sleep(350)
  }
  const itemProbe = await ev(`(() => {
    const el = document.querySelector('[data-menu-item="menu.openDevTools"]')
    // 顶部栏的下拉容器是 .topmenu-drop（组件自己在 onDocDown 里就用它判定"点击是否在菜单内"；
    // 这里刻意不写 [role="menu"] —— 顶部栏那层没加 role，只有右键菜单那套组件才有）
    const panelOf = (node) => (node ? node.closest('.topmenu-drop') : null)
    if (!el) {
      const panel = document.querySelector('.topmenu-drop')
      return JSON.stringify({
        found: false,
        panelItems: panel
          ? [...panel.querySelectorAll('[data-menu-item]')].map((x) => x.getAttribute('data-menu-item'))
          : []
      })
    }
    const r = el.getBoundingClientRect()
    const panel = panelOf(el)
    return JSON.stringify({
      found: true,
      inMenu: !!panel,
      // 面板里都有哪些项（帮助菜单的实测内容，留作证据）
      panelItems: panel
        ? [...panel.querySelectorAll('[data-menu-item]')].map((x) => x.getAttribute('data-menu-item'))
        : [],
      label: (el.textContent || '').trim(),
      hasIcon: !!el.querySelector('svg'),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2)
    })
  })()`).then(JSON.parse)
  console.log('A-HELP-MENU ' + JSON.stringify(itemProbe))
  report.check('help-menu-has-open-devtools-item', itemProbe.found === true, JSON.stringify(itemProbe))
  report.check('item-lives-inside-a-menu-panel', itemProbe.inMenu === true, JSON.stringify(itemProbe))
  report.check('item-has-icon', itemProbe.hasIcon === true)

  // ── B. 点它 → devtools 目标 + 主进程日志 + **焦点不许被顶部栏抢走** ─────────
  // 焦点读数（用户报障第五/八轮："点击后焦点紧接着被顶部栏的『文件』抢走 / 会短暂闪一下"）：
  // 前后各读一次，把"焦点去哪了"钉成数据。判据用 `activeElement` 的**结构**（是否在
  // 顶部栏容器 `.topmenu-root` 里 / 是否在编辑面里），不依赖文案与语言。
  const FOCUS_PROBE = `(() => {
    const el = document.activeElement
    if (!el) return JSON.stringify({ none: true })
    return JSON.stringify({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 40),
      topmenuGroup: el.getAttribute ? el.getAttribute('data-topmenu-group') : null,
      inTopBar: !!(el.closest && el.closest('.topmenu-root')),
      inEditor: !!(el.closest && el.closest('.ProseMirror')),
      isSourceEditor: el.tagName === 'TEXTAREA' && String(el.className || '').includes('source-editor'),
      text: (el.textContent || '').trim().slice(0, 16)
    })
  })()`
  const readFocus = async (label) => {
    const raw = await ev(FOCUS_PROBE)
    const parsed = JSON.parse(raw)
    console.log(label + ' ' + raw)
    return parsed
  }

  /**
   * 焦点"闪烁"的记录器（用户报障第八轮）：**从点击那一刻起**把每一次焦点变化记下来，
   * 并且**逐帧**采样 `document.activeElement` —— 后者才是"用户看到什么"的判据：
   * 若某一帧的 `activeElement` 落在顶部栏里，那一帧就会画出焦点环（=用户看到的那一闪）。
   *
   * 为什么要同时记 `focusin` 与帧：焦点会被浏览器在**窗口重新激活**时挪到"文档里第一个可聚焦
   * 元素"（实测应用侧 `focus()` 调用 0 次），这件事拦不住；能保证的是"同一任务里挪回去"，
   * 于是那一帧绘制时读到的已经是编辑面 —— 判据就落在"有没有哪一帧画在顶部栏"上。
   */
  const FOCUS_RECORDER_INSTALL = `(() => {
    window.__focusRec = { events: [], frames: [], calls: [] }
    window.__focusT0 = performance.now()
    const at = () => Math.round(performance.now() - window.__focusT0)
    const d = (el) => ({
      tag: el ? el.tagName : null,
      group: el && el.getAttribute ? el.getAttribute('data-topmenu-group') : null,
      top: !!(el && el.closest && el.closest('.topmenu-root')),
      ed: !!(el && el.closest && el.closest('.ProseMirror')),
      text: el ? String(el.textContent || '').trim().slice(0, 12) : ''
    })
    const rec = (why, el) => window.__focusRec.events.push(Object.assign({ why, t: at() }, d(el)))
    document.addEventListener('focusin', (e) => rec('focusin', e.target), true)
    document.addEventListener('focusout', (e) => rec('focusout', e.target), true)
    window.addEventListener('blur', () => rec('window-blur', document.activeElement))
    window.addEventListener('focus', () => rec('window-focus', document.activeElement))
    // 帧采样：rAF 回调在绘制**之前**跑，所以"这一帧采样到顶部栏"≈"这一帧会画出它的焦点环"
    const tick = () => {
      window.__focusRec.frames.push(Object.assign({ t: at() }, d(document.activeElement)))
      window.__focusRaf = requestAnimationFrame(tick)
    }
    window.__focusRaf = requestAnimationFrame(tick)
    // 应用侧主动 focus() 的调用日志（区分"应用挪的"与"浏览器挪的"）
    const orig = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function () {
      window.__focusRec.calls.push(Object.assign({ t: at() }, d(this)))
      return orig.apply(this, arguments)
    }
    window.__focusReset = () => {
      window.__focusRec = { events: [], frames: [], calls: [] }
      window.__focusT0 = performance.now()
    }
    return 'ok'
  })()`
  const FOCUS_RECORDER_RESET = `(() => { window.__focusReset(); return 'ok' })()`
  const FOCUS_RECORDER_READ = `JSON.stringify(window.__focusRec)`

  if (itemProbe.found) {
    // 点击**前**的焦点（此时应该在刚点过的「帮助」分组按钮上 —— 那是菜单自己的正常状态）
    await readFocus('B-FOCUS-BEFORE-CLICK')
    // 装记录器并清零：**从点击这一刻起**算（「帮助」按钮上那次焦点是用户自己点的，不算）
    await ev(FOCUS_RECORDER_INSTALL)
    await ev(FOCUS_RECORDER_RESET)
    await clickPoint(send, itemProbe.x, itemProbe.y)
    await sleep(600)

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
      'help-menu-click-opens-devtools-target',
      opened.length >= 1 && afterTargets.length > beforeTargets.length,
      JSON.stringify({ before: beforeTargets.length, after: afterTargets.length })
    )

    // ★ 焦点回归（用户报障的那条）：等激活抖动过去再读一次。
    // 因果链：① 菜单项被移除 → 焦点落 body；② DevTools（detach 窗口）让主窗口 blur→focus，
    // Chromium 在重新激活时把焦点给**文档里第一个可聚焦元素** = 顶部栏「文件」。
    // 抖动的实测时长：devtools 目标出现后 ~160ms 内完成（两次 blur/focus 到 617ms）。
    await sleep(1500)
    const focusAfter = await readFocus('B-FOCUS-AFTER-OPEN')
    report.check(
      'open-devtools-does-not-steal-focus-to-topbar',
      focusAfter.inTopBar === false && focusAfter.topmenuGroup === null,
      '打开开发者工具后焦点落在顶部栏里：' + JSON.stringify(focusAfter)
    )
    report.check(
      'open-devtools-returns-focus-to-editor',
      focusAfter.inEditor === true || focusAfter.isSourceEditor === true,
      '打开开发者工具后焦点应回到编辑面，实测：' + JSON.stringify(focusAfter)
    )

    // ── B3. 焦点"闪烁"（用户报障第八轮）：**有没有哪一帧把焦点环画在顶部栏上** ──────
    // 判据：从点击那一刻起逐帧采样 `document.activeElement`；只要有**任何一帧**落在顶部栏里，
    // 那一帧就会画出焦点环 —— 用户看到的就是那一下闪。
    const rec = JSON.parse(await ev(FOCUS_RECORDER_READ))
    /**
     * 只看**窗口第一次失活之后**的帧：在这之前顶部栏可能本来就拿着焦点 ——
     * 用户点「帮助」打开菜单时，焦点按菜单的正常行为落在 `[data-topmenu-group="h"]` 上，
     * 那不是"被抢"，是用户自己点的（记录器是从点菜单项那一刻清零的，但那次点击的焦点交接
     * 可能还差一两帧才完成）。真正要防的是**浏览器在窗口重新激活时把焦点塞给顶部栏**，
     * 而那只可能发生在失活之后。
     */
    const firstBlur = rec.events.find((e) => e.why === 'window-blur')
    const tBlur = firstBlur ? firstBlur.t : null
    const allTopFrames = rec.frames.filter((f) => f.top)
    const topFrames = rec.frames.filter((f) => f.top && (tBlur === null || f.t >= tBlur))
    const topFocusIns = rec.events.filter((e) => e.why === 'focusin' && e.top && (tBlur === null || e.t >= tBlur))
    const topFocusOuts = rec.events.filter(
      (e) => e.why === 'focusout' && e.top && (tBlur === null || e.t >= tBlur)
    )
    const activationCycle = rec.events.filter(
      (e) => e.why === 'window-blur' || e.why === 'window-focus'
    ).length
    const focusCallsOnTopBar = rec.calls.filter((c) => c.top).length
    console.log(
      'B3-FOCUS-TIMELINE ' +
        JSON.stringify({
          activationCycleEvents: activationCycle,
          firstBlurT: tBlur,
          frames: rec.frames.length,
          allTopbarFrames: allTopFrames,
          topbarFramesAfterBlur: topFrames,
          topbarFocusIns: topFocusIns,
          topbarFocusOuts: topFocusOuts,
          focusCalls: rec.calls.length,
          focusCallsOnTopBar,
          events: rec.events
        })
    )
    if (activationCycle === 0) {
      // 本轮 DevTools 没抢到前台（没发生失活/激活）：焦点压根没被挪，这条断言无对象 —— 如实 SKIP
      report.skip(
        'no-painted-frame-with-topbar-focus',
        '本轮没观察到窗口失活/激活循环（DevTools 没抢到前台），焦点不会被挪'
      )
      report.skip('topbar-focus-is-corrected-same-task', '同上')
    } else {
      report.check(
        'no-painted-frame-with-topbar-focus',
        topFrames.length === 0,
        '有 ' +
          topFrames.length +
          ' 帧的焦点落在顶部栏（用户会看到焦点环闪一下）：' +
          JSON.stringify(topFrames.slice(0, 5))
      )
      // 每一次"被浏览器塞进顶部栏"的 focusin，都必须在同一任务内被纠正掉（focusout 紧随其后，
      // 时间差 ≤5ms；实测 0ms）——这才是"那一帧不会画出焦点环"的机制保证
      const corrected = topFocusIns.every((fi) => {
        const fo = topFocusOuts.find((f) => f.t >= fi.t)
        return !!fo && fo.t - fi.t <= 5
      })
      report.check(
        'topbar-focus-is-corrected-same-task',
        topFocusIns.length === 0 || corrected,
        '顶部栏 focusin 后没有在同一任务内被纠正：' +
          JSON.stringify({ topFocusIns, topFocusOuts })
      )
    }
    // 反向栅栏：纠正必须由**应用**完成（记录器里的 `focus()` 调用），且应用从不把焦点放到顶部栏
    report.check(
      'app-refocuses-editor-and-never-focuses-topbar',
      rec.calls.some((c) => c.ed) && focusCallsOnTopBar === 0,
      '应用侧 focus() 调用：' + JSON.stringify(rec.calls)
    )

    const afterLog = readOpenedLines(logPath)
    console.log('B-MAIN-LOG ' + JSON.stringify({ path: logPath, before: beforeLog, after: afterLog }))
    if (!logPath) {
      // 手工起实例（没走 run-suites）时拿不到实例日志：如实 SKIP，不伪造 FAIL
      report.skip('help-menu-click-reaches-main-ipc', '没有 LUMIN_INSTANCE_LOG，读不到实例日志')
      report.skip('second-click-reports-already-open', '同上')
    } else {
      report.check(
        'help-menu-click-reaches-main-ipc',
        afterLog.length === beforeLog.length + 1 && afterLog[afterLog.length - 1].already === false,
        JSON.stringify({
          before: beforeLog.length,
          after: afterLog.length,
          last: afterLog[afterLog.length - 1]
        })
      )
    }

    // ── C. 再点一次：主进程走 isDevToolsOpened 分支，报 already=true ──────────
    const again = await clickHelpMenuItem(app, HELP_DEVTOOLS_ITEM, 700)
    report.check('help-menu-can-be-opened-again', again.ok === true, JSON.stringify(again))
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
    // 第二次点击（DevTools 已开、主进程走 already=true 分支）也要守住焦点口径
    const focusAfterSecond = await readFocus('C-FOCUS-AFTER-SECOND-CLICK')
    report.check(
      'second-click-focus-still-not-in-topbar',
      focusAfterSecond.inTopBar === false && focusAfterSecond.topmenuGroup === null,
      JSON.stringify(focusAfterSecond)
    )

    // 收尾：关掉 DevTools（别把独立窗口留在桌面上，也别影响后面的断言）
    const closed = await ensureClosed(app)
    report.check('devtools-can-be-closed', closed === true)
  } else {
    // 菜单项找不到时，后面几段的**前提**就不成立：如实 SKIP，不伪造 FAIL
    for (const name of [
      'help-menu-click-opens-devtools-target',
      'open-devtools-does-not-steal-focus-to-topbar',
      'open-devtools-returns-focus-to-editor',
      'no-painted-frame-with-topbar-focus',
      'topbar-focus-is-corrected-same-task',
      'app-refocuses-editor-and-never-focuses-topbar',
      'help-menu-click-reaches-main-ipc',
      'help-menu-can-be-opened-again',
      'second-click-reports-already-open',
      'second-click-keeps-exactly-one-devtools',
      'second-click-focus-still-not-in-topbar',
      'devtools-can-be-closed'
    ]) {
      report.skip(name, '帮助菜单里没有 `menu.openDevTools` 那一项')
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

  // 入口位置的静态守卫（第五轮把入口从编辑区工具栏**搬到顶部栏 → 帮助**）：
  //   * `TopMenuBar.vue` 的帮助组里必须有 `menu.openDevTools` 这一项、且真的调 IPC；
  //   * `Toolbar.vue` 里**不许**再出现那枚按钮/那个键（"两边都留"是这一轮要防的回归）。
  const menuBarSrc = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'src', 'components', 'TopMenuBar.vue'),
    'utf-8'
  )
  report.check(
    'topmenu-help-item-calls-openDevTools-api',
    menuBarSrc.includes(`labelKey: 'menu.openDevTools'`) &&
      menuBarSrc.includes('window.luminAPI.app.openDevTools()'),
    '帮助菜单里那一项必须真的调 window.luminAPI.app.openDevTools()'
  )
  report.check(
    'topmenu-leaf-has-semantic-anchor',
    menuBarSrc.includes(':data-menu-item='),
    '叶子菜单项要带 data-menu-item 语义锚点（验收脚本不按本地化文字找）'
  )

  const toolbarSrc = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'src', 'components', 'Toolbar.vue'),
    'utf-8'
  )
  report.check(
    'toolbar-no-longer-mentions-openDevTools',
    !toolbarSrc.includes('openDevTools') && !toolbarSrc.includes('data-open-devtools'),
    '编辑区快捷工具栏里还留着「打开开发者工具」（按钮/键名/逻辑应已全部移除）'
  )

  const ipcSrc = fs.readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf-8')
  report.check(
    'main-registers-openDevTools-ipc-detached',
    ipcSrc.includes(`ipcMain.handle('app:openDevTools'`) && ipcSrc.includes(`mode: 'detach'`),
    '主进程必须注册 app:openDevTools 并用 mode: detach（内嵌会挤坏布局）'
  )

  // i18n：键从 `toolbar.openDevTools` 改名为 `menu.openDevTools`（文本级增删）。
  // 这里守"旧键已删、新键三语都在"（`tests/i18nKeys` 那两条会守"新键有引用、旧键无残留"）。
  const packs = ['zh-CN', 'en-US', 'ru-RU'].map((lang) => ({
    lang,
    text: fs.readFileSync(path.join(root, 'src', 'shared', 'i18n', `${lang}.json`), 'utf-8')
  }))
  report.check(
    'i18n-key-renamed-to-menu-namespace',
    packs.every(
      (p) =>
        p.text.includes('"openDevTools"') &&
        /"devtools":\s*"[^"]+",\s*\n\s*"openDevTools"/.test(p.text) &&
        !/"groupInsert":\s*"[^"]+",\s*\n\s*"openDevTools"/.test(p.text)
    ),
    '三份语言包都该是「menu.openDevTools 在 devtools 之后、toolbar 里那份已删」'
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
