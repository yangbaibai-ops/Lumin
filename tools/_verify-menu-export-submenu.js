// 验收：文件菜单里的「导出」收成一级项 + 悬停二级菜单（具体格式在二级里）
//
// 断言：① 一级菜单不再平铺四个「导出为 …」，只剩一个带箭头的「导出」；
//      ② 悬停「导出」→ 右侧浮层列出四种格式（文案取自 i18n，标题为「导出」）；
//      ③ 浮层贴死一级面板（重叠 1px）、指针从一级行平移进浮层不会被关掉（160ms 宽限）；
//      ④ 悬停到普通项会把浮层收掉；Esc 先收浮层再收菜单；
//      ⑤ **动作接线**：从组件实例读菜单数据，断言四个二级项各自调用 `runExport('<格式>')`。
//        这里刻意**不点击**导出项：点击会真的走导出流程并弹出系统「另存为」对话框，
//        自动化无法取消原生对话框（`window.luminAPI` 是冻结对象，没法打桩）。
//        导出功能本身仍由 useExport 承担，本次改动只是把入口从一级挪进二级。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym]
  window.__M = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), app }
  return 'ok'
})()`

/** 从组件实例读菜单数据：拿到「导出」二级项的 run 函数源码（证明接线，不执行） */
const WIRING = `(() => {
  const t = (k) => window.__M.app.config.globalProperties.$t(k)
  const fileBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t('menu.file'))
  if (!fileBtn) return JSON.stringify({ err: 'no file button' })
  let inst = fileBtn.__vueParentComponent
  let groups = null
  for (let i = 0; inst && i < 6 && !groups; i++) {
    if (inst.setupState?.GROUPS) groups = inst.setupState.GROUPS
    inst = inst.parent
  }
  if (!groups) return JSON.stringify({ err: 'GROUPS not reachable' })
  const fileGroup = (groups.value ?? groups).find((g) => g.key === 'f')
  const sub = fileGroup.items.find((it) => it && it.children)
  return JSON.stringify({
    labelKey: sub.labelKey,
    children: sub.children.map((ch) => ({ labelKey: ch.labelKey, src: String(ch.run).replace(/\\s+/g, ' ') }))
  })
})()`

const MENU = `(() => {
  // 必须排除二级浮层（它同样带 .topmenu-drop.fixed）
  const p = document.querySelector('.topmenu-drop:not(.topmenu-sub)')
  if (!p) return JSON.stringify({ open: false })
  const t = (k) => window.__M.app.config.globalProperties.$t(k)
  const rows = [...p.querySelectorAll('button')].map((b) => ({
    text: b.textContent.trim(),
    caret: !!b.querySelector('svg + svg')
  }))
  return JSON.stringify({ open: true, items: rows.map((r) => r.text), exportLabel: t('menu.export'), formats: ['exportPdf', 'exportHtml', 'exportWord', 'exportEpub'].map((k) => t('menu.' + k)) })
})()`

const SUB = `(() => {
  const s = document.querySelector('.topmenu-sub')
  if (!s) return JSON.stringify({ open: false })
  const panel = document.querySelector('.topmenu-drop:not(.topmenu-sub)')
  const sr = s.getBoundingClientRect()
  const pr = panel?.getBoundingClientRect()
  return JSON.stringify({
    open: true,
    header: s.querySelector('p')?.textContent?.trim() ?? null,
    items: [...s.querySelectorAll('button')].map((b) => b.textContent.trim()),
    subLeft: Math.round(sr.left),
    panelRight: pr ? Math.round(pr.right) : null,
    gap: pr ? Math.round(sr.left - pr.right) : null
  })
})()`

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  const WS = path.join(os.tmpdir(), 'lumin-menu-ws')
  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  const DOC = path.join(WS, 'menu-export.md')
  fs.writeFileSync(DOC, '# export me\n\nbody text\n', 'utf-8')

  const pages = (await get('/json/list')).filter((t) => t.type === 'page')
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  await w.ev(SETUP)
  await w.ev(`(async () => { window.__M.files().setRoot(${JSON.stringify(WS)}); await window.__M.files().openPath(${JSON.stringify(DOC)}); return 'ok' })()`)
  await sleep(1000)

  const move = async (x, y) => {
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  }
  const clickAt = async (x, y) => {
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await sleep(50)
    await w.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await sleep(40)
    await w.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const esc = async () => {
    await w.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await w.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(350)
  }
  /** Alt+F 打开文件菜单 */
  const openFileMenu = async () => {
    await w.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 1 })
    await w.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 1 })
    await sleep(500)
  }
  /** 取菜单行的中心坐标 */
  const rowCenter = async (label) =>
    JSON.parse(
      await w.ev(`(() => {
        const p = document.querySelector('.topmenu-drop:not(.topmenu-sub)')
        const btn = [...(p?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
        if (!btn) return 'null'
        const r = btn.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`)
    )
  /** 悬停「导出」并把指针平移进浮层（分两步，保证 mouseenter 触发） */
  const hoverExport = async () => {
    const row = await rowCenter((await menuInfo()).exportLabel)
    if (!row) return null
    await move(row.x - 6, row.y)
    await sleep(60)
    await move(row.x, row.y)
    await sleep(500)
    return JSON.parse(await w.ev(SUB))
  }
  const menuInfo = async () => JSON.parse(await w.ev(MENU))

  try {
    // ── ① 一级菜单里「导出」是单个一级项 ──
    await openFileMenu()
    const menu = await menuInfo()
    console.log('MENU ' + JSON.stringify(menu))
    c('file-menu-opens', menu.open === true, JSON.stringify(menu))
    c('export-is-single-top-level', menu.items.filter((x) => x === menu.exportLabel).length === 1, JSON.stringify(menu.items))
    c('no-flat-export-items', menu.formats.every((f) => !menu.items.includes(f)), JSON.stringify(menu.items))

    // ── ② 悬停展开二级，列出四种格式 ──
    const sub = await hoverExport()
    console.log('SUB ' + JSON.stringify(sub))
    c('submenu-opens-on-hover', sub?.open === true, JSON.stringify(sub))
    c('submenu-header-is-export', sub?.header === menu.exportLabel, JSON.stringify(sub?.header))
    c('submenu-lists-four-formats', JSON.stringify(sub?.items) === JSON.stringify(menu.formats), JSON.stringify(sub?.items))

    // ── ③ 贴死一级面板（重叠 1px） ──
    c('submenu-flush-right', typeof sub?.gap === 'number' && Math.abs(sub.gap + 1) <= 1, `gap=${sub?.gap} panelRight=${sub?.panelRight} subLeft=${sub?.subLeft}`)

    // ── ④ 指针平移进浮层不关闭（160ms 宽限内进入即撤销） ──
    const subRect = JSON.parse(
      await w.ev(`(() => { const r = document.querySelector('.topmenu-sub').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 30), y: Math.round(r.top + 40) }) })()`)
    )
    await move(subRect.x, subRect.y)
    await sleep(500)
    const stillOpen = JSON.parse(await w.ev(SUB))
    c('submenu-survives-pointer-move', stillOpen.open === true, JSON.stringify(stillOpen?.items))

    // ── ⑤ 悬停普通项 → 浮层收起 ──
    const saveRow = await rowCenter(await w.ev(`window.__M.app.config.globalProperties.$t('menu.save')`))
    await move(saveRow.x, saveRow.y)
    await sleep(500)
    const closedByLeaf = JSON.parse(await w.ev(SUB))
    c('submenu-closes-on-plain-row', closedByLeaf.open === false, JSON.stringify(closedByLeaf))

    // ── ⑥ Esc 先收浮层，再收菜单 ──
    await hoverExport()
    await esc()
    const afterEsc1 = JSON.parse(await w.ev(SUB))
    const menuAfterEsc1 = await menuInfo()
    await esc()
    const menuAfterEsc2 = await menuInfo()
    c('esc-closes-submenu-first', afterEsc1.open === false && menuAfterEsc1.open === true, JSON.stringify({ sub: afterEsc1.open, menu: menuAfterEsc1.open }))
    c('esc-then-closes-menu', menuAfterEsc2.open === false, JSON.stringify(menuAfterEsc2))

    // ── ⑦ 动作接线（读组件菜单数据，不执行导出：点击会弹系统「另存为」对话框） ──
    const wiring = JSON.parse(await w.ev(WIRING))
    console.log('WIRING ' + JSON.stringify(wiring))
    const want = [
      ['menu.exportPdf', 'pdf'],
      ['menu.exportHtml', 'html'],
      ['menu.exportWord', 'word'],
      ['menu.exportEpub', 'epub']
    ]
    c('wiring-submenu-label', wiring.labelKey === 'menu.export', JSON.stringify(wiring.labelKey))
    c(
      'wiring-four-leaf-labels',
      JSON.stringify((wiring.children ?? []).map((x) => x.labelKey)) === JSON.stringify(want.map(([k]) => k)),
      JSON.stringify((wiring.children ?? []).map((x) => x.labelKey))
    )
    c(
      'wiring-each-calls-runExport',
      want.every(([labelKey, fmt]) => {
        const ch = (wiring.children ?? []).find((x) => x.labelKey === labelKey)
        return !!ch && ch.src.includes(`runExport("${fmt}")`)
      }),
      JSON.stringify((wiring.children ?? []).map((x) => x.src))
    )

    // 普通项点击仍会关闭菜单（复用与二级项相同的 runLeaf 路径；这里点「保存」不弹对话框）
    await openFileMenu()
    const saveRow2 = await rowCenter(await w.ev(`window.__M.app.config.globalProperties.$t('menu.save')`))
    await clickAt(saveRow2.x, saveRow2.y)
    await sleep(800)
    c('leaf-click-closes-menu', (await menuInfo()).open === false, JSON.stringify(await menuInfo()))
  } finally {
    await esc().catch(() => {})
    await w.ev(`(async () => { window.__M.files().close(); return 'ok' })()`).catch(() => {})
    fs.rmSync(WS, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
