'use strict'
/**
 * 诊断探针：① 覆盖层要用的"逐行矩形"从哪来（Range/元素 client rects 等价性）；
 *            ② 原生选区**实画**带宽（像素差）vs 行盒 vs 元素底色；
 *            ③ 负 z-index 的覆盖层在这个 DOM 里是否可见（要不要 isolation）。
 * 用法：node tmp/probe-overlay.js <port> <tag> [realPath]
 */
const fs = require('fs')
const path = require('path')
const { decodePNG, diffRows, colorRows, countColor } = require('./png')

const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'diag'
const REAL = process.argv[4] || 'C:\\Users\\yangbaibai\\Desktop\\Lumin相关\\数学公式示例.md'
/** LUMIN_TRUSTED_PATHS=%TEMP% ⇒ 真实桌面路径被授权闸拒绝（实测 toast「无法打开文件」），
 *  改用**同哈希逐字节副本**：SHA256 133C85F71D40D0E0F8CACDD82EB5CEB49986B5BE9F98A3CF72393A65111128AB */
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-overlay-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')
const EDGE = [228, 230, 234]

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
      }, 20000)
      pending.set(i, (m) => {
        clearTimeout(t)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails)
      throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))
  const shotImg = async (clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    const buf = Buffer.from(r.result.data, 'base64')
    fs.writeFileSync(`tmp/ov-${TAG}-last.png`, buf)
    return decodePNG(buf)
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
  const out = { tag: TAG }
  const dump = () => fs.writeFileSync(`tmp/ov-${TAG}.json`, JSON.stringify(out, null, 1))
  let opened = COPY
  try {
    await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(COPY)}); return 'ok' })()`)
  } catch (e) {
    out.openError = String(e.message).slice(0, 200)
  }
  await sleep(200)
  const st = await json(`(() => { const f = window.__vt.files(); const e = window.__vt.ed(); return { len: (f.content||'').length, size: e ? e.state.doc.content.size : -1 } })()`)
  if (!st.len) {
    out.realPathError = 'TEMP 副本也打不开？'
    opened = REAL
    await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'ok' })()`)
  }
  out.opened = opened
  await sleep(1500)
  await send('Page.bringToFront').catch(() => null)
  // 等远程图片加载完（被撑高的行就是它们撑的）
  for (let i = 0; i < 40; i++) {
    const ok = await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)
    if (ok) break
    await sleep(400)
  }
  out.imgLoaded = await json(`[...document.querySelectorAll('.ProseMirror img')].map((im) => ({ c: im.complete, nw: im.naturalWidth, nh: im.naturalHeight, h: +im.getBoundingClientRect().height.toFixed(2) }))`)

  // DOM 结构：view.dom 的父链（覆盖层挂哪儿、谁有底色、谁是定位祖先）
  out.dom = await json(`(() => {
    const v = window.__vt.ed().view
    const chain = []
    let n = v.dom
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      chain.push({ tag: n.tagName.toLowerCase(), cls: String(n.className).slice(0, 80), pos: cs.position, z: cs.zIndex, iso: cs.isolation, bg: cs.backgroundColor, transform: cs.transform === 'none' ? 'none' : 'yes' })
      n = n.parentElement
    }
    return chain
  })()`)
  out.struct = await json(`(() => {
    const v = window.__vt.ed().view
    return { parentCls: String(v.dom.parentElement?.className || ''), parentTag: v.dom.parentElement?.tagName, offsetParentCls: String(v.dom.offsetParent?.className || '') }
  })()`)

  // 段落 15 的几何：逐行（range 原始 + 合并行 + 图片）
  const geomExpr = `(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
    const out = []
    for (const el of els) {
      const p = el.closest('p, li, pre, div')
      const cs = getComputedStyle(p)
      const q = document.createRange(); q.selectNodeContents(p)
      const raw = [...q.getClientRects()].filter((x) => x.width > 0 && x.height > 0).map(R)
      const imgs = [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect()))
      const groups = []
      for (const r of [...q.getClientRects(), ...p.querySelectorAll('img').values()].map((x) => ('getBoundingClientRect' in x ? x.getBoundingClientRect() : x)).filter((x) => x.width > 0 && x.height > 0)) {
        const hit = groups.find((o) => r.top < o.b - 0.5 && r.bottom > o.t + 0.5)
        if (hit) { hit.t = Math.min(hit.t, r.top); hit.b = Math.max(hit.b, r.bottom); hit.l = Math.min(hit.l, r.left); hit.r = Math.max(hit.r, r.right) }
        else groups.push({ t: r.top, b: r.bottom, l: r.left, r: r.right })
      }
      out.push({
        cls: el.className, from: el.getAttribute('data-img-from'), textLen: (el.textContent || '').length,
        pRect: R(p.getBoundingClientRect()), contentColLeft: +(p.getBoundingClientRect().left + parseFloat(cs.paddingLeft)).toFixed(2),
        elRects: [...el.getClientRects()].map(R),
        selfRangeRects: (() => { const g = document.createRange(); g.selectNodeContents(el); return [...g.getClientRects()].map(R) })(),
        textRangeRects: (() => { const g = document.createRange(); const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const tn = w.nextNode(); if (!tn) return null; g.setStart(tn, 0); g.setEnd(tn, Math.min(3, tn.length)); return [...g.getClientRects()].map(R) })(),
        rawRangeRects: raw, imgRects: imgs,
        lines: groups.map((o) => ({ l: +o.l.toFixed(2), t: +o.t.toFixed(2), r: +o.r.toFixed(2), b: +o.b.toFixed(2), w: +(o.r - o.l).toFixed(2), h: +(o.b - o.t).toFixed(2) }))
      })
    }
    return out
  })()`

  const clickFirstImg = async () => {
    const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    if (!pt) return null
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(500)
    return pt
  }
  const selectFrom = async (from, len) => {
    await json(`(() => {
      const v = window.__vt.ed().view
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, ${from}, ${from + len})))
      return 'ok'
    })()`)
    await sleep(600)
  }
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(400)
  }

  // ── 草稿弹窗（"未保存的草稿"，会盖一层遮罩 ⇒ 截图全被压灰、选区也不画）：一律「丢弃」
  const dismissDraft = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => {
        const btns = [...document.querySelectorAll('button')].filter((b) => /丢弃|放弃|Discard/i.test(b.textContent || ''))
        if (!btns.length) return 0
        btns[0].click()
        return 1
      })()`)
      if (!hit) break
      await sleep(700)
    }
    return ev(`!!document.querySelector('[role=dialog]')`)
  }
  out.modalAfterOpen = await dismissDraft()

  const CLIP = { x: 300, y: 330, width: 1000, height: 340 }
  // 编辑器聚焦：否则 PM 设了 Selection 但**原生选区不画**（实测 selBand=null）
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(200)
  // ── 未激活（隐藏）基线截图
  out.hiddenCount = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  const shotHidden = await shotImg(CLIP)
  await clickFirstImg()
  out.revealedAfterClick = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  await sleep(400)
  out.geom = await json(geomExpr)
  dump()
  log('revealed=' + out.revealedAfterClick + ' geom=' + out.geom.length + ' rects=' + out.geom.map((g) => g.elRects.length).join(','))
  const shotRevealed = await shotImg(CLIP)

  // 逐元素像素测量：底色带 / 选区实画带
  const freeSeg = (l, r, blocked) => {
    const cuts = [[l, r]]
    for (const [bl, br] of blocked) {
      for (let i = cuts.length - 1; i >= 0; i--) {
        const [a, b] = cuts[i]
        if (br <= a || bl >= b) continue
        cuts.splice(i, 1)
        if (bl > a) cuts.push([a, bl])
        if (br < b) cuts.push([br, b])
      }
    }
    cuts.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))
    return cuts[0] || null
  }
  out.pixels = []
  for (const g of out.geom) {
    const blocked = g.imgRects.filter((r) => r.h > 2).map((r) => [r.l, r.r])
    for (const f of g.elRects) {
      const seg = freeSeg(f.l, f.r, blocked)
      if (!seg || seg[1] - seg[0] < 8) {
        out.pixels.push({ frag: f, skipped: 'no free x segment' })
        continue
      }
      const line = g.lines.find((L) => L.t < f.b - 0.5 && L.b > f.t + 0.5 && L.h > f.h + 1) || g.lines.find((L) => L.t < f.b - 0.5 && L.b > f.t + 0.5) || null
      const x0 = Math.max(0, Math.round(seg[0] - CLIP.x) + 1)
      const x1 = Math.min(CLIP.width - 1, Math.round(seg[1] - CLIP.x) - 1)
      const y0 = Math.max(0, Math.round(f.t - CLIP.y) - 6)
      const y1 = Math.min(CLIP.height - 1, Math.round((line ? line.b : f.b) - CLIP.y) + 6)
      const win = { x0, x1, y0, y1 }
      const bg = colorRows(shotRevealed, EDGE, win, 4, 3)
      const rec = {
        frag: f,
        line,
        win: { x0, x1, y0, y1 },
        bgBand: bg && { top: +(bg.top + CLIP.y).toFixed(2), bottom: +(bg.bottom + CLIP.y).toFixed(2), height: bg.height }
      }
      const len = g.textLen
      await selectFrom(Number(g.from), len)
      const shotSel = await shotImg(CLIP)
      fs.writeFileSync(`tmp/ov-${TAG}-sel-${out.pixels.length}.png`, fs.readFileSync(`tmp/ov-${TAG}-last.png`))
      const sel = diffRows(shotRevealed, shotSel, win, 24, 2)
      rec.selBand = sel && { top: +(sel.top + CLIP.y).toFixed(2), bottom: +(sel.bottom + CLIP.y).toFixed(2), height: sel.height }
      rec.selApi = await json(`(() => { const s = document.getSelection(); if (!s.rangeCount || !s.toString()) return null; const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2) }); return [...s.getRangeAt(0).getClientRects()].map(R) })()`)
      out.pixels.push(rec)
      await ev(`document.getSelection().removeAllRanges()`)
      await sleep(250)
    }
  }
  fs.writeFileSync(`tmp/ov-${TAG}-revealed.png`, fs.readFileSync(`tmp/ov-${TAG}-last.png`))

  // 参照：**普通正文行**上的原生选区实画带宽（应 = 行盒 = 32.30）
  out.plainSel = await (async () => {
    const pos = await json(`(() => {
      const v = window.__vt.ed().view
      const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => (x.textContent || '').startsWith('下划线不当斜体') && !x.querySelector('[data-img-revealed]'))
      if (!p) return null
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      const tn = w.nextNode()
      if (!tn) return null
      const from = v.posAtDOM(tn, 0)
      const r = p.getBoundingClientRect()
      return { from, to: from + 8, rect: { l: r.left, t: r.top, r: r.right, b: r.bottom } }
    })()`)
    if (!pos) return null
    await ev(`(() => { const v = window.__vt.ed().view; const TS = v.state.selection.constructor; v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, ${pos.from}, ${pos.to}))); return 'ok' })()`)
    await sleep(500)
    const shotSel = await shotImg(CLIP)
    const win = {
      x0: Math.max(0, Math.round(pos.rect.l - CLIP.x) + 1),
      x1: Math.min(CLIP.width - 1, Math.round(pos.rect.l - CLIP.x) + 120),
      y0: Math.max(0, Math.round(pos.rect.t - CLIP.y) - 8),
      y1: Math.min(CLIP.height - 1, Math.round(pos.rect.b - CLIP.y) + 8)
    }
    const d = diffRows(shotRevealed, shotSel, win, 24, 2)
    const api = await json(`(() => { const s = document.getSelection(); if (!s.rangeCount || !s.toString()) return null; const R = (x) => ({ t: +x.top.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2) }); return [...s.getRangeAt(0).getClientRects()].map(R) })()`)
    await ev(`document.getSelection().removeAllRanges()`)
    await sleep(200)
    return { paraRect: pos.rect, selBand: d && { top: +(d.top + CLIP.y).toFixed(2), bottom: +(d.bottom + CLIP.y).toFixed(2), height: d.height }, api }
  })()
  dump()

  // ── 负 z-index 覆盖层可见性（有/无 isolation）
  const redTest = async (withIsolation) => {
    const g = (out.geom[0] && out.geom[0].elRects[0]) || { l: 400, t: 400, r: 500, b: 430 }
    await ev(`(() => {
      document.getElementById('xw-iso')?.remove()
      if (${withIsolation}) { const s = document.createElement('style'); s.id = 'xw-iso'; s.textContent = '.editor-content{isolation:isolate}'; document.head.appendChild(s) }
      document.getElementById('xw-red')?.remove()
      const v = window.__vt.ed().view
      const host = v.dom.parentElement
      const d = document.createElement('div')
      d.id = 'xw-red'
      d.style.cssText = 'position:absolute;z-index:-1;background-color:rgb(255,0,0)'
      const base = (host.offsetParent || host).getBoundingClientRect()
      const g = ${JSON.stringify(g)}
      d.style.left = (g.l - base.left + 2) + 'px'
      d.style.top = (g.t - base.top + 2) + 'px'
      d.style.width = '40px'
      d.style.height = '40px'
      host.appendChild(d)
      return 'ok'
    })()`)
    await sleep(300)
    const img = await shotImg(CLIP)
    const n = countColor(img, [255, 0, 0], { x0: 0, y0: 0, x1: CLIP.width - 1, y1: CLIP.height - 1 }, 10)
    await ev(`document.getElementById('xw-red')?.remove()`)
    return n
  }
  out.redNoIsolation = await redTest(false)
  out.redWithIsolation = await redTest(true)
  await ev(`document.getElementById('xw-iso')?.remove()`)

  fs.writeFileSync(`tmp/ov-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  log('FAIL: ' + (e && e.stack ? e.stack : e.message))
  process.exit(1)
})
