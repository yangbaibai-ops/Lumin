'use strict'
/**
 * 第一百二十五轮 · 两条"拖动期没有选中样式"的逐帧三层证据 + 像素判据。
 *   T 表头：在 thead/th 的文字上按下并拖动（表头有不透明底色 `--panel-2`）
 *   S 刚显形的源码：点图后**立刻**在源码文字上按下并拖动（源码有不透明底色 `--edge`）
 * 逐帧记：① `data-sel-own`（闸）② 我们的带 `data-sel-band-live` + Highlight 兜底 ranges
 *         ③ 原生 `getSelection()` 的 rects（被闸压掉时仍能读到，但像素上看不到）
 *         ④ 目标盒（th 单元盒 / 源码片段盒）与各自 computed 背景色、我们的层 z-index
 * 像素判据：拖动中 vs 松手后 在"文字下方 8px 的带区"取色，必须一致（= 拖动期就有选中样式）。
 * 用法：node tmp/sel-live-125.js <port> <tag> [case]
 */
const fs = require('fs')
const path = require('path')
const { decodePng, paperColor } = require('./png-util.js')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const WHICH = process.argv[4] || 'both'
const TMP = process.env.TEMP || 'C:\\Windows\\Temp'
const FIXTURE = TMP + '\\xw-selband-fixture.md'
const OUTDIR = path.join(__dirname, 'shots-121')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(' ') + '\n')
const px = (img, x, y) => img.px(Math.round(x), Math.round(y))
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

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
      /** 目标元素（表头单元 / 源码片段）几何 + 背景 + 我们的层信息 */
      probe() {
        const d = document.querySelector('.ProseMirror')
        const th = document.querySelector('.ProseMirror th, .ProseMirror thead td')
        const revealed = document.querySelector('.ProseMirror [data-img-revealed]')
        const band = document.querySelector('.sel-band')
        const bgOf = (el) => { if (!el) return null; const c = getComputedStyle(el); return { bg: c.backgroundColor, z: c.zIndex, pos: c.position, pe: c.pointerEvents } }
        const cellText = th ? [...th.querySelectorAll('*')].find((x) => (x.textContent || '').trim().length) : null
        return {
          tokens: (() => { const cs = getComputedStyle(document.documentElement); return { sel: cs.getPropertyValue('--sel').trim(), edge: cs.getPropertyValue('--edge').trim(), panel2: cs.getPropertyValue('--panel-2').trim() } })(),
          domBg: getComputedStyle(d).backgroundColor,
          bandCss: bgOf(band),
          th: th ? { rect: R(th.getBoundingClientRect()), ...bgOf(th), text: (th.textContent || '').slice(0, 8) } : null,
          thText: cellText ? R(cellText.getBoundingClientRect()) : null,
          revealed: revealed ? { rects: [...revealed.getClientRects()].map(R), ...bgOf(revealed), kind: revealed.getAttribute('data-img-kind') } : null,
          parentChildren: [...(d.parentElement ? d.parentElement.children : [])].map((e) => (e.className || e.tagName) + ':' + getComputedStyle(e).zIndex)
        }
      },
      frame() {
        const d = document.querySelector('.ProseMirror')
        const st = window.__vt.ed().state
        const s = st.selection
        const bands = parse(d.getAttribute('data-sel-band-live'))
        const hl = (() => { try { const h = CSS.highlights.get('lumin-img-drag'); if (!h) return []; const o = []; for (const r of h) for (const c of r.getClientRects()) o.push([+c.left.toFixed(2), +c.top.toFixed(2), +c.right.toFixed(2), +c.bottom.toFixed(2)]); return o } catch (e) { return [] } })()
        let nat = []
        try { const q = window.getSelection(); if (q && q.rangeCount) nat = [...q.getRangeAt(0).getClientRects()].map((r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } catch (e) { /* ignore */ }
        const rev = document.querySelector('.ProseMirror [data-img-revealed]')
        return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), type: (s.jsonID || (s.constructor && s.constructor.name) || '?'), own: d.getAttribute('data-sel-own'), miss: d.getAttribute('data-sel-band-miss'), editing: rev ? String(rev.className).includes('--editing') : null,
          bands, hl, nat: nat.slice(0, 14), revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length }
      },
      /** "原生覆盖 − 我们绘制覆盖" 的残差（同一帧内）*/
      residue() {
        const d = document.querySelector('.ProseMirror')
        const bands = parse(d.getAttribute('data-sel-band-live'))
        const hl = (() => { try { const h = CSS.highlights.get('lumin-img-drag'); if (!h) return []; const o = []; for (const r of h) for (const c of r.getClientRects()) o.push([c.left, c.top, c.right, c.bottom]); return o } catch (e) { return [] } })()
        const cover = [...bands, ...hl]
        let nat = []
        try { const q = window.getSelection(); if (q && q.rangeCount) nat = [...q.getRangeAt(0).getClientRects()].map((r) => [r.left, r.top, r.right, r.bottom]) } catch (e) { /* ignore */ }
        const hidden = (r) => {
          const x = (r[0] + r[2]) / 2, y = (r[1] + r[3]) / 2
          const stack = document.elementsFromPoint(x, y)
          for (const el of stack) {
            if (!d.contains(el)) continue
            const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor || '')
            if (!m) continue
            const p = m[1].split(',').map((v) => parseFloat(v))
            const a = p.length > 3 ? p[3] : 1
            if (a > 0.02) return true
          }
          return false
        }
        const stack0 = (() => {
          if (!cover.length) return []
          const r = cover[0]
          return document.elementsFromPoint((r[0] + r[2]) / 2, (r[1] + r[3]) / 2).map((el) => ({
            tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
            inDom: d.contains(el), bg: getComputedStyle(el).backgroundColor, z: getComputedStyle(el).zIndex
          }))
        })()
        const out = []
        for (const r of nat) {
          if (r[2] - r[0] < 1 || r[3] - r[1] < 1) continue
          const cov = cover.some((b) => b[0] <= r[0] + 0.5 && b[2] >= r[2] - 0.5 && Math.min(b[3], r[3]) - Math.max(b[1], r[1]) > 0)
          const vis = cov && !hidden(r)
          out.push({ nat: r.map((v) => +v.toFixed(2)), covered: cov, coveredVisible: vis, hiddenByBg: hidden(r) })
        }
        return { rects: out, stack: stack0, bands: bands.map((b) => b.map((v) => +v.toFixed(2))) }
      }
    }
    return 'ok'
  })()`)
  const info = await json(`window.__P.probe()`)
  log(`# 环境：令牌 sel=${info.tokens.sel} edge=${info.tokens.edge} panel2=${info.tokens.panel2}`)
  log(`# 环境：view.dom 背景=${info.domBg}  .sel-band=${JSON.stringify(info.bandCss)}`)
  log(`# 父层子元素 z-index: ${JSON.stringify(info.parentChildren)}`)
  log(`# 表头: ${JSON.stringify(info.th)}  表头文字=${JSON.stringify(info.thText)}`)
  const away = { x: 1210, y: 840 }
  const out = { tag: TAG, info, cases: [] }

  const headerGlyph = () => json(`(() => { const th = document.querySelector('.ProseMirror th, .ProseMirror thead td, .ProseMirror td'); if (!th) return null; const w = document.createTreeWalker(th, NodeFilter.SHOW_TEXT); let n = null; while ((n = w.nextNode())) { if ((n.textContent || '').trim().length) break } if (!n) return null; const rg = document.createRange(); rg.setStart(n, 0); rg.setEnd(n, Math.min(2, n.length)); const r = rg.getBoundingClientRect(); return [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)] })()`)

  const runDrag = async (label, from, to, samplePts, frames = 14) => {
    await click(away.x, away.y, 320)
    if (label.startsWith('T')) { // 按下前重新量一次表头字形（避免漂移）
      const g = await headerGlyph()
      if (g) { from = { x: Math.round((g[0] + g[2]) / 2), y: Math.round((g[1] + g[3]) / 2) }; to = { x: from.x + Math.min(140, Math.max(60, g[2] - g[0] + 100)), y: from.y } }
    }
    if (label.startsWith('S')) { // 点图显形，然后**立刻**在源码上按下
      const g = await json(`(() => { const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const w = [...p.querySelectorAll('[data-img-widget]')].pop(); return { img: R(w.getBoundingClientRect()) } })()`)
      await click(Math.round(g.img[2] + 26), Math.round((g.img[1] + g.img[3]) / 2), 0)
      await sleep(30) // "立马"：只等一帧
      const rv = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? [...el.getClientRects()].map((r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) : null })()`)
      const glyph = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return null; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n = null; while ((n = w.nextNode())) { if ((n.textContent || '').trim().length) break } if (!n) return null; const rg = document.createRange(); rg.setStart(n, 0); rg.setEnd(n, Math.min(2, n.length)); const r = rg.getBoundingClientRect(); return [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)] })()`)
      if (glyph) { from = { x: Math.round((glyph[0] + glyph[2]) / 2), y: Math.round((glyph[1] + glyph[3]) / 2) }; to = { x: from.x + 150, y: from.y } }
      else if (rv && rv.length) { from = { x: Math.round(rv[0][0] + 12), y: Math.round((rv[0][1] + rv[0][3]) / 2) }; to = { x: Math.round(rv[0][2] - 30), y: from.y } }
    }
    const fs2 = []
    const imgs = []
    await mouse('mousePressed', from.x, from.y); await sleep(28)
    const f0 = await json(`window.__P.frame()`); f0.residue = await json(`window.__P.residue()`); fs2.push(f0)
    for (let k = 1; k <= 10; k++) { await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / 10, from.y + ((to.y - from.y) * k) / 10, { buttons: 1 }); await sleep(15) }
    for (let i = 0; i < frames; i++) {
      const f = await json(`window.__P.frame()`)
      const rs = await json(`window.__P.residue()`)
      f.t = i; f.residue = rs
      fs2.push(f)
      if (i === 2 || i === 6 || i === frames - 1) imgs.push({ i, img: await shot(`${label}-drag-${i}`) })
      await sleep(11)
    }
    const mid = fs2[fs2.length - 1]
    const midImg = imgs[imgs.length - 1].img
    // 采样点用**同一帧**的带/原生矩形派生（避免布局漂移导致取错像素）
    const band0 = mid.bands[0]
    const nat0 = mid.nat[0]
    const derived = []
    if (band0) derived.push({ name: '带中心', x: Math.round((band0[0] + band0[2]) / 2), y: Math.round((band0[1] + band0[3]) / 2) })
    if (band0) derived.push({ name: '带内字形下方4px', x: Math.round((band0[0] + band0[2]) / 2), y: Math.round(band0[3] - 4) })
    if (nat0) derived.push({ name: '原生rect中心', x: Math.round((nat0[0] + nat0[2]) / 2), y: Math.round((nat0[1] + nat0[3]) / 2) })
    if (nat0) derived.push({ name: '原生rect下方40px(空白带)', x: Math.round((nat0[0] + nat0[2]) / 2), y: Math.round(nat0[3] + 40) })
    if (nat0) derived.push({ name: '原生rect上方8px', x: Math.round((nat0[0] + nat0[2]) / 2), y: Math.round(nat0[1] - 8) })
    for (const p of samplePts) derived.push(p)
    const dragSamples = derived.map((p) => ({ ...p, drag: px(midImg, p.x, p.y) }))
    await mouse('mouseReleased', to.x, to.y)
    await sleep(420)
    const settledImg = await shot(`${label}-settled`)
    const settled = await json(`window.__P.frame()`)
    const samples = dragSamples.map((p) => ({ ...p, settled: px(settledImg, p.x, p.y) }))
    samples.forEach((s) => { s.Δ = dist(s.drag, s.settled); s.拖动期有样式 = s.Δ <= 12 })
    const resMax = fs2.map((f) => ((f.residue && f.residue.rects) || []).filter((r) => !r.coveredVisible).length)
    const rec = { label, from, to, frames: fs2, samples, settled, resMax: Math.max(...resMax), resFramesBad: resMax.filter((n) => n > 0).length,
      dragCovered: mid.bands.length, dragOwn: mid.own, dragHl: mid.hl.length, dragNat: mid.nat.length }
    out.cases.push(rec)
    log(`\n== ${label}  (${from.x},${from.y}) → (${to.x},${to.y})`)
    log(`   拖动中末帧: sel=${mid.sel} 闸=${mid.own} 带=${mid.bands.length} 兜底=${mid.hl.length} 原生rects=${mid.nat.length} miss=${mid.miss}`)
    log(`   带=${JSON.stringify(mid.bands).slice(0, 180)}`)
    log(`   原生前 4 条=${JSON.stringify(mid.nat.slice(0, 4))}`)
    log(`   ★ 未被"可见覆盖"的原生 rect 数：最大 ${rec.resMax}，出现该情况的帧 ${rec.resFramesBad}/${fs2.length}`)
    log(`   带中心处元素栈(自上而下): ${JSON.stringify(((mid.residue && mid.residue.stack) || []).slice(0, 6))}`)
    for (const s of samples) log(`   像素(${s.name} x=${s.x} y=${s.y}): 拖动中=${JSON.stringify(s.drag)} 松手后=${JSON.stringify(s.settled)} Δ=${s.Δ} ⇒ 拖动期有样式=${s.拖动期有样式}`)
    const uniq = fs2.map((f) => `${f.sel}|闸${f.own}|带${f.bands.length}|兜底${f.hl.length}|原生${f.nat.length}`).filter((x, i, a) => i === 0 || x !== a[i - 1])
    log(`   逐帧去重(${uniq.length}/${fs2.length}): ${JSON.stringify(uniq.slice(0, 8))}`)
    return rec
  }

  if (WHICH === 'both' || WHICH === 'T') {
    const thT = await json(`(() => { const th = document.querySelector('.ProseMirror th, .ProseMirror thead td'); if (!th) return null; const w = document.createTreeWalker(th, NodeFilter.SHOW_TEXT); let n = null; while ((n = w.nextNode())) { if ((n.textContent || '').trim().length) break } if (!n) return null; const rg = document.createRange(); rg.setStart(n, 0); rg.setEnd(n, Math.min(2, n.length)); const r = rg.getBoundingClientRect(); return [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)] })()`)
    log(`# 表头字形盒=${JSON.stringify(thT)}`)
    const cx = Math.round((thT[0] + thT[2]) / 2)
    const cy = Math.round((thT[1] + thT[3]) / 2)
    const cell = info.th.rect
    await runDrag('T-表头', { x: cx, y: cy }, { x: Math.round(Math.min(cell[2] - 20, cx + 130)), y: cy },
      [{ name: '表头单元中心偏下', x: Math.round((cell[0] + cell[2]) / 2), y: Math.round(cy + 9) },
       { name: '表头字形行', x: cx, y: cy },
       { name: '表体首行', x: Math.round((cell[0] + cell[2]) / 2), y: Math.round(cell[3] + 26) }])
  }
  if (WHICH === 'both' || WHICH === 'S') {
    await click(away.x, away.y, 320)
    const g = await json(`(() => { const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const w = [...p.querySelectorAll('[data-img-widget]')].pop(); const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3); const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length)); return { img: R(w.getBoundingClientRect()), text: R(rg.getBoundingClientRect()) } })()`)
    await runDrag('S-刚显形源码', { x: 0, y: 0 }, { x: 0, y: 0 },
      [{ name: '正文行(源码外)', x: Math.round((g.text[0] + g.text[2]) / 2), y: Math.round((g.text[1] + g.text[3]) / 2) }], 12)
  }
  if (WHICH === 'repeat') {
    const reps = []
    for (let k = 1; k <= 5; k++) {
      const g = await json(`(() => { const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const w = [...p.querySelectorAll('[data-img-widget]')].pop(); const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3); const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length)); return { img: R(w.getBoundingClientRect()), text: R(rg.getBoundingClientRect()) } })()`)
      const r = await runDrag(`S-rep${k}`, { x: 0, y: 0 }, { x: 0, y: 0 }, [{ name: '正文行(源码外)', x: Math.round((g.text[0] + g.text[2]) / 2), y: Math.round((g.text[1] + g.text[3]) / 2) }], 10)
      reps.push({ k, frames: r.frames.map((f) => `${f.sel}|闸${f.own}|带${f.bands.length}|兜底${f.hl.length}|原生${f.nat.length}`), samples: r.samples, ok: r.samples.every((x) => x.拖动期有样式) })
      if (k === 1) { try { fs.copyFileSync(path.join(OUTDIR, `${TAG}-S-rep1-drag-9.png`), path.join(__dirname, 'fresh-source-visible.png')) } catch (e) { /* ignore */ } }
    }
    out.repeat = reps
    log(`\n# 5 次连续复测：` + JSON.stringify(reps.map((r) => ({ k: r.k, ok: r.ok, 帧数: r.frames.length, 去重: [...new Set(r.frames)].length, 首帧: r.frames[0], 末帧: r.frames[r.frames.length - 1] }))))
    // 表头也连做 5 次（第一条报障）
    const treps = []
    for (let k = 1; k <= 5; k++) {
      const r = await runDrag(`T-rep${k}`, { x: 0, y: 0 }, { x: 0, y: 0 }, [], 10)
      treps.push({ k, ok: r.samples.every((x) => x.拖动期有样式) || r.samples.length === 0, samples: r.samples })
      if (k === 1) { try { fs.copyFileSync(path.join(OUTDIR, `${TAG}-T-rep1-drag-9.png`), path.join(__dirname, 'table-header-live.png')) } catch (e) { /* ignore */ } }
    }
    out.trepeat = treps
    log(`# 表头 5 次：` + JSON.stringify(treps.map((r) => ({ k: r.k, ok: r.ok, samples: r.samples.map((x) => `${x.name}:Δ${x.Δ}`) }))))
  }
  fs.writeFileSync(path.join(OUTDIR, `sellive125-${TAG}.json`), JSON.stringify(out, null, 1))
  log(`\n# 证据：tmp/shots-121/sellive125-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
