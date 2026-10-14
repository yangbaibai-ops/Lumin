'use strict'
/**
 * 第一百二十三轮 · B 条：「从后往前选『粗』到『星』，竟把后面的 `a * kb` 也选上」。
 *
 * 用例（真实夹具第 13 行 `下划线不当斜体：$x_1+y_2$；星号不当5加粗：$a*kb$。 坏公式：$\frac12$ 结束。`）：
 *   ① `星` ← `粗`（从后往前、**停在公式之前**）⇒ 灰底右边界必须 ≤ 公式左边界；
 *   ② `星` ← 公式**之后**（越过公式）⇒ 公式那一段必须有灰底，且带高与同排正文一致；
 *   ③ 松手后模型选区不得包含公式；
 *   ④ 同类行（前一行 `下划线不当斜体：$x_1+y_2$；…`）从行尾往左选到行首。
 *
 * 逐帧（Node 侧 11ms 轮询）记：模型 from/to、每条带 {l,t,r,b}、公式区间 [s,e] 与其矩形、
 * **旧口径**命中（`p>=from-1 && p<=to+1`）与**新口径**命中（严格覆盖）各是什么。
 *
 * 用法：node tmp/sel-formula-123.js <port> <tag>
 */
const fs = require('fs')
const path = require('path')
const { decodePng, paperColor, columnRun } = require('./png-util.js')

