// 验收：「一个文件只开一个窗口」——文件已开在别的窗口时聚焦那个窗口，而不是再开一个
//
// 覆盖：注册表（渲染层上报 → 主进程记录）、跨窗口聚焦、最小化窗口被唤回、
// 无人打开时返回 not-open 并真的新建窗口、走真实入口 openExternalFile / openInWindowOrFocus
// 的两条分支、窗口关闭后注册表清账。
//
// 跑法：独立 userData 实例（见 §4.23），不碰用户正在用的窗口与数据。
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
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = app._context.provides[sym]
  window.__D = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), app }
  return 'ok'
})()`

const STATE = `JSON.stringify({
  doc: window.__D.files().current?.path ?? null,
  root: window.__D.files().root,
  focused: document.hasFocus(),
  visible: document.visibilityState === 'visible'
})`

const pages = async () => (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
const attach = async (page) => {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await c.ev(SETUP)) === 'ok' && (await c.ev(`window.__D.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await c.ev(SETUP)
  c.id = page.id
  return c
}
const st = async (w) => JSON.parse(await w.ev(STATE))

/** focus/blur 事件记录（判定「窗口是否被唤到前面」比 hasFocus()/visibilityState 可靠） */
const installFocusLog = (w) =>
  w.ev(`(() => {
    if (!window.__focusLog) {
      window.__focusLog = []
      window.addEventListener('focus', () => window.__focusLog.push('focus'))
      window.addEventListener('blur', () => window.__focusLog.push('blur'))
    }
    window.__focusLog.length = 0
    return 'ok'
  })()`)
