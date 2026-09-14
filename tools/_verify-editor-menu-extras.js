// 收尾验收：A) 三主题下菜单配色  B) 文件树右键菜单未被影响  C) menu_usage 落盘
const path = require('path')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')
const CDP = 'http://127.0.0.1:9222/json'
const DB = path.join(os.homedir(), 'AppData', 'Roaming', 'lumin', 'lumin.db')
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value }
async function rightClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 })
  await sleep(600)
}
const MD = JSON.stringify(['# T', '', '段落一'].join('\n'))

;(async () => {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym] ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map) ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), files: () => pinia._s.get('files'), menu: () => pinia._s.get('editorMenu'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(500)

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  const prevTheme = await ev(`window.__vt.settings().theme`)

  // ── A) 三主题配色 ───────────────────────────────────────────────────────
  const opened = await ev(`(async () => {
    const f = window.__vt.files()
    if (f.current) await f.close()
    await f.openUntitled()
    await new Promise((r) => setTimeout(r, 300))
    window.__vt.files().setContent(${MD})
    window.__vt.ed().commands.setContent(${MD}, { emitUpdate: false })
    return 'ok'
  })()`)
  void opened
  await sleep(600)
  for (const theme of ['light', 'dark', 'sepia']) {
    await ev(`window.__vt.settings().setTheme('${theme}')`)
    await sleep(500)
    await ev(`window.__vt.menu().openAt(600, 300)`)
    await sleep(500)
    const info = await ev(`(() => {
      const p = document.querySelector('.ecm-panel')
      if (!p) return null
      const cs = getComputedStyle(p)
      const item = p.querySelector('.ecm-item')
      const active = p.querySelector('.ecm-item.is-active')
      return JSON.stringify({
        panelBg: cs.backgroundColor, border: cs.borderTopColor, radius: cs.borderTopLeftRadius,
        itemColor: getComputedStyle(item).color,
        activeBg: active ? getComputedStyle(active).backgroundColor : null,
        activeColor: active ? getComputedStyle(active).color : null,
        shadow: cs.boxShadow !== 'none'
      })
    })()`)
    console.log('THEME ' + theme + ' ' + info)
    const t = info ? JSON.parse(info) : null
    c(`theme-${theme}-themed`, !!t && t.panelBg !== 'rgba(0, 0, 0, 0)' && t.shadow === true, String(info))
    await ev(`window.__vt.menu().close()`)
    await sleep(200)
  }
  await ev(`window.__vt.settings().setTheme('${prevTheme}')`)
  await sleep(400)

  // ── B) 文件树右键菜单回归 ───────────────────────────────────────────────
  await ev(`window.__vt.menu().close()`)
  await ev(`(() => { window.__vt.ui().sidebarVisible = true; return 'ok' })()`)
  await sleep(600)
  const treePt = JSON.parse(await ev(`(() => {
    const aside = document.querySelector('aside')
    if (!aside) return JSON.stringify({ x: -1, y: -1 })
    const r = aside.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + 60), y: Math.round(r.top + 170) })
  })()`))
  console.log('TREE-PT ' + JSON.stringify(treePt))
  await rightClick(treePt.x, treePt.y)
  const treeMenu = JSON.parse(await ev(`(() => JSON.stringify({ state: !!window.__vt.ui().contextMenu, dom: !!document.querySelector('.fixed.z-\\\\[160\\\\]'), editorMenu: !!document.querySelector('.ecm-panel') }))()`))
  console.log('TREE-MENU ' + JSON.stringify(treeMenu))
  c('file-tree-menu-still-works', treeMenu.state === true && treeMenu.dom === true && treeMenu.editorMenu === false, JSON.stringify(treeMenu))
  await ev(`window.__vt.ui().closeContextMenu()`)
  await sleep(200)

  // ── C) menu_usage 落盘 ──────────────────────────────────────────────────
  const mark = 'table.rowBelow'
  await ev(`window.luminAPI.menuUsage.bump(${JSON.stringify(mark)})`)
  await sleep(400)
  const db = new DatabaseSync(DB, { readOnly: true })
  let row = null
  let cols = []
  try {
    cols = db.prepare('PRAGMA table_info(menu_usage)').all().map((r) => r.name)
    row = db.prepare('SELECT action_id, count, last_used FROM menu_usage WHERE action_id = ?').get(mark)
  } finally {
    db.close()
  }
  console.log('DISK ' + JSON.stringify({ cols, row }))
  c('usage-schema-on-disk', ['action_id', 'count', 'last_used'].every((x) => cols.includes(x)), JSON.stringify(cols))
  c('usage-row-on-disk', !!row && row.action_id === mark && row.count >= 1, JSON.stringify(row))

  // 复原
  await ev(`(async () => {
    window.__vt.menu().close()
    const f = window.__vt.files()
    await f.close()
    await window.luminAPI.drafts.remove('untitled')
    await window.luminAPI.menuUsage.reset()
    window.__vt.menu().usage = {}
    return 'ok'
  })()`)
  await sleep(400)
  const after = new DatabaseSync(DB, { readOnly: true })
  let left = -1
  try {
    left = after.prepare('SELECT COUNT(*) AS c FROM menu_usage').get().c
  } finally {
    after.close()
  }
  c('usage-reset-on-disk', left === 0, 'rows=' + left)

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  ws.close()
})().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