const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const TMP = process.env.TEMP || 'C:\\Windows\\Temp'
const FIXTURE = TMP + '\\xw-selband-fixture.md'
const OUTDIR = path.join(__dirname, 'shots-121')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(' ') + '\n')

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
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 300) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const sel = () => ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') })()`)

  await ev(`(() => { if (window.__vt) return 1
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 1 })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await ev(`window.__o = window.__vt.files().openPath(${JSON.stringify(FIXTURE)}).then(() => 'ok').catch((e) => 'err:' + e.message); 1`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(1100)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(800)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }

  await ev(`(() => {
    const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]
    const parse = (s) => (s || '').split(';').filter(Boolean).map((t) => { const [l, tp, r, b] = t.split(',').map(Number); return [l, tp, r, b] })
    window.__P = {
      /** 找"星号不当5加粗"那一段：逐字符矩形 + 每颗行内公式的 {rect, 文档区间, 旧/新口径命中} */
      target(mark) {
        const view = window.__vt.ed().view
        const ps = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')]
        const p = ps.find((x) => (x.textContent || '').includes(mark))
        if (!p) return null
        const chars = []
        const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
        let n
        while ((n = w.nextNode())) {
          if (!n.length) continue
          for (let i = 0; i < n.length; i++) {
            const rg = document.createRange()
            rg.setStart(n, i); rg.setEnd(n, i + 1)
            const q = rg.getBoundingClientRect()
            if (q.width > 0.1 && q.height > 0.1) chars.push({ ch: n.textContent[i], x: (q.left + q.right) / 2, y: (q.top + q.bottom) / 2, rect: R(q) })
          }
        }
        const maths = [...p.querySelectorAll('[data-md-math-rendered]')].map((m) => {
          let s = NaN, e = NaN
          try { s = view.posAtDOM(m, 0); const nn = view.state.doc.nodeAt(s); e = s + (nn ? nn.nodeSize : 1) } catch (err) { /* ignore */ }
          return { rect: R(m.getBoundingClientRect()), s, e, tex: (m.textContent || '').slice(0, 10) }
        })
        return { text: (p.textContent || '').slice(0, 40), para: R(p.getBoundingClientRect()), chars, maths }
      },
      frame() {
        const view = window.__vt.ed().view
        const st = window.__vt.ed().state
        const s = st.selection
        const d = document.querySelector('.ProseMirror')
        const bands = parse(d.getAttribute('data-sel-band-live'))
        const ours = parse(d.getAttribute('data-sel-band-ours'))
        const hl = (() => { const h = window.CSS && CSS.highlights && CSS.highlights.get('lumin-img-drag'); if (!h) return []; const o = []; for (const rg of h) for (const r of rg.getClientRects()) o.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]); return o })()
        /** 应用的"负责绘制区间" = 试探区间 ∪ 原生区间（见 paintLiveSel） */
        const live = d.getAttribute('data-img-drag-live')
        const lv = (live || '').split('|').map(Number)
        const pf0 = Number.isFinite(lv[2]) ? lv[2] : s.from
        const pt0 = Number.isFinite(lv[3]) ? lv[3] : s.to
        const q = window.getSelection()
        let nf = NaN, nt = NaN
        if (q && !q.isCollapsed && q.rangeCount) {
          try { const r = q.getRangeAt(0); nf = view.posAtDOM(r.startContainer, r.startOffset); nt = view.posAtDOM(r.endContainer, r.endOffset) } catch (e) { /* ignore */ }
        }
        const pf = Number.isFinite(nf) ? Math.min(pf0, nf) : Math.min(pf0, s.from)
        const pt = Number.isFinite(nt) ? Math.max(pt0, nt) : Math.max(pt0, s.to)
        const overlaps = (a, b) => Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0 && Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0
        const maths = [...document.querySelectorAll('.ProseMirror [data-md-math-rendered]')].map((m) => {
          let p0 = NaN, e0 = NaN
          try { p0 = view.posAtDOM(m, 0); const nn = st.doc.nodeAt(p0); e0 = p0 + (nn ? nn.nodeSize : 1) } catch (err) { /* ignore */ }
          const rect = R(m.getBoundingClientRect())
          return {
            rect, s: p0, e: e0,
            /** 旧口径（±1 位置）会不会把这一整颗公式并进来 */
            oldHit: Number.isFinite(p0) && p0 >= pf - 1 && p0 <= pt + 1,
            /** 新口径（严格覆盖） */
            newHit: Number.isFinite(p0) && pf <= p0 && pt >= e0,
            /** 实际画没画到（带/兜底 与公式矩形有交） */
            painted: [...bands, ...hl].some((b) => overlaps(b, rect)),
            modelCovered: p0 < s.to && e0 > s.from
          }
        })
        const bandMaxRight = bands.length ? Math.max(...bands.map((b) => b[2])) : null
        const bandMinLeft = bands.length ? Math.min(...bands.map((b) => b[0])) : null
        const selInMath = maths.filter((m) => m.modelCovered).length
        return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), own: d.getAttribute('data-sel-own'), live,
          union: [pf, pt], bands, ours, hl, maths, bandMaxRight, bandMinLeft, selInMath }
      }
    }
    return 'ok'
  })()`)

  const T = await json(`window.__P.target('星号不当5加粗')`)
  if (!T) throw new Error('fixture paragraph not found')
  const chOf = (c, nth) => T.chars.filter((k) => k.ch === c)[nth || 0]
  const star = chOf('星')
  const cu = chOf('粗')
  const math2 = T.maths.find((m) => (m.tex || '').replace(/[^a-z*]/g, '') === 'a*kb') || T.maths[1]
  log(`# 目标段 ${JSON.stringify(T.text)}`)
  log(`#   星@${JSON.stringify(star && star.rect)} 粗@${JSON.stringify(cu && cu.rect)}`)
  for (const m of T.maths) log(`#   公式 ${JSON.stringify(m.tex)} 区间=[${m.s},${m.e}) 矩形=${JSON.stringify(m.rect)}`)

  const runCase = async (label, from, to, probeCols) => {
    await click(960, 830, 320)
    await mouse('mousePressed', from.x, from.y)
    await sleep(40)
    const steps = 12
    for (let k = 1; k <= steps; k++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / steps, from.y + ((to.y - from.y) * k) / steps, { buttons: 1 })
      await sleep(16)
    }
    await sleep(60)
    const frames = []
    for (let i = 0; i < 20; i++) { const f = await json(`window.__P.frame()`); f.t = i; frames.push(f); await sleep(11) }
    const img = await shot(`${label}-drag`)
    const mid = await json(`window.__P.frame()`)
    await mouse('mouseReleased', to.x, to.y)
    await sleep(500)
    const settledSel = await sel()
    const settledImg = await shot(`${label}-settled`)
    const settled = await json(`window.__P.frame()`)
    const paper = paperColor(img)
    const paper2 = paperColor(settledImg)
    const cols = {}
    for (const [k, x] of Object.entries(probeCols)) {
      const xi = Math.round(x)
      const yc = Math.round((T.chars[0].rect[1] + T.chars[0].rect[3]) / 2)
      cols[k] = { x: xi, drag: columnRun(img, xi, T.para[1] - 30, T.para[3] + 30, paper), settled: columnRun(settledImg, xi, T.para[1] - 30, T.para[3] + 30, paper2) }
    }
    const rec = { label, from, to, mid, settledSel, settledMaths: settled.maths, leak: { bands: mid.bands.length, own: mid.own }, frames: frames.map((f) => `${f.sel}|own${f.own}|bands${f.bands.length}|minL${f.bandMinLeft}|maxR${f.bandMaxRight}|oldHit${f.maths.filter((m) => m.oldHit).length}|newHit${f.maths.filter((m) => m.newHit).length}|painted${f.maths.filter((m) => m.painted).length}`), cols }
    return rec
  }

  const cases = []
  // ① `星` ← 公式**前一个字符**（`：`；此时模型 to 正好 = 公式起点）⇒ 灰底右边界必须 ≤ 公式左边界
  const before = T.chars.filter((k) => k.rect[2] <= math2.rect[0] + 1).slice(-1)[0] || cu
  cases.push(['B1-starToCu', { x: before.x, y: before.y }, { x: star.x, y: star.y }, { formula: (math2.rect[0] + math2.rect[2]) / 2, bodyPre: (T.para[0] + math2.rect[0]) / 2 }])
  // ② `星` ← 公式之后（越过公式）
  const after = T.chars.filter((k) => k.x > math2.rect[2] + 2)[0] || { x: T.para[2] - 8, y: cu.y }
  cases.push(['B2-starFromAfter', { x: after.x, y: after.y }, { x: star.x, y: star.y }, { formula: (math2.rect[0] + math2.rect[2]) / 2, bodyPre: (T.para[0] + math2.rect[0]) / 2 }])
  // ④ 同类行：前一行（下划线不当斜体）从行尾往左选到行首
  const Tprev = await json(`window.__P.target('下划线不当斜体')`)
  const prevLast = Tprev.chars[Tprev.chars.length - 1]
  const prevFirst = Tprev.chars[0]
  cases.push(['B4-prevLineBack', { x: prevLast.x, y: prevLast.y }, { x: prevFirst.x, y: prevFirst.y }, { formula: (Tprev.maths[0].rect[0] + Tprev.maths[0].rect[2]) / 2, bodyPre: (Tprev.para[0] + Tprev.maths[0].rect[0]) / 2 }])

  const out = { tag: TAG, target: T, prev: { text: Tprev.text, chars: Tprev.chars.length, maths: Tprev.maths }, cases: [] }
  for (const [label, from, to, cols] of cases) {
    const rec = await runCase(label, from, to, cols)
    out.cases.push(rec)
    log(`\n=== ${label}  (${from.x},${from.y}) → (${to.x},${to.y})`)
    log(`    拖动中 sel=${rec.mid.sel} own=${rec.mid.own} 带=${JSON.stringify(rec.mid.bands)} 兜底=${rec.mid.hl.length}`)
    log(`    带 minLeft=${rec.mid.bandMinLeft} maxRight=${rec.mid.bandMaxRight}`)
    for (const m of rec.mid.maths) log(`    公式[${m.s},${m.e}) 矩形=${JSON.stringify(m.rect)} 实际画到=${m.painted} 旧口径命中=${m.oldHit} 新口径命中=${m.newHit} 模型含=${m.modelCovered}`)
    log(`    选区∩公式数=${rec.mid.selInMath} 负责区间=${JSON.stringify(rec.mid.union)}  松手后 sel=${rec.settledSel} 松手后实际画到=${JSON.stringify(rec.settledMaths.map((m) => m.painted))}`)
    for (const [k, v] of Object.entries(rec.cols)) log(`    列 ${k} x=${v.x} 拖动中=${v.drag ? `t${v.drag.top} b${v.drag.bottom} h${v.drag.height}` : 'null'} 松手后=${v.settled ? `t${v.settled.top} b${v.settled.bottom} h${v.settled.height}` : 'null'}`)
    const uniq = rec.frames.filter((s, i, a) => i === 0 || s !== a[i - 1])
    log(`    逐帧去重(${uniq.length}/${rec.frames.length}): ${JSON.stringify(uniq)}`)
    // ① 的关键判据：灰底右边界 vs 公式左边界
    if (label === 'B1-starToCu' && rec.mid.bandMaxRight != null && math2.rect) {
      log(`    ★ 判据①：灰底右边界 ${rec.mid.bandMaxRight} vs 公式左边界 ${math2.rect[0]} ⇒ 差值 ${(math2.rect[0] - rec.mid.bandMaxRight).toFixed(2)}（≥0 = 没盖到公式）`)
    }
  }
  fs.writeFileSync(path.join(OUTDIR, `selformula123-${TAG}.json`), JSON.stringify(out, null, 1))
  log(`\n# 证据：tmp/shots-121/selformula123-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
