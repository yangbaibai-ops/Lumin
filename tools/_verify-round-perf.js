'use strict'
// ─── 验收：本轮三项（节点整选框 / 分屏拖拽性能 / 设置面板）─────────────────────
//
// A. 节点级整选**不再出现**（`.ProseMirror-selectednode` 不落地、选中元素没有描边），
//    且「降级成文本光标」这件事真的是光标（可以继续打字）。
// B. 分屏拖拽：**拖拽期间不碰 Vue 状态**（两侧 inline 样式是直写的）、松手后清理干净、
//    比例写回设置、以及一份**帧时间基线**（重文档下的 p95，防止以后把优化改回去）。
// C. 设置面板：遮罩**压暗不模糊**（backdrop-filter 为 none 且有暗色底色）、
//    面板本身清晰、标题栏可拖动且位移只走 transform。
//
// 跑法：node tools/_verify-round-perf.js（先起隔离实例）
const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  openDocWith,
  fatal
} = require('./lib/harness')

/** 造一份「有分量」的文档：段落 + 代码块，用来把布局成本压出来 */
function heavyMarkdown(paras = 400, blocks = 8) {
  let md = ''
  for (let i = 0; i < paras; i++) {
    md += `第 ${i} 段：普通正文，含 **加粗** 与 *斜体* 还有 \`行内代码\`。\n\n`
    if (blocks && i % Math.max(1, Math.floor(paras / blocks)) === 0) {
      md += '```js\nconst value = 1\nfunction compute() { return value * 2 }\n```\n\n'
    }
  }
  return md
}

