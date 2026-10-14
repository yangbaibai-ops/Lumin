'use strict'
/**
 * 复现用户实测：宽窗口（正文列吃满 max-w-1320 ⇒ 内容宽 1208）时，
 * 源码片段与高图**同行**、片段在行顶 ⇒ 底色却没铺满整行。
 * 打印：逐片段矩形 / 该行参与者并集明细 / 同行图片矩形 / 覆盖层实际矩形。
 * 用法：node tmp/row-repro.js <port> <tag> [width]
 */
const fs = require('fs')
const { decodePNG, diffRows, colorRows } = require('./png')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'repro'
const W = Number(process.argv[4] || 1920)
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-rowfix-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')
const EDGE = [228, 230, 234]

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
  const shotFile = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
    return decodePNG(Buffer.from(r.result.data, 'base64'))
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
  await sleep(1500)
  await dismiss()
  await send('Emulation.clearDeviceMetricsOverride').catch(() => null)
  // 用户真实窗口：%APPDATA%\Lumin 的 windowState = 1440x955 ⇒ innerWidth ≈ 1424
  await ev(`(() => { window.resizeTo(1440, 955); return 'ok' })()`)
  await sleep(900)
  log('innerWidth=' + (await ev(`innerWidth`)))
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  for (let i = 0; i < 40; i++) {
    if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break
    await sleep(400)
  }
  const out = { width: W, innerWidth: await ev(`innerWidth`), doc: await ev(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); return { w: p.getBoundingClientRect().width } })()`).then((x) => x) }
  // 隐藏态截图（对照）
  const elsewhere = await json(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = p.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: elsewhere.x, y: elsewhere.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: elsewhere.x, y: elsewhere.y, button: 'left', clickCount: 1 })
  await sleep(400)

  // 逐帧采集（点击图片：按下 0 / 松开 1 + 覆盖层序列）
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  await ev(`window.__fr = (async () => { const o = []; const t0 = performance.now(); return await new Promise((res) => { const step = () => { const pm = document.querySelector('.ProseMirror'); o.push({ t: Math.round(performance.now()-t0), open: pm.getAttribute('data-img-open'), n: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, ov: document.querySelectorAll('.img-src-overlay > div').length }); if (performance.now()-t0 > 900) res(o); else requestAnimationFrame(step) }; requestAnimationFrame(step) }) })(); 'started'`, false)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(160)
  out.press = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(450)
  out.release = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)

  // 逐片段 + 并集明细（并集口径 = HEAD a8e1980 的实现：行内参与者竖直并集）
  out.geom = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const SRC = document.querySelectorAll('.ProseMirror [data-img-revealed]')
    const out = []
    for (const el of SRC) {
      const p = el.closest('p, li, pre, div')
      const block = p
      const strut = parseFloat(getComputedStyle(el).lineHeight)
      // ── HEAD 实现的采集口径（复制自 imageToolbar.ts 的 inlineRowRects）──
      const parts = []
      const walk = (parent) => {
        for (const child of Array.from(parent.childNodes)) {
          if (child === el) continue
          if (child.nodeType === 3) {
            const tn = child
            if (!tn.length) continue
            const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, tn.length)
            for (const r of Array.from(rg.getClientRects())) if (r.height > 0) parts.push({ src: 'text', tag: '#text', cls: '', ...R(r) })
            continue
          }
          if (child.nodeType !== 1) continue
          const e = child
          const cs = getComputedStyle(e)
          if (cs.display === 'none' || cs.visibility === 'hidden') continue
          const replaced = e.tagName === 'IMG' || e.tagName === 'SVG'
          if (replaced || cs.display.startsWith('inline')) {
            for (const r of Array.from(e.getClientRects())) if (r.height > 0) parts.push({ src: replaced ? 'replaced' : 'inline', tag: e.tagName, cls: String(e.className).slice(0, 30), ...R(r) })
          }
          if (!replaced && !cs.display.startsWith('inline')) walk(e)
        }
      }
      walk(block)
      const frags = []
      for (const f of Array.from(el.getClientRects())) {
        if (!f.height && !f.width) continue
        const ov = parts.filter((q) => !(q.b <= f.top + 0.5 || q.t >= f.bottom - 0.5))
        let top = Infinity, bottom = -Infinity
        for (const q of ov) { top = Math.min(top, q.t); bottom = Math.max(bottom, q.b) }
        const union = Number.isFinite(top) ? { t: +top.toFixed(2), b: +bottom.toFixed(2), h: +(bottom - top).toFixed(2) } : null
        frags.push({ frag: R(f), strut, participants: ov, union, unionGtStrut: union ? union.h > strut + 0.5 : false, unionGtFrag: union ? union.h > f.height + 0.5 : false })
      }
      out.push({
        cls: el.className, from: Number(el.getAttribute('data-img-from')), textLen: (el.textContent || '').length,
        block: R(block.getBoundingClientRect()), frags,
        imgs: [...block.querySelectorAll('img')].map((im) => ({ nw: im.naturalWidth, cls: String(im.parentElement.className).slice(0, 30), ...R(im.getBoundingClientRect()) })),
        widgetSpans: [...block.querySelectorAll('[data-img-widget]')].map((w) => ({ cls: String(w.className).slice(0, 40), display: getComputedStyle(w).display, ...R(w.getBoundingClientRect()) })),
        overlayRects: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())),
        overlayCount: document.querySelectorAll('.img-src-overlay > div').length
      })
    }
    return out
  })()`)
  out.frames = JSON.parse(await ev(`window.__fr.then((f) => JSON.stringify(f))`))

  // 像素：底色实画带（逐片段）与原生选区实画带（逐片段）
  const clip = await json(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const r = p.getBoundingClientRect(); const l = Math.max(0, Math.floor(r.left) - 6); return { x: l, y: Math.max(0, Math.floor(r.top) - 20), width: Math.min(1200, Math.ceil(r.width) + 20), height: Math.ceil(r.height) + 60 } })()`)
  out.clip = clip
  const shotRevealed = await shotFile(clip, `tmp/${TAG}-${W}-nosel.png`)
  out.pixels = []
  for (const g of out.geom) {
    for (const rec of g.frags) {
      const f = rec.frag
      const x0 = Math.max(0, Math.round(f.l - clip.x) + 2)
      const x1 = Math.min(clip.width - 1, Math.round(f.r - clip.x) - 2)
      const y0 = Math.max(0, Math.round(f.t - clip.y) - 8)
      const y1 = Math.min(clip.height - 1, Math.round(f.b - clip.y) + 200)
      if (x1 <= x0) continue
      const win = { x0, x1, y0, y1 }
      const bg = colorRows(shotRevealed, EDGE, win, 4, 3)
      const r = { frag: f, win, bgBand: bg && { top: +(bg.top + clip.y).toFixed(2), bottom: +(bg.bottom + clip.y).toFixed(2), height: bg.height } }
      await ev(`(() => { const v = window.__vt.ed().view; const TS = v.state.selection.constructor; v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, ${g.from}, ${g.from + g.textLen}))); return 'ok' })()`)
      await sleep(450)
      const shotSel = await shotFile(clip, `tmp/${TAG}-${W}-sel.png`)
      const sel = diffRows(shotRevealed, shotSel, win, 24, 2)
      r.selBand = sel && { top: +(sel.top + clip.y).toFixed(2), bottom: +(sel.bottom + clip.y).toFixed(2), height: sel.height }
      out.pixels.push(r)
      await ev(`document.getSelection().removeAllRanges()`)
      await sleep(200)
    }
  }
  if (out.geom[0]) await shotFile(clip, `tmp/ident-rowheight-${TAG}.png`)
  fs.writeFileSync(`tmp/row-repro-${W}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
