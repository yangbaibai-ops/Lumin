'use strict'
// ─── 验收：快捷键「改绑」的显示 / 生效两条链（用户实测 bug 的回归钉）────────────────
//
// 用户原话：「快捷键功能是假的，我点击并重新输入快捷键后，显示的快捷键和实际使用中
// 依然是默认的」。这条现象其实是**三条独立的链**同时断掉，本套件逐条钉住：
//
//   ① 设置界面里显示的键位（SettingsKeymap 的 computed 依赖）
//      —— 改绑后必须**立刻**变成新键，不需要切页签/重开设置/重启；
//   ② 真实按键走的键位（lib/keymap/service 的命中表）
//      —— 新键立刻生效、旧键立刻让位（防「新旧都生效」）；
//   ③ 「旧键仍然按默认行为工作」的第二个真相（GlobalSearch 里那份硬编码 Ctrl+Shift+P）
//      —— 命令表之外的键位监听一律不许有：它会让「改绑/解绑」在旧键上看起来没生效。
//
// 另有一条**默认键唯一性**断言：同一档里两条命令拿同一个默认键时，改绑其中一条，
// 旧键会被另一条「接管」——用户看到的就是「改绑了但按旧键还是默认行为」。
//
// 为什么不去页面上动态取源码模块（那要 5173 上的 dev server）：套件就只能进 needs-dev 档、
// 默认矩阵永远不跑它（本轮的 bug 正是这样漏到今天）。这里全部走 **DOM + store + 真实按键**，
// 构建产物（out/renderer）下即可跑，所以登记进 run-suites.js 的 DEFAULT_SUITES。
//
// 跑法：`node tools/run-suites.js --suite=_verify-keymap-custom.js`（运行器会起隔离实例）
const fs = require('fs')
const path = require('path')
const {
  connect,
  attach,
  appPages,
  settle,
  sleep,
  ensureFocus,
  pressKey,
  bringToFront,
  openDocWith,
  Reporter,
  fatal
} = require('./lib/harness')

const ROOT = path.join(__dirname, '..')

const report = new Reporter('快捷键改绑：显示 / 生效 / 单一真相源')

/** 页面侧：某条命令那一行现在显示的键位胶囊（'Ctrl+Alt+J'）；没有该行返回 NO-ROW */
function chipsExpr(commandId) {
  const sel = '.key-row[data-command="' + commandId + '"]'
  return (
    '(function(){var r=document.querySelector(' +
    JSON.stringify(sel) +
    ');if(!r)return "NO-ROW";' +
    'return Array.prototype.map.call(r.querySelectorAll(".key-chip"),function(k){return k.textContent.trim()}).join("+")})()'
  )
}

/** 页面侧：点某行第 n 个按钮（0=修改 / 1=恢复默认） */
function clickRowBtnExpr(commandId, index) {
  const sel = '.key-row[data-command="' + commandId + '"]'
  return (
    '(function(){var r=document.querySelector(' +
    JSON.stringify(sel) +
    ');if(!r)return "NO-ROW";r.scrollIntoView({block:"center"});' +
    'r.querySelectorAll("button")[' +
    index +
    '].click();return "ok"})()'
  )
}

/** 页面侧：有多少行带着「冲突」徽标（默认档下必须为 0 = 没有重复默认键） */
const CONFLICT_BADGES =
  'document.querySelectorAll(".key-row .text-warning-ink").length'

// CDP modifiers 是**位标志**：Alt=1 / Ctrl=2 / Meta=4 / Shift=8 ⇒ Ctrl+Shift = 10、Ctrl+Alt = 3
const KEYS = {
  'Ctrl+Alt+J': { key: 'j', code: 'KeyJ', vk: 74, modifiers: 2 | 1 },
  'Ctrl+Shift+F': { key: 'F', code: 'KeyF', vk: 70, modifiers: 2 | 8 },
  'Ctrl+Alt+9': { key: '9', code: 'Digit9', vk: 57, modifiers: 2 | 1 },
  'Ctrl+Shift+P': { key: 'P', code: 'KeyP', vk: 80, modifiers: 2 | 8 }
}

