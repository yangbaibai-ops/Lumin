'use strict'
// 验收：开发者工具的入口与"取消 F12"
//
// 用户口径原话：「取消点击 F12 出现开发者工具的功能，取而代之的是在顶部工具栏中添加一项：
// '打开开发者工具'，点击就出现开发者工具。」
//
// 四组断言：
//   A 工具栏里**真的有**那一项（语义锚点 `[data-open-devtools]` + aria-label 来自语言包），
//     且点击真的走 `window.luminAPI.app.openDevTools()`（这是主进程 IPC，可观测）；
//   B 点击之后 CDP 的 `/json/list` 里**多出一个 devtools 目标**（真的开起来了，不是只调了个 IPC）；
//   C 再点一次**不报错**（主进程 `isDevToolsOpened()` 分支；不做二态切换，见 Toolbar.vue 的说明）；
//   D **F12 不再出现 DevTools 目标**（用户要取消的那条；改前这里必红）+ 源码里 `watchWindowShortcuts`
//     已被显式策略取代（防止有人把它整包换回来）。
//
// 为什么用 `/json/list` 的 target 数而不是"看界面"：DevTools 是独立窗口（`mode: 'detach'`），
// 页面侧看不见它；调试端口的目标列表是唯一**跨进程**可观测的事实。
//
// 跑法：`node tools/run-suites.js --suite=_verify-devtools.js`（运行器会起隔离实例）。
// F12 那一段要**真实按键**：拿不到 OS 焦点时如实 SKIP 该段（不算失败，见 harness 的口径）。
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
  instanceLog
} = require('./lib/harness')
const { blockedShortcut } = require('../src/shared/shortcuts.ts')

/**
 * 读主进程日志里所有 `[devtools] opened …` 行，解析成 `{ windowId, already }`。
 *
 * 为什么读它：主进程开的 DevTools 是**独立窗口**，页面侧看不见也摸不到，
 * 而 `contextBridge` 暴露的 API 对象是**只读**的（不能 monkey-patch 来计数 ——
 * 第一版就是这么拿到一个恒空的计数数组、断言假红而 DevTools 其实已经开起来了）。
 * 主进程在 `app:openDevTools` 里打了一行 ASCII 日志，那既是"IPC 真的到了主进程"的证据，
 * 也带得出返回值语义（第二次点击应当 already=true）。路径见 harness 的 `instanceLog()`。
 */