async function main() {
  const report = new Reporter('验收：节点整选 / 分屏拖拽性能 / 设置面板')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { send, ev } = app

  async function mouse(type, x, y, buttons) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
      buttons,
      clickCount: 1
    })
  }

  // ═══ A. 节点级整选：不落地 + 没有描边 ═══
  await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await openDocWith(
    app,
    '前一段文字\n\n![图](https://example.com/does-not-exist.png)\n\n后一段文字\n',
    'node-select.md'
  )
  await waitEditor(ev)
  await sleep(900)
  const a = await ev(`(() => {
    const ed = window.__L.ed()
    const P = window.__L.pinia
    // 1) 直接派一个 NodeSelection：filterTransaction 应当把它降级掉
    let imgPos = -1
    ed.state.doc.descendants((n, pos) => { if (n.type.name === 'image') imgPos = pos })
    if (imgPos < 0) return JSON.stringify({ setup: 'no-image' })
    const { NodeSelection } = window.__PM_STATE || {}
    P // 占位，避免 lint 抱怨未使用
    return JSON.stringify({ setup: 'ok', imgPos,
      selBefore: ed.state.selection.constructor.name,
      hasSelectedNodeClass: document.querySelectorAll('.ProseMirror-selectednode').length,
      imgOutline: (() => {
        const img = document.querySelector('.ProseMirror img')
        if (!img) return null
        const cs = getComputedStyle(img)
        return { outline: cs.outlineStyle + ' ' + cs.outlineWidth, outlineColor: cs.outlineColor }
      })()
    })
  })()`)
    .then(JSON.parse)
    .catch((e) => ({ err: e.message }))
  console.log('A-setup ' + JSON.stringify(a))
  report.check('A 文档里有可整选的节点（图片）', a.setup === 'ok', JSON.stringify(a))

  // 用键盘/命令触发一次节点整选：点图片（PM 默认会把图片选成 NodeSelection）
  if (a.setup === 'ok') {
    const imgPoint = await ev(`(() => {
      const img = document.querySelector('.ProseMirror img')
      if (!img) return JSON.stringify({ found: false })
      const r = img.getBoundingClientRect()
      return JSON.stringify({ found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`).then(JSON.parse)
    if (imgPoint.found) {
      await mouse('mouseMoved', imgPoint.x, imgPoint.y, 0)
      await mouse('mousePressed', imgPoint.x, imgPoint.y, 1)
      await mouse('mouseReleased', imgPoint.x, imgPoint.y, 0)
      await sleep(400)
    }
    const a2 = await ev(`(() => {
      const ed = window.__L.ed()
      const el = document.querySelector('.ProseMirror-selectednode')
      const img = document.querySelector('.ProseMirror img')
      const cs = img ? getComputedStyle(img) : null
      return JSON.stringify({
        selType: ed.state.selection.constructor.name,
        selectedNodeEls: document.querySelectorAll('.ProseMirror-selectednode').length,
        imgOutlineStyle: cs ? cs.outlineStyle : null,
        imgOutlineWidth: cs ? cs.outlineWidth : null,
        imgOutlineColor: cs ? cs.outlineColor : null,
        focused: !!el || false
      })
    })()`).then(JSON.parse)
    console.log('A-after ' + JSON.stringify(a2))
    report.check(
      'A 点图片后没有节点整选（selection 不是 NodeSelection）',
      a2.selType !== 'NodeSelection',
      a2.selType
    )
    report.check(
      'A 没有 .ProseMirror-selectednode 元素',
      a2.selectedNodeEls === 0,
      String(a2.selectedNodeEls)
    )
    report.check(
      'A 图片没有紫色（主题色）描边',
      a2.imgOutlineStyle === 'none' || a2.imgOutlineWidth === '0px',
      `outline=${a2.imgOutlineStyle} ${a2.imgOutlineWidth} ${a2.imgOutlineColor}`
    )
    // 降级之后仍然可编辑：敲一个字应当进文档
    const before = await ev(`window.__L.ed().state.doc.textContent.length`)
    await send('Input.insertText', { text: '字' })
    await sleep(500)
    const after = await ev(`window.__L.ed().state.doc.textContent.length`)
    report.check('A 降级成文本光标后仍可输入', after > before, `${before} -> ${after}`)
  }

  // ═══ B. 分屏拖拽 ═══
  await openDocWith(app, heavyMarkdown(400, 8), 'split-perf.md')
  await waitEditor(ev)
  await sleep(1800)
  await ev(`(() => { window.__L.ui().editorMode = 'split'; return 'ok' })()`)
  await sleep(1800)
  const b = await ev(`(async () => {
    const host = document.querySelector('.split-divider').parentElement
    const div = document.querySelector('.split-divider')
    if (!div) return JSON.stringify({ err: 'no-divider' })
    const panes = () => [...host.children].filter((c) => c.classList && c.classList.contains('bg-paper'))
    const rr = host.getBoundingClientRect(); const dr = div.getBoundingClientRect()
    const cxp = Math.round(dr.left + dr.width / 2), cy = Math.round(rr.top + 60)
    const frames = []; let running = true; let last = performance.now()
    const loop = (t) => { frames.push(t - last); last = t; if (running) requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
    const t0 = performance.now()
    div.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cxp, clientY: cy, button: 0 }))
    for (let i = 0; i < 80; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cxp + Math.round(Math.sin(i / 8) * 140), clientY: cy }))
      await new Promise((r2) => setTimeout(r2, 8))
    }
    const mid = { bodyClass: document.body.className,
      leftInline: panes()[0].getAttribute('style') || '',
      leftW: Math.round(panes()[0].getBoundingClientRect().width) }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cxp + 90, clientY: cy }))
    running = false
    await new Promise((r2) => setTimeout(r2, 350))
    const after = { bodyClass: document.body.className,
      leftInline: panes()[0].getAttribute('style') || '',
      rightInline: panes()[1].getAttribute('style') || '',
      leftW: Math.round(panes()[0].getBoundingClientRect().width),
      hostW: Math.round(host.getBoundingClientRect().width),
      ratio: window.__L.settings().splitRatio }
    const f = frames.slice(3); const s = [...f].sort((x, y) => x - y)
    return JSON.stringify({ mid, after,
      frames: f.length, p50: +s[Math.floor(s.length * 0.5)].toFixed(2),
      p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +Math.max(...f).toFixed(2),
      over33: f.filter((v) => v > 33).length })
  })()`).then(JSON.parse)
  console.log('B ' + JSON.stringify(b))
  report.check(
    'B 拖拽中禁选中类挂在 body 上（不再写 `.split-dragging *`）',
    b.mid?.bodyClass === 'split-dragging',
    String(b.mid?.bodyClass)
  )
  report.check(
    'B 拖拽中两侧样式是直写的（绕开 Vue 响应式）',
    /width:/.test(b.mid?.leftInline || ''),
    b.mid?.leftInline
  )
  report.check('B 松手后 body 类被摘掉', b.after?.bodyClass === '', String(b.after?.bodyClass))
  // pane 宽度只有一个主人（syncPaneLayout 直写 DOM）：松手后 inline 保留终态，
  // 不会出现「清 inline 交回 Vue」那种掉回内容宽度（516px）的情况
  report.check(
    'B 松手后 inline 保留终态宽度（比例唯一写入方）',
    /flex:\s*0 0 auto/.test(b.after?.leftInline || '') &&
      /width:\s*[\d.]+%/.test(b.after?.leftInline || ''),
    b.after?.leftInline
  )
  report.check(
    'B 松手后比例写回设置且与左栏宽度一致',
    Math.abs((b.after?.leftW ?? 0) / (b.after?.hostW ?? 1) - (b.after?.ratio ?? 0)) < 0.02,
    JSON.stringify({ leftW: b.after?.leftW, hostW: b.after?.hostW, ratio: b.after?.ratio })
  )
  // 切换模式再切回：直写的那份宽度不会残留成错误布局
  const bMode = await ev(`(async () => {
    const host = document.querySelector('.split-divider').parentElement
    const panes = () => [...host.children].filter((c) => c.classList && c.classList.contains('bg-paper'))
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms))
    window.__L.ui().editorMode = 'wysiwyg'
    await sleep2(300)
    const wy = { left: panes()[0].getAttribute('style') || '', right: panes()[1].getAttribute('style') || '',
      leftW: Math.round(panes()[0].getBoundingClientRect().width), hostW: Math.round(host.getBoundingClientRect().width) }
    window.__L.ui().editorMode = 'source'
    await sleep2(300)
    const src = { left: panes()[0].getAttribute('style') || '', right: panes()[1].getAttribute('style') || '',
      rightW: Math.round(panes()[1].getBoundingClientRect().width), leftW: Math.round(panes()[0].getBoundingClientRect().width) }
    window.__L.ui().editorMode = 'split'
    await sleep2(400)
    const back = { left: panes()[0].getAttribute('style') || '',
      leftW: Math.round(panes()[0].getBoundingClientRect().width), hostW: Math.round(host.getBoundingClientRect().width),
      ratio: window.__L.settings().splitRatio }
    return JSON.stringify({ wy, src, back })
  })()`).then(JSON.parse)
  console.log('B-modes ' + JSON.stringify(bMode))
  report.check(
    'B wysiwyg 下渲染面板整幅、源码面板 display:none',
    /display:\s*none/.test(bMode.wy?.right || '') &&
      !/display:\s*none/.test(bMode.wy?.left || '') &&
      Math.abs((bMode.wy?.leftW ?? 0) / (bMode.wy?.hostW ?? 1) - 1) < 0.02,
    JSON.stringify(bMode.wy)
  )
  report.check(
    'B source 下源码面板整幅、渲染面板 display:none 且不残留宽度',
    /display:\s*none/.test(bMode.src?.left || '') && !/width:/.test(bMode.src?.left || ''),
    JSON.stringify(bMode.src)
  )
  report.check(
    'B 切回 split 仍按比例分栏（宽度不残留）',
    Math.abs((bMode.back?.leftW ?? 0) / (bMode.back?.hostW ?? 1) - (bMode.back?.ratio ?? 0)) < 0.02,
    JSON.stringify(bMode.back)
  )
  report.check(
    'B 拖拽期间帧率基线：p95 ≤ 34ms（重文档 400 段）',
    (b.p95 ?? 999) <= 34,
    `p95=${b.p95} max=${b.max} over33=${b.over33} frames=${b.frames}`
  )

  // ═══ C. 设置面板 ═══
  await ev(`(() => { window.__L.ui().openSettings('editor'); return 'ok' })()`)
  await sleep(700)
  const c1 = await ev(`(() => {
    const scrim = document.querySelector('.settings-scrim')
    const panel = document.querySelector('.settings-panel')
    const handle = document.querySelector('.settings-drag-handle')
    if (!scrim || !panel) return JSON.stringify({ found: false })
    const sc = getComputedStyle(scrim); const pc = getComputedStyle(panel)
    const h = handle ? getComputedStyle(handle) : null
    return JSON.stringify({ found: true,
      scrimBackdrop: sc.backdropFilter || sc.webkitBackdropFilter,
      scrimAnim: sc.animationName,
      scrimBg: sc.backgroundColor,
      panelBackdrop: pc.backdropFilter || pc.webkitBackdropFilter,
      panelBg: pc.backgroundColor,
      panelTransform: pc.transform,
      handleCursor: h ? h.cursor : null,
      oldMaskBlur: document.querySelector('.settings-mask .backdrop-blur-\\\\[2px\\\\]') ? true : false })
  })()`).then(JSON.parse)
  console.log('C1 ' + JSON.stringify(c1))
  report.check(
    'C 遮罩存在且不再模糊背景',
    c1.found === true && (c1.scrimBackdrop === 'none' || !c1.scrimBackdrop),
    `backdrop=${c1.scrimBackdrop}`
  )
  report.check(
    'C 遮罩是压暗的（有暗色底色）',
    /rgba?\(/.test(c1.scrimBg || '') && c1.scrimBg !== 'rgba(0, 0, 0, 0)',
    c1.scrimBg
  )
  report.check(
    'C 面板本身不模糊（清晰）',
    c1.panelBackdrop === 'none' || !c1.panelBackdrop,
    `panelBackdrop=${c1.panelBackdrop}`
  )
  report.check(
    'C 标题栏是拖动把手（grab 光标）',
    c1.handleCursor === 'grab',
    String(c1.handleCursor)
  )

  // 拖标题栏：位移只走 transform
  const hp = await ev(`(() => {
    const h = document.querySelector('.settings-drag-handle')
    const r = h.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`).then(JSON.parse)
  await mouse('mouseMoved', hp.x, hp.y, 0)
  await mouse('mousePressed', hp.x, hp.y, 1)
  await sleep(80)
  await mouse('mouseMoved', hp.x + 120, hp.y + 60, 1)
  await sleep(150)
  const c2 = await ev(`(() => {
    const p = document.querySelector('.settings-panel')
    const r = p.getBoundingClientRect()
    return JSON.stringify({ transform: getComputedStyle(p).transform,
      dragging: p.classList.contains('is-dragging'),
      handleCursor: getComputedStyle(document.querySelector('.settings-drag-handle')).cursor })
  })()`).then(JSON.parse)
  await mouse('mouseReleased', hp.x + 120, hp.y + 60, 0)
  await sleep(200)
  const c3 = await ev(`(() => {
    const p = document.querySelector('.settings-panel')
    return JSON.stringify({ transform: getComputedStyle(p).transform, dragging: p.classList.contains('is-dragging') })
  })()`).then(JSON.parse)
  console.log('C2 ' + JSON.stringify(c2) + ' C3 ' + JSON.stringify(c3))
  report.check(
    'C 拖动后位移体现在 transform 上',
    /matrix/.test(c2.transform) && c2.transform !== 'none',
    c2.transform
  )
  report.check(
    'C 拖动中把手光标变 grabbing',
    c2.handleCursor === 'grabbing',
    String(c2.handleCursor)
  )
  report.check(
    'C 松手后拖动态结束、位移保留',
    c3.dragging === false && c3.transform === c2.transform,
    JSON.stringify(c3)
  )

  // 关掉再开：位置回到居中（会话级）
  await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)
  await sleep(300)
  await ev(`(() => { window.__L.ui().openSettings('editor'); return 'ok' })()`)
  await sleep(600)
  const c4 = await ev(
    `(() => getComputedStyle(document.querySelector('.settings-panel')).transform)()`
  )
  report.check(
    'C 重新打开回到居中（位置不跨次保留）',
    c4 === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(c4),
    String(c4)
  )

  await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
