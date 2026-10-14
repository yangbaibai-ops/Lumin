'use strict'
/**
 * 第一百零八轮验收（只测本轮）：覆盖层"空白带"点击 ⇒ A 不收回 + B 按列落光标
 * 用法：node tmp/verify-band108.js <port> <tag>
 */
const fs = require('fs')
const { decodePNG, diffRows, colorRows } = require('./png')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
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
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 30000)
    pending.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const shot = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    const buf = Buffer.from(r.result.data, 'base64')
    if (file) fs.writeFileSync(file, buf)
    return decodePNG(buf)
  }
  const click = async (x, y, settle = 420) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(settle)
  }
  const drag = async (x0, y0, x1, y1, steps = 10) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x0), y: Math.round(y0), button: 'left', clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x0 + ((x1 - x0) * i) / steps), y: Math.round(y0 + ((y1 - y0) * i) / steps), button: 'left', buttons: 1 })
      await sleep(22)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x1), y: Math.round(y1), button: 'left', clickCount: 1 })
    await sleep(420)
  }
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(650)
    }
  }
  const stateOf = () => json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const s = window.__vt.ed().state.selection
    const d = document.getSelection()
    return {
      revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
      sel: { from: s.from, to: s.to, empty: s.empty },
      domText: d ? (d.toString() || '').slice(0, 24) : null,
      editing: el ? el.classList.contains('img-src-revealed--editing') : null,
      cls: el ? el.className : null,
      bg: el ? getComputedStyle(el).backgroundColor : null,
      overlays: document.querySelectorAll('.img-src-overlay > div').length,
      overlayEl: !!document.querySelector('.img-src-overlay')
    }
  })()`)
  const widgetPoint = (i) => json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][${i}]; if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  const sha = () => ev(`(async () => { const md = window.__vt.ed().storage.markdown.getMarkdown(); const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2,'0')).join('') })()`)

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
  await sleep(900)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }

  const out = { tag: TAG, innerWidth: await ev(`innerWidth`) }
  out.mdBefore = await sha()
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  out.hiddenBefore = await stateOf()

  // 打开第 2 张图（用户那一行：img1 与源码片段 A 同行）
  const pt = await widgetPoint(1)
  await click(pt.x, pt.y)
  const geom = () => json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return null
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const frags = [...el.getClientRects()].filter((x) => x.width > 0 && x.height > 0).map(R)
    const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    let texts = []
    if (tn && tn.length) { const rg = document.createRange(); rg.selectNodeContents(tn); texts = [...rg.getClientRects()].map(R) }
    return { from: Number(el.getAttribute('data-img-from')), len: (el.textContent || '').length, frags, texts, ov: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())) }
  })()`)
  const g0 = await geom()
  out.source = { from: g0.from, to: g0.from + g0.len, frags: g0.frags, texts: g0.texts, overlays: g0.ov }
  const fragOf = (i) => g0.frags[i]
  const textOf = (i) => g0.texts[i]
  const bandYOf = (i) => Math.round((fragOf(i).b + g0.ov[i].b) / 2) // 空白带中部
  const glyphYOf = (i) => Math.round((textOf(i).t + textOf(i).b) / 2)

  // ① 连点 3 次空白带（第 1 行那条带）
  out.A = []
  for (let k = 0; k < 3; k++) {
    const x = Math.round((fragOf(0).l + fragOf(0).r) / 2)
    const y = bandYOf(0)
    const pre = await stateOf()
    await click(x, y)
    const post = await stateOf()
    out.A.push({ k: k + 1, x, y, preRevealed: pre.revealed, postRevealed: post.revealed, pos: post.sel, editing: post.editing, overlays: post.overlays })
  }
  await shot({ x: Math.max(0, Math.floor(fragOf(0).l) - 30), y: Math.max(0, Math.floor(g0.ov[0].t) - 24), width: Math.min(1200, Math.ceil(fragOf(0).w) + 60), height: Math.ceil(g0.ov[0].h) + 48 }, 'tmp/band-caret-click.png')

  // ② 按列落光标：空白带 vs 同行字形（同一 x）
  out.B = []
  const probes = [
    { row: 0, kind: 'mid' },
    { row: 0, kind: 'left' },
    { row: 0, kind: 'right' },
    { row: 1, kind: 'mid' },
    { row: 1, kind: 'left' },
    { row: 1, kind: 'right' }
  ]
  for (const p of probes) {
    const f = fragOf(p.row)
    const x = p.kind === 'mid' ? Math.round((f.l + f.r) / 2) : p.kind === 'left' ? Math.round(f.l + 1) : Math.round(f.r - 1)
    // 先保证显形
    if ((await stateOf()).revealed === 0) await click(pt.x, pt.y)
    await click(x, bandYOf(p.row))
    const band = await stateOf()
    // 对照：同一 x 点同行字形
    if ((await stateOf()).revealed === 0) await click(pt.x, pt.y)
    await click(x, glyphYOf(p.row))
    const glyph = await stateOf()
    out.B.push({
      row: p.row, kind: p.kind, x,
      bandPos: band.sel, bandRevealed: band.revealed,
      glyphPos: glyph.sel, glyphRevealed: glyph.revealed,
      delta: Math.abs(band.sel.from - glyph.sel.from),
      sourceRange: [g0.from, g0.from + g0.len]
    })
  }

  // ③ 不误伤：字形上拖动 ⇒ 非空选区；字形上单击 ⇒ 光标
  if ((await stateOf()).revealed === 0) await click(pt.x, pt.y)
  const gy = glyphYOf(0)
  await drag(fragOf(0).l + 8, gy, fragOf(0).l + 160, gy)
  out.C = { dragOnGlyphs: await stateOf() }
  await ev(`document.getSelection().removeAllRanges()`)
  await sleep(200)
  if ((await stateOf()).revealed === 0) await click(pt.x, pt.y)
  await click(fragOf(0).l + 40, gy)
  out.C.clickOnGlyphs = await stateOf()

  // ④ 点真正的别处 ⇒ 收起
  await click(away.x, away.y)
  out.D = await stateOf()

  // ⑤ 不破坏
  //  逐帧（显形这一手势）
  if ((await stateOf()).revealed === 0) await click(pt.x, pt.y)
  await click(away.x, away.y)
  await ev(`window.__fr = (async () => { const o = []; const t0 = performance.now(); return await new Promise((res) => { const step = () => { const pm = document.querySelector('.ProseMirror'); o.push({ t: Math.round(performance.now()-t0), open: pm.getAttribute('data-img-open'), n: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, ov: document.querySelectorAll('.img-src-overlay > div').length }); if (performance.now()-t0 > 900) res(o); else requestAnimationFrame(step) }; requestAnimationFrame(step) }) })(); 'started'`, false)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(160)
  out.E = { press: await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`) }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(430)
  out.E.release = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  out.E.bg = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? getComputedStyle(el).backgroundColor : null })()`)
  const frames = JSON.parse(await ev(`window.__fr.then((f) => JSON.stringify(f))`))
  out.E.frames = frames.map((f) => f.n + '/' + f.ov).filter((v, i, a) => i === 0 || v !== a[i - 1])
  //  空白带中部的命中测试（不得是覆盖层）+ 布局 A/B
  const g1 = await geom()
  out.E.hit = await json(`(() => {
    const j = (el) => ({ tag: el ? el.tagName : null, cls: el ? String(el.className).slice(0, 36) : null, overlay: !!(el && el.closest && el.closest('.img-src-overlay')) })
    const x = ${Math.round((fragOf(0).l + fragOf(0).r) / 2)}
    const y = ${bandYOf(0)}
    return { mid: j(document.elementFromPoint(x, y)), y, x }
  })()`)
  out.E.layoutOn = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return { para: R(p.getBoundingClientRect()), imgs: [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect())), h2: R(document.querySelector('.ProseMirror h2').getBoundingClientRect()), scrollH: document.querySelector('.editor-scroll').scrollHeight, overlays: document.querySelectorAll('.img-src-overlay > div').length }
  })()`)
  await ev(`(() => { const s = document.createElement('style'); s.id='xw-off'; s.textContent='.img-src-overlay{display:none !important}'; document.head.appendChild(s); return 'ok' })()`)
  await sleep(300)
  out.E.layoutOff = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return { para: R(p.getBoundingClientRect()), imgs: [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect())), h2: R(document.querySelector('.ProseMirror h2').getBoundingClientRect()), scrollH: document.querySelector('.editor-scroll').scrollHeight }
  })()`)
  await ev(`document.getElementById('xw-off')?.remove()`)
  await sleep(250)
  out.E.layoutSame = ['para', 'imgs', 'h2', 'scrollH'].every((k) => JSON.stringify(out.E.layoutOn[k]) === JSON.stringify(out.E.layoutOff[k]))
  //  编辑态（点进源码文本）⇒ 透明 + 覆盖层摘除
  if ((await stateOf()).revealed === 0) await click(pt.x, pt.y)
  for (let k = 0; k < 2; k++) {
    const tn = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return null; const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); if (!tn || !tn.length) return null; const a = Math.min(20, Math.max(0, tn.length - 3)); const rg = document.createRange(); rg.setStart(tn, a); rg.setEnd(tn, Math.min(a + 3, tn.length)); const r = rg.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
    if (!tn) break
    await click(tn.x, tn.y, 600)
    if ((await stateOf()).editing) break
  }
  out.E.editing = await stateOf()
  //  非激活隐藏 + 往返
  await click(away.x, away.y)
  out.E.hidden = await stateOf()
  out.mdAfter = await sha()
  out.E.mdRoundtripSame = out.mdBefore === out.mdAfter
  out.E.modalAtEnd = await ev(`document.querySelectorAll('.lm-prompt__card').length`)
  fs.writeFileSync(`tmp/band108-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL ' + (e && e.stack ? e.stack : e.message)); process.exit(1) })
