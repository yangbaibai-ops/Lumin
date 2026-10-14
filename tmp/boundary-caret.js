'use strict'
/**
 * 第一百一十二轮验收②：把光标**恰好**设在 img.from / img.to ⇒ 显隐结果稳定且与注释一致
 * 用法：node tmp/boundary-caret.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
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
  const click = async (x, y, s = 400) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const dismiss = async () => { for (let i = 0; i < 8; i++) { const h = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`); if (!h) break; await sleep(650) } }
  await ev(`(() => { if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK' })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300); await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(900); await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(800)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  const snap = () => json(`(() => { const s = window.__vt.ed().state.selection; const el = document.querySelector('.ProseMirror [data-img-revealed]'); const pm = document.querySelector('.ProseMirror')
    return { from: s.from, to: s.to, empty: s.empty, revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, open: pm.getAttribute('data-img-open'), cls: el ? String(el.className).replace('img-src-revealed--editing','RE').replace('img-src-revealed','R') : null, ov: document.querySelectorAll('.img-src-overlay > div').length } })()`)
  const setCaret = (p) => ev(`(() => { const v = window.__vt.ed().view; v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, ${p}))); return 'ok' })()`)
  const out = { tag: TAG, cases: [] }
  const runCase = async (name, pos) => {
    await click(away.x, away.y, 260)
    // 先激活（让 254 显形），再把光标精确放到 pos
    const pt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="254"] img'); const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
    await click(pt.x, pt.y, 650)
    await setCaret(pos)
    await sleep(500)
    const seq = []
    for (let i = 0; i < 32; i++) { const s = await snap(); seq.push(`${s.revealed ? 'R' + (s.cls && s.cls.includes('RE') ? 'E' : '') : '-'}|ov${s.ov}|open${s.open}|sel${s.from}-${s.to}`); await sleep(20) }
    const ded = seq.filter((v, i) => i === 0 || v !== seq[i - 1])
    out.cases.push({ name, pos, dedup: ded, stable: ded.length === 1, samples: seq.length })
  }
  await runCase('img.from (254, 前一段的 to 也是它)', 254)
  await runCase('img.to (355)', 355)
  await runCase('from+1 (255, 严格之内)', 255)
  fs.writeFileSync(`tmp/boundary-caret-${TAG}.json`, JSON.stringify(out, null, 1))
  for (const c of out.cases) console.log(`${c.name} pos=${c.pos} 稳定=${c.stable} samples=${c.samples}\n   ${JSON.stringify(c.dedup)}`)
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
