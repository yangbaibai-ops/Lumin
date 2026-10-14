'use strict'
/**
 * 第一百二十六轮 · 松手后选区被截断：三类跨越（表格 / 公式 / 图片）逐帧 live vs settled。
 * 每次记：① `data-img-drag-live`（试探区间）+ 模型 from/to/type；
 *         ② 松手后模型 from/to/**type** + `data-img-settle-fallback` + 原生 DOM 选区；
 *         ③ **丢掉的区间**（live ∖ settled）及其落在哪个节点上（`doc.resolve(p).parent.type.name`）。
 * 用法：node tmp/settle-126.js <port> <tag> [case]
 */
const fs = require('fs')
const path = require('path')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const ONLY = process.argv[4] || 'all'
const TMP = process.env.TEMP || 'C:\\Windows\\Temp'
const FIXTURE = TMP + '\\xw-selband-fixture.md'
const OUTDIR = path.join(__dirname, 'shots-121')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(' ') + '\n')

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true })
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
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
    fs.writeFileSync(path.join(OUTDIR, `${TAG}-${name}.png`), Buffer.from(r.result.data, 'base64'))
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
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); return 'ok' })()`)
  await ev(`window.__o = window.__vt.files().openPath(${JSON.stringify(FIXTURE)}).then(() => 'ok').catch((e) => 'err:' + e.message); 1`, false)
  for (let i = 0; i < 30; i++) { await sleep(300); if (await ev(`(window.__vt.files().content || '').length`)) break }
  for (let i = 0; i < 30; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(300) }
  await sleep(600)

  await ev(`(() => {
    const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]
    const parse = (s) => (s || '').split(';').filter(Boolean).map((t) => { const [l, tp, r, b] = t.split(',').map(Number); return [l, tp, r, b] })
    window.__P = {
      /** 文档里的"地标"：表格 / 行内公式 / 块级公式 / 图片 / 段落 的区间与屏幕点 */
      marks() {
        const st = window.__vt.ed().state
        const v = window.__vt.ed().view
        const out = { blocks: [], tables: [], mathInline: [], mathBlock: [], imgs: [] }
        let i = -1
        st.doc.forEach((node, off) => {
          if (node.isTextblock) { i++; out.blocks.push({ i, name: node.type.name, from: off + 1, to: off + node.nodeSize - 1, text: node.textContent.slice(0, 12) }) }
          if (node.type.name === 'table') out.tables.push({ from: off, to: off + node.nodeSize, rows: node.childCount, text: node.textContent.slice(0, 16) })
        })
        for (const el of document.querySelectorAll('.ProseMirror [data-md-math-rendered]')) {
          let p = NaN; try { p = v.posAtDOM(el, 0) } catch (e) { /* ignore */ }
          const st2 = st.doc.nodeAt(p); out.mathInline.push({ from: p, to: p + (st2 ? st2.nodeSize : 1), rect: R(el.getBoundingClientRect()), text: (el.textContent || '').slice(0, 8) })
        }
        for (const el of document.querySelectorAll('.ProseMirror [data-md-math-block]')) {
          let p = NaN; try { p = v.posAtDOM(el, 0) } catch (e) { /* ignore */ }
          out.mathBlock.push({ from: p, rect: R(el.getBoundingClientRect()) })
        }
        for (const el of document.querySelectorAll('.ProseMirror [data-img-widget]')) {
          out.imgs.push({ from: Number(el.getAttribute('data-img-from')), rect: R(el.getBoundingClientRect()) })
        }
        for (const el of document.querySelectorAll('.ProseMirror table')) out.tables.push({ rect: R(el.getBoundingClientRect()) })
        return out
      },
      /** 用"文本起头"定位元素，然后在该元素前两个字上取点（拖动起/终点用） */
      ptText(prefix, frac) {
        const cands = [...document.querySelectorAll('.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror pre, .ProseMirror li, .ProseMirror td, .ProseMirror th')]
        const hits = cands.filter((x) => (x.textContent || '').indexOf(prefix) >= 0)
        if (!hits.length) return null
        // 取"最小的命中元素"（避免命中祖先）
        const el = hits.reduce((a, b) => ((a.textContent || '').length <= (b.textContent || '').length ? a : b))
        el.scrollIntoView({ block: 'center' })
        const full = el.textContent || ''
        const off = Math.max(0, Math.min(full.length - 1, full.indexOf(prefix) + Math.round((frac || 0) * prefix.length)))
        // 把 full 的偏移映射到具体文本节点（KaTeX/高亮会把文本拆成很多节点）
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let acc = 0
        let n = null
        let local = 0
        while ((n = w.nextNode())) {
          const L = (n.textContent || '').length
          if (off < acc + L) { local = off - acc; break }
          acc += L
        }
        if (!n) return null
        const L = (n.textContent || '').length
        const a = Math.max(0, Math.min(L - 1, local))
        const rg = document.createRange()
        rg.setStart(n, a)
        rg.setEnd(n, Math.min(L, a + 1))
        const r = rg.getBoundingClientRect()
        if (!(r.width || r.height)) {
          const pr = el.getBoundingClientRect()
          return [Math.round(pr.left + 20), Math.round((pr.top + pr.bottom) / 2)]
        }
        return [Math.round(r.left + (r.width || 4) / 2), Math.round((r.top + r.bottom) / 2)]
      },
      /** 按"地标名"取点（矩形法，不依赖文本节点切分） */
      ptMark(kind, frac) {
        const q = (sel) => [...document.querySelectorAll(sel)]
        let el = null
        if (kind === 'heading') el = q('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3')[0]
        else if (kind === 'codeblock') {
          const kids = q('.ProseMirror > *')
          const ti = kids.findIndex((x) => x.querySelector && x.querySelector('table'))
          el = (ti >= 0 ? kids[ti + 1] : null) || q('.ProseMirror pre').find((x) => (x.textContent || '').includes('flowchart')) || kids[kids.length - 1]
        }
        else if (kind === 'imgpara') {
          const p = q('.ProseMirror p').find((x) => x.querySelector('[data-img-widget]'))
          el = p || null
        }
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        const x = Math.round(r.left + Math.max(6, r.width * (frac == null ? 0.5 : frac)))
        const y = Math.round((r.top + r.bottom) / 2)
        return [x, y]
      },
      /** 某文档位置附近的可点坐标（用 Range 客户端矩形） */
      caret(pos) {
        const v = window.__vt.ed().view
        try {
          const c = v.domAtPos(pos)
          const rg = document.createRange()
          rg.setStart(c.node, c.offset); rg.setEnd(c.node, c.offset)
          const r = rg.getBoundingClientRect()
          if (r.width || r.height) return [Math.round(r.left), Math.round((r.top + r.bottom) / 2)]
        } catch (e) { /* ignore */ }
        return null
      },
      frame() {
        const v = window.__vt.ed().view
        const s = window.__vt.ed().state.selection
        const d = document.querySelector('.ProseMirror')
        const live = d.getAttribute('data-img-drag-live') || ''
        const lv = live.split('|').map(Number)
        const bands = parse(d.getAttribute('data-sel-band-live'))
        let nf = NaN, nt = NaN
        try { const q = window.getSelection(); if (q && q.rangeCount && !q.isCollapsed) { const r = q.getRangeAt(0); nf = v.posAtDOM(r.startContainer, r.startOffset); nt = v.posAtDOM(r.endContainer, r.endOffset) } } catch (e) { /* ignore */ }
        return { sel: s.from + '-' + s.to, empty: s.empty, type: (s.jsonID || (s.constructor && s.constructor.name) || '?'),
          live, lFrom: lv[2], lTo: lv[3], bands: bands.length, own: d.getAttribute('data-sel-own'),
          nat: [Number.isFinite(nf) ? Math.min(nf, nt) : null, Number.isFinite(nf) ? Math.max(nf, nt) : null] }
      },
      /** live ∖ settled 的区间 + 落在哪个节点 */
      dropped(liveF, liveT, setF, setT) {
        const st = window.__vt.ed().state
        const kind = (p) => { try { const r = st.doc.resolve(Math.max(0, Math.min(p, st.doc.content.size))); return r.parent.type.name + (r.parent.type.name === 'paragraph' ? '' : '/' + (r.nodeAfter ? r.nodeAfter.type.name : '-')) } catch (e) { return '?' } }
        const parts = []
        if (liveF < setF) parts.push({ from: liveF, to: Math.min(setF, liveT), where: kind(liveF) + '→' + kind(Math.min(setF, liveT)) })
        if (liveT > setT) parts.push({ from: Math.max(setT, liveF), to: liveT, where: kind(Math.max(setT, liveF)) + '→' + kind(liveT) })
        return parts.filter((x) => x.to > x.from)
      }
    }
    return 'ok'
  })()`)

  const M = await json(`window.__P.marks()`)
  log(`# 地标：块=${JSON.stringify(M.blocks.map((b) => ({ i: b.i, name: b.name, from: b.from, to: b.to, t: b.text })))}`)
  log(`# 表格=${JSON.stringify(M.tables)}`)
  log(`# 行内公式=${JSON.stringify(M.mathInline.slice(0, 6))}`)
  log(`# 块级公式=${JSON.stringify(M.mathBlock)}`)
  log(`# 图片=${JSON.stringify(M.imgs)}`)

  const away = { x: 1210, y: 850 }
  const run = async (label, from, to, holdFrames = 12) => {
    await click(away.x, away.y, 300)
    if (label.startsWith('table')) { await sleep(100) }
    await mouse('mousePressed', from.x, from.y)
    await sleep(30)
    const frames = [await json(`window.__P.frame()`)]
    for (let k = 1; k <= 14; k++) { await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / 14, from.y + ((to.y - from.y) * k) / 14, { buttons: 1 }); await sleep(14) }
    for (let i = 0; i < holdFrames; i++) { const f = await json(`window.__P.frame()`); f.t = i; frames.push(f); await sleep(11) }
    const mid = frames[frames.length - 1]
    await shot(`${label}-live`)
    if (label === 'table-fwd') { try { fs.copyFileSync(path.join(OUTDIR, `${TAG}-${label}-live.png`), path.join(__dirname, 'cross-table-live.png')) } catch (e) { /* ignore */ } }
    await mouse('mouseReleased', to.x, to.y)
    await sleep(650)
    await shot(`${label}-settled`)
    const settled = await json(`window.__P.frame()`)
    if (label === 'table-fwd') { try { fs.copyFileSync(path.join(OUTDIR, `${TAG}-${label}-settled.png`), path.join(__dirname, 'cross-table-settle.png')) } catch (e) { /* ignore */ } }
    const post = await json(`(() => { const d = document.querySelector('.ProseMirror'); const s = window.__vt.ed().state.selection; return { fallback: d.getAttribute('data-img-settle-fallback'), settleIn: d.getAttribute('data-img-settle-in'), settleIn: d.getAttribute('data-img-settle-in'), band: document.querySelectorAll('.sel-band > div').length, own: d.getAttribute('data-sel-own'), type: (s.jsonID || s.constructor.name), text: window.__vt.ed().state.doc.textBetween(s.from, s.to, '\\n').slice(0, 40) } })()`)
    const dropped = (mid.lFrom != null && mid.lTo != null) ? await json(`window.__P.dropped(${mid.lFrom}, ${mid.lTo}, ${settled.sel.split('-')[0]}, ${settled.sel.split('-')[1]})`) : []
    const same = mid.lFrom === Number(settled.sel.split('-')[0]) && mid.lTo === Number(settled.sel.split('-')[1])
    const rec = { label, from, to, mid, settled, post, dropped, same, frames: frames.map((f) => `${f.sel}${f.empty ? 'E' : ''}|${f.type}|live${f.lFrom}-${f.lTo}|nat${JSON.stringify(f.nat)}|带${f.bands}|闸${f.own}`) }
    log(`\n== ${label}  (${from.x},${from.y}) → (${to.x},${to.y})`)
    log(`   拖动中: live=[${mid.lFrom},${mid.lTo}] 模型=${mid.sel} 原生=${JSON.stringify(mid.nat)} 带=${mid.bands} 闸=${mid.own}`)
    log(`   松手后: 模型=${settled.sel}${settled.empty ? 'E' : ''} type=${settled.type} 原生=${JSON.stringify(settled.nat)} | fallback=${post.fallback} 残留带=${post.band}`)
    log(`   落定输入: ${post.settleIn}`)
    log(`   落定输入: ${post.settleIn}`)
    log(`   ★ 一致=${same}；丢掉的区间=${JSON.stringify(dropped)}`)
    log(`   逐帧去重(${[...new Set(rec.frames)].length}/${rec.frames.length}): ${JSON.stringify([...new Set(rec.frames)].slice(0, 6))}`)
    return rec
  }

  const out = { tag: TAG, marks: M, cases: [] }
  const B = M.blocks
  const first = B[0], last = B[B.length - 1]
  const findX = (b, frac) => null
  const pt = async (pos) => json(`window.__P.caret(${pos})`)
  // 跨表格：从表格前第一段 → 表格后最后一段（用文档端点算坐标）
  const P = (prefix, frac) => json(`window.__P.ptText(${JSON.stringify(prefix)}, ${frac || 0})`)
  const caseList = []
  const mk = async (label, a1, f1, a2, f2) => {
    const A = await P(a1, f1), Bp = await P(a2, f2)
    if (!A || !Bp) { log(`# ${label} 端点取不到：${a1} / ${a2}`); return }
    caseList.push([label, A, Bp])
  }
  const mk2 = async (label, k1, f1, k2, f2) => {
    const A = await json(`window.__P.ptMark(${JSON.stringify(k1)}, ${f1})`)
    const Bp = await json(`window.__P.ptMark(${JSON.stringify(k2)}, ${f2})`)
    if (!A || !Bp) { log(`# ${label} 端点取不到：${k1} / ${k2}`); return }
    caseList.push([label, A, Bp])
  }
  if (ONLY === 'all' || ONLY === 'table') {
    await mk2('table-fwd', 'heading', 0.9, 'codeblock', 0.05)
    await mk2('table-back', 'codeblock', 0.05, 'heading', 0.9)
  }
  if (ONLY === 'all' || ONLY === 'math') {
    await mk('math-block-fwd', '块级公式', 0.9, 'gyg', 0.5)
    await mk('math-block-back', 'gyg', 0.5, '块级公式', 0.9)
    await mk('math-inline-fwd', '下划线不当斜体', 0.05, '结束', 0.9)
    await mk('math-inline-back', '结束', 0.9, '下划线不当斜体', 0.05)
  }
  if (ONLY === 'all' || ONLY === 'img') {
    await mk2('img-fwd', 'imgpara', 0.02, 'heading', 0.9)
    await mk2('img-back', 'heading', 0.9, 'imgpara', 0.02)
  }
  fs.writeFileSync(path.join(OUTDIR, `settle126-${TAG}.json`), JSON.stringify(out, null, 1))
  for (const [label, a, b] of caseList) {
    if (!a || !b) { log(`\n== ${label} 跳过（坐标取不到）`); continue }
    out.cases.push(await run(label, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }))
  }
  fs.writeFileSync(path.join(OUTDIR, `settle126-${TAG}.json`), JSON.stringify(out, null, 1))
  log(`\n# 证据：tmp/shots-121/settle126-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
