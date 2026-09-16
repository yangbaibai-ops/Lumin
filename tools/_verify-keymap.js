// 验收：快捷键系统（命令注册表 + 可自定义键位 + Ctrl+Tab 窗口切换 + 设置界面）
//
// 覆盖：
//  A. 命令表与默认键：条目齐全、i18n 标题都有值、默认键规范化正确（Mod → Ctrl）
//  B. 默认键真的生效（Ctrl+/ 切模式、Ctrl+Shift+B 侧栏、Ctrl+K 设置、Ctrl+Shift+P 全局搜索）
//  C. Ctrl+N 只触发一次（原生菜单已不再自带 accelerator，避免双份真相 + 重复触发）
//  D. 自定义：改键后新键生效、旧键失效；解绑；恢复默认；用户绑定优先于默认绑定；冲突可见
//  E. 持久化：reload 后自定义仍在（SQLite settings.keybindings）
//  F. Ctrl+Tab / Ctrl+Shift+Tab 应用内切换窗口（真实焦点转移）
//  G. 设置界面：分组/搜索/录制（录制期间全局快捷键让行）
//
// 跑法：独立 userData 实例（见 §4.23）。会在临时目录建夹具，结束前清掉。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ROOT = path.resolve(__dirname, '..')

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => res(JSON.parse(d)))
    }).on('error', rej)
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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = app._context.provides[sym]
  window.__K = {
    files: () => pinia._s.get('files'),
    ui: () => pinia._s.get('ui'),
    settings: () => pinia._s.get('settings'),
    app
  }
  // 按键投递探针：区分「CDP 事件没到页面」与「快捷键服务没命中」
  if (!window.__keyLog) {
    window.__keyLog = []
    window.addEventListener('keydown', (e) => window.__keyLog.push({ key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, prevented: e.defaultPrevented }), true)
  }
  window.__keyLog.length = 0
  return 'ok'
})()`

const pages = async () => (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
const attach = async (page) => {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await c.ev(SETUP)) === 'ok' && (await c.ev(`window.__K.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await c.ev(SETUP)
  c.id = page.id
  return c
}

/** 按一次组合键（CDP modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8） */
async function press(w, spec) {
  await pressWithResult(w, spec)
}

/** 与 press 相同，但返回 CDP 结果（用于读 window:cycle 的返回值） */
async function pressWithResult(w, spec) {
  // 关键：CDP 注入的按键会走「当前聚焦窗口」的输入管线，目标窗口不是前台时事件可能被丢掉。
  // 因此每次按键前先把目标窗口置前（Page.bringToFront），并留一点时间让焦点生效。
  // 把目标窗口真正抬到前台再注入按键：document.hasFocus() 在多窗口下会同时为 true，
  // 不能当判据；可靠做法是走应用自己的聚焦逻辑（focusWindowByDoc，本套件另有用例覆盖它）。
  const docPath = await w.ev(`window.__K?.files().current?.path ?? null`).catch(() => null)
  if (docPath) {
    await w.ev(`window.luminAPI.app.focusWindowByDoc(${JSON.stringify(docPath)})`).catch(() => {})
    await sleep(400)
  }
  await w.send('Page.bringToFront').catch(() => {})
  await sleep(400)
  const parts = spec.split('+')
  const key = parts[parts.length - 1]
  let modifiers = 0
  if (parts.includes('Alt')) modifiers |= 1
  if (parts.includes('Ctrl')) modifiers |= 2
  if (parts.includes('Shift')) modifiers |= 8
  const lower = key.toLowerCase()
  const special = { tab: ['Tab', 'Tab', 9], enter: ['Enter', 'Enter', 13], escape: ['Escape', 'Escape', 27], space: [' ', 'Space', 32] }
  let domKey = lower
  let code = ''
  let vk = 0
  if (special[lower]) {
    domKey = special[lower][0]
    code = special[lower][1]
    vk = special[lower][2]
  } else if (key.length === 1) {
    domKey = key
    code = /[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /[0-9]/.test(key) ? 'Digit' + key : key === '/' ? 'Slash' : key === ',' ? 'Comma' : key === '.' ? 'Period' : key === '-' ? 'Minus' : key === '=' ? 'Equal' : ''
    vk = key.toUpperCase().charCodeAt(0)
  }
  await w.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: domKey, code, windowsVirtualKeyCode: vk, modifiers })
  await sleep(30)
  await w.send('Input.dispatchKeyEvent', { type: 'keyUp', key: domKey, code, windowsVirtualKeyCode: vk, modifiers })
  await sleep(250)
  return null
}

