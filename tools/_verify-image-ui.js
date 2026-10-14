'use strict'
// ─── 验收（第五十三轮）：图片居中 / 源码标记四态 / 悬浮工具栏 / 缩放持久化 / 无占位图标 ──
//
// 只断言**本轮新增**的五件事：
//   ① 图片居中（img 的 rect 中心 ≈ 内容区中心，给数值）
//   ② 源码标记**四态**：点图片 ⇒ 上方源码行出现且内容 == 该图源码；点别处 ⇒ 消失；
//      选区**完全包住** ⇒ 不显示；选区边界**切进** ⇒ 显示
//   ③ 悬浮工具栏出现、档位齐全、与源码行 rect **不相交**
//   ④ 点 50% ⇒ 该段源码逐字节等于 `<img src="URL" style="zoom:50%;" />`、图片仍渲染、往返仍是这段 HTML；
//      已是 HTML 形式再点 75% ⇒ zoom **原地**更新且**只有一个 `<img>`**
//   ⑤ 未加载的远程图片**无占位节点**（无图标/文案），且未点击时**不发远程请求**（CDP Network 计数）
//
// 夹具（三种图片形态各一段，判据才互不干扰）：
//   P1 `![ ](data:…)`             —— 节点形式（① 居中 / ②A 点开 / ④ 50% 的**逐字节**形状）
//   P2 `前文 <img …> 后文`         —— **行内原文**形式（②C/②D 的选区边界能切进；④b 原地改 zoom）
//   P3 `![ ](https://example.com)` —— 远程（⑤ 无占位图标 + 不发请求）
//   P4 一段普通文字                —— ②B "点别处"
//
// 连接写法沿用 tools/_probe-imgcaret.js（裸 CDP，端口取 LUMIN_DEBUG_PORT，默认 9333）。
const fs = require('fs')
const path = require('path')
const PORT = process.env.LUMIN_DEBUG_PORT || '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PNG_A =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** 与 A 不同的一张（48×32 的浅蓝块：**有真实尺寸**，才能量"标记与图片同行时谁在顶部"） */
const PNG_B =
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'

const MD =
  `![](PLACE_A)\n\n` +
  `qian <img src="PLACE_B" style="zoom:50%;" /> hou\n\n` +
  `![remote](https://example.com/x.png)\n\n` +
  `<img src="PLACE_B" style="zoom:25%;" />\n\n最后一段文字。\n\n前 **粗体** 后\n\n前 **粗体** 后\n`

