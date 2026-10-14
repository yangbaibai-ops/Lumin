'use strict'
/**
 * 第一百二十三轮 · 判定「源码上拖动 ⇒ 灰带盖住上一行」是 **(A) 带越界** 还是 **(B) 选区越界**。
 *
 * 手势：点图片右侧空白带 ⇒ 源码显形；**在显形出来的源码文字上按下**，按住向右拖（不松手）。
 * 逐帧（Node 侧 11ms 轮询）记：模型选区 from/to（以及**上一行段落**的文档区间是否被包含）、
 * `data-img-drag-live`、`data-sel-own`、我们**实画**的每条带 {l,t,r,b,h}、原生选区矩形、
 * 以及这一段的**逐行盒**（文本行的并集）、图片盒、显形源码行盒 ⇒ 直接判 A/B。
 *
 * 用法：node tmp/sel-above-123.js <port> <tag>
 */
const fs = require('fs')
const path = require('path')
const { decodePng, paperColor, rowRuns } = require('./png-util.js')

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
  const click = async (x, y, s = 320) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
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

  // ── 页面侧探针
  await ev(`(() => {
    const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]
    const parse = (s) => (s || '').split(';').filter(Boolean).map((t) => { const [l, tp, r, b] = t.split(',').map(Number); return [l, tp, r, b] })
    window.__P = {
      /* 最后一段（含两张图）的几何：文本行盒（并集）、图片盒、段落盒 */
      target() {
        const ps = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')]
        const pi = ps.findIndex((p) => p.querySelector('[data-img-widget]'))
        const p = ps[pi]
        if (!p) return null
        const prev = ps[pi - 1] || null
        const textRects = (el) => { const acc = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) acc.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } return acc }
        const imgs = [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect()))
        return { pi, para: R(p.getBoundingClientRect()), paraText: (p.textContent || '').slice(0, 20), prevPara: prev ? R(prev.getBoundingClientRect()) : null, prevText: prev ? (prev.textContent || '').slice(0, 20) : null, imgs }
      },
      /* 逐帧：模型选区 + 我们画的带 + 原生选区 + 相关行的几何 + 上一行是否被覆盖 */
      frame() {
        const d = document.querySelector('.ProseMirror')
        const view = window.__vt.ed().view
        const st = window.__vt.ed().state
        const s = st.selection
        /** **精确**的段落文档区间：按 doc 结构算（posAtDOM + textContent.length 是不准的）
         *  —— 带行内公式/图片源码的段落 textContent 长度 ≠ 文档长度。 */
        const ranges = []
        st.doc.forEach((node, offset) => {
          if (!node.isTextblock) return
          let img = false
          node.descendants((n) => { if (n.type.name === 'image' || n.type.name === 'mathBlock') img = true; return true })
          ranges.push({ offset, from: offset + 1, to: offset + node.nodeSize - 1, img, text: node.textContent.slice(0, 14) })
        })
        const ps = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')]
        const pi = ps.findIndex((p) => p.querySelector('[data-img-widget]'))
        const p = ps[pi]
        const prev = ps[pi - 1] || null
        const imgRange = ranges.filter((r) => r.img)
        const prevRange = imgRange.length && ranges.indexOf(imgRange[0]) > 0 ? ranges[ranges.indexOf(imgRange[0]) - 1] : null
        const selInPrev = prevRange && !s.empty ? Math.min(prevRange.to, s.to) - Math.max(prevRange.from, s.from) : 0
        const curRange = imgRange[0] || null
        const selInCur = curRange && !s.empty ? Math.min(curRange.to, s.to) - Math.max(curRange.from, s.from) : 0
        const textRects = (el) => { if (!el) return []; const acc = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) acc.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } return acc }
        const rows = (rs) => { const L = []; for (const r of rs.sort((a, b) => a[1] - b[1])) { const g = L.find((x) => Math.min(x[3], r[3]) - Math.max(x[1], r[1]) > 0); if (!g) L.push([...r]); else { g[0] = Math.min(g[0], r[0]); g[2] = Math.max(g[2], r[2]); g[1] = Math.min(g[1], r[1]); g[3] = Math.max(g[3], r[3]) } } return L }
        const curRows = rows(textRects(p))
        const prevRows = rows(textRects(prev))
        const revs = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')].flatMap((el) => [...el.getClientRects()].map((r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]))
        const imgs = p ? [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect())) : []
        const bands = parse(d.getAttribute('data-sel-band-live'))
        const ours = parse(d.getAttribute('data-sel-band-ours'))
        const hl = (() => { const h = window.CSS && CSS.highlights && CSS.highlights.get('lumin-img-drag'); if (!h) return []; const o = []; for (const rg of h) for (const r of rg.getClientRects()) o.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]); return o })()
        const nl = (() => { const q = window.getSelection(); if (!q || q.isCollapsed || !q.rangeCount) return []; return [...q.getRangeAt(0).getClientRects()].map((r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) })()
        /** 判定用：带 vs **上一段的行盒**（用户截图里被盖住的那一行） */
        const prevRow = prevRows.length ? prevRows[prevRows.length - 1] : null
        const bandMinTop = bands.length ? Math.min(...bands.map((b) => b[1])) : null
        const coversPrevRow = bands.some((b) => prevRow && b[1] < prevRow[3] - 1 && b[3] > prevRow[1] + 1)
        /** 我们负责画的片段里，落在上一段区间内的那些（该不该有带） */
        const oursInPrev = ours.filter((o) => prevRow && Math.min(o[3], prevRow[3]) - Math.max(o[1], prevRow[1]) > 0)
        return {
          t: 0, sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), live: d.getAttribute('data-img-drag-live'), own: d.getAttribute('data-sel-own'),
          revs, revText: revs.length ? (document.querySelector('.ProseMirror [data-img-revealed]').textContent || '').slice(0, 16) : null,
          prevRange: prevRange ? [prevRange.from, prevRange.to] : null, curRange: curRange ? [curRange.from, curRange.to] : null,
          selInPrev, selInCur, prevRows, curRows, imgs, bands, ours, hl, nl,
          bandMinTop, prevRow, coversPrevRow, oursInPrevN: oursInPrev.length
        }
      }
    }
    return 'ok'
  })()`)

  const T = await json(`window.__P.target()`)
  log(`# 目标段 pi=${T.pi} para=${JSON.stringify(T.para)} text=${JSON.stringify(T.paraText)} 图=${JSON.stringify(T.imgs)}`)
  log(`# 上一段 ${JSON.stringify(T.prevPara)} text=${JSON.stringify(T.prevText)}`)

  // ── ① 让源码显形：点第 2 张图右侧空白带
  const img2 = T.imgs[T.imgs.length - 1]
  const blank = { x: Math.round(img2[2] + 26), y: Math.round((img2[1] + img2[3]) / 2) }
  await click(blank.x, blank.y, 500)
  const rev0 = await json(`(() => { const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]; if (!els.length) return null; const rs = els.flatMap((e) => [...e.getClientRects()]); const q = rs.length ? [Math.min(...rs.map((r) => r.left)), Math.min(...rs.map((r) => r.top)), Math.max(...rs.map((r) => r.right)), Math.max(...rs.map((r) => r.bottom))] : null; return { count: els.length, rect: q, rows: rs.map((r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]), text: (els[0].textContent || '').slice(0, 24) } })()`)
  log(`# 源码显形: ${JSON.stringify(rev0)}`)
  await shot('above-before-press')

  // ── ② 在**显形出来的源码文字**上按下，按住向右拖（不松手）
  const f0 = await json(`window.__P.frame()`)
  log(`# 按下前: sel=${f0.sel} own=${f0.own} 本段区间=${JSON.stringify(f0.curRange)} 上一段区间=${JSON.stringify(f0.prevRange)}`)
  log(`#   本段行盒=${JSON.stringify(f0.curRows)} 上一段行盒=${JSON.stringify(f0.prevRows)} 源码行=${JSON.stringify(f0.revs)}`)
  // 按在"源码文字所在的那一行"上：默认取最宽的一条；SRCROW=bottom 取最靠下的一条（复现用户截图那一种）
  const pickBottom = process.env.SRCROW === 'bottom'
  const srcRow = rev0 && rev0.rows.length
    ? rev0.rows.slice().sort((a, b) => (pickBottom ? b[3] - a[3] : (b[2] - b[0]) - (a[2] - a[0])))[0]
    : null
  const press = srcRow ? { x: Math.round(srcRow[0] + 18), y: Math.round((srcRow[1] + srcRow[3]) / 2) } : { x: 330, y: 426 }
  const to = { x: press.x + 170, y: press.y }
  log(`# 起手（源码文字行内）: (${press.x},${press.y}) 该源码行=${JSON.stringify(srcRow)}`)
  await mouse('mousePressed', press.x, press.y)
  await sleep(40)
  const steps = 12
  for (let k = 1; k <= steps; k++) {
    await mouse('mouseMoved', press.x + ((to.x - press.x) * k) / steps, press.y, { buttons: 1 })
    await sleep(16)
  }
  await sleep(60)
  const frames = []
  for (let i = 0; i < 22; i++) {
    const f = await json(`window.__P.frame()`)
    f.t = i
    frames.push(f)
    await sleep(11)
  }
  const dragShot = await shot('above-drag')
  const mid = await json(`window.__P.frame()`)
  await mouse('mouseReleased', to.x, to.y)
  await sleep(560)
  const settledShot = await shot('above-settled')
  const settled = await json(`window.__P.frame()`)
  const settledSel = await sel()
  const leak = await json(`({ bands: document.querySelectorAll('.sel-band > div').length, band: document.querySelectorAll('.sel-band').length, own: document.querySelector('.ProseMirror').getAttribute('data-sel-own'), imgSel: document.querySelectorAll('.ProseMirror .img-selected').length, revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length })`)

  const paperD = paperColor(dragShot)
  // 行扫描：源码行中心（看灰带实际盖到哪一行）
  const rowScan = (img, y) => rowRuns(img, Math.round(y), 300, 1100, paperD)
  const scans = {}
  for (const [k, v] of Object.entries({ 源码行: mid.srcRow, 上一行: mid.aboveRowBottom != null && mid.aboveRowBottom ? null : null })) { void k; void v }
  const scanRows = {}
  if (mid.curRows.length) { const sr = mid.curRows[mid.curRows.length - 1]; scanRows['srcRow'] = { y: Math.round((sr[1] + sr[3]) / 2), drag: rowScan(dragShot, (sr[1] + sr[3]) / 2), settled: rowScan(settledShot, (sr[1] + sr[3]) / 2) } }
  if (mid.curRows.length > 1) {
    const up = mid.curRows[mid.curRows.length - 2]
    scanRows['rowAbove'] = { y: Math.round((up[1] + up[3]) / 2), drag: rowScan(dragShot, (up[1] + up[3]) / 2), settled: rowScan(settledShot, (up[1] + up[3]) / 2) }
  }
  if (mid.prevRows.length) {
    const pr = mid.prevRows[mid.prevRows.length - 1]
    scanRows['prevParaRow'] = { y: Math.round((pr[1] + pr[3]) / 2), drag: rowScan(dragShot, (pr[1] + pr[3]) / 2), settled: rowScan(settledShot, (pr[1] + pr[3]) / 2) }
  }

  const out = { tag: TAG, target: T, revealed: rev0, press, to, mid, settled, settledSel, leak, frames, scanRows, paper: paperD }
  fs.writeFileSync(path.join(OUTDIR, `selabove123-${TAG}.json`), JSON.stringify(out, null, 1))

  log(`\n=== 手势：源码上 (${press.x},${press.y}) → (${to.x},${to.y})，未松手`)
  log(`    显形源码行盒=${JSON.stringify(mid.revealed)}  本段行盒=${JSON.stringify(mid.curRows)}`)
  log(`    上一段段落盒=${JSON.stringify(T.prevPara)} 上一段行盒=${JSON.stringify(mid.prevRows)}`)
  log(`    拖动中 sel=${mid.sel} live=${mid.live} own=${mid.own} 上一段区间=${JSON.stringify(mid.prevRange)} 与选区重叠=${mid.selPrevOverlap}`)
  log(`    我们画的带=${JSON.stringify(mid.bands)}`)
  log(`    兜底高亮=${JSON.stringify(mid.hl)} 原生选区矩形数=${mid.nl.length} 图=${JSON.stringify(mid.imgs)}`)
  log(`    带最小 t=${mid.bandMinTop}  上一行盒 b=${mid.aboveRowBottom}  ⇒ 带盖上上一行=${mid.coversAbove}`)
  log(`    松手后 sel=${settledSel} 泄漏=${JSON.stringify(leak)}`)
  for (const [k, v] of Object.entries(scanRows)) log(`    行扫描 ${k} y=${v.y} 拖动中=${JSON.stringify(v.drag)} 松手后=${JSON.stringify(v.settled)}`)
  const uniq = frames.map((f) => `${f.sel}|own${f.own}|bands${f.bands.length}|minTop${f.bandMinTop}|above${f.coversAbove}|prevOv${f.selPrevOverlap}`).filter((s, i, a) => i === 0 || s !== a[i - 1])
  log(`    逐帧去重(${uniq.length}/${frames.length}): ${JSON.stringify(uniq)}`)
  const missOurs = frames.filter((f) => f.ours.length && !f.ours.every((o) => f.bands.some((b) => b[0] <= o[0] + 0.5 && b[2] >= o[2] - 0.5 && Math.min(b[3], o[3]) - Math.max(b[1], o[1]) > 0) || f.hl.some((b) => b[0] <= o[0] + 0.5 && b[2] >= o[2] - 0.5 && Math.min(b[3], o[3]) - Math.max(b[1], o[1]) > 0))).length
  log(`    漏画帧（ours 未被 带∪兜底 盖住）= ${missOurs}/${frames.length}`)
  log(`\n# 截图：tmp/shots-121/${TAG}-above-{before-press,drag,settled}.png  证据：tmp/shots-121/selabove123-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
