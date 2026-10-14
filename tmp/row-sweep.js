'use strict'
/**
 * 扫描：逐窗口宽 × 逐张图（revealed = 第 1/2 段源码）⇒ 打印每个片段的
 *   片段矩形 / 同行图片矩形 / 行盒（由全部行内参与者按竖直重叠分组的并集）/ 覆盖层实际矩形
 * 目的：找到"片段与高图同行、但覆盖层没铺满"的配置（用户实测现象）。
 * 用法：node tmp/row-sweep.js <port> [widths=csv]
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const WIDTHS = (process.argv[3] || '1200,1300,1424,1500,1600,1700,1920').split(',').map(Number)
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-rowfix-fixture.md'
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
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(450)
  }
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(650)
    }
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
  await send('Emulation.clearDeviceMetricsOverride').catch(() => null)
  await dismiss()
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(COPY)}); return 'ok' })()`)
  await sleep(1400)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  for (let i = 0; i < 40; i++) {
    if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break
    await sleep(400)
  }

  const measure = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    // 该段落全部行内参与者的矩形（文字 + 行内/替换元素，含递归），用于还原"行盒"
    const parts = []
    const walk = (parent) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === 3) {
          const tn = child
          if (!tn.length) continue
          const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, tn.length)
          for (const r of Array.from(rg.getClientRects())) if (r.height > 0) parts.push({ k: 'text', ...R(r) })
          continue
        }
        if (child.nodeType !== 1) continue
        const e = child
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const replaced = e.tagName === 'IMG' || e.tagName === 'SVG'
        if (replaced || cs.display.startsWith('inline')) for (const r of Array.from(e.getClientRects())) if (r.height > 0) parts.push({ k: replaced ? 'img' : 'inline', cls: String(e.className).slice(0, 24), ...R(r) })
        if (!replaced && !cs.display.startsWith('inline')) walk(e)
      }
    }
    walk(p)
    // 行盒 = 参与者按竖直重叠分组的并集
    const groups = []
    for (const q of parts.slice().sort((a, b) => a.t - b.t)) {
      const hit = groups.find((g) => q.t < g.b - 0.5 && q.b > g.t + 0.5)
      if (hit) { hit.t = Math.min(hit.t, q.t); hit.b = Math.max(hit.b, q.b); hit.items.push(q) }
      else groups.push({ t: q.t, b: q.b, items: [q] })
    }
    const frags = el ? [...el.getClientRects()].map((f) => {
      const line = groups.find((g) => g.t < f.bottom - 0.5 && g.b > f.top + 0.5) || null
      // 与该片段**同一行**的图片（在组内找 img）
      const lineImgs = line ? line.items.filter((q) => q.k === 'img') : []
      const lineH = line ? +(line.b - line.t).toFixed(2) : null
      return { frag: R(f), line: line ? { t: +line.t.toFixed(2), b: +line.b.toFixed(2), h: lineH } : null, lineImgs, lineTextH: line ? +(line.b - line.t).toFixed(2) : null }
    }) : []
    return {
      innerWidth: innerWidth,
      block: R(p.getBoundingClientRect()),
      revealedFrom: el ? Number(el.getAttribute('data-img-from')) : null,
      revealedLen: el ? (el.textContent || '').length : 0,
      frags,
      imgsAll: [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect())),
      overlayRects: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect()))
    }
  })()`)

  const out = { widths: [], capture: null }
  for (const w of WIDTHS) {
    await ev(`(() => { window.resizeTo(${w}, 955); return 'ok' })()`)
    await sleep(800)
    const entry = { window: w, innerWidth: await ev(`innerWidth`), sources: [] }
    const nWidgets = await ev(`document.querySelectorAll('.ProseMirror [data-img-widget]').length`)
    for (let i = 0; i < Math.min(2, nWidgets); i++) {
      // 先点别处隐藏，再点第 i 张图
      const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
      await click(away.x, away.y)
      const pt = await json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][${i}]; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
      await click(pt.x, pt.y)
      const m = await measure()
      m.widgetIndex = i
      // 判定：每个片段——同行最高项 > 片段高 + 2 时，覆盖层是否覆盖到该行
      m.assessment = m.frags.map((f) => {
        const sameLineMax = Math.max(f.frag.h, ...(f.lineImgs.map((q) => q.h)))
        const ov = m.overlayRects.filter((o) => o.t < f.frag.b + 2 && o.b > f.frag.t - 2 && o.l <= f.frag.l + 2 && o.r >= f.frag.r - 2)
        const ovH = ov.length ? Math.max(...ov.map((o) => o.h)) : 0
        const needed = Math.max(f.frag.h, sameLineMax, ...(f.line ? [f.line.h] : []))
        return { fragH: f.frag.h, lineH: f.line ? f.line.h : null, imgH: f.lineImgs.map((q) => q.h), sameLineMax, overlayH: ovH, needCover: needed > f.frag.h + 2, covered: ovH >= f.frag.h + 2, ok: !(needed > f.frag.h + 2) || Math.abs(ovH - needed) <= 2 }
      })
      entry.sources.push(m)
    }
    out.widths.push(entry)
  }
  fs.writeFileSync('tmp/row-sweep.json', JSON.stringify(out, null, 1))
  // 摘要
  const lines = []
  lines.push('window innerW | widget | revealedFrom | frags(h) | lineH | lineImgH | overlayH | OK?')
  for (const e of out.widths) {
    for (const s of e.sources) {
      s.frags.forEach((f, i) => {
        const a = s.assessment[i]
        lines.push(`${e.window} ${e.innerWidth} | #${s.widgetIndex} | from=${s.revealedFrom} | frag#${i} h=${f.frag.h} t=${f.frag.t} b=${f.frag.b} | lineH=${a.lineH} | imgH=${JSON.stringify(a.imgH)} | ovH=${a.overlayH} | need=${a.needCover} ${a.ok ? 'OK' : '*** FAIL ***'}`)
      })
    }
  }
  lines.push('innerWidth/block/overlay 明细见 tmp/row-sweep.json')
  fs.writeFileSync('tmp/row-sweep.txt', lines.join('\n'))
  console.log(lines.join('\n'))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