/**
 * 按键 + 「页面确实收到」校验：CDP 注入偶发丢失（OS 前台窗口不是目标窗口时），
 * 因此注入后读页面上的 keydown 探针，没收到就重试（最多 3 次）。
 * 只在「事件没送达」时重试，不会掩盖真正的断言失败。
 */
async function pressVerified(w, spec) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await w.ev(`(window.__keyLog && (window.__keyLog.length = 0), 'ok')`).catch(() => {})
    await pressWithResult(w, spec)
    const got = await w.ev(`(window.__keyLog || []).length`).catch(() => 0)
    if (got > 0) return attempt
    await sleep(350)
  }
  return 0
}

/** 安装 focus/blur 记录（document.hasFocus() 在多窗口下不够可靠，事件流更直接） */
const installFocusLog = (w) =>
  w.ev(`(() => {
    if (!window.__focusLog) {
      window.__focusLog = []
      window.addEventListener('focus', () => window.__focusLog.push({ t: Date.now(), kind: 'focus', hasFocus: document.hasFocus() }))
      window.addEventListener('blur', () => window.__focusLog.push({ t: Date.now(), kind: 'blur', hasFocus: document.hasFocus() }))
    }
    window.__focusLog.length = 0
    return 'ok'
  })()`)
const clearFocusLog = (w) => w.ev(`(window.__focusLog.length = 0, 'ok')`)
const focusLog = async (w) => JSON.parse(await w.ev(`JSON.stringify(window.__focusLog)`))

/** 直读 SQLite kv.settings.keybindings（证明「改键落库」，而不是只在内存里） */
function readDbKeybindings() {
  const dbPath = process.env.LUMIN_DB
  if (!dbPath || !fs.existsSync(dbPath)) return {}
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'settings'").get()
    return row ? (JSON.parse(row.value).keybindings ?? {}) : {}
  } catch {
    return {}
  } finally {
    db.close()
  }
}