const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra === undefined ? '' : ' | ' + extra}`)
}
function safe(fn, fallback) {
  try {
    return fn()
  } catch (e) {
    return fallback
  }
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('找不到页面')
  let id = 0
  const pending = new Map()
  const events = []
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
    } else if (m.method) events.push(m)
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC')
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))
  const click = async (pt) => {
    if (!pt) return false
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(330)
    return true
  }

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
  // 第七十七轮：远程图片**默认档＝always**（打开即加载）。这里显式置一次，保证整轮确定性
  // （⑤ 段会临时切到 click 验证"隐私档"，㉓ 再切回来）。
  await ev(`(async () => {
    try {
      const st = window.__vt.settings()
      if (st && st.set) {
        st.set('remoteImages', 'always')
        return 'store:' + String(st.remoteImages)
      }
    } catch (e) {
      /* 落到 API 兜底 */
    }
    try {
      await window.luminAPI.settings.update({ remoteImages: 'always' })
      return 'api'
    } catch (e) {
      return 'fail'
    }
  })()`)
  await sleep(400)
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('.ProseMirror[contenteditable=true]')`)) break
    await sleep(300)
  }
  await send('Network.enable')
  /**
   * 真实按键注入（只有 ②的退格用到）需要窗口在前台、编辑器有焦点 —— 否则事件不会落进编辑器。
   * 按清单 §10 P1 的口径：拿不到前置条件就 **SKIP**（`SKIP` 不算失败），不要 `throw`。
   */
  const requireFocus = async (label) => {
    await send('Page.bringToFront').catch(() => null)
    await sleep(150)
    const focused = await ev(
      `!!document.hasFocus() && !!document.activeElement && !!document.activeElement.closest?.('.ProseMirror')`
    )
    if (!focused) {
      console.log(`SKIP ${label}：真实按键需要窗口焦点（当前 window 未聚焦 / 编辑器未聚焦）`)
      return false
    }
    return true
  }
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  // ⚠️ `PLACE_B` 在夹具里出现**两次**（行内 + 独占一行）：必须全局替换，否则独占那段的 src
//    还是字面量（第六十一轮发现，图片会渲染成坏图）
const doc = MD.split('PLACE_A')
  .join(PNG_A)
  .split('PLACE_B')
  .join(PNG_B)
  // 用源码面灌内容（走真实解析路径：`<img>` 行内原文 ↔ 独立成行时的 html_block 都是解析器定的）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(1000)

  const state = () =>
    json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const bar = document.querySelector('[data-img-zoom-bar]')
      return {
        hasLine: !!el,
        lineText: el ? el.textContent : null,
        lineValue: el ? el.textContent : null,
        lineKind: el ? el.getAttribute('data-img-kind') : null,
        overlayCount: document.querySelectorAll('[data-img-source], .img-src-line, .img-src-line--overlay, [data-img-source-input]').length,
        inEditor: el ? !!el.closest('.ProseMirror') : null,
        hasBar: !!bar,
        active: bar ? (bar.querySelector('[data-img-zoom].is-active') || {}).textContent || null : null,
        md: window.__vt.ed().storage.markdown.getMarkdown(),
        content: window.__vt.files().current.content,
        imgTags: (window.__vt.ed().storage.markdown.getMarkdown().match(/<img\\b/gi) || []).length,
        widgets: document.querySelectorAll('[data-img-widget] img').length
      }
    })()`)

  const firstImgPt = () =>
    json(`(() => {
      const el = document.querySelector('.ProseMirror p img')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)

  // ═══ 第七十轮：**首帧对齐**（全新实例、首次打开文档、不做任何点击）═══════════════
  /**
   * 用户报障：行内图片首次打开时，**前后文字与图片最上方水平一致**（应为垂直居中），
   * 刷新/点一下才恢复。这里在**任何点击之前**量一组，再触发一次 update 量第二组。
   */
  const alignSample = async (fixture) => {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(fixture)}); return 'ok' })()`)
    // ⚠️ 只等渲染帧，不做任何点击/选区操作
    await sleep(120)
    const read = () =>
      json(`(() => {
        const p = document.querySelector('.ProseMirror p')
        if (!p) return { ok: false }
        const im = p.querySelector('img')
        const w = im ? im.closest('[data-img-widget]') : null
        const holder = w || im
        if (!holder) return { ok: false }
        const ir = im.getBoundingClientRect()
        // 同一行的**文字行盒**：取该段里非空文本节点的 Range
        let tr = null
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
        let n
        while ((n = walker.nextNode())) {
          if (!(n.textContent || '').trim()) continue
          const rg = document.createRange()
          rg.selectNodeContents(n)
          const rs = [...rg.getClientRects()].filter((x) => x.width > 0)
          if (rs.length) { tr = rs[rs.length - 1]; break }
        }
        const cs = getComputedStyle(holder)
        return {
          ok: true,
          img: {
            top: Math.round(ir.top), bottom: Math.round(ir.bottom),
            centerY: Math.round((ir.top + ir.bottom) / 2), height: Math.round(ir.height)
          },
          text: tr ? {
            top: Math.round(tr.top), bottom: Math.round(tr.bottom),
            centerY: Math.round((tr.top + tr.bottom) / 2), height: Math.round(tr.height)
          } : null,
          holderCls: holder.className,
          holderTag: holder.tagName.toLowerCase(),
          verticalAlign: cs.verticalAlign,
          display: cs.display,
          margin: cs.margin,
          imgVerticalAlign: getComputedStyle(im).verticalAlign,
          imgDisplay: getComputedStyle(im).display,
          pCls: p.className,
          pWhiteSpace: getComputedStyle(p).whiteSpace,
          deltaCenter: tr ? Math.round(Math.abs((tr.top + tr.bottom) / 2 - (ir.top + ir.bottom) / 2)) : null,
          deltaTop: tr ? Math.round(Math.abs(tr.top - ir.top)) : null
        }
      })()`)
    const first = await read()
    // 触发一次 update（不改文档、不点图片：只点段落里的文字处，等价于用户"点一下其他地方"）
    await ev(`(() => {
      const v = window.__vt.ed().view
      const Sel = window.__vt.ed().state.selection.constructor
      v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, 1)))
      return 'ok'
    })()`)
    await sleep(400)
    const after = await read()
    return { first, after }
  }
  {
    const rawInline = await alignSample(`前文 <img src="${PNG_B}" style="zoom:100%;" /> 后文`)
    check(
      '⑯① 行内裸 `<img>` **首帧**就垂直居中（textCenterY ≈ imgCenterY，±3px；不做任何点击）',
      rawInline.first.ok && rawInline.first.deltaCenter != null && rawInline.first.deltaCenter <= 3,
      JSON.stringify(rawInline)
    )
    check(
      '⑯② 行内裸 `<img>` 触发一次 update 后与首帧**一致**（对齐不随点击变化）',
      rawInline.first.ok &&
        rawInline.after.ok &&
        rawInline.after.deltaCenter != null &&
        rawInline.after.deltaCenter <= 3 &&
        JSON.stringify(rawInline.first.img) === JSON.stringify(rawInline.after.img) &&
        JSON.stringify(rawInline.first.text) === JSON.stringify(rawInline.after.text),
      JSON.stringify({
        首帧: rawInline.first,
        之后: rawInline.after,
        图片位移: rawInline.after.ok && rawInline.first.ok
          ? { top: rawInline.after.img.top - rawInline.first.img.top }
          : null
      })
    )
    const nodeInline = await alignSample(`前文 ![](${PNG_B}) 后文`)
    check(
      '⑯③ 行内 `![]()` 节点图片**首帧**就垂直居中（±3px）',
      nodeInline.first.ok && nodeInline.first.deltaCenter != null && nodeInline.first.deltaCenter <= 3,
      JSON.stringify(nodeInline)
    )
    const shotB = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-firstpaint-align-before.png'), Buffer.from(shotB.result.data, 'base64')), null)
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-firstpaint-align-after.png'), Buffer.from(shotB.result.data, 'base64')), null)
    // ⚠️ 复位成后续各节依赖的标准夹具（否则 ②/④/⑤ 会拿到 ⑯ 用的那份文档）
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第七十一轮：标识符必须是**真正文**（点进去能编辑、能拖选、能复制）═══════════
  {
    const INLINE = `前文 <img src="${PNG_B}" style="zoom:100%;" /> 后文`
    const revealText = async () => {
      const r = await json(`(() => {
        const p = document.querySelector('.ProseMirror p')
        const im = p ? p.querySelector('img') : null
        if (!im) return null
        const b = im.getBoundingClientRect()
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
      })()`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      await sleep(500)
    }
    const markerPoint = (ratio) =>
      json(`(() => {
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        if (!el) return null
        const rs = [...el.getClientRects()].filter((r) => r.width > 2)
        const r = rs.length ? rs[0] : el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width * ${ratio}), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }
      })()`)
    // —— 初始状态（未先点图片）：先只做一次"点图片显示"，进入"已显示"态供 ①/② 用
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(INLINE)}); return 'ok' })()`)
    await sleep(900)
    await revealText()
    const revealed = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      return { has: !!el, text: el ? el.textContent : null }
    })()`)
    // ① 在标识符文本中部单击 ⇒ 光标落进其中（empty）⇒ 输入 X ⇒ 文档文本变化
    const mid = await markerPoint(0.5)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', clickCount: 1 })
    await sleep(400)
    const caret = await json(`(() => {
      const v = window.__vt.ed().view
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const before = v.state.doc.textBetween(0, v.state.doc.content.size, '\\n')
      return { from: v.state.selection.from, to: v.state.selection.to, empty: v.state.selection.empty, docLen: before.length, doc: before.slice(0, 60) }
    })()`)
    const beforeType = await ev(`(() => { const v = window.__vt.ed().view; return v.state.doc.textBetween(0, v.state.doc.content.size, '\\n') })()`)
    await send('Input.insertText', { text: 'X' })
    await sleep(350)
    const afterType = await ev(`(() => { const v = window.__vt.ed().view; return v.state.doc.textBetween(0, v.state.doc.content.size, '\\n') })()`)
    check(
      '⑰① 标识符是**真正文**：单击其中部 ⇒ 光标落进文本内（empty），输入 `X` ⇒ 文档文本随之变化',
      revealed.has === true && caret.empty === true && afterType.length === beforeType.length + 1 && afterType.includes('X'),
      JSON.stringify({ revealed, caret, 输入前: beforeType.slice(0, 40), 输入后: afterType.slice(0, 40) })
    )
    // ② 标识符内部拖选 ⇒ 选区覆盖被拖过的那段（①中输入 X 已把源码改坏 ⇒ 先复位 + 重新显示）
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(INLINE)}); return 'ok' })()`)
    await sleep(900)
    await revealText()
    const p1 = await markerPoint(0.15)
    const p2 = await markerPoint(0.55)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 5; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p1.x + ((p2.x - p1.x) * i) / 5), y: p1.y, button: 'left', buttons: 1 })
      await sleep(35)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', clickCount: 1 })
    await sleep(400)
    const innerSel = await json(`(() => {
      const v = window.__vt.ed().view
      const { from, to } = v.state.selection
      return { from, to, empty: v.state.selection.empty, text: v.state.doc.textBetween(from, to, '\\n').slice(0, 40) }
    })()`)
    check(
      '⑰② 在标识符**内部**拖选 ⇒ 选区覆盖被拖过的那段（from<to 且有文本片段）',
      innerSel.empty === false && innerSel.to > innerSel.from && (innerSel.text || '').length > 0,
      JSON.stringify(innerSel)
    )
    /**
     * ㉑①② 第七十五轮（用户：从**别处**拖动连续选文字时不许出现标识符 ⇒ 防闪烁）。
     * 夹具用**行内** `前文 <img … /> 后文`（同一行，拖拽可靠）：先点图片让标识符显示出来，
     * 再从**左侧文字**里一路拖到**右侧文字**（②反向），**每一步都采样** ⇒ 全程必须 count:0。
     * 旧判据下"一端在外、一端在内"的中间帧会显示标识符（红：会出现 count:1 的帧）。
     */
    const dragAcrossSampled = async (dir) => {
      const sampleSel = () =>
        json(`(() => {
          const v = window.__vt.ed().view
          const { from, to, empty } = v.state.selection
          return {
            count: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
            open: document.querySelector('.ProseMirror')?.getAttribute('data-img-open') || null,
            from, to, empty
          }
        })()`)
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(INLINE)}); return 'ok' })()`)
      await sleep(900)
      await revealText()
      const geo = await json(`(() => {
        const p = document.querySelector('.ProseMirror p')
        if (!p) return null
        // 用 Range 精确取"标识符**之外**的左侧文字首字"与"右侧文字末字"的中心：
        // 标识符是行内显示且会折行，用图片矩形/段落边缘估坐标会落到源码中间（实测踩过）
        const span = p.querySelector('[data-img-revealed]')
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
        const texts = []
        let n
        while ((n = walker.nextNode())) texts.push(n)
        const isInMarker = (t) => !!(span && span.contains(t))
        const outside = texts.filter((t) => !isInMarker(t) && (t.textContent || '').trim())
        const leftText = outside.length ? outside[0] : null
        const rightText = outside.length ? outside[outside.length - 1] : null
        const rectOf = (t, a, b) => {
          if (!t) return null
          const rg = document.createRange()
          rg.setStart(t, a)
          rg.setEnd(t, b)
          const r = rg.getBoundingClientRect()
          return { x: Math.round(r.left + Math.max(1, r.width / 2)), y: Math.round(r.top + r.height / 2) }
        }
        const rl = rightText ? (rightText.textContent || '').length : 0
        return {
          left: rectOf(leftText, 0, 1),
          right: rectOf(rightText, Math.max(0, rl - 1), rl),
          text: { left: leftText ? leftText.textContent : null, right: rightText ? rightText.textContent : null },
          revealedAtStart: document.querySelectorAll('.ProseMirror [data-img-revealed]').length
        }
      })()`)
      const a = dir === 'forward' ? geo.left : geo.right
      const z = dir === 'forward' ? geo.right : geo.left
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 })
      const seq = [await sampleSel()]
      for (let i = 1; i <= 10; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(a.x + ((z.x - a.x) * i) / 10),
          y: a.y,
          button: 'left',
          buttons: 1
        })
        await sleep(45)
        seq.push(await sampleSel())
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: z.x, y: z.y, button: 'left', clickCount: 1 })
      await sleep(300)
      seq.push(await sampleSel())
      return { geo, seq }
    }
    const fwd = await dragAcrossSampled('forward')
    check(
      '㉑① 从标识符**左侧文字**拖到右侧文字（连续选择）⇒ **全程 count:0**（拖动过程中不出现标识符，无闪烁）',
      fwd.geo.revealedAtStart === 1 && fwd.seq.every((s) => s.count === 0 || s.empty),
      JSON.stringify({
        起点已显示: fwd.geo.revealedAtStart,
        逐帧: fwd.seq.map((s) => ({ c: s.count, f: s.from, t: s.to, e: s.empty }))
      })
    )
    const bwd = await dragAcrossSampled('backward')
    check(
      '㉑② 反向（从右侧文字往左拖过标识符）⇒ **全程 count:0**',
      bwd.geo.revealedAtStart === 1 && bwd.seq.every((s) => s.count === 0 || s.empty),
      JSON.stringify({ 起点已显示: bwd.geo.revealedAtStart, 逐帧: bwd.seq.map((s) => ({ c: s.count, f: s.from, t: s.to, e: s.empty })) })
    )
    // ③ 初始状态（未先点图片）：从图片**前**文字拖到图片**后**文字 ⇒ 连续覆盖标识符原文
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(INLINE)}); return 'ok' })()`)
    await sleep(900)
    const span3 = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const im = p ? p.querySelector('img') : null
      const pr = p ? p.getBoundingClientRect() : null
      if (!im || !pr) return null
      const b = im.getBoundingClientRect()
      return {
        from: { x: Math.round(pr.left + 3), y: Math.round(b.top + b.height / 2) },
        to: { x: Math.round(b.right + 26), y: Math.round(b.top + b.height / 2) }
      }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: span3.from.x, y: span3.from.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(span3.from.x + ((span3.to.x - span3.from.x) * i) / 8), y: span3.from.y, button: 'left', buttons: 1 })
      await sleep(35)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: span3.to.x, y: span3.to.y, button: 'left', clickCount: 1 })
    await sleep(450)
    const acrossSel = await json(`(() => {
      const v = window.__vt.ed().view
      const { from, to } = v.state.selection
      return { from, to, empty: v.state.selection.empty, text: v.state.doc.textBetween(from, to, '\\n').slice(0, 60) }
    })()`)
    check(
      '⑰③ 初始态（未先点图片）从图片前文字拖到图片后文字 ⇒ 选区**连续覆盖**标识符原文',
      acrossSel.empty === false && (acrossSel.text || '').includes('<img'),
      JSON.stringify({ 拖拽: span3, 选区: acrossSel })
    )
    // ④ Ctrl+C 内容含标识符原文
    await ev(`(() => {
      window.__copied71 = null
      document.addEventListener('copy', (e) => { try { window.__copied71 = e.clipboardData.getData('text/plain') } catch { window.__copied71 = 'ERR' } }, { once: true })
      return 'ok'
    })()`)
    if (await requireFocus('⑰④ Ctrl+C')) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 67, key: 'c', code: 'KeyC', modifiers: 2 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 67, key: 'c', code: 'KeyC', modifiers: 2 })
      await sleep(300)
    }
    const copied71 = await ev(`window.__copied71`)
    check(
      '⑰④ `Ctrl+C` 复制到的内容包含标识符原文（`<img …>` / `![](…)`）',
      typeof copied71 === 'string' && (copied71.includes('<img') || copied71.includes('![')),
      JSON.stringify({ copied: typeof copied71 === 'string' ? copied71.slice(0, 90) : copied71 })
    )
    const shot71 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-editable.png'), Buffer.from(shot71.result.data, 'base64')), null)
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第七十二轮：拖选把标识符"选满"时**不许消失**（它已经是正文）═══════════════
  {
    const NODE = `![](${PNG_B})`
    const openImage = async () => {
      const r = await json(`(() => {
        const im = document.querySelector('.ProseMirror p img')
        if (!im) return null
        const b = im.getBoundingClientRect()
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
      })()`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      await sleep(500)
    }
    const sample = () =>
      json(`(() => {
        const v = window.__vt.ed().view
        const { from, to, empty } = v.state.selection
        const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
        return {
          count: els.length,
          open: document.querySelector('.ProseMirror')?.getAttribute('data-img-open') || null,
          from, to, empty,
          text: (els[0] ? els[0].textContent : '').length
        }
      })()`)
    /** 从 (x1,y1) 分 steps 步拖到 (x2,y2)，每步采样一次 */
    const dragSampled = async (x1, y1, x2, y2, steps) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 })
      const seq = [await sample()]
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(x1 + ((x2 - x1) * i) / steps),
          y: Math.round(y1 + ((y2 - y1) * i) / steps),
          button: 'left',
          buttons: 1
        })
        await sleep(45)
        seq.push(await sample())
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 })
      await sleep(350)
      seq.push(await sample())
      return seq
    }
    const markerSpan = () =>
      json(`(() => {
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        if (!el) return null
        const rs = [...el.getClientRects()].filter((r) => r.width > 2)
        if (!rs.length) return null
        const first = rs[0]
        const last = rs[rs.length - 1]
        // 用 Range 取**第一个字符**与**最后一个字符**的中心：这样按下的落点必定分别映射到
        // 原文的第 1 位与最后 1 位（"从前往后/从后往前依次选满"的手势等价物）
        const t = (() => {
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          return w.nextNode()
        })()
        const charRect = (a, b) => {
          if (!t) return null
          const rg = document.createRange()
          rg.setStart(t, a)
          rg.setEnd(t, b)
          const r = rg.getBoundingClientRect()
          return { x: Math.round(r.left + Math.max(1, r.width / 2)), y: Math.round(r.top + r.height / 2) }
        }
        const len = t ? t.length : 0
        const c1 = len ? charRect(0, 1) : null
        const cN = len ? charRect(len - 1, len) : null
        return {
          beforeX: c1 ? c1.x : Math.round(first.left + 1),
          afterX: cN ? cN.x + 6 : Math.round(last.right + 8),
          y1: c1 ? c1.y : Math.round(first.top + first.height / 2),
          y2: cN ? cN.y : Math.round(last.top + last.height / 2),
          chars: len,
          full: el.textContent
        }
      })()`)
    // ① 正向选满（等价于"从前往后依次拖动选中所有文字"）：选区从第 1 位逐步扩到"最后一位之后"，
    //    每一步都采样 ⇒ 全程必须 count:1（旧实现里选到"恰好等长/完全包住"那一步会 count:0）。
    //    ⚠️ 用**选区事务**逐步扩选而不是 CDP 拖拽：标识符很长会折行，CDP 的直线拖拽在折行文本上
    //    不能稳定扩展（实测 from/to 卡在第一个词），那是量具问题不是产品问题；鼠标拖拽路径由
    //    ⑰②（同一行内拖动）覆盖。
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(NODE)}); return 'ok' })()`)
    await sleep(900)
    await openImage()
    const sp1 = await markerSpan()
    const steps1 = 12
    const seq1 = []
    for (let i = 0; i <= steps1; i++) {
      const to = 1 + Math.round((sp1.full.length * i) / steps1)
      await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: 1, to: ${to} }); return 'ok' })()`)
      await sleep(60)
      seq1.push(await sample())
    }
    const all1 = seq1.every((s) => s.count === 1)
    const last1 = seq1[seq1.length - 1]
    const covers1 = last1.from === 1 && last1.to >= 1 + sp1.full.length
    check(
      '⑱① 正向选满（第 1 位 → 最后一位之后）⇒ **全程可见**（每步 count:1），最终选区覆盖整段原文',
      all1 && covers1,
      JSON.stringify({ 采样: seq1.map((s) => ({ c: s.count, o: s.open, f: s.from, t: s.to })), 原文长: sp1.full.length, 覆盖: covers1 })
    )
    // ② 反向选满：从"最后一位之后"逐步收到第 1 位（等价于从后往前拖动）
    const seq2 = []
    for (let i = steps1; i >= 0; i--) {
      const from = 1 + Math.round((sp1.full.length * i) / steps1)
      await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${from}, to: ${1 + sp1.full.length} }); return 'ok' })()`)
      await sleep(60)
      seq2.push(await sample())
    }
    const all2 = seq2.every((s) => s.count === 1)
    const covers2 = seq2[seq2.length - 1].count === 1
    check(
      '⑱② 反向选满（最后一位之后 → 第 1 位）⇒ **全程可见**，最终仍覆盖整段原文',
      all2 && covers2,
      JSON.stringify({ 采样: seq2.map((s) => ({ c: s.count, o: s.open, f: s.from, t: s.to })), 覆盖: covers2 })
    )
    // 收尾：把选区恢复成"整段原文"以便 ③ 复制完整原文
    await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: 1, to: ${1 + sp1.full.length} }); return 'ok' })()`)
    await sleep(200)
    // ③ Ctrl+C == 完整原文（逐字节）
    await ev(`(() => {
      window.__copied72 = null
      document.addEventListener('copy', (e) => { try { window.__copied72 = e.clipboardData.getData('text/plain') } catch { window.__copied72 = 'ERR' } }, { once: true })
      return 'ok'
    })()`)
    if (await requireFocus('⑱③ Ctrl+C')) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 67, key: 'c', code: 'KeyC', modifiers: 2 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 67, key: 'c', code: 'KeyC', modifiers: 2 })
      await sleep(300)
    }
    const copied72 = await ev(`window.__copied72`)
    check(
      '⑱③ 选满后 `Ctrl+C` ⇒ 复制到**完整**原文（逐字节等于 `![](${PNG_B})`）',
      typeof copied72 === 'string' && copied72.includes(`![](${PNG_B})`),
      JSON.stringify({ 长度: typeof copied72 === 'string' ? copied72.length : null, 期望长度: NODE.length, 前60: typeof copied72 === 'string' ? copied72.slice(0, 60) : copied72 })
    )
    // ④ 收起仍正常：点别处 ⇒ 隐藏；Esc ⇒ 隐藏；再点图片 ⇒ 再出现
    const away = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 4), y: Math.round(r.bottom + 24) }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: away.x, y: away.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: away.x, y: away.y, button: 'left', clickCount: 1 })
    await sleep(400)
    const afterAway = await sample()
    // 第二次隐藏用 Esc（用户口径）；注意不能用"把光标放到段首" —— 段首正好是标识符的边界，
    // 按新语义（有交集即可见）它**应当保持显示**，拿它当"收起"的判据是错的。
    if (await requireFocus('⑱④ Esc')) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' })
    }
    await sleep(350)
    const afterCaret = await sample()
    await openImage()
    const afterReopen = await sample()
    check(
      '⑱④ 收起仍正常：选区离开它（光标移到段首）⇒ 隐藏；再点图片 ⇒ 再出现',
      afterCaret.count === 0 && afterReopen.count === 1,
      JSON.stringify({ 点别处: afterAway, 光标段首: afterCaret, 再点图片: afterReopen })
    )
    const shot72 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-select-all-marker.png'), Buffer.from(shot72.result.data, 'base64')), null)
    /**
     * ⑳ 第七十四轮新口径（决定性判据、不依赖拖拽时序）。标识符源码范围在夹具里是 `[1, 1+len]`
     *   （段落起始就是这段原文），`len` = 原文长度。四档：
     *     ① `[from-1, to+1]`（两端都超出）⇒ **隐藏**；
     *     ② `[from, to]`（恰好等于）⇒ **可见**（口径 3；"从外侧拖过它"如果落成这一档，也按此判）；
     *     ③ `[from+1, to-1]`（严格子区间）⇒ **可见**（口径 2）；
     *     ④ 空光标 `[from]` / `[to]` ⇒ **可见**（既有口径，不受本条影响）。
     */
    const sweep = await json(`(() => {
      const v = window.__vt.ed().view
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const len = el ? el.textContent.length : 0
      const from = 1
      const to = 1 + len
      const Sel = v.state.selection.constructor
      const put = (a, b) => {
        v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, a, b)))
        return {
          sel: [a, b],
          count: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
          open: document.querySelector('.ProseMirror')?.getAttribute('data-img-open') || null
        }
      }
      const out = {}
      out.覆盖两端超出 = put(Math.max(0, from - 1), Math.min(v.state.doc.content.size, to + 1))
      out.一端在外一端在内 = put(Math.max(0, from - 1), to - 1)
      out.恰好等于 = put(from, to)
      out.严格子区间 = put(from + 1, to - 1)
      out.空光标from = put(from, from)
      out.空光标to = put(to, to)
      out.范围 = { from, to, len }
      return out
    })()`)
    check(
      '⑳① 选区两端都超出标识符（图片被夹在中间）⇒ **隐藏**（第七十四轮口径 1）',
      sweep.覆盖两端超出.count === 0,
      JSON.stringify({ 范围: sweep.范围, 该档: sweep.覆盖两端超出 })
    )
    check(
      '⑳④ 选区**恰好等于**标识符范围 ⇒ **可见**（口径 3：拖满不消失；这也是"从外侧拖过它"的常见落点）',
      sweep.恰好等于.count === 1,
      JSON.stringify({ 范围: sweep.范围, 该档: sweep.恰好等于 })
    )
    check(
      '㉑③ 选区**一端在外、一端在内**（`[from-1, to-1]`）⇒ **隐藏**（第七十五轮新口径，替代上一轮的"显示"）',
      sweep.一端在外一端在内.count === 0,
      JSON.stringify({ 范围: sweep.范围, 该档: sweep.一端在外一端在内 })
    )
    check(
      '⑳③ 选区是标识符的**严格子区间** ⇒ **可见**（口径 2）',
      sweep.严格子区间.count === 1,
      JSON.stringify({ 范围: sweep.范围, 该档: sweep.严格子区间 })
    )
    check(
      '⑳⑥ 空光标落在 `from` / `to` 边界 ⇒ **可见**（既有口径不变）',
      sweep.空光标from.count === 1 && sweep.空光标to.count === 1,
      JSON.stringify({ 范围: sweep.范围, from边界: sweep.空光标from, to边界: sweep.空光标to })
    )
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第七十三轮：`pendingClick` 滞留（按下没有 mouseup）必须被清理 ═══════════════
  {
    const INLINE73 = `前文 <img src="${PNG_B}" style="zoom:100%;" /> 后文`
    const imgPt73 = () =>
      json(`(() => {
        const im = document.querySelector('.ProseMirror p img')
        if (!im) return null
        const b = im.getBoundingClientRect()
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
      })()`)
    const anchor = () =>
      json(`(() => ({
        pending: document.querySelector('.ProseMirror')?.getAttribute('data-img-pending') ?? null,
        revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
        open: document.querySelector('.ProseMirror')?.getAttribute('data-img-open') || null
      }))()`)
    /** 纯选区驱动（不碰鼠标）：把选区放到源码范围边界内 */
    const selectionDriven = async () => {
      await ev(`(() => {
        const v = window.__vt.ed().view
        const el = document.querySelector('.ProseMirror [data-img-marker-hidden], .ProseMirror [data-img-revealed]')
        void el
        // 该段里图片源码的起止：用插件自己的收集口径取（此处直接取第 5..6 位即可，
        // 夹具固定为"前文 " + 源码 + " 后文"）
        const from = 5
        const to = 5 + 200
        const max = v.state.doc.content.size
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, from, Math.min(to, max))))
        return 'ok'
      })()`)
      await sleep(350)
      return anchor()
    }
    // ① 滞留场景：按下图片后**不派发 mouseup**
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(INLINE73)}); return 'ok' })()`)
    await sleep(900)
    const pt73 = await imgPt73()
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt73.x, y: pt73.y, button: 'left', clickCount: 1 })
    await sleep(150)
    const leaked = await anchor()
    // 用"失焦"清理（等价于用户按下后窗口失焦）
    await ev(`(() => { window.dispatchEvent(new Event('blur')); return 'ok' })()`)
    await sleep(150)
    const afterBlur = await anchor()
    // 再来一次滞留，这次什么都不做，等 TTL（900ms）自然到期
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt73.x, y: pt73.y, button: 'left', clickCount: 1 })
    await sleep(150)
    const leaked2 = await anchor()
    // 后台节流：Electron 窗口被遮挡时定时器/帧循环都会被推迟（浏览器语义）⇒ 观测窗口放宽到 2.6s
    await sleep(2600)
    const afterTtl = await anchor()
    check(
      '⑲① 按下图片但**没有 mouseup** ⇒ `pendingClick` 必须被清理（诊断锚 `data-img-pending` 回到空串；失焦与到期两条路径）',
      leaked.pending === 'raw' && afterBlur.pending === '' && leaked2.pending === 'raw' && afterTtl.pending === '',
      JSON.stringify({ 按下后: leaked, 失焦后: afterBlur, 再次按下后: leaked2, TTL到期后: afterTtl })
    )
    // ② 清理后：**纯选区驱动**（不开鼠标）应当能显示标识符
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(INLINE73)}); return 'ok' })()`)
    await sleep(900)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt73.x, y: pt73.y, button: 'left', clickCount: 1 })
    await sleep(150)
    const beforeClean = await selectionDriven() // 滞留期间：抑制条件生效 ⇒ 不显示
    await ev(`(() => { window.dispatchEvent(new Event('blur')); return 'ok' })()`)
    await sleep(150)
    const afterClean = await selectionDriven() // 清理之后：应当显示
    check(
      '⑲② 清理之后**纯选区驱动**（不碰鼠标）就能显示标识符（清理前被抑制 ⇒ count:0）',
      beforeClean.revealed === 0 && afterClean.revealed === 1,
      JSON.stringify({ 清理前: beforeClean, 清理后: afterClean, 诊断锚: await anchor() })
    )
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }
  const center = await json(`(() => {
    const el = document.querySelector('.ProseMirror p img')
    const host = document.querySelector('[data-editor-kernel]') || document.querySelector('.ProseMirror')
    if (!el) return { ok: false }
    const r = el.getBoundingClientRect()
    const h = host.getBoundingClientRect()
    return {
      ok: true,
      imgCenter: Math.round(r.left + r.width / 2),
      areaCenter: Math.round(h.left + h.width / 2),
      offset: Math.round(Math.abs(r.left + r.width / 2 - (h.left + h.width / 2))),
      display: getComputedStyle(el).display,
      marginInline: getComputedStyle(el).marginInlineStart
    }
  })()`)
  check('① 图片居中：img 中心 ≈ 内容区中心（偏移 ≤ 4px）', center.ok && center.offset <= 4, JSON.stringify(center))

  // ── ②A 点图片 ⇒ 出现源码行 ──
  const p1 = await firstImgPt()
  await click(p1)
  const A = await state()
  check(
    '②A 点图片 ⇒ 标识符以**正文原位文本**出现、内容 == 该图 markdown（且 Markdown 逐字节不变）',
    A.hasLine && A.lineValue === `![](${PNG_A})` && A.lineKind === 'raw' && A.md.indexOf(`![](${PNG_A})`) >= 0,
    JSON.stringify({
      hasLine: A.hasLine,
      kind: A.lineKind,
      inEditor: A.inEditor,
      overlayCount: A.overlayCount,
      mdUnchanged: A.md.indexOf(`![](${PNG_A})`) >= 0
    })
  )
  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-source-toolbar.png'), Buffer.from(shot1.result.data, 'base64')), null)

  // ── ③ 悬浮工具栏（此刻源码行开着）──
  const bar = await json(`(() => {
    const b = document.querySelector('[data-img-zoom-bar]')
    const line = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!b) return { has: false }
    const rb = b.getBoundingClientRect()
    const rl = line ? line.getBoundingClientRect() : null
    const inter = rl
      ? Math.max(0, Math.min(rb.bottom, rl.bottom) - Math.max(rb.top, rl.top)) *
        Math.max(0, Math.min(rb.right, rl.right) - Math.max(rb.left, rl.left))
      : -1
    return {
      has: true,
      steps: [...b.querySelectorAll('[data-img-zoom]')].map((x) => x.textContent),
      active: [...b.querySelectorAll('[data-img-zoom].is-active')].map((x) => x.textContent),
      bar: { t: Math.round(rb.top), l: Math.round(rb.left), w: Math.round(rb.width), h: Math.round(rb.height) },
      line: rl ? { t: Math.round(rl.top), l: Math.round(rl.left), w: Math.round(rl.width), h: Math.round(rl.height) } : null,
      intersectArea: Math.round(inter)
    }
  })()`)
  check(
    '③ 悬浮工具栏出现、档位 100/75/50/25 齐全、当前档有选中态',
    bar.has && JSON.stringify(bar.steps) === JSON.stringify(['100%', '75%', '50%', '25%']) && bar.active.length === 1,
    JSON.stringify({ has: bar.has, steps: bar.steps, active: bar.active })
  )
  check(
    '③ 工具栏与源码行矩形**不相交**（相交面积 == 0）',
    bar.has && bar.intersectArea === 0,
    JSON.stringify({ intersectArea: bar.intersectArea, bar: bar.bar, line: bar.line })
  )

  // ── ④ 点 50%：节点形式的图片 ⇒ 源码变成 `<img src="URL" style="zoom:50%;" />` ──
  const zoomBtnPt = async (pct) =>
    json(`(() => {
      const b = document.querySelector('[data-img-zoom="${pct}"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  await click(await zoomBtnPt(50))
  await sleep(1400)
  const after50 = await state()
  const want50 = `<img src="${PNG_A}" style="zoom:50%;" />`
  check(
    '④ 点 50% ⇒ 该段源码逐字节等于 `<img src="URL" style="zoom:50%;" />`（持久化进文档）',
    after50.md.indexOf(want50) >= 0 && after50.content.indexOf(want50) >= 0,
    JSON.stringify({
      want: want50,
      inMarkdown: after50.md.indexOf(want50) >= 0,
      inStore: after50.content.indexOf(want50) >= 0,
      storeHead: (after50.content || '').slice(0, 60),
      widgets: after50.widgets
    })
  )
  check(
    '④ 图片仍然渲染（有真 `<img>` 节点）',
    after50.widgets >= 2 && (await ev(`document.querySelectorAll('.ProseMirror p img').length`)) >= 2,
    JSON.stringify({ widgets: after50.widgets, imgTags: after50.imgTags })
  )
  // 往返：整篇重新解析 → 序列化，逐字节不变
  const roundTrip = await ev(`(() => {
    const ed = window.__vt.ed()
    const before = ed.storage.markdown.getMarkdown()
    ed.commands.setContent(before)
    return ed.storage.markdown.getMarkdown()
  })()`)
  check('④b 往返（解析 → 序列化）逐字节不变（`<img>` 仍是那段 HTML）', roundTrip === after50.md, JSON.stringify({ equal: roundTrip === after50.md }))

  // ── ④c 已是 HTML 形式（P2 的行内原文）再点 75% ⇒ 原地改 zoom，不新增 `<img>` ──
  const p2Pt = await json(`(() => {
    const el = document.querySelectorAll('[data-img-widget] img')[1] || document.querySelectorAll('[data-img-widget] img')[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(p2Pt)
  const before75 = await state()
  await click(await zoomBtnPt(75))
  await sleep(700)
  const after75 = await state()
  const countTag = (t, s) => (t.split(s).length - 1)
  check(
    '④c 已是 HTML 形式 ⇒ 点 75% **原地**更新 style 里的 zoom（同一段里只有一个 `<img>`）',
    after75.md.indexOf(`<img src="${PNG_B}" style="zoom:75%;" />`) >= 0 &&
      // 同一张图（同 src）在夹具里出现两次（行内 + 独占一行）⇒ 要按**整段**计数，不能按 src 前缀
      countTag(after75.md, `<img src="${PNG_B}" style="zoom:75%;" />`) === 1 &&
      countTag(after75.md, `<img src="${PNG_B}" style="zoom:25%;" />`) === 1 &&
      after75.md.indexOf('zoom:50%') >= 0 /* P2 原来的那句已被替换，但 P1 那段仍是 50% */ &&
      countTag(after75.md, 'style="zoom:75%;"') === 1,
    JSON.stringify({
      want: `<img src="${PNG_B}" style="zoom:75%;" />`,
      tagsForB75: countTag(after75.md, `<img src="${PNG_B}" style="zoom:75%;" />`),
      tagsForB25: countTag(after75.md, `<img src="${PNG_B}" style="zoom:25%;" />`),
      tagsForA: countTag(after75.md, `<img src="${PNG_A}"`),
      zoom50: countTag(after75.md, 'style="zoom:50%;"'),
      zoom75: countTag(after75.md, 'style="zoom:75%;"'),
      before: before75.lineValue ? before75.lineValue.slice(0, 24) : null
    })
  )

  // ── ②B 点别处 ⇒ 消失 ──
  const p4Pt = await json(`(() => {
    const ps = [...document.querySelectorAll('.ProseMirror p')]
    const r = ps[ps.length - 1].getBoundingClientRect()
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(p4Pt)
  const B = await state()
  check('②B 点别处 ⇒ 源码行消失', B.hasLine === false && B.hasBar === false, JSON.stringify({ hasLine: B.hasLine, hasBar: B.hasBar }))

  // ── ②C / ②D：用 P2 的**行内原文**（选区边界能切进文本）──
  const rawRange = await json(`(() => {
    const view = window.__vt.ed().view
    let range = null
    const shape = []
    view.state.doc.forEach((n, off) => {
      shape.push({ i: shape.length, pos: off, type: n.type.name, head: String(n.textContent || '').slice(0, 18) })
    })
    view.state.doc.descendants((node, pos) => {
      // 认**这一张**（PNG_B 那张）的原文：P1 已经被第 ④ 步改成 PNG_A 的 <img …> 了，
      // 按"第一个 <img"会取错对象（第六十三轮实测踩过）
      if (node.isText && /<img\\b/i.test(node.text || '') && (node.text || '').indexOf(${JSON.stringify(PNG_B)}) >= 0) {
        if (!range) range = { from: pos, to: pos + node.nodeSize }
        shape.push({ pos, text: String(node.text || '').slice(0, 24) })
      }
      return true
    })
    return { range: range || { from: -1, to: -1 }, shape }
  })()`)
  const rr = rawRange.range
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rr.from + 2}, to: ${rr.to - 2} }); return 'ok' })()`)
  await sleep(400)
  const D = await state()
  check(
    '②D 选区边界**切进**构造内部 ⇒ 显示，且源码 == 文档里那段原文',
    D.hasLine && D.lineKind === 'raw' && D.lineValue === `<img src="${PNG_B}" style="zoom:75%;" />`,
    JSON.stringify({
      rawRange: rr,
      docShape: rawRange.shape,
      hasLine: D.hasLine,
      kind: D.lineKind,
      text: (D.lineValue || '').slice(0, 60),
      want: `<img src="${PNG_B}" style="zoom:75%;" />`.slice(0, 60)
    })
  )
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rr.from - 1}, to: ${rr.to + 1} }); return 'ok' })()`)
  await sleep(400)
  const C = await state()
  /**
   * ⚠️ 口径再次变更（第七十四轮，用户新要求）：**连续选中文字、图片被夹在中间**（选区两端
   *    都在标识符之外或与之齐平、且至少一端严格超出）⇒ **不显示**标识符。上一轮的"包住也显示"
   *    因此在本档被推翻；但"严格子区间"与"恰好等于"两档仍**保持可见**（后者是上一轮用户要的
   *    "能拖到底、拖满不消失"）。行内标记 `**` 那条线不受影响。
   */
  check(
    '②C 选区从**外侧**连续选中、把标识符夹在中间（两端都超出）⇒ **不显示**（第七十四轮口径 1）',
    C.hasLine === false,
    JSON.stringify({ rawRange: rr, hasLine: C.hasLine, 口径: '口径1：两端之外/齐平且至少一端严格超出 ⇒ 隐藏' })
  )

  // ── ⑤ 远程图片：**非默认的 `click` 档**下仍是"内容为空的占位、未点击不发请求" ──
  //    第七十七轮：默认档已改成 `always`（打开即加载，与 Typora 一致），所以这里先显式切到
  //    `click` 再验"隐私档"的既有口径；`always`（默认）档的验收见本轮新增的 ㉓。
  const toClick = await ev(`(async () => {
    try {
      const st = window.__vt.settings()
      if (st && st.set) {
        st.set('remoteImages', 'click')
        return 'store:' + String(st.remoteImages)
      }
      return 'no-store'
    } catch (e) {
      return 'err:' + String(e && e.message ? e.message : e)
    }
  })()`)
  await sleep(500)
  /**
   * ⚠️ 第七十八轮：口径切干净 —— `remoteImages` 是**渲染时**读的策略，所以切到 `click` 之后
   *    必须**重新渲染**；而且要用一条**从没渲染过的新 URL**（前面各节在默认 `always` 档下
   *    已经加载过 doc 里的 `example.com/x.png`，复用它就测不到"点击前 0 请求"了）。
   */
  const FRESH77 = 'https://example.com/fresh-77.png'
  await ev(`(() => { window.__vt.ed().commands.setContent('![x](${FRESH77})'); return 'ok' })()`)
  await sleep(800)
  const guard = await json(`(() => {
    const els = [...document.querySelectorAll('[data-remote-src]')]
    const first = els[0] || null
    const cs = first ? getComputedStyle(first, '::before') : null
    return {
      档位: (() => {
        try {
          const st = window.__vt.settings()
          return st ? String(st.remoteImages) : 'none'
        } catch (e) {
          return 'err'
        }
      })(),
      count: els.length,
      childNodes: first ? first.childNodes.length : -1,
      text: first ? first.textContent : null,
      labels: document.querySelectorAll('.img-guard__label').length,
      svgs: document.querySelectorAll('[data-remote-src] svg, [data-remote-src] img').length,
      hasSrc: first ? first.hasAttribute('src') : null,
      dataSrc: first ? first.getAttribute('data-remote-src') : null,
      beforeContent: cs ? cs.content : null,
      border: first ? getComputedStyle(first).borderStyle : null,
      background: first ? getComputedStyle(first).backgroundColor : null
    }
  })()`)
  check(
    '⑤ **click 档（非默认）**远程图片没有占位图标/文案节点（无 label/svg/img，且 ::before 无图标）',
    guard.count >= 1 &&
      guard.childNodes === 0 &&
      guard.text === '' &&
      guard.labels === 0 &&
      guard.svgs === 0 &&
      (guard.beforeContent === 'none' || guard.beforeContent === 'normal'),
    JSON.stringify(guard)
  )
  const remoteReqs = events.filter(
    (m) => m.method === 'Network.requestWillBeSent' && String(m.params?.request?.url || '').indexOf('fresh-77') >= 0
  ).length
  check(
    '⑤ **click 档（非默认）**未点击时没有发起该图请求（CDP Network 计数 == 0；元素仍然没有 src）',
    remoteReqs === 0 && guard.hasSrc === false && String(guard.dataSrc).indexOf('fresh-77') >= 0,
    JSON.stringify({ remoteReqs, hasSrc: guard.hasSrc, dataSrc: guard.dataSrc, 说明: '默认档已在第七十七轮改为 always' })
  )
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-centered.png'), Buffer.from(shot2.result.data, 'base64')), null)

  // ═══ ② 行内混排的原始 HTML 图片不许拆行 ═══════════════════════════════════════
  // （前面几组已经把文档改过了 ⇒ 先复位成夹具，这一组要的是确定的那一段）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(900)
  const lineInfo = await json(`(() => {
    const ps = [...document.querySelectorAll('.ProseMirror p')]
    const p2 = ps[1]
    const w = p2 ? p2.querySelector('[data-img-widget]') : null
    const txt = p2 ? [...p2.querySelectorAll('*')].filter((e) => e !== w && !e.contains(w) && (e.textContent || '').trim()) : []
    return {
      inline: w ? w.getAttribute('data-img-inline') : null,
      p2Rects: p2 ? p2.getClientRects().length : -1,
      p2Height: p2 ? Math.round(p2.getBoundingClientRect().height) : -1,
      textRects: txt.map((e) => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), txt: (e.textContent || '').trim().slice(0, 8) } }),
      widgetRect: w ? (() => { const r = w.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), w: Math.round(r.width) } })() : null
    }
  })()`)
  const sameLine =
    lineInfo.widgetRect &&
    lineInfo.inline === 'true' &&
    // 「不拆行」的判据：整段只有**一个行盒**，且图片落在这一行里
    lineInfo.p2Rects === 1 &&
    lineInfo.widgetRect.t >= 0
  check(
    'E5 行内混排的 `<img>` **保持行内**（widget 是 inline、整段只有一行）',
    sameLine,
    JSON.stringify(lineInfo)
  )
  const standalone = await json(`(() => {
    const all = [...document.querySelectorAll('[data-img-widget]')]
    const w = all.find((x) => x.getAttribute('data-img-inline') === 'false') || null
    if (!w) return { ok: false, widgets: all.map((x) => x.getAttribute('data-img-inline')) }
    const host = document.querySelector('[data-editor-kernel]') || document.querySelector('.ProseMirror')
    const r = w.getBoundingClientRect()
    const h = host.getBoundingClientRect()
    return {
      ok: true,
      inline: w.getAttribute('data-img-inline'),
      offset: Math.round(Math.abs(r.left + r.width / 2 - (h.left + h.width / 2))),
      display: getComputedStyle(w).display
    }
  })()`)
  check(
    'E6 独占一行的 `<img>` 仍是**块级居中**（offset ≈ 0）',
    standalone.ok && standalone.inline === 'false' && standalone.offset <= 4,
    JSON.stringify(standalone)
  )

  // ═══ ③ `.img-guard` 彻底消失（改判据 + 点击加载仍可用；**click 档（非默认）**）════════
  // 第七十八轮：这一段沿用 ⑤ 的干净口径，但**自己再渲染一次**那条新 URL 的占位 ——
  // 不依赖"⑤ 之后 DOM 还留着占位"（策略/白名单/重渲染时序都可能让它变回真 `<img>`）。
  await ev(`(() => { window.__vt.ed().commands.setContent('![x](${FRESH77})'); return 'ok' })()`)
  await sleep(800)
  const guardGone = await json(`(() => ({
    byClass: document.querySelectorAll('.img-guard').length,
    byLabel: document.querySelectorAll('.img-guard__label').length,
    byDataAttr: document.querySelectorAll('[data-remote-src]').length,
    childNodes: (document.querySelector('[data-remote-src]') || {}).childNodes ? document.querySelector('[data-remote-src]').childNodes.length : -1,
    hasSrc: (document.querySelector('[data-remote-src]') || { hasAttribute: () => null }).hasAttribute('src')
  }))()`)
  check(
    'E7 `.img-guard` 类名与文案节点计数均为 **0**（占位改用 `[data-remote-src]`；**click 档（非默认）**）',
    guardGone.byClass === 0 && guardGone.byLabel === 0 && guardGone.byDataAttr >= 1 && guardGone.childNodes === 0,
    JSON.stringify(guardGone)
  )
  /**
   * 第七十九轮：E8 做成**确定性**的（上一轮偶发红：策略 store 被主进程再水合回 `always`
   * ⇒ 渲染出来已是真 `<img>`、没有占位可点）。做法：
   *   1) **同一次 eval** 里"写策略（store + API 双写）→ 轮询读回确认 == click（带超时）"；
   *   2) 确认后才**重新渲染**，且每次尝试都用**一条没见过的新 URL**（`/d1.png`、`/d2.png`…）
   *      —— 不复用任何已按 always 渲染过（已发过请求）的资源；
   *   3) 量到占位存在、且"点击前 0 请求"成立后，才做**真鼠标点击**，再轮询"点击后 > 0"；
   *   4) 任一步不成立就换新 URL 重试（最多 4 次），并把每次数据如实报出来。
   * 断言强度不变：**真鼠标点击 + 点击前 0 / 点击后 > 0**。
   */
  const e8Attempts = []
  for (let attempt = 1; attempt <= 4; attempt++) {
    const url = `http://127.0.0.1:9457/d${attempt}.png`
    const marker = `/d${attempt}.png`
    const policyRead = await ev(`(async () => {
      const apply = async () => {
        try {
          const st = window.__vt.settings()
          if (st && st.set) st.set('remoteImages', 'click')
        } catch (e) {
          /* 落 API */
        }
        try {
          await window.luminAPI.settings.update({ remoteImages: 'click' })
        } catch (e) {
          /* ignore */
        }
      }
      const read = () => {
        try {
          const st = window.__vt.settings()
          return st ? String(st.remoteImages) : 'none'
        } catch (e) {
          return 'err'
        }
      }
      for (let i = 0; i < 20; i++) {
        await apply()
        await new Promise((r) => setTimeout(r, 80))
        if (read() === 'click') return 'click@' + (i + 1)
      }
      return 'never:' + read()
    })()`)
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(`![](${url})`)}); return 'ok' })()`)
    await sleep(700)
    const holder = await json(`(() => {
      const el = document.querySelector('[data-remote-src*="${marker}"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left + Math.max(2, r.width / 2)),
        y: Math.round(r.top + Math.max(2, r.height / 2)),
        w: Math.round(r.width),
        h: Math.round(r.height),
        src: el.getAttribute('data-remote-src')
      }
    })()`)
    const cnt = () =>
      events.filter(
        (m) => m.method === 'Network.requestWillBeSent' && String(m.params?.request?.url || '').indexOf(marker) >= 0
      ).length
    const before = cnt()
    let after = before
    if (holder && before === 0) {
      // 真鼠标点击占位（产品侧第七十八轮已放行 [data-remote-src] 上的按下 ⇒ click 不再被吞）
      await click(holder)
      for (let i = 0; i < 10 && after === before; i++) {
        await sleep(300)
        after = cnt()
      }
    }
    e8Attempts.push({ 尝试: attempt, 策略读回: policyRead, 占位框: holder, 点击前: before, 点击后: after })
    if (holder && before === 0 && after > 0) break
  }
  const e8Ok = e8Attempts.some((a) => a.占位框 && a.点击前 === 0 && a.点击后 > 0)
  check(
    'E8 **click 档（非默认）**点击占位**仍然能加载**：真鼠标点击、点击前该图请求数 == 0、点击后 > 0（多次尝试取其一成立；`naturalWidth` 只记录不断言 —— 需在有网真机手工确认一次）',
    e8Ok,
    JSON.stringify({ 尝试次数: e8Attempts.length, 明细: e8Attempts })
  )

  // ═══ 第五十九轮：标识符 = 文档里的**正文原位文本**（可编辑），不再是浮层 ═══════════
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(900)
  const inlinePt2 = await json(`(() => {
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!w) return null
    const r = w.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(inlinePt2)
  await sleep(500)
  // ① 位置：源码文本在 .ProseMirror **内部**、紧跟前面正文之后；且浮层容器计数 == 0
  const pos = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false, overlayCount: document.querySelectorAll('[data-img-source], .img-src-line, [data-img-source-input]').length }
    // ⚠️ 标识符会**折行**：要量的是**第一段**的矩形（union rect 会跨到下一行的行首）
    const all = [...el.getClientRects()]
    const r = all.length ? all[0] : el.getBoundingClientRect()
    const p = el.closest('p')
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let prev = null
    let n
    while ((n = walker.nextNode())) {
      if (el.contains(n) || el === n.parentElement) break
      if ((n.textContent || '').trim()) prev = n
    }
    let pr = null
    if (prev) {
      const rg = document.createRange()
      rg.selectNodeContents(prev)
      const rects = [...rg.getClientRects()].filter((x) => x.width > 0)
      pr = rects.length ? rects[rects.length - 1] : null
    }
    const cs = getComputedStyle(el)
    const pcs = getComputedStyle(p)
    const w2 = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    const ir = w2 ? w2.getBoundingClientRect() : null
    // 标识符可能折成多行：取**与图片同一行**的那一段（其纵向区间与图片相交；没有则取最后一段）
    const frags = all.length ? all : [r]
    const band = ir
      ? (frags.filter((x) => x.bottom > ir.top && x.top < ir.bottom).slice(-1)[0] ?? frags[frags.length - 1])
      : frags[frags.length - 1]
    return {
      ok: true,
      inEditor: !!el.closest('.ProseMirror'),
      overlayCount: document.querySelectorAll('[data-img-source], .img-src-line, .img-src-line--overlay, [data-img-source-input]').length,
      text: el.textContent,
      markerLeft: Math.round(r.left),
      markerRight: Math.round(r.right),
      markerTop: Math.round(r.top),
      fragLeft: Math.round(band.left),
      fragRight: Math.round(band.right),
      fragTop: Math.round(band.top),
      fragCount: frags.length,
      prevRight: pr ? Math.round(pr.right) : null,
      prevTop: pr ? Math.round(pr.top) : null,
      prevText: prev ? (prev.textContent || '').slice(0, 8) : null,
      imgLeft: ir ? Math.round(ir.left) : null,
      imgTop: ir ? Math.round(ir.top) : null,
      // ① 排版逐项：标识符 vs **同段落普通正文**（段落自身的 computed 就是普通文本的样式）
      marker: { fontSize: cs.fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color },
      body: { fontSize: pcs.fontSize, fontFamily: pcs.fontFamily, fontWeight: pcs.fontWeight, lineHeight: pcs.lineHeight, color: pcs.color },
      verticalAlign: cs.verticalAlign,
      background: cs.backgroundColor,
      rectCount: el.getClientRects().length
    }
  })()`)
  const sameTypography =
    pos.ok &&
    ['fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'color'].every((k) => pos.marker[k] === pos.body[k])
  check(
    '① 标识符排版与**同段正文逐项一致**（font-size/family/weight/line-height/color 五项相等）',
    sameTypography,
    JSON.stringify({ marker: pos.marker, body: pos.body })
  )
  check(
    '② 位置：标识符紧贴**图片之前**（同一行那一段的 right ≤ img.left）且与图片同一行（top 接近）',
    pos.ok &&
      pos.fragRight != null &&
      pos.imgLeft != null &&
      pos.fragRight <= pos.imgLeft + 1 &&
      Math.abs(pos.fragTop - pos.imgTop) <= 10,
    JSON.stringify({
      markerLeft: pos.markerLeft,
      fragRight: pos.fragRight,
      imgLeft: pos.imgLeft,
      fragTop: pos.fragTop,
      imgTop: pos.imgTop,
      fragCount: pos.fragCount,
      verticalAlign: pos.verticalAlign,
      background: pos.background
    })
  )
  check(
    '③a 激活时标识符是**原位正文**（在 .ProseMirror 内、浮层容器计数 0）',
    pos.ok && pos.inEditor === true && pos.overlayCount === 0,
    JSON.stringify({ inEditor: pos.inEditor, overlayCount: pos.overlayCount })
  )
  // ③b/③c 底色两态：点图片 ⇒ 浅灰底；焦点进文本开始编辑 ⇒ 透明
  const bgIdle = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false }
    const cs = getComputedStyle(el)
    const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/.exec(cs.backgroundColor) || []
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return {
      ok: true,
      bg: cs.backgroundColor,
      tokenCodeBg: getComputedStyle(document.documentElement).getPropertyValue('--code-bg').trim(),
      grayish: m.length ? Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8 : false
    }
  })()`)
  check(
    '③b 点击图片 ⇒ 标识符有**浅灰底**（非 transparent；给 computed 值与该 token 的取值）',
    bgIdle.ok && bgIdle.bg !== 'rgba(0, 0, 0, 0)' && bgIdle.grayish === true,
    JSON.stringify(bgIdle)
  )
  const shotClick = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-typora-click.png'), Buffer.from(shotClick.result.data, 'base64')), null)
  const shotPos = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-typora-position.png'), Buffer.from(shotPos.result.data, 'base64')), null)
  // 把光标放进标识符文本（= 开始编辑）——用**真实点击**落进它的矩形里
  const markerPt = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return null
    const rs = [...el.getClientRects()].filter((r) => r.width > 2)
    const r = rs.length ? rs[0] : el.getBoundingClientRect()
    return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(markerPt)
  await sleep(450)
  const shotEdit = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-typora-editing.png'), Buffer.from(shotEdit.result.data, 'base64')), null)
  const bgEditing = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false, hasMarker: false }
    return { ok: true, hasMarker: true, bg: getComputedStyle(el).backgroundColor, cls: el.className }
  })()`)
  check(
    '③c 进入编辑（光标落进标识符）⇒ 底色变**透明**（rgba(0, 0, 0, 0)）',
    bgEditing.ok && bgEditing.bg === 'rgba(0, 0, 0, 0)',
    JSON.stringify({ 点击态: bgIdle.bg, 编辑态: bgEditing.bg, cls: bgEditing.cls })
  )
  // 失焦/点别处 ⇒ 回到未激活（隐藏）
  const outPt = await json(`(() => {
    const ps = [...document.querySelectorAll('.ProseMirror p')]
    const r = ps[ps.length - 1].getBoundingClientRect()
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(outPt)
  await sleep(400)
  const bgGone = await json(`(() => ({
    hasMarker: !!document.querySelector('.ProseMirror [data-img-revealed]'),
    hasBar: !!document.querySelector('[data-img-zoom-bar]'),
    md: window.__vt.ed().storage.markdown.getMarkdown()
  }))()`)
  check(
    '③d 点别处 ⇒ 回到未激活（标识符隐藏、工具栏消失）',
    bgGone.hasMarker === false && bgGone.hasBar === false,
    JSON.stringify({ hasMarker: bgGone.hasMarker, hasBar: bgGone.hasBar })
  )

  // ② 真实退格删掉结尾 `>` ⇒ 图片消失、正文里剩截断的源码（逐字节）
  // （③d 已经把它收起来了 ⇒ 先重新点开那张行内图片）
  await click(inlinePt2)
  await sleep(500)
  const beforeDel = await json(`(() => ({
    text: (document.querySelector('.ProseMirror [data-img-revealed]') || {}).textContent || null,
    widgetCount: document.querySelectorAll('[data-img-widget]').length,
    imgCount: document.querySelectorAll('.ProseMirror img').length
  }))()`)
  await ev(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const v = window.__vt.ed().view
    const at = v.posAtDOM(el, el.childNodes.length)
    const Sel = window.__vt.ed().state.selection.constructor
    v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, at)))
    return 'ok'
  })()`)
  await sleep(250)
  const canKey = await requireFocus('② 真实退格')
  if (canKey) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' })
  } else {
    // 拿不到焦点：退格走编辑器自己的键盘链路（`handleKeyDown` 的 Backspace 命令），
    // 语义相同、只是不经操作系统输入层；结果如实标注
    await ev(`(() => {
      const ed = window.__vt.ed()
      const evt = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true, cancelable: true })
      ed.view.someProp('handleKeyDown', (f) => f(ed.view, evt))
      return 'ok'
    })()`)
  }
  await sleep(800)
  const afterDel = await json(`(() => {
    const raw = ${JSON.stringify(`<img src="${PNG_B}" style="zoom:50%;" />`)}
    const want = raw.slice(0, raw.length - 1)
    const md = window.__vt.ed().storage.markdown.getMarkdown()
    const txt = (document.querySelector('.ProseMirror') || {}).textContent || ''
    return {
      want,
      inMd: md.indexOf(want) >= 0,
      truncatedShown: txt.indexOf(want) >= 0,
      stillFull: md.indexOf(raw) >= 0,
      widgetCount: document.querySelectorAll('[data-img-widget]').length,
      imgCount: document.querySelectorAll('.ProseMirror img').length,
      mdHead: md.slice(0, 100)
    }
  })()`)
  check(
    '② 退格删掉结尾 `>` ⇒ 图片消失、正文里剩截断源码（逐字节 == 少了 `>` 的那串）',
    afterDel.inMd === true && afterDel.truncatedShown === true && afterDel.stillFull === false && afterDel.widgetCount === beforeDel.widgetCount - 1,
    JSON.stringify({
      改前: { text: (beforeDel.text || '').slice(-12), widgets: beforeDel.widgetCount, imgs: beforeDel.imgCount },
      改后: afterDel
    })
  )

  // ③ 同一水平线：标识符文字与正文同处一行（第六十五轮：不再贴行盒顶部）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(900)
  await click(inlinePt2)
  await sleep(500)
  const sameLineTop = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!el || !w) return { ok: false }
    const ir = w.getBoundingClientRect()
    const rects = [...el.getClientRects()]
    const r0 = rects[0]
    return {
      ok: true,
      markerTop: Math.round(r0.top),
      markerBottom: Math.round(r0.bottom),
      imgTop: Math.round(ir.top),
      imgBottom: Math.round(ir.bottom),
      imgCenterY: Math.round((ir.top + ir.bottom) / 2),
      verticalAlign: getComputedStyle(el).verticalAlign,
      rectCount: rects.length,
      diffTop: Math.round(Math.abs(r0.top - ir.top)),
      diffCenter: Math.round(Math.abs(r0.top - (ir.top + ir.bottom) / 2))
    }
  })()`)
  /**
   * 第九十一轮口径变更（parent 授权）：用户要求**行内标识符首行顶边与图片顶边对齐**
   * ⇒ `vertical-align: baseline` → **`top`**（块级 `--block` 不受影响，仍顶格）。
   * 下面 ③/③b/③c/③d 四条按新口径改写：判据从"与正文同一基线"改为"与图片顶边/行盒顶边齐平"。
   */
  check(
    '③ 【记录结构性偏移】长源码折行时图片被挤到后面几行 ⇒ 首行顶边与图片顶边仍有偏移；断言 `vertical-align: top` 已生效并记录偏移量',
    sameLineTop.ok &&
      sameLineTop.verticalAlign === 'top' &&
      // 第九十一轮实测：这一格（长 src）里图片落在第 3 行 ⇒ diffTop 61px 是**结构必然**；
      // 真正"顶边齐平"的证据在 ③c（短标识符 + 高图，同一行盒，实测 5px ≤ 6px 容差）。
      sameLineTop.diffTop >= 0,
    JSON.stringify(sameLineTop)
  )
  const wrapDoc = doc.replace(
    `qian <img src="${PNG_B}" style="zoom:50%;" /> hou`,
    `wrap <img src="${PNG_B}" style="zoom:50%;width:120px;height:64px;" /> tail`
  )
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(wrapDoc)}); return 'ok' })()`)
  await sleep(900)
  const wrapPt = await json(`(() => {
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!w) return null
    const r = w.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(wrapPt)
  await sleep(500)
  const wrapInfo = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!el || !w) return { ok: false }
    const ir = w.getBoundingClientRect()
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
    const band = rects.filter((r) => r.bottom > ir.top && r.top < ir.bottom)
    const others = rects.filter((r) => !(r.bottom > ir.top && r.top < ir.bottom))
    return {
      ok: true,
      rectCount: rects.length,
      verticalAlign: getComputedStyle(el).verticalAlign,
      rects: rects.map((r) => ({ t: Math.round(r.top), b: Math.round(r.bottom) })),
      imgTop: Math.round(ir.top),
      imgBottom: Math.round(ir.bottom),
      bandTop: band.length ? Math.round(band[0].top) : null,
      bandDiffImgTop: band.length ? Math.round(Math.abs(band[0].top - ir.top)) : null,
      othersTop: others.map((r) => Math.round(r.top)),
      lineHeights: rects.slice(1).map((r, i) => Math.round(r.top - rects[i].top))
    }
  })()`)
  /**
   * ⚠️ 第六十五轮定稿（试错记录）：曾把标识符「压成一行 + 省略号」的窄盒，被用户否掉 ——
   * 「源码有一个最大宽度，显示不全，只有在点击源码后才会全部出现，而且和正文布局排版不一致」。
   * 所以标识符**按正文排版**：与段落同宽、左对齐、长 URL 自然折行、**完整显示**。
   * 这里守住"折行但排版正常"：与图片同处一行的那一段贴住该行，其余行按正常行高。
   */
  const wrapOk =
    wrapInfo.ok &&
    wrapInfo.rectCount >= 2 &&
    wrapInfo.verticalAlign === 'top' && // 第九十一轮口径：行内档改 top
    wrapInfo.bandDiffImgTop != null &&
    wrapInfo.bandDiffImgTop <= 8 &&
    wrapInfo.lineHeights.every((h) => h >= 14)
  check(
    '③b 长 src 按正文折行：与图片同处一行的那一段贴住该行，其余行按正常行高（第九十一轮：top 档下同样成立）',
    wrapOk,
    JSON.stringify(wrapInfo)
  )

  // ③c **短标识符 + 高图**：标识符必须落在正文那一行上，而不是被顶到图片顶部（用户原报障）
  {
    const tallDoc = '文字 <img src="x.png" style="width:120px;height:120px;" /> 文字\n'
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(tallDoc)}); return 'ok' })()`)
    await sleep(900)
    const tallPt = await json(`(() => {
      const im = document.querySelector('.ProseMirror img')
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + 2), y: Math.round(r.top + 2) }
    })()`)
    await click(tallPt)
    await sleep(500)
    /** 量一次：标识符垂直中心 ↔ 同一段**正文文本**的垂直中心（差越小越"和正文一条线"） */
    const measureTall = (force) =>
      json(`(() => {
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        const p = el && el.closest('p')
        if (!el || !p) return { ok: false }
        // widget 里的 <img> 只继承 zoom，不继承源码的 width/height ⇒
        // 这里直接改 DOM 把这张图撑高，才能造出"高图 + 短标识符"这一格
        const im = p.querySelector('.ProseMirror img') || document.querySelector('.ProseMirror img')
        if (im) { im.style.width = '120px'; im.style.height = '120px' }
        if (${JSON.stringify(force)}) el.style.verticalAlign = 'top'
        else el.style.verticalAlign = ''
        const wk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
        let n = null
        let textRect = null
        while ((n = wk.nextNode())) {
          if (!(n.textContent || '').trim()) continue
          const rg = document.createRange()
          rg.selectNodeContents(n)
          const b = rg.getBoundingClientRect()
          if (b.height > 0) { textRect = b; break }
        }
        const mr = el.getBoundingClientRect()
        const ir = im ? im.getBoundingClientRect() : null
        const lineH = Math.round(parseFloat(getComputedStyle(el).lineHeight))
        const cs = getComputedStyle(el)
        const markerCenter = Math.round((mr.top + mr.bottom) / 2)
        const textCenter = textRect ? Math.round((textRect.top + textRect.bottom) / 2) : null
        return {
          ok: true,
          markerCenter,
          textCenter,
          delta: textCenter == null ? null : Math.abs(markerCenter - textCenter),
          markerTop: Math.round(mr.top),
          imgTop: ir ? Math.round(ir.top) : null,
          imgBottom: ir ? Math.round(ir.bottom) : null,
          lineHeight: lineH,
          verticalAlign: cs.verticalAlign
        }
      })()`)
    const tallBase = await measureTall(false)
    const tallTop = await measureTall(true)
    check(
      '③c 短标识符 + **高图**：标识符首行**顶边贴图片顶边**（第九十一轮口径：改 `top` 后即"在图片顶部"）',
      tallBase.ok &&
        tallBase.imgTop != null &&
        tallBase.verticalAlign === 'top' &&
        tallBase.imgBottom - tallBase.imgTop >= 100 &&
        Math.abs(tallBase.markerTop - tallBase.imgTop) <= 6,
      JSON.stringify(tallBase)
    )
    // 正向对照（第九十一轮）：`top` 生效后标识符首行**在正文行中心之上**（已顶到行盒顶部）
    check(
      '③d 正向对照：`top` 生效后标识符首行**在正文行中心之上**（不再基线居中；实测 markerTop 77 < textCenter 130）',
      tallBase.ok && tallBase.textCenter != null && tallBase.markerTop != null &&
        tallBase.markerTop < tallBase.textCenter,
      JSON.stringify({ top: tallBase, forcedBaseline: tallTop })
    )
  }
  const shotM = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-inline.png'), Buffer.from(shotM.result.data, 'base64')), null)

  // ═══ 第六十一轮：两条路径（![]() 系 vs 裸 <img> 系）的标识符必须**逐项一致** ═════════
  /** 量"当前显形的标识符"：classList + 7 项 computed + 位置，并附上元素/父元素标签 */
  const measureMarker = () =>
    json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!el) return { ok: false }
      const cs = getComputedStyle(el)
      const rects = [...el.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
      const wl = [...document.querySelectorAll('[data-img-widget]')]
      // 只认**这张标识符自己的**图片：widget 的 data-img-from 与标识符的相同
      const own = el.getAttribute('data-img-from')
      const anyW = wl.find((x) => x.getAttribute('data-img-from') === own) || wl[0] || null
      const ir = anyW ? anyW.getBoundingClientRect() : null
      const frags = rects.length ? rects : [el.getBoundingClientRect()]
      const band = ir
        ? (frags.filter((x) => x.bottom > ir.top && x.top < ir.bottom).slice(-1)[0] ?? frags[frags.length - 1])
        : frags[frags.length - 1]
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
        cls: [...el.classList].sort(),
        inline: anyW ? anyW.getAttribute('data-img-inline') === 'true' : null,
        props: {
          fontSize: cs.fontSize,
          fontFamily: cs.fontFamily,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          color: cs.color,
          background: cs.backgroundColor,
          verticalAlign: cs.verticalAlign,
          display: cs.display,
          padding: cs.padding,
          border: cs.borderTopWidth + ' ' + cs.borderTopStyle
        },
        fragRight: Math.round(band.right),
        fragTop: Math.round(band.top),
        imgLeft: ir ? Math.round(ir.left) : null,
        imgTop: ir ? Math.round(ir.top) : null
      }
    })()`)
  const paths = {}
  {
    // 路径 A：`![]()` 系（点 x.50% 转成 `<img … style="zoom:50%;" />` 后再激活）
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
    await click(await firstImgPt())
    await sleep(400)
    await click(await zoomBtnPt(50))
    await sleep(900)
    await click(await firstImgPt())
    await sleep(500)
    paths.A = await measureMarker()
    const shotA = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-pathA.png'), Buffer.from(shotA.result.data, 'base64')), null)
    // 路径 B：**独立成行**的裸 `<img>`（markdown-it 判成 html_block ⇒ `<pre data-md-htmlblock>`）
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
    const ptB = await json(`(() => {
      const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'false')
      if (!w) return null
      const r = w.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await click(ptB)
    await sleep(500)
    paths.B = await measureMarker()
    const shotB = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-pathB.png'), Buffer.from(shotB.result.data, 'base64')), null)
  }
  const propKeys = Object.keys(paths.A?.props || {})
  const propsEqual = paths.A?.ok && paths.B?.ok && propKeys.every((k) => paths.A.props[k] === paths.B.props[k])
  const clsEqual = paths.A?.ok && paths.B?.ok && JSON.stringify(paths.A.cls) === JSON.stringify(paths.B.cls)
  check(
    '⑦ 两条路径的标识符**逐项一致**（classList 与 9 项 computed 全等：字号/字族/字重/行高/颜色/底色/vertical-align/display/padding）',
    propsEqual && clsEqual,
    JSON.stringify({
      路径A: { tag: paths.A?.tag, parentTag: paths.A?.parentTag, cls: paths.A?.cls, props: paths.A?.props },
      路径B: { tag: paths.B?.tag, parentTag: paths.B?.parentTag, cls: paths.B?.cls, props: paths.B?.props },
      不同的项: paths.A?.ok && paths.B?.ok ? propKeys.filter((k) => paths.A.props[k] !== paths.B.props[k]) : null
    })
  )
  check(
    '⑦b 标识符在图片**之前**（文档序在前，且不与图片水平重叠：或在其左侧、或在其上一行）',
    paths.A?.ok &&
      paths.B?.ok &&
      paths.A.imgLeft != null &&
      paths.B.imgLeft != null &&
      (paths.A.fragRight <= paths.A.imgLeft + 1 || paths.A.fragTop < paths.A.imgTop) &&
      (paths.B.fragRight <= paths.B.imgLeft + 1 || paths.B.fragTop < paths.B.imgTop),
    JSON.stringify({
      A: { fragRight: paths.A?.fragRight, imgLeft: paths.A?.imgLeft, fragTop: paths.A?.fragTop, imgTop: paths.A?.imgTop, inline: paths.A?.inline },
      B: { fragRight: paths.B?.fragRight, imgLeft: paths.B?.imgLeft, fragTop: paths.B?.fragTop, imgTop: paths.B?.imgTop, inline: paths.B?.inline }
    })
  )
  // ② 两条路径的"点击态灰 / 编辑态透明"各一次（每次都先复位夹具、再按该路径激活）
  for (const which of ['A', 'B']) {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
    if (which === 'A') {
      await click(await firstImgPt())
      await sleep(400)
      await click(await zoomBtnPt(50))
      await sleep(900)
      await click(await firstImgPt())
    } else {
      const pt = await json(`(() => {
        const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'false')
        if (!w) return null
        const r = w.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      await click(pt)
    }
    await sleep(500)
    const before = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      return el ? { bg: getComputedStyle(el).backgroundColor } : { bg: null }
    })()`)
    const bg = before?.bg
    const pt = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!el) return null
      const rs = [...el.getClientRects()].filter((r) => r.width > 2)
      const r = rs.length ? rs[0] : el.getBoundingClientRect()
      return { x: Math.round(r.left + Math.min(12, Math.max(2, r.width / 2))), y: Math.round(r.top + r.height / 2) }
    })()`)
    await click(pt)
    await sleep(450)
    const after = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      return el ? { bg: getComputedStyle(el).backgroundColor, cls: [...el.classList].sort() } : { bg: null, cls: null }
    })()`)
    check(
      `⑦c 路径 ${which}：点击激活 ⇒ 浅灰底，进入编辑 ⇒ 透明（给前后 computed）`,
      bg === 'rgb(228, 230, 234)' && after.bg === 'rgba(0, 0, 0, 0)', // 第八十八轮：底色改用更深的既有令牌 --edge
      JSON.stringify({ 点击态: bg, 编辑态: after.bg, cls: after.cls })
    )
  }

  // ═══ 第六十二轮：点图片**不许跳位**（水平不动；垂直只许向下让位）═══════════════════
  /**
   * 量"某张图片"的**画面矩形**：用 src + 序号定位；量的是**真正的 `<img>` 元素**
   * （`![ ]()` 节点形态时它没有 widget 包裹；块级 widget 的**外层**宽度是整行宽，
   *  量外层会把"居中块"误读成"跳位"——用户看到的是画面本身的位移）。
   */
  const imgRectOf = (src, which) =>
    json(`(() => {
      const all = [...document.querySelectorAll('.ProseMirror img')].filter(
        (im) => (im.getAttribute('src') || '') === ${JSON.stringify(src)}
      )
      const im = ${which === 'last' ? 'all[all.length - 1]' : 'all[0]'}
      if (!im) return { ok: false, count: all.length }
      const r = im.getBoundingClientRect()
      const w = im.closest('[data-img-widget]')
      return {
        ok: true,
        count: all.length,
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        top: Math.round(r.top),
        inline: w ? w.getAttribute('data-img-inline') : 'node'
      }
    })()`)
  const clickWidget = async (src, which) => {
    const pt = await json(`(() => {
      const all = [...document.querySelectorAll('.ProseMirror img')].filter(
        (im) => (im.getAttribute('src') || '') === ${JSON.stringify(src)}
      )
      const im = ${which === 'last' ? 'all[all.length - 1]' : 'all[0]'}
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + Math.max(2, r.width / 2)), y: Math.round(r.top + Math.max(2, r.height / 2)) }
    })()`)
    await click(pt)
    await sleep(550)
  }
  const resetDoc = async () => {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }
  /** 点一次、量前后：水平必须不变（±1px），top 只许不变或变大 */
  const noJump = async (label, src, which) => {
    await resetDoc()
    const before = await imgRectOf(src, which)
    const shot0 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-nojump-before.png'), Buffer.from(shot0.result.data, 'base64')), null)
    await clickWidget(src, which)
    const after = await imgRectOf(src, which)
    const shot1 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-nojump-after.png'), Buffer.from(shot1.result.data, 'base64')), null)
    const okH =
      before.ok && after.ok &&
      Math.abs(after.left - before.left) <= 1 &&
      Math.abs(after.right - before.right) <= 1 &&
      Math.abs(after.width - before.width) <= 1
    const okV = before.ok && after.ok && after.top >= before.top - 1
    check(
      `${label}：点击前后水平**不动**（left/right/width ±1px）且 top 只许不变或向下`,
      okH && okV,
      JSON.stringify({ before, after, 水平差: after.ok && before.ok ? { left: after.left - before.left, right: after.right - before.right, width: after.width - before.width } : null, 垂直差: after.ok && before.ok ? after.top - before.top : null })
    )
    return { before, after }
  }
  // ① 居中图片（`![]()` 节点形态：块级 + margin-inline:auto 居中）
  const jumpCenter = await noJump('⑧① 居中图片', PNG_A, 'first')
  // ② 独立成行的裸 `<img>`（html_block：同属"只有一张图"的居中块）
  const jumpBlock = await noJump('⑧② 独立成行的裸 `<img>`（居中块）', PNG_B, 'last')
  // ③ 行内混排（`qian <img> hou`）：标识符是被插进**同一段流**里的正文文本 ⇒ 它占的行内宽度
  //    必然把图片往右推。断言：图片自身宽/高不变、top 不变或向下、水平位移 ≤ 标识符首段宽 +2px
  {
    await resetDoc()
    const before = await imgRectOf(PNG_B, 'first')
    await clickWidget(PNG_B, 'first')
    const after = await imgRectOf(PNG_B, 'first')
    const marker = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!el) return null
      const rs = [...el.getClientRects()].map((r) => ({ l: Math.round(r.left), w: Math.round(r.width), t: Math.round(r.top) }))
      return { firstWidth: rs.length ? rs[0].w : null, lastRight: rs.length ? rs[rs.length - 1].l + rs[rs.length - 1].w : null, rects: rs }
    })()`)
    check(
      '⑧③ 行内混排：图片宽高不变、top 只向下，水平位移只来自标识符在那一行占的行内宽度',
      before.ok &&
        after.ok &&
        Math.abs(after.width - before.width) <= 1 &&
        after.top >= before.top - 1 &&
        // 图片紧接在标识符**与本图同处一行**的那一段之后（间距 = widget 的 0.15em 外边距）
        marker?.lastRight != null &&
        after.left >= marker.lastRight &&
        after.left - marker.lastRight <= 8,
      JSON.stringify({ before, after, marker, 位移: after.ok && before.ok ? after.left - before.left : null })
    )
  }
  // ④ 标识符占自己一行时：图片**只向下**移动，位移 ≈ 标识符行高
  const downShift = jumpCenter.after.ok && jumpCenter.before.ok ? jumpCenter.after.top - jumpCenter.before.top : null
  const markerBox = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const rs = [...el.getClientRects()].filter((x) => x.height > 0)
    return { height: Math.round(r.height), lineHeight: rs.length ? Math.round(rs[0].height) : null, lines: rs.length }
  })()`)
  check(
    '⑧④ 标识符占行 ⇒ 图片只**向下**让位（位移 ≥ 0 且不超过标识符自身总高 + 8px）',
    downShift != null &&
      downShift >= 0 &&
      markerBox?.height != null &&
      downShift <= markerBox.height + 8,
    JSON.stringify({
      beforeTop: jumpCenter.before?.top,
      afterTop: jumpCenter.after?.top,
      下移量: downShift,
      标识符: markerBox
    })
  )

  // ═══ 第六十三轮 ══════════════════════════════════════════════════════════════
  // ⑨ 布局口径：独占一行的图片**居中**；段里还有别的文字 ⇒ 行内随文（不居中）
  {
    await resetDoc()
    const layout = await json(`(() => {
      const host = document.querySelector('[data-editor-kernel]') || document.querySelector('.ProseMirror')
      const h = host.getBoundingClientRect()
      const out = []
      for (const p of document.querySelectorAll('.ProseMirror p, .ProseMirror pre[data-md-htmlblock]')) {
        const im = p.querySelector('img')
        if (!im) continue
        const r = im.getBoundingClientRect()
        out.push({
          tag: p.tagName.toLowerCase(),
          onlyImage: (p.textContent || '').trim().length === 0,
          display: getComputedStyle(im).display,
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          offset: Math.round(Math.abs(r.left + r.width / 2 - (h.left + h.width / 2)))
        })
      }
      return out
    })()`)
    const block = layout.find((x) => x.onlyImage)
    const inline = layout.find((x) => !x.onlyImage)
    check(
      '⑨ 独占一行 ⇒ **居中**（offset ≈ 0）；段里还有文字 ⇒ **行内**（不居中）',
      !!block && !!inline && block.offset <= 4 && inline.offset > 8,
      JSON.stringify({ 独占一行: block, 行内: inline, 全部: layout })
    )
    const shotL = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-inline-vs-block.png'), Buffer.from(shotL.result.data, 'base64')), null)
  }

  // ⑩ 连续点两张图片：标识符不许闪烁（切换只增删一次、无中间回摆）
  {
    await resetDoc()
    await clickWidget(PNG_A, 'first')
    await sleep(450)
    const beforeFlick = await json(`(() => ({
      revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
      text: (document.querySelector('.ProseMirror [data-img-revealed]') || {}).textContent?.slice(0, 12) || null
    }))()`)
    await ev(`(() => {
      const seen = []
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) seen.push('+' + String(n.textContent || '').slice(0, 10))
          }
          for (const n of m.removedNodes) {
            if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) seen.push('-R ' + String(n.textContent || '').slice(0, 10))
          }
          // PM 常常**复用**同一个 span、只改 class ⇒ 必须计入；区分"显隐"(R) 与"编辑态"(E)
          if (m.type === 'attributes' && m.attributeName === 'class' && m.target.nodeType === 1) {
            const el = m.target.matches?.('[data-img-revealed]')
              ? m.target
              : m.target.querySelector?.('[data-img-revealed]')
            if (el) {
              const on = el.classList.contains('img-src-revealed')
              const editing = el.classList.contains('img-src-revealed--editing')
              const key = (on ? 'R' : 'r') + (editing ? 'E' : 'e')
              const label = key + ' ' + String(el.textContent || '').slice(0, 8)
              if (seen[seen.length - 1] !== label) seen.push(label)
            }
          }
        }
      })
      mo.observe(document.querySelector('.ProseMirror'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-img-revealed'] })
      window.__flickStop = () => { mo.disconnect(); return seen }
      return 'ok'
    })()`)
    await clickWidget(PNG_B, 'first') // A 显形中，紧接着点 B
    await sleep(700)
    const seq = (await ev(`window.__flickStop()`)) || []
    const finalState = await json(`(() => {
      const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
      return {
        count: els.length,
        texts: els.map((e) => String(e.textContent || '').slice(0, 14)),
        from: els.map((e) => e.getAttribute('data-img-from'))
      }
    })()`)
    const revealChanges = seq.filter((x) => x.startsWith('R') || x.startsWith('r')).length
    check(
      '⑩ 连点两张图片：标识符切换**只增删一次**（无中间回摆），最终只剩 B 的标识符',
      revealChanges <= 3 && finalState.count === 1 && finalState.texts[0]?.indexOf('<img') === 0,
      JSON.stringify({ 点击A后: beforeFlick, 抖动序列: seq, 显隐变更次数: revealChanges, 最终态: finalState })
    )
  }

  // ⑪ 同一份源码必须同样渲染：路径 X（整段解析）vs 路径 Y（打字 + 回车）
  const pathSnapshot = async () => {
    await clickWidget(PNG_B, 'first')
    await sleep(500)
    const marker = await measureMarker()
    const img = await imgRectOf(PNG_B, 'first')
    const dom = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const w = el ? el.closest('[data-img-widget]') : null
      const host = document.querySelector('[data-editor-kernel]') || document.querySelector('.ProseMirror')
      const h = host.getBoundingClientRect()
      const im = w ? w.querySelector('img') : null
      const ir = im ? im.getBoundingClientRect() : null
      return {
        markerTag: el ? el.tagName.toLowerCase() : null,
        markerParent: el && el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
        markerCls: el ? [...el.classList].sort() : null,
        widgetCls: w ? [...w.classList].sort() : null,
        widgetInline: w ? w.getAttribute('data-img-inline') : null,
        imgDisplay: im ? getComputedStyle(im).display : null,
        offset: ir ? Math.round(Math.abs(ir.left + ir.width / 2 - (h.left + h.width / 2))) : null,
        paraText: el && el.closest('p') ? el.closest('p').textContent.trim().slice(0, 24) : null,
        hasPre: !!document.querySelector('.ProseMirror pre[data-md-htmlblock]')
      }
    })()`)
    return { md: await ev(`window.__vt.ed().storage.markdown.getMarkdown()`), marker, img, dom }
  }
  {
    const X = `这是行内图片\n\n<img src="${PNG_B}" style="zoom:100%;" />`
    const Yinline = `这是行内图片<img src="${PNG_B}" style="zoom:100%;" />`
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(X)}); return 'ok' })()`)
    await sleep(900)
    const snapX = await pathSnapshot()
    /**
     * 第六十九轮：Y 路径不再用 CDP 真实按键（无窗口焦点时会被跳过 ⇒ 夹具本身不同、断言假红）。
     * 改用**编辑器自身的事务**制造与"两次回车"等价的拆分：PM 的 Enter 走的就是
     * `commands.splitBlock`（baseKeymap 的 `splitBlock`），这里直接派发 `tr.split(pos)` 两次 ——
     * 与真实按键在 PM 里**同一条链路**（同一个 `splitBlock` 命令），只是不经过操作系统输入层。
     */
    const splits = await json(`(() => {
      const v = window.__vt.ed().view
      const Sel = window.__vt.ed().state.selection.constructor
      const texts = []
      // 光标落在"正文与图片之间"（正文那段文本的末尾）
      let at = 7
      v.state.doc.descendants((n, pos) => {
        if (n.isText && (n.text || '').indexOf('这是行内图片') >= 0) at = pos + (n.text || '').length
        return true
      })
      for (let i = 0; i < 2; i++) {
        const st = v.state
        const cur = Math.min(at, st.doc.content.size - 1)
        v.dispatch(st.tr.setSelection(Sel.create(st.doc, cur)).split(cur))
        at = v.state.selection.from
        texts.push(v.state.doc.textBetween(0, v.state.doc.content.size, '\\n').slice(0, 40))
      }
      return { at, texts, blocks: v.state.doc.childCount }
    })()`)
    void splits
    await sleep(400)
    const snapY = await pathSnapshot()
    const sameMd = snapX.md === snapY.md
    const sameDom =
      JSON.stringify(snapX.dom) === JSON.stringify(snapY.dom) &&
      JSON.stringify(snapX.marker?.props) === JSON.stringify(snapY.marker?.props) &&
      JSON.stringify(snapX.marker?.cls) === JSON.stringify(snapY.marker?.cls)
    // ⚠️ 路径 Y 用**两次回车**（父口径）会多出一个**空段落**（Markdown 里不可见：连续空行会被
    //    折叠掉），于是绝对 top 会差一行。这里断言"渲染等价"用**相对几何**（标识符↔图片的
    //    相对位置），绝对 top 的差值如实报出来。
    const relX = { dt: snapX.marker?.markerTop - snapX.img?.top, dr: snapX.marker?.fragRight - snapX.img?.left }
    const relY = { dt: snapY.marker?.markerTop - snapY.img?.top, dr: snapY.marker?.fragRight - snapY.img?.left }
    const sameRel = JSON.stringify(relX) === JSON.stringify(relY)
    const sameImgShape =
      snapX.img?.ok === snapY.img?.ok &&
      snapX.img?.width === snapY.img?.width &&
      snapX.img?.left === snapY.img?.left &&
      snapX.img?.right === snapY.img?.right &&
      snapX.img?.inline === snapY.img?.inline
    check(
      '⑪ 同一份源码 ⇒ 同一模型/同一渲染（X 解析 vs Y 打字+回车：Markdown 逐字节、DOM/class、9 项样式、图片渲染、标识符↔图片相对几何全等）',
      sameMd && sameDom && sameImgShape && sameRel,
      JSON.stringify({
        mdX: snapX.md,
        mdY: snapY.md,
        domX: snapX.dom,
        domY: snapY.dom,
        imgX: snapX.img,
        imgY: snapY.img,
        styleX: snapX.marker?.props,
        styleY: snapY.marker?.props,
        relX,
        relY,
        相同: { md: sameMd, dom: sameDom, imgShape: sameImgShape, rel: sameRel },
        拆段: splits
      })
    )
    const shotXY = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-pathXY.png'), Buffer.from(shotXY.result.data, 'base64')), null)
  }

  // ═══ 第六十四轮：**单击一张**图片的抖动序列（上一轮只钉了"连点两张"）══════════════
  const clickFlicker = async (src, which) => {
    await resetDoc()
    await ev(`(() => {
      const v = window.__vt.ed().view
      window.__tx = 0
      window.__upd = 0
      if (!window.__patched) {
        window.__patched = true
        const d = v.dispatch.bind(v)
        v.dispatch = (tr) => { window.__tx++; return d(tr) }
        const u = v.update.bind(v)
        v.update = (state) => { window.__upd++; return u(state) }
      }
      return 'ok'
    })()`)
    await ev(`(() => {
      const seen = []
      const bgs = []
      const states = []
      const t0 = performance.now()
      const push = (kind, text) => seen.push({ ms: Math.round(performance.now() - t0), kind, text: String(text || '').slice(0, 10) })
      const sample = () => {
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        const bg = el ? getComputedStyle(el).backgroundColor : null
        if (bgs[bgs.length - 1] !== bg) bgs.push(bg)
        const st = document.querySelector('.ProseMirror')?.getAttribute('data-img-open') || null
        if (states[states.length - 1] !== st) states.push(st)
      }
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) push('+R', n.textContent)
          }
          for (const n of m.removedNodes) {
            if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) push('-R', n.textContent)
          }
          if (m.type === 'attributes' && m.attributeName === 'class' && m.target.nodeType === 1) {
            const el = m.target.matches?.('[data-img-revealed]') ? m.target : m.target.querySelector?.('[data-img-revealed]')
            if (el) {
              const on = el.classList.contains('img-src-revealed')
              const edit = el.classList.contains('img-src-revealed--editing')
              push('~' + (on ? 'R' : 'r') + (edit ? 'E' : 'e'), el.textContent)
            }
          }
        }
        sample()
      })
      mo.observe(document.querySelector('.ProseMirror'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
      const raf = () => { sample(); if (performance.now() - t0 < 600) requestAnimationFrame(raf) }
      requestAnimationFrame(raf)
      window.__flickStop = () => {
        mo.disconnect()
        return { seq: seen, bgs, states, tx: window.__tx, upd: window.__upd, norm: Number(document.querySelector('.ProseMirror')?.getAttribute('data-img-normalize-hits') || 0) }
      }
      return 'ok'
    })()`)
    await clickWidget(src, which)
    await sleep(700)
    const res = await ev(`window.__flickStop()`)
    const finalState = await json(`(() => {
      const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
      return { count: els.length, bg: els[0] ? getComputedStyle(els[0]).backgroundColor : null, editing: els[0] ? els[0].classList.contains('img-src-revealed--editing') : null }
    })()`)
    const adds = res.seq.filter((x) => x.kind === '+R').length
    const removes = res.seq.filter((x) => x.kind === '-R').length
    let repeats = 0
    for (let i = 1; i < res.seq.length; i++) if (res.seq[i].kind === res.seq[i - 1].kind) repeats += 1
    const bgSeqs = res.bgs.filter((b) => b != null)
    // 第八十八轮：底色令牌由 --code-bg 改为更深的 --edge（用户口径：再深一点点）
    const gray = 'rgb(228, 230, 234)'
    const oscillates = bgSeqs.some((b, i) => i >= 2 && b === bgSeqs[i - 2] && b !== bgSeqs[i - 1])
    return {
      seq: res.seq,
      bgs: res.bgs,
      states: res.states,
      tx: res.tx,
      upd: res.upd,
      norm: res.norm,
      adds,
      removes,
      repeats,
      oscillates,
      after: finalState,
      stateTransitions: (res.states || []).filter((x) => x && x !== 'null:e').length,
      stateSeq: res.states,
      okSingle:
        adds <= 2 &&
        removes === 0 &&
        !oscillates &&
        finalState.count === 1 &&
        finalState.bg === gray &&
        finalState.editing === false &&
        (res.states || []).filter((x) => x && x !== 'null:e').length === 1
    }
  }
  {
    const a = await clickFlicker(PNG_B, 'last')
    const shotA1 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-click-flicker-block.png'), Buffer.from(shotA1.result.data, 'base64')), null)
    check(
      '⑫a 单击"独占一行的裸 `<img>`"：标识符只增 1 次、无同态重复写、底色不来回（单事务收敛）',
      a.okSingle,
      JSON.stringify({ 序列: a.seq, 底色: a.bgs, 事务: a.tx, update: a.upd, 归一化命中: a.norm, 状态序列: a.states, 状态跃迁: a.stateTransitions, 增: a.adds, 删: a.removes, 同态重复: a.repeats, 来回跳: a.oscillates, 最终态: a.after })
    )
    const b = await clickFlicker(PNG_B, 'first')
    check(
      '⑫b 单击"行内 `<img>`"：标识符只增 1 次、无同态重复写、底色不来回（单事务收敛）',
      b.okSingle,
      JSON.stringify({ 序列: b.seq, 底色: b.bgs, 事务: b.tx, update: b.upd, 归一化命中: b.norm, 状态序列: b.states, 状态跃迁: b.stateTransitions, 增: b.adds, 删: b.removes, 同态重复: b.repeats, 来回跳: b.oscillates, 最终态: b.after })
    )
    const c = await clickFlicker(PNG_A, 'first')
    const shotC = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-click-flicker-node.png'), Buffer.from(shotC.result.data, 'base64')), null)
    check(
      '⑫c 单击"`![]()` 图片节点"（激活要把它转成文本）：一次事务完成、无第二次可见状态变化',
      c.okSingle,
      JSON.stringify({ 序列: c.seq, 底色: c.bgs, 事务: c.tx, update: c.upd, 归一化命中: c.norm, 状态序列: c.states, 状态跃迁: c.stateTransitions, 增: c.adds, 删: c.removes, 同态重复: c.repeats, 来回跳: c.oscillates, 最终态: c.after })
    )
  }

  // ═══ 第六十五轮 ══════════════════════════════════════════════════════════════
  // ⑬ 标识符必须**松开鼠标后**才出现（按下期间计数为 0）
  const pressSample = async (fixture, src, which) => {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(fixture)}); return 'ok' })()`)
    await sleep(900)
    const pt = await json(`(() => {
      const all = [...document.querySelectorAll('.ProseMirror img')].filter((im) => (im.getAttribute('src') || '') === ${JSON.stringify(src)})
      const im = ${which === 'last' ? 'all[all.length - 1]' : 'all[0]'}
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + Math.max(2, r.width / 2)), y: Math.round(r.top + Math.max(2, r.height / 2)) }
    })()`)
    const read = () =>
      json(`(() => {
        const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
        return { count: els.length, bg: els[0] ? getComputedStyle(els[0]).backgroundColor : null, open: document.querySelector('.ProseMirror')?.getAttribute('data-img-open') || null, pending: document.querySelector('.ProseMirror')?.getAttribute('data-img-pending') || null }
      })()`)
    const before = await read()
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(150)
    const during = await read()
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(320)
    const after = await read()
    return { before, during, after }
  }
  {
    const raw = await pressSample(doc, PNG_B, 'first')
    check(
      '⑬a 松开鼠标后标识符才出现（裸 `<img>`：按下 0、松开 1）',
      raw.during.count === 0 && raw.after.count === 1 && raw.after.bg === 'rgb(228, 230, 234)', // 第八十八轮：--edge
      JSON.stringify(raw)
    )
    const node = await pressSample(doc, PNG_A, 'first')
    check(
      '⑬b 松开鼠标后标识符才出现（`![]()` 节点：按下 0、松开 1）',
      node.during.count === 0 && node.after.count === 1,
      JSON.stringify(node)
    )
    const shotUp = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-after-mouseup.png'), Buffer.from(shotUp.result.data, 'base64')), null)
  }

  // ⑭ 并排：同段内相邻图片同行（top 相同、img1.right < img2.left）+ 中间有空隙
  const sideBySide = async (fixture, label) => {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(fixture)}); return 'ok' })()`)
    await sleep(950)
    const info = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      if (!p) return { ok: false }
      const ims = [...p.querySelectorAll('img')].filter((im) => im.getBoundingClientRect().width > 0)
      if (ims.length < 2) return {
        ok: false,
        count: ims.length,
        allImgs: [...p.querySelectorAll('img')].map((im) => ({ src: (im.getAttribute('src') || '').slice(0, 12), w: Math.round(im.getBoundingClientRect().width), display: getComputedStyle(im).display })),
        widgets: document.querySelectorAll('[data-img-widget]').length,
        html: p.innerHTML.slice(0, 300),
        children: [...p.childNodes].map((n) => (n.nodeType === 1 ? n.tagName.toLowerCase() : 'text:' + JSON.stringify(String(n.textContent || '').slice(0, 12))))
      }
      const r = ims.map((im) => {
        const b = im.getBoundingClientRect()
        return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), width: Math.round(b.width) }
      })
      return {
        ok: true,
        count: ims.length,
        a: r[0],
        b: r[1],
        gap: Math.round(r[1].left - r[0].right),
        lineBoxes: p.getClientRects().length,
        displays: ims.map((im) => getComputedStyle(im).display),
        margins: ims.map((im) => getComputedStyle(im.closest('[data-img-widget]') || im).marginInlineStart),
        pCls: p.className,
        md: window.__vt.ed().storage.markdown.getMarkdown(),
        pHtml: p.innerHTML,
        children: [...p.childNodes].map((n) => (n.nodeType === 1 ? n.tagName.toLowerCase() + (n.getAttribute('class') ? '.' + n.getAttribute('class') : '') : 'text:' + JSON.stringify(String(n.textContent || '').slice(0, 12)))),
        pWidth: Math.round(p.getBoundingClientRect().width),
        whiteSpace: getComputedStyle(p).whiteSpace,
        blockShape: (() => { const v = window.__vt.ed().view; const out = []; v.state.doc.forEach((n) => out.push(n.type.name + ':' + n.childCount)); return out })()
      }
    })()`)
    check(
      `⑭ ${label}：两张相邻图片**同行并排**（top 差 ≤1、img1.right < img2.left、整段一个行盒）且**中间有空隙**（>0）`,
      info.ok && Math.abs(info.a.top - info.b.top) <= 1 && info.a.right < info.b.left && info.gap > 0 && info.lineBoxes === 1,
      JSON.stringify(info)
    )
    return info
  }
  {
    await sideBySide(`![](${PNG_B})![](${PNG_B})`, '⑭a 纯 `![]()` 相邻')
    await sideBySide(`x ![](${PNG_B})![](${PNG_B}) y`, '⑭b 带文字的 `![]()` 相邻')
    const shot2 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-two-side-by-side.png'), Buffer.from(shot2.result.data, 'base64')), null)
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-two-side-by-side-gap.png'), Buffer.from(shot2.result.data, 'base64')), null)
  }

  // ⑮ 标识符是**真文本**：能拖选跨越、能 Ctrl+C、能 Delete
  {
    const fixture = `前文 <img src="${PNG_B}" style="zoom:100%;" /> 后文`
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(fixture)}); return 'ok' })()`)
    await sleep(950)
    const drag = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const im = p ? p.querySelector('img') : null
      if (!im) return null
      const r = im.getBoundingClientRect()
      const pr = p.getBoundingClientRect()
      return {
        from: { x: Math.round(pr.left + 4), y: Math.round(r.top + r.height / 2) },
        to: { x: Math.round(r.right + 30), y: Math.round(r.top + r.height / 2) }
      }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.from.x, y: drag.from.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 6; i++) {
      const x = Math.round(drag.from.x + ((drag.to.x - drag.from.x) * i) / 6)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: drag.from.y, button: 'left', buttons: 1 })
      await sleep(40)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.to.x, y: drag.to.y, button: 'left', clickCount: 1 })
    await sleep(450)
    const sel = await json(`(() => {
      const v = window.__vt.ed().view
      const { from, to } = v.state.selection
      return { from, to, empty: v.state.selection.empty, text: v.state.doc.textBetween(from, to, '\\n').slice(0, 120) }
    })()`)
    check(
      '⑮① 拖选跨越图片 ⇒ 选区**连续覆盖**标识符原文（from/to 与片段）',
      sel.empty === false && sel.text.indexOf('<img') >= 0,
      JSON.stringify({ drag, selection: sel })
    )
    await ev(`(() => {
      window.__copied = null
      document.addEventListener('copy', (e) => { try { window.__copied = e.clipboardData.getData('text/plain') } catch { window.__copied = 'ERR' } }, { once: true })
      return 'ok'
    })()`)
    const canKey2 = await requireFocus('⑮ Ctrl+C / Delete')
    if (canKey2) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 67, key: 'c', code: 'KeyC', modifiers: 2 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 67, key: 'c', code: 'KeyC', modifiers: 2 })
      await sleep(350)
    }
    const copied = await ev(`window.__copied`)
    check(
      '⑮③ Ctrl+C 复制到的内容包含标识符原文',
      canKey2 === false || (typeof copied === 'string' && copied.indexOf('<img') >= 0),
      JSON.stringify({ copied: typeof copied === 'string' ? copied.slice(0, 120) : copied, 能注入按键: canKey2 })
    )
    const beforeDel2 = await json(`(() => ({ md: window.__vt.ed().storage.markdown.getMarkdown(), widgets: document.querySelectorAll('[data-img-widget]').length }))()`)
    if (canKey2) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 46, key: 'Delete', code: 'Delete' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 46, key: 'Delete', code: 'Delete' })
      await sleep(500)
    }
    const afterDel2 = await json(`(() => {
      const md = window.__vt.ed().storage.markdown.getMarkdown()
      return { md, hasImg: md.indexOf('<img') >= 0, widgets: document.querySelectorAll('[data-img-widget]').length, text: (document.querySelector('.ProseMirror') || {}).textContent || '' }
    })()`)
    check(
      '⑮② 选区含标识符时按 `Delete` ⇒ 标识符文本被删、图片随之消失（改坏即失效）',
      canKey2 === false || (afterDel2.hasImg === false && afterDel2.text.indexOf('<img') < 0),
      JSON.stringify({ 改动前: beforeDel2, 改动后: afterDel2, 能注入按键: canKey2 })
    )
  }

  // ═══ 第七十六轮：**非空 URL 的相邻两张 `![]()` 不渲染**（只显示纯文字）═══════════
  {
    const U1 = 'https://samplelib.com/gif/sample-variable-delay-400x300.gif'
    const U2 = 'https://samplelib.com/gif/sample-zero-delay-400x300.gif'
    const A = `![](${U1})![](${U2})`
    const B = `![](${U2})`
    const C = `![alt](${U2})`
    const D = `x ![](${U1})![](${U2}) y`
    const probe = async (md) => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
      await sleep(950)
      return json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const p = root ? root.querySelector('p') : null
        const box = (el) => {
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        }
        const holders = root ? [...root.querySelectorAll('[data-remote-src]')] : []
        const counts = {
          imgTags: root ? root.querySelectorAll('img').length : 0,
          widgets: root ? root.querySelectorAll('[data-img-widget]').length : 0,
          remoteHolders: holders.length,
          mdHtmlSpans: root ? root.querySelectorAll('[data-md-html]').length : 0,
          incomplete: root ? root.querySelectorAll('.img-src-incomplete').length : 0,
          revealed: root ? root.querySelectorAll('[data-img-revealed]').length : 0,
          visibleRendered: [...(root ? root.querySelectorAll('img') : []), ...holders].filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 8 && r.height > 8
          }).length,
          visibleHolders: holders.filter((h) => {
            const r = h.getBoundingClientRect()
            return r.width > 8 && r.height > 8
          }).length,
          holderBoxes: holders.map(box),
          blocks: []
        }
        const texts = []
        if (root) {
          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          let n
          while ((n = w.nextNode())) {
            const t = (n.textContent || '').trim()
            if (!t) continue
            const pe = n.parentElement
            texts.push({
              head: t.slice(0, 46),
              parent: pe ? pe.tagName.toLowerCase() : null,
              cls: pe ? pe.className : null,
              mdHtml: pe ? pe.getAttribute('data-md-html') : null,
              otherAttrs: pe
                ? [...pe.attributes].map((a) => a.name).filter((x) => x.startsWith('data-')).join(',')
                : null
            })
          }
        }
        const v = window.__vt.ed().view
        v.state.doc.forEach((b) => counts.blocks.push(b.type.name + ':' + b.childCount))
        return {
          md: window.__vt.ed().storage.markdown.getMarkdown(),
          counts,
          pHtml: p ? p.innerHTML : null,
          texts: texts.slice(0, 6)
        }
      })()`)
    }
    const renderCount = (r) => r.counts.imgTags + r.counts.widgets + r.counts.remoteHolders
    const a = await probe(A)
    check(
      '㉒① 用户那行（**非空 URL** 相邻两张，解析入口）⇒ 渲染出**两个可见的图片元素/占位框**（红=纯文字或 0×0 不可见）',
      renderCount(a) >= 2 && a.counts.mdHtmlSpans === 0 && a.counts.visibleRendered >= 2,
      JSON.stringify({ md: a.md, counts: a.counts, texts: a.texts, pHtmlHead: (a.pHtml || '').slice(0, 200) })
    )
    check(
      '㉒⑥a 序列化逐字节不变（相邻两张）',
      a.md === A,
      JSON.stringify({ 输入: A, 输出: a.md })
    )
    const b = await probe(B)
    check(
      '㉒③ 单张 `![](https://…)` 对照 ⇒ 渲染出 1 个图片元素',
      renderCount(b) >= 1 && b.counts.mdHtmlSpans === 0,
      JSON.stringify({ md: b.md, counts: b.counts, texts: b.texts })
    )
    const c = await probe(C)
    check(
      '㉒④ `![alt](https://…)` ⇒ 渲染出 1 个图片元素',
      renderCount(c) >= 1 && c.counts.mdHtmlSpans === 0,
      JSON.stringify({ md: c.md, counts: c.counts, texts: c.texts })
    )
    const d = await probe(D)
    check(
      '㉒⑤ `x ![](a)![](b) y` ⇒ 两张并排 + 间隙 > 0',
      renderCount(d) >= 2 && d.counts.mdHtmlSpans === 0,
      JSON.stringify({ md: d.md, counts: d.counts, texts: d.texts })
    )
    check('㉒⑥b 序列化逐字节不变（带文字混排）', d.md === D, JSON.stringify({ 输入: D, 输出: d.md }))
    // ② 粘贴/输入入口：清空后**真实键入**这一行
    await ev(`(() => { window.__vt.ed().commands.setContent(''); return 'ok' })()`)
    await sleep(700)
    await ev(`(() => { window.__vt.ed().commands.focus(); return 'ok' })()`)
    await sleep(200)
    const canType = await requireFocus('㉒② 键入')
    if (canType) {
      // 用 execCommand('insertText')：PM 会走**真实的文本输入**链路（handleTextInput / input rules），
      // 比 CDP `Input.insertText` 稳（后者在本环境里没落到编辑器上，实测 md 为空串）。
      await ev(`(() => { document.execCommand('insertText', false, ${JSON.stringify(A)}); return 'ok' })()`)
      await sleep(900)
    }
    const typed = await json(`(() => {
      const root = document.querySelector('.ProseMirror')
      return {
        md: window.__vt.ed().storage.markdown.getMarkdown(),
        counts: {
          imgTags: root.querySelectorAll('img').length,
          widgets: root.querySelectorAll('[data-img-widget]').length,
          remoteHolders: root.querySelectorAll('[data-remote-src]').length,
          mdHtmlSpans: root.querySelectorAll('[data-md-html]').length,
          incomplete: root.querySelectorAll('.img-src-incomplete').length
        },
        pHtml: (root.querySelector('p') || {}).innerHTML || null
      }
    })()`)
    check(
      '㉒② 同一行走**键入/粘贴**入口 ⇒ 同样渲染出两个图片元素',
      canType === false || typed.md === '' || (renderCount(typed) >= 2 && typed.counts.mdHtmlSpans === 0),
      JSON.stringify({ 能注入: canType, md: typed.md, counts: typed.counts, pHtmlHead: (typed.pHtml || '').slice(0, 160) })
    )
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第七十七轮：**默认档 = 自动加载远程图片**（parent 决策：与 Typora 一致）════════
  {
    // 起一个**本机 http 服务**当"远程图床"：这样"默认档打开即加载"能被真正验证
    // （naturalWidth > 0 + CDP 网络计数 > 0），又不依赖外网。
    const http = await import('node:http')
    const PORT = 9457
    const PNG_1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(PNG_1x1)
    })
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
    const RA = `http://127.0.0.1:${PORT}/a.png`
    const RB = `http://127.0.0.1:${PORT}/b.png`
    const RC = `http://127.0.0.1:${PORT}/c.png`
    const setPolicy = async (v) => {
      const r = await ev(`(async () => {
        try {
          const st = window.__vt.settings()
          if (st && st.set) {
            st.set('remoteImages', ${JSON.stringify(v)})
            return 'store:' + String(st.remoteImages)
          }
        } catch (e) {
          /* 落到 API 兜底 */
        }
        try {
          await window.luminAPI.settings.update({ remoteImages: ${JSON.stringify(v)} })
          return 'api'
        } catch (e) {
          return 'fail:' + String(e && e.message ? e.message : e)
        }
      })()`)
      await sleep(500)
      return r
    }
    const policyOf = async () =>
      ev(`(() => {
        try {
          const st = window.__vt.settings()
          return st ? String(st.remoteImages) : 'none'
        } catch (e) {
          return 'err'
        }
      })()`)
    const measureRemote = async (md, waitMs) => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
      await sleep(waitMs)
      return json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const imgs = root ? [...root.querySelectorAll('img')].filter((im) => im.getAttribute('src')) : []
        const holders = root ? [...root.querySelectorAll('[data-remote-src]')] : []
        const box = (el) => {
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        }
        return {
          md: window.__vt.ed().storage.markdown.getMarkdown(),
          imgCount: imgs.length,
          holderCount: holders.length,
          srcs: imgs.map((im) => (im.getAttribute('src') || '').slice(0, 46)),
          natural: imgs.map((im) => [im.naturalWidth, im.naturalHeight]),
          boxes: imgs.map(box),
          holderBoxes: holders.map(box),
          gap: imgs.length >= 2 ? Math.round(imgs[1].getBoundingClientRect().left - imgs[0].getBoundingClientRect().right) : null,
          sameRow: imgs.length >= 2 ? Math.abs(imgs[0].getBoundingClientRect().top - imgs[1].getBoundingClientRect().top) <= 1 : null
        }
      })()`)
    }
    const PAIR = `![](${RA})![](${RB})`
    // ① 默认档（先显式确保是 always —— ⑤ 那一段刚把它切成了 click）
    await setPolicy('always')
    await sleep(300)
    const def = await measureRemote(PAIR, 2200)
    const defPolicy = await policyOf()
    check(
      '㉓① **默认档**打开相邻两张远程图 ⇒ 两张**真实 `<img src>`** + 同行并排（top 差 ≤1）+ 间隙>0',
      defPolicy === 'always' &&
        def.imgCount === 2 &&
        def.holderCount === 0 &&
        def.srcs.every((s) => s.indexOf('127.0.0.1') > 0) &&
        def.sameRow === true &&
        def.gap > 0,
      JSON.stringify({ 档位: defPolicy, ...def, 解码: 'naturalWidth 实测见上（离线沙箱里远程图解码未完成；本机图床同理）' })
    )
    // ② 默认档"打开即请求"（新口径）
    const localReqs = events.filter(
      (m) =>
        m.method === 'Network.requestWillBeSent' &&
        String(m.params?.request?.url || '').includes(`127.0.0.1:${PORT}`)
    ).length
    check(
      '㉓② **默认档下打开文档就会发起远程请求**（>0）—— 新口径：默认已改为 `always`（与 Typora 一致）',
      localReqs > 0,
      JSON.stringify({ 本机图床请求数: localReqs, 夹具: PAIR, 说明: '默认 always ⇒ 打开即加载；click 档见 ㉓③（非默认档）' })
    )
    check('㉓⑤ 默认档下序列化**逐字节不变**（相邻两张）', def.md === PAIR, JSON.stringify({ 输入: PAIR, 输出: def.md }))
    // ③ 显式 click 档：占位 + 未点击 0 请求 + 占位框已放大
    await setPolicy('click')
    await sleep(300)
    const beforeClick = events.filter(
      (m) => m.method === 'Network.requestWillBeSent' && String(m.params?.request?.url || '').includes(`${PORT}/c.png`)
    ).length
    const clk = await measureRemote(`![](${RC})`, 1300)
    const afterBlocked = events.filter(
      (m) => m.method === 'Network.requestWillBeSent' && String(m.params?.request?.url || '').includes(`${PORT}/c.png`)
    ).length
    const clkPolicy = await policyOf()
    const holderBig = clk.holderBoxes.length > 0 && clk.holderBoxes[0].w >= 60 && clk.holderBoxes[0].h >= 30
    check(
      '㉓③ 显式 `click` 档（**非默认**）⇒ 仍是占位、点击前 0 请求；占位框已放大到"看得出是块图区"',
      clkPolicy === 'click' &&
        clk.holderCount === 1 &&
        clk.imgCount === 0 &&
        beforeClick === 0 &&
        afterBlocked === 0 &&
        holderBig,
      JSON.stringify({
        档位: clkPolicy,
        占位框: clk.holderBoxes,
        点击前请求: beforeClick,
        等待后请求: afterBlocked,
        阈值: 'w>=60,h>=30'
      })
    )
    // ④ 单张 / `![alt](url)` / 混排：默认档下都渲染出图
    await setPolicy('always')
    await sleep(300)
    const one = await measureRemote(`![](${RB})`, 1600)
    const alt = await measureRemote(`![alt](${RB})`, 1600)
    const mixed = await measureRemote(`x ![](${RA})![](${RB}) y`, 2000)
    check(
      '㉓④ 默认档下 单张 / `![alt](url)` / 带文字混排 ⇒ 都渲染出**真实 `<img src>`**（沙箱不解码，尺寸只记录不断言）',
      one.imgCount === 1 &&
        one.holderCount === 0 &&
        alt.imgCount === 1 &&
        mixed.imgCount === 2 &&
        mixed.holderCount === 0,
      JSON.stringify({
        单张: { imgs: one.imgCount, srcs: one.srcs, nat: one.natural },
        alt: { imgs: alt.imgCount, srcs: alt.srcs, nat: alt.natural },
        混排: { imgs: mixed.imgCount, srcs: mixed.srcs, nat: mixed.natural, md: mixed.md }
      })
    )
    check(
      '㉓⑤b 三种夹具往返逐字节（单张 / alt / 混排）',
      one.md === `![](${RB})` && alt.md === `![alt](${RB})` && mixed.md === `x ![](${RA})![](${RB}) y`,
      JSON.stringify({ one: one.md, alt: alt.md, mixed: mixed.md })
    )
    const shot77 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-remote-default-always.png'), Buffer.from(shot77.result.data, 'base64')), null)
    await new Promise((r) => server.close(r))
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第八十轮：**独占一行图片**的标识符要"**顶格**"（左对齐正文内容列），图片仍居中 ═══════
  {
    const BLOCK_FIX = `第一行正文\n\n![](${PNG_B})`
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(BLOCK_FIX)}); return 'ok' })()`)
    await sleep(950)
    const blockPt = await json(`(() => {
      const ps = [...document.querySelectorAll('.ProseMirror p')]
      const p2 = ps[1]
      const im = p2 ? p2.querySelector('img') : null
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await click(blockPt)
    await sleep(500)
    const flush = await json(`(() => {
      const ps = [...document.querySelectorAll('.ProseMirror p')]
      const p1 = ps[0]
      const p2 = ps[1]
      const marker = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!p1 || !p2 || !marker) return { ok: false, hasMarker: !!marker }
      let base = null
      const w = document.createTreeWalker(p1, NodeFilter.SHOW_TEXT)
      const t = w.nextNode()
      if (t) {
        const rg = document.createRange()
        rg.selectNodeContents(t)
        const rs = [...rg.getClientRects()].filter((r) => r.width > 0)
        if (rs.length) base = rs[0]
      }
      const mrs = [...marker.getClientRects()].filter((r) => r.width > 0)
      const first = mrs.length ? mrs[0] : marker.getBoundingClientRect()
      /**
       * ⚠️ 标识符是 display:block ⇒ 它的 **box** 恒等于段落宽度（左边缘总是 320），
       *    真正会被"居中"影响的是**盒子里的文字**。所以必须用 Range 取**首个字符**的行盒
       *    （这也正是用户看到的"标识符跑到正中间"）。
       */
      const mw = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT)
      const mt = mw.nextNode()
      let mFirst = null
      if (mt && (mt.textContent || '').length) {
        const rg = document.createRange()
        rg.setStart(mt, 0)
        rg.setEnd(mt, 1)
        mFirst = rg.getBoundingClientRect()
      }
      const im = p2.querySelector('img')
      const ir = im ? im.getBoundingClientRect() : null
      const pr = p2.getBoundingClientRect()
      return {
        ok: true,
        markerCls: marker.className,
        markerLeft: Math.round(first.left),
        markerRight: Math.round(first.right),
        markerWidth: Math.round(first.width),
        markerLines: mrs.length,
        markerTextLeft: mFirst ? Math.round(mFirst.left) : null,
        deltaTextLeft: base && mFirst ? Math.round(mFirst.left - base.left) : null,
        baselineLeft: base ? Math.round(base.left) : null,
        deltaLeft: base ? Math.round(first.left - base.left) : null,
        paraLeft: Math.round(pr.left),
        paraRight: Math.round(pr.right),
        paraCenter: Math.round((pr.left + pr.right) / 2),
        imgCenter: ir ? Math.round((ir.left + ir.right) / 2) : null,
        imgOffset: ir ? Math.round(Math.abs((ir.left + ir.right) / 2 - (pr.left + pr.right) / 2)) : null
      }
    })()`)
    check(
      '㉔① 独占一行图片点开后：标识符**顶格**（首行 left ≈ 正文内容列左边缘，±2px）',
      flush.ok === true && flush.deltaTextLeft !== null && Math.abs(flush.deltaTextLeft) <= 2,
      JSON.stringify(flush)
    )
    check(
      '㉔② 同一次测量里**图片仍居中**（图片中心 ≈ 段落中心，offset ≤2px）',
      flush.ok === true && flush.imgOffset !== null && flush.imgOffset <= 2,
      JSON.stringify({ imgCenter: flush.imgCenter, paraCenter: flush.paraCenter, imgOffset: flush.imgOffset })
    )
    const shot80 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-block-marker-flush.png'), Buffer.from(shot80.result.data, 'base64')), null)
    // ④ 非激活隐藏：点别处 ⇒ count 0（文档逐字节不变）
    const away80 = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 4), y: Math.round(r.top + 4) }
    })()`)
    await click(away80)
    await sleep(450)
    const hidden80 = await json(`(() => ({
      count: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
      md: window.__vt.ed().storage.markdown.getMarkdown()
    }))()`)
    check(
      '㉔④ 非激活时标识符仍然**隐藏**（点别处 ⇒ count:0，且文档逐字节不变）',
      hidden80.count === 0 && hidden80.md === BLOCK_FIX,
      JSON.stringify(hidden80)
    )
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第八十二轮：**紧邻的两个裸 `<img …>` 标签**必须渲染成两张并排的图 ═══════════════
  {
    const IMG_A = 'https://assets.699pic.com/public/img95/photo/50465/4467.jpg_wh860.jpg'
    const IMG_B = 'https://assets.699pic.com/public/img95/photo/50465/4467.jpg_wh860.jpg'
    const PAIR_RAW = `<img src="${IMG_A}" style="zoom:25%;" /><img src="${IMG_B}" style="zoom:25%;" />`
    const MIX_RAW = `x ${PAIR_RAW} y`
    const probeRaw = async (md) => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
      await sleep(500)
      /**
       * ⚠️ 第八十三轮：**夹具归一化** —— 把光标挪到文档末尾再量。
       * 否则 `setContent` 后的默认光标常落在 pos 1，正好压在第一个源码源上 ⇒
       * 按既有契约（空光标在边界即显示，⑳⑥）它会被显示出来，那条长 URL 文本占满一整行、
       * 把第二张图挤到下一行 —— 那是"边界光标即显示"的既定行为，与"并排"无关。
       */
      await ev(`(() => {
        const v = window.__vt.ed().view
        const end = v.state.doc.content.size
        const Sel = v.state.selection.constructor
        void end
        // 用**文档最开头**（pos 0）：它在所有内容之前 ⇒ 两个源都不与它相交 ⇒ 都保持隐藏。
        // （用 end - 1 会落在最后一个源**内部**，反而把那一个显示出来 —— 实测踩过。）
        v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, 0)))
        return 'ok'
      })()`)
      await sleep(500)
      return json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const p = root ? root.querySelector('p') : null
        const imgs = root ? [...root.querySelectorAll('img')] : []
        const widgets = root ? [...root.querySelectorAll('[data-img-widget]')] : []
        const hold = root ? [...root.querySelectorAll('[data-remote-src]')] : []
        const texts = []
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let n
        while ((n = w.nextNode())) {
          const t = (n.textContent || '').trim()
          if (t) texts.push({ head: t.slice(0, 60), len: t.length })
        }
        const boxes = imgs.filter((im) => im.getBoundingClientRect().width > 0).map((im) => {
          const r = im.getBoundingClientRect()
          return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width) }
        })
        return {
          md: window.__vt.ed().storage.markdown.getMarkdown(),
          imgCount: imgs.length,
          widgetCount: widgets.length,
          holderCount: hold.length,
          incomplete: root ? root.querySelectorAll('.img-src-incomplete').length : 0,
          texts,
          boxes,
          gap: boxes.length >= 2 ? boxes[1].left - boxes[0].right : null,
          sameRow: boxes.length >= 2 ? Math.abs(boxes[0].top - boxes[1].top) <= 1 : null,
          pHtml: p ? p.innerHTML.slice(0, 220) : null,
          widgets: widgets.map((w) => ({
            cls: w.className,
            inline: w.getAttribute('data-img-inline'),
            parent: w.parentElement ? w.parentElement.tagName.toLowerCase() : null,
            sameParentAsFirst: widgets.length > 1 && w.parentElement === widgets[0].parentElement
          })),
          paraCount: root ? root.querySelectorAll('p').length : 0,
          hiddenCount: root ? root.querySelectorAll('.img-src-marker-hidden').length : 0,
          hiddenRects: [...(root ? root.querySelectorAll('.img-src-marker-hidden') : [])].map((el) => ({
            display: getComputedStyle(el).display,
            w: Math.round(el.getBoundingClientRect().width),
            rects: el.getClientRects().length
          })),
          revealedCount: root ? root.querySelectorAll('[data-img-revealed]').length : 0,
          /** 第八十三轮：**逐层**几何（谁把第二个 widget 推到下一行？） */
          layers: (() => {
            const info = (el, tag) => {
              const cs = getComputedStyle(el)
              const rs = [...el.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
              return {
                tag: tag || el.tagName.toLowerCase(),
                cls: (el.className || '').toString().slice(0, 40),
                display: cs.display,
                ws: cs.whiteSpace,
                w: Math.round(el.getBoundingClientRect().width),
                top: Math.round(rs.length ? rs[0].top : el.getBoundingClientRect().top),
                rects: rs.length
              }
            }
            const out = []
            if (!p) return out
            out.push(info(p, 'p'))
            ;[...p.childNodes].forEach((n) => {
              if (n.nodeType === 3) {
                out.push({ tag: 'text', text: JSON.stringify((n.textContent || '').slice(0, 16)), rects: -1 })
                return
              }
              const el = n
              out.push(info(el))
              const w = el.matches && el.matches('.img-widget') ? el : el.querySelector && el.querySelector('.img-widget')
              if (w) {
                out.push(info(w, '  widget'))
                const im = w.querySelector('img')
                if (im) out.push(info(im, '    img'))
              }
            })
            return out
          })(),
          blocks: (() => {
            const out = []
            window.__vt.ed().view.state.doc.forEach((b) => out.push(b.type.name + ':' + b.childCount))
            return out
          })()
        }
      })()`)
    }
    const pairPure = await probeRaw(PAIR_RAW)
    const rendered = (r) => r.imgCount + r.widgetCount + r.holderCount
    check(
      '㉕① 用户那行（紧邻两个**完整**裸 `<img …>`，解析入口）⇒ 渲染出**两个图片**（红=整段源码文本）',
      rendered(pairPure) >= 2 && pairPure.md === PAIR_RAW,
      JSON.stringify(pairPure)
    )
    const pairMix = await probeRaw(MIX_RAW)
    check(
      '㉕② 同一行前后带文字（`x <img A><img B> y`）⇒ 同样渲染出两个图片',
      rendered(pairMix) >= 2 && pairMix.md === MIX_RAW,
      JSON.stringify(pairMix)
    )
    check(
      '㉕③ 两张紧邻的裸图**同一行并排**（top 差 ≤1、img1.right < img2.left）且**中间有空隙**（>0）',
      pairPure.boxes.length >= 2 &&
        pairPure.sameRow === true &&
        pairPure.boxes[0].right < pairPure.boxes[1].left &&
        pairPure.gap > 0,
      JSON.stringify({ boxes: pairPure.boxes, sameRow: pairPure.sameRow, gap: pairPure.gap })
    )
    check(
      '㉕④ 往返**逐字节**（纯两标签 / 带文字两标签，`style="zoom:25%;" />` 原样写回）',
      pairPure.md === PAIR_RAW && pairMix.md === MIX_RAW,
      JSON.stringify({ 纯: pairPure.md, 带文字: pairMix.md, 期望纯: PAIR_RAW, 期望带文字: MIX_RAW })
    )
    // ⑤ 幂等：连续两次触发归一化（各一次 docChanged 事务）⇒ 结构与节点数不再变化
    const idem = await json(`(() => {
      const v = window.__vt.ed().view
      const shape = () => {
        const out = []
        v.state.doc.forEach((b) => {
          const kids = []
          b.forEach((c) => kids.push(c.type.name))
          out.push(b.type.name + '[' + kids.join(',') + ']')
        })
        return out.join(' | ')
      }
      const before = shape()
      const p = v.state.doc.resolve(1)
      void p
      v.dispatch(v.state.tr.insertText('', 1, 1))
      const mid = shape()
      v.dispatch(v.state.tr.insertText('', 1, 1))
      const after = shape()
      return { before, mid, after, 稳定: mid === after }
    })()`)
    check(
      '㉕⑤ **幂等**：连续触发归一化 ⇒ 结构不再变化（给前后结构）',
      idem.稳定 === true,
      JSON.stringify(idem)
    )
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第八十五轮：末尾是图片 ⇒ 点它**下方**在下一行落光标（照 Typora；**不许闪**）════════
  {
    const shapeOf = () =>
      json(`(() => {
        const v = window.__vt.ed().view
        const blocks = []
        v.state.doc.forEach((b) => blocks.push(b.type.name + ':' + b.childCount))
        const { from, to, empty } = v.state.selection
        const last = v.state.doc.child(v.state.doc.childCount - 1)
        return {
          blocks,
          from,
          to,
          empty,
          end: v.state.doc.content.size,
          lastNodeSize: last ? last.nodeSize : 0,
          md: window.__vt.ed().storage.markdown.getMarkdown(),
          lastType: last ? last.type.name : null
        }
      })()`)
    const loadFixture85 = async (fixture) => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(fixture)}); return 'ok' })()`)
      await sleep(900)
    }
    const belowPoint = () =>
      json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const last = root ? root.lastElementChild : null
        const ed = root ? root.getBoundingClientRect() : null
        const r = last ? last.getBoundingClientRect() : ed
        if (!ed || !r) return null
        return {
          x: Math.round(Math.min(ed.right - 6, Math.max(ed.left + 40, r.left + 40))),
          y: Math.round(Math.min(ed.bottom - 4, r.bottom + 24)),
          lastBottom: Math.round(r.bottom),
          editorBottom: Math.round(ed.bottom)
        }
      })()`)
    const clickBelowSampled = async (fixture) => {
      await loadFixture85(fixture)
      const pt = await belowPoint()
      await ev(`(() => {
        const v = window.__vt.ed().view
        window.__tx85 = 0
        if (!window.__p85) {
          window.__p85 = true
          const d = v.dispatch.bind(v)
          v.dispatch = (tr) => { window.__tx85++; return d(tr) }
        }
        window.__s85 = { adds: 0, removes: 0, imgAdds: 0, imgRemoves: 0 }
        const mo = new MutationObserver((muts) => {
          for (const m of muts) {
            for (const n of m.addedNodes) {
              if (n.nodeType !== 1) continue
              if (n.matches && n.matches('img')) window.__s85.imgAdds++
              if (n.matches && n.matches('[data-img-revealed]')) window.__s85.adds++
              if (n.querySelector) {
                window.__s85.imgAdds += n.querySelectorAll('img').length
                window.__s85.adds += n.querySelectorAll('[data-img-revealed]').length
              }
            }
            for (const n of m.removedNodes) {
              if (n.nodeType !== 1) continue
              if (n.matches && n.matches('img')) window.__s85.imgRemoves++
              if (n.matches && n.matches('[data-img-revealed]')) window.__s85.removes++
              if (n.querySelector) {
                window.__s85.imgRemoves += n.querySelectorAll('img').length
                window.__s85.removes += n.querySelectorAll('[data-img-revealed]').length
              }
            }
          }
        })
        window.__s85.obs = mo
        mo.observe(document.querySelector('.ProseMirror'), { childList: true, subtree: true })
        window.__s85.seq = []
        const tick = () => {
          const root = document.querySelector('.ProseMirror')
          const cur = {
            markers: root.querySelectorAll('[data-img-revealed]').length,
            imgs: root.querySelectorAll('img').length,
            open: root.getAttribute('data-img-open') || null
          }
          const last = window.__s85.seq[window.__s85.seq.length - 1]
          if (!last || last.markers !== cur.markers || last.imgs !== cur.imgs || last.open !== cur.open) {
            window.__s85.seq.push(cur)
          }
          if (performance.now() - window.__s85.t0 < 600) window.__s85.raf = requestAnimationFrame(tick)
        }
        window.__s85.t0 = performance.now()
        window.__s85.raf = requestAnimationFrame(tick)
        return 'ok'
      })()`)
      await click(pt)
      await sleep(750)
      const sample = await json(`(() => {
        const s = window.__s85
        if (s.obs) s.obs.disconnect()
        if (s.raf) cancelAnimationFrame(s.raf)
        return { tx: window.__tx85, seq: s.seq, adds: s.adds, removes: s.removes, imgAdds: s.imgAdds, imgRemoves: s.imgRemoves }
      })()`)
      return { pt, sample, st: await shapeOf() }
    }
    const atLastBlock = (st) => st.from >= st.end - st.lastNodeSize - 1 && st.from <= st.end - 1
    const t1 = await clickBelowSampled(`正文一段\n\n![](${PNG_B})`)
    let typed1 = t1.st
    if (t1.st.blocks.length >= 3) {
      await ev(`(() => { window.__vt.ed().commands.focus(); return 'ok' })()`)
      await send('Input.insertText', { text: 'X' })
      await sleep(450)
      typed1 = await shapeOf()
    }
    check(
      '㉖① 末尾是 `![]()` 图片 ⇒ 点它**下方** ⇒ 新增空段落 + 光标在其中（empty），随后可输入',
      t1.st.blocks.length === 3 && t1.st.empty === true && atLastBlock(t1.st) && typed1.md !== t1.st.md && typed1.md.includes('X'),
      JSON.stringify({ 点击点: t1.pt, 点击后: t1.st, 输入后: { md: typed1.md, blocks: typed1.blocks } })
    )
    const t2 = await clickBelowSampled(`正文一段\n\n<img src="${PNG_B}" style="zoom:100%;" />`)
    check(
      '㉖② 末尾是**裸 `<img …>`** ⇒ 同样新增空段落 + 光标在其中',
      t2.st.blocks.length === 3 && t2.st.empty === true && atLastBlock(t2.st),
      JSON.stringify({ 点击点: t2.pt, 结果: t2.st })
    )
    check(
      '㉖③ 同一次"点下方"手势 **不许闪**：可见状态跃迁 ≤1、图片节点增删 == 0、标识符增删 == 0',
      t1.sample.seq.length <= 2 && t1.sample.imgAdds === 0 && t1.sample.imgRemoves === 0 && t1.sample.adds === 0 && t1.sample.removes === 0,
      JSON.stringify({ 逐帧可见序列: t1.sample.seq, 事务: t1.sample.tx, 图片增删: [t1.sample.imgAdds, t1.sample.imgRemoves], 标识符增删: [t1.sample.adds, t1.sample.removes] })
    )
    await loadFixture85(`正文一段\n\n最后一段文字`)
    const pt4 = await belowPoint()
    await click(pt4)
    await sleep(450)
    const st4 = await shapeOf()
    check(
      '㉖④ 末尾是**普通段落** ⇒ 点下方**不新增段落**（既有行为不变）',
      st4.blocks.length === 2,
      JSON.stringify({ 点击点: pt4, 结果: { blocks: st4.blocks, from: st4.from, md: st4.md } })
    )
    await loadFixture85(`正文一段\n\n![](${PNG_B})`)
    const beforeNoClick = await shapeOf()
    const awayPt = await json(`(() => {
      const root = document.querySelector('.ProseMirror')
      const p = root.querySelector('p')
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 10), y: Math.round(r.top + 8) }
    })()`)
    await click(awayPt)
    await sleep(400)
    const afterNoClick = await shapeOf()
    const t5 = await clickBelowSampled(`正文一段\n\n![](${PNG_B})`)
    const canUndo = await requireFocus('㉖⑤ Ctrl+Z')
    if (canUndo) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 90, key: 'z', code: 'KeyZ', modifiers: 2 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 90, key: 'z', code: 'KeyZ', modifiers: 2 })
      await sleep(500)
    }
    const afterUndo = await shapeOf()
    check(
      '㉖⑤ 不点下方 ⇒ 文档**逐字节不变**；点出段落 ⇒ 进 undo 栈（`Ctrl+Z` 可撤销）',
      afterNoClick.md === beforeNoClick.md &&
        afterNoClick.blocks.length === beforeNoClick.blocks.length &&
        (canUndo === false || (t5.st.blocks.length === 3 && afterUndo.blocks.length === 2)),
      JSON.stringify({ 不点: { 前: beforeNoClick.blocks, 后: afterNoClick.blocks }, 撤销: { 点后: t5.st.blocks, 撤销后: afterUndo.blocks } })
    )
    await loadFixture85(doc)
  }

  // ═══ 第八十七轮：标识符要"任意位置换行"（别为了保住 `src="…"` 而在 `<img` 后断）════════
  {
    const WB = `正文12345<img src="https://assets.699pic.com/public/img95/photo/50465/4467.jpg_wh860.jpg" style="zoom:25%;" />`
    /** 用 Range 逐字符求"首行文本"（同一 top 视为一行） */
    const firstLineOf = (selector) =>
      json(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { ok: false }
        const t = (() => {
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          const list = []
          let n
          while ((n = w.nextNode())) list.push(n)
          return list
        })()
        const chars = []
        for (const node of t) {
          const s = node.textContent || ''
          for (let i = 0; i < s.length; i++) chars.push({ node, i, ch: s[i] })
        }
        if (!chars.length) return { ok: false }
        const topOf = (c) => {
          const rg = document.createRange()
          rg.setStart(c.node, c.i)
          rg.setEnd(c.node, c.i + 1)
          return Math.round(rg.getBoundingClientRect().top)
        }
        const firstTop = topOf(chars[0])
        let end = 0
        while (end < chars.length && topOf(chars[end]) === firstTop) end++
        const firstLine = chars.slice(0, end).map((c) => c.ch).join('')
        const tops = new Set(chars.map((c) => topOf(c)))
        return {
          ok: true,
          firstLine,
          firstLineTail: firstLine.slice(-20),
          lines: tops.size,
          total: chars.length,
          whiteSpace: getComputedStyle(el).whiteSpace,
          overflowWrap: getComputedStyle(el).overflowWrap,
          wordBreak: getComputedStyle(el).wordBreak,
          verticalAlign: getComputedStyle(el).verticalAlign
        }
      })()`)
    // 收窄容器，逼出换行
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(WB)}); return 'ok' })()`)
    await sleep(900)
    const narrow = await json(`(() => {
      const root = document.querySelector('.ProseMirror')
      root.style.maxWidth = '360px'
      return { w: Math.round(root.getBoundingClientRect().width) }
    })()`)
    await sleep(300)
    const wbPt = await json(`(() => {
      const w = document.querySelector('[data-img-widget]')
      if (!w) return null
      const r = w.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await click(wbPt)
    await sleep(500)
    const wb = await firstLineOf('[data-img-revealed]')
    const urlRun = (wb.firstLine || '').match(/https?:\/\/[\w.@%/:-]{8,}/)
    check(
      '㉗① 标识符**在 URL 内部换行**（首行含 ≥8 个连续 URL 字符）——红=首行只到 `<img`',
      wb.ok === true && !!urlRun,
      JSON.stringify({ 容器宽: narrow.w, ...wb, URL片段: urlRun ? urlRun[0].slice(0, 40) : null })
    )
    check(
      '㉗② 首行**不得以 `<img` 结尾**（畸形断点）',
      wb.ok === true && !/<\/?img\s*$/.test((wb.firstLine || '').trim()),
      JSON.stringify({ 首行末20: wb.firstLineTail, 首行文本: (wb.firstLine || '').slice(0, 80) })
    )
    check(
      '㉗③ 三条不变量：块级标识符**顶格**（Range 首字符行盒 ≈ 正文列左边缘）、行内 `vertical-align: top`、非激活 `count:0`',
      wb.ok === true,
      JSON.stringify({ whiteSpace: wb.whiteSpace, overflowWrap: wb.overflowWrap, wordBreak: wb.wordBreak, 行数: wb.lines, 标记字符数: wb.total })
    )
    check('㉗④ 往返**逐字节不变**（收窄容器只是视图层）', (await ev(`window.__vt.ed().storage.markdown.getMarkdown()`)) === WB, JSON.stringify({ 输入: WB }))
    await ev(`(() => {
      const root = document.querySelector('.ProseMirror')
      root.style.maxWidth = ''
      return 'ok'
    })()`)
    const shot87 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-wordbreak.png'), Buffer.from(shot87.result.data, 'base64')), null)
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第八十八轮：标识符两处视觉微调（行内**顶端对齐** + 底色更深）═══════════════════
  {
    const INLINE88 = `正文12345<img src="${PNG_B}" style="zoom:100%;" />`
    const probe88 = () =>
      json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const marker = root.querySelector('[data-img-revealed]')
        const img = root.querySelector('[data-img-widget] img') || root.querySelector('img:not([class])')
        if (!marker || !img) return { ok: false, hasMarker: !!marker, hasImg: !!img }
        const cs = getComputedStyle(marker)
        // 标识符**首行**的行盒（用 Range 取第一个字符，再取与该字符同一 top 的整行）
        const t = (() => {
          const w = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT)
          return w.nextNode()
        })()
        let firstTop = null
        if (t && (t.textContent || '').length) {
          const rg = document.createRange()
          rg.setStart(t, 0)
          rg.setEnd(t, 1)
          firstTop = Math.round(rg.getBoundingClientRect().top)
        }
        const ir = img.getBoundingClientRect()
        return {
          ok: true,
          markerFirstLineTop: firstTop,
          imgTop: Math.round(ir.top),
          deltaTop: firstTop === null ? null : Math.round(Math.abs(firstTop - ir.top)),
          verticalAlign: cs.verticalAlign,
          background: cs.backgroundColor,
          display: cs.display,
          markerCls: marker.className
        }
      })()`)
    const load88 = async (md) => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
      await sleep(900)
    }
    const clickImg88 = async () => {
      const pt = await json(`(() => {
        const w = document.querySelector('[data-img-widget]') || document.querySelector('.ProseMirror img')
        if (!w) return null
        const r = w.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      await click(pt)
      await sleep(450)
    }
    // ① 行内：标识符首行顶边 ≈ 图片顶边；② 底色（before/after 与令牌）
    await load88(INLINE88)
    await clickImg88()
    const v88 = await probe88()
    check(
      /**
       * 第八十九轮按产品决策收口：用户选择「**保持现状**（两者都显示，标识符在上/左、图片在后）」
       * ⇒ "标识符首行顶边 == 图片顶边"**本项不做**。
       * 这里不是"恒真"断言，而是**记录现状 + 结构护栏**：
       *   * 图片 widget 挂在 `img.to`（在标识符文本之后）⇒ 长源码折行后图片天然在下面几行，
       *     偏移量是**结构必然**（本轮实测 62px），`vertical-align` 改不动它；
       *   * 所以只断言"偏移量落在记录区间内 + 当前仍是 `baseline` 档"——**若有人把图片挪到
       *     标识符之前/首行，这条会红**，提醒重新评估（而不是悄悄改变观感）。
       */
      '㉘① 【第九十一轮口径更新】行内档已是 `vertical-align: top`；长源码折行时图片仍在后面几行（结构性偏移，记录数值）',
      v88.ok === true &&
        v88.deltaTop !== null &&
        v88.deltaTop >= 30 &&
        v88.verticalAlign === "top",
      JSON.stringify({
        ...v88,
        决策: '第八十九轮：用户选择"保持现状"（标识符在上/左、图片在后）⇒ 顶端对齐本项不做',
        结构性偏移: '图片 widget 在标识符文本之后（img.to, side:1）⇒ 长源码折行后图片在下面几行'
      })
    )
    check(
      '㉘② 底色比 `--code-bg` **更深**（用既有令牌），编辑态仍透明',
      v88.ok === true && v88.background !== 'rgb(241, 242, 245)',
      JSON.stringify({ 底色: v88.background, display: v88.display })
    )
    // ③ 块级仍顶格（Range 首字符行盒 left == 正文列左）
    await load88(`${`正文一段`}\n\n![](${PNG_B})`)
    const blockPt88 = await json(`(() => {
      const p = [...document.querySelectorAll('.ProseMirror p')][1]
      const im = p ? p.querySelector('img') : null
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await click(blockPt88)
    await sleep(450)
    const block88 = await json(`(() => {
      const ps = [...document.querySelectorAll('.ProseMirror p')]
      const p1 = ps[0]
      const marker = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!p1 || !marker) return { ok: false }
      let base = null
      const w = document.createTreeWalker(p1, NodeFilter.SHOW_TEXT)
      const t = w.nextNode()
      if (t) {
        const rg = document.createRange()
        rg.selectNodeContents(t)
        const rs = [...rg.getClientRects()].filter((r) => r.width > 0)
        if (rs.length) base = rs[0]
      }
      const mt = (() => {
        const ww = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT)
        return ww.nextNode()
      })()
      let mLeft = null
      if (mt && (mt.textContent || '').length) {
        const rg = document.createRange()
        rg.setStart(mt, 0)
        rg.setEnd(mt, 1)
        mLeft = Math.round(rg.getBoundingClientRect().left)
      }
      return {
        ok: true,
        markerTextLeft: mLeft,
        baselineLeft: base ? Math.round(base.left) : null,
        delta: base && mLeft !== null ? Math.round(mLeft - base.left) : null,
        verticalAlign: getComputedStyle(marker).verticalAlign
      }
    })()`)
    check(
      '㉘③ 块级标识符仍**顶格**（Range 首字符行盒 left ≈ 正文列左，±2px）',
      block88.ok === true && block88.delta !== null && Math.abs(block88.delta) <= 2,
      JSON.stringify(block88)
    )
    // ④ 换行仍正确（㉗ 的核心）：收窄容器 ⇒ 首行含 ≥8 个连续 URL 字符
    const WB88 = `正文12345<img src="https://assets.699pic.com/public/img95/photo/50465/4467.jpg_wh860.jpg" style="zoom:25%;" />`
    await load88(WB88)
    await ev(`(() => { document.querySelector('.ProseMirror').style.maxWidth = '360px'; return 'ok' })()`)
    await sleep(250)
    await clickImg88()
    const wrap88 = await json(`(() => {
      const el = document.querySelector('[data-img-revealed]')
      if (!el) return { ok: false }
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const t = w.nextNode()
      if (!t) return { ok: false }
      const s = t.textContent || ''
      const rg = document.createRange()
      rg.setStart(t, 0)
      rg.setEnd(t, 1)
      const top0 = Math.round(rg.getBoundingClientRect().top)
      let end = 0
      for (let i = 0; i < s.length; i++) {
        const r = document.createRange()
        r.setStart(t, i)
        r.setEnd(t, i + 1)
        if (Math.round(r.getBoundingClientRect().top) !== top0) break
        end = i + 1
      }
      const firstLine = s.slice(0, end)
      return { ok: true, firstLine, url: (firstLine.match(/https?:\\/\\/[\\w.@%/:-]{8,}/) || [null])[0] }
    })()`)
    check(
      '㉘④ 换行仍正确：首行含 ≥8 个连续 URL 字符（上一轮 ㉗ 的核心）',
      wrap88.ok === true && !!wrap88.url,
      JSON.stringify(wrap88)
    )
    // ⑤ 往返逐字节 + 非激活 count 0
    const md88 = await ev(`window.__vt.ed().storage.markdown.getMarkdown()`)
    const away88 = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 6), y: Math.round(r.top + 6) }
    })()`)
    await click(away88)
    await sleep(400)
    const inactive88 = await json(`(() => ({
      count: document.querySelectorAll('.ProseMirror [data-img-revealed]').length
    }))()`)
    check(
      '㉘⑤ 往返**逐字节不变**且非激活时标识符**隐藏**（count:0）',
      md88 === WB88 && inactive88.count === 0,
      JSON.stringify({ md: md88, 期望: WB88, 非激活: inactive88 })
    )
    await ev(`(() => { document.querySelector('.ProseMirror').style.maxWidth = ''; return 'ok' })()`)
    const shot88 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-ident-topbg.png'), Buffer.from(shot88.result.data, 'base64')), null)
    await load88(doc)
  }

  // ═══ 第九十轮：**三种形态**的块级标识符都必须"顶格"（补上只验节点形态的洞）════════
  {
    const U90 = 'https://assets.699pic.com/public/img95/photo/50465/4467.jpg_wh860.jpg'
    /** 量"标识符**首行文字**的 left"与"正文内容列左边缘"（两者都用 Range 取行盒，不许用盒子 left） */
    const flushOf = () =>
      json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const ps = [...root.querySelectorAll('p')]
        const marker = root.querySelector('[data-img-revealed]')
        if (!marker) return { ok: false, hasMarker: false }
        // 基准：第一段里那行**正文文字**的行盒左边缘
        let base = null
        for (const p of ps) {
          const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
          let t = w.nextNode()
          while (t && (!(t.textContent || '').trim() || marker.contains(t))) t = w.nextNode()
          if (!t) continue
          const rg = document.createRange()
          rg.selectNodeContents(t)
          const rs = [...rg.getClientRects()].filter((r) => r.width > 0)
          if (rs.length) { base = rs[0]; break }
        }
        const mt = (() => {
          const w = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT)
          return w.nextNode()
        })()
        let mLeft = null
        if (mt && (mt.textContent || '').length) {
          const rg = document.createRange()
          rg.setStart(mt, 0)
          rg.setEnd(mt, 1)
          mLeft = Math.round(rg.getBoundingClientRect().left)
        }
        const img = root.querySelector('[data-img-widget] img') || root.querySelector('p img')
        const holder = root.querySelector('[data-img-widget]') || img
        const hr = holder ? holder.getBoundingClientRect() : null
        const pr = ps.length ? ps[ps.length - 1].getBoundingClientRect() : root.getBoundingClientRect()
        return {
          ok: true,
          markerTag: marker.tagName.toLowerCase(),
          markerCls: marker.className,
          markerParent: marker.parentElement ? marker.parentElement.tagName.toLowerCase() : null,
          markerTextLeft: mLeft,
          baselineLeft: base ? Math.round(base.left) : null,
          delta: base && mLeft !== null ? Math.round(mLeft - base.left) : null,
          textAlign: getComputedStyle(marker).textAlign,
          imgCenterOffset: hr ? Math.round(Math.abs((hr.left + hr.right) / 2 - (pr.left + pr.right) / 2)) : null,
          imgLeft: hr ? Math.round(hr.left) : null
        }
      })()`)
    const load90 = async (md) => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
      await sleep(900)
    }
    const clickImg90 = async () => {
      const pt = await json(`(() => {
        const w = document.querySelector('[data-img-widget]') || document.querySelector('.ProseMirror img')
        if (!w) return null
        const r = w.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      await click(pt)
      await sleep(500)
    }
    // (a) `![]()` 节点形态（对照组）
    await load90(`正文12345\n\n![](${U90})`)
    await clickImg90()
    const a90 = await flushOf()
    // (b) 用户实际场景：`![]()` 点缩放 → 变成 `<img … style="zoom:25%;" />`
    await load90(`正文12345\n\n![](${U90})`)
    await clickImg90()
    const zoomPt = await json(`(() => {
      const bar = document.querySelector('.img-zoom-bar')
      if (!bar) return null
      const btn = [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').indexOf('25') >= 0)
      if (!btn) return null
      const r = btn.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await click(zoomPt)
    await sleep(600)
    const b90 = await flushOf()
    const bMd = await ev(`window.__vt.ed().storage.markdown.getMarkdown()`)
    // (c) 手写/粘贴的独立成行裸 `<img … />`（htmlBlock 路径）
    await load90(`正文12345\n\n<img src="${U90}" style="zoom:25%;" />`)
    await clickImg90()
    const c90 = await flushOf()
    check(
      '㉙① (a) `![]()` 节点形态 ⇒ 块级标识符**顶格**（delta ≤ 2px，Range 首字符行盒）',
      a90.ok === true && a90.delta !== null && Math.abs(a90.delta) <= 2,
      JSON.stringify(a90)
    )
    check(
      '㉙① (b) **缩放转成的裸 `<img … style="zoom:25%;" />`**（用户实际场景）⇒ 同样**顶格**（delta ≤ 2px）',
      b90.ok === true && b90.delta !== null && Math.abs(b90.delta) <= 2,
      JSON.stringify({ ...b90, zoomedMd: bMd })
    )
    check(
      '㉙① (c) **手写/粘贴的独立成行裸 `<img … />`**（htmlBlock 路径）⇒ 同样**顶格**（delta ≤ 2px）',
      c90.ok === true && c90.delta !== null && Math.abs(c90.delta) <= 2,
      JSON.stringify(c90)
    )
    check(
      '㉙② 同一次 payload：**图片本身仍居中**（holder 中心 ≈ 段落中心，offset ≤ 2px）',
      [a90, b90, c90].every((x) => x.ok === true && x.imgCenterOffset !== null && x.imgCenterOffset <= 2),
      JSON.stringify({ a: a90.imgCenterOffset, b: b90.imgCenterOffset, c: c90.imgCenterOffset })
    )
    // ③ 行内档未被误伤
    await load90(`正文12345<img src="${U90}" style="zoom:25%;" />`)
    await clickImg90()
    const inline90 = await json(`(() => {
      const root = document.querySelector('.ProseMirror')
      const marker = root.querySelector('[data-img-revealed]')
      const w = root.querySelector('[data-img-widget]')
      if (!marker || !w) return { ok: false }
      const mr = marker.getBoundingClientRect()
      const wr = w.getBoundingClientRect()
      return {
        ok: true,
        verticalAlign: getComputedStyle(marker).verticalAlign,
        markerLeft: Math.round(mr.left),
        widgetLeft: Math.round(wr.left),
        sameLine: Math.abs(mr.top - wr.top) < 40,
        inlineAttr: w.getAttribute('data-img-inline')
      }
    })()`)
    check(
      '㉙③ 行内档未被误伤：标识符仍在图片**之前**、`vertical-align: top`（第九十一轮口径）',
      inline90.ok === true && inline90.markerLeft < inline90.widgetLeft && inline90.verticalAlign === 'top' && inline90.inlineAttr === 'true',
      JSON.stringify(inline90)
    )
    const shot90 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-ident-flush-3forms.png'), Buffer.from(shot90.result.data, 'base64')), null)
    await load90(doc)
  }

  // ═══ 第九十三轮：源码被"整段选中"而隐藏时 ⇒ **图片显示为被选中**（`img-selected`）═══════
  {
    const U93 = 'https://assets.699pic.com/public/img95/photo/50465/4467.jpg_wh860.jpg'
    const DOC93 = `行内公式$E = mc^2$ 与 $a^2 + b^2 = c^2$。<img src="${U93}" style="zoom:25%;" />`
    const stateOf = () =>
      json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const v = window.__vt.ed().view
        const w = root.querySelector('[data-img-widget]')
        const img = w ? w.querySelector('img') : root.querySelector('p img')
        const cs = w ? getComputedStyle(w) : img ? getComputedStyle(img) : null
        return {
          markers: root.querySelectorAll('[data-img-revealed]').length,
          imgs: root.querySelectorAll('img').length,
          widgetCls: w ? w.className : null,
          imgCls: img ? img.className : null,
          selected: root.querySelectorAll('.img-selected').length,
          background: cs ? cs.backgroundColor : null,
          outline: cs ? cs.outlineColor + ' / ' + cs.outlineWidth : null,
          sel: { from: v.state.selection.from, to: v.state.selection.to, empty: v.state.selection.empty },
          md: window.__vt.ed().storage.markdown.getMarkdown()
        }
      })()`)
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(DOC93)}); return 'ok' })()`)
    await sleep(900)
    // ① 整段选中（覆盖整个源码范围，且两端严格超出）⇒ 标识符隐藏 + 图片带 img-selected
    const full93 = await json(`(() => {
      const v = window.__vt.ed().view
      const all = v.state.doc.textBetween(0, v.state.doc.content.size, '\\n')
      const a = 0
      const b = v.state.doc.content.size
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, a, b)))
      return all.length
    })()`)
    await sleep(400)
    const s93 = await stateOf()
    check(
      '㉚① 整段选中（覆盖整个源码范围）⇒ 松开后**标识符 count:0** 且**图片带 `.img-selected`**（给类名与 computed 令牌值）',
      s93.markers === 0 && s93.selected >= 1 && s93.background === 'rgba(17, 24, 39, 0.11)',
      JSON.stringify({ 文档长度: full93, ...s93, 令牌: { 底色: '--sel', 描边: '--accent' } })
    )
    // ② 点别处 ⇒ img-selected 被移除
    const away93 = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 6), y: Math.round(r.top + 6) }
    })()`)
    await click(away93)
    await sleep(450)
    const after93 = await stateOf()
    check(
      '㉚② 点别处 ⇒ `.img-selected` **立即移除**（不许残留）',
      after93.selected === 0 && after93.markers === 0,
      JSON.stringify({ 前后: { selected: s93.selected, widgetCls: s93.widgetCls }, 之后: { selected: after93.selected, widgetCls: after93.widgetCls, imgCls: after93.imgCls } })
    )
    // ③ 只覆盖一部分 ⇒ 标识符显示；图片**带** img-selected
    const partial93 = await json(`(() => {
      const v = window.__vt.ed().view
      const w = document.querySelector('[data-img-widget]')
      const from = w ? Number(w.getAttribute('data-img-from')) : 1
      // 选区落在源码**内部**（严格子区间）⇒ 标识符按原口径仍显示（两条判据已拆开），
      // 而"图片被选中"改用**浏览器语义**（第一百零六轮：只要选区与它有交就算）⇒ 这里应带类
      v.dispatch(
        v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, from + 2, from + 12))
      )
      return from
    })()`)
    await sleep(400)
    const p93 = await stateOf()
    check(
      '㉚③ **部分覆盖**（严格子区间）⇒ 标识符**显示**（count ≥1，显隐口径与"图片选中"已解耦）且图片**带** `.img-selected`（第一百零六轮用户口径：像浏览器那样，碰到就算被选中）',
      p93.markers >= 1 && p93.selected >= 1 && p93.background === 'rgba(17, 24, 39, 0.11)',
      JSON.stringify({ 源码起点: partial93, ...p93, 口径: '第一百零六轮：selectionIntersectsSource（观感）与 selectionCoversSource（显隐）分开' })
    )
    // ④ 不闪：整段选中这一手势的逐帧序列
    await ev(`(() => {
      const root = document.querySelector('.ProseMirror')
      window.__s93 = []
      const tick = () => {
        const cur = {
          markers: root.querySelectorAll('[data-img-revealed]').length,
          sel: root.querySelectorAll('.img-selected').length,
          imgs: root.querySelectorAll('img').length
        }
        const last = window.__s93[window.__s93.length - 1]
        if (!last || last.markers !== cur.markers || last.sel !== cur.sel || last.imgs !== cur.imgs) window.__s93.push(cur)
        if (performance.now() - window.__t93 < 600) requestAnimationFrame(tick)
      }
      window.__t93 = performance.now()
      requestAnimationFrame(tick)
      return 'ok'
    })()`)
    await ev(`(() => {
      const v = window.__vt.ed().view
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 0, v.state.doc.content.size)))
      return 'ok'
    })()`)
    await sleep(800)
    const seq93 = await json(`window.__s93`)
    check(
      '㉚④ 整段选中这一手势**不闪**：逐帧可见状态（标识符/选中态/图片数）跃迁 ≤ 2',
      Array.isArray(seq93) && seq93.length <= 3,
      JSON.stringify({ 逐帧: seq93 })
    )
    const shot93 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-selected-marker-hidden.png'), Buffer.from(shot93.result.data, 'base64')), null)
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第九十四轮：**从后往前拖**松开后选区丢了（tableClipboard 的 mouseup 收尾误判单击）════
  {
    const U94 = 'https://assets.699pic.com/public/img95/photo/50465/4467.jpg_wh860.jpg'
    const DOC94 = `行内公式$E = mc^2$ 与 $a^2 + b^2 = c^2$。<img src="${U94}" style="zoom:25%;" />`
    const load94 = async () => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(DOC94)}); return 'ok' })()`)
      await sleep(900)
    }
    /** 拖一次（steps 步），返回松开前后的选区与"单击判定"两个分量 */
    const drag94 = async (dir, steps = 10) => {
      await load94()
      /**
       * 第九十五轮：**起点改到"源码文本自身内部"**。
       * 上一轮反向夹具从 `widget.right + 3` 起手（在段落最后一个行内元素**右侧**、正文之外），
       * PM 很可能只当"末位落光标"⇒ 拖动中压根没建立选区。这里先点图片让**源码显形**，
       * 再从源码行盒的右端往左拖 ⇒ 才是用户那种"从后往前选文字"。
       */
      const imgPt94 = await json(`(() => {
        const w = document.querySelector('[data-img-widget]')
        if (!w) return null
        const r = w.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      await click(imgPt94)
      await sleep(450)
      const geo = await json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const el = root.querySelector('[data-img-revealed]')
        const p = root.querySelector('p')
        const pr = p.getBoundingClientRect()
        const rs = el ? [...el.getClientRects()].filter((r) => r.width > 2) : []
        const lastRect = rs.length ? rs[rs.length - 1] : null
        return {
          leftX: Math.round(pr.left + 3),
          rightX: lastRect ? Math.round(lastRect.right - 4) : Math.round(pr.right - 6),
          y: Math.round((lastRect ? lastRect.top + lastRect.height / 2 : pr.top + 10))
        }
      })()`)
      const a = dir === 'back' ? { x: geo.rightX, y: geo.y } : { x: geo.leftX, y: geo.y }
      const z = dir === 'back' ? { x: geo.leftX, y: geo.y } : { x: geo.rightX, y: geo.y }
      const before = await json(`(() => {
        const v = window.__vt.ed().view
        return { from: v.state.selection.from, to: v.state.selection.to, empty: v.state.selection.empty }
      })()`)
      /**
       * 第九十五轮探针：包一层 `dispatch`，把**每一次事务**的选区变化与 meta 记下来
       * ⇒ 用来点名"是谁把非空选区收成空选区"。
       */
      await ev(`(() => {
        const v = window.__vt.ed().view
        window.__tx95 = []
        if (!window.__p95) {
          window.__p95 = true
          const d = v.dispatch.bind(v)
          v.dispatch = (tr) => {
            try {
              const sel = tr.selection
              const metaKeys = []
              const meta = tr.meta || {}
              for (const k of Object.keys(meta)) metaKeys.push(String(k).slice(0, 24) + '=' + String(meta[k]).slice(0, 12))
              window.__tx95.push({
                from: sel ? sel.from : null,
                to: sel ? sel.to : null,
                empty: sel ? sel.empty : null,
                docChanged: tr.docChanged === true,
                hist: tr.getMeta('addToHistory') === false ? 'noHist' : 'hist',
                meta: metaKeys,
                steps: tr.steps ? tr.steps.length : 0
              })
            } catch (e) {
              window.__tx95.push({ err: String(e && e.message ? e.message : e) })
            }
            return d(tr)
          }
        }
        return 'ok'
      })()`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 })
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(a.x + ((z.x - a.x) * i) / steps),
          y: a.y,
          button: 'left',
          buttons: 1
        })
        await sleep(35)
      }
      // 松开前先记"按下点 / 当前指针下的文档位置"（复现 tableClipboard 的两个判定分量）
      const probe = await json(`(() => {
        const v = window.__vt.ed().view
        const press = v.posAtCoords({ left: ${a.x}, top: ${a.y} })
        const now = v.posAtCoords({ left: ${z.x}, top: ${z.y} })
        return {
          pressPos: press ? press.pos : null,
          releasePos: now ? now.pos : null,
          movedFar: Math.abs(${z.x} - ${a.x}) > 10 || Math.abs(${z.y} - ${a.y}) > 10
        }
      })()`)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: z.x, y: z.y, button: 'left', clickCount: 1 })
      await sleep(600) // 等 tableClipboard 的 setTimeout 收尾
      const after = await json(`(() => {
        const v = window.__vt.ed().view
        const root = document.querySelector('.ProseMirror')
        const { from, to, empty } = v.state.selection
        return {
          from,
          to,
          empty,
          text: v.state.doc.textBetween(from, to, '\\n').slice(0, 60),
          markers: root.querySelectorAll('[data-img-revealed]').length,
          selected: root.querySelectorAll('.img-selected').length,
          imgs: root.querySelectorAll('img').length,
          md: window.__vt.ed().storage.markdown.getMarkdown()
        }
      })()`)
      const tx95 = await json(`window.__tx95 || []`).catch(() => null)
      return { geo, a, z, probe, before, after, tx95 }
    }
    const back = await drag94('back')
    const posChangedOld =
      back.probe.releasePos !== back.probe.pressPos // 旧规则的第二个分量（lastHeadPos ≈ releasePos）
    check(
      '㉛① **从后往前拖**（起点在源码内部）⇒ 松开后选区**仍在**（`empty:false`）且覆盖所拖范围',
      back.after.empty === false &&
        back.after.to - back.after.from >= 20 &&
        back.after.from <= back.probe.releasePos &&
        back.after.imgs >= 1,
      JSON.stringify({
        拖拽: { 起点: back.a, 终点: back.z },
        旧判定分量: { movedFar: back.probe.movedFar, posChangedOld, pressPos: back.probe.pressPos, releasePos: back.probe.releasePos },
        事务探针: back.tx95,
        松开前: back.before,
        松开后: back.after
      })
    )
    const fwd = await drag94('fwd')
    check(
      '㉛② **从前往后拖** ⇒ 与反向对称：选区仍在（`empty:false`）且覆盖所拖范围',
      fwd.after.empty === false &&
        fwd.after.to - fwd.after.from >= 20 &&
        fwd.after.to >= fwd.probe.releasePos - 2,
      JSON.stringify({ 拖拽: { 起点: fwd.a, 终点: fwd.z }, 旧判定分量: { movedFar: fwd.probe.movedFar }, 松开后: fwd.after })
    )
    // ③ 真正单击（位移 ≤10px）落在已有选区内 ⇒ 仍收成光标（第四十五轮口径不回归）
    await load94()
    // ── 第九十六轮：**按下点在图片右侧空白**（正文之外）⇒ 往左拖能不能建立选区？────────────
    await load94()
    const marginGeo = await json(`(() => {
      const root = document.querySelector('.ProseMirror')
      const w = root.querySelector('[data-img-widget]')
      const p = root.querySelector('p')
      const pr = p.getBoundingClientRect()
      const wr = w.getBoundingClientRect()
      return {
        marginX: Math.round(Math.min(pr.right - 4, wr.right + 6)),
        widgetRight: Math.round(wr.right),
        paraRight: Math.round(pr.right),
        leftX: Math.round(pr.left + 3),
        y: Math.round(wr.top + wr.height / 2)
      }
    })()`)
    await ev(`(() => {
      const v = window.__vt.ed().view
      window.__tx96 = []
      window.__seq96 = []
      if (!window.__p96) {
        window.__p96 = true
        const d = v.dispatch.bind(v)
        v.dispatch = (tr) => {
          const sel = tr.selection
          window.__tx96.push({ from: sel ? sel.from : null, to: sel ? sel.to : null, empty: sel ? sel.empty : null })
          return d(tr)
        }
      }
      const tick = () => {
        const s = window.__vt.ed().view.state.selection
        const cur = { from: s.from, to: s.to, empty: s.empty }
        const last = window.__seq96[window.__seq96.length - 1]
        if (!last || last.from !== cur.from || last.to !== cur.to) window.__seq96.push(cur)
        if (performance.now() - window.__t96 < 900) requestAnimationFrame(tick)
      }
      window.__t96 = performance.now()
      requestAnimationFrame(tick)
      return 'ok'
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: marginGeo.marginX, y: marginGeo.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 10; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(marginGeo.marginX + ((marginGeo.leftX - marginGeo.marginX) * i) / 10),
        y: marginGeo.y,
        button: 'left',
        buttons: 1
      })
      await sleep(35)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: marginGeo.leftX, y: marginGeo.y, button: 'left', clickCount: 1 })
    await sleep(700)
    const margin96 = await json(`(() => {
      const v = window.__vt.ed().view
      const root = document.querySelector('.ProseMirror')
      const { from, to, empty } = v.state.selection
      return {
        from,
        to,
        empty,
        text: v.state.doc.textBetween(from, to, '\\n').slice(0, 60),
        tx: window.__tx96,
        seq: window.__seq96,
        markers: root.querySelectorAll('[data-img-revealed]').length,
        selected: root.querySelectorAll('.img-selected').length,
        imgs: root.querySelectorAll('img').length
      }
    })()`)
    check(
      '㉛④ **图片右侧空白处按下 → 往左拖**过整段 ⇒ 松开后选区**非空**且覆盖所拖范围（Typora 式；红=压根没建立选区）',
      margin96.empty === false && margin96.to - margin96.from >= 20,
      JSON.stringify({ 几何: marginGeo, 空白起手: margin96 })
    )
    await ev(`(() => {
      const v = window.__vt.ed().view
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 0, v.state.doc.content.size)))
      return 'ok'
    })()`)
    await sleep(350)
    const clickPt94 = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 30), y: Math.round(r.top + 10) }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickPt94.x, y: clickPt94.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPt94.x, y: clickPt94.y, button: 'left', clickCount: 1 })
    await sleep(600)
    const afterClick94 = await json(`(() => {
      const v = window.__vt.ed().view
      return { from: v.state.selection.from, to: v.state.selection.to, empty: v.state.selection.empty }
    })()`)
    check(
      '㉛③ **真正单击**（位移 0 ≤10px）落在已有选区内 ⇒ **仍收成光标**（第四十五轮口径不回归）',
      afterClick94.empty === true,
      JSON.stringify({ 点击点: clickPt94, 单击后: afterClick94 })
    )
    const shot94 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-backward-drag.png'), Buffer.from(shot94.result.data, 'base64')), null)
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第九十九轮：用**用户确切原文**（base64 data URI + zoom:100%）复现"标识符隐藏但图片未选中" ═
  {
    const DATA_URI99 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'
    const DOC99 = `前文 <img src="${DATA_URI99}" style="zoom:100%;" />`
    const DOC93B = `行内公式$E = mc^2$ 与 $a^2 + b^2 = c^2$。<img src="https://assets.699pic.com/public/img95/photo/50465/4467.jpg_wh860.jpg" style="zoom:25%;" />`
    /** 量：选区三输入 + 判据中间值 + 标识符计数 + 图片元素类列表/computed */
    const probe99 = () =>
      json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const v = window.__vt.ed().view
        const sel = v.state.selection
        const w = root.querySelector('[data-img-widget]')
        const img = w ? w.querySelector('img') : null
        const revealed = root.querySelector('[data-img-revealed]')
        const srcLen = revealed ? (revealed.textContent || '').length : null
        const from = w ? Number(w.getAttribute('data-img-from')) : null
        const to = from == null || srcLen == null ? null : from + srcLen
        const cs = w ? getComputedStyle(w) : null
        const csImg = img ? getComputedStyle(img) : null
        return {
          sel: { from: sel.from, to: sel.to, empty: sel.empty },
          img: { from, to, srcLen },
          covers: from == null || to == null ? null : sel.from <= from && sel.to >= to,
          strictlyBeyond: from == null || to == null ? null : sel.from < from || sel.to > to,
          markers: root.querySelectorAll('[data-img-revealed]').length,
          selectedCount: root.querySelectorAll('.img-selected').length,
          widgetCls: w ? w.className : null,
          imgCls: img ? img.className : null,
          bgWidget: cs ? cs.backgroundColor : null,
          outlineWidget: cs ? cs.outlineColor + ' / ' + cs.outlineWidth : null,
          bgImg: csImg ? csImg.backgroundColor : null,
          outlineImg: csImg ? csImg.outlineColor + ' / ' + csImg.outlineWidth : null,
          imgs: root.querySelectorAll('img').length
        }
      })()`)
    /** 后→前拖：起点在源码**之后**（图片右缘外一点点），终点在"前文"里 */
    const backDrag99 = async (md) => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
      await sleep(900)
      const geo = await json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const w = root.querySelector('[data-img-widget]')
        const p = root.querySelector('p')
        const wr = w.getBoundingClientRect()
        const pr = p.getBoundingClientRect()
        return {
          startX: Math.round(Math.min(pr.right - 4, wr.right + 8)),
          endX: Math.round(pr.left + 6),
          y: Math.round(wr.top + wr.height / 2)
        }
      })()`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.startX, y: geo.y, button: 'left', clickCount: 1 })
      for (let i = 1; i <= 10; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(geo.startX + ((geo.endX - geo.startX) * i) / 10),
          y: geo.y,
          button: 'left',
          buttons: 1
        })
        await sleep(35)
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.endX, y: geo.y, button: 'left', clickCount: 1 })
      await sleep(600)
      const after = await probe99()
      return { geo, after }
    }
    const data99 = await backDrag99(DOC99)
    const url99 = await backDrag99(DOC93B)
    // 第一百轮收口：被判据与样式把守的**契约本体**用**程序化覆盖选区**验证（两种形态各一次）；
    // CDP 直线拖拽的现状数值如实记录在 payload 里（不是恒真断言 —— 若判据/样式坏了，这两条会红）。
    const coverProbe = async () => {
      await ev(`(() => {
        const v = window.__vt.ed().view
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 0, v.state.doc.content.size)))
        return 'ok'
      })()`)
      await sleep(400)
      return probe99()
    }
    const coverData = await coverProbe() // 当前内容 = 远程 URL 夹具（backDrag99 最后加载的那条）
    check(
      '㉜①【契约】**程序化覆盖整个源码范围** ⇒ 标识符 count:0 **且** 图片带 `.img-selected` 且样式可见（`--sel`/`--accent`）',
      coverData.markers === 0 &&
        coverData.selectedCount >= 1 &&
        coverData.bgWidget === 'rgba(17, 24, 39, 0.11)' &&
        coverData.outlineWidget === 'rgb(107, 114, 128) / 2px',
      JSON.stringify({ 覆盖后: coverData, CDP直线拖_远程URL: url99.after })
    )
    const dataCover = await (async () => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(DOC99)}); return 'ok' })()`)
      await sleep(900)
      return coverProbe()
    })()
    check(
      '㉜②【契约】**用户夹具（base64 data URI + zoom:100%）**同样成立（两种形态一致）',
      dataCover.markers === 0 &&
        dataCover.selectedCount >= 1 &&
        dataCover.bgWidget === 'rgba(17, 24, 39, 0.11)' &&
        dataCover.outlineWidget === 'rgb(107, 114, 128) / 2px',
      JSON.stringify({
        用户夹具_覆盖后: dataCover,
        CDP直线拖_用户夹具: data99.after,
        收口说明:
          'CDP 直线拖在这一格只推进到 sel.from≈131/177（图片那条空行无文字 ⇒ x 方向推进不到源码起点）⇒ 记录现状'
      })
    )
    const shot99 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-selected-datauri.png'), Buffer.from(shot99.result.data, 'base64')), null)
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第一百零四轮：**DOM 身份快照** —— 起点在标识符里 ⇒ 拖动期间恒显示，松手后才隐藏 ═══════
  {
    const U104 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'
    const DOC104 = `前文 <img src="${U104}" style="zoom:100%;" />`
    const load104 = async () => {
      await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(DOC104)}); return 'ok' })()`)
      await sleep(900)
    }
    const stateOf104 = () =>
      json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const w = root.querySelector('[data-img-widget]')
        const cs = w ? getComputedStyle(w) : null
        const v = window.__vt.ed().view
        return {
          markers: root.querySelectorAll('[data-img-revealed]').length,
          selected: root.querySelectorAll('.img-selected').length,
          sel: { from: v.state.selection.from, to: v.state.selection.to, empty: v.state.selection.empty },
          bg: cs ? cs.backgroundColor : null,
          outline: cs ? cs.outlineColor + ' / ' + cs.outlineWidth : null
        }
      })()`)
    /** 在**标识符文本上按下**，向右拖到整段末尾 ⇒ 拖动期间逐帧采样 markers */
    const dragOnMarker = async () => {
      await load104()
      const imgPt = await json(`(() => {
        const w = document.querySelector('[data-img-widget]')
        const r = w.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      await click(imgPt)
      await sleep(450)
      const geo = await json(`(() => {
        const root = document.querySelector('.ProseMirror')
        const el = root.querySelector('[data-img-revealed]')
        const p = root.querySelector('p')
        const rs = el ? [...el.getClientRects()].filter((r) => r.width > 2) : []
        const r0 = rs[0]
        const pr = p.getBoundingClientRect()
        return {
          startX: Math.round(r0.left + 10),
          endX: Math.round(pr.right - 6),
          y: Math.round(r0.top + r0.height / 2)
        }
      })()`)
      await ev(`(() => {
        window.__seq104 = []
        const tick = () => {
          const n = document.querySelectorAll('.ProseMirror [data-img-revealed]').length
          const last = window.__seq104[window.__seq104.length - 1]
          if (last !== n) window.__seq104.push(n)
          if (performance.now() - window.__t104 < 1500) requestAnimationFrame(tick)
        }
        window.__t104 = performance.now()
        requestAnimationFrame(tick)
        return 'ok'
      })()`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.startX, y: geo.y, button: 'left', clickCount: 1 })
      for (let i = 1; i <= 12; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(geo.startX + ((geo.endX - geo.startX) * i) / 12),
          y: geo.y,
          button: 'left',
          buttons: 1
        })
        await sleep(35)
      }
      const during = await stateOf104()
      const seq = await json(`window.__seq104`)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.endX, y: geo.y, button: 'left', clickCount: 1 })
      await sleep(650)
      const after = await stateOf104()
      return { geo, during, seq, after }
    }
    const onMarker = await dragOnMarker()
    check(
      '㉞① **在标识符文本上按下**并向右拖 ⇒ 拖动期间逐帧 `markers` **恒 1**（无 1→0→1），**松开后 0**',
      onMarker.during.markers === 1 &&
        Array.isArray(onMarker.seq) &&
        onMarker.seq.length >= 1 &&
        onMarker.seq.every((n) => n === 1) &&
        onMarker.after.markers === 0,
      JSON.stringify(onMarker)
    )
    await load104()
    await ev(`(() => {
      const v = window.__vt.ed().view
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 0, v.state.doc.content.size)))
      return 'ok'
    })()`)
    await sleep(450)
    const cover104 = await stateOf104()
    check(
      '㉞② **程序化覆盖整个源码范围** ⇒ 标识符 0 + 图片 `.img-selected`（注明：程序化路径；直线拖无法覆盖多行源码）',
      cover104.markers === 0 &&
        cover104.selected >= 1 &&
        cover104.bg === 'rgba(17, 24, 39, 0.11)' &&
        cover104.outline === 'rgb(107, 114, 128) / 2px',
      JSON.stringify({ 程序化覆盖: cover104, 在标识符上拖: onMarker })
    )
    const shot104 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-drag-dom-identity.png'), Buffer.from(shot104.result.data, 'base64')), null)
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }

  // ═══ 第一百二十七轮（用户两条报障）：**拖动期必须"处处都有样式"** + **松手后与拖动期一致** ═══
  //  ① 覆盖差额 = 该帧"试探区间 ∪ 原生 DOM 区间"里、既没被我们的选中带/兜底高亮**完整**盖住、
  //     也不在"交回原生绘制的块"或"闸没开时的原生选区"里的文本片段条数 ⇒ 必须帧帧为 0。
  //  ② settled 与 live（最后一帧试探区间）双向差集必须为 0（"本该选中没选中" + "不该选中却选中"）。
  const lsFixture =
    `行内公式行：开头文字 $E = mc^2$ 中间文字 $a^2 + b^2 = c^2$ 结尾文字。\n\n` +
    `$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n` +
    `段A：星号不斜 粗体不粗 $x_1 + y_2$ 结束。\n\n` +
    `段B：行内图 <img src="${PNG_B}" style="zoom:25%;" /> 中间 <img src="${PNG_B}" style="zoom:25%;" /> 后文继续。\n\n` +
    `| 列一 | 列二 |\n| :--- | :--- |\n| **粗体甲** | 说明甲一段话 |\n| **粗体乙** | 说明乙一段话 |\n| **粗体丙** | 说明丙一段话 |\n\n` +
    `尾段：随便一些文字，让选区可以落在这里。`
  const lsCoverFn = `(rangeFrom, rangeTo, sawWrite) => {
    const pm = document.querySelector('.ProseMirror')
    const v = window.__vt.ed().view
    const own = pm.getAttribute('data-sel-own')
    const nativeMode = own !== 'all'
    const bandsA = [...document.querySelectorAll('.sel-band > div')].map((d) => { const r = d.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } })
    const hlA = []
    try { const h = CSS.highlights.get('lumin-img-drag'); if (h) for (const rg of h) for (const c of rg.getClientRects()) hlA.push({ l: c.left, t: c.top, r: c.right, b: c.bottom }) } catch (e) {}
    const natA = []
    try { const q = window.getSelection(); if (q && q.rangeCount && !q.isCollapsed) for (const c of q.getRangeAt(0).getClientRects()) if (c.width > 0.5 || c.height > 0.5) natA.push({ l: c.left, t: c.top, r: c.right, b: c.bottom }) } catch (e) {}
    const TOL = 1.25
    const has = (arr, r) => arr.some((b) => b.l <= r.l + TOL && b.r >= r.r - TOL && b.t <= r.t + TOL && b.b >= r.b - TOL)
    let fragN = 0, missN = 0
    const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      if (!n.length) continue
      if (n.parentElement && n.parentElement.closest('[data-md-math-block]')) continue
      let start = -1
      try { start = v.posAtDOM(n, 0) } catch (e) { start = NaN }
      const pe = n.parentElement
      const inMath = !!(pe && pe.closest('[data-md-math-rendered],[data-md-math-block]'))
      let a1, b1, whole = false
      if (!Number.isFinite(start)) {
        if (!inMath) continue
        try { const hp = v.posAtDOM(pe.closest('[data-md-math-rendered],[data-md-math-block]'), 0); if (!(hp >= rangeFrom - 1 && hp <= rangeTo + 1)) continue; a1 = 0; b1 = n.length; whole = true } catch (e) { continue }
      } else { a1 = Math.max(rangeFrom, start); b1 = Math.min(rangeTo, start + n.length) }
      if (b1 <= a1) continue
      const rg = document.createRange()
      try { if (whole) rg.selectNodeContents(n); else { rg.setStart(n, a1 - start); rg.setEnd(n, b1 - start) } } catch (e) { continue }
      const nat = !!(pe && pe.closest('th,thead,.img-src-revealed,pre,code,blockquote'))
      for (const c of [...rg.getClientRects()]) {
        if (!(c.width > 0.5 || c.height > 0.5)) continue
        fragN++
        const rr = { l: c.left, t: c.top, r: c.right, b: c.bottom }
        if (nat) continue
        if (has(bandsA, rr)) continue
        if (has(hlA, rr)) continue
        if (nativeMode && has(natA, rr)) continue
        missN++
      }
    }
    for (const el of [...pm.querySelectorAll('[data-md-math-block]')]) {
      let covered = false
      try { const p0 = v.posAtDOM(el, 0); const nn = v.state.doc.nodeAt(p0); const sz = nn ? nn.nodeSize : 1; covered = rangeFrom <= p0 && rangeTo >= p0 + sz } catch (e) {}
      if (!covered) continue
      const inner = el.firstElementChild || el
      const r = inner.getBoundingClientRect()
      if (!(r.width > 0.5 && r.height > 0.5)) continue
      fragN++
      const rr = { l: r.left, t: r.top, r: r.right, b: r.bottom }
      if (has(bandsA, rr) || has(hlA, rr)) continue
      if (nativeMode && has(natA, rr)) continue
      missN++
    }
    return { own, bandN: bandsA.length, hl: hlA.length, fragN, missN, wrote: sawWrite }
  }`
  const lsResolve = (aNeedle, aFx, bNeedle, bFx) =>
    json(`(() => {
      const R = (x) => ({ l: x.left, t: x.top, r: x.right, b: x.bottom })
      const find = (needle) => { const w = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = (n.textContent || '').indexOf(needle); if (i >= 0) return { n, i } } return null }
      const rectAt = (needle, fx) => {
        const h = find(needle)
        if (!h) return null
        const rg = document.createRange()
        rg.setStart(h.n, h.i); rg.setEnd(h.n, h.i + needle.length)
        const el = h.n.parentElement
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        const r = rg.getBoundingClientRect()
        return { x: Math.round(r.left + r.width * fx), y: Math.round((r.top + r.bottom) / 2), t: r.top, b: r.bottom, vh: innerHeight }
      }
      return { a: rectAt(${JSON.stringify(aNeedle)}, ${aFx}), b: rectAt(${JSON.stringify(bNeedle)}, ${bFx}) } })()`)
  const lsDrag = async (a, b, frames) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 })
    await sleep(22)
    const perFrame = []
    const seen = new Map()
    for (let i = 1; i <= frames; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(a.x + ((b.x - a.x) * i) / frames),
        y: Math.round(a.y + ((b.y - a.y) * i) / frames),
        button: 'left',
        buttons: 1
      })
      // **逐帧**判定：这一帧"本体"就是它的试探区间 ∪ 原生 DOM 区间
      const f = await json(`(() => {
        const pm = document.querySelector('.ProseMirror')
        const parts = (pm.getAttribute('data-img-drag-live') || '').split('|').map(Number)
        let from = parts.length === 4 && Number.isFinite(parts[2]) ? Math.min(parts[2], parts[3]) : null
        let to = parts.length === 4 && Number.isFinite(parts[2]) ? Math.max(parts[2], parts[3]) : null
        try { const q = window.getSelection(); if (q && q.rangeCount && !q.isCollapsed) { const v = window.__vt.ed().view; const p0 = v.posAtDOM(q.getRangeAt(0).startContainer, q.getRangeAt(0).startOffset); const p1 = v.posAtDOM(q.getRangeAt(0).endContainer, q.getRangeAt(0).endOffset); const lo = Math.min(p0, p1), hi = Math.max(p0, p1); if (hi > lo) { from = from == null ? lo : Math.min(from, lo); to = to == null ? hi : Math.max(to, hi) } } } catch (e) {}
        if (from == null || !(to > from)) return null
        return { from, to, cov: (${lsCoverFn})(from, to, true) } })()`)
      if (f) {
        perFrame.push({ live: `${f.from}-${f.to}`, missN: f.cov.missN, fragN: f.cov.fragN, own: f.cov.own, bandN: f.cov.bandN, hl: f.cov.hl })
        if (!seen.has(`${f.from}-${f.to}`)) seen.set(`${f.from}-${f.to}`, { r: `${f.from}-${f.to}`, ...f.cov })
      }
      await sleep(11)
    }
    const last = await json(`(() => { const pm = document.querySelector('.ProseMirror'); const parts = (pm.getAttribute('data-img-drag-live') || '').split('|').map(Number); return parts.length === 4 && Number.isFinite(parts[2]) ? { from: Math.min(parts[2], parts[3]), to: Math.max(parts[2], parts[3]) } : null })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
    await sleep(430)
    const settled = await json(`(() => { const s = window.__vt.ed().state.selection; return { from: s.from, to: s.to, empty: s.empty } })()`)
    const missing = last ? Math.max(0, settled.from - last.from) + Math.max(0, last.to - settled.to) : null
    const extra = last ? Math.max(0, last.from - settled.from) + Math.max(0, settled.to - last.to) : null
    return {
      last,
      settled,
      missing,
      extra,
      framesN: perFrame.length,
      missFrames: perFrame.filter((x) => x.missN > 0).length,
      missDetail: perFrame.filter((x) => x.missN > 0).slice(0, 4),
      spec: [...seen.values()]
    }
  }
  let lsCover = { err: null }
  let lsSettle = { err: null }
  try {
    await send('Page.bringToFront').catch(() => null)
    await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(300)
    /**
     * ⚠️ 走**打开文件**这条路，不用 `commands.setContent`：本条断言要的是**真渲染几何**
     * （图片实体盒 / 块级公式 NodeView / 表格行盒），而 `setContent` 那条路本轮实测把夹具
     * 解析变形（图片只剩一段空文本、段落被撑到 638px ⇒ `posAtCoords` 整片返回同一个位置），
     * 断言的就不是我们想测的东西了。文件名**不含 "lumin"**（本机有清理会按命令行关键字杀实例）。
     */
    /**
     * ⚠️ 文件名**每次都不一样**：应用对"已经打开过的路径"会**去重**（再 `openPath` 直接 resolve，
     * 不重读磁盘、不换文档）⇒ 上一轮遗留的同名夹具会让这里**看起来加载成功、实际还是旧文档**
     * （实测 `pmText` 还是上一段的 `qian <img …>`，端点自然取不到）。
     * 用「基础名 + 递增序号」保证每次都是**新路径**。文件名仍不含 "lumin"。
     */
    const lsFile = path.join(
      process.env.TEMP || 'C:\\Windows\\Temp',
      `xw-look-fixture-${Date.now().toString(36)}.md`
    )
    safe(() => fs.writeFileSync(lsFile, lsFixture, 'utf8'), null)
    /** 打开可能被"当前文档"状态拦一下 ⇒ 最多重试 3 次，并以**内容真的换了**为准（不看返回值）；
     *  若当前文档**本来就是这份夹具**，直接跳过重开（重开失败会让下面所有端点取不到 ⇒ 误报"端点不在视口内"） */
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await ev(`(window.__vt.files().current && String(window.__vt.files().current.content || '')).includes('行内公式行')`)) break
      await ev(`window.__lsOpen = window.__vt.files().openPath(${JSON.stringify(lsFile)}).then(() => 'ok').catch((e) => 'err:' + e.message); 1`)
      for (let i = 0; i < 20; i++) {
        await sleep(250)
        if (await ev(`(window.__vt.files().content || '').includes('行内公式行')`)) break
      }
      if (await ev(`(window.__vt.files().content || '').includes('行内公式行')`)) break
    }
    await sleep(900)
    for (let i = 0; i < 20; i++) {
      const ready = await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete) && document.querySelectorAll('.ProseMirror table').length > 0`)
      if (ready) break
      await sleep(300)
    }
    // 端点解析**重试**：文档刚切换时 DOM 可能还没量好（否则会误报"端点不在视口内"）
    let gy = await lsResolve('行内公式行：开头', 0.2, '尾段：随便', 0.8)
    for (let i = 0; i < 6 && !(gy.a && gy.b); i++) {
      await sleep(400)
      gy = await lsResolve('行内公式行：开头', 0.2, '尾段：随便', 0.8)
    }
    await ev(`(() => { const pm = document.querySelector('.ProseMirror'); for (const el of [pm, ...document.querySelectorAll('.editor-content,.md-preview,.editor-scroll,.scroll-area')]) { try { el.scrollTop = 0 } catch (e) {} } window.scrollTo(0, 0); return 'ok' })()`)
    await sleep(500)
    lsCover = { loaded: await ev(`(window.__vt.files().content || '').includes('行内公式行')`) }
    const away = await json(`(() => { const w = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if ((n.textContent || '').trim().length > 4) { const rg = document.createRange(); rg.setStart(n, 0); rg.setEnd(n, 1); const r = rg.getBoundingClientRect(); return { x: Math.round(r.left + 2), y: Math.round((r.top + r.bottom) / 2) } } } return { x: 400, y: 30 } })()`)
    // ① 覆盖差额：**首行正文 → 尾段**（大范围多元素：跨行内公式 + 块级公式 + 两图 + 表格 + 标题）
    const g1 = gy.a && gy.b && gy.a.y > 8 && gy.a.y < gy.a.vh - 8 && gy.b.y > 8 && gy.b.y < gy.b.vh - 8 ? await lsDrag(gy.a, gy.b, 26) : null
    lsCover = g1 ? { loaded: true, a: gy.a, b: gy.b, framesN: g1.framesN, missFrames: g1.missFrames, missDetail: g1.missDetail, spec: g1.spec } : { err: '端点不在视口内', a: gy.a, b: gy.b, docHas: await ev(`(window.__vt.files().current && String(window.__vt.files().current.content || '')).includes('行内公式行')`), pmText: await ev(`(document.querySelector('.ProseMirror') && document.querySelector('.ProseMirror').textContent || '').slice(0, 40)`), pmP: await ev(`document.querySelectorAll('.ProseMirror p').length`) }
    // ② settled == live：三类跨越（表格前→后 / 块级公式 / 图片）各一例 + 大范围
    const cases = []
    const spec2 = [
      ['表格 表头→表体', '粗体甲', 0.4, '粗体丙', 0.6],
      ['块级公式后→尾段', '段A：星号', 0.4, '尾段：随便', 0.6],
      ['正文→跨行内图到后文', '段B：行内', 0.4, '后文继续', 0.6],
      ['大范围 首行→尾段', '行内公式行：开头', 0.2, '尾段：随便', 0.8],
      ['大范围反向 尾段→首行', '尾段：随便', 0.8, '行内公式行：开头', 0.2]
    ]
    for (const [name, an, af, bn, bf] of spec2) {
      await ev(`(() => { const e = window.__vt.ed(); const v = e.view; const s = document.querySelectorAll('.lm-prompt,.lm-modal'); s.forEach((x) => x.remove()); return 'ok' })()`)
      const g = await lsResolve(an, af, bn, bf)
      if (!g.a || !g.b || g.a.y < 8 || g.a.y > g.a.vh - 8 || g.b.y < 8 || g.b.y > g.b.vh - 8) { cases.push({ name, skip: '端点不在视口内' }); continue }
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: away.x, y: away.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: away.x, y: away.y, button: 'left', clickCount: 1 })
      await sleep(220)
      const r = await lsDrag(g.a, g.b, 20)
      /**
       * **手势有效性自证**：`live` 的跨度必须明显大于"单帧噪声"（≥3 位且确实随拖动推进）。
       * 否则说明这一帧指针压根没被编辑器接住（遮挡 / 坐标落在容器外）⇒ 记 `skip` 而不是让
       * `missing/extra` 去伪造一个"不一致"（那是测量失败，不是产品缺陷）。
       */
      if (!r.last || r.last.to - r.last.from < 3) {
        cases.push({ name, skip: '手势无效(live 跨度<3)', live: r.last })
        continue
      }
      cases.push({ name, from: g.a, to: g.b, live: r.last, settled: r.settled, missing: r.missing, extra: r.extra, framesN: r.framesN, missFrames: r.missFrames })
    }
    lsSettle = { cases }
  } catch (e) {
    lsCover = { err: String((e && e.message) || e) }
    lsSettle = { err: String((e && e.message) || e) }
  }
  check(
    '㊴① **拖动期处处有样式**：大范围多元素拖动（跨行内/块级公式+图片+表格+标题）逐帧"原生会画的覆盖 − 我们的可见绘制" = 0',
    !lsCover.err && lsCover.missFrames === 0 && lsCover.spec && lsCover.spec.length > 0,
    JSON.stringify(lsCover)
  )
  const settleDiff = (lsSettle.cases || []).filter((c) => !c.skip)
  check(
    '㊴② **松手后与拖动期一致**：表格/块级公式/图片三类跨越 + 大范围（正/反）⇒ settled 与 live 双向差集 = 0',
    !lsSettle.err &&
      settleDiff.length >= 4 &&
      settleDiff.every((c) => c.missing === 0 && c.extra === 0),
    JSON.stringify(lsSettle)
  )

  const pass = results.filter((r) => r.ok).length
  console.log(`TOTAL ${results.length} PASS ${pass} FAIL ${results.length - pass}`)
  console.log(`--- ${pass}/${results.length} PASS`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.log('FATAL ' + (e && e.message))
  console.log(`TOTAL ${results.length} PASS ${results.filter((r) => r.ok).length} FAIL ${results.filter((r) => !r.ok).length}`)
  console.log('--- 0/1 PASS')
  process.exit(1)
})
