'use strict'
/**
 * 定位失败配置：第 2 段源码显形（widget#1）时，img1 与 frag#0 同行（行盒 143.25），
 * 但覆盖层只画了 frag#1 那一行 ⇒ 打印段落子节点结构 + 行走器实际收集到的矩形。
 * 用法：node tmp/row-dom.js <port> [width]
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const W = Number(process.argv[3] || 1424)
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-rowfix-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  await ev(`(() => { window.resizeTo(${W}, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) {
    if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break
    await sleep(400)
  }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  const pt = await json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][1]; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  await click(pt.x, pt.y)
  const out = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const tree = []
    for (const c of Array.from(p.childNodes)) {
      const e = c.nodeType === 1 ? c : null
      tree.push({
        node: c.nodeType === 1 ? c.tagName : '#text(' + (c.textContent || '').slice(0, 18) + ')',
        cls: e ? String(e.className).slice(0, 46) : null,
        display: e ? getComputedStyle(e).display : null,
        inRevealed: e ? (e === el || e.contains(el)) : false,
        rects: c.nodeType === 1 ? [...e.getClientRects()].map(R) : (() => { const rg = document.createRange(); rg.selectNodeContents(c); return [...rg.getClientRects()].map(R) })()
      })
    }
    // 与 HEAD 实现一致的行走器
    const parts = []
    const walk = (parent) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child === el) continue
        if (child.nodeType === 3) {
          const tn = child
          if (!tn.length) continue
          const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, tn.length)
          for (const r of Array.from(rg.getClientRects())) if (r.height > 0) parts.push({ k: 'text', text: (tn.textContent||'').slice(0,10), ...R(r) })
          continue
        }
        if (child.nodeType !== 1) continue
        const e = child
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const replaced = e.tagName === 'IMG' || e.tagName === 'SVG'
        if (replaced || cs.display.startsWith('inline')) for (const r of Array.from(e.getClientRects())) if (r.height > 0) parts.push({ k: replaced ? 'img' : 'inline', cls: String(e.className).slice(0, 30), ...R(r) })
        if (!replaced && !cs.display.startsWith('inline')) walk(e)
      }
    }
    walk(p)
    return {
      innerWidth: innerWidth,
      block: R(p.getBoundingClientRect()),
      revealed: { from: el ? Number(el.getAttribute('data-img-from')) : null, cls: el ? el.className : null, rects: el ? [...el.getClientRects()].map(R) : [] },
      tree,
      walkerParts: parts,
      overlayRects: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect()))
    }
  })()`)
  console.log(JSON.stringify(out, null, 1))
  fs.writeFileSync('tmp/row-dom.json', JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