const resolvedKeys = (w, id) =>
  w.ev(`(async () => { const m = await import('/src/lib/keymap/service.ts'); const r = m.currentKeymap()?.get(${JSON.stringify(id)}); return r ? JSON.stringify({ id: r.id, keys: r.keys, customized: r.customized, conflictWith: r.conflictWith, title: window.__K.app.config.globalProperties.$t(r.titleKey) }) : 'null' })()`)

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // 静态：原生菜单不该再自带 accelerator（否则用户改了键也会被原生那份触发）
  const menuSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'menu.ts'), 'utf8')
  c('native-menu-has-no-accelerators', !/accelerator:/.test(menuSrc), 'menu.ts accelerator 出现次数=' + (menuSrc.match(/accelerator:/g) || []).length)

  const F = path.join(os.tmpdir(), 'lumin-keymap-f')
  fs.rmSync(F, { recursive: true, force: true })
  fs.mkdirSync(F, { recursive: true })
  fs.writeFileSync(path.join(F, 'k.md'), '# k\n\nbody\n', 'utf-8')

  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  let w1 = await attach(all[0])
  const seen = new Set(all.map((p) => p.id))
  let w2 = null
  try {
    // ── 预置：清空用户覆盖，保证从「全默认」出发（套件可重复运行） ──
    await w1.ev(`(async () => { window.__K.settings().resetAllKeybindings(); return 'ok' })()`)
    await sleep(700)
    c('preflight-defaults-clean', (await w1.ev(`Object.keys(window.__K.settings().keybindings).length`)) === 0, 'overrides=' + (await w1.ev(`JSON.stringify(window.__K.settings().keybindings)`)))

    // ── A. 命令表与默认键 ──
    const table = JSON.parse(
      await w1.ev(`(async () => {
        const m = await import('/src/lib/keymap/service.ts')
        const t = window.__K.app.config.globalProperties.$t
        const list = m.currentKeymap()?.resolved() ?? []
        return JSON.stringify({
          count: list.length,
          missingTitle: list.filter((x) => !t(x.titleKey) || t(x.titleKey) === x.titleKey).map((x) => x.titleKey),
          missingGroup: list.filter((x) => !t(x.groupKey) || t(x.groupKey) === x.groupKey).map((x) => x.groupKey),
          next: list.find((x) => x.id === 'window.next')?.keys ?? null,
          prev: list.find((x) => x.id === 'window.prev')?.keys ?? null,
          save: list.find((x) => x.id === 'file.save')?.keys ?? null,
          cycle: list.find((x) => x.id === 'view.cycleMode')?.keys ?? null,
          duplicates: Object.entries(list.reduce((acc, x) => { if (x.keys) (acc[x.keys] = acc[x.keys] || []).push(x.id); return acc }, {})).filter(([, v]) => v.length > 1)
        })
      })()`)
    )
    console.log('TABLE ' + JSON.stringify(table))
    c('commands-registered', table.count >= 20, 'count=' + table.count)
    c('titles-and-groups-translated', table.missingTitle.length === 0 && table.missingGroup.length === 0, JSON.stringify({ titles: table.missingTitle, groups: table.missingGroup }))
    c('default-next-window-is-mod-tab', table.next === 'Ctrl+Tab', JSON.stringify(table.next))
    c('default-prev-window-is-mod-shift-tab', table.prev === 'Ctrl+Shift+Tab', JSON.stringify(table.prev))
    c('default-mod-normalized-to-ctrl', table.save === 'Ctrl+S' && table.cycle === 'Ctrl+/', JSON.stringify({ save: table.save, cycle: table.cycle }))
    c('no-duplicate-defaults', table.duplicates.length === 0, JSON.stringify(table.duplicates))

    // ── 环境：临时工作区 + 打开文档（Ctrl+N/S 都作用在临时目录里） ──
    await w1.ev(`(async () => { const f = window.__K.files(); await f.setRoot(${JSON.stringify(F)}); await f.openPath(${JSON.stringify(path.join(F, 'k.md'))}); return 'ok' })()`)
    await sleep(1000)

    // ── B. 默认键生效 ──
    const mode0 = await w1.ev(`window.__K.ui().editorMode`)
    await pressVerified(w1, 'Ctrl+/')
    const mode1 = await w1.ev(`window.__K.ui().editorMode`)
    c('default-cycle-mode-fires', mode0 !== mode1, `${mode0} -> ${mode1}`)

    const side0 = await w1.ev(`window.__K.ui().sidebarVisible`)
    await pressVerified(w1, 'Ctrl+Shift+B')
    const side1 = await w1.ev(`window.__K.ui().sidebarVisible`)
    c('default-toggle-sidebar-fires', side0 !== side1, `${side0} -> ${side1}`)

    await pressVerified(w1, 'Ctrl+Shift+P')
    const searchOpen = await w1.ev(`window.__K.ui().globalSearch.open === true`)
    if (searchOpen) {
      await w1.ev(`window.__K.ui().closeGlobalSearch()`)
      await sleep(400)
    }
    c('default-global-search-fires', searchOpen === true, String(searchOpen))
    await sleep(300)

    // ── C. Ctrl+N 只触发一次（原生菜单不再自带 accelerator，避免原生 + 渲染层各触发一次） ──
    // 语义（§4.47）：Ctrl+N = **新窗口 + 工作区不变 + 未命名文档**（不落盘），
    // 所以「只触发一次」用**窗口数**判定 —— 真触发两次就会多出两个窗口。
    await w1.ev(`(() => { window.__K.files().close(); return 'ok' })()`)
    await sleep(600)
    const pagesBeforeC = (await pages()).length
    await pressVerified(w1, 'Ctrl+N')
    await sleep(2200)
    const freshC = (await pages()).filter((p) => !seen.has(p.id))
    const keyLogN = JSON.parse(await w1.ev(`JSON.stringify(window.__keyLog)`))
    console.log('CTRL-N ' + JSON.stringify({ pagesBeforeC, after: (await pages()).length, fresh: freshC.length, keyLogN }))
    c(
      'new-doc-fires-exactly-once',
      freshC.length === 1,
      `windows ${pagesBeforeC} -> ${(await pages()).length} keylog=${JSON.stringify(keyLogN)}`
    )
    if (freshC.length) {
      // 新窗口：同一个工作区 + 未命名文档（磁盘上不产生文件）
      const nw = await attach(freshC[0])
      const ns = JSON.parse(
        await nw.ev(
          `JSON.stringify({ root: window.__K.files().root ?? null, doc: window.__K.files().current?.path ?? null, name: window.__K.files().current?.name ?? null })`
        )
      )
      c(
        'ctrl-n-new-window-same-folder-untitled',
        ns.root === F && ns.doc === null && /^Untitled-\d+\.md$/.test(String(ns.name)),
        JSON.stringify(ns)
      )
      c('ctrl-n-creates-no-file', fs.readdirSync(F).length === 1, JSON.stringify(fs.readdirSync(F)))
      await nw.send('Page.close').catch(() => {})
      nw.ws.close()
      await sleep(1300)
    }
    // 恢复：重新打开夹具文档，后续用例继续在同一窗口上跑
    await w1.ev(`(async () => { const f = window.__K.files(); await f.setRoot(${JSON.stringify(F)}); await f.openPath(${JSON.stringify(path.join(F, 'k.md'))}); return 'ok' })()`)
    await sleep(900)

    // ── D. 自定义 ──
    await w1.ev(`window.__K.settings().setKeybinding('view.toggleSidebar', 'Ctrl+Alt+B')`)
    await sleep(400)
    const custom = JSON.parse(await resolvedKeys(w1, 'view.toggleSidebar'))
    c('custom-binding-resolved', custom.keys === 'Ctrl+Alt+B' && custom.customized === true, JSON.stringify(custom))

    const s0 = await w1.ev(`window.__K.ui().sidebarVisible`)
    await pressVerified(w1, 'Ctrl+Alt+B')
    const s1 = await w1.ev(`window.__K.ui().sidebarVisible`)
    c('custom-binding-fires', s0 !== s1, `${s0} -> ${s1}`)

    const s2 = await w1.ev(`window.__K.ui().sidebarVisible`)
    await pressVerified(w1, 'Ctrl+Shift+B') // 旧默认键已让位
    const s3 = await w1.ev(`window.__K.ui().sidebarVisible`)
    c('old-default-no-longer-fires', s2 === s3, `${s2} -> ${s3}`)

    // 冲突：先把 toggleSidebar 恢复默认（Ctrl+Shift+B），再把 focusMode 绑到同一个键上
    await w1.ev(`window.__K.settings().resetKeybinding('view.toggleSidebar')`)
    await sleep(300)
    await w1.ev(`window.__K.settings().setKeybinding('view.focusMode', 'Ctrl+Shift+B')`)
    await sleep(400)
    const conflict = JSON.parse(await resolvedKeys(w1, 'view.toggleSidebar'))
    const s4 = await w1.ev(`window.__K.ui().sidebarVisible`)
    const f4 = await w1.ev(`window.__K.ui().focusMode`)
    await pressVerified(w1, 'Ctrl+Shift+B')
    const s5 = await w1.ev(`window.__K.ui().sidebarVisible`)
    const f5 = await w1.ev(`window.__K.ui().focusMode`)
    c('user-binding-beats-default', s5 === s4 && f5 !== f4, JSON.stringify({ side: [s4, s5], focus: [f4, f5] }))
    c('conflict-reported', Array.isArray(conflict.conflictWith) && conflict.conflictWith.includes('view.focusMode'), JSON.stringify(conflict.conflictWith))
    await w1.ev(`window.__K.settings().resetKeybinding('view.focusMode')`)
    await sleep(300)

    // 解绑 → 按键什么都不做
    await w1.ev(`window.__K.settings().setKeybinding('view.toggleSidebar', null)`)
    await sleep(400)
    const unbound = JSON.parse(await resolvedKeys(w1, 'view.toggleSidebar'))
    const u0 = await w1.ev(`window.__K.ui().sidebarVisible`)
    await pressVerified(w1, 'Ctrl+Alt+B')
    const u1 = await w1.ev(`window.__K.ui().sidebarVisible`)
    c('unbind-disables-key', unbound.keys === null && u0 === u1, JSON.stringify({ keys: unbound.keys, side: [u0, u1] }))

    // 恢复默认 → 默认键回来
    await w1.ev(`window.__K.settings().resetKeybinding('view.toggleSidebar')`)
    await sleep(400)
    const restored = JSON.parse(await resolvedKeys(w1, 'view.toggleSidebar'))
    const r0 = await w1.ev(`window.__K.ui().sidebarVisible`)
    await pressVerified(w1, 'Ctrl+Shift+B')
    const r1 = await w1.ev(`window.__K.ui().sidebarVisible`)
    c('reset-restores-default', restored.keys === 'Ctrl+Shift+B' && restored.customized === false && r0 !== r1, JSON.stringify({ keys: restored.keys, side: [r0, r1] }))

    // ── F. Ctrl+Tab / Ctrl+Shift+Tab 切换窗口 ──
    await w1.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
    for (let i = 0; i < 60; i++) {
      await sleep(300)
      const fresh = (await pages()).find((p) => !seen.has(p.id))
      if (fresh) {
        w2 = await attach(fresh)
        break
      }
    }
    if (!w2) throw new Error('第二个窗口没有出现')
    seen.add(w2.id)
    await sleep(800)

    // 让 w1 聚焦，并用 focus/blur 事件流判定「谁被切到了前面」
    await installFocusLog(w1)
    await installFocusLog(w2)
    await w1.send('Page.bringToFront')
    await sleep(1000)
    await clearFocusLog(w1)
    await clearFocusLog(w2)

    const cycle1 = await w1.ev(`window.luminAPI.app.cycleWindow(1)`)
    await sleep(1000)
    const log1 = { w1: await focusLog(w1), w2: await focusLog(w2) }
    console.log('CTRL-TAB-1 ' + JSON.stringify({ cycle1, log1 }))
    c('ctrl-tab-switches-window', log1.w2.some((x) => x.kind === 'focus') && log1.w1.some((x) => x.kind === 'blur'), JSON.stringify(log1))

    // 再按一次（从 w2 出发）→ 切回 w1
    await clearFocusLog(w1)
    await clearFocusLog(w2)
    const cycle2 = await w2.ev(`window.luminAPI.app.cycleWindow(1)`)
    await sleep(1000)
    const log2 = { w1: await focusLog(w1), w2: await focusLog(w2) }
    console.log('CTRL-TAB-2 ' + JSON.stringify({ cycle2, log2 }))
    c('ctrl-tab-cycles-back', log2.w1.some((x) => x.kind === 'focus') && log2.w2.some((x) => x.kind === 'blur'), JSON.stringify(log2))

    // Ctrl+Shift+Tab：反向
    await clearFocusLog(w1)
    await clearFocusLog(w2)
    const cycle3 = await w1.ev(`window.luminAPI.app.cycleWindow(-1)`)
    await sleep(1000)
    const log3 = { w1: await focusLog(w1), w2: await focusLog(w2) }
    console.log('CTRL-TAB-3 ' + JSON.stringify({ cycle3, log3 }))
    c('ctrl-shift-tab-goes-previous', log3.w2.some((x) => x.kind === 'focus') && log3.w1.some((x) => x.kind === 'blur'), JSON.stringify(log3))

    // 真实按键路径：Ctrl+Tab（默认键）在 w1 上按 → w2 获得焦点
    await clearFocusLog(w1)
    await clearFocusLog(w2)
    await pressVerified(w1, 'Ctrl+Tab')
    await sleep(1000)
    const log4 = { w1: await focusLog(w1), w2: await focusLog(w2) }
    const keyLog4 = JSON.parse(await w1.ev(`JSON.stringify(window.__keyLog)`))
    console.log('CTRL-TAB-KEY ' + JSON.stringify({ log4, keyLog4 }))
    c('ctrl-tab-keybinding-fires', log4.w2.some((x) => x.kind === 'focus') && log4.w1.some((x) => x.kind === 'blur'), JSON.stringify({ log4, keyLog4 }))

    // 自定义 Ctrl+Tab 也生效（换成 Ctrl+Alt+T 后 Ctrl+Tab 不再切窗口）
    await w1.ev(`window.__K.settings().setKeybinding('window.next', 'Ctrl+Alt+T')`)
    await sleep(400)
    await w1.send('Page.bringToFront')
    await sleep(900)
    await clearFocusLog(w1)
    await clearFocusLog(w2)
    await pressVerified(w1, 'Ctrl+Alt+T')
    await sleep(1000)
    const log5 = { w1: await focusLog(w1), w2: await focusLog(w2) }
    c('rebound-window-cycle-works', log5.w2.some((x) => x.kind === 'focus'), JSON.stringify(log5))
    await w1.ev(`window.__K.settings().resetAllKeybindings()`)
    await sleep(400)

    // ── G. 设置界面：分组 / 搜索 / 录制 ──
    await w1.send('Page.bringToFront')
    await sleep(600)
    await w1.ev(`window.__K.ui().openSettings('keymap')`)
    await sleep(900)
    const uiState = JSON.parse(
      await w1.ev(`JSON.stringify({
        rows: document.querySelectorAll('.key-row').length,
        groups: document.querySelectorAll('section.surface h3').length,
        chips: document.querySelectorAll('.key-chip').length,
        search: !!document.querySelector('input[placeholder]')
      })`)
    )
    console.log('SETTINGS-UI ' + JSON.stringify(uiState))
    c('settings-keymap-tab-renders', uiState.rows >= 20 && uiState.groups >= 4 && uiState.chips > 0, JSON.stringify(uiState))

    // 搜索过滤（用组件上的 .keymap-search，避免抓到设置里别的输入框）
    await w1.ev(`(() => { const i = document.querySelector('.keymap-search'); i.value = '窗口'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
    await sleep(500)
    const filtered = await w1.ev(`document.querySelectorAll('.key-row').length`)
    c('search-filters-rows', filtered > 0 && filtered < uiState.rows, `${uiState.rows} -> ${filtered}`)
    await w1.ev(`(() => { const i = document.querySelector('.keymap-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
    await sleep(400)

    // 录制：先把目标行滚进视口再点「修改」（否则坐标落在视口外，点击会打偏）
    const recordInfo = JSON.parse(
      await w1.ev(`(() => {
        const row = document.querySelector('.key-row[data-command="view.toggleSidebar"]')
        if (!row) return JSON.stringify({ ok: false })
        row.scrollIntoView({ block: 'center' })
        const b = row.querySelectorAll('button')[0]
        b.click()
        return JSON.stringify({ ok: true, buttons: row.querySelectorAll('button').length })
      })()`)
    )
    await sleep(600)
    console.log('RECORDER-CLICK ' + JSON.stringify(recordInfo))
    const recording = JSON.parse(
      await w1.ev(`(async () => { const m = await import('/src/lib/keymap/service.ts'); return JSON.stringify({ recording: m.isKeymapRecording(), hint: !!document.querySelector('.key-recording') }) })()`)
    )
    c('recorder-enters-recording', recording.recording === true && recording.hint === true, JSON.stringify(recording))

    // 录制期间：Ctrl+N 不应真的执行（全局服务让行）。§4.47 之后它的「执行」= 多一个窗口，
    // 所以窗口数一并断言（旧断言只看工作区文件数，已随语义变化调整）。
    const filesBefore = fs.readdirSync(F).length
    const winBefore = (await pages()).length
    const docBefore = await w1.ev(`window.__K.files().current?.path ?? null`)
    await pressVerified(w1, 'Ctrl+N')
    await sleep(900)
    const filesAfter = fs.readdirSync(F).length
    const winAfter = (await pages()).length
    const docAfter = await w1.ev(`window.__K.files().current?.path ?? null`)
    c('recording-swallows-global-keys', filesAfter === filesBefore && docAfter === docBefore && winAfter === winBefore, JSON.stringify({ files: [filesBefore, filesAfter], doc: [docBefore, docAfter], windows: [winBefore, winAfter] }))
    // 而这次按键已经被录制为 sidebar 的新键
    const recorded = JSON.parse(await resolvedKeys(w1, 'view.toggleSidebar'))
    c('recorder-captures-keys', recorded.keys === 'Ctrl+N' && recorded.customized === true, JSON.stringify(recorded))
    await w1.ev(`window.__K.settings().resetAllKeybindings()`)
    await sleep(300)
    await w1.ev(`window.__K.ui().closeSettings()`)
    await sleep(400)
    // ── E. 持久化（放在最后）：直读 SQLite + reload 后解析结果仍生效 ──
    await w1.ev(`window.__K.settings().setKeybinding('view.focusMode', 'Ctrl+Alt+F')`)
    await sleep(1600)
    const dbKeys = readDbKeybindings()
    c('custom-binding-persisted-in-sqlite', dbKeys['view.focusMode'] === 'Ctrl+Alt+F', JSON.stringify(dbKeys))

    // reload：重建 CDP 连接（旧连接在 reload 后失效），随后只校验「解析结果」——
    // 按键派发能力已在前面用 6 条命令验证过，这里验的是「重启后自定义仍在」。
    const pageId = w1.id
    await w1.send('Page.reload')
    await sleep(2400)
    w1.ws.close()
    const pageAfterReload = (await pages()).find((p) => p.id === pageId)
    if (!pageAfterReload) throw new Error('reload 后找不到同一个窗口')
    w1 = await attach(pageAfterReload)
    await sleep(900)
    const persisted = JSON.parse(await resolvedKeys(w1, 'view.focusMode'))
    c('custom-binding-survives-reload', persisted.keys === 'Ctrl+Alt+F' && persisted.customized === true, JSON.stringify(persisted))
    await w1.ev(`window.__K.settings().resetAllKeybindings()`)
    await sleep(400)

  } finally {
    for (const w of [w2]) if (w && w.ws.readyState === 1) await w.send('Page.close').catch(() => {})
    await sleep(700)
    fs.rmSync(F, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w1.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
