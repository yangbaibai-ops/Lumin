'use strict'
/**
 * 第一百零七轮验收（只测本轮）：宽窗口（用户窗口 1440x955 ⇒ 源码与高图**同行**）下，
 * 逐片段把"源码底色实画 vs 该行行盒 vs 同行图片 vs 原生选区实画"四者并列，
 * 并给"关掉覆盖层（=上一轮/只有 CSS 的红）"的对照值。
 * 用法：node tmp/verify-row107.js <port> <tag> [innerWidth]
 */
const fs = require('fs')
const { decodePNG, diffRows, colorRows, colorRunRows, countColor } = require('./png')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const IW = Number(process.argv[4] || 1424)
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-rowfix-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')
const EDGE = [228, 230, 234]
const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'
const BLOCK_MD = `<img src="${PNG_B}" style="zoom:100%;" />\n`

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params) =>
    new Promise((res, rej) => {
      const i = ++id
      const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 30000)
      pending.set(i, (m) => { clearTimeout(t); res(m) })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails)
      throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const shot = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    const buf = Buffer.from(r.result.data, 'base64')
    if (file) fs.writeFileSync(file, buf)
    return decodePNG(buf)
  }
  const click = async (x, y, settle = 480) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(settle)
  }
  const drag = async (x0, y0, x1, y1, steps = 10) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x0), y: Math.round(y0), button: 'left', clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x0 + ((x1 - x0) * i) / steps), y: Math.round(y0 + ((y1 - y0) * i) / steps), button: 'left', buttons: 1 })
      await sleep(20)
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
  /** 打开文件：**不 await** openPath（"有未保存的更改"提示会把它挂住），边等边关提示 */
  const openFile = async (p) => {
    await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(p)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
    for (let i = 0; i < 24; i++) {
      await sleep(400)
      const done = await ev(`window.__openDone === undefined ? null : window.__openDone`)
      await dismiss()
      const len = await ev(`(window.__vt.files().content || '').length`)
      if (len) return true
      if (done) break
    }
    return (await ev(`(window.__vt.files().content || '').length`)) > 0
  }
  const widgetPoint = (i) => json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][${i}]; if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  const revealedCount = () => ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  const ensureRevealed = async (i, tries = 3) => {
    for (let k = 0; k < tries; k++) {
      if (await revealedCount()) return true
      const pt = await widgetPoint(i)
      if (pt) await click(pt.x, pt.y)
    }
    return (await revealedCount()) > 0
  }
  const sha = () => ev(`(async () => { const md = window.__vt.ed().storage.markdown.getMarkdown(); const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2,'0')).join('') })()`)
  const geomExpr = `(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const el = p ? p.querySelector('[data-img-revealed]') : null
    const REPLACED = new Set(['IMG','SVG','CANVAS','VIDEO','IFRAME','OBJECT','EMBED'])
    // 参考"行盒"：全部行盒参与者（含行内 span 内部的 widget；跳过 .katex 与定位盒子）分组
    const parts = []
    const walk = (parent) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child === el) continue
        if (child.nodeType === 3) {
          const tn = child
          if (!tn.length) continue
          const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, tn.length)
          for (const r of Array.from(rg.getClientRects())) if (r.height > 0) parts.push({ who: '#text', ...R(r) })
          continue
        }
        if (child.nodeType !== 1) continue
        const e = child
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        if (e.classList.contains('katex')) continue
        const rep = REPLACED.has(e.tagName)
        if ((rep || cs.display.startsWith('inline')) && cs.position === 'static')
          for (const r of Array.from(e.getClientRects())) if (r.height > 0) parts.push({ who: e.tagName + '.' + String(e.className).slice(0,20), ...R(r) })
        walk(e)
      }
    }
    if (p) walk(p)
    const rows = []
    for (const r of parts.slice().sort((a,b) => a.t - b.t)) {
      const hit = rows.find((g) => r.t < g.b - 0.5 && r.b > g.t + 0.5)
      if (hit) { hit.t = Math.min(hit.t, r.t); hit.b = Math.max(hit.b, r.b); hit.rows.push(r.who) }
      else rows.push({ t: r.t, b: r.b, rows: [r.who] })
    }
    const frags = el ? [...el.getClientRects()].filter((x) => x.width > 0 && x.height > 0).map((f) => {
      const mid = (f.top + f.bottom) / 2
      const row = rows.find((g) => mid >= g.t - 0.5 && mid <= g.b + 0.5)
      return { frag: R(f), row: row ? { t: +row.t.toFixed(2), b: +row.b.toFixed(2), h: +(row.b - row.t).toFixed(2) } : null, rowMembers: row ? row.rows.slice(0, 8) : [] }
    }) : []
    return {
      innerWidth: innerWidth,
      block: p ? R(p.getBoundingClientRect()) : null,
      from: el ? Number(el.getAttribute('data-img-from')) : null,
      len: el ? (el.textContent || '').length : 0,
      frags,
      imgs: p ? [...p.querySelectorAll('img')].map((im) => ({ nw: im.naturalWidth, ...R(im.getBoundingClientRect()) })) : [],
      widgets: p ? [...p.querySelectorAll('[data-img-widget]')].map((w) => ({ ...R(w.getBoundingClientRect()) })) : [],
      overlays: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())),
      overlayEl: !!document.querySelector('.img-src-overlay')
    }
  })()`

  // ── 桥 / 打开
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
  await openFile(COPY)
  await sleep(1200)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) {
    if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break
    await sleep(400)
  }
  const out = { tag: TAG, innerWidth: await ev(`innerWidth`), fixtureSha: '133C85F71D40D0E0F8CACDD82EB5CEB49986B5BE9F98A3CF23111128AB'.slice(0, 64) }
  out.mdBefore = await sha()
  out.fixture = { copy: COPY, mdLen: await ev(`window.__vt.ed().storage.markdown.getMarkdown().length`) }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  out.hiddenBefore = await json(`(() => ({ revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, overlayEl: !!document.querySelector('.img-src-overlay') }))()`)
  // ⑤ 未激活布局（与改动前后逐项对比用）
  out.layoutHidden = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return { para: R(p.getBoundingClientRect()), imgs: [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect())), h2: R(document.querySelector('.ProseMirror h2').getBoundingClientRect()), scrollH: document.querySelector('.editor-scroll').scrollHeight }
  })()`)

  // ── ①② 逐张图：逐个片段给"底色实画 / 行盒 / 同行图片 / 原生选区实画" + 关层对照（红）
  out.bysource = []
  for (let i = 0; i < 2; i++) {
    await click(away.x, away.y)
    const pt = await widgetPoint(i)
    if (!pt) continue
    // ⑥ 按下 0 / 松开 1 + 逐帧
    await ev(`window.__fr = (async () => { const o = []; const t0 = performance.now(); return await new Promise((res) => { const step = () => { const pm = document.querySelector('.ProseMirror'); o.push({ t: Math.round(performance.now()-t0), open: pm.getAttribute('data-img-open'), n: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, ov: document.querySelectorAll('.img-src-overlay > div').length }); if (performance.now()-t0 > 900) res(o); else requestAnimationFrame(step) }; requestAnimationFrame(step) }) })(); 'started'`, false)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(160)
    const press = await revealedCount()
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(430)
    const release = await revealedCount()
    const bg = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? getComputedStyle(el).backgroundColor : null })()`)
    const frames = JSON.parse(await ev(`window.__fr.then((f) => JSON.stringify(f))`))
    const g = await json(geomExpr)
    const rec = { widget: i, press, release, bg, frames: frames.map((f) => f.n + '/' + f.ov).filter((v, k, a) => k === 0 || v !== a[k - 1]), innerWidth: g.innerWidth, from: g.from, len: g.len, block: g.block, frags: g.frags, overlays: g.overlays, widgets: g.widgets, imgs: g.imgs, pix: [] }
    if (!g.frags.length) { out.bysource.push(rec); continue }
    const clip = await json(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const r = p.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left) - 24), y: Math.max(0, Math.floor(r.top) - 24), width: Math.min(1200, Math.ceil(r.width) + 48), height: Math.ceil(r.height) + 48 } })()`)
    rec.clip = clip
    const shotOn = await shot(clip, `tmp/${TAG}-w${i}-on.png`)
    // 关掉覆盖层（=只有 CSS 的上一轮实画 ⇒ 红）
    await ev(`(() => { const s = document.createElement('style'); s.id = 'xw-off'; s.textContent = '.img-src-overlay{display:none !important}'; document.head.appendChild(s); return 'ok' })()`)
    await sleep(300)
    const shotOff = await shot(clip, `tmp/${TAG}-w${i}-off.png`)
    await ev(`document.getElementById('xw-off')?.remove()`)
    await sleep(250)
    for (const fr of g.frags) {
      const blocked = g.widgets.map((w) => [w.l, w.r]).concat(g.imgs.filter((x) => x.w > 2).map((x) => [x.l, x.r]))
      let cuts = [[fr.frag.l, fr.frag.r]]
      for (const [bl, br] of blocked) {
        const next = []
        for (const [a, b] of cuts) {
          if (br <= a || bl >= b) { next.push([a, b]); continue }
          if (bl > a) next.push([a, bl])
          if (br < b) next.push([br, b])
        }
        cuts = next
      }
      cuts.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))
      const seg = cuts[0]
      if (!seg || seg[1] - seg[0] < 8) { rec.pix.push({ frag: fr.frag, skipped: 'no free x segment' }); continue }
      const win = {
        x0: Math.max(0, Math.round(seg[0] - clip.x) + 1),
        x1: Math.min(clip.width - 1, Math.round(seg[1] - clip.x) - 1),
        y0: Math.max(0, Math.round((fr.row ? fr.row.t : fr.frag.t) - clip.y) - 4),
        y1: Math.min(clip.height - 1, Math.round((fr.row ? fr.row.b : fr.frag.b) - clip.y) + 4)
      }
      // ① / ②：覆盖层**自己的实画**（开/关两图之差）落在这一片段上的行区间
      const en = diffRows(shotOn, shotOff, win, 24, 2)
      // 红（对照 = 只有 CSS 的实画）：同一窗口里 --edge 的行区间（每行 ≥3px）
      const off = colorRows(shotOff, EDGE, win, 4, 3)
      // ③ 普通行口径：只看**片段自己**的 y 范围
      const fwin = { x0: win.x0, x1: win.x1, y0: Math.max(0, Math.round(fr.frag.t - clip.y) - 4), y1: Math.min(clip.height - 1, Math.round(fr.frag.b - clip.y) + 4) }
      const foff = colorRows(shotOff, EDGE, fwin, 4, 3)
      const fon = colorRows(shotOn, EDGE, fwin, 4, 3)
      const ovHit = g.overlays.filter((o) => o.t < fr.frag.b + 2 && o.b > fr.frag.t - 2 && Math.abs(o.l - fr.frag.l) < 2)
      rec.pix.push({
        frag: fr.frag, row: fr.row, win,
        bgOn: en && { top: +(en.top + clip.y).toFixed(2), bottom: +(en.bottom + clip.y).toFixed(2), height: en.height },
        bgOff: off && { top: +(off.top + clip.y).toFixed(2), bottom: +(off.bottom + clip.y).toFixed(2), height: off.height },
        fragBandOn: fon && { top: +(fon.top + clip.y).toFixed(2), bottom: +(fon.bottom + clip.y).toFixed(2), height: fon.height },
        fragBandOff: foff && { top: +(foff.top + clip.y).toFixed(2), bottom: +(foff.bottom + clip.y).toFixed(2), height: foff.height },
        overlay: ovHit.length ? ovHit[0] : null
      })
      // 原生选区实画（选该源码）
      await ev(`(() => { const v = window.__vt.ed().view; const TS = v.state.selection.constructor; v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, ${g.from}, ${g.from + g.len}))); return 'ok' })()`)
      await sleep(450)
      const shotSel = await shot(clip, null)
      const sel = diffRows(shotOn, shotSel, win, 24, 2)
      rec.pix[rec.pix.length - 1].selBand = sel && { top: +(sel.top + clip.y).toFixed(2), bottom: +(sel.bottom + clip.y).toFixed(2), height: sel.height }
      rec.pix[rec.pix.length - 1].selApi = await json(`(() => { const s = document.getSelection(); if (!s.rangeCount || !s.toString()) return null; return [...s.getRangeAt(0).getClientRects()].map((x) => +x.height.toFixed(2)) })()`)
      await ev(`document.getSelection().removeAllRanges()`)
      await sleep(200)
      if (i === 1) await shot(clip, 'tmp/ident-rowheight-fix.png')
    }
    out.bysource.push(rec)
    fs.writeFileSync(`tmp/row107-${TAG}.json`, JSON.stringify(out, null, 1))
  }

  // ── ⑥ 不破坏（在 widget#1 状态上做）
  await ensureRevealed(1)
  const g1 = await json(geomExpr)
  const f1 = g1.frags[0]
  if (f1) {
    const band = out.bysource[1] && out.bysource[1].pix[0] && out.bysource[1].pix[0].bgOn
    const hx = Math.round((f1.frag.l + f1.frag.r) / 2)
    const hy = band ? Math.round((band.top + band.bottom) / 2) : Math.round((f1.frag.t + f1.frag.b) / 2)
    const lowY = band ? Math.round(band.bottom - 6) : Math.round(f1.frag.b + 30)
    out.mouse = await json(`(() => {
      const j = (el) => ({ tag: el ? el.tagName : null, cls: el ? String(el.className).slice(0, 40) : null, overlay: !!(el && el.closest && el.closest('.img-src-overlay')) })
      return { mid: j(document.elementFromPoint(${hx}, ${hy})), low: j(document.elementFromPoint(${Math.round(f1.frag.l + 10)}, ${lowY})), lowY: ${lowY} }
    })()`)
    const gy = Math.round((f1.frag.t + f1.frag.b) / 2)
    await drag(f1.frag.l + 6, gy, f1.frag.r - 6, gy)
    out.mouse.dragOnGlyphs = await json(`(() => { const s = window.__vt.ed().state.selection; const d = document.getSelection(); return { from: s.from, to: s.to, empty: s.empty, domText: d ? (d.toString() || '').slice(0, 24) : null } })()`)
    await ev(`document.getSelection().removeAllRanges()`)
    await sleep(200)
    // 同一手势在"关掉覆盖层"下再走一遍 ⇒ 说明上面那个结果与覆盖层无关（既有的 PM 行为）
    await ev(`(() => { const s = document.createElement('style'); s.id='xw-off3'; s.textContent='.img-src-overlay{display:none !important}'; document.head.appendChild(s); return 'ok' })()`)
    await sleep(300)
    await drag(f1.frag.l + 6, gy, f1.frag.r - 6, gy)
    out.mouse.dragOnGlyphsOverlayOff = await json(`(() => { const s = window.__vt.ed().state.selection; const d = document.getSelection(); return { from: s.from, to: s.to, empty: s.empty, domText: d ? (d.toString() || '').slice(0, 24) : null } })()`)
    await ev(`document.getElementById('xw-off3')?.remove()`)
    await ev(`document.getSelection().removeAllRanges()`)
    await sleep(200)
  }
  // 编辑态去底 + 覆盖层摘除（点进源码文本；必要时换点重试）
  const textPoint = () => json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return null
    const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    if (!tn || !tn.length) return null
    const a = Math.min(20, Math.max(0, tn.length - 3))
    const rg = document.createRange(); rg.setStart(tn, a); rg.setEnd(tn, Math.min(a + 3, tn.length))
    const r = rg.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: { l: +r.left.toFixed(2), t: +r.top.toFixed(2), b: +r.bottom.toFixed(2) } }
  })()`)
  out.editingDiag = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const tp = await textPoint()
    if (!tp) break
    await click(tp.x, tp.y, 700)
    const st = await json(`(() => {
      const v = window.__vt.ed().view
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const s = v.state.selection
      const at = v.posAtCoords({ left: ${tp.x}, top: ${tp.y} })
      const d = document.elementFromPoint(${tp.x}, ${tp.y})
      return { point: ${JSON.stringify(tp)}, at: at ? at.pos : null, sel: { from: s.from, to: s.to, empty: s.empty }, editingAttr: el ? el.getAttribute('data-img-editing') : null, cls: el ? el.className : null, bg: el ? getComputedStyle(el).backgroundColor : null, overlays: document.querySelectorAll('.img-src-overlay > div').length, overlayEl: !!document.querySelector('.img-src-overlay'), hit: d ? String(d.className).slice(0, 30) : null }
    })()`)
    out.editingDiag.push(st)
    if (st.editingAttr === 'true') break
  }
  out.editing = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return { found: false }; const cs = getComputedStyle(el); return { found: true, cls: el.className, editing: el.classList.contains('img-src-revealed--editing'), bg: cs.backgroundColor, overlays: document.querySelectorAll('.img-src-overlay > div').length, overlayEl: !!document.querySelector('.img-src-overlay') } })()`)
  await click(away.x, away.y)
  out.hiddenAfter = await json(`(() => ({ revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, overlayEl: !!document.querySelector('.img-src-overlay'), overlays: document.querySelectorAll('.img-src-overlay > div').length, selected: document.querySelectorAll('.ProseMirror .img-selected').length }))()`)
  out.mdAfter = await sha()
  out.mdRoundtripSame = out.mdBefore === out.mdAfter

  // ── ⑤ 覆盖层 A/B：布局不受影响
  await ensureRevealed(1)
  const measureAB = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return { para: R(p.getBoundingClientRect()), imgs: [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect())), h2: R(document.querySelector('.ProseMirror h2').getBoundingClientRect()), scrollH: document.querySelector('.editor-scroll').scrollHeight, docH: +document.querySelector('.ProseMirror').getBoundingClientRect().height.toFixed(2), overlays: document.querySelectorAll('.img-src-overlay > div').length }
  })()`)
  out.ab = { on: await measureAB() }
  await ev(`(() => { const s = document.createElement('style'); s.id='xw-off2'; s.textContent='.img-src-overlay{display:none !important}'; document.head.appendChild(s); return 'ok' })()`)
  await sleep(300)
  out.ab.off = await measureAB()
  await ev(`document.getElementById('xw-off2')?.remove()`)
  await sleep(250)
  out.ab.same = ['para', 'imgs', 'h2', 'scrollH', 'docH'].every((k) => JSON.stringify(out.ab.on[k]) === JSON.stringify(out.ab.off[k]))

  // ── ③④ 块级档
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(BLOCK_MD)}); return 'ok' })()`)
  await sleep(900)
  const bpt = await widgetPoint(0)
  if (bpt) {
    await click(bpt.x, bpt.y)
    out.block = await json(`(() => {
      const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!el) return { found: false }
      const cs = getComputedStyle(el)
      const p = el.closest('p, div')
      const csP = getComputedStyle(p)
      const pRect = p.getBoundingClientRect()
      const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
      const fc = (() => { if (!tn || !tn.length) return null; const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, 1); const rs = [...rg.getClientRects()]; return rs.length ? R(rs[0]) : null })()
      return { found: true, cls: el.className, lh: cs.lineHeight, elRects: [...el.getClientRects()].map(R), firstCharRangeRect: fc, contentColLeft: +(pRect.left + parseFloat(csP.paddingLeft)).toFixed(2), overlayEl: !!document.querySelector('.img-src-overlay'), overlayCount: document.querySelectorAll('.img-src-overlay > div').length }
    })()`)
    const bclip = { x: 300, y: 40, width: 1000, height: 300 }
    const shotB = await shot(bclip, `tmp/${TAG}-block.png`)
    const el0 = out.block.elRects && out.block.elRects[0]
    if (el0) {
      const win = { x0: Math.max(0, Math.round(el0.l - bclip.x) + 2), x1: Math.min(bclip.width - 1, Math.round(el0.r - bclip.x) - 2), y0: Math.max(0, Math.round(el0.t - bclip.y) - 8), y1: Math.min(bclip.height - 1, Math.round(el0.b - bclip.y) + 8) }
      const c = colorRows(shotB, EDGE, win, 4, Math.round((win.x1 - win.x0) * 0.6))
      out.block.pxBg = c && { top: +(c.top + bclip.y).toFixed(2), bottom: +(c.bottom + bclip.y).toFixed(2), height: c.height }
      out.block.win = win
      out.block.expected = +(3 * parseFloat(out.block.lh)).toFixed(2)
    }
    const pos = await json(`(() => { const v = window.__vt.ed().view; const el = document.querySelector('.ProseMirror [data-img-revealed]'); const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); if (!tn) return null; const from = v.posAtDOM(tn, 0); return { from, to: Math.min(from + 5, v.state.doc.content.size - 1) } })()`)
    if (pos) {
      await ev(`(() => { const v = window.__vt.ed().view; const TS = v.state.selection.constructor; v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, ${pos.from}, ${pos.to}))); return 'ok' })()`)
      await sleep(400)
      out.block.selApi = await json(`(() => { const s = document.getSelection(); if (!s.rangeCount || !s.toString()) return null; return [...s.getRangeAt(0).getClientRects()].map((x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), h: +x.height.toFixed(2) })) })()`)
      await ev(`document.getSelection().removeAllRanges()`)
    }
  }
  out.modalAtEnd = await ev(`document.querySelectorAll('.lm-prompt__card').length`)
  fs.writeFileSync(`tmp/row107-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e && e.stack ? e.stack : e.message)); process.exit(1) })
