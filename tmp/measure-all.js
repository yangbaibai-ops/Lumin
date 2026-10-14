'use strict'
/**
 * 本轮全量测量：真实文件（行内形态）+ 夹具（块级形态）的
 *   ① 标识符背景矩形  ② 行盒几何  ③ 原生选区（DOM 选区 + PM setSelection）矩形
 * 并落三张截图供像素取证。
 * 用法：node tmp/measure-all.js <port> <tag> [mode=real|block|both]
 */
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const TAG = process.argv[3] || 'a'
const MODE = process.argv[4] || 'real'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIiHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'
const BLOCK_MD = `<img src="${PNG_B}" style="zoom:100%;" />\n`
const R = `(x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })`

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
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
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'ok' })()`)
  await sleep(1300)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(200)
  const mdOpen = await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`)

  const out = { tag: TAG, mode: MODE, mdAtOpenLen: mdOpen.length }

  const measure = async (label, withSel, shotBox) => {
    if (withSel) {
      await json(`(() => {
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        if (!el) return { ok: false }
        const from = Number(el.getAttribute('data-img-from'))
        const to = from + (el.textContent || '').length
        const v = window.__vt.ed().view
        const TS = v.state.selection.constructor
        v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, from, to)))
        return { ok: true, from, to }
      })()`)
      await sleep(600)
    }
    const g = await json(`(() => {
      const R = ${R}
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!el) return { ok: false }
      const cs = getComputedStyle(el)
      const block = el.closest('p, li, pre, div')
      // 行盒：该标识符所在**每一行**的行盒几何（用同段同行的所有 rect 求并集）
      const pr = document.createRange(); pr.selectNodeContents(block)
      const allLines = [...pr.getClientRects()].filter((x) => x.width > 0)
      const lines = []
      for (const r of allLines) {
        const hit = lines.find((l) => Math.abs(l.t - r.top) < 3)
        if (hit) { hit.l = Math.min(hit.l, r.left); hit.r = Math.max(hit.r, r.right); hit.b = Math.max(hit.b, r.bottom); hit.h = +(hit.b - hit.t).toFixed(2); hit.w = +(hit.r - hit.l).toFixed(2) }
        else lines.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height })
      }
      const sel = document.getSelection()
      const selRects = sel.rangeCount && sel.toString() ? [...sel.getRangeAt(0).getClientRects()].map(R) : null
      const selStr = sel.rangeCount ? sel.toString().slice(0, 40) : ''
      return {
        ok: true, cls: el.className, tag: el.tagName.toLowerCase(), display: cs.display, va: cs.verticalAlign,
        lh: cs.lineHeight, fs: cs.fontSize, bg: cs.backgroundColor, pad: cs.paddingBlock || cs.padding,
        nLines: lines.length, lines,
        blockRect: (() => { const b = block.getBoundingClientRect(); return R(b) })(),
        blockCls: block.className, blockTag: block.tagName.toLowerCase(),
        bgRects: [...el.getClientRects()].map(R),
        firstCharRect: (() => {
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const tn = w.nextNode()
          if (!tn || !tn.length) return null
          const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, 1)
          const rs = [...rg.getClientRects()]
          return rs.length ? R(rs[0]) : null
        })(),
        selStr, selRects,
        pmSel: (() => { const s = window.__vt.ed().state.selection; return { from: s.from, to: s.to, empty: s.empty } })(),
        widgets: [...block.querySelectorAll('[data-img-widget] img')].map((im) => R(im.getBoundingClientRect()))
      }
    })()`)
    out[label] = g
    if (shotBox) {
      await shot(`tmp/px-${TAG}-${label}${withSel ? '-sel' : '-nosel'}.png`, shotBox)
      out[label].shot = `tmp/px-${TAG}-${label}${withSel ? '-sel' : '-nosel'}.png`
    }
    return g
  }

  // ── 真实文件（行内形态）：点图显形 → 量（无选区 / 有选区）
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  out.imgPt = pt
  out.hiddenCount = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  if (pt) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(500)
  }
  out.revealedAfterClick = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  out.mdRoundtripSameReal = mdOpen === (await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`))
  if (MODE !== 'block') await measure('real-nosel', false, { x: 300, y: 330, width: 1000, height: 320 })
  if (MODE !== 'block') await measure('real-sel', true, { x: 300, y: 330, width: 1000, height: 320 })

  // ── 块级夹具
  if (MODE !== 'real') {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(BLOCK_MD)}); return 'ok' })()`)
    await sleep(900)
    const bp = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    out.blockImgPt = bp
    if (bp) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bp.x, y: bp.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bp.x, y: bp.y, button: 'left', clickCount: 1 })
      await sleep(500)
    }
    out.blockRevealed = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
    await measure('block-nosel', false, { x: 300, y: Math.max(0, (out.blockImgPt ? out.blockImgPt.y : 300) - 120), width: 1000, height: 240 })
    await measure('block-sel', true)
  }

  out.mdRoundtripSame = mdOpen === (await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL: ' + e.message); process.exit(1) })
