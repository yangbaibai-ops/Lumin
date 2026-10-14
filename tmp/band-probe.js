'use strict'
/**
 * 第一百零八轮：空白带（整行全高覆盖层里、源码盒子之外的部分）点击行为
 * 用法：node tmp/band-probe.js <port> <tag> [innerWidth]
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'red'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-band-fixture.md'
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
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 30000); pending.set(i, (m) => { clearTimeout(t); res(m) }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const shotFile = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  const click = async (x, y, settle = 420) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(settle)
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
  await send('Emulation.clearDeviceMetricsOverride').catch(() => null)
  await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(800)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  // 打开第 2 张图（用户那一行：img1 与源码片段 A 同行）
  const pt = await json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][1]; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  await click(pt.x, pt.y)
  const state = () => json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const s = window.__vt.ed().state.selection
    const d = document.getSelection()
    return { revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, sel: { from: s.from, to: s.to, empty: s.empty }, domText: d ? (d.toString()||'').slice(0,20) : null, editing: el ? el.classList.contains('img-src-revealed--editing') : null, cls: el ? el.className : null, overlays: document.querySelectorAll('.img-src-overlay > div').length }
  })()`)
  const bands = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const R = (x) => (x && typeof x.left === 'number' ? { l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) } : null)
    const rectsOf = (list) => { try { return Array.from(list).map(R).filter(Boolean) } catch (e) { return [] } }
    const frags = el ? rectsOf(el.getClientRects()) : []
    const ov = rectsOf(document.querySelectorAll('.img-src-overlay > div') ? [...document.querySelectorAll('.img-src-overlay > div')].map((d) => d.getBoundingClientRect()) : [])
    const tn = el ? document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode() : null
    let textRects = []
    try { if (tn && tn.length) { const rg = document.createRange(); rg.selectNodeContents(tn); textRects = rectsOf(rg.getClientRects()) } } catch (e) { textRects = [] }
    return { frags, ov, textRects, from: el ? Number(el.getAttribute('data-img-from')) : null }
  })()`)
  const out = { tag: TAG, v: await ev(`innerWidth`), bands, before: await state(), steps: [] }
  const band = bands.ov[0]
  const frag = bands.frags[0]
  const textRect = bands.textRects[0]
  if (band && frag && textRect) {
    const midX = Math.round((frag.l + frag.r) / 2)
    const leftX = Math.round(frag.l + 1)
    const rightX = Math.round(frag.r - 1)
    const bandY = Math.round(frag.b + 40)
    const glyphY = Math.round((textRect.t + textRect.b) / 2)
    const pts = [
      { kind: 'band-mid', x: midX, y: bandY },
      { kind: 'band-left', x: leftX, y: bandY },
      { kind: 'band-right', x: rightX, y: bandY },
      { kind: 'band-low', x: midX, y: Math.round(band.b - 8) },
      { kind: 'band-over-img', x: Math.round((band.l + band.r) / 2) - 300, y: bandY },
      { kind: 'below-row', x: midX, y: Math.round(band.b + 20) },
      { kind: 'band-mid-2', x: midX, y: bandY },
      { kind: 'band-mid-3', x: midX, y: bandY },
      { kind: 'glyph-mid', x: midX, y: glyphY }
    ]
    for (const p of pts) {
      const pre = await state()
      await click(p.x, p.y)
      const post = await state()
      out.steps.push({ ...p, preRevealed: pre.revealed, postRevealed: post.revealed, postSel: post.sel, postEditing: post.editing, postOverlays: post.overlays })
      if (post.revealed === 0) { // 收起后重新打开，保证后续步骤可测
        await click(pt.x, pt.y)
      }
    }
    const clip = { x: Math.max(0, Math.floor(frag.l) - 40), y: Math.max(0, Math.floor(band.t) - 30), width: Math.min(1200, Math.ceil(frag.w) + 80), height: Math.ceil(band.h) + 60 }
    await shotFile(clip, `tmp/band-${TAG}.png`)
    out.clip = clip
  }
  fs.writeFileSync(`tmp/band-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL ' + (e.stack || e.message)); process.exit(1) })
