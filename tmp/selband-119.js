'use strict'
/**
 * 第一百一十九轮验收：先冒烟（正文起手能不能建选区），再**从图片后起手**把 head 拖到含公式的行，
 * 用纯数值拿 S1（公式段 vs 同排正文段 + 行盒高）与 S2（拖动中 vs 松手后，四类）。
 * 用法：node tmp/selband-119.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-selband-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

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
  const click = async (x, y, s = 340) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
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
  const sel = () => ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') })()`)
  const parseBands = (s) => (s || '').split(';').filter(Boolean).map((t) => { const [l, tp, r, b] = t.split(',').map(Number); return { l, t: tp, r, b, h: +(b - tp).toFixed(2) } })

  // ── 冒烟：正文起手
  const smoke = await json(`(() => { const root = document.querySelector('.ProseMirror'); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n = null, hit = null; while ((n = w.nextNode())) { if (!n.parentElement || !n.parentElement.closest('p')) continue; if ((n.textContent || '').trim().length > 6) { hit = n; break } } if (!hit) return { x0: 0, x1: 0, y: 0 }; const rg = document.createRange(); rg.selectNodeContents(hit); const r = rg.getBoundingClientRect(); return { x0: Math.round(r.left + 6), x1: Math.round(r.right - 6), y: Math.round((r.top + r.bottom) / 2) } })()`)
  await click(away.x, away.y, 260)
  const beforeSmoke = await sel()
  await mouse('mousePressed', smoke.x0, smoke.y)
  await sleep(35)
  for (let k = 1; k <= 14; k++) { await mouse('mouseMoved', smoke.x0 + ((smoke.x1 - smoke.x0) * k) / 14, smoke.y, { buttons: 1 }); await sleep(18) }
  await sleep(50)
  const midSmoke = await sel()
  await mouse('mouseReleased', smoke.x1, smoke.y)
  await sleep(300)
  const afterSmoke = await sel()
  const smokeOk = !midSmoke.endsWith('E') && !afterSmoke.endsWith('E')
  console.log(`冒烟（正文起手 ${smoke.x0}→${smoke.x1} @y${smoke.y}）: before=${beforeSmoke} midDrag=${midSmoke} after=${afterSmoke} ⇒ ${smokeOk ? '能建选区' : '建不出选区（改用图片后起手）'}`)
  await click(away.x, away.y, 300)

  // ── 目标：三处行内公式所在行 + 块级公式行；用图片后起手把 head 拖到该行
  const targets = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) })
    const out = []
    const blocks = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')]
    for (const b of blocks) {
      const lh = parseFloat(getComputedStyle(b).lineHeight)
      const maths = [...b.querySelectorAll('[data-md-math-rendered]')].map((m) => R(m.getBoundingClientRect()))
      if (!maths.length) continue
      const rects = []
      const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
      let n
      while ((n = walk.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0.5) rects.push({ ...R(r), h: +r.height.toFixed(2) }) }
      for (const m of maths) {
        const row = rects.filter((r) => m.t >= r.t - 25 && m.b <= r.b + 25)
        if (!row.length) continue
        const left = Math.min(...row.map((r) => r.l)), right = Math.max(...row.map((r) => r.r))
        const rel = (m.l - left) / Math.max(1, right - left)
        out.push({ kind: 'inline', pos: rel < 0.15 ? 'start' : rel > 0.75 ? 'end' : 'mid', lh, formula: m, lineLeft: left, lineRight: right, lineTop: Math.min(...row.map((r) => r.t)), lineBottom: Math.max(...row.map((r) => r.b)), textHeights: row.map((r) => r.h), bodyLeft: { l: left, t: Math.min(...row.map((r) => r.t)), r: m.l - 2, b: Math.max(...row.map((r) => r.b)) } })
      }
    }
    const bm = document.querySelector('.ProseMirror [data-md-math-block]')
    if (bm) { const r = R(bm.getBoundingClientRect()); out.push({ kind: 'block', pos: 'block', lh: parseFloat(getComputedStyle(bm.parentElement).lineHeight), formula: r, lineLeft: r.l, lineRight: r.r, lineTop: r.t, lineBottom: r.b, textHeights: [], bodyLeft: { l: r.l, t: r.t, r: r.r, b: r.b } }) }
    return out })()`)
  const geo = await json(`(() => { const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) }); const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); return { widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect())) } })()`)
  const start = { x: Math.round(geo.widgets[1].r + 40), y: Math.round((geo.widgets[1].t + geo.widgets[1].b) / 2) }
  const out = { tag: TAG, smoke: { beforeSmoke, midSmoke, afterSmoke, smokeOk }, start, targets: [] }
  const run = async (label, T) => {
    await click(away.x, away.y, 280)
    // 终点：落在该行正文里（公式左/右侧都试；优先公式左侧的正文）
    const y = Math.round(T.kind === 'block' ? (T.lineTop + T.lineBottom) / 2 : (T.formula.t + T.formula.b) / 2)
    const endX = Math.round(T.kind === 'block' ? T.lineLeft + 20 : Math.min(T.lineRight - 4, Math.max(T.lineLeft + 4, T.formula.l - 8)))
    await mouse('mousePressed', start.x, start.y)
    await sleep(35)
    for (let k = 1; k <= 16; k++) { await mouse('mouseMoved', start.x + ((endX - start.x) * k) / 16, start.y + ((y - start.y) * k) / 16, { buttons: 1 }); await sleep(16) }
    await sleep(50)
    const live = parseBands(await ev(`document.querySelector('.ProseMirror').getAttribute('data-sel-band-live')`))
    const liveDiag = await ev(`document.querySelector('.ProseMirror').getAttribute('data-img-drag-live')`)
    const liveSel = await sel()
    const liveWhy = await ev(`document.querySelector('.ProseMirror').getAttribute('data-sel-band-why')`)
    const liveImgs = await json(`(() => [...document.querySelectorAll('.ProseMirror [data-img-widget].img-selected')].map((w) => { const r = w.getBoundingClientRect(); return { from: w.getAttribute('data-img-from'), l: +r.left.toFixed(2), t: +r.top.toFixed(2), r: +r.right.toFixed(2), b: +r.bottom.toFixed(2) } }))()`)
    await mouse('mouseReleased', endX, y)
    await sleep(450)
    const settled = parseBands(await ev(`document.querySelector('.ProseMirror').getAttribute('data-sel-band-settled')`))
    /** S2 口径：落定那一手会把带按**落定区间**重记一次 ⇒ 读它才是"同一几何函数+同一输入"的对照 */
    const liveFinal = parseBands(await ev(`document.querySelector('.ProseMirror').getAttribute('data-sel-band-live')`))
    const settledSel = await sel()
    const settledImgs = await json(`(() => [...document.querySelectorAll('.ProseMirror [data-img-widget].img-selected')].map((w) => { const r = w.getBoundingClientRect(); return { from: w.getAttribute('data-img-from'), l: +r.left.toFixed(2), t: +r.top.toFixed(2), r: +r.right.toFixed(2), b: +r.bottom.toFixed(2) } }))()`)
    const fallback = await ev(`document.querySelector('.ProseMirror').getAttribute('data-img-settle-fallback')`)
    const leak = await json(`(() => ({ bandKids: document.querySelectorAll('.sel-band > div').length, cls: document.querySelectorAll('.ProseMirror .img-selected').length }))()`)
    // 该行的 band（用 live 集里覆盖该行 y 的那条）
    const cover = (set) => set.filter((b) => b.t <= y + 1 && b.b >= y - 1)
    const liveRow = cover(live), settledRow = cover(settled)
    const deltas = []
    for (let i = 0; i < Math.max(live.length, settled.length); i++) {
      const a = live[i], b = settled[i]
      deltas.push(!a || !b ? { i, missing: a ? 'settled' : 'live' } : { i, dl: +Math.abs(a.l - b.l).toFixed(2), dt: +Math.abs(a.t - b.t).toFixed(2), dr: +Math.abs(a.r - b.r).toFixed(2), db: +Math.abs(a.b - b.b).toFixed(2), dh: +Math.abs(a.h - b.h).toFixed(2) })
    }
    // S1：该行 band 的行盒对比 + 公式段/正文段覆盖
    const inRow = (set, x) => set.find((b) => b.t <= y + 1 && b.b >= y - 1 && x >= b.l - 1 && x <= b.r + 1) || null
    const gapX = (T.formula.l + Math.min(T.lineRight, T.formula.r)) / 2
    const g = {
      label, kind: T.kind, pos: T.pos, y, endX, lh: T.lh, textHeights: T.textHeights,
      liveSel, settledSel, fallback, leak, liveDiag, liveWhy,
      live, settled, liveFinal, deltas, liveRow, settledRow,
      formulaBand: inRow(live, (T.formula.l + T.formula.r) / 2),
      bodyBand: inRow(live, T.bodyLeft.l + 2),
      gapBand: inRow(live, T.formula.r + 2),
      imgLive: liveImgs, imgSettled: settledImgs,
      imgSame: JSON.stringify(liveImgs) === JSON.stringify(settledImgs)
    }
    out.targets.push(g)
    console.log(`\n== ${label} (${T.kind}/${T.pos}) endX=${endX} y=${y} lh=${T.lh} 旧文字盒高=${JSON.stringify(T.textHeights)}`)
    console.log(`   band-why=${liveWhy}`)
    console.log(`   drag-live(锚|head|from|to)=${liveDiag} liveSel=${liveSel} settledSel=${settledSel} fallback=${fallback} 泄漏=${JSON.stringify(leak)}`)
    console.log(`   行内 band: 公式段=${JSON.stringify(g.formulaBand)} 正文段=${JSON.stringify(g.bodyBand)} 缝隙处=${JSON.stringify(g.gapBand)}`)
    console.log(`   live 行内覆盖=${JSON.stringify(liveRow)} settled 行内覆盖=${JSON.stringify(settledRow)}`)
    const dFinal = liveFinal.map((a, i) => {
      const b = settled[i]
      if (!a || !b) return { i, missing: a ? 'settled' : 'liveFinal' }
      return { i, dl: +Math.abs(a.l - b.l).toFixed(2), dt: +Math.abs(a.t - b.t).toFixed(2), dr: +Math.abs(a.r - b.r).toFixed(2), db: +Math.abs(a.b - b.b).toFixed(2), dh: +Math.abs(a.h - b.h).toFixed(2) }
    })
    console.log(`   liveFinal=${JSON.stringify(liveFinal)}`)
    console.log(`   Δ(liveFinal vs settled)=${JSON.stringify(dFinal)}  Δ(拖动中 vs settled)=${JSON.stringify(deltas)}`)
    console.log(`   ↑ 旧行: Δ=${JSON.stringify(deltas)}`)
    return g
  }
  for (const T of targets.slice(0, 6)) await run(`S1/S2 ${T.kind}-${T.pos}`, T)
  fs.writeFileSync(`tmp/selband119-${TAG}.json`, JSON.stringify(out, null, 1))
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
