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

  // ═══ C. 设置页（整页，不再是小窗浮层）═══
  // 用户口径：「打开设置界面不要弹出一个小的窗口在原窗口的上方，而是占据整个界面」。
  // 原来这一节验的是「遮罩压暗 / 面板可拖动 / 拖完位置保留」——那套交互已经删掉，改为验整页形态。
  await ev(`(() => { window.__L.ui().openSettings('editor'); return 'ok' })()`)
  await sleep(700)
  const c1 = await ev(`(() => {
    const page = document.querySelector('[data-settings-page]')
    if (!page) return JSON.stringify({ found: false })
    const pc = getComputedStyle(page)
    const r = page.getBoundingClientRect()
    const nav = document.querySelector('.settings-nav')
    const body = document.querySelector('.settings-body')
    const navItems = [...document.querySelectorAll('.settings-nav-item')]
    const active = navItems.filter((b) => b.classList.contains('is-active'))
    return JSON.stringify({
      found: true,
      covers: Math.round(r.width) >= window.innerWidth - 1 && Math.round(r.height) >= window.innerHeight - 1,
      position: pc.position,
      opacityBg: pc.backgroundColor,
      hasScrim: !!document.querySelector('.settings-scrim, .settings-mask'),
      hasDragHandle: !!document.querySelector('.settings-drag-handle'),
      navItems: navItems.length,
      activeItems: active.length,
      navBg: nav ? getComputedStyle(nav).backgroundColor : null,
      bodyBg: body ? getComputedStyle(body).backgroundColor : null,
      closeLabel: (document.querySelector('[data-settings-close]')?.textContent || '').trim(),
      scrollables: [...document.querySelectorAll('.settings-page *')].filter((el) => {
        const s = getComputedStyle(el)
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
      }).length
    })
  })()`).then(JSON.parse)
  console.log('C1 ' + JSON.stringify(c1))
  report.check(
    'C 设置是整页：铺满窗口且 fixed',
    c1.found === true && c1.covers === true && c1.position === 'fixed',
    JSON.stringify({ covers: c1.covers, position: c1.position })
  )
  report.check(
    'C 整页不透明（不再是浮在正文上的半透明遮罩）',
    /rgb/.test(c1.opacityBg || '') && !/rgba\(0, 0, 0, 0\)/.test(c1.opacityBg || ''),
    String(c1.opacityBg)
  )
  report.check(
    'C 旧的遮罩与拖动把手都已删除',
    c1.hasScrim === false && c1.hasDragHandle === false,
    JSON.stringify({ scrim: c1.hasScrim, dragHandle: c1.hasDragHandle })
  )
  report.check(
    'C 左导航 6 个分组且恰有一个当前项',
    c1.navItems === 6 && c1.activeItems === 1,
    JSON.stringify({ items: c1.navItems, active: c1.activeItems })
  )
  report.check(
    'C 内容区是可滚动的纸面（不是固定高的小盒）',
    c1.scrollables >= 1 && typeof c1.bodyBg === 'string',
    JSON.stringify({ scrollables: c1.scrollables, bodyBg: c1.bodyBg })
  )
  report.check(
    'C 关闭入口是一枚带文案的按钮（不再只有一个 X）',
    c1.closeLabel.length > 0,
    JSON.stringify({ closeLabel: c1.closeLabel })
  )

  // 切页签：内容跟着换（整页的导航仍然按同一套状态工作）
  await ev(`(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((x) => x.textContent.includes('外观')); b && b.click(); return 'ok' })()`)
  await sleep(500)
  const c2 = await ev(`(() => {
    const active = [...document.querySelectorAll('.settings-nav-item')].filter((b) => b.classList.contains('is-active'))
    const title = (document.querySelector('.settings-section-title')?.textContent || '').trim()
    const tab = window.__L.ui().settingsSection
    return JSON.stringify({ active: active.length, title, tab })
  })()`).then(JSON.parse)
  console.log('C2 ' + JSON.stringify(c2))
  report.check(
    'C 点左导航切分组：状态与标题一起变',
    c2.active === 1 && c2.tab === 'appearance' && c2.title.length > 0,
    JSON.stringify(c2)
  )

  // Esc 关闭（浮层时代的行为要保留）
  await ev(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'ok'
  })()`)
  await sleep(400)
  const c3 = await ev(`JSON.stringify({ open: window.__L.ui().settingsOpen, page: !!document.querySelector('[data-settings-page]') })`).then(JSON.parse)
  report.check(
    'C Esc 关闭整页设置',
    c3.open === false && c3.page === false,
    JSON.stringify(c3)
  )

  await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
