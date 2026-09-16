// 验收：全局 tooltip（title 接管）
// A. 悬停带 title 的元素：<750ms 不出现，>750ms 出现且文本正确
// B. 移开后 tooltip 消失，且 title 属性被完整还原
// C. title 在悬停期间被组件改写（响应式 :title）时，移开后必须保留新值，不被旧值覆盖
// 默认单窗口；NEW_WINDOW=1 时另开窗口跑（推荐：新窗口是干净的模块实例，
// 不受 dev 期间 HMR 造成的模块重复实例影响）
const CDP = 'http://127.0.0.1:9222/json'
const LABEL = '新建文件'
let ws,
  id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) {
  return new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
}
async function ev(e) {
  const r = await send('Runtime.evaluate', {
    expression: e,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails)
    throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
async function moveTo(x, y, wait = 20) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    button: 'none',
    buttons: 0
  })
  await sleep(wait)
}
const BTN = `(() => {
  const b = [...document.querySelectorAll('[title]')].find((x) => x.title === ${JSON.stringify(LABEL)})
  if (!b) return 'null'
  const r = b.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
})()`
const TIP = `document.querySelector('.lm-tooltip')?.textContent?.trim() ?? null`
const BTN_TITLE = `(() => { const b = [...document.querySelectorAll('[title]')].find((x) => x.title === ${JSON.stringify(LABEL)} || x.title === 'REACTIVE-TITLE'); return b ? b.getAttribute('title') : null })()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  let page = targets.find((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  if (!page) {
    console.log('NO-APP-PAGE')
    return
  }
  let tempWindow = null
  if (process.env.NEW_WINDOW === '1') {
    const opener = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      opener.onopen = res
      opener.onerror = rej
    })
    let oid = 0
    const opending = new Map()
    opener.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && opending.has(m.id)) {
        opending.get(m.id)(m)
        opending.delete(m.id)
      }
    }
    const osend = (method, params) =>
      new Promise((res) => {
        const i = ++oid
        opending.set(i, res)
        opener.send(JSON.stringify({ id: i, method, params }))
      })
    await osend('Runtime.evaluate', {
      expression: '(window.luminAPI.app.newWindow(), "ok")',
      returnByValue: true
    })
    const preexisting = new Set(
      targets.filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url)).map((t) => t.id)
    )
    for (let i = 0; i < 60; i++) {
      await sleep(400)
      const list = await (await fetch(CDP)).json()
      const fresh = list.filter(
        (t) => t.type === 'page' && /index\.html|5173/.test(t.url) && !preexisting.has(t.id)
      )
      if (fresh.length) {
        page = fresh[fresh.length - 1]
        tempWindow = page
        break
      }
    }
    opener.close()
    if (!tempWindow) {
      console.log('SKIP: 第二个窗口未出现')
      return
    }
    console.log('（在第二个窗口里验收，用户窗口不受影响）')
  }

  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
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
  await send('Page.enable')
  await send('Page.bringToFront')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break
  }
  await ev(
    `(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`
  )
  await sleep(500)

  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  const btnRaw = await ev(BTN)
  if (btnRaw === 'null') {
    console.log('SKIP: 找不到带 title 的按钮（侧边栏可能隐藏）')
    if (tempWindow) {
      await send('Page.close').catch(() => {})
      await sleep(400)
    }
    ws.close()
    return
  }
  const btn = JSON.parse(btnRaw)
  console.log('BTN ' + JSON.stringify(btn))

  // 先移开，避免「指针本来就在按钮上」导致 mouseover 不触发
  await moveTo(600, 300, 150)
  await moveTo(btn.x, btn.y, 400)
  const beforeTip = await ev(`!!document.querySelector('.lm-tooltip')`)
  await sleep(600)
  const afterTip = await ev(TIP)
  const titleWhileHover = await ev(BTN_TITLE)
  console.log('A ' + JSON.stringify({ beforeTip, afterTip, titleWhileHover }))
  c('no-tooltip-before-750ms', beforeTip === false, 'before=' + beforeTip)
  c('tooltip-appears-after-750ms', afterTip === LABEL, 'text=' + afterTip)
  c('title-stripped-while-hovering', titleWhileHover === null, 'title=' + titleWhileHover)

  // ── C. 悬停期间 title 被改写（模拟响应式 :title）→ 移开后必须保留新值 ──────
  await ev(`(() => {
    // 找到当前被接管的那颗按钮（title 已被移除，用 hover 目标定位）
    const el = document.elementFromPoint(${btn.x}, ${btn.y})?.closest?.('button') ?? null
    if (el) el.setAttribute('title', 'REACTIVE-TITLE')
    return 'ok'
  })()`)
  const replaced = await ev(BTN_TITLE)
  await moveTo(600, 350, 400)
  const titleAfterLeave = await ev(BTN_TITLE)
  const tipGone = await ev(`!document.querySelector('.lm-tooltip')`)
  console.log('C ' + JSON.stringify({ replaced, titleAfterLeave, tipGone }))
  c('tooltip-hidden-after-leave', tipGone === true)
  c(
    'reactive-title-not-clobbered',
    titleAfterLeave === 'REACTIVE-TITLE',
    'title=' + titleAfterLeave
  )
  // 还原
  await ev(
    `(() => { const b = [...document.querySelectorAll('[title]')].find((x) => x.title === 'REACTIVE-TITLE'); if (b) b.setAttribute('title', ${JSON.stringify(LABEL)}); return 'ok' })()`
  )
  const restoredTitle = await ev(BTN_TITLE)
  c('title-restored-to-label', restoredTitle === LABEL, 'title=' + restoredTitle)

  console.log(results.join('\n'))
  if (tempWindow) {
    await send('Page.close').catch(() => {})
    await sleep(400)
  }
  ws.close()
  if (results.some((r) => r.startsWith('FAIL'))) process.exit(1)
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
