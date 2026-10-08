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
// ── 第二轮（用户实测：恢复默认 → 关闭应用 → 重开，自定义键位又回来了）────────────────
// ⑦⑧⑨ 段走**真·重启**（关窗 → `window-all-closed` → `app.quit()`，再用同一个 userData
// 起一个新实例），并直读主进程落盘的 `kv.settings.keybindings`（node:sqlite，只读）：
//   * ⑦ 改绑要活过重启（显示 + 真实按键）；
//   * ⑧ **「恢复默认」必须真的把盘上那张表清空**（会话里看着是默认、盘上还是自定义，
//     就是"重启后复活"的成因）→ 重启后显示与实际都必须是默认；
//   * ⑨ 「改完顺手关应用」：键位（立刻落库）与节流设置（关窗 flush）都不能丢。
// 这几段的"红"是**只在重启后显形**的：见 `shared/settingsSchema.ts` 的 `mergeSettings`。
//
// 为什么不去页面上动态取源码模块（那要 5173 上的 dev server）：套件就只能进 needs-dev 档、
// 默认矩阵永远不跑它（本轮的 bug 正是这样漏到今天）。这里全部走 **DOM + store + 真实按键 +
// 真实重启 + 直读数据库**，构建产物（out/renderer）下即可跑，所以登记进 run-suites.js 的 DEFAULT_SUITES。
//
// 跑法：`node tools/run-suites.js --suite=_verify-keymap-custom.js`（运行器会起隔离实例）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
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
  startIsolated,
  spawnApp,
  Reporter,
  fatal
} = require('./lib/harness')

const ROOT = path.join(__dirname, '..')
/** 本实例的调试端口 / userData / 数据库（运行器通过环境变量给，单独跑也有一份默认值） */
const PORT = Number(process.env.LUMIN_DEBUG_PORT || 9222)
const USER_DATA = process.env.LUMIN_ISOLATED_USERDATA || path.join(os.tmpdir(), 'lumin-suites-ud')
const DB_PATH = process.env.LUMIN_DB || path.join(USER_DATA, 'lumin.db')

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

// ─── 真·重启用的工具（关窗走真实退出路径 → 同 profile 再起一个实例）─────────────

/**
 * 直读**主进程落盘**的 `kv.settings.keybindings`（`node:sqlite` 只读打开实例自己的库）。
 *
 * 为什么要绕过 IPC 直读文件：本轮报障的核心就是"**会话里看着是默认、盘上还是自定义**"。
 * 只问渲染层（或只问 `settings:getAll`）都可能被同一份内存状态骗过去，盘上那份才是重启后
 * 真正读的东西。`LUMIN_DB` 由运行器指到隔离 profile，绝不碰用户自己的库。
 */
function diskKeybindings() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'settings'").get()
    return row ? (JSON.parse(row.value).keybindings ?? {}) : 'NO-ROW'
  } finally {
    db.close()
  }
}

/** 等实例真的退出（调试端口上没有本应用的页面了） */
async function waitGone(ms = 25000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if ((await appPages()).length === 0) return true
    await sleep(400)
  }
  return false
}

/**
 * 请求退出（**真实路径**）：`app:close` → 主进程关窗守卫 → 渲染层 `requestClose` 落盘放行。
 *
 * `skipPrepare` 用于"节流窗口内立刻退出"那条：不预先动任何设置/文档，
 * 让"最后一条设置写入"与"请求退出"之间保持 0ms。
 * （非 skipPrepare 时先把文档关掉并打开自动保存：关窗判定见 shared/closePrompt.ts ——
 * 自动保存开着或文档不脏都不弹「是否保存更改？」，套件才不会卡在一个没人点的对话框上。
 * 自动保存这一条本身也会落盘，于是后续几轮退出天然无弹窗。）
 */
