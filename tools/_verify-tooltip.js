// 验证全局 tooltip：悬停带 title 的元素 750ms 后出现 .lm-tooltip，文本匹配。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  // 找一个带 title 的按钮（侧边栏「新建文件」）
  const el = await ev(`(() => {
    const b = [...document.querySelectorAll('[title]')].find((x) => x.title === '新建文件')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: b.title }
  })()`)
  if (!el) { console.log('FAIL no title element'); process.exit(2) }

  // 悬停
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: el.x, y: el.y })
  await sleep(400)
  const before = await ev(`!!document.querySelector('.lm-tooltip')`)
  await sleep(500) // 总共 ~900ms > 750ms
  const after = await ev(`(() => { const t = document.querySelector('.lm-tooltip'); return t ? JSON.stringify({ text: t.textContent.trim(), bg: getComputedStyle(t).backgroundColor, visible: t.offsetParent !== null }) : 'none' })()`)
  console.log('tooltip before 750ms:', before)
  console.log('tooltip after 750ms:', after)

  // 移走，检查隐藏
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await sleep(200)
  const hidden = await ev(`!document.querySelector('.lm-tooltip')`)
  console.log('tooltip hidden after leave:', hidden)

  ws.close()
  process.exit(before === false && after !== 'none' && hidden === true ? 0 : 1)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
