'use strict'
/** 诊断：为什么 (342,370) 的按下没被"行盒空白带"接管 —— dump 显形元素的 kind/class/几何 + 按下前后的模型选区 */
const PORT = process.argv[2] || '9351'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const mouse = (t, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type: t, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 320) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const dump = () => json(`(() => {
    const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]
    const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const s = window.__vt.ed().state.selection
    return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), own: document.querySelector('.ProseMirror').getAttribute('data-sel-own'),
      revealed: els.map((el) => ({ kind: el.getAttribute('data-img-kind'), cls: String(el.className), from: el.getAttribute('data-img-from'), rects: [...el.getClientRects()].map(R) })),
      para: p ? R(p.getBoundingClientRect()) : null,
      overlay: [...document.querySelectorAll('.img-src-overlay > div')].map((e) => R(e.getBoundingClientRect())) } })()`)
  const g = await json(`(() => { const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const w = [...p.querySelectorAll('[data-img-widget]')].pop(); return { img: R(w.getBoundingClientRect()), para: R(p.getBoundingClientRect()) } })()`)
  console.log('img=' + JSON.stringify(g.img))
  await click(950, 830, 320)
  console.log('away: ' + JSON.stringify(await dump()))
  await click(Math.round(g.img[2] + 26), Math.round((g.img[1] + g.img[3]) / 2), 520)
  const st = await dump()
  console.log('after blank-band click: ' + JSON.stringify(st))
  await mouse('mousePressed', 342, 370); await sleep(60)
  console.log('after press(342,370): ' + JSON.stringify(await dump()))
  await mouse('mouseMoved', 700, 370, { buttons: 1 }); await sleep(40)
  console.log('after move(700,370): ' + JSON.stringify(await dump()))
  await mouse('mouseReleased', 700, 370); await sleep(300)
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1) })