function readOpenedLines(logPath) {
  if (!logPath) return []
  let text = ''
  try {
    text = fs.readFileSync(logPath, 'utf-8')
  } catch {
    return []
  }
  const out = []
  for (const m of text.matchAll(/\[devtools\] opened window=(\d+) already=(true|false)/g)) {
    out.push({ windowId: Number(m[1]), already: m[2] === 'true' })
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

/** 按一次 F12（真实的 Input.dispatchKeyEvent，走主进程的 before-input-event） */
async function pressF12(app) {
  const base = { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123, nativeVirtualKeyCode: 123 }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(1200)
}

/** 确保 DevTools 是关着的（用被测应用自己的 IPC，不 kill 进程、也不碰 target）：返回是否已关 */
async function ensureClosed(app) {
  await app.ev(`(async () => await window.luminAPI.app.closeDevTools())()`)
  await waitNoDevTools(4000)
  return (await devToolsTargets()).length === 0
}

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('SKIP: 没有可用窗口')
    return 0
  }
  const { ev, send } = app
  const report = new Reporter('开发者工具：工具栏入口 / 真的能打开 / F12 不再触发')

  // 工具栏出厂是收起的（见 harness.showToolbar 的说明），先显式打开
  const shown = await showToolbar(app)
  report.check('toolbar-visible', shown === true)

  // ── A. 工具栏里真的有那一项 ────────────────────────────────────────────────
  // ⚠️ 工具栏根节点是 `overflow-x-auto`：窄窗口下**右边的固定入口（导出/设置，以及这一枚新按钮）
  // 会横向溢到可视区之外**，CDP 点击会落到窗口外（表现为"点了没反应"）——所以先 scrollIntoView，
  // 再取坐标；`inViewport` 也把左右两边一起判（漏判左右正是本套件第一次跑时的假红原因）。
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
      hasIcon: !!btn.querySelector('svg'),
      isToolbarItem: !!btn.closest('[data-toolbar-item]')
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
  // 判据是**跨进程**的两条，刻意不在页面里 monkey-patch `window.luminAPI`：
  //   * 调试端口的目标列表里多出一个 devtools 目标（DevTools 是独立窗口，页面侧看不见它）；
  //   * **主进程自己那行日志** `[devtools] opened window=N already=…`（`main/ipc.ts` 里打的），
  //     它是"渲染层 → IPC → 主进程"这条链真的走通了的直接证据，也带得出返回值语义
  //     （第二次点击时主进程应当报 already=true）。
  // 为什么不去覆盖 `window.luminAPI.app.openDevTools` 计数：`contextBridge.exposeInMainWorld`
  // 暴露出去的对象是**只读**的，赋值会静默失败（第一版就是这么拿到一个恒空的计数数组，
  // 断言假红而 DevTools 其实已经开起来了）。
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
    console.log(
      'B-MAIN-LOG ' + JSON.stringify({ path: logPath, before: beforeLog, after: afterLog })
    )
    if (!logPath) {
      // 手工起实例（没走 run-suites）时拿不到实例日志：如实 SKIP，不伪造 FAIL
      report.skip('click-reaches-main-ipc', '没有 LUMIN_ISOLATED_USERDATA，读不到实例日志')
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
    console.log('C-AFTER-SECOND-CLICK ' + JSON.stringify({ log: log2, devtoolsTargets: dtTargets2.length }))
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

    // 收尾：关掉 DevTools（别把独立窗口留在桌面上，也别影响后面的套件）
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

  // ── D. F12 不再出现 DevTools ──────────────────────────────────────────────
  // 判据是**跨进程**的：调试端口的目标列表里不许多出 devtools。
  // F12 要真实按键才走得到 `before-input-event`，所以先取焦点；拿不到就如实 SKIP 这一段
  // （环境抖动，不是产品缺陷 —— 口径见 harness 的 ensureFocus 说明）。
  const focused = await ensureFocus(app)
  report.note(`F12 段：focused=${focused}`)
  if (!focused) {
    report.skip('f12-does-not-open-devtools', '窗口拿不到 OS 焦点（CDP 注入的 F12 会丢）')
  } else {
    const f12Targets = await devToolsTargets()
    report.check(
      'precondition-no-devtools-before-f12',
      f12Targets.length === 0,
      JSON.stringify(f12Targets.map((t) => t.url))
    )
    await pressF12(app)
    const afterF12 = await devToolsTargets()
    console.log(
      'D-F12 devtoolsTargets=' +
        afterF12.length +
        ' ' +
        JSON.stringify(afterF12.map((t) => ({ type: t.type, url: String(t.url).slice(0, 60) })))
    )
    report.check(
      'f12-does-not-open-devtools',
      afterF12.length === 0,
      'F12 之后多出了 devtools 目标：' + JSON.stringify(afterF12.map((t) => t.url))
    )
  }

  // ── E. 接线层面的守卫：污染不了的静态事实（页面里 monkey-patch 不了 contextBridge）──
  //   * 两条键策略：F12 与 Ctrl+Shift+I 必须被屏蔽；
  //   * `watchWindowShortcuts` 没有被整包换回来（换回来 = DevTools 的键盘入口全回来了）；
  //   * 渲染层那枚按钮真的调 `window.luminAPI.app.openDevTools`；
  //   * 主进程真的注册了 `app:openDevTools` 且用 `mode: 'detach'`。
  const policy = {
    f12: blockedShortcut({ type: 'keyDown', key: 'F12' }),
    ctrlShiftI: blockedShortcut({ type: 'keyDown', key: 'i', control: true, shift: true })
  }
  console.log('E-POLICY ' + JSON.stringify(policy))
  report.check('policy-blocks-f12', policy.f12 === true, JSON.stringify(policy))
  report.check('policy-blocks-ctrl-shift-i', policy.ctrlShiftI === true, JSON.stringify(policy))

  const root = path.join(__dirname, '..')
  const mainSrc = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf-8')
  report.check(
    'main-no-longer-calls-watchWindowShortcuts',
    !/^\s*optimizer\.watchWindowShortcuts\(/m.test(mainSrc),
    'main/index.ts 里还在整包挂 watchWindowShortcuts → DevTools 的键盘入口会一起回来'
  )
  report.check(
    'main-wires-explicit-shortcut-policy',
    mainSrc.includes('blockedShortcut(input)') && mainSrc.includes('devShortcut(input)')
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
    ipcSrc.includes(`ipcMain.handle('app:openDevTools'`) &&
      ipcSrc.includes(`mode: 'detach'`),
    '主进程必须注册 app:openDevTools 并用 mode: detach（内嵌会挤坏布局）'
  )

  await ensureClosed(app)

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