/**
 * ⚠️ **每一步都要能被看见**：CDP 的 `Runtime.evaluate` 在目标页崩掉/被重载时会**永不返回**
 * （socket 还开着、就是没人应答）。裸等下去的后果极其恶性 —— Node 的事件循环一空，
 * 进程**静默退出 0**，运行器只会看到"输出少了几条断言 + 退出码 0"，判成 **PASS**
 * （本轮实测：同一个套件在运行器里跑出过 14/14、11/11、7/7 三种结果，全是"绿的假象"）。
 * 所以：每次求值都带**超时**（超时 = 显式异常 → 由 fatal 记成 FAIL），
 * 并记下"最后走到哪一步"，进程真死了也能在退出时打印出来。
 */
let step = 'init'
const mark = (name) => {
  step = name
}
process.on('exit', (code) => {
  if (code !== 0 || report.total === 0 || !finished) {
    console.log('EXIT code=' + code + ' 最后完成的步骤=' + step + ' 已产出断言=' + report.total)
  }
})
let finished = false

/** 给任意 promise 套一个超时（默认 12s；CDP 单次往返正常在 100ms 内） */
function deadline(p, what, ms = 12000) {
  let timer = null
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('CDP/步骤超时（' + ms + 'ms）：' + what + '；最后完成的步骤=' + step)), ms)
    })
  ])
}

/** 真实敲一次组合键（CDP 注入的按键要窗口在前台才不丢，先提前台再发） */
async function tap(app, spec) {
  await bringToFront(app)
  await sleep(250)
  await deadline(pressKey(app.send, KEYS[spec]), 'pressKey ' + spec)
  await sleep(400)
}

/**
 * `app` 的**带超时代理**：所有 CDP 往返都走它，绝不裸等。
 * 为什么不是每个调用点各写一遍 `deadline(...)`：漏一个就又会回到"静默退出 0 被记成 PASS"，
 * 而这类漏洞只在目标页崩掉/重载时才显形 —— 一次写对、全场生效才是能守住的写法。
 */
function guarded(app) {
  return {
    page: app.page,
    close: () => app.close(),
    ev: (expr) => deadline(app.ev(expr), 'ev ' + String(expr).slice(0, 70)),
    send: (method, params) => deadline(app.send(method, params), 'send ' + method)
  }
}

/** 走真实用户路径改绑：点该行「修改」按钮 → 按一次新组合键 */
async function recordByKeyboard(app, commandId, spec) {
  const clicked = await app.ev(clickRowBtnExpr(commandId, 0))
  if (clicked !== 'ok') return false
  await sleep(300)
  const recording = await app.ev('!!document.querySelector(".key-recording")')
  await tap(app, spec)
  return recording === true
}

const openKeymapTab = async (app) => {
  await app.ev('window.__L.ui().openSettings("keymap")')
  await sleep(900)
}

const closeSettings = async (app) => {
  await app.ev('window.__L.ui().closeSettings()')
  await sleep(500)
}

const focusMode = (app) => app.ev('window.__L.ui().focusMode')
const focusClass = (app) => app.ev('!!document.querySelector(".typora-container.focus-mode")')

const FOCUS = 'view.focusMode'
const PALETTE = 'app.commandPalette'