async function requestQuit(app, opts = {}) {
  if (!opts.skipPrepare) {
    await ensureFocus(app)
    await app.ev('(window.__L.settings().set("autoSave", true), "ok")').catch(() => {})
    await sleep(250)
    await app.ev('(function(){ window.__L.files().close(); return "ok" })()').catch(() => {})
    await sleep(300)
  }
  mark('退出中（关窗 → window-all-closed → app.quit）')
  await app.ev('(window.luminAPI.app.close(), "sent")').catch(() => {})
  app.close()
  if (await waitGone(8000)) return
  /**
   * 兜底重发一次：`app:close` 走的是 `BrowserWindow.getFocusedWindow()`，
   * 焦点被别的窗口抢走时它会拿到 null（什么都不发生）。这时 socket 已经关了，
   * 重新 attach 一个页面再发一次 —— 比"等 25 秒然后报一个看不懂的失败"强。
   */
  const pages = await appPages()
  if (pages.length) {
    const again = await attach(pages[0])
    await again.send('Page.bringToFront').catch(() => {})
    await sleep(300)
    await again.ev('(window.luminAPI.app.close(), "sent")').catch(() => {})
    again.close()
  }
  if (!(await waitGone(17000))) throw new Error('实例没有在 25s 内退出（关窗路径可能被弹窗或强杀兜底卡住）')
}

