'use strict'
/**
 * 第一百一十四轮：拖动期"尾巴回缩"取证（Node 侧 11ms 轮询）
 * 逐帧记录：试探区间(data-img-drag-live 的 anchor|head|from|to)、Highlight 的 Range 文本长度与 x 覆盖、
 *          img-selected 数量与其覆盖的 widget 区间、指针位置、PM 选区
 * 四种组合：图片后/公式后 × 向左/向右（源码未显形为主，另加一组显形）
 * 用法：node tmp/tail-114.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-tail-fixture.md'
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
  const click = async (x, y, s = 380) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const shot = async (file) => {
    const clip = await json(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
      const r = p.getBoundingClientRect()
      return { x: Math.max(0, Math.floor(r.left) - 26), y: Math.max(0, Math.floor(r.top) - 26), width: Math.min(1210, Math.ceil(r.width) + 52), height: Math.ceil(r.height) + 52 } })()`)
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
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
  const geo = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const math = [...p.querySelectorAll('[data-md-math-rendered],[data-md-math-block]')].map((m) => R(m.getBoundingClientRect()))
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3)
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length))
    return { widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => ({ from: Number(w.getAttribute('data-img-from')), ...R(w.getBoundingClientRect()) })),
      math, text: R(rg.getBoundingClientRect()), para: R(p.getBoundingClientRect()), mathCount: math.length } })()`)
  await click(away.x, away.y)
  const out = { tag: TAG, geo, gestures: [] }
  const snap = () => json(`(() => {
    const s = window.__vt.ed().state.selection
    const pm = document.querySelector('.ProseMirror')
    const live = pm.getAttribute('data-img-drag-live') || ''
    const parts = live ? live.split('|').map(Number) : []
    const marked = [...document.querySelectorAll('.ProseMirror [data-img-widget].img-selected')].map((w) => Number(w.getAttribute('data-img-from')))
    let hl = { n: 0, len: 0, x0: null, x1: null }
    try {
      const h = CSS.highlights.get('lumin-img-drag')
      if (h) for (const r of h) { hl.n++; hl.len += (r.toString() || '').length
        for (const c of r.getClientRects()) { hl.x0 = hl.x0 == null ? c.left : Math.min(hl.x0, c.left); hl.x1 = hl.x1 == null ? c.right : Math.max(hl.x1, c.right) } }
    } catch (e) {}
    // 用户**实际看到**的原生选区（浏览器 DOM 选区）及其绘制范围
    let dom = { n: 0, len: 0, x0: null, x1: null }
    try {
      const sel = window.getSelection()
      if (sel && sel.rangeCount) {
        dom.n = sel.rangeCount
        const r = sel.getRangeAt(0)
        dom.len = (r.toString() || '').length
        for (const c of r.getClientRects()) { dom.x0 = dom.x0 == null ? c.left : Math.min(dom.x0, c.left); dom.x1 = dom.x1 == null ? c.right : Math.max(dom.x1, c.right) }
      }
    } catch (e) {}
    const u = (a, b) => (a == null ? b : b == null ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])])
    const domX = dom.x0 == null ? null : [dom.x0, dom.x1]
    const hlX = hl.x0 == null ? null : [hl.x0, hl.x1]
    const union = u(domX, hlX)
    return { anchor: parts[0] ?? null, head: parts[1] ?? null, pFrom: parts[2] ?? null, pTo: parts[3] ?? null,
      sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), imgSel: marked.length, imgSelFrom: marked.join(','),
      hlN: hl.n, hlLen: hl.len, hlX: hlX, domLen: dom.len, domX: domX,
      uX: union == null ? null : [Math.round(union[0]), Math.round(union[1])],
      revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
      cls: (() => { const e2 = document.querySelector('.ProseMirror [data-img-revealed]'); return e2 ? String(e2.className).replace('img-src-revealed--editing', 'RE').replace('img-src-revealed', 'R') : null })(),
      ov: document.querySelectorAll('.img-src-overlay > div').length,
      open: pm.getAttribute('data-img-open'),
      fallback: pm.getAttribute('data-img-settle-fallback') }
  })()`)
  /** 一次拖动：逐帧采样；返回帧数组与远端回缩帧 */
  const drag = async (name, from, to, frames = 26, opts = {}) => {
    await click(away.x, away.y, 260)
    // 前置收敛（第一百一十六轮）：先确认**已收起**再点开目标段，避免"点已开的那段"造成两种前置
    for (let k = 0; k < 3; k++) {
      const n = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
      if (!n) break
      await click(away.x, away.y, 300)
    }
    if (opts.reveal254) { for (let k = 0; k < 3; k++) { const pt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="254"] img'); const r = w.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) } })()`); await click(pt.x, pt.y, 620); if ((await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? Number(el.getAttribute('data-img-from')) : null })()`)) === 254) break } await sleep(250) }
    const fs2 = []
    await mouse('mousePressed', from.x, from.y); await sleep(25)
    fs2.push({ i: -1, t: 0, ptr: `${from.x},${from.y}`, ...(await snap()) })
    for (let k = 1; k <= frames; k++) {
      const x = from.x + ((to.x - from.x) * k) / frames
      const y = from.y + ((to.y - from.y) * k) / frames
      await mouse('mouseMoved', x, y, { buttons: 1 })
      fs2.push({ i: k, t: k, ptr: `${Math.round(x)},${Math.round(y)}`, ...(await snap()) })
      await sleep(11)
    }
    if (opts.shotAt) await shot(opts.shotAt)
    const pre = await snap()
    await mouse('mouseReleased', to.x, to.y)
    await sleep(420)
    const post = await json(`(() => { const s = window.__vt.ed().state.selection; const v = window.__vt.ed().view; return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), frag: v.state.doc.textBetween(s.from, s.to, '\\n').slice(0, 90), marked: document.querySelectorAll('.ProseMirror .img-selected').length, hlNow: (() => { try { return CSS.highlights.get('lumin-img-drag') ? 1 : 0 } catch (e) { return -1 } })() } })()`)
    // 远端回缩检测：① 试探区间远端 ② **用户实际看到的并集**（原生选区 ∪ highlight）右端
    const shrink = []
    const shrinkU = []
    for (let k = 1; k < fs2.length; k++) {
      const a = fs2[k - 1], b = fs2[k]
      if (a.pTo == null || b.pTo == null) continue
      const fa = Math.abs(a.pTo - a.anchor), fb = Math.abs(b.pTo - b.anchor)
      if (fb < fa) shrink.push({ i: b.i, prev: a.pTo, now: b.pTo, anchor: a.anchor, prevFar: fa, nowFar: fb })
      // 并集覆盖的**两端**都要查：拖动方向不定，任一端回缩都算
      const retr = (a1, b1) => (!a1 || !b1 ? null : b1[0] > a1[0] + 1 ? 'left' : b1[1] < a1[1] - 1 ? 'right' : null)
      const dir = retr(a.uX, b.uX)
      if (dir) shrinkU.push({ i: b.i, dir, prevX: a.uX, nowX: b.uX, domX: b.domX, hlX: b.hlX })
    }
    const g = { name, from, to, frames: fs2, pre, post, shrink, shrinkU }
    out.gestures.push(g)
    console.log(`\n== ${name} 起点(${from.x},${from.y}) → 终点(${to.x},${to.y})`)
    console.log('   序列 ' + JSON.stringify(fs2.map((f) => `${f.pFrom}-${f.pTo}(a${f.anchor},h${f.head},sel${f.sel},img${f.imgSel}[${f.imgSelFrom}],hl${f.hlLen})`)))
    console.log(`   回缩帧=${shrink.length}` + (shrink.length ? ' ' + JSON.stringify(shrink) : ''))
    console.log(`   松手前 paint=${pre.pFrom}-${pre.pTo} imgSel=${pre.imgSel}[${pre.imgSelFrom}] hlLen=${pre.hlLen} | 松手后 ${JSON.stringify(post)}`)
    return g
  }
  const w0 = geo.widgets[0]
  const w1 = geo.widgets[1]
  const textY = Math.round((geo.text.t + geo.text.b) / 2)
  const imgMidY = Math.round((w1.t + w1.b) / 2)
  const m0 = geo.math[0]
  const m1 = geo.math[geo.math.length - 1]
  const mathY = m0 ? Math.round((m0.t + m0.b) / 2) : textY
  // A 图片后 → 向左拖（源码未显形；P1 主场景）
  await drag('A 图片后→左拖(未显形)', { x: Math.round(w1.r + 40), y: imgMidY }, { x: Math.round(geo.text.l + 6), y: textY }, 30, { shotAt: 'tmp/drag-tail-union-2.png' })
  // B 图片后 → 向右拖
  await drag('B 图片后→右拖(未显形)', { x: Math.round(w1.r + 12), y: imgMidY }, { x: Math.round(geo.para.r - 8), y: imgMidY }, 24)
  // C 公式后 → 向左拖
  await drag('C 公式后→左拖(未显形)', { x: Math.round((m1 ? m1.r : w0.l) + 6), y: mathY }, { x: Math.round(geo.text.l + 6), y: textY }, 26)
  // D 公式后 → 向右拖
  await drag('D 公式后→右拖(未显形)', { x: Math.round((m0 ? m0.r : 500) + 10), y: mathY }, { x: Math.round(geo.para.r - 8), y: textY }, 24)
  // E 图片后 → 左拖（源码显形）—— 连跑两次验确定性（④）
  await drag('E1 图片后→左拖(显形) 第1次', { x: Math.round(w1.r + 40), y: imgMidY }, { x: Math.round(geo.text.l + 6), y: textY }, 26, { reveal254: true })
  await drag('E2 图片后→左拖(显形) 第2次', { x: Math.round(w1.r + 40), y: imgMidY }, { x: Math.round(geo.text.l + 6), y: textY }, 26, { reveal254: true })
  // F 正文起手 → 向右拖过两张图（P2 ④ 要复测的两条之一）
  await drag('F 正文起手→右拖过图(未显形)', { x: Math.round(w0.l - 60), y: textY }, { x: Math.round(w1.r + 30), y: imgMidY }, 26)
  fs.writeFileSync(`tmp/tail114-${TAG}.json`, JSON.stringify(out, null, 1))
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
