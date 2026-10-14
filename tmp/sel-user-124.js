'use strict'
/**
 * 第一百二十四轮 · 用户手势（**源码显形 + 在源码区域按下拖动**）逐帧三层证据 + 9 点矩阵。
 * 每个测试点前**重开夹具**（保证"显形且非编辑态"这个用户状态可复现），再点图片右侧空白带显形。
 * 用法：node tmp/sel-user-124.js <port> <tag> [matrix]
 */
const fs = require('fs')
const path = require('path')
const { decodePng, paperColor, rowRuns } = require('./png-util.js')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const DO_MATRIX = process.argv[4] === 'matrix'
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

  await ev(`(() => {
    const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]
    const parse = (s) => (s || '').split(';').filter(Boolean).map((t) => { const [l, tp, r, b] = t.split(',').map(Number); return [l, tp, r, b] })
    window.__P = {
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
          out.push({ i: bi, from: offset + 1, to: offset + node.nodeSize - 1, text: node.textContent.slice(0, 16), rect: el ? R(el.getBoundingClientRect()) : null })
        })
        return out
      },
      state() {
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        const s = window.__vt.ed().state.selection
        return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), anchor: s.anchor, head: s.head,
          revealed: el ? { kind: el.getAttribute('data-img-kind'), editing: String(el.className).includes('--editing'), rows: [...el.getClientRects()].map(R), text: (el.textContent || '').slice(0, 14) } : null }
      },
      geom() {
        const ps = [...document.querySelectorAll('.ProseMirror p')]
        const p = ps.find((x) => x.querySelector('[data-img-widget]'))
        const w = [...p.querySelectorAll('[data-img-widget]')]
        const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3)
        const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length))
        return { para: R(p.getBoundingClientRect()), text: R(rg.getBoundingClientRect()), imgs: w.map((x) => R(x.getBoundingClientRect())) }
      },
      frame(bk) {
        const d = document.querySelector('.ProseMirror')
        const s = window.__vt.ed().state.selection
        const live = d.getAttribute('data-img-drag-live') || ''
        const lv = live.split('|').map(Number)
        const bands = parse(d.getAttribute('data-sel-band-live'))
        const blk = (pos) => { for (const b of bk) if (pos >= b.from && pos <= b.to) return b.i; return null }
        return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), modelAnchor: s.anchor, modelHead: s.head,
          fromBlk: blk(s.from), toBlk: blk(s.to), live, pFrom: lv[2], pTo: lv[3], bands, own: d.getAttribute('data-sel-own') }
      }
    }
    return 'ok'
  })()`)

  const away = { x: 1200, y: 820 }
  const reload = async () => {
    await ev(`window.__o = window.__vt.files().openPath(${JSON.stringify(FIXTURE)}).then(() => 'ok').catch((e) => 'err:' + e.message); 1`, false)
    for (let i = 0; i < 30; i++) { await sleep(300); if (await ev(`(window.__vt.files().content || '').length`)) break }
    for (let i = 0; i < 30; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(300) }
    await sleep(500)
  }
  const reveal = async () => {
    const g = await json(`window.__P.geom()`)
    const w = g.imgs[0]
    await click(Math.round(w[2] + 26), Math.round((w[1] + w[3]) / 2), 520)
    let st = await json(`window.__P.state()`)
    if (!st.revealed || st.revealed.editing) {
      // 换到图右侧另一条 y（行盒上下空白）再试
      for (const dy of [-40, 40, -70, 70]) {
        await click(Math.round(w[2] + 26), Math.round((w[1] + w[3]) / 2 + dy), 420)
        st = await json(`window.__P.state()`)
        if (st.revealed && !st.revealed.editing) break
      }
    }
    return { g, st }
  }

  const run = async (label, from, to, frames = 14) => {
    await reload()
    const rv = await reveal()
    const bk = await json(`window.__P.blocks()`)
    const curPos = await ev(`(() => { const v = window.__vt.ed().view; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); try { return v.posAtDOM(p, 0) } catch (e) { return -1 } })()`)
    const idx = bk.findIndex((bl) => bl.from <= curPos && curPos <= bl.to)
    const prevIdx = idx - 1
    const S = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return null; const v = window.__vt.ed().view; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n = null, f = null, l = null; while ((n = w.nextNode())) { if (!n.length) continue; if (!f) f = n; l = n } let s = NaN, e = NaN; try { if (f) { s = v.posAtDOM(f, 0); e = v.posAtDOM(l, l.length) } } catch (err) {} return { from: s, to: e, rows: [...el.getClientRects()].map((x) => [+x.left.toFixed(2), +x.top.toFixed(2), +x.right.toFixed(2), +x.bottom.toFixed(2)]) } })()`)
    if (!S) return { label, skipped: 'no-reveal' }
    await mouse('mousePressed', from.x, from.y)
    await sleep(35)
    const fr = [await json(`window.__P.frame(${JSON.stringify(bk.map((b) => ({ i: b.i, from: b.from, to: b.to })))})`)]
    const steps = 10
    for (let k = 1; k <= steps; k++) { await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / steps, from.y + ((to.y - from.y) * k) / steps, { buttons: 1 }); await sleep(16) }
    await sleep(45)
    for (let i = 0; i < frames; i++) { const f = await json(`window.__P.frame(${JSON.stringify(bk.map((b) => ({ i: b.i, from: b.from, to: b.to })))})`); f.t = i; fr.push(f); await sleep(11) }
    const img = await shot(`${label}-drag`)
    const mid = fr[fr.length - 1]
    await mouse('mouseReleased', to.x, to.y)
    await sleep(420)
    const settled = await json(`window.__P.frame(${JSON.stringify(bk.map((b) => ({ i: b.i, from: b.from, to: b.to })))})`)
    const paper = paperColor(img)
    const prev = bk[idx - 1]
    const prevRowScan = prev ? rowRuns(img, Math.round((prev.rect[1] + prev.rect[3]) / 2), Math.round(prev.rect[0]), Math.round(prev.rect[2]), paper) : []
    const inSrc = (p) => S.from <= p && p < S.to
    const badModel = fr.filter((f) => f.fromBlk === prevIdx || f.toBlk === prevIdx)
    const badAnchor = fr.filter((f) => !inSrc(f.modelAnchor))
    const bandTop = mid.bands.length ? Math.min(...mid.bands.map((b) => b[1])) : null
    const rec = { label, from, to, srcRange: [S.from, S.to], srcRows: S.rows, revealedRows: S.rows, blocks: bk.map((b) => ({ i: b.i, from: b.from, to: b.to, text: b.text, rect: b.rect })), prevIdx,
      pressFrame: fr[0], mid, settled, bands: mid.bands, bandTop, prevRect: prev ? prev.rect : null, prevRowScan, badModel: badModel.length, badAnchor: badAnchor.length, frames: fr }
    log(`\n== ${label} 起手(${from.x},${from.y}) → (${to.x},${to.y})   [源码区间 ${S.from}-${S.to}) ]`)
    log(`   按下帧 sel=${fr[0].sel} 模型锚点=${fr[0].modelAnchor}(在源码内=${inSrc(fr[0].modelAnchor)}) fromBlk=${fr[0].fromBlk} toBlk=${fr[0].toBlk} live=${fr[0].live}`)
    log(`   末帧   sel=${mid.sel} 锚点=${mid.modelAnchor} 头=${mid.modelHead} 闸=${mid.own} 带=${JSON.stringify(mid.bands)}`)
    log(`   上一段(i=${prevIdx}) 行盒=${JSON.stringify(prev ? prev.rect : null)} 带最小t=${bandTop} ⇒ 盖上上一段=${bandTop != null && prev && bandTop < prev.rect[3] - 1}`)
    log(`   上一段行扫描=${JSON.stringify(prevRowScan).slice(0, 160)}`)
    log(`   ★ 模型越界帧=${badModel.length}/${fr.length}  锚点不在源码区间帧=${badAnchor.length}/${fr.length}${badAnchor.length ? ' ' + JSON.stringify(badAnchor.slice(0, 2).map((f) => ({ t: f.t, sel: f.sel, anchor: f.modelAnchor }))) : ''}`)
    log(`   松手后 sel=${settled.sel} 锚点=${settled.modelAnchor}`)
    return rec
  }

  const out = { tag: TAG, cases: [] }
  const g0 = await json(`window.__P.geom()`)
  log(`# 段落盒=${JSON.stringify(g0.para)} 文字行=${JSON.stringify(g0.text)} 图=${JSON.stringify(g0.imgs)}`)
  if (!DO_MATRIX) {
    // 用户手势：源码区域**字形行左侧空白**按下，向右连续拖过整段源码
    const r = await run('user-gesture', { x: 342, y: 372 }, { x: 1310, y: 372 }, 16)
    out.cases.push(r)
    if (r && !r.skipped) {
      fs.copyFileSync(path.join(OUTDIR, `${TAG}-user-gesture-drag.png`), path.join(__dirname, 'sel-above-user-gesture-fixed.png'))
      log(`# 截图 → tmp/sel-above-user-gesture-fixed.png`)
    }
  } else {
    const rows = [['行中部', 372], ['行盒上方', 358], ['下方空白', 470]]
    const xs = [['左', 342], ['中', 640], ['右', 1000]]
    for (const [vk, vy] of Object.entries(rows)) {
      for (const [hk, hx] of Object.entries(xs)) {
        const rec = await run(`M-${vk}-${hk}`, { x: hx, y: vy }, { x: 1310, y: vy }, 10)
        out.cases.push(rec)
      }
    }
  }
  fs.writeFileSync(path.join(OUTDIR, `seluser124-${TAG}.json`), JSON.stringify(out, null, 1))
  const ok = out.cases.filter((c) => c && !c.skipped)
  log(`\n# 汇总：有效用例 ${ok.length}/${out.cases.length}；模型越界帧合计=${ok.reduce((a, c) => a + c.badModel, 0)}；锚点越界帧合计=${ok.reduce((a, c) => a + c.badAnchor, 0)}；带上盖上一段的用例=${ok.filter((c) => c.bandTop != null && c.prevRect && c.bandTop < c.prevRect[3] - 1).length}`)
  log(`# 证据：tmp/shots-121/seluser124-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