/** 用**同一个 userData** 再起一个实例（= 用户说的"关掉应用再打开"），返回可用的句柄 */
async function relaunch() {
  spawnApp({ userData: USER_DATA, port: PORT })
  const end = Date.now() + 45000
  while (Date.now() < end) {
    const pages = await appPages()
    if (pages.length) {
      try {
        const fresh = guarded(await attach(pages[0]))
        if (await settle(fresh.ev)) return fresh
        fresh.close()
      } catch {
        /* 窗口还没挂上：继续等 */
      }
    }
    await sleep(500)
  }
  throw new Error('重启之后 45s 内没有等到可用页面')
}

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

  // ═══════════════════════════════════════════════════════════════════════════
  // 本轮新增：**真·重启**下的持久化（用户实测：恢复默认 →关掉应用→重开，自定义又回来了）
  //
  // 为什么不用 `Page.reload` 代替：reload 只重建渲染层，而本轮的 bug 恰恰在**盘上那份数据**
  // 与"退出前有没有把挂起的写入落下去"。所以这里走真实路径：关窗 → 主进程 `window-all-closed`
  // → `app.quit()`，再用**同一个 userData** 起一个新实例（= 用户说的"关掉再打开"），
  // 同时直读 `kv.settings`（node:sqlite，只读打开）证明主进程侧的落盘值。
  // ═══════════════════════════════════════════════════════════════════════════
  let cur = app2

  // ── ⑦ 改绑要活过真·重启 ────────────────────────────────────────────────────
  mark('⑦ 真重启：改绑活过重启')
  await cur.ev('(window.__L.settings().setKeybinding("view.focusMode", "Ctrl+Alt+J"), "ok")')
  await sleep(800)
  const disk1 = diskKeybindings()
  report.check(
    'rebind-persisted-to-disk',
    disk1['view.focusMode'] === 'Ctrl+Alt+J',
    '主进程盘上 kv.settings.keybindings = ' + JSON.stringify(disk1) + '（node:sqlite 只读打开 lumin.db）'
  )
  await requestQuit(cur)
  cur = await relaunch()
  mark('⑦ 重启后读显示与生效')
  await openKeymapTab(cur)
  const restartChips = await cur.ev(chipsExpr(FOCUS))
  report.check(
    'rebind-survives-real-restart-display',
    restartChips === 'Ctrl+Alt+J',
    '重启后设置界面显示 = ' + restartChips
  )
  await closeSettings(cur)
  await openDocWith(cur, '# restart\n\nbody\n', 'restart.md')
  await sleep(400)
  const k0 = await focusMode(cur)
  await tap(cur, 'Ctrl+Alt+J')
  const k1 = await focusMode(cur)
  report.check(
    'rebind-survives-real-restart-effective',
    k0 !== k1,
    '重启后 Ctrl+Alt+J: focusMode ' + k0 + ' -> ' + k1
  )

  // ── ⑧ 「恢复默认」必须**落盘**（本轮报障核心）───────────────────────────────
  mark('⑧ 恢复默认 → 盘上必须清空')
  await cur.ev('(window.__L.settings().resetAllKeybindings(), "ok")')
  await sleep(900)
  const disk2 = diskKeybindings()
  report.check(
    'reset-clears-disk-keybindings',
    JSON.stringify(disk2) === '{}',
    '恢复默认后盘上 kv.settings.keybindings = ' +
      JSON.stringify(disk2) +
      '（必须是 {} —— 会话内显示默认但盘上还留着旧表，就是"重启后自定义复活"）'
  )
  await openKeymapTab(cur)
  const resetChips = await cur.ev(chipsExpr(FOCUS))
  report.check(
    'reset-display-default-immediately',
    resetChips === 'Ctrl+Shift+F',
    '恢复默认后立刻读设置界面 = ' + resetChips
  )
  await closeSettings(cur)
  await requestQuit(cur)
  cur = await relaunch()
  mark('⑧ 重启后：显示与实际都必须是默认')
  await openKeymapTab(cur)
  const resetRestartChips = await cur.ev(chipsExpr(FOCUS))
  report.check(
    'reset-survives-real-restart-display',
    resetRestartChips === 'Ctrl+Shift+F',
    '重启后设置界面显示 = ' + resetRestartChips + '（期望默认 Ctrl+Shift+F）'
  )
  await closeSettings(cur)
  await openDocWith(cur, '# restart2\n\nbody\n', 'restart2.md')
  await sleep(400)
  const z0 = await focusMode(cur)
  await tap(cur, 'Ctrl+Alt+J') // 旧自定义键：重启后必须**什么都不做**
  const z1 = await focusMode(cur)
  await tap(cur, 'Ctrl+Shift+F') // 默认键：必须回来
  const z2 = await focusMode(cur)
  report.check(
    'reset-survives-real-restart-effective',
    z0 === z1 && z1 !== z2,
    '重启后 Ctrl+Alt+J: ' + z0 + ' -> ' + z1 + '（期望不变）；Ctrl+Shift+F: ' + z1 + ' -> ' + z2 + '（期望变）'
  )

  // ── ⑨ 节流窗口内立刻退出：键位与节流设置**都不能丢**（④）─────────────────────
  // 「改完顺手关应用」是最常见的路径：改绑是立刻落库（离散动作不进节流），
  // 别的设置（滑杆那类）走 250ms 节流 —— 关窗流程必须在放行前把它冲掉。
  // 这里在最后两条设置写入与"请求退出"之间**不 sleep**，模拟 0ms 退出。
  mark('⑨ 0ms 退出：最后一条改动不能丢')
  await ensureFocus(cur)
  // 先关掉文档并把自动保存打开（都在"0ms 那对写入"之前）：关窗就不会弹「是否保存更改？」
  await cur.ev('(window.__L.settings().set("autoSave", true), "ok")')
  await sleep(200)
  await cur.ev('(function(){ window.__L.files().close(); return "ok" })()')
  await sleep(300)
  // ↓ 这两条与"请求退出"之间**不 sleep**：模拟"改完顺手就关应用"
  await cur.ev('(window.__L.settings().setKeybinding("view.focusMode", "Ctrl+Alt+9"), "ok")')
  await cur.ev('(window.__L.settings().set("fontSize", 18.5), "ok")')
  await requestQuit(cur, { skipPrepare: true })
  cur = await relaunch()
  mark('⑨ 重启后核对最后一条改动')
  const quickKeys = await cur.ev('JSON.stringify(window.__L.settings().keybindings)')
  const quickFont = await cur.ev('window.__L.settings().fontSize')
  report.check(
    'keybinding-written-without-throttle-window',
    quickKeys.indexOf('Ctrl+Alt+9') >= 0,
    '改绑后 0ms 请求退出 → 重启后 keybindings = ' + quickKeys
  )
  report.check(
    'throttled-setting-flushed-on-quit',
    quickFont === 18.5,
    '节流设置（fontSize 18.5）后 0ms 请求退出 → 重启后 fontSize = ' + quickFont
  )

  // 收尾：盘上覆盖清空 + 字体复位，别把状态留给下一个套件
  mark('收尾（真重启之后）')
  await cur.ev(
    '(function(){ var s = window.__L.settings(); s.resetAllKeybindings(); s.set("fontSize", 17); return "ok" })()'
  )
  await sleep(900)
  const disk3 = diskKeybindings()
  report.check(
    'cleanup-disk-back-to-defaults',
    JSON.stringify(disk3) === '{}',
    '收尾后盘上 kv.settings.keybindings = ' + JSON.stringify(disk3)
  )
  cur.close()
  // 收尾：把本次重启起的实例收掉（运行器也会按 user-data-dir 收一遍，这里只是不留孤儿）
  startIsolated({ userData: USER_DATA, port: PORT, cleanupOnly: true })
  finished = true
  process.exit(report.finish())
})().catch((e) => {
  // 出错路径同样别把实例留在 9222 上（下一步的套件会连不上）
  try {
    startIsolated({ userData: USER_DATA, port: PORT, cleanupOnly: true })
  } catch {
    /* 收尾失败不影响结论 */
  }
  fatal(e)
})