;(async () => {
  // ── 静态：命令表之外**不许**再有第二份键位监听 ───────────────────────────────
  // 审计 D10 的现场：`GlobalSearch.vue` 曾在 document 上写死 Ctrl/Cmd+Shift+P，
  // 于是用户在设置里把 `edit.globalSearch` 改绑/解绑之后，按旧键**仍然**会打开全局搜索
  // ——「显示的键位」与「实际生效的键位」从此各说各话。这条断言把那个坑钉死。
  const gsSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'components', 'GlobalSearch.vue'),
    'utf-8'
  )
  const gsListeners = (gsSrc.match(/addEventListener\(\s*['"]keydown/g) || []).length
  report.check(
    'no-second-keybinding-source',
    gsListeners === 0,
    'GlobalSearch.vue 里 window/document 级 keydown 监听 = ' + gsListeners + '（键位真相只能有命令表那一份）'
  )

  const raw = await connect()
  const app = guarded(raw)
  mark('等页面就绪')
  if (!(await settle(app.ev))) {
    report.skip('全部断言', '页面没有就绪（ui.booting 未结束）')
    finished = true
    process.exit(report.finish())
  }
  mark('取焦点')
  if (!(await ensureFocus(app))) {
    report.skip('全部断言', '窗口拿不到 OS 焦点：CDP 注入的按键会丢（环境问题，不是产品缺陷）')
    finished = true
    process.exit(report.finish())
  }

  // 干净起点：清掉可能残留的用户覆盖与浮层状态（套件可重复运行），并开一份文档
  // （专注模式的 DOM 类名长在编辑器容器上，没有文档就量不到）
  mark('复位现场')
  await app.ev(
    '(function(){var u=window.__L.ui();u.focusMode=false;u.closeSettings();u.closeCommandPalette();u.closeGlobalSearch();' +
      'window.__L.settings().resetAllKeybindings();return "ok"})()'
  )
  await sleep(700)
  await openDocWith(app, '# keymap\n\nbody\n', 'keymap-custom.md')
  await sleep(400)

  // ── 0. 默认档：命令表渲染出来、且**没有重复默认键** ──────────────────────────
  mark('0 默认档')
  await openKeymapTab(app)
  const rows = await app.ev('document.querySelectorAll(".key-row").length')
  report.check('keymap-tab-renders', rows >= 20, 'rows=' + rows)
  const badges = await app.ev(CONFLICT_BADGES)
  report.check(
    'no-duplicate-default-keys',
    badges === 0,
    '默认档下带「冲突」徽标的行=' + badges + '（>0 说明两条命令占同一个默认键：改绑其中一条后，旧键会被另一条接管）'
  )
  const before = await app.ev(chipsExpr(FOCUS))
  report.note('改绑前 ' + FOCUS + ' 显示 = ' + before)

  // ── ① 显示：点「修改」→ 真按键 → 设置界面**立刻**显示新键 ────────────────────
  mark('① 改绑后显示立刻更新')
  const recorded = await recordByKeyboard(app, FOCUS, 'Ctrl+Alt+J')
  report.check('recorder-accepts-keys', recorded, '进入录制态并敲了 Ctrl+Alt+J')
  const afterChips = await app.ev(chipsExpr(FOCUS))
  report.check(
    'display-updates-immediately-after-rebind',
    afterChips === 'Ctrl+Alt+J',
    '改绑后立刻读设置界面 = ' + afterChips + '（期望 Ctrl+Alt+J；不切页签、不重开设置）'
  )
  const stored = await app.ev('JSON.stringify(window.__L.settings().keybindings)')
  report.note('store.keybindings = ' + stored)

  // ── ② 生效：真实按键发新键 → 命令真的执行（专注模式：store 旗标 + DOM 类名）────
  mark('② 新键真的执行')
  await closeSettings(app)
  const f0 = await focusMode(app)
  await tap(app, 'Ctrl+Alt+J')
  const f1 = await focusMode(app)
  const cls = await focusClass(app)
  report.check(
    'new-key-runs-command',
    f0 !== f1 && f1 === true && cls === true,
    'Ctrl+Alt+J: focusMode ' + f0 + ' -> ' + f1 + '，DOM .typora-container.focus-mode=' + cls
  )

  // ── ③ 旧键不再执行（防「新旧都生效」）────────────────────────────────────────
  mark('③ 旧键不再执行')
  await tap(app, 'Ctrl+Shift+F')
  const f2 = await focusMode(app)
  report.check(
    'old-key-no-longer-runs',
    f2 === f1,
    'Ctrl+Shift+F 之后 focusMode 仍是 ' + f2 + '（改绑前是 ' + f1 + '；变了=旧键还在跑）'
  )

  // ── ④ 「旧键仍按默认行为工作」的第二真相：把命令面板改绑走，旧键 Ctrl+Shift+P
  //       必须什么都不做（命令表之外不许再有人响应这个键）─────────────────────────
  mark('④ 旧键被真正让出')
  await openKeymapTab(app)
  await recordByKeyboard(app, PALETTE, 'Ctrl+Alt+9')
  await sleep(400)
  const paletteChips = await app.ev(chipsExpr(PALETTE))
  await closeSettings(app)
  await tap(app, 'Ctrl+Shift+P')
  const paletteOpen = await app.ev('window.__L.ui().commandPaletteOpen === true')
  const searchOpen = await app.ev('window.__L.ui().globalSearch.open === true')
  report.check(
    'former-default-key-freed',
    paletteOpen === false && searchOpen === false,
    '命令面板改绑成 ' +
      paletteChips +
      ' 后按 Ctrl+Shift+P：面板=' +
      paletteOpen +
      ' 全局搜索=' +
      searchOpen +
      '（任一为 true = 旧键还有第二个真相在响应）'
  )
  await tap(app, 'Ctrl+Alt+9')
  const paletteNewKey = await app.ev('window.__L.ui().commandPaletteOpen === true')
  report.check('rebound-key-opens-palette', paletteNewKey === true, 'Ctrl+Alt+9: 面板开=' + paletteNewKey)
  await app.ev('window.__L.ui().closeCommandPalette()')
  await sleep(400)

  // ── ⑤ 恢复默认：要有路径，且**显示立刻跟着回到默认** ─────────────────────────
  mark('⑤ 恢复默认')
  await openKeymapTab(app)
  const resetClicked = await app.ev(clickRowBtnExpr(FOCUS, 1))
  await sleep(600)
  const restoredChips = await app.ev(chipsExpr(FOCUS))
  report.check(
    'reset-restores-default-display',
    resetClicked === 'ok' && restoredChips === 'Ctrl+Shift+F',
    '点「恢复默认」后立刻读设置界面 = ' + restoredChips + '（期望 Ctrl+Shift+F）'
  )
  await closeSettings(app)
  const r0 = await focusMode(app)
  await tap(app, 'Ctrl+Shift+F')
  const r1 = await focusMode(app)
  report.check(
    'reset-restores-default-key',
    r0 !== r1,
    'Ctrl+Shift+F: focusMode ' + r0 + ' -> ' + r1
  )

  // ── ⑥ 持久化：重新改绑 → 落库 → reload → 显示与生效都还是新键 ────────────────
  mark('⑥ 持久化（reload）')
  await openKeymapTab(app)
  await recordByKeyboard(app, FOCUS, 'Ctrl+Alt+J')
  await closeSettings(app)
  await sleep(1400) // 落库是 250ms 节流，reload 前给它写完的时间
  const pageId = app.page.id
  await app.send('Page.reload')
  await sleep(2600)
  app.close()
  mark('⑥ reload 之后重连')
  const reloadedPage = (await appPages()).find((p) => p.id === pageId)
  if (!reloadedPage) throw new Error('reload 之后找不到同一个窗口')
  const app2 = guarded(await attach(reloadedPage))
  if (!(await settle(app2.ev))) throw new Error('reload 之后页面没有就绪')
  if (!(await ensureFocus(app2))) {
    report.skip('reload 之后的断言', '窗口拿不到 OS 焦点')
    finished = true
    process.exit(report.finish())
  }
  mark('⑥ reload 后读设置界面')
  await openKeymapTab(app2)
  const persistedChips = await app2.ev(chipsExpr(FOCUS))
  report.check(
    'custom-key-survives-reload-display',
    persistedChips === 'Ctrl+Alt+J',
    'reload 后设置界面显示 = ' + persistedChips
  )
  await closeSettings(app2)
  const p0 = await focusMode(app2)
  await tap(app2, 'Ctrl+Alt+J')
  const p1 = await focusMode(app2)
  report.check(
    'custom-key-survives-reload-effective',
    p0 !== p1,
    'reload 后 Ctrl+Alt+J: focusMode ' + p0 + ' -> ' + p1
  )

  // 收尾：把 profile 还原成全默认，别影响后续套件
  mark('收尾')
  await app2.ev('(window.__L.settings().resetAllKeybindings(), "ok")')
  await sleep(900)
  await openKeymapTab(app2)
  const finalBadges = await app2.ev(CONFLICT_BADGES)
  report.check('cleanup-back-to-defaults', finalBadges === 0, '恢复默认后冲突徽标=' + finalBadges)
  app2.close()
  finished = true
  process.exit(report.finish())
})().catch(fatal)
