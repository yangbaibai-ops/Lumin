'use strict'
/**
 * 本轮（第一百零五轮）图片源码标识符「整行全高背景」的**测量脚本**。
 * 只做测量、不改代码、不写盘。用法：
 *   node tmp\ident-measure.js <port> <mode>
 *     mode = real   → 打开真实文件，量第 15 行的**行内**形态
 *     mode = block  → setContent 一段「图片独占一行」夹具，量**块级**形态
 * 输出：一段 JSON（stdout 最后一行），人类可读的键值在 stderr。
 */
const PORT = process.argv[2] || '9334'
const MODE = process.argv[3] || 'real'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'
const BLOCK_MD = `<img src="${PNG_B}" style="zoom:100%;" />\n`

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) {
      throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    }
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))

  const boot = await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    if (!pinia) return 'NO_PINIA'
    window.__vt = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), ed: () => pinia._s.get('editor')?.instance ?? null, settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  if (boot !== 'OK') throw new Error('bridge ' + boot)
  await ev(`(async () => {
    try { const st = window.__vt.settings(); if (st && st.set) { st.set('remoteImages', 'always'); return 'store' } } catch (e) {}
    try { await window.luminAPI.settings.update({ remoteImages: 'always' }); return 'api' } catch (e) { return 'fail' }
  })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)

  const opened = await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'ok' })()`)
  await sleep(1200)
  const title = await ev(`(() => { const f = window.__vt.files().current; return f ? (f.path || f.name || '') : '' })()`)

  // 打开后的**逐字节往返**取样（在任何点击之前）
  const mdAtOpen = await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`)

  let blockFixture = null
  if (MODE === 'block') {
    blockFixture = BLOCK_MD
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(BLOCK_MD)}); return 'ok' })()`)
    await sleep(900)
  }

  const imgInfo = () =>
    json(`(() => {
      const im = document.querySelector('.ProseMirror [data-img-widget] img')
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { natural: [im.naturalWidth, im.naturalHeight], complete: im.complete,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
        widget: !!im.closest('[data-img-widget]'), zoom: im.style.zoom }
    })()`)

  const before = await imgInfo()
  // 点图片 → 显形（按 suite 同款 Input 注入）
  if (before) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.cx, y: before.cy, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.cx, y: before.cy, button: 'left', clickCount: 1 })
    await sleep(500)
  }

  const state = await json(`(() => {
    const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
    const cs = els[0] ? getComputedStyle(els[0]) : null
    return {
      revealedCount: els.length,
      classes: els.map((e) => e.className),
      tags: els.map((e) => e.tagName.toLowerCase()),
      display: cs ? cs.display : null,
      verticalAlign: cs ? cs.verticalAlign : null,
      lineHeight: cs ? cs.lineHeight : null,
      fontSize: cs ? cs.fontSize : null,
      bg: cs ? cs.backgroundColor : null,
      padding: cs ? cs.padding : null,
      textLen: els.map((e) => (e.textContent || '').length)
    }
  })()`)

  /**
   * 核心几何：对**第 idx 个**标识符量
   *   bg     —— 它自己的 rects（块级=1 个；行内=每个行片段一个，就是**画出来的底色矩形**）
   *   line   —— 该标识符**首字符**的行盒（用 Range 取首字符，按验收要求不用盒子 left）
   *   sel    —— 把**同一段源码范围**做成原生选区后的高亮矩形
   */
  const geom = async (idx) =>
    json(`(() => {
      const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
      const el = els[${idx}]
      if (!el) return { ok: false, reason: 'no-el', n: els.length }
      const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
      // ---- 1) 背景矩形（元素自身的 border-box rects；bg 画在 padding box 上，border=0 ⇒ 同 box）
      const bgRects = [...el.getClientRects()].map(R)
      const bgUnion = R(el.getBoundingClientRect())
      // ---- 2) 首字符的行盒（Range 取首字符；行盒高度按"该行盒里所有文字 rect 的并集"取）
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const tn = walker.nextNode()
      const rg = document.createRange()
      let firstCharRect = null, firstLineRect = null
      if (tn && tn.length) {
        rg.setStart(tn, 0); rg.setEnd(tn, 1)
        const rs = [...rg.getClientRects()]
        firstCharRect = rs.length ? R(rs[0]) : null
        // 整行：该行盒 = 包含首字符的那条**行**的几何 —— 用同段同行的所有 rect 并集近似
        const p = el.closest('p, li, pre, div') || el.parentElement
        const pr = document.createRange()
        pr.selectNodeContents(p)
        const lineTop = firstCharRect ? firstCharRect.t : 0
        const same = [...pr.getClientRects()].filter((x) => x.width > 0 && Math.abs(x.top - (firstCharRect ? firstCharRect.t : 0)) < 2)
        firstLineRect = same.length
          ? R({ left: Math.min(...same.map((x) => x.left)), right: Math.max(...same.map((x) => x.right)), top: Math.min(...same.map((x) => x.top)), bottom: Math.max(...same.map((x) => x.bottom)), width: 0, height: 0 })
          : null
      }
      // ---- 3) 同段同行的**纯文本行盒**（对照：普通正文文字的行盒高度）
      const p2 = el.closest('p, li') || el.parentElement
      const txt = (() => {
        const w = document.createTreeWalker(p2, NodeFilter.SHOW_TEXT)
        let n
        while ((n = w.nextNode())) {
          if ((n.textContent || '').trim()) {
            const q = document.createRange(); q.selectNodeContents(n)
            const rr = [...q.getClientRects()].filter((x) => x.width > 0)
            if (rr.length) return R(rr[0])
          }
        }
        return null
      })()
      // ---- 4) 原生选区（DOM 选区：同一段源码范围）高亮矩形
      const sel = document.getSelection()
      sel.removeAllRanges()
      const sr = document.createRange()
      sr.selectNodeContents(el)
      sel.addRange(sr)
      const selRects = [...sel.getRangeAt(0).getClientRects()].map(R)
      const selStr = sel.toString().slice(0, 40)
      sel.removeAllRanges()
      // ---- 5) computed
      const cs = getComputedStyle(el)
      return {
        ok: true,
        n: els.length,
        idx: ${idx},
        cls: el.className,
        tag: el.tagName.toLowerCase(),
        display: cs.display, verticalAlign: cs.verticalAlign, lineHeight: cs.lineHeight,
        fontSize: cs.fontSize, bg: cs.backgroundColor, paddingBlock: cs.paddingTop + '/' + cs.paddingBottom,
        text: (el.textContent || '').slice(0, 60),
        textLen: (el.textContent || '').length,
        bgRects, bgUnion, firstCharRect, firstLineRect, plainTextLine: txt, selRects, selStr,
        parentCls: (el.parentElement || {}).className || ''
      }
    })()`)

  const g0 = await geom(0)
  const g1 = await geom(1)

  const out = {
    mode: MODE,
    port: PORT,
    title,
    revealedState: state,
    img: before,
    mdRoundtripSame: mdAtOpen === (await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`)),
    mdLen: mdAtOpen.length,
    id0: g0,
    id1: g1
  }
  process.stderr.write(
    [
      `mode=${MODE} title=${title} revealed=${state.revealedCount} cls=${JSON.stringify(state.classes)}`,
      `img=${JSON.stringify(before)}`,
      `id0 display=${g0.display} va=${g0.verticalAlign} lh=${g0.lineHeight} fs=${g0.fontSize}`,
      `  bgRects=${JSON.stringify(g0.bgRects)}`,
      `  firstChar=${JSON.stringify(g0.firstCharRect)} line=${JSON.stringify(g0.firstLineRect)}`,
      `  plainTextLine=${JSON.stringify(g0.plainTextLine)}`,
      `  selRects=${JSON.stringify(g0.selRects)}`,
      `id1 display=${g1.display} va=${g1.verticalAlign}`,
      `  bgRects=${JSON.stringify(g1.bgRects)}`,
      `  firstChar=${JSON.stringify(g1.firstCharRect)}`,
      `  selRects=${JSON.stringify(g1.selRects)}`
    ].join('\n') + '\n'
  )
  process.stdout.write(JSON.stringify(out) + '\n')
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  process.stderr.write('FAIL: ' + e.message + '\n')
  process.exit(1)
})
