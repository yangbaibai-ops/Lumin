'use strict'
/**
 * 第一百二十四轮 · 复现用户手势（**源码显形 + 在源码上按下拖动**）并逐帧给**三层证据**：
 *   ① 模型 `selection.from/to/empty` 及其**所属块**（是否落进上一段落）；
 *   ② 原生 `getSelection()` 的 anchor/focus 节点与偏移 + 所属块；
 *   ③ 我们算出的锚点/头（`data-img-drag-live` 的 anchor|head|from|to）+ 每条带 {l,t,r,b}。
 * 9 点矩阵：竖直 3（源码字形行中部 / 该行盒上方 / 下方空白）× 水平 3（左 / 中 / 右）。
 * 用法：node tmp/sel-anchor-124.js <port> <tag> [more]
 */
const fs = require('fs')
const path = require('path')
const { decodePng, paperColor, rowRuns } = require('./png-util.js')

const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const MODE = process.argv[4] || 'matrix'
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
  const mouse = (t, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type: t, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 320) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }

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
      /** 文档结构：每个文本块的真实区间（DOM 元素另存 __P.els，不可序列化） */
      blocks() {
        const st = window.__vt.ed().state
        const els = [...document.querySelectorAll('.ProseMirror > *')]
        window.__P.els = []
        const out = []
        let bi = -1
        st.doc.forEach((node, offset) => {
          if (!node.isTextblock) return
          bi++
          const el = els[bi] || null
          if (el) window.__P.els.push(el)
          out.push({ i: bi, from: offset + 1, to: offset + node.nodeSize - 1, text: node.textContent.slice(0, 18),
            rect: el ? R(el.getBoundingClientRect()) : null })
        })
        return out
      },
      /** 源码片段（显形出来的那一整段原文）的文档区间与逐行矩形 */
      srcSpan() {
        const view = window.__vt.ed().view
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        if (!el) return null
        const rows = [...el.getClientRects()].map(R)
        // 该 span 内的文字节点范围
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let n = null, first = null, last = null
        while ((n = w.nextNode())) { if (!n.length) continue; if (!first) first = n; last = n }
        let s = NaN, e = NaN
        try {
          if (first) { s = view.posAtDOM(first, 0); e = view.posAtDOM(last, last.length) }
        } catch (err) { /* ignore */ }
        return { from: s, to: e, rows, fromAttr: el.getAttribute('data-img-from'), text: (el.textContent || '').slice(0, 20) }
      },
      /** 被图片撑高的那一行（行盒 = 图盒 ∪ 该行文字）与相邻段落的行盒 */
      geom() {
        const ps = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')]
        const pi = ps.findIndex((p) => p.querySelector('[data-img-widget]'))
        const p = ps[pi], prev = ps[pi - 1] || null, next = ps[pi + 1] || null
        const imgs = p ? [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect())) : []
        return { pi, para: p ? R(p.getBoundingClientRect()) : null, prev: prev ? R(prev.getBoundingClientRect()) : null, prevText: prev ? (prev.textContent || '').slice(0, 14) : null, next: next ? R(next.getBoundingClientRect()) : null, imgs }
      },
      /** 逐帧三层证据 */
      frame(anchorBlocks) {
        const view = window.__vt.ed().view
        const st = window.__vt.ed().state
        const s = st.selection
        const d = document.querySelector('.ProseMirror')
        const live = d.getAttribute('data-img-drag-live') || ''
        const lv = live.split('|').map(Number)
        const bands = parse(d.getAttribute('data-sel-band-live'))
        const blk = (pos) => { for (const b of anchorBlocks) if (pos >= b.from && pos <= b.to) return b.i; return null }
        const blkEl = (node) => { const el = node && (node.nodeType === 1 ? node : node.parentElement); if (!el) return null; const els = window.__P.els || []; for (let i = 0; i < els.length; i++) if (els[i] === el || els[i].contains(el)) return i; return null }
        const q = window.getSelection()
        let nat = null
        if (q && q.rangeCount) nat = { anchor: q.anchorNode ? (q.anchorNode.textContent || '').slice(Math.max(0, q.anchorOffset - 6), q.anchorOffset + 6) : null, anchorOff: q.anchorOffset, focus: q.focusNode ? (q.focusNode.textContent || '').slice(Math.max(0, q.focusOffset - 6), q.focusOffset + 6) : null, focusOff: q.focusOffset, aBlk: blkEl(q.anchorNode), fBlk: blkEl(q.focusNode), collapsed: q.isCollapsed }
        return { t: 0, sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), modelAnchor: s.anchor, modelHead: s.head, fromBlk: blk(s.from), toBlk: blk(s.to), live, anchor: Number.isFinite(lv[0]) ? lv[0] : null, head: Number.isFinite(lv[1]) ? lv[1] : null, pFrom: Number.isFinite(lv[2]) ? lv[2] : null, pTo: Number.isFinite(lv[3]) ? lv[3] : null, anchorBlk: Number.isFinite(lv[0]) ? blk(lv[0]) : null, nat, bands, own: d.getAttribute('data-sel-own') }
      }
    }
    return 'ok'
  })()`)

  const G = await json(`window.__P.geom()`)
  let blocks = await json(`window.__P.blocks()`)
  const prevIdx = G.pi - 1
  const curIdx = G.pi
  log(`# 段落：prev(i=${prevIdx})=${JSON.stringify(blocks[prevIdx] && { from: blocks[prevIdx].from, to: blocks[prevIdx].to, rect: blocks[prevIdx].rect, text: blocks[prevIdx].text })}`)
  log(`#        cur(i=${curIdx})=${JSON.stringify(blocks[curIdx] && { from: blocks[curIdx].from, to: blocks[curIdx].to, rect: blocks[curIdx].rect, text: blocks[curIdx].text })}`)
  log(`# 图盒=${JSON.stringify(G.imgs)} 段盒=${JSON.stringify(G.para)}`)

  // 显形源码：点第 2 张图右侧空白带（=`revealed=1` 的既有入口）
  const img2 = G.imgs[G.imgs.length - 1]
  await click(Math.round(img2[2] + 26), Math.round((img2[1] + img2[3]) / 2), 500)
  const S = await json(`window.__P.srcSpan()`)
  blocks = await json(`window.__P.blocks()`)
  log(`# 显形源码区间=[${S && S.from},${S && S.to}) 行矩形=${JSON.stringify(S && S.rows)} text=${JSON.stringify(S && S.text)}`)
  log(`# 显形后 cur(i=${curIdx})=${JSON.stringify({ from: blocks[curIdx].from, to: blocks[curIdx].to, rect: blocks[curIdx].rect })}`)

  const tall = S && S.rows.length ? [Math.min(...S.rows.map((r) => r[1])), Math.max(...S.rows.map((r) => r[3]))] : [G.imgs[0][1], G.imgs[0][3]]
  const lineBox = [Math.min(tall[0], G.imgs[0][1]), Math.max(tall[1], G.imgs[0][3])]
  const rows = (S && S.rows.length ? S.rows : []).slice().sort((a, b) => a[1] - b[1])
  const row0 = rows[0] || [320, lineBox[0], 1340, lineBox[0] + 32]
  log(`# 撑高行盒=[${lineBox[0].toFixed(1)},${lineBox[1].toFixed(1)}] 源码行=${JSON.stringify(rows)}`)

  // 9 点矩阵：竖直 3 × 水平 3
  const midY = Math.round((row0[1] + row0[3]) / 2)
  const vAbove = Math.round(lineBox[0] + 3)
  const vBelow = Math.round(Math.min(lineBox[1] - 3, row0[3] + 26))
  const xs = { 左: Math.round(blocks[curIdx].rect[0] + 22), 中: Math.round((blocks[curIdx].rect[0] + Math.min(blocks[curIdx].rect[2], G.imgs[0][0] - 10)) / 2), 右: Math.round(Math.min(blocks[curIdx].rect[2] - 20, row0[2] - 30)) }
  const vs = { 字形行中部: midY, 行盒上方: vAbove, 下方空白: vBelow }
  log(`# 矩阵：x=${JSON.stringify(xs)} y=${JSON.stringify(vs)}`)

  /** 保证处于"**源码显形且非编辑态**"（用户报障的那个状态）：编辑态下 bandAt 不接管，量出来的不是我们要的场景 */
  const ensureRevealed = async () => {
    for (let k = 0; k < 5; k++) {
      const st = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? { editing: String(el.className).includes('--editing') } : null })()`)
      if (st && !st.editing) return true
      await click(950, 830, 320)
      await sleep(150)
    }
    await click(Math.round(img2[2] + 26), Math.round((img2[1] + img2[3]) / 2), 500)
    return false
  }

  const hold = async (label, from, to, frames = 16) => {
    await click(950, 830, 260)
    await ensureRevealed()
    await mouse('mousePressed', from.x, from.y)
    await sleep(35)
    const fs2 = [await json(`window.__P.frame(${JSON.stringify(blocks.map((b) => ({ i: b.i, from: b.from, to: b.to })))})`)]
    const steps = 10
    for (let k = 1; k <= steps; k++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / steps, from.y + ((to.y - from.y) * k) / steps, { buttons: 1 })
      await sleep(16)
    }
    await sleep(50)
    for (let i = 0; i < frames; i++) { const f = await json(`window.__P.frame(${JSON.stringify(blocks.map((b) => ({ i: b.i, from: b.from, to: b.to })))})`); f.t = i; fs2.push(f); await sleep(11) }
    const img = await shot(`${label}-drag`)
    const mid = fs2[fs2.length - 1]
    await mouse('mouseReleased', to.x, to.y)
    await sleep(450)
    const settled = await json(`window.__P.frame(${JSON.stringify(blocks.map((b) => ({ i: b.i, from: b.from, to: b.to })))})`)
    const paper = paperColor(img)
    const prevRow = blocks[prevIdx].rect
    const rowScan = rowRuns(img, Math.round((prevRow[1] + prevRow[3]) / 2), Math.round(prevRow[0]), Math.round(prevRow[2]), paper)
    const SRC = (typeof S !== 'undefined' && S) ? S : { from: NaN, to: NaN }
    const anchorInSrc = (f) => f.modelAnchor != null && SRC.from <= f.modelAnchor && f.modelAnchor < SRC.to
    const badAnchor = fs2.filter((f) => f.modelAnchor != null && !anchorInSrc(f))
    const badModel = fs2.filter((f) => f.fromBlk === prevIdx || f.toBlk === prevIdx || (f.anchorBlk === prevIdx))
    const badNat = fs2.filter((f) => f.nat && (f.nat.aBlk === prevIdx || f.nat.fBlk === prevIdx))
    const bandTop = mid.bands.length ? Math.min(...mid.bands.map((b) => b[1])) : null
    log(`\n== ${label}  起手(${from.x},${from.y}) → (${to.x},${to.y})`)
    log(`   按下帧: sel=${fs2[0].sel} 模型锚点=${fs2[0].modelAnchor} fromBlk=${fs2[0].fromBlk} toBlk=${fs2[0].toBlk} 原生anchor块=${fs2[0].nat && fs2[0].nat.aBlk} focus块=${fs2[0].nat && fs2[0].nat.fBlk} live=${fs2[0].live}`)
    log(`   末帧:   sel=${mid.sel} 模型锚点=${mid.modelAnchor} 头=${mid.modelHead} fromBlk=${mid.fromBlk} toBlk=${mid.toBlk} anchor=${mid.anchor}(块${mid.anchorBlk}) head=${mid.head} live=${mid.live} 闸=${mid.own}`)
    log(`   带=${JSON.stringify(mid.bands)} 带最小t=${bandTop}  上一段行盒=${JSON.stringify(prevRow)} ⇒ 盖上上一段=${bandTop != null && bandTop < prevRow[3] - 1}`)
    log(`   上一段那一行扫描(拖动期)=${JSON.stringify(rowScan)}`)
    log(`   ★ 锚点不在源码区间[${SRC.from},${SRC.to})的帧=${badAnchor.length}/${fs2.length}${badAnchor.length ? ' ' + JSON.stringify(badAnchor.slice(0, 3).map((f) => ({ t: f.t, sel: f.sel, anchor: f.anchor, fromBlk: f.fromBlk, toBlk: f.toBlk }))) : ''}`)
    log(`   ★ 模型/锚点越界帧=${badModel.length}/${fs2.length}${badModel.length ? ' ' + JSON.stringify(badModel.slice(0, 3).map((f) => ({ t: f.t, sel: f.sel, fromBlk: f.fromBlk, toBlk: f.toBlk, anchorBlk: f.anchorBlk, anchor: f.anchor }))) : ''}`)
    log(`   ★ 原生越界帧=${badNat.length}/${fs2.length}${badNat.length ? ' ' + JSON.stringify(badNat.slice(0, 2).map((f) => ({ t: f.t, sel: f.sel, a: f.nat.aBlk, fblk: f.nat.fBlk, anchorText: f.nat.anchor }))) : ''}`)
    log(`   松手后: sel=${settled.sel} fromBlk=${settled.fromBlk} toBlk=${settled.toBlk}`)
    const uniq = fs2.map((f) => `${f.sel}|fromB${f.fromBlk}|toB${f.toBlk}|aB${f.anchorBlk}|live${f.live}|bands${f.bands.length}`).filter((s, i, a) => i === 0 || s !== a[i - 1])
    log(`   逐帧去重(${uniq.length}/${fs2.length}) ${JSON.stringify(uniq.slice(-6))}`)
    return { label, from, to, frames: fs2, mid, settled, rowScan, badModel: badModel.length, badAnchor: badAnchor.length, badNat: badNat.length, bandTop, prevRow, srcRange: [SRC.from, SRC.to] }
  }

  const out = { tag: TAG, blocks, srcSpan: S, lineBox, matrix: [], rows }
  if (MODE === 'user') {
    // 用户手势：在源码字形行上按下，向右连续拖（复现"选中上面的文字"）
    for (const [vk, vy] of Object.entries(vs)) {
      for (const [hk, hx] of Object.entries(xs)) {
        const label = `U-${vk}-${hk}`
        const tx = hk === '右' ? Math.min(blocks[curIdx].rect[2] - 8, hx + 120) : 1316
        const r = await hold(label, { x: hx, y: vy }, { x: tx, y: vy }, 12)
        out.matrix.push(r)
      }
    }
  } else {
    for (const [vk, vy] of Object.entries(vs)) {
      for (const [hk, hx] of Object.entries(xs)) {
        const label = `M-${vk}-${hk}`
        const r = await hold(label, { x: hx, y: vy }, { x: hx + 150, y: vy }, 10)
        out.matrix.push(r)
      }
    }
  }
  fs.writeFileSync(path.join(OUTDIR, `selanchor124-${TAG}.json`), JSON.stringify(out, null, 1))
  log(`\n# 证据：tmp/shots-121/selanchor124-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