const clearFocusLog = (w) => w.ev(`(window.__focusLog.length = 0, 'ok')`)
const focusLog = async (w) => JSON.parse(await w.ev(`JSON.stringify(window.__focusLog)`))

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const F = path.join(os.tmpdir(), 'lumin-dedup-f')
  fs.rmSync(F, { recursive: true, force: true })
  fs.mkdirSync(F, { recursive: true })
  const X = path.join(F, 'x.md')
  const Y = path.join(F, 'y.md')
  fs.writeFileSync(X, '# x\n\ncontent x\n', 'utf-8')
  fs.writeFileSync(Y, '# y\n\ncontent y\n', 'utf-8')

  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const wA = await attach(all[0])
  const extra = []
  try {
    // A 打开 X（并上报给主进程）
    await wA.ev(`(async () => { const f = window.__D.files(); await f.setRoot(${JSON.stringify(F)}); await f.openPath(${JSON.stringify(X)}); return 'ok' })()`)
    await sleep(1200)
    const a0 = await st(wA)
    console.log('A ' + JSON.stringify(a0))
    c('a-has-x', a0.doc === X, JSON.stringify(a0.doc))

    // 新建一个干净窗口 B（新窗口会抢焦点）
    const seen = new Set(all.map((p) => p.id))
    await wA.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
    let wB = null
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const fresh = (await pages()).find((p) => !seen.has(p.id))
      if (fresh) {
        wB = await attach(fresh)
        break
      }
    }
    if (!wB) throw new Error('第二个窗口没有出现')
    extra.push(wB)
    await sleep(800)
    await installFocusLog(wA)
    await installFocusLog(wB)

    // ① 从 B 问：谁开着 X → 应聚焦 A，且不新建窗口
    const winCount0 = (await pages()).length
    const r1 = await wB.ev(`window.luminAPI.app.focusWindowByDoc(${JSON.stringify(X)})`)
    await sleep(900)
    const a1 = await st(wA)
    const b1 = await st(wB)
    const winCount1 = (await pages()).length
    console.log('CASE1 ' + JSON.stringify({ r1, a: a1, b: b1, winCount0, winCount1 }))
    c('focus-by-doc-returns-focused', r1 === 'focused', r1)
    c('target-window-focused', a1.focused === true, JSON.stringify(a1))
    c('caller-window-not-focused', b1.focused === false, JSON.stringify(b1))
    c('no-new-window-created', winCount1 === winCount0, `${winCount0} -> ${winCount1}`)

    // ② 把 A 最小化后再问 → 应还原并聚焦
    await wA.ev(`(window.luminAPI.app.minimize(), 'ok')`)
    await sleep(900)
    const aMin = await st(wA)
    await clearFocusLog(wA)
    await clearFocusLog(wB)
    const r2 = await wB.ev(`window.luminAPI.app.focusWindowByDoc(${JSON.stringify(X)})`)
    await sleep(1400)
    const a2 = await st(wA)
    const logs2 = { a: await focusLog(wA), b: await focusLog(wB) }
    console.log('CASE2 ' + JSON.stringify({ aMin, r2, aAfter: a2, logs2 }))
    c('minimized-before-focus', aMin.visible === false || aMin.focused === false, JSON.stringify(aMin))
    // 注意：visibilityState 会把「被完全遮挡」也算成 hidden（级联窗口会互相遮挡），
    // 因此判定「被唤到前面」看 focus 事件流：A 收到 focus、B 收到 blur。
    c('focus-brings-window-forward', r2 === 'focused' && logs2.a.includes('focus') && logs2.b.includes('blur'), JSON.stringify({ r2, logs2, aAfter: a2 }))

    // ③ 没人打开的 Y → not-open（调用方据此会走新窗口）
    const r3 = await wB.ev(`window.luminAPI.app.focusWindowByDoc(${JSON.stringify(Y)})`)
    c('unknown-doc-returns-not-open', r3 === 'not-open', r3)

    // ④ 真实入口：B **没有工作区** 时打开一个已在别处开着的文件 X
    //    → 必须先判「别的窗口开着吗」，聚焦 A，而不是在本窗口再开一份（回归用例：
    //      早期版本把「本窗口没有工作台就直接打开」排在前面，会开出两份 X）
    const winCount2 = (await pages()).length
    const r4 = await wB.ev(`(async () => { const m = await import('/src/lib/openFile.ts'); return String(await m.openExternalFile(${JSON.stringify(X)})) })()`)
    await sleep(900)
    const a4 = await st(wA)
    const b4 = await st(wB)
    const winCount3 = (await pages()).length
    console.log('CASE4 ' + JSON.stringify({ r4, a: a4, b: b4, winCount2, winCount3 }))
    c('no-workspace-still-focuses-existing', r4 === 'focused-existing', r4)
    c('no-workspace-does-not-open-second-copy', b4.doc === null, JSON.stringify(b4))
    c('no-workspace-no-new-window', winCount3 === winCount2, `${winCount2} -> ${winCount3}`)
    c('no-workspace-focused-target', a4.focused === true, JSON.stringify(a4))

    // ⑤ B 没有工作区 + 文件没人开着 → 在本窗口打开，并把侧栏切到该文件的文件夹
    const r5 = await wB.ev(`(async () => { const m = await import('/src/lib/openFile.ts'); return String(await m.openExternalFile(${JSON.stringify(Y)})) })()`)
    await sleep(1200)
    const b5 = await st(wB)
    console.log('CASE5 ' + JSON.stringify({ r5, b: b5 }))
    c('workspace-less-window-opens-here', r5 === 'opened-here', r5)
    c('workspace-less-window-gets-doc', b5.doc === Y, JSON.stringify(b5))
    c('workspace-less-window-sidebar-switched', b5.root === F, JSON.stringify(b5.root))

    // ⑥ B 现在有工作区了；打开一个**没人开着**的 Z → 新窗口
    const Z = path.join(F, 'z.md')
    fs.writeFileSync(Z, '# z\n\ncontent z\n', 'utf-8')
    const r6 = await wB.ev(`(async () => { const m = await import('/src/lib/openFile.ts'); return String(await m.openExternalFile(${JSON.stringify(Z)})) })()`)
    let wZ = null
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const fresh = (await pages()).find((p) => !seen.has(p.id) && p.id !== wB.id)
      if (fresh) {
        wZ = await attach(fresh)
        break
      }
    }
    if (!wZ) throw new Error('打开 Z 的新窗口没有出现')
    extra.push(wZ)
    await sleep(1000)
    const z6 = await st(wZ)
    console.log('CASE6 ' + JSON.stringify({ r6, newWindow: z6 }))
    c('unknown-file-opens-new-window', r6 === 'opened-in-new-window', r6)
    c('new-window-has-z', z6.doc === Z, JSON.stringify(z6))

    // ⑦ 最近文档入口（openInWindowOrFocus）：X 已开在 A → 聚焦而不是再开
    const winCount4 = (await pages()).length
    const r7 = await wB.ev(`(async () => { const m = await import('/src/lib/openFile.ts'); return String(await m.openInWindowOrFocus(${JSON.stringify(X)})) })()`)
    await sleep(900)
    const a7 = await st(wA)
    const winCount5 = (await pages()).length
    console.log('CASE7 ' + JSON.stringify({ r7, a: a7, winCount4, winCount5 }))
    c('recent-entry-focuses-existing', r7 === 'focused-existing', r7)
    c('recent-entry-no-new-window', winCount5 === winCount4, `${winCount4} -> ${winCount5}`)
    c('recent-entry-focused-target', a7.focused === true, JSON.stringify(a7))

    // ⑧ A 关掉后注册表清账 → X 变成 not-open
    await wA.send('Page.close').catch(() => {})
    await sleep(1500)
    const r8 = await wB.ev(`window.luminAPI.app.focusWindowByDoc(${JSON.stringify(X)})`)
    c('registry-cleaned-on-window-close', r8 === 'not-open', r8)
  } finally {
    for (const w of extra) if (w.ws.readyState === 1) await w.send('Page.close').catch(() => {})
    await sleep(700)
    fs.rmSync(F, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  if (wA.ws.readyState === 1) wA.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
