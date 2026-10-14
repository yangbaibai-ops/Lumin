'use strict'
/**
 * 松手后（浏览器原生选区）到底画成什么样：程序化设置 DOM 选区（= 原生绘制），
 * 按列逐像素量带的 top/bottom/height，并与候选“行盒”算法对比。
 * 用法：node tmp/native-geom2.js <port> real|math <tag>
 */
const fs = require('fs')
const path = require('path')
const { decodePng, paperColor, DIFF } = require('./png-util.js')

const PORT = process.argv[2] || '9351'
const MODE = process.argv[3] || 'real'
const TAG = process.argv[4] || 'a'
const TMP = process.env.TEMP || 'C:\\Windows\\Temp'
const FIXTURE = MODE === 'real' ? TMP + '\\xw-selband-fixture.md' : TMP + '\\xw-selstyle-math.md'
const OUTDIR = path.join(__dirname, 'shots-121')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(' ') + '\n')

/** 列上游程：纸面/带/墨迹三分类，返回包含 yc 的那段 */
function seg(img, x, y0, y1, paper, yc) {
  const cls = []
  for (let y = y0; y <= y1; y++) {
    const p = img.px(x, y)
    const d = DIFF(p, paper)
    cls.push(d <= 6 ? 0 : p[0] < 150 ? 2 : 1)
  }
  let i = yc - y0
  if (i < 0 || i >= cls.length) return null
  if (cls[i] === 0) {
    let found = -1
    for (let k = 0; k < cls.length; k++) if (cls[k] !== 0) { found = k; break }
    if (found < 0) return null
    i = found
  }
  let a = i
  while (a > 0 && cls[a - 1] !== 0) a--
  let b = i
  while (b < cls.length - 1 && cls[b + 1] !== 0) b++
  const inkRows = cls.slice(a, b + 1).filter((v) => v === 2).length
  return { top: a + y0, bottom: b + y0, height: b - a + 1, inkRows }
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true })
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(r.result.data, 'base64')
    fs.writeFileSync(path.join(OUTDIR, `${TAG}-${name}.png`), buf)
    return decodePng(buf)
  }
  await ev(`(() => { if (window.__vt) return 1
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui') }
    return 1 })()`)
  await ev(`window.__vt.ui().editorMode = 'wysiwyg'`)
  await ev(`window.__o = window.__vt.files().openPath(${JSON.stringify(FIXTURE)}).then(() => 'ok').catch((e) => 'err:' + e.message); 1`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(1200)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 1 })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }

  await ev(`(() => {
    window.__G = {
      inlineBoxes(block) {
        const out = []
        const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
        let n
        while ((n = w.nextNode())) {
          if (!n.length) continue
          const pe = n.parentElement
          if (!pe) continue
          const cs = getComputedStyle(pe)
          const L = parseFloat(cs.lineHeight)
          const rg = document.createRange(); rg.selectNodeContents(n)
          for (const r of rg.getClientRects()) {
            if (r.width <= 0.5 && r.height <= 0.5) continue
            const pad = Number.isFinite(L) && L > r.height ? (L - r.height) / 2 : 0
            out.push({ l: r.left, r: r.right, t: r.top - pad, b: r.bottom + pad, kind: 'text', tag: pe.tagName + '.' + String(pe.className || '').split(' ')[0], math: !!pe.closest('[data-md-math-rendered]'), h: r.height, L })
          }
        }
        for (const el of block.querySelectorAll('img,[data-img-widget],[data-md-math-rendered] span,[data-md-math-block] span')) {
          const cs = getComputedStyle(el)
          if (el.tagName !== 'IMG' && !/inline-block|inline-table/.test(cs.display)) continue
          for (const r of el.getClientRects()) {
            if (r.width <= 0.5 && r.height <= 0.5) continue
            out.push({ l: r.left, r: r.right, t: r.top, b: r.bottom, kind: el.tagName === 'IMG' ? 'img' : 'ib', tag: el.tagName + '.' + String(el.className || '').split(' ')[0], math: !!el.closest('[data-md-math-rendered]'), h: r.height, L: parseFloat(cs.lineHeight) })
          }
        }
        return out
      },
      linesOf(boxes) {
        const L = []
        for (const b of [...boxes].sort((x, y) => x.t - y.t)) {
          let g = L.find((x) => Math.min(x.b, b.b) - Math.max(x.t, b.t) > 0)
          if (!g) { g = { t: b.t, b: b.b, l: b.l, r: b.r, items: [] }; L.push(g) }
          else { g.t = Math.min(g.t, b.t); g.b = Math.max(g.b, b.b); g.l = Math.min(g.l, b.l); g.r = Math.max(g.r, b.r) }
          g.items.push(b)
        }
        return L
      },
      reportOne(bi) {
        const b = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')][bi]
        if (!b) return null
        const q = b.getBoundingClientRect()
        return this.linesOf(this.inlineBoxes(b)).map((g) => {
          const bodyItems = g.items.filter((x) => !x.math && x.kind === 'text')
          const mathItems = g.items.filter((x) => x.math)
          return {
            lineBox: [+g.t.toFixed(2), +g.b.toFixed(2), +(g.b - g.t).toFixed(2)],
            bodyCol: bodyItems.length ? +((Math.min(...bodyItems.map((x) => x.l)) + Math.max(...bodyItems.map((x) => x.r))) / 2).toFixed(1) : null,
            mathCol: mathItems.length ? +((Math.min(...mathItems.map((x) => x.l)) + Math.max(...mathItems.map((x) => x.r))) / 2).toFixed(1) : null,
            mathSpan: mathItems.length ? [+Math.min(...mathItems.map((x) => x.l)).toFixed(2), +Math.max(...mathItems.map((x) => x.r)).toFixed(2)] : null,
            blockRect: [+q.left.toFixed(2), +q.top.toFixed(2), +q.right.toFixed(2), +q.bottom.toFixed(2)],
            imgs: [...b.querySelectorAll('[data-img-widget]')].map((w) => { const r = w.getBoundingClientRect(); return [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)] }),
            items: g.items.map((x) => x.kind + ':' + x.tag + '@' + x.l.toFixed(1) + '..' + x.r.toFixed(1) + '/' + x.t.toFixed(1) + '..' + x.b.toFixed(1) + (x.math ? '(math)' : ''))
          }
        })
      },
      report() {
        const out = []
        for (const [bi] of [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')].entries()) {
          const rows = this.reportOne(bi) || []
          for (const [li, r] of rows.entries()) out.push({ bi, li, blockBox: false, ...r })
        }
        const bm = document.querySelector('.ProseMirror [data-md-math-block]')
        if (bm) {
          const g = this.linesOf(this.inlineBoxes(bm))
          for (const q of g) out.push({ bi: 'block', li: 0, blockBox: true, lineBox: [+q.t.toFixed(2), +q.b.toFixed(2), +(q.b - q.t).toFixed(2)], bodyCol: null, mathCol: +((q.l + q.r) / 2).toFixed(1), mathSpan: [+q.l.toFixed(2), +q.r.toFixed(2)], items: q.items.map((x) => x.kind + ':' + x.tag + '@' + x.l.toFixed(1) + '..' + x.r.toFixed(1) + '/' + x.t.toFixed(1) + '..' + x.b.toFixed(1)) })
        }
        return out
      },
      selectPara(bi) {
        const b = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')][bi]
        if (!b) return null
        const rg = document.createRange(); rg.selectNodeContents(b)
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg)
        return 1
      },
      selectBlock() {
        const b = document.querySelector('.ProseMirror [data-md-math-block]')
        if (!b) return null
        const rg = document.createRange(); rg.selectNodeContents(b)
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg)
        return 1
      },
      clearSel() { window.getSelection().removeAllRanges(); return 1 },
      modelSel() { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') }
    }
    return 1
  })()`)

  const rep = await json(`window.__G.report()`)
  const out = { tag: TAG, mode: MODE, rows: [] }
  for (const row0 of rep) {
    await ev(row0.blockBox ? `window.__G.selectBlock()` : `window.__G.selectPara(${row0.bi})`)
    await sleep(240)
    let row = row0
    if (!row0.blockBox) {
      const one = await json(`window.__G.reportOne(${row0.bi})`)
      const m = one && one[row0.li]
      if (m) row = { ...row0, ...m }
    }
    const name = 'nat-' + (row0.blockBox ? 'block' : row0.bi) + '-' + row0.li
    const img = await shot(name)
    const paper = paperColor(img)
    const [lt, lb] = row.lineBox
    const y0 = Math.max(0, Math.round(lt - 70))
    const y1 = Math.min(img.h - 1, Math.round(lb + 70))
    const yc = Math.round((lt + lb) / 2)
    const bodySeg = row.bodyCol != null ? seg(img, Math.round(row.bodyCol), y0, y1, paper, yc) : null
    const mathSeg = row.mathCol != null ? seg(img, Math.round(row.mathCol), y0, y1, paper, yc) : null
    const rec = { ...row, paper, modelSel: await ev(`window.__G.modelSel()`), bodySeg, mathSeg,
      dBody: bodySeg ? +(bodySeg.height - row.lineBox[2]).toFixed(2) : null,
      dMath: mathSeg ? +(mathSeg.height - row.lineBox[2]).toFixed(2) : null }
    out.rows.push(rec)
    log(`\n# 段落${row0.bi}/${row0.li} 候选行盒=[${lt},${lb}] h=${row.lineBox[2]} 选区=${rec.modelSel} 块盒=${JSON.stringify(row.blockRect || null)}`)
    log(`   图=${JSON.stringify(row.imgs || null)} 公式x范围=${JSON.stringify(row.mathSpan || null)}`)
    log(`   正文列 x=${row.bodyCol} → 实测 t${bodySeg && bodySeg.top} b${bodySeg && bodySeg.bottom} h${bodySeg && bodySeg.height} (Δ候选 ${rec.dBody}) | 公式列 x=${row.mathCol} → 实测 t${mathSeg && mathSeg.top} b${mathSeg && mathSeg.bottom} h${mathSeg && mathSeg.height} (Δ候选 ${rec.dMath})`)
  }
  fs.writeFileSync(path.join(OUTDIR, `nativegeom-${MODE}-${TAG}.json`), JSON.stringify(out, null, 1))
  await ev(`window.__G.clearSel()`)
  log(`\n# JSON: tmp/shots-121/nativegeom-${MODE}-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
