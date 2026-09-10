// 验收：多窗口一致性 —— 通知在任一窗口产生/关闭后，其它窗口的通知中心同步刷新
// （主进程每次变更广播 notifications:changed，各窗口 store 重新对齐 SQLite）
const CDP = 'http://127.0.0.1:9222/json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP_VT = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym]
  window.__vt = { ui: () => pinia._s.get('ui'), notif: () => pinia._s.get('notifications') }
  return 'ok'
})()`
const SNAP = `(() => JSON.stringify({
  store: window.__vt.notif().items.map((n) => n.title),
  cards: document.querySelectorAll('.ntf-card').length,
  title: document.querySelector('.ntf-card p')?.textContent?.trim() ?? null
}))()`

async function main() {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // 清理历史行，保证从空开始
  const targets0 = await (await fetch(CDP)).json()
  const pages0 = targets0.filter((t) => t.type === 'page')
  if (pages0.length !== 1) {
    console.log('SKIP: 期望只有 1 个窗口，实际 ' + pages0.length)
    return
  }
  const a = connect(pages0[0].webSocketDebuggerUrl)
  await a.ready
  await a.send('Page.enable')
  await a.ev(SETUP_VT)
  await a.ev(`(async () => { await window.luminAPI.notifications.closeAll(); await window.luminAPI.notifications.clearClosed(); return 'ok' })()`)

  // 开第二个窗口
  await a.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
  let pageB = null
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    const list = await (await fetch(CDP)).json()
    const pages = list.filter((t) => t.type === 'page' && t.url.includes('5173'))
    if (pages.length >= 2) {
      pageB = pages.find((p) => p.id !== pages0[0].id)
      break
    }
  }
  if (!pageB) {
    console.log('SKIP: 第二个窗口未出现')
    a.ws.close()
    return
  }
  const b = connect(pageB.webSocketDebuggerUrl)
  await b.ready
  await b.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    if ((await b.ev(SETUP_VT)) === 'ok' && (await b.ev(`window.__vt.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await b.ev(SETUP_VT)
  await sleep(600)

  const beforeA = JSON.parse(await a.ev(SNAP))
  const beforeB = JSON.parse(await b.ev(SNAP))
  console.log('BEFORE  A=' + JSON.stringify(beforeA) + ' B=' + JSON.stringify(beforeB))

  // 窗口 A 产生通知 → B 应同步出现
  await a.ev(`(async () => { await window.__vt.notif().notify({ level: 'warning', title: '跨窗口通知', body: '来自窗口 A' }); return 'ok' })()`)
  await sleep(1400)
  const afterA = JSON.parse(await a.ev(SNAP))
  const afterB = JSON.parse(await b.ev(SNAP))
  console.log('AFTER-A A=' + JSON.stringify(afterA) + ' B=' + JSON.stringify(afterB))
  c('created-in-A', afterA.store.includes('跨窗口通知') && afterA.cards === 1, JSON.stringify(afterA))
  c('mirrored-in-B', afterB.store.includes('跨窗口通知') && afterB.cards === 1 && afterB.title === '跨窗口通知', JSON.stringify(afterB))

  // 窗口 B 关闭它 → A 应同步消失
  await b.ev(`(async () => { const n = window.__vt.notif(); await n.close(n.items[0].id); return 'ok' })()`)
  await sleep(1400)
  const closedA = JSON.parse(await a.ev(SNAP))
  const closedB = JSON.parse(await b.ev(SNAP))
  console.log('AFTER-CLOSE A=' + JSON.stringify(closedA) + ' B=' + JSON.stringify(closedB))
  c('close-in-B-mirrored-in-A', closedA.cards === 0 && closedA.store.length === 0 && closedB.store.length === 0, JSON.stringify({ a: closedA, b: closedB }))

  // 关闭第二个窗口并清理
  await b.send('Page.close').catch(() => {})
  await sleep(800)
  await a.ev(`(async () => { await window.luminAPI.notifications.closeAll(); await window.luminAPI.notifications.clearClosed(); window.__vt.notif().items = []; window.__vt.notif().activeId = null; return 'ok' })()`)
  const left = await a.ev(`(async () => (await window.luminAPI.notifications.list({ includeClosed: true })).length)()`)
  c('cleanup-empty', left === 0, 'left=' + left)
  console.log(results.join('\n'))
  a.ws.close()
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
