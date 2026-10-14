'use strict'
/**
 * 第一百零五轮验收测量（只测本轮）：
 *   ① 顶格（首字符行盒 left vs 正文内容列左边缘）
 *   ② 标识符背景矩形 vs 该行行盒（行盒高 = 1lh；另用「整段剩余高度」交叉验证）
 *   ③ 原生选区（PM setSelection → getSelection().getRangeAt(0).getClientRects()）+ 截图供像素比
 *   ④ 块级形态（夹具）+ 行内形态（真实文件）
 *   ⑤ 编辑态去底 / 非激活隐藏 / 往返 / 按下0松开1 / 底色一次
 * 用法：node tmp/verify-round105.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const TAG = process.argv[3] || 'v105'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')
const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'
const BLOCK_MD = `<img src="${PNG_B}" style="zoom:100%;" />\n`

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
  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  const selectSource = async () => {
    await ev(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const to = Number(el.getAttribute('data-img-from')) + (el.textContent || '').length
      const v = window.__vt.ed().view
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, to)))
      return 'ok'
    })()`)
    await sleep(200)
    await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const from = Number(el.getAttribute('data-img-from'))
      const to = from + (el.textContent || '').length
      const v = window.__vt.ed().view
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, from, to)))
      return { from, to }
    })()`)
    await sleep(700)
  }
  const clickWidget = async (which) => {
    const pt = await json(`(() => {
      const all = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')]
      const im = ${which === 'last' ? 'all[all.length-1]' : 'all[0]'}
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(600)
    return pt
  }
  // 全量几何 + 行盒（行盒 = 该行所有 inline 盒的并集；正文行还含 strut ⇒ 与 1lh 交叉验证）
  const geom = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false }
    const cs = getComputedStyle(el)
    const p = el.closest('p, li, pre, div')
    const csP = getComputedStyle(p)
    const pRect = p.getBoundingClientRect()
    const firstCharRange = (() => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const tn = w.nextNode()
      if (!tn || !tn.length) return null
      const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, 1)
      const rs = [...rg.getClientRects()]
      return rs.length ? R(rs[0]) : null
    })()
    // 行盒：把该段所有 inline 盒（含 replaced 的图片）按竖直重叠分组成「行」
    const lines = (() => {
      const rs = []
      const q = document.createRange(); q.selectNodeContents(p)
      rs.push(...[...q.getClientRects()].filter((x) => x.width > 0 && x.height > 0))
      for (const im of p.querySelectorAll('img')) rs.push(im.getBoundingClientRect())
      const out = []
      for (const r of rs) {
        const hit = out.find((o) => r.top < o.b - 0.5 && r.bottom > o.t + 0.5)
        if (hit) { hit.t = Math.min(hit.t, r.top); hit.b = Math.max(hit.b, r.bottom); hit.l = Math.min(hit.l, r.left); hit.r = Math.max(hit.r, r.right) }
        else out.push({ t: r.top, b: r.bottom, l: r.left, r: r.right })
      }
      return out.map((o) => ({ l: +o.l.toFixed(2), t: +o.t.toFixed(2), r: +o.r.toFixed(2), b: +o.b.toFixed(2), w: +(o.r - o.l).toFixed(2), h: +(o.b - o.t).toFixed(2) }))
    })()
    const sel = document.getSelection()
    return {
      ok: true, cls: el.className, tag: el.tagName.toLowerCase(), display: cs.display, va: cs.verticalAlign,
      lh: cs.lineHeight, lhPx: parseFloat(cs.lineHeight), fs: cs.fontSize,
      bg: cs.backgroundColor, padTop: cs.paddingTop, padBottom: cs.paddingBottom,
      padLeft: cs.paddingLeft, bdb: cs.boxDecorationBreak, writingMode: cs.writingMode,
      elRects: [...el.getClientRects()].map(R), elUnion: R(el.getBoundingClientRect()),
      firstCharRange, pRect: R(pRect), pPadLeft: csP.paddingLeft, pPadRight: csP.paddingRight,
      contentColLeft: +(pRect.left + parseFloat(csP.paddingLeft)).toFixed(2),
      lines,
      selStrLen: sel.rangeCount ? sel.toString().length : 0,
      selRects: sel.rangeCount && sel.toString() ? [...sel.getRangeAt(0).getClientRects()].map(R) : null,
      pmSel: (() => { const s = window.__vt.ed().state.selection; return { from: s.from, to: s.to, empty: s.empty } })(),
      widgets: [...p.querySelectorAll('[data-img-widget] img')].map((im) => R(im.getBoundingClientRect()))
    }
  })()`)

  await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) { try { await window.luminAPI.settings.update({ remoteImages: 'always' }) } catch (e2) {} } return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  log('open real file...')
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'ok' })()`)
  await sleep(1400)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(200)

  const out = { tag: TAG }
  out.mdOpenLen = (await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`)).length
  out.mdOpenSha = await ev(`(async () => {
    const md = window.__vt.ed().storage.markdown.getMarkdown()
    const buf = new TextEncoder().encode(md)
    const h = await crypto.subtle.digest('SHA-256', buf)
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
  })()`)
  out.hiddenBeforeClick = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)

  // ── ⑤ 按下 0 / 松开 1 + 底色一次（在真实文件上，第一张图）
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(160)
  out.pressCount = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(420)
  out.releaseCount = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  out.releaseBg = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? getComputedStyle(el).backgroundColor : null })()`)
  out.releasePad = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? getComputedStyle(el).paddingTop + '/' + getComputedStyle(el).paddingBottom : null })()`)

  // ── ④a 行内形态（真实文件第 15 行）：不选区
  out.inline = await geom()
  await shot(`tmp/${TAG}-inline-nosel.png`, { x: 300, y: 330, width: 1000, height: 320 })
  await shot(`tmp/ident-fullheight-bg.png`, { x: 300, y: 330, width: 1000, height: 320 })
  // ── ③ 原生选区
  await selectSource()
  out.inlineSel = await geom()
  await shot(`tmp/${TAG}-inline-sel.png`, { x: 300, y: 330, width: 1000, height: 320 })
  await ev(`document.getSelection().removeAllRanges()`)
  await sleep(300)

  // ── ⑤ 编辑态去底（点进源码文本 → --editing）
  const mid = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const rs = [...el.getClientRects()].filter((r) => r.width > 2)
    const r = rs[0] || el.getBoundingClientRect()
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', clickCount: 1 })
  await sleep(450)
  out.editing = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { found: false }
    const cs = getComputedStyle(el)
    return { found: true, cls: el.className, editing: el.classList.contains('img-src-revealed--editing'), bg: cs.backgroundColor, pad: cs.paddingTop + '/' + cs.paddingBottom, count: document.querySelectorAll('.ProseMirror [data-img-revealed]').length }
  })()`)
  out.mdAfterEditing = (await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`)).length

  // ── ⑤ 非激活隐藏：点别处
  const elsewhere = await json(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-revealed]')); const r = p.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: elsewhere.x, y: elsewhere.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: elsewhere.x, y: elsewhere.y, button: 'left', clickCount: 1 })
  await sleep(450)
  out.hiddenAfterClickElsewhere = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  out.mdRoundtripSameReal = (await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`)) === out.mdOpenLen

  // ── ④b 块级形态（夹具）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(BLOCK_MD)}); return 'ok' })()`)
  await sleep(900)
  await clickWidget('first')
  out.block = await geom()
  await shot(`tmp/${TAG}-block-nosel.png`, { x: 300, y: 40, width: 1000, height: 260 })
  await selectSource()
  out.blockSel = await geom()
  await shot(`tmp/${TAG}-block-sel.png`, { x: 300, y: 40, width: 1000, height: 260 })

  fs.writeFileSync(`tmp/${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL: ' + e.message); process.exit(1) })
