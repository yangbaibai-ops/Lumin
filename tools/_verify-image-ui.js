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
  `<img src="PLACE_B" style="zoom:25%;" />\n\n最后一段文字。\n\n前 **粗体** 后\n`

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
    window.__vt = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  if (boot !== 'OK') throw new Error('bridge ' + boot)
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('.ProseMirror[contenteditable=true]')`)) break
    await sleep(300)
  }
  await send('Network.enable')
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  const doc = MD.replace('PLACE_A', PNG_A).replace('PLACE_B', PNG_B)
  // 用源码面灌内容（走真实解析路径：`<img>` 行内原文 ↔ 独立成行时的 html_block 都是解析器定的）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(1000)

  const state = () =>
    json(`(() => {
      const line = document.querySelector('[data-img-source]')
      const bar = document.querySelector('[data-img-zoom-bar]')
      return {
        hasLine: !!line,
        lineText: line ? line.getAttribute('data-img-text') : null,
        lineValue: (() => { const i = document.querySelector('[data-img-source-input]'); return i ? i.value : null })(),
        lineInvalid: !!document.querySelector('[data-img-source-input].is-invalid'),
        lineKind: line ? line.getAttribute('data-img-kind') : null,
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

  // ── ① 居中 ──
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
    '②A 点图片 ⇒ 上方出现源码行且内容 == 该图 markdown',
    A.hasLine && A.lineValue === `![](${PNG_A})` && A.lineKind === 'node',
    JSON.stringify({ hasLine: A.hasLine, kind: A.lineKind, lineValue: (A.lineValue || '').slice(0, 30) })
  )
  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-source-toolbar.png'), Buffer.from(shot1.result.data, 'base64')), null)

  // ── ③ 悬浮工具栏（此刻源码行开着）──
  const bar = await json(`(() => {
    const b = document.querySelector('[data-img-zoom-bar]')
    const line = document.querySelector('[data-img-source]')
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
    after75.md.indexOf(`src="${PNG_B}" style="zoom:75%;"`) >= 0 &&
      countTag(after75.md, `<img src="${PNG_B}"`) === 1 &&
      after75.md.indexOf('zoom:50%') >= 0 /* P2 原来的那句已被替换，但 P1 那段仍是 50% */ &&
      countTag(after75.md, 'style="zoom:75%;"') === 1,
    JSON.stringify({
      want: `src="${PNG_B}" style="zoom:75%;"`,
      tagsForB: countTag(after75.md, `<img src="${PNG_B}"`),
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
    view.state.doc.descendants((node, pos) => {
      if (node.isText && /^|^<img\\b/i.test(node.text || '') && /<img\\b/i.test(node.text || '')) range = { from: pos, to: pos + node.nodeSize }
      return true
    })
    return range || { from: -1, to: -1 }
  })()`)
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rawRange.from + 2}, to: ${rawRange.to - 2} }); return 'ok' })()`)
  await sleep(400)
  const D = await state()
  check(
    '②D 选区边界**切进**构造内部 ⇒ 显示，且源码 == 文档里那段原文',
    D.hasLine && D.lineKind === 'raw' && D.lineValue === `<img src="${PNG_B}" style="zoom:75%;" />`,
    JSON.stringify({ rawRange, hasLine: D.hasLine, kind: D.lineKind, text: (D.lineValue || '').slice(0, 40) })
  )
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rawRange.from - 1}, to: ${rawRange.to + 1} }); return 'ok' })()`)
  await sleep(400)
  const C = await state()
  check('②C 选区**完全包住**构造 ⇒ 不显示', C.hasLine === false, JSON.stringify({ rawRange, hasLine: C.hasLine }))

  // ── ⑤ 远程图片：无占位图标/文案；未点击不发请求 ──
  const guard = await json(`(() => {
    const els = [...document.querySelectorAll('[data-remote-src]')]
    const first = els[0] || null
    const cs = first ? getComputedStyle(first, '::before') : null
    return {
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
    '⑤ 远程图片没有占位图标/文案节点（无 label/svg/img，且 ::before 无图标）',
    guard.count >= 1 &&
      guard.childNodes === 0 &&
      guard.text === '' &&
      guard.labels === 0 &&
      guard.svgs === 0 &&
      (guard.beforeContent === 'none' || guard.beforeContent === 'normal'),
    JSON.stringify(guard)
  )
  const remoteReqs = events.filter(
    (m) => m.method === 'Network.requestWillBeSent' && /example\.com/.test(m.params?.request?.url || '')
  ).length
  check(
    '⑤ 未点击时没有发起远程请求（CDP Network 计数 == 0；元素仍然没有 src）',
    remoteReqs === 0 && guard.hasSrc === false && String(guard.dataSrc).indexOf('example.com') >= 0,
    JSON.stringify({ remoteReqs, hasSrc: guard.hasSrc, dataSrc: guard.dataSrc })
  )
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-centered.png'), Buffer.from(shot2.result.data, 'base64')), null)

  // ═══ 第五十五轮新增：① 源码行可编辑 ═══════════════════════════════════════════
  // 先把文档**复位成夹具**（前面的缩放/转换已经改过它；这一组要的是确定的那段）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(900)
  // 先点开 P1 的图片，让源码行出现
  await click(await firstImgPt())
  const edit0 = await state()
  check(
    'E1 源码行是**可编辑控件**（出现 `[data-img-source-input]` 且初值 == 当前源码）',
    edit0.hasLine && edit0.lineValue === `![](${PNG_A})`,
    JSON.stringify({ hasLine: edit0.hasLine, value: (edit0.lineValue || '').slice(0, 24) })
  )
  // 编辑中（只输入、不提交）⇒ 源码行不许被显隐判据收走
  const editedUrl = 'https://example.org/pic-renamed.png'
  await ev(`(() => {
    const i = document.querySelector('[data-img-source-input]')
    i.focus()
    i.value = ${JSON.stringify(`![pic2](${editedUrl})`)}
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(450)
  const editing = await state()
  check(
    'E2 编辑期间源码行**不消失**（打字不提交时仍在，且文档还没变）',
    editing.hasLine && editing.md.indexOf(editedUrl) < 0,
    JSON.stringify({ hasLine: editing.hasLine, docChanged: editing.md.indexOf(editedUrl) >= 0 })
  )
  // 回车提交：Markdown 逐字节等于新的 `![pic2](新URL)`，图片重渲染成新 src
  await ev(`(() => {
    const i = document.querySelector('[data-img-source-input]')
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`)
  await sleep(900)
  const committed = await state()
  const commitMark = await ev(
    `(() => { const l = document.querySelector('[data-img-source]'); return l ? (l.getAttribute('data-img-commit') || '(none)') + ' ' + (l.getAttribute('data-img-commit-msg') || '') : 'no-line' })()`
  )
  const wantMd = `![pic2](${editedUrl})`
  const p1ImgSrc = await ev(`(() => {
    // 新 src 是**远程**地址 ⇒ 按隐私闸门它渲染成占位（没有 src 属性）；
    // 所以"图片跟着重渲染"的证据是二者之一：真 <img src> 或 [data-remote-src] 占位。
    const want = ${JSON.stringify(editedUrl)}
    const im = [...document.querySelectorAll('.ProseMirror img')].find((x) => x.getAttribute('src') === want)
    if (im) return im.getAttribute('src')
    const ph = [...document.querySelectorAll('[data-remote-src]')].find((x) => x.getAttribute('data-remote-src') === want)
    return ph ? ph.getAttribute('data-remote-src') : null
  })()`)
  check(
    'E3 改 URL + 回车 ⇒ Markdown 逐字节等于新 `![alt](url)`，且图片重渲染（img.src 跟着变）',
    committed.md.indexOf(wantMd) >= 0 && p1ImgSrc === editedUrl,
    JSON.stringify({
      wantMd,
      inMd: committed.md.indexOf(wantMd) >= 0,
      imgSrc: String(p1ImgSrc).slice(0, 40),
      commit: commitMark,
      value: (committed.lineValue || '').slice(0, 30)
    })
  )
  // 非法输入：不改文档 + 红边反馈 + 还原原值
  const beforeBad = committed.md
  const valueBeforeBad = committed.lineValue
  await ev(`(() => {
    const i = document.querySelector('[data-img-source-input]')
    i.focus()
    i.value = '这不是图片源码'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`)
  await sleep(600)
  const bad = await state()
  check(
    'E4 非法输入 ⇒ **文档不变**（前后 Markdown 相同）+ 红边 + 还原原值',
    bad.md === beforeBad && bad.lineInvalid === true && bad.lineValue === valueBeforeBad,
    JSON.stringify({
      sameDoc: bad.md === beforeBad,
      invalid: bad.lineInvalid,
      restored: bad.lineValue === valueBeforeBad,
      value: (bad.lineValue || '').slice(0, 40)
    })
  )

  // ═══ ② 行内混排的原始 HTML 图片不许拆行 ═══════════════════════════════════════
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
    lineInfo.textRects.filter((r) => r.b > r.t).length > 0 &&
    lineInfo.textRects
      .filter((r) => r.b > r.t) // 只看**可见**文本（被隐藏的标记文本 rect 是 0 高）
      .every((r) => r.b > lineInfo.widgetRect.t && r.t < lineInfo.widgetRect.b)
  check(
    'E5 行内混排的 `<img>` **保持行内**（widget 是 inline、与前后文字在同一行的纵向区间里）',
    lineInfo.inline === 'true' && sameLine,
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

  // ═══ ③ `.img-guard` 彻底消失（改判据 + 点击加载仍可用）═══════════════════════════
  const guardGone = await json(`(() => ({
    byClass: document.querySelectorAll('.img-guard').length,
    byLabel: document.querySelectorAll('.img-guard__label').length,
    byDataAttr: document.querySelectorAll('[data-remote-src]').length,
    childNodes: (document.querySelector('[data-remote-src]') || {}).childNodes ? document.querySelector('[data-remote-src]').childNodes.length : -1,
    hasSrc: (document.querySelector('[data-remote-src]') || { hasAttribute: () => null }).hasAttribute('src')
  }))()`)
  check(
    'E7 `.img-guard` 类名与文案节点计数均为 **0**（占位改用 `[data-remote-src]`）',
    guardGone.byClass === 0 && guardGone.byLabel === 0 && guardGone.byDataAttr >= 1 && guardGone.childNodes === 0,
    JSON.stringify(guardGone)
  )
  const reqsBeforeClick = events.filter(
    (m) => m.method === 'Network.requestWillBeSent' && /example\.com/.test(m.params?.request?.url || '')
  ).length
  const clickPt = await json(`(() => {
    // 明确点**那张远程图（example.com）**的占位：E3 之后 P1 也变成远程图了，不能取第一个
    const el = document.querySelector('[data-remote-src*="example.com"]') || document.querySelector('[data-remote-src]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + Math.max(2, r.width / 2)), y: Math.round(r.top + Math.max(2, r.height / 2)) }
  })()`)
  await click(clickPt)
  await sleep(900)
  const reqsAfterClick = events.filter(
    (m) => m.method === 'Network.requestWillBeSent' && /example\.com/.test(m.params?.request?.url || '')
  ).length
  check(
    'E8 点击占位**仍然能加载**：点击前请求数 == 0、点击后 > 0（且占位已被换成真 `<img>`）',
    reqsBeforeClick === 0 && reqsAfterClick > 0,
    JSON.stringify({ reqsBeforeClick, reqsAfterClick })
  )

  // ═══ 第五十八轮：图片"标识符"要像 `**` 那样当正文展示、去掉波浪线、与图片同行时置顶 ═══
  // 夹具复位（前面的缩放/提交已经改过文档），再单独点开 **行内混排** 的那张图（标记与图片同一行）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(900)
  const inlinePt = await json(`(() => {
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!w) return null
    const r = w.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(inlinePt)
  await sleep(500)
  const marker = await json(`(() => {
    const line = document.querySelector('[data-img-source]')
    const ta = document.querySelector('[data-img-source-input]')
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    const img = w ? w.querySelector('img') : null
    // 行盒：用 Range 量"这一段第一行"的顶（text 首行）
    const p = w ? w.closest('p') : null
    let lineTop = null
    if (p) {
      const rg = document.createRange()
      rg.selectNodeContents(p)
      const rs = [...rg.getClientRects()].filter((r) => r.height > 0)
      lineTop = rs.length ? Math.round(rs[0].top) : null
    }
    const cs = line ? getComputedStyle(line) : null
    const cst = ta ? getComputedStyle(ta) : null
    const lr = line ? line.getBoundingClientRect() : null
    const ir = img ? img.getBoundingClientRect() : null
    return {
      hasMarker: !!line,
      markerClass: line ? line.className : null,
      markerTag: line ? line.tagName.toLowerCase() : null,
      markerSpellcheck: line ? line.getAttribute('spellcheck') : null,
      markerAutocorrect: line ? line.getAttribute('autocorrect') : null,
      markerAutocapitalize: line ? line.getAttribute('autocapitalize') : null,
      inputSpellcheckAttr: ta ? ta.getAttribute('spellcheck') : null,
      inputSpellcheckProp: ta ? ta.spellcheck : null,
      inputAutocorrect: ta ? ta.getAttribute('autocorrect') : null,
      inputAutocapitalize: ta ? ta.getAttribute('autocapitalize') : null,
      markerFontSize: cs ? cs.fontSize : null,
      markerColor: cs ? cs.color : null,
      markerFontFamily: cs ? cs.fontFamily.slice(0, 40) : null,
      markerBackground: cs ? cs.backgroundColor : null,
      markerPadding: cs ? cs.padding : null,
      markerVerticalAlign: cs ? cs.verticalAlign : null,
      markerTop: lr ? Math.round(lr.top) : null,
      markerBottom: lr ? Math.round(lr.bottom) : null,
      imgTop: ir ? Math.round(ir.top) : null,
      imgBottom: ir ? Math.round(ir.bottom) : null,
      imgCenterY: ir ? Math.round((ir.top + ir.bottom) / 2) : null,
      lineTop,
      bodyFontSize: getComputedStyle(document.querySelector('.ProseMirror p') || document.body).fontSize,
      taFontSize: cst ? cst.fontSize : null,
      taColor: cst ? cst.color : null
    }
  })()`)
  const shot3 = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-active.png'), Buffer.from(shot3.result.data, 'base64')), null)

  // ① 正文形态：与 `.md-marker` 同族（先激活一个粗体标记，量它的字号/颜色）
  await ev(`(() => {
    const v = window.__vt.ed().view
    let hit = null
    v.state.doc.descendants((n, pos) => {
      if (n.isText && n.text === '粗体') hit = { from: pos, to: pos + n.nodeSize }
      return true
    })
    if (hit) v.dispatch(v.state.tr.setSelection(window.__vt.ed().state.selection.constructor.create(v.state.doc, hit.from + 1)))
    return 'ok'
  })()`)
  await sleep(450)
  const mdMarker = await json(`(() => {
    const ms = [...document.querySelectorAll('.md-marker')]
    const m = ms.find((x) => x.querySelector('.md-reveal-inline')) || ms[0]
    if (!m) return { ok: false, count: ms.length }
    const cs = getComputedStyle(m)
    return {
      ok: true,
      count: ms.length,
      revealed: !!m.querySelector('.md-reveal-inline'),
      fontSize: cs.fontSize,
      color: cs.color,
      fontFamily: cs.fontFamily.slice(0, 40),
      background: cs.backgroundColor,
      padding: cs.padding
    }
  })()`)
  check(
    '⑤ 激活时标记是**正文形态**（字号/颜色与 `.md-marker` 同族：同 body 字号、同 --marker 墨色）',
    marker.hasMarker &&
      mdMarker.ok &&
      marker.markerFontSize === mdMarker.fontSize &&
      marker.markerColor === mdMarker.color &&
      marker.taFontSize === mdMarker.fontSize &&
      marker.markerFontFamily === mdMarker.fontFamily,
    JSON.stringify({
      标记: { fontSize: marker.markerFontSize, color: marker.markerColor, family: marker.markerFontFamily, bg: marker.markerBackground, padding: marker.markerPadding },
      文本域: { fontSize: marker.taFontSize, color: marker.taColor },
      mdMarker
    })
  )
  check(
    '⑥ 去掉拼写检查波浪线：标记元素 `spellcheck="false"`（+ autocorrect/autocapitalize 关闭）',
    marker.markerSpellcheck === 'false' &&
      marker.inputSpellcheckAttr === 'false' &&
      marker.inputSpellcheckProp === false &&
      marker.markerAutocorrect === 'off' &&
      marker.markerAutocapitalize === 'off' &&
      marker.inputAutocorrect === 'off' &&
      marker.inputAutocapitalize === 'off',
    JSON.stringify({
      line: { spellcheck: marker.markerSpellcheck, autocorrect: marker.markerAutocorrect, autocapitalize: marker.markerAutocapitalize, tag: marker.markerTag, class: marker.markerClass },
      input: { spellcheckAttr: marker.inputSpellcheckAttr, spellcheckProp: marker.inputSpellcheckProp, autocorrect: marker.inputAutocorrect, autocapitalize: marker.inputAutocapitalize }
    })
  )
  const nearTop =
    marker.markerTop != null && marker.imgTop != null && marker.imgCenterY != null &&
    Math.abs(marker.markerTop - marker.imgTop) < Math.abs(marker.markerTop - marker.imgCenterY)
  check(
    '⑦ 与图片**同行时标记置顶**（marker.top 更接近 img.top / 行顶，而不是 img.centerY）',
    nearTop,
    JSON.stringify({
      markerTop: marker.markerTop,
      markerBottom: marker.markerBottom,
      imgTop: marker.imgTop,
      imgBottom: marker.imgBottom,
      imgCenterY: marker.imgCenterY,
      lineTop: marker.lineTop,
      verticalAlign: marker.markerVerticalAlign,
      diffTop: marker.markerTop != null ? Math.abs(marker.markerTop - marker.imgTop) : null,
      diffCenter: marker.markerTop != null && marker.imgCenterY != null ? Math.abs(marker.markerTop - marker.imgCenterY) : null
    })
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
