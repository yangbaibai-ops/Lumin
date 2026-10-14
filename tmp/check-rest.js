'use strict'
/**
 * ⑤ 不破坏项 + 往返字节 的补充取证（跑在干净实例上）：
 *   - 编辑态去底（真实点击落进标识符 ⇒ --editing / bg transparent / 与点击态的 padding 一致）
 *   - 非激活隐藏（点别处 count:0）
 *   - getMarkdown() 往返 SHA 不变 + 磁盘文件 SHA 不变
 *   - 单点不闪（class/bg 序列：+R 次数、同态重复、来回跳）
 *   - 不跳位（图片 rect / 段落 rect 与 HEAD 基线一致）—— 由 round105 的几何对照给出
 * 用法：node tmp/check-rest.js <port>
 */
const fs = require('fs')
const crypto = require('crypto')
const PORT = process.argv[2] || '9334'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
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
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 20000)
    pending.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))
  const mdSha = () => ev(`(async () => {
    const md = window.__vt.ed().storage.markdown.getMarkdown()
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md))
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
  })()`)
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui') }
    return 'OK'
  })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'ok' })()`)
  await sleep(1400)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(200)

  const out = {}
  out.mdShaOpen = await mdSha()
  out.hiddenCount0 = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)

  // 单点不闪：观察 class 属性变化 + 底色序列
  await ev(`(() => {
    const seen = []; const bgs = []
    const sample = () => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); const bg = el ? getComputedStyle(el).backgroundColor : null; if (bgs[bgs.length-1] !== bg) bgs.push(bg) }
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) seen.push('+R')
        for (const n of m.removedNodes) if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) seen.push('-R')
        if (m.type === 'attributes' && m.attributeName === 'class') { const el = m.target.matches?.('[data-img-revealed]') ? m.target : m.target.querySelector?.('[data-img-revealed]'); if (el) seen.push('~' + (el.classList.contains('img-src-revealed') ? 'R' : 'r') + (el.classList.contains('img-src-revealed--editing') ? 'E' : 'e')) }
      }
      sample()
    })
    mo.observe(document.querySelector('.ProseMirror'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    const t0 = performance.now()
    const raf = () => { sample(); if (performance.now() - t0 < 700) requestAnimationFrame(raf) }
    requestAnimationFrame(raf)
    window.__stop = () => { mo.disconnect(); return { seen, bgs } }
    return 'ok'
  })()`)
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await clickAt(pt.x, pt.y)
  await sleep(800)
  out.flick = await ev(`JSON.stringify(window.__stop())`)
  out.revealedAfterSingleClick = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  out.idleBg = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? getComputedStyle(el).backgroundColor : null })()`)

  // 编辑态：真实点击落进标识符文本（与套件 ③c 同一手法）
  const markerPt = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const rs = [...el.getClientRects()].filter((r) => r.width > 2)
    const r = rs.length ? rs[0] : el.getBoundingClientRect()
    return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + r.height / 2) }
  })()`)
  await clickAt(markerPt.x, markerPt.y)
  await sleep(500)
  out.editing = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { found: false }
    const cs = getComputedStyle(el)
    return { found: true, cls: el.className, editing: el.classList.contains('img-src-revealed--editing'), bg: cs.backgroundColor, pad: cs.paddingTop + '/' + cs.paddingBottom, sel: (() => { const s = window.__vt.ed().state.selection; return { from: s.from, to: s.to, empty: s.empty } })() }
  })()`)
  out.mdShaAfterEditing = await mdSha()

  // 点别处 ⇒ 隐藏
  const elsewhere = await json(`(() => { const ps = [...document.querySelectorAll('.ProseMirror p')]; const p = ps[ps.length - 1]; const r = p.getBoundingClientRect(); return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) } })()`)
  await clickAt(elsewhere.x, elsewhere.y)
  await sleep(500)
  out.hiddenCountAfterElsewhere = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  out.mdShaEnd = await mdSha()
  out.diskSha = crypto.createHash('sha256').update(fs.readFileSync(REAL)).digest('hex').toUpperCase()
  out.diskSize = fs.statSync(REAL).size

  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL: ' + e.message); process.exit(1) })
