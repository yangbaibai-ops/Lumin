'use strict'
/**
 * 第一百零六轮验收（只测本轮）：A 背景铺满整行（含被图片撑高的行）+ B 图片"像浏览器那样被选中"
 * 用法：node tmp/verify-overlay106.js <port> <tag>
 * 产出：tmp/ov106-<tag>.json、tmp/ident-overlay-fullheight.png、tmp/img-selected-browser-like.png
 */
const fs = require('fs')
const { decodePNG, diffRows, colorRows, countColor } = require('./png')

const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-overlay-fixture.md'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin相关\\数学公式示例.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const EDGE = [228, 230, 234]
const SEL = [17, 24, 39]
const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'
const BLOCK_MD = `<img src="${PNG_B}" style="zoom:100%;" />\n`
const CLIP = { x: 300, y: 330, width: 1000, height: 340 }
const CLIP_BLOCK = { x: 300, y: 40, width: 1000, height: 300 }

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res, rej) => {
      const i = ++id
      const t = setTimeout(() => {
        pending.delete(i)
        rej(new Error('timeout ' + method))
      }, 30000)
      pending.set(i, (m) => {
        clearTimeout(t)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails)
      throw new Error(
        'EXC: ' +
          JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
      )
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))
  const shot = async (clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    return decodePNG(Buffer.from(r.result.data, 'base64'))
  }
  const shotFile = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  const click = async (x, y, settle = 500) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(settle)
  }
  const drag = async (x0, y0, x1, y1, steps = 12) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x0), y: Math.round(y0), button: 'left', clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x0 + ((x1 - x0) * i) / steps),
        y: Math.round(y0 + ((y1 - y0) * i) / steps),
        button: 'left',
        buttons: 1
      })
      await sleep(25)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x1), y: Math.round(y1), button: 'left', clickCount: 1 })
    await sleep(450)
  }
  /** 提示层：草稿（丢弃/恢复）+ 离开确认（确认）+ 通用（放弃）—— 一律"不保存、继续" */
  const dismissPrompts = async () => {
    for (let i = 0; i < 10; i++) {
      const hit = await ev(`(() => {
        const btns = [...document.querySelectorAll('button')]
        const pick = (re) => btns.find((b) => re.test((b.textContent || '').trim()))
        const b = pick(/^丢弃$/) || pick(/^放弃$/) || pick(/^确认$/) || pick(/^Discard$/i) || pick(/^Confirm$/i)
        if (!b) return 0
        b.click()
        return 1
      })()`)
      if (!hit) break
      await sleep(650)
    }
    const left = await json(`(() => ({ prompts: document.querySelectorAll('.lm-prompt__card').length, buttons: [...document.querySelectorAll('.lm-prompt__card button')].map((b) => b.textContent) }))()`)
    return left
  }
  const widgetPoint = () =>
    json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  const revealedCount = () => ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  const ensureRevealed = async (tries = 3) => {
    for (let i = 0; i < tries; i++) {
      if (await revealedCount()) return true
      const pt = await widgetPoint()
      if (pt) await click(pt.x, pt.y)
    }
    return (await revealedCount()) > 0
  }
  const sha = () =>
    ev(`(async () => { const md = window.__vt.ed().storage.markdown.getMarkdown(); const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('') })()`)
  const freeSeg = (l, r, blocked) => {
    let cuts = [[l, r]]
    for (const [bl, br] of blocked) {
      const next = []
      for (const [a, b] of cuts) {
        if (br <= a || bl >= b) {
          next.push([a, b])
          continue
        }
        if (bl > a) next.push([a, bl])
        if (br < b) next.push([br, b])
      }
      cuts = next
    }
    cuts.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))
    return cuts[0] || null
  }
  const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })

  const out = { tag: TAG, clip: CLIP }
  const dump = () => fs.writeFileSync(`tmp/ov106-${TAG}.json`, JSON.stringify(out, null, 1))

  // ── 桥
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await dismissPrompts()
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(COPY)}); return 'ok' })()`)
  await sleep(1500)
  await send('Page.bringToFront').catch(() => null)
  out.promptsAfterOpen = await dismissPrompts()
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(200)
  for (let i = 0; i < 40; i++) {
    const ok = await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)
    if (ok) break
    await sleep(400)
  }
  out.fixture = {
    copy: COPY,
    imgs: await json(`[...document.querySelectorAll('.ProseMirror img')].map((im) => ({ nw: im.naturalWidth, nh: im.naturalHeight, h: +im.getBoundingClientRect().height.toFixed(2) }))`),
    mdLen: await ev(`window.__vt.ed().storage.markdown.getMarkdown().length`)
  }
  out.mdBefore = await sha()

  // ── 先回到"未激活"（点一段没有图片的正文）
  const elsewhere = await json(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent || '').length > 5); const r = p.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) } })()`)
  await click(elsewhere.x, elsewhere.y)
  out.hiddenBefore = await json(`(() => ({ revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, overlayEl: !!document.querySelector('.img-src-overlay'), overlays: document.querySelectorAll('.img-src-overlay > div').length }))()`)
  // ⑤ 基线（未激活）布局
  const layoutExpr = `(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return {
      para: R(p.getBoundingClientRect()),
      widgets: [...p.querySelectorAll('[data-img-widget] img')].map((im) => R(im.getBoundingClientRect())),
      h2: R([...document.querySelectorAll('.ProseMirror h2')][0].getBoundingClientRect()),
      scrollH: document.querySelector('.editor-scroll').scrollHeight,
      pRectList: [...document.querySelectorAll('.ProseMirror p')].map((x) => R(x.getBoundingClientRect())).slice(0, 6)
    }
  })()`
  out.layoutHidden = await json(layoutExpr)

  // ── ⑥ 按下 0 / 松开 1 + 底色一次 + 逐帧序列（不闪）
  const pt = await widgetPoint()
  await ev(`window.__frames = (async () => { const o = []; const t0 = performance.now(); return await new Promise((res) => { const step = () => { const pm = document.querySelector('.ProseMirror'); o.push({ t: Math.round(performance.now() - t0), open: pm.getAttribute('data-img-open'), n: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, ov: document.querySelectorAll('.img-src-overlay > div').length }); if (performance.now() - t0 > 900) res(o); else requestAnimationFrame(step) }; requestAnimationFrame(step) }) })(); 'started'`, false)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(160)
  out.pressCount = await revealedCount()
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(420)
  out.releaseCount = await revealedCount()
  out.releaseBg = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? getComputedStyle(el).backgroundColor : null })()`)

  // ── ①② 几何 + 像素（尽快，别等提示层把状态打乱）
  const geomExpr = `(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
    const o = []
    for (const el of els) {
      const p = el.closest('p, li, pre, div')
      const csP = getComputedStyle(p)
      const pRect = p.getBoundingClientRect()
      const q = document.createRange(); q.selectNodeContents(p)
      const raw = [...q.getClientRects()].filter((x) => x.width > 0 && x.height > 0).map(R)
      const imgs = [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect()))
      const groups = []
      for (const r of [...q.getClientRects(), ...[...p.querySelectorAll('img')].map((im) => im.getBoundingClientRect())]) {
        if (!(r.width > 0 && r.height > 0)) continue
        const hit = groups.find((g) => r.top < g.b - 0.5 && r.bottom > g.t + 0.5)
        if (hit) { hit.t = Math.min(hit.t, r.top); hit.b = Math.max(hit.b, r.bottom); hit.l = Math.min(hit.l, r.left); hit.r = Math.max(hit.r, r.right) }
        else groups.push({ t: r.top, b: r.bottom, l: r.left, r: r.right })
      }
      o.push({
        cls: el.className, from: Number(el.getAttribute('data-img-from')), textLen: (el.textContent || '').length,
        pRect: R(pRect), contentColLeft: +(pRect.left + parseFloat(csP.paddingLeft)).toFixed(2),
        elRects: [...el.getClientRects()].map(R), rawRangeRects: raw, imgRects: imgs,
        lines: groups.map((g) => ({ l: +g.l.toFixed(2), t: +g.t.toFixed(2), r: +g.r.toFixed(2), b: +g.b.toFixed(2), w: +(g.r - g.l).toFixed(2), h: +(g.b - g.t).toFixed(2) })),
        overlayRects: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())),
        overlayCount: document.querySelectorAll('.img-src-overlay > div').length
      })
    }
    return o
  })()`
  out.geom = await json(geomExpr)
  out.geomTaskB = await json(`(() => ({ widgets: [...document.querySelectorAll('.ProseMirror [data-img-widget]')].map((w) => w.className), selected: document.querySelectorAll('.ProseMirror .img-selected').length }))()`)
  const shotRevealed = await shot(CLIP)
  await shotFile(CLIP, 'tmp/ident-overlay-fullheight.png')
  dump()

  out.pixels = []
  for (const g of out.geom) {
    const blocked = g.imgRects.filter((r) => r.h > 2).map((r) => [r.l, r.r])
    for (const f of g.elRects) {
      const seg = freeSeg(f.l, f.r, blocked)
      if (!seg || seg[1] - seg[0] < 8) continue
      const line = g.lines.find((L) => L.t < f.b - 0.5 && L.b > f.t + 0.5 && L.h > f.h + 1) || g.lines.find((L) => L.t < f.b - 0.5 && L.b > f.t + 0.5) || null
      const win = {
        x0: Math.max(0, Math.round(seg[0] - CLIP.x) + 1),
        x1: Math.min(CLIP.width - 1, Math.round(seg[1] - CLIP.x) - 1),
        y0: Math.max(0, Math.round(f.t - CLIP.y) - 6),
        y1: Math.min(CLIP.height - 1, Math.round((line ? line.b : f.b) - CLIP.y) + 6)
      }
      const bg = colorRows(shotRevealed, EDGE, win, 4, 3)
      const rec = { frag: f, line, win, bgBand: bg && { top: +(bg.top + CLIP.y).toFixed(2), bottom: +(bg.bottom + CLIP.y).toFixed(2), height: bg.height } }
      await ev(`(() => { const v = window.__vt.ed().view; const TS = v.state.selection.constructor; v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, ${g.from}, ${g.from + g.textLen}))); return 'ok' })()`)
      await sleep(480)
      const shotSel = await shot(CLIP)
      const sel = diffRows(shotRevealed, shotSel, win, 24, 2)
      rec.selBand = sel && { top: +(sel.top + CLIP.y).toFixed(2), bottom: +(sel.bottom + CLIP.y).toFixed(2), height: sel.height }
      rec.selApi = await json(`(() => { const s = document.getSelection(); if (!s.rangeCount || !s.toString()) return null; const R = (x) => ({ t: +x.top.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2) }); return [...s.getRangeAt(0).getClientRects()].map(R) })()`)
      out.pixels.push(rec)
      await ev(`document.getSelection().removeAllRanges()`)
      await sleep(200)
    }
  }
  out.frames = JSON.parse(await ev(`window.__frames.then((f) => JSON.stringify(f))`))
  dump()

  // ── ⑥ 覆盖层不挡鼠标：命中测试 + 在被覆盖区域拖选
  const frag2 = out.geom[0] && out.geom[0].elRects[1]
  if (frag2) {
    const band = out.pixels[1] && out.pixels[1].bgBand
    const hy = band ? Math.round((band.top + band.bottom) / 2) : Math.round(frag2.t + frag2.h / 2)
    const hx = Math.round((frag2.l + frag2.r) / 2)
    out.mouse = await json(`(() => {
      const a = document.elementFromPoint(${hx}, ${hy})
      const b = document.elementFromPoint(${Math.round(frag2.l + 20)}, ${band ? Math.round(band.bottom - 6) : Math.round(frag2.b + 20)})
      const j = (el) => ({ tag: el ? el.tagName : null, cls: el ? String(el.className).slice(0, 60) : null, overlay: !!(el && el.closest && el.closest('.img-src-overlay')) })
      return { mid: j(a), low: j(b) }
    })()`)
    const ly = band ? Math.round(band.bottom - 6) : Math.round(frag2.b + 20)
    await drag(frag2.l + 8, ly, frag2.r - 8, ly)
    out.mouse.dragSelection = await json(`(() => { const s = window.__vt.ed().state.selection; const d = document.getSelection(); return { from: s.from, to: s.to, empty: s.empty, domText: d ? (d.toString() || '').slice(0, 30) : null } })()`)
    // 在**字形上**拖选（覆盖层正下方）：必须能正常选中源码文本
    const gy = Math.round(frag2.t + frag2.h / 2)
    await drag(frag2.l + 4, gy, frag2.r - 4, gy)
    out.mouse.dragOnGlyphs = await json(`(() => { const s = window.__vt.ed().state.selection; const d = document.getSelection(); return { from: s.from, to: s.to, empty: s.empty, domText: d ? (d.toString() || '').slice(0, 40) : null, textAtPoint: (() => { const el = document.elementFromPoint(${Math.round((frag2.l + frag2.r) / 2)}, ${gy}); return el ? String(el.className).slice(0, 40) : null })() } })()`)
    await ev(`document.getSelection().removeAllRanges()`)
    await sleep(200)
  }
  dump()

  // ── ⑥ 编辑态去底 + 无覆盖层
  await ensureRevealed()
  const mid2 = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return null; const r = [...el.getClientRects()].filter((x) => x.width > 2)[0] || el.getBoundingClientRect(); return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) } })()`)
  if (mid2) {
    await click(mid2.x, mid2.y)
    out.editing = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return { found: false }; const cs = getComputedStyle(el); return { found: true, cls: el.className, editing: el.classList.contains('img-src-revealed--editing'), bg: cs.backgroundColor, overlays: document.querySelectorAll('.img-src-overlay > div').length, overlayEl: !!document.querySelector('.img-src-overlay') } })()`)
  }
  // ── ⑥ 非激活隐藏
  await click(elsewhere.x, elsewhere.y)
  out.hiddenAfterClick = await json(`(() => ({ revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, overlayEl: !!document.querySelector('.img-src-overlay'), overlays: document.querySelectorAll('.img-src-overlay > div').length, selected: document.querySelectorAll('.ProseMirror .img-selected').length }))()`)
  out.mdAfter = await sha()
  out.mdRoundtripSame = out.mdBefore === out.mdAfter
  dump()

  // ── B：程序化选区（部分覆盖 / 不相交 / 完全覆盖）
  await ensureRevealed()
  const src = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return null; return { from: Number(el.getAttribute('data-img-from')), len: (el.textContent || '').length, cls: el.className } })()`)
  out.taskB = { source: src }
  if (src) {
    const setSel = async (from, to) => {
      await ev(`(() => { const v = window.__vt.ed().view; const TS = v.state.selection.constructor; v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, ${from}, ${to}))); return 'ok' })()`)
      await sleep(450)
    }
    const look = () =>
      json(`(() => {
        const sel = [...document.querySelectorAll('.ProseMirror .img-selected')]
        const w = document.querySelector('.ProseMirror [data-img-widget]')
        const cs = w ? getComputedStyle(w) : null
        const wi = w && w.querySelector('img') ? getComputedStyle(w.querySelector('img')) : null
        return {
          selectedCount: sel.length, classes: sel.map((n) => n.className),
          widgetCls: w ? w.className : null,
          widgetBg: cs ? cs.backgroundColor : null, widgetOutline: cs ? cs.outlineStyle + ' ' + cs.outlineWidth : null,
          imgBg: wi ? wi.backgroundColor : null,
          markers: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
          overlays: document.querySelectorAll('.img-src-overlay > div').length,
          sel: (() => { const s = window.__vt.ed().state.selection; return { from: s.from, to: s.to, empty: s.empty } })()
        }
      })()`)
    out.taskB.partial = await (async () => {
      await setSel(src.from + Math.floor(src.len * 0.6), src.from + src.len)
      const r = await look()
      await shotFile(CLIP, 'tmp/img-selected-browser-like.png')
      await shotFile(CLIP, `tmp/ov106-${TAG}-taskB-partial.png`)
      return r
    })()
    const pos = await json(`(() => { const v = window.__vt.ed().view; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => (x.textContent || '').startsWith('下划线不当斜体') && !x.querySelector('[data-img-revealed]')); if (!p) return null; const tn = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode(); if (!tn) return null; const from = v.posAtDOM(tn, 0); return { from, to: from + 8 } })()`)
    if (pos) {
      await setSel(pos.from, pos.to)
      out.taskB.noIntersect = await look()
    }
    await setSel(Math.max(0, src.from - 4), src.from + src.len + 4)
    out.taskB.full = await look()
    out.taskB.mdSame = (await sha()) === out.mdBefore
    await ev(`document.getSelection().removeAllRanges()`)
    await sleep(200)
  }
  // ── B：真实鼠标拖动跨过图片（浏览器语义）
  await ensureRevealed()
  const g0 = out.geom[0]
  if (g0) {
    const lastImg = g0.imgRects[g0.imgRects.length - 1]
    await drag(g0.pRect.l + 6, g0.pRect.t + 16, Math.min(1250, lastImg.r + 60), g0.pRect.t + 16)
    out.taskB_dragReal = await json(`(() => ({
      sel: (() => { const s = window.__vt.ed().state.selection; return { from: s.from, to: s.to, empty: s.empty } })(),
      selected: [...document.querySelectorAll('.ProseMirror .img-selected')].map((n) => n.className),
      widgets: [...document.querySelectorAll('.ProseMirror [data-img-widget]')].map((w) => w.className),
      markers: document.querySelectorAll('.ProseMirror [data-img-revealed]').length
    }))()`)
    await shotFile(CLIP, `tmp/ov106-${TAG}-dragselected.png`)
  }
  dump()

  // ── ③④ 块级档夹具
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(BLOCK_MD)}); return 'ok' })()`)
  await sleep(900)
  const bpt = await widgetPoint()
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
      const firstChar = (() => { if (!tn || !tn.length) return null; const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, 1); const rs = [...rg.getClientRects()]; return rs.length ? R(rs[0]) : null })()
      return {
        found: true, cls: el.className, lh: cs.lineHeight, pad: cs.paddingTop + '/' + cs.paddingBottom,
        elRects: [...el.getClientRects()].map(R), firstCharRangeRect: firstChar,
        contentColLeft: +(pRect.left + parseFloat(csP.paddingLeft)).toFixed(2),
        overlayCount: document.querySelectorAll('.img-src-overlay > div').length, overlayEl: !!document.querySelector('.img-src-overlay')
      }
    })()`)
    const shotBlock = await shot(CLIP_BLOCK)
    await shotFile(CLIP_BLOCK, `tmp/ov106-${TAG}-block-nosel.png`)
    const el = out.block.elRects && out.block.elRects[0]
    if (el) {
      const win = {
        x0: Math.max(0, Math.round(el.l - CLIP_BLOCK.x) + 2),
        x1: Math.min(CLIP_BLOCK.width - 1, Math.round(el.r - CLIP_BLOCK.x) - 2),
        y0: Math.max(0, Math.round(el.t - CLIP_BLOCK.y) - 6),
        y1: Math.min(CLIP_BLOCK.height - 1, Math.round(el.b - CLIP_BLOCK.y) + 6)
      }
      const bg = colorRows(shotBlock, EDGE, win, 4, Math.round((win.x1 - win.x0) * 0.6))
      out.block.win = win
      out.block.pxBgBand = bg && { top: +(bg.top + CLIP_BLOCK.y).toFixed(2), bottom: +(bg.bottom + CLIP_BLOCK.y).toFixed(2), height: bg.height }
      out.block.expectedLines = +(3 * parseFloat(out.block.lh)).toFixed(2)
    }
    const pos = await json(`(() => { const v = window.__vt.ed().view; const el = document.querySelector('.ProseMirror [data-img-revealed]'); const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); if (!tn) return null; const from = v.posAtDOM(tn, 0); return { from, to: Math.min(from + 5, v.state.doc.content.size - 1) } })()`)
    if (pos) {
      await ev(`(() => { const v = window.__vt.ed().view; const TS = v.state.selection.constructor; v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, ${pos.from}, ${pos.to}))); return 'ok' })()`)
      await sleep(400)
      out.block.selApi = await json(`(() => { const s = document.getSelection(); if (!s.rangeCount || !s.toString()) return null; return [...s.getRangeAt(0).getClientRects()].map((x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2) })) })()`)
      await ev(`document.getSelection().removeAllRanges()`)
    }
  }
  out.modalAtEnd = (await dismissPrompts()).prompts

  // ── 真实桌面路径（授权闸拒绝；放在最后，避免 toast 影响前面的坐标量测）
  out.realPath = await (async () => {
    const r = await ev(`(async () => { try { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'no-error' } catch (e) { return String(e.message).slice(0, 160) } })()`)
    await sleep(900)
    const state = await json(`(() => ({ contentLen: (window.__vt.files().content || '').length, toasts: [...document.querySelectorAll('[class*=toast]')].map((n) => (n.textContent || '').slice(0, 90)) }))()`)
    return { openResult: r, ...state }
  })()
  dump()
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  process.stderr.write('FAIL: ' + (e && e.stack ? e.stack : e.message) + '\n')
  process.exit(1)
})
