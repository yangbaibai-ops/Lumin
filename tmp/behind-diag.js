'use strict'
// 诊断：同一状态下"纯文字拖动"到底能不能建立选区（排查探针本身）
const PORT = process.argv[2] || '9351'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-behind-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const dismiss = async () => { for (let i = 0; i < 8; i++) { const h = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`); if (!h) break; await sleep(650) } }
  await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(900)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }
  console.log('focus/active', await ev(`JSON.stringify({ hasFocus: document.hasFocus(), act: document.activeElement ? String(document.activeElement.className).slice(0,30) : null })`))
  const info = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3)
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length))
    return { p: R(p.getBoundingClientRect()), text: R(rg.getBoundingClientRect()), widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect())) }
  })()`)
  console.log('info', JSON.stringify(info))
  const drag = async (x0, y0, x1, y1) => {
    await mouse('mousePressed', x0, y0)
    await sleep(40)
    for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12, { buttons: 1 }); await sleep(20) }
    await sleep(40)
    const mid = await ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '/' + s.to + '/' + s.empty })()`)
    await mouse('mouseReleased', x1, y1)
    await sleep(400)
    const after = await ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '/' + s.to + '/' + s.empty })()`)
    return { mid, after }
  }
  // A) 纯文字上按下往右拖（应当能选）
  console.log('A 纯文字 (text.l+6,textMid) → +160:', JSON.stringify(await drag(info.text.l + 6, Math.round((info.text.t + info.text.b) / 2), info.text.l + 160, Math.round((info.text.t + info.text.b) / 2))))
  // B) 图片右侧按下往左拖
  const w1 = info.widgets[1]
  console.log('B 图右 → 左:', JSON.stringify(await drag(w1.r + 40, Math.round((w1.t + w1.b) / 2), w1.l - 40, Math.round((w1.t + w1.b) / 2))))
  // C) 图片右侧按下往左拖（更慢、更多步）
  console.log('C 图右 → 左(慢):', JSON.stringify(await drag(w1.r + 12, Math.round((w1.t + w1.b) / 2), info.text.l + 6, Math.round((info.text.t + info.text.b) / 2))))
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
