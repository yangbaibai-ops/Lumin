'use strict'
// 复刻新版算法（collectRowRects + 行盒分组）并打印每组明细，找出污染行盒的矩形
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const W = Number(process.argv[3] || 1424)
const IDX = Number(process.argv[4] || 1)
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-rowfix-fixture.md'
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
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(450)
  }
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(650)
    }
  }
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
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(COPY)}); return 'ok' })()`)
  await sleep(1400)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(${W}, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) {
    if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break
    await sleep(400)
  }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  const pt = await json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][${IDX}]; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  await click(pt.x, pt.y)
  const out = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const REPLACED = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED'])
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const el = p.querySelector('[data-img-revealed]')
    const parts = []
    const walk = (parent) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child === el) continue
        if (child.nodeType === 3) {
          const tn = child
          if (!tn.length) continue
          const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, tn.length)
          for (const r of Array.from(rg.getClientRects())) if (r.height > 0) parts.push({ who: '#text:' + (tn.textContent||'').slice(0,10), pos: 'text', ...R(r) })
          continue
        }
        if (child.nodeType !== 1) continue
        const e = child
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        if (e.classList.contains('katex')) continue
        const replaced = REPLACED.has(e.tagName)
        if ((replaced || cs.display.startsWith('inline')) && cs.position === 'static') {
          for (const r of Array.from(e.getClientRects())) if (r.height > 0) parts.push({ who: e.tagName + '.' + String(e.className).slice(0,26), pos: cs.position, disp: cs.display, ...R(r) })
        }
        walk(e)
      }
    }
    walk(p)
    const frags = el ? [...el.getClientRects()].map(R) : []
    const rows = []
    for (const r of parts.concat(frags.map((f) => ({ who: 'FRAG', ...f }))).sort((a, b) => a.t - b.t)) {
      const hit = rows.find((g) => r.t < g.b - 0.5 && r.b > g.t + 0.5)
      if (hit) { hit.t = Math.min(hit.t, r.t); hit.b = Math.max(hit.b, r.b); hit.members.push(r) }
      else rows.push({ t: r.t, b: r.b, members: [r] })
    }
    return {
      pRect: R(p.getBoundingClientRect()), frags,
      overlayRects: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())),
      rows: rows.map((g) => ({ t: +g.t.toFixed(2), b: +g.b.toFixed(2), h: +(g.b - g.t).toFixed(2), members: g.members }))
    }
  })()`)
  fs.writeFileSync(`tmp/row-groups-${IDX}.json`, JSON.stringify(out, null, 1))
  console.log('pRect', JSON.stringify(out.pRect))
  console.log('frags', JSON.stringify(out.frags))
  console.log('overlay', JSON.stringify(out.overlayRects))
  out.rows.forEach((g, i) => {
    console.log(`row#${i} t=${g.t} b=${g.b} h=${g.h}  members=${g.members.length}`)
    for (const m of g.members) console.log(`    ${m.who} [${m.disp || ''} ${m.pos || ''}] l=${m.l} r=${m.r} t=${m.t} b=${m.b} w=${m.w} h=${m.h}`)
  })
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
