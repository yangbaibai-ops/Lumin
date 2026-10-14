'use strict'
/**
 * 第一百二十一轮主探针（S1/S2）：**方框拖动**（按下点→指针压在图片盒上）期间，我们的绘制
 * vs 松手后浏览器画的那条带，逐列/逐行取像素 + 逐帧取几何。
 *
 * 用法：
 *   node tmp/selstyle-122.js <port> math|real <tag>
 *
 * 机制要点（为什么这么起手）：拖动期的即时绘制只在 `boxDrag` 这条路上（指针压在图片盒上时
 * `imgDragEdgeAtPoint` 才给得出 focus），而指针进图片死区后**原生选区会塌缩** ⇒ 覆盖整段的
 * 就只有我们画的那一层 —— 正是用户第 1/2 条看到的东西。
 */
const fs = require('fs')
const path = require('path')
const { decodePng, columnRun, rowRuns, paperColor, DIFF } = require('./png-util.js')

const PORT = process.argv[2] || '9351'
const MODE = process.argv[3] || 'math'
const TAG = process.argv[4] || 'a'
const TMP = process.env.TEMP || 'C:\\Windows\\Temp'
const FIXTURE = MODE === 'real' ? TMP + '\\xw-selband-fixture.md' : TMP + '\\xw-selstyle-math.md'
const OUTDIR = path.join(__dirname, 'shots-121')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(' ') + '\n')

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true })
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 320) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const dismiss = async () => { for (let i = 0; i < 8; i++) { const h = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`); if (!h) break; await sleep(600) } }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(r.result.data, 'base64')
    fs.writeFileSync(path.join(OUTDIR, `${TAG}-${name}.png`), buf)
    return decodePng(buf)
  }
  const sel = () => ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') })()`)

  await ev(`(() => { if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK' })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300); await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(FIXTURE)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(1000); await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }

  await ev(`(() => {
    const R = (rg) => { const o = []; for (const r of rg.getClientRects()) { if (r.width > 0.5 || r.height > 0.5) o.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } return o }
    window.__P = {
      rects: R,
      native() { const s = window.getSelection(); if (!s || s.isCollapsed || !s.rangeCount) return { empty: true, rects: [] }; return { empty: false, rects: R(s.getRangeAt(0)) } },
      hl() { const h = window.CSS && CSS.highlights && CSS.highlights.get('lumin-img-drag'); if (!h) return []; const o = []; for (const rg of h) o.push(...R(rg)); return o },
      bands() { const o = []; for (const d of document.querySelectorAll('.sel-band > div')) { const r = d.getBoundingClientRect(); o.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } return o },
      imgSel() { const o = []; for (const w of document.querySelectorAll('.ProseMirror .img-selected')) { const r = w.getBoundingClientRect(); o.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } return o },
      lines(rects) { const L = []; for (const r of rects) { let h = L.find((x) => Math.min(x.b, r[3]) - Math.max(x.t, r[1]) > 0); if (!h) { h = { l: r[0], t: r[1], r: r[2], b: r[3] }; L.push(h) } else { h.l = Math.min(h.l, r[0]); h.r = Math.max(h.r, r[2]); h.t = Math.min(h.t, r[1]); h.b = Math.max(h.b, r[3]) } } return L },
      frame() {
        const n = this.native(); const h = this.hl(); const b = this.bands(); const im = this.imgSel()
        const painted = [...b, ...h]
        const d = document.querySelector('.ProseMirror')
        const own = d.getAttribute('data-sel-own')
        const parse = (s) => (s || '').split(';').filter(Boolean).map((t) => { const [l, tp, r, bo] = t.split(',').map(Number); return [l, tp, r, bo] })
        const ours = parse(d.getAttribute('data-sel-band-ours'))
        const rendered = parse(d.getAttribute('data-sel-band-live'))
        const cov = (set, r) => set.some((p) => Math.min(p[3], r[3]) - Math.max(p[1], r[1]) > -0.5 && p[0] <= r[0] + 0.5 && p[2] >= r[2] - 0.5)
        // Chromium 的 Range.getClientRects 里会混进**块盒矩形**（段落/块级公式的盒子，整行宽）；
        // 它**不画**这些（逐像素已验证：那一行的实测带只到文本右缘）⇒ 比"漏画"时要剔掉
        const blocks = [...document.querySelectorAll('.ProseMirror p,.ProseMirror li,.ProseMirror pre,.ProseMirror td,.ProseMirror th,.ProseMirror [data-md-math-block]')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom] })
        const isBlockBox = (r) => blocks.some((b) => Math.abs(b[0] - r[0]) <= 1 && Math.abs(b[1] - r[1]) <= 1 && Math.abs(b[2] - r[2]) <= 1 && Math.abs(b[3] - r[3]) <= 1)
        const natText0 = n.rects.filter((r) => !isBlockBox(r))
        const natText = natText0
        const nBlockBoxRects = n.rects.length - natText.length
        const lines = this.lines(natText)
        // ① 我们负责画的（data-sel-band-ours）有没有没画出来的 ⇒ 恒 0
        let missOurs = 0
        for (const r of ours) if (!cov(painted, r)) missOurs++
        // ② 闸门开着（浏览器那份被关掉）时，**原生选区几何（文字盒）**也必须被我们盖住 ⇒ 恒 0
        let missLines = 0, missFrags = 0; const detail = []
        if (own) {
          for (const r of natText) if (!cov(painted, r)) { missFrags++; if (detail.length < 4) detail.push(['frag', r]) }
          for (const L of lines) if (!painted.some((p) => Math.min(p[3], L.b) - Math.max(p[1], L.t) > 0 && p[0] <= L.l + 0.5 && p[2] >= L.r - 0.5)) { missLines++; if (detail.length < 4) detail.push(['line', [L.l, L.t, L.r, L.b]]) }
        }
        return { empty: n.empty, nRects: natText.length, nBlockBoxRects, nLines: lines.length, painted: painted.length, bands: b.length, hl: h.length, imgs: im.length,
          own, oursN: ours.length, renderedN: rendered.length, missOurs, missLines, missFrags, detail,
          nativeLines: lines.map((x) => [+x.l.toFixed(1), +x.t.toFixed(1), +x.r.toFixed(1), +x.b.toFixed(1)]),
          bandRects: b.map((x) => x.map((v) => +v.toFixed(1))), hlRects: h.map((x) => x.map((v) => +v.toFixed(1))), imgRects: im.map((x) => x.map((v) => +v.toFixed(1))) }
      },
      diag() {
        const d = document.querySelector('.ProseMirror')
        return { live: d.getAttribute('data-img-drag-live'), edge: d.getAttribute('data-img-drag-edge'), own: d.getAttribute('data-sel-own'), bandOurs: d.getAttribute('data-sel-band-ours'), liveBand: d.getAttribute('data-sel-band-live'), bandMiss: d.getAttribute('data-sel-band-miss'), settledBand: d.getAttribute('data-sel-band-settled'), fallback: d.getAttribute('data-img-settle-fallback') }
      },
      /* 现测某一"行"（拖动后重取，避免布局漂移把列量到别处）：key = 行首/行中/行尾/纯正文/block */
      lineInfo(key) {
        const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]
        if (key === 'block') {
          const bm = document.querySelector('.ProseMirror [data-md-math-block]')
          if (!bm) return null
          const texts = []
          const w = document.createTreeWalker(bm, NodeFilter.SHOW_TEXT); let n
          while ((n = w.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0.5) texts.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) }
          return { line: R(bm.getBoundingClientRect()), katex: texts }
        }
        const all = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')]
        const p = /^@[0-9]+$/.test(key) ? all[Number(key.slice(1))] : all.find((x) => (x.textContent || '').startsWith(key))
        if (!p) return null
        const rects = []
        const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n
        while ((n = w.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) rects.push({ l: r.left, t: r.top, r: r.right, b: r.bottom }) }
        const math = [...p.querySelectorAll('[data-md-math-rendered]')].map((m) => R(m.getBoundingClientRect()))
        const imgs = [...p.querySelectorAll('[data-img-widget]')].map((m) => R(m.getBoundingClientRect()))
        const groups = []
        for (const r of rects) { let g = groups.find((x) => Math.min(x.b, r.b) - Math.max(x.t, r.t) > 0); if (!g) { g = { l: r.l, t: r.t, r: r.r, b: r.b }; groups.push(g) } else { g.l = Math.min(g.l, r.l); g.r = Math.max(g.r, r.r); g.t = Math.min(g.t, r.t); g.b = Math.max(g.b, r.b) } }
        const g = groups[0]
        if (!g) return null
        return { line: [+g.l.toFixed(2), +g.t.toFixed(2), +g.r.toFixed(2), +g.b.toFixed(2)], formulas: math, imgs }
      },
      lines2() {
        const out = []
        for (const [bi, b] of [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')].entries()) {
          const rects = []
          const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n
          while ((n = w.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) rects.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height }) }
          const math = [...b.querySelectorAll('[data-md-math-rendered]')].map((m) => { const q = m.getBoundingClientRect(); return [q.left, q.top, q.right, q.bottom] })
          const imgs = [...b.querySelectorAll('[data-img-widget]')].map((m) => { const q = m.getBoundingClientRect(); return [q.left, q.top, q.right, q.bottom] })
          const groups = []
          for (const r of rects) { let g = groups.find((x) => Math.min(x.b, r.b) - Math.max(x.t, r.t) > 0); if (!g) { g = { l: r.l, t: r.t, r: r.r, b: r.b, hs: [r.h] }; groups.push(g) } else { g.l = Math.min(g.l, r.l); g.r = Math.max(g.r, r.r); g.t = Math.min(g.t, r.t); g.b = Math.max(g.b, r.b); g.hs.push(r.h) } }
          for (const g of groups) {
            const fm = math.filter((m) => (m[1] + m[3]) / 2 >= g.t - 3 && (m[1] + m[3]) / 2 <= g.b + 3)
            const im = imgs.filter((m) => (m[1] + m[3]) / 2 >= g.t - 3 && (m[1] + m[3]) / 2 <= g.b + 3)
            const rel = fm.length ? (fm[0][0] - g.l) / Math.max(1, g.r - g.l) : -1
            out.push({ blk: bi, text: (b.textContent || '').slice(0, 16), line: [+g.l.toFixed(2), +g.t.toFixed(2), +g.r.toFixed(2), +g.b.toFixed(2)], lineH: +(g.b - g.t).toFixed(2), textHs: g.hs.map((x) => +x.toFixed(1)), lh: parseFloat(getComputedStyle(b).lineHeight),
              formulas: fm.map((x) => x.map((v) => +v.toFixed(2))), imgs: im.map((x) => x.map((v) => +v.toFixed(2))), rel: +rel.toFixed(2), pos: fm.length ? (rel < 0.25 ? 'start' : rel > 0.6 ? 'end' : 'mid') : '' })
          }
        }
        const bm = document.querySelector('.ProseMirror [data-md-math-block]')
        if (bm) {
          const q = bm.getBoundingClientRect()
          const texts = []
          const w = document.createTreeWalker(bm, NodeFilter.SHOW_TEXT); let n
          while ((n = w.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0.5) texts.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) }
          out.push({ blk: 'block', text: '$$', line: [+q.left.toFixed(2), +q.top.toFixed(2), +q.right.toFixed(2), +q.bottom.toFixed(2)], lineH: +q.height.toFixed(2), textHs: texts.map((t) => +(t[3] - t[1]).toFixed(1)), lh: parseFloat(getComputedStyle(bm.parentElement).lineHeight), formulas: [[+q.left.toFixed(2), +q.top.toFixed(2), +q.right.toFixed(2), +q.bottom.toFixed(2)]], imgs: [], rel: 0, pos: 'block', katex: texts })
        }
        return out
      },
      awayPoint() {
        const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-md-math-rendered],[data-md-math-block],[data-img-widget]') && x.getBoundingClientRect().height > 10)
        if (!q) { const r = document.querySelector('.ProseMirror').getBoundingClientRect(); return { x: Math.round(r.right - 30), y: Math.round(r.bottom - 30) } }
        const r = q.getBoundingClientRect()
        return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }
      }
    }
    return 'ok'
  })()`)

  const away = await json(`window.__P.awayPoint()`)
  const lines = await json(`window.__P.lines2()`)
  log(`# 夹具 ${FIXTURE}`)
  for (const [i, L] of lines.entries()) log(`#   行${i} ${JSON.stringify(L.text)} line=${JSON.stringify(L.line)} h=${L.lineH} lh=${L.lh} 文字盒高=${JSON.stringify(L.textHs)} 公式=${JSON.stringify(L.formulas)} 图=${JSON.stringify(L.imgs)} pos=${L.pos}`)

  const out = { tag: TAG, mode: MODE, cases: [] }

  /** 用"现测的行几何"重算量测窗口/列（`key` = 行首/行中/行尾/纯正文/block） */
  const buildMeta = (key, fresh) => {
    const R = fresh.line
    const y = Math.round((R[1] + R[3]) / 2)
    if (key === 'block') {
      const kx = fresh.katex && fresh.katex.length
        ? (Math.min(...fresh.katex.map((t) => t[0])) + Math.max(...fresh.katex.map((t) => t[2]))) / 2
        : (R[0] + R[2]) / 2
      return { key, yWindow: [Math.round(R[1] - 40), Math.round(R[3] + 40)], xWindow: [Math.round(R[0]) - 6, Math.round(R[2]) + 6],
        cols: { katex: kx, blank: R[0] + 60, gapR: (fresh.katex && fresh.katex.length ? Math.max(...fresh.katex.map((t) => t[2])) : R[2]) + 6 },
        rows: { blockMid: y }, line: R, formula: R }
    }
    const f = fresh.formulas && fresh.formulas[0] ? fresh.formulas[0] : null
    const cols = {}
    if (f) { cols.formula = (f[0] + f[2]) / 2; cols.gapL = f[0] - 4; cols.gapR = f[2] + 4 }
    cols.bodyL = (R[0] + (f ? f[0] : R[2])) / 2
    if (f && R[2] > f[2] + 12) cols.bodyR = (f[2] + R[2]) / 2
    else if (!f) cols.bodyR = R[0] + 20
    return { key, yWindow: [Math.round(R[1] - 40), Math.round(R[3] + 40)], xWindow: [Math.round(R[0]) - 6, Math.round(R[2]) + 6], cols,
      rows: { lineMid: y, lineTop: Math.round(R[1] + 4), lineBottom: Math.round(R[3] - 4) }, line: R, formula: f }
  }

  /** 一次「按住不放」：从 from 拖到 to（指针停在 to 上不松手） */
  const holdDrag = async (label, from, to, meta) => {
    await click(away.x, away.y, 300)
    await mouse('mousePressed', from.x, from.y)
    await sleep(40)
    const steps = 12
    for (let k = 1; k <= steps; k++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / steps, from.y + ((to.y - from.y) * k) / steps, { buttons: 1 })
      await sleep(18)
    }
    await sleep(60)
    const frames = []
    for (let i = 0; i < 22; i++) {
      const f = await json(`window.__P.frame()`)
      const d = await json(`window.__P.diag()`)
      f.sel = await sel(); f.live = d.live; f.edge = d.edge; f.why = d.why
      frames.push(f)
      await sleep(11)
    }
    const dragShot = await shot(`${label}-drag`)
    const midSel = await sel()
    const midDiag = await json(`window.__P.diag()`)
    const midFrame = await json(`window.__P.frame()`)
    /** 拖动后**重取**这一行的几何（布局可能被"显形源码"挪过 ⇒ 列不能沿用开场那份） */
    let meta2 = meta
    if (meta.key) {
      const fresh = await json(`window.__P.lineInfo(${JSON.stringify(meta.key)})`)
      if (fresh) meta2 = buildMeta(meta.key, fresh)
    }
    /** 多行 case：一次手势顺带量多行（每个 key 各自重取几何） */
    const extraFresh = []
    for (const k of meta.extraKeys || []) {
      const fresh = await json(`window.__P.lineInfo(${JSON.stringify(k)})`)
      if (fresh) extraFresh.push([k, buildMeta(k, fresh)])
    }
    await mouse('mouseReleased', to.x, to.y)
    await sleep(560)
    const settledShot = await shot(`${label}-settled`)
    const settledSel = await sel()
    const settledDiag = await json(`window.__P.diag()`)
    const settledFrame = await json(`window.__P.frame()`)
    const leak = await json(`({ bandKids: document.querySelectorAll('.sel-band > div').length, band: document.querySelectorAll('.sel-band').length, imgSel: document.querySelectorAll('.ProseMirror .img-selected').length, dragLive: document.querySelector('.ProseMirror').getAttribute('data-img-drag-live') })`)
    await click(away.x, away.y, 260)

    const paperD = paperColor(dragShot)
    const paperS = paperColor(settledShot)
    const [lt, lb] = meta2.yWindow
    const cols = {}
    for (const [nm, x] of Object.entries(meta2.cols || {})) {
      const xi = Math.round(x)
      cols[nm] = { x: xi, drag: columnRun(dragShot, xi, lt, lb, paperD), settled: columnRun(settledShot, xi, lt, lb, paperS) }
    }
    const rows = {}
    for (const [nm, y] of Object.entries(meta2.rows || {})) {
      rows[nm] = { y, drag: rowRuns(dragShot, Math.round(y), meta2.xWindow[0], meta2.xWindow[1], paperD), settled: rowRuns(settledShot, Math.round(y), meta2.xWindow[0], meta2.xWindow[1], paperS) }
    }
    const g = (o) => (o ? { t: o.top, b: o.bottom, h: o.height, edge: o.edge } : null)
    const measure = (m) => {
      const cs = {}
      for (const [nm, x] of Object.entries(m.cols || {})) {
        const xi = Math.round(x)
        cs[nm] = { x: xi, drag: columnRun(dragShot, xi, m.yWindow[0], m.yWindow[1], paperD), settled: columnRun(settledShot, xi, m.yWindow[0], m.yWindow[1], paperS) }
      }
      const rs = {}
      for (const [nm, y] of Object.entries(m.rows || {})) {
        rs[nm] = { y, drag: rowRuns(dragShot, Math.round(y), m.xWindow[0], m.xWindow[1], paperD), settled: rowRuns(settledShot, Math.round(y), m.xWindow[0], m.xWindow[1], paperS) }
      }
      return {
        cols: Object.fromEntries(Object.entries(cs).map(([k, v]) => [k, { x: v.x, drag: g(v.drag), settled: g(v.settled), d: v.drag && v.settled ? { dt: Math.abs(v.drag.top - v.settled.top), db: Math.abs(v.drag.bottom - v.settled.bottom), dh: Math.abs(v.drag.height - v.settled.height), dcolor: DIFF(v.drag.edge, v.settled.edge) } : null }])),
        rows: Object.fromEntries(Object.entries(rs).map(([k, v]) => [k, { y: v.y, drag: v.drag, settled: v.settled }]))
      }
    }
    const rec = {
      label, from, to, meta: { yWindow: meta.yWindow, xWindow: meta.xWindow },
      midSel, settledSel, live: midDiag.live, edge: midDiag.edge, why: midDiag.why, fallback: midDiag.fallback, liveBand: midDiag.liveBand, settledBand: midDiag.settledBand, own: midDiag.own, bandMiss: midDiag.bandMiss,
      leak, midFrame: { nRects: midFrame.nRects, nLines: midFrame.nLines, painted: midFrame.painted, bands: midFrame.bands, hl: midFrame.hl, imgs: midFrame.imgs, own: midFrame.own, missOurs: midFrame.missOurs, missLines: midFrame.missLines, missFrags: midFrame.missFrags, nativeLines: midFrame.nativeLines, bandRects: midFrame.bandRects, hlRects: midFrame.hlRects, detail: midFrame.detail },
      settledFrame: { nRects: settledFrame.nRects, nLines: settledFrame.nLines, bandRects: settledFrame.bandRects, nativeLines: settledFrame.nativeLines, missLines: settledFrame.missLines, missFrags: settledFrame.missFrags },
      frameStats: {
        n: frames.length,
        missOursMax: Math.max(...frames.map((f) => f.missOurs)),
        missLinesMax: Math.max(...frames.map((f) => f.missLines)),
        missFragsMax: Math.max(...frames.map((f) => f.missFrags)),
        missFrames: frames.filter((f) => f.missLines + f.missFrags + f.missOurs > 0).length,
        noPaintWithNativeFrames: frames.filter((f) => f.nRects > 0 && f.painted === 0).length,
        emptyNativeFrames: frames.filter((f) => f.empty).length,
        paintedMin: Math.min(...frames.map((f) => f.painted)),
        ownSeq: frames.map((f) => f.own || '-').filter((s, i, a) => i === 0 || s !== a[i - 1]),
        seq: frames.map((f) => `${f.empty ? 'E' : f.nRects}L${f.nLines}p${f.painted}(b${f.bands}h${f.hl})own${f.own || '-'}m${f.missOurs}.${f.missLines}.${f.missFrags}@${f.sel}`),
        firstMissDetail: frames.find((f) => f.missLines + f.missFrags + f.missOurs > 0)?.detail || null
      },
      paper: { drag: paperD, settled: paperS },
      ...measure(meta2),
      extra: extraFresh.map(([k, m]) => ({ key: k, ...measure(m) }))
    }
    out.cases.push(rec)
    log(`\n=== ${label}  from=(${from.x},${from.y}) to=(${to.x},${to.y})`)
    log(`    sel 拖动中=${midSel} 松手后=${settledSel}  live=${midDiag.live} edge=${midDiag.edge} why=${midDiag.why}`)
    log(`    拖动中: 原生片段=${midFrame.nRects} 行=${midFrame.nLines} 我们画=${midFrame.painted}(带${midFrame.bands}+高亮${midFrame.hl}) 闸=${midFrame.own} 负责${midFrame.oursN}/实画${midFrame.renderedN} 漏ours=${midFrame.missOurs} 漏原生行=${midFrame.missLines} 漏原生片=${midFrame.missFrags}`)
    log(`    逐帧漏画: missLinesMax=${rec.frameStats.missLinesMax} missFragsMax=${rec.frameStats.missFragsMax} 有漏帧=${rec.frameStats.missFrames}/${rec.frameStats.n} 原生非空但零绘制帧=${rec.frameStats.noPaintWithNativeFrames} 空原生帧=${rec.frameStats.emptyNativeFrames} paintedMin=${rec.frameStats.paintedMin}`)
    if (rec.frameStats.firstMissDetail) log(`    首次漏画明细=${JSON.stringify(rec.frameStats.firstMissDetail)}`)
    log(`    我们的带矩形=${JSON.stringify(midFrame.bandRects)}`)
    log(`    原生行矩形=${JSON.stringify(midFrame.nativeLines)}`)
    log(`    松手后原生行矩形=${JSON.stringify(settledFrame.nativeLines)}`)
    log(`    泄漏=${JSON.stringify(leak)}`)
    for (const [k, v] of Object.entries(rec.cols)) log(`    列 ${k.padEnd(8)} x=${String(v.x).padStart(4)} 拖动中=${v.drag ? `t${v.drag.t} b${v.drag.b} h${v.drag.h} rgb${v.drag.edge}` : 'null'} 松手后=${v.settled ? `t${v.settled.t} b${v.settled.b} h${v.settled.h} rgb${v.settled.edge}` : 'null'} Δ=${v.d ? `t${v.d.dt} b${v.d.db} h${v.d.dh} 色${v.d.dcolor}` : 'n/a'}`)
    for (const [k, v] of Object.entries(rec.rows)) log(`    行 ${k} y=${v.y} 拖动中=${JSON.stringify(v.drag)} 松手后=${JSON.stringify(v.settled)}`)
    for (const e of rec.extra) {
      log(`  ── 附带量测 ${e.key}`)
      for (const [k, v] of Object.entries(e.cols)) log(`    列 ${k.padEnd(8)} x=${String(v.x).padStart(4)} 拖动中=${v.drag ? `t${v.drag.t} b${v.drag.b} h${v.drag.h} rgb${v.drag.edge}` : 'null'} 松手后=${v.settled ? `t${v.settled.t} b${v.settled.b} h${v.settled.h} rgb${v.settled.edge}` : 'null'} Δ=${v.d ? `t${v.d.dt} b${v.d.db} h${v.d.dh} 色${v.d.dcolor}` : 'n/a'}`)
      for (const [k, v] of Object.entries(e.rows)) log(`    行 ${k} y=${v.y} 拖动中=${JSON.stringify(v.drag)} 松手后=${JSON.stringify(v.settled)}`)
    }
    return rec
  }

  const findLine = (p) => lines.find((L) => L.text.includes(p))
  const cases = []
  if (MODE === 'math') {
    for (const [label, key] of [['S1-start', '行首'], ['S1-mid', '行中'], ['S1-end', '行尾']]) {
      const L = findLine(key)
      if (!L) continue
      const f = L.formulas[0]
      const img = L.imgs[0]
      cases.push([label, { x: Math.round(L.line[0] + 3), y: Math.round((L.line[1] + L.line[3]) / 2) }, { x: Math.round((img[0] + img[2]) / 2), y: Math.round((img[1] + img[3]) / 2) },
        { yWindow: [Math.round(L.line[1] - 40), Math.round(L.line[3] + 40)], xWindow: [Math.round(L.line[0]) - 6, Math.round(L.line[2]) + 6],
          cols: { formula: (f[0] + f[2]) / 2, gapL: f[0] - 4, gapR: f[2] + 4, bodyL: (L.line[0] + f[0]) / 2, bodyR: L.line[2] > f[2] + 10 ? (f[2] + L.line[2]) / 2 : null },
          rows: { lineMid: Math.round((L.line[1] + L.line[3]) / 2), lineTop: Math.round(L.line[1] + 4), lineBottom: Math.round(L.line[3] - 4) }, line: L, formula: f, img, key }])
    }
    const B = lines.find((L) => L.pos === 'block')
    const Bimg = lines.find((L) => L.pos === '' && L.imgs.length)
    if (B) {
      const img = (Bimg && Bimg.imgs[0]) || null
      const kx = B.katex && B.katex.length ? (B.katex[0][0] + B.katex[0][2]) / 2 : (B.line[0] + B.line[2]) / 2
      // 起手：块级公式**下面那张图右侧的空白带**（死区：原生不落光标），往左上拖回公式行
      const from = img ? { x: Math.round(img[2] + 30), y: Math.round((img[1] + img[3]) / 2) } : { x: Math.round(kx + 40), y: Math.round((B.line[1] + B.line[3]) / 2) }
      cases.push(['S1-block', from, { x: Math.round(kx), y: Math.round((B.line[1] + B.line[3]) / 2) },
        { yWindow: [Math.round(B.line[1] - 70), Math.round(B.line[3] + 150)], xWindow: [Math.round(B.line[0]) - 6, Math.round(B.line[2]) + 6], cols: { katex: kx, blank: B.line[0] + 60, gapR: (B.katex && B.katex.length ? B.katex[B.katex.length - 1][2] : B.line[2]) + 6 }, rows: { blockMid: Math.round((B.line[1] + B.line[3]) / 2) }, line: B, formula: B.line, key: 'block' }])
    }
    const T = findLine('纯正文')
    if (T && T.imgs.length) {
      const img = T.imgs[0]
      // 纯正文对照：同样用"图右侧空白带"起手，往左拖回正文（这一路只有我们在画）
      cases.push(['S2-text', { x: Math.round(img[2] + 30), y: Math.round((img[1] + img[3]) / 2) }, { x: Math.round(T.line[0] + 40), y: Math.round((T.line[1] + T.line[3]) / 2) },
        { yWindow: [Math.round(T.line[1] - 40), Math.round(T.line[3] + 40)], xWindow: [Math.round(T.line[0]) - 6, Math.round(T.line[2]) + 6], cols: { bodyL: (T.line[0] + T.line[2]) / 2, bodyR: T.line[0] + 20 }, rows: { lineMid: Math.round((T.line[1] + T.line[3]) / 2) }, line: T, formula: null, img, key: '纯正文' }])
    }
  } else {
    // real：跨行（从正文起手拖过图 / 从图后往左拖）；一次手势顺带量多行（@0=行1 行内公式、@4=行13 三个公式、
    // @5=行15 两个行内公式+两张图、block=块级公式）
    const L1 = lines[0]
    const imgLine = lines.find((L) => L.imgs.length)
    const img = imgLine ? imgLine.imgs[0] : null
    const EXTRA = ['@0', '@4', '@5', 'block']
    if (L1 && img) {
      cases.push(['X-fwd-L1img', { x: Math.round(L1.line[0] + 3), y: Math.round((L1.line[1] + L1.line[3]) / 2) }, { x: Math.round((img[0] + img[2]) / 2), y: Math.round((img[1] + img[3]) / 2) },
        { yWindow: [0, 0], xWindow: [0, 0], cols: {}, rows: {}, extraKeys: EXTRA }])
    }
    const imgLast = imgLine && imgLine.imgs.length ? imgLine.imgs[imgLine.imgs.length - 1] : null
    const B = lines.find((L) => L.pos === 'block')
    if (imgLast && B) {
      cases.push(['X-back-img2block', { x: Math.round(imgLast[2] + 26), y: Math.round((imgLast[1] + imgLast[3]) / 2) }, { x: Math.round(B.line[0] + 30), y: Math.round((B.line[1] + B.line[3]) / 2) },
        { yWindow: [0, 0], xWindow: [0, 0], cols: {}, rows: {}, extraKeys: EXTRA }])
    }
  }
  for (const [label, from, to, meta] of cases) await holdDrag(label, from, to, meta)
  fs.writeFileSync(path.join(OUTDIR, `selstyle122-${MODE}-${TAG}.json`), JSON.stringify(out, null, 1))
  log(`\n# 证据 JSON: tmp/shots-121/selstyle122-${MODE}-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
