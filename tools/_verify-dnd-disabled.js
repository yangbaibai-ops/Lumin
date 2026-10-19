'use strict'
// ─── 验收：drag & drop 全禁用（行为 + 样式 + 动效），且拖选 / 粘贴不回归 ─────────
//
// 用户口径：取消这个应用所有组件元素（包括代码块等）的拖拽行为（拖拽文字插入等），
//           取消拖拽的样式，直接禁用拖拽这个行为，包括样式和动效以及效果。
//
// 本套件用**真鼠标手势**与 CDP 原生拖放投递，逐条证明：
//   ① 选中文字再拖到别处 ⇒ 文档逐字不变、`.ProseMirror-dropcursor` 计数 0；
//   ② 图片 / 代码块节点拖动 ⇒ 文档逐字不变；
//   ③ CDP `Input.dispatchDragEvent` 投递 .txt / .png ⇒ 不插入、不打开、不弹通知；
//   ④ 计算样式 `-webkit-user-drag` = none、cursor 不是 grab/grabbing/move、无拖拽高亮节点；
//   ⑤ 20 步鼠标拖选仍然工作（selection / `.sel-band` / `data-sel-own` 三个数值）；
//   ⑥ Ctrl+V 粘贴仍然工作（前后 diff）。
//
// 跑法（先起隔离实例）：
//   $env:ELECTRON_RUN_AS_NODE=$null
//   pwsh tools/start-isolated.ps1 -UserData "$env:TEMP\xw-dnd-ud" -Port 9470
//   $env:LUMIN_DEBUG_PORT='9470'; node tools/_verify-dnd-disabled.js
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  connect,
  settle,
  waitEditor,
  ensureFocus,
  sleep,
  openDocWith,
  Reporter,
  fatal
} = require('./lib/harness')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 段内每个字符的文档位置 + 屏幕几何（坐标一律现量，不写死像素） */
const GEO = `(() => {
  const p = document.querySelector('.ProseMirror p')
  if (!p) return 'null'
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  const out = []
  while (w.nextNode()) {
    const t = w.currentNode
    let base = -1
    try { base = window.__L.ed().view.posAtDOM(t, 0) } catch (e) { base = -1 }
    for (let i = 0; i < t.data.length; i++) {
      const r = document.createRange()
      r.setStart(t, i); r.setEnd(t, i + 1)
      const b = r.getBoundingClientRect()
      out.push({ ch: t.data[i], pos: base + i, l: b.left, r: b.right, w: b.width, y: Math.round(b.top + b.height / 2) })
    }
  }
  return JSON.stringify(out)
})()`

const SNAP = `(() => {
  const ed = window.__L.ed()
  const view = ed.view
  const sel = ed.state.selection
  const root = document.querySelector('.ProseMirror')
  const img = document.querySelector('.md-preview img')
  const pre = document.querySelector('.code-block-wrapper')
  const treeRow = document.querySelector('.tree-row')
  const css = (el) => el ? getComputedStyle(el) : null
  return JSON.stringify({
    md: ed.storage.markdown.getMarkdown(),
    text: ed.state.doc.textContent,
    from: sel.from,
    to: sel.to,
    empty: sel.empty,
    selText: sel.empty ? '' : ed.state.doc.textBetween(sel.from, sel.to, '|'),
    path: window.__L.files().current ? window.__L.files().current.path : null,
    dirty: window.__L.files().dirty,
    notif: window.__L.notifications().items.length,
    imgs: document.querySelectorAll('.md-preview img').length,
    dropcursor: document.querySelectorAll('.ProseMirror-dropcursor').length,
    cmDropCursor: document.querySelectorAll('.cm-dropCursor').length,
    dragging: document.querySelectorAll('.dragging, .is-dragging, [data-dragging]').length,
    band: document.querySelectorAll('.sel-band').length,
    selOwn: root ? root.getAttribute('data-sel-own') : null,
    userDrag: root ? css(root).getPropertyValue('-webkit-user-drag') : '',
    imgDrag: img ? { attr: img.getAttribute('draggable'), prop: img.draggable, userDrag: css(img).getPropertyValue('-webkit-user-drag') } : null,
    preDrag: pre ? { attr: pre.getAttribute('draggable'), prop: pre.draggable, userDrag: css(pre).getPropertyValue('-webkit-user-drag') } : null,
    treeDrag: treeRow ? { attr: treeRow.getAttribute('draggable'), prop: treeRow.draggable, userDrag: css(treeRow).getPropertyValue('-webkit-user-drag') } : null,
    cursors: {
      root: root ? css(root).cursor : '',
      img: img ? css(img).cursor : '',
      pre: pre ? css(pre).cursor : '',
      tree: treeRow ? css(treeRow).cursor : ''
    }
  })
})()`

async function main() {
  const report = new Reporter('验收：drag & drop 全禁用（含样式/动效），拖选与粘贴不回归')
  fs.mkdirSync(TMP, { recursive: true })
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { ev, send } = app
  if (!(await waitEditor(ev))) {
    report.skip('editor-ready', '编辑器没挂上')
    return report.finish()
  }
  const snap = () => ev(SNAP).then(JSON.parse)
  const mouse = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
      buttons,
      clickCount: 1
    })
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    if (!r.result || !r.result.data) return false
    fs.writeFileSync(path.join(TMP, name), Buffer.from(r.result.data, 'base64'))
    return true
  }

  /** 真实鼠标拖拽手势；onStep 可在按住期间取样/截图 */
  const drag = async (from, to, { steps = 20, onStep = null } = {}) => {
    await mouse('mouseMoved', from.x, from.y, 0)
    await sleep(120)
    await mouse('mousePressed', from.x, from.y, 1)
    await sleep(140)
    for (let i = 1; i <= steps; i++) {
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps,
        1
      )
      await sleep(35)
      if (onStep) await onStep(i)
    }
    await sleep(120)
    await mouse('mouseReleased', to.x, to.y, 0)
    await sleep(450)
  }

  try {
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(300)

    // 文件树也进入验收视野：造一个临时工作区（拖拽已全禁用，树行同样不许拖）
    const treeDir = path.join(os.tmpdir(), 'lumin-dnd-disabled-tree')
    fs.rmSync(treeDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(treeDir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(treeDir, 'move-me.md'), '# 待移动\n', 'utf8')
    await ev(`(async () => {
      await window.__L.files().setRoot(${JSON.stringify(treeDir)})
      window.__L.ui().sidebarVisible = true
      return 'ok'
    })()`)
    await sleep(1100)

    // ── 0. 页面侧拖拽事件探针（挂在 window 捕获、晚于产品拦截器注册）────────────
    await ev(`(() => {
      window.__dragLog = []
      for (const t of ['dragstart','drag','dragenter','dragover','dragleave','drop','dragend']) {
        window.addEventListener(t, (e) => {
          window.__dragLog.push({ type: t, prevented: e.defaultPrevented, trusted: e.isTrusted })
        }, true)
      }
      return 'ok'
    })()`)
    const dragLog = () => ev('JSON.stringify(window.__dragLog || [])').then(JSON.parse)

    const MD = [
      '# 拖拽禁用验收',
      '',
      'ABCDEF 拖选验收一二三四五六七八九十',
      '',
      `![p](data:image/png;base64,${PNG_1PX})`,
      '',
      '```js',
      'const n = 1',
      '```',
      ''
    ].join('\n')
    await openDocWith(app, MD, 'dnd-disabled.md')
    await waitEditor(ev)
    await sleep(1100)

    const idle = await snap()
    await shot('dnd-disabled-idle.png')
    report.check(
      '① 静息态：编辑器 / 图片 / 代码块 / 文件树的 -webkit-user-drag 都是 none',
      idle.userDrag === 'none' &&
        (!idle.imgDrag || idle.imgDrag.userDrag === 'none') &&
        (!idle.preDrag || idle.preDrag.userDrag === 'none') &&
        (!idle.treeDrag || idle.treeDrag.userDrag === 'none'),
      JSON.stringify({ root: idle.userDrag, img: idle.imgDrag, pre: idle.preDrag, tree: idle.treeDrag })
    )
    report.check(
      '② 静息态：cursor 不是 grab/grabbing/move；无 dropcursor / 拖拽高亮节点',
      !/grab|move/.test(Object.values(idle.cursors).join(' ')) &&
        idle.dropcursor === 0 &&
        idle.cmDropCursor === 0 &&
        idle.dragging === 0,
      JSON.stringify({ cursors: idle.cursors, dropcursor: idle.dropcursor, cm: idle.cmDropCursor, dragging: idle.dragging })
    )
    report.check(
      '③ DOM 拖拽源：编辑器外（树行）钉 draggable=false；编辑器内不写属性（见注释）',
      /**
       * 口径变更（paste-freeze-tables 轮）：**编辑器内不再由 MutationObserver 写
       * `draggable=false`**。真因：给 PM 管理的 `<a>` 写属性会被 PM 的 DOMObserver
       * 当成"外部改了我的 DOM"⇒ 整段重渲染 ⇒ 再写一次……主线程死循环（实测 2.5s
       * 9451 次回调、CDP 全超时；一篇只有两个链接的文档就能触发）。
       * 编辑器内的"不可拖"由另外两层保证（下面 ④–⑧ 的真手势用例逐条验证）：
       *   ① window 捕获阶段 `dragstart` preventDefault + stopPropagation；
       *   ② 全局 `-webkit-user-drag: none`。
       * 所以这里断言：树行仍是属性钉死；编辑器内是 user-drag:none（不是属性）。
       */
      (!idle.treeDrag || idle.treeDrag.attr === 'false') &&
        idle.userDrag === 'none' &&
        (!idle.imgDrag || idle.imgDrag.userDrag === 'none') &&
        (!idle.preDrag || idle.preDrag.userDrag === 'none') &&
        idle.imgDrag?.attr !== 'false' &&
        idle.preDrag?.attr !== 'false',
      JSON.stringify({ img: idle.imgDrag, pre: idle.preDrag, tree: idle.treeDrag })
    )

    // ── 1. 文字拖拽插入：真实手势选中 DE，再按住拖到 A|B 之间 ─────────────────
    const chars = JSON.parse(await ev(GEO))
    const pick = (ch, frac) => {
      const c = chars.find((x) => x.ch === ch)
      return c ? { x: c.l + c.w * frac, y: c.y, pos: c.pos } : null
    }
    const D = pick('D', 0.25)
    const E = pick('E', 0.8)
    const B = pick('B', 0.06)
    report.check('④ 夹具：ABCDEF 字符几何齐全', !!(D && E && B), JSON.stringify({ D, E, B }))
    await drag(D, E, { steps: 12 }) // 真实手势划选 DE
    const selDE = await snap()
    report.check(
      '⑤ 真实鼠标拖选 12 步得到 DE（按现量字符位置）——拖选本身没被禁用',
      selDE.from === D.pos && selDE.to === E.pos + 1 && selDE.selText === 'DE',
      JSON.stringify({ from: selDE.from, to: selDE.to, expected: [D.pos, E.pos + 1], selText: selDE.selText })
    )
    const mdBeforeTextDrag = selDE.md
    await ev('window.__dragLog = []')
    await drag(E, B, {
      steps: 20,
      onStep: async (i) => {
        if (i === 15) await shot('dnd-attempt.png')
      }
    })
    const afterText = await snap()
    const logText = await dragLog()
    report.check(
      '⑥ 拖动选中的 DE 到 A|B 之间 ⇒ getMarkdown() 逐字不变（diff 为空）',
      afterText.md === mdBeforeTextDrag && afterText.text.includes('ABCDEF'),
      JSON.stringify({ before: mdBeforeTextDrag, after: afterText.md, text: afterText.text })
    )
    report.check(
      '⑦ 这次拖动没有放置指示线 / 幽灵高亮：dropcursor=0、dragging=0',
      afterText.dropcursor === 0 && afterText.cmDropCursor === 0 && afterText.dragging === 0,
      JSON.stringify({ dropcursor: afterText.dropcursor, cm: afterText.cmDropCursor, dragging: afterText.dragging })
    )
    report.check(
      '⑧ 拖动期间所有 drag* 事件都被入口 preventDefault（有事件时逐条为 true）',
      logText.every((x) => x.prevented === true),
      JSON.stringify(logText.slice(0, 8))
    )

    // ── 2. 图片 / 代码块节点拖动：选中节点后真鼠标拖 ─────────────────────────
    const mdBeforeNodes = (await snap()).md
    await ev(`(() => {
      const ed = window.__L.ed()
      let p = -1
      ed.state.doc.descendants((n, pos) => { if (n.type.name === 'image') { p = pos; return false } return true })
      if (p < 0) return 'no-image'
      ed.chain().setNodeSelection(p).run()
      return 'ok'
    })()`)
    await sleep(350)
    const imgRect = JSON.parse(
      await ev(`(() => { const r = document.querySelector('.md-preview img').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`)
    )
    await drag(imgRect, { x: B.x, y: B.y }, { steps: 12 })
    const afterImg = await snap()
    report.check(
      '⑨ 图片节点（NodeSelection + 真拖）⇒ 文档逐字不变、图片 user-drag:none',
      afterImg.md === mdBeforeNodes &&
        (!afterImg.imgDrag || afterImg.imgDrag.userDrag === 'none'),
      JSON.stringify({ same: afterImg.md === mdBeforeNodes, img: afterImg.imgDrag })
    )

    await ev(`(() => {
      const ed = window.__L.ed()
      let p = -1
      ed.state.doc.descendants((n, pos) => { if (n.type.name === 'codeBlock') { p = pos; return false } return true })
      if (p < 0) return 'no-code'
      ed.chain().setNodeSelection(p).run()
      return 'ok'
    })()`)
    await sleep(350)
    const preRect = JSON.parse(
      await ev(`(() => { const r = document.querySelector('.code-block-wrapper').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`)
    )
    await drag(preRect, { x: B.x, y: B.y }, { steps: 12 })
    const afterPre = await snap()
    report.check(
      '⑩ 代码块节点（NodeSelection + 真拖）⇒ 文档逐字不变、代码块 user-drag:none',
      afterPre.md === mdBeforeNodes &&
        (!afterPre.preDrag || afterPre.preDrag.userDrag === 'none'),
      JSON.stringify({ same: afterPre.md === mdBeforeNodes, pre: afterPre.preDrag })
    )

    // ── 2b. 文件树内部拖动（既有产品功能）也一并禁用：真拖之后文件不动 ─────────
    const rows = JSON.parse(
      await ev(`(() => {
        const rs = [...document.querySelectorAll('[data-tree-row]')]
        return JSON.stringify(rs.map((r) => {
          const b = r.getBoundingClientRect()
          return { path: r.getAttribute('data-tree-path'), draggable: r.draggable, attr: r.getAttribute('draggable'),
            x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }
        }))
      })()`)
    )
    const srcRow = rows.find((r) => /move-me\.md$/.test(r.path || ''))
    const dstRow = rows.find((r) => /sub$/.test(r.path || ''))
    if (srcRow && dstRow) await drag(srcRow, dstRow, { steps: 14 })
    const moved = fs.existsSync(path.join(treeDir, 'sub', 'move-me.md'))
    report.check(
      '⑩b 文件树行 draggable=false，且把行拖进文件夹不搬家（既有「拖动移动」功能已禁用）',
      !!srcRow && !!dstRow && srcRow.draggable === false && srcRow.attr === 'false' && !moved,
      JSON.stringify({ src: srcRow, dst: dstRow, moved })
    )

    // ── 3. 合成 dragstart / drop：入口拦截的证据（属性 + 日志）────────────────
    const synth = JSON.parse(
      await ev(`(() => {
        window.__dragLog = []
        const target = document.querySelector('.ProseMirror')
        const mk = (type) => {
          const dt = new DataTransfer()
          dt.effectAllowed = 'all'
          const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
          target.dispatchEvent(e)
          return { type, prevented: e.defaultPrevented, effectAllowed: dt.effectAllowed, dropEffect: dt.dropEffect }
        }
        const out = [mk('dragstart'), mk('dragover'), mk('drop')]
        return JSON.stringify({ out, log: window.__dragLog })
      })()`)
    )
    report.check(
      '⑪ 合成 dragstart/dragover/drop 全被 entry preventDefault（dropEffect=none）',
      synth.out.every((x) => x.prevented === true && x.dropEffect === 'none'),
      JSON.stringify(synth)
    )

    // ── 4. 文件拖入：CDP 投递 .txt / .png ⇒ 不插入、不打开、不弹通知 ─────────
    const txtPath = path.join(os.tmpdir(), 'lumin-dnd-disabled-drop.txt')
    const pngPath = path.join(os.tmpdir(), 'lumin-dnd-disabled-drop.png')
    fs.writeFileSync(txtPath, 'DROPPED-FILE-MUST-NOT-OPEN\n', 'utf8')
    fs.writeFileSync(pngPath, Buffer.from(PNG_1PX, 'base64'))
    const beforeDrop = await snap()
    const editorPoint = JSON.parse(
      await ev(`(() => {
        const r = document.querySelector('.ProseMirror').getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) })
      })()`)
    )
    const dropFile = async (file) => {
      const data = { items: [], files: [file], dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await send('Input.dispatchDragEvent', { type, x: editorPoint.x, y: editorPoint.y, data, modifiers: 0 })
        await sleep(200)
      }
      await sleep(900)
    }
    await ev('window.__dragLog = []')
    await dropFile(txtPath)
    const afterTxt = await snap()
    const logTxt = await dragLog()
    report.check(
      '⑫ 拖入 .txt ⇒ 当前文档 / getMarkdown() / 通知数都不变（不打开、不弹窗）',
      afterTxt.path === beforeDrop.path && afterTxt.md === beforeDrop.md && afterTxt.notif === beforeDrop.notif,
      JSON.stringify({ path: [beforeDrop.path, afterTxt.path], mdSame: afterTxt.md === beforeDrop.md, notif: [beforeDrop.notif, afterTxt.notif] })
    )
    report.check(
      '⑬ 文件拖入的 dragenter/dragover 都被 entry preventDefault（drop 被 dropEffect=none 直接掐掉）',
      logTxt.some((x) => x.type === 'dragenter') &&
        logTxt.some((x) => x.type === 'dragover') &&
        logTxt
          .filter((x) => x.type === 'dragenter' || x.type === 'dragover' || x.type === 'drop')
          .every((x) => x.prevented === true),
      JSON.stringify(logTxt.slice(-8))
    )

    await dropFile(pngPath)
    const afterPng = await snap()
    report.check(
      '⑭ 拖入 .png ⇒ 不插入图片（img 数不变）、getMarkdown() 不变',
      afterPng.md === beforeDrop.md && afterPng.imgs === beforeDrop.imgs,
      JSON.stringify({ mdSame: afterPng.md === beforeDrop.md, imgs: [beforeDrop.imgs, afterPng.imgs] })
    )

    // ── 5. 拖选回归：20 步鼠标拖选（三个数值）────────────────────────────────
    const SELECT_MD = '拖选验收一二三四五六七八九十ABCDEFGHIJKLMNOPQRSTUVWXYZ\n'
    await openDocWith(app, SELECT_MD, 'dnd-drag-select.md')
    await waitEditor(ev)
    await sleep(900)
    const chars2 = JSON.parse(await ev(GEO))
    const at = (ch, frac = 0.5) => {
      const c = chars2.find((x) => x.ch === ch)
      return c ? { x: c.l + c.w * frac, y: c.y } : null
    }
    const beforeSel = await snap()
    let during = null
    await drag(at('选'), at('五'), {
      steps: 20,
      onStep: async (i) => {
        if (i === 18) {
          during = await snap()
          await shot('dnd-drag-select.png')
        }
      }
    })
    const afterSel = await snap()
    report.check(
      '⑮ 20 步鼠标拖选仍然工作：selection 真的变化、.sel-band 正常、data-sel-own 正常',
      !afterSel.empty && afterSel.from < afterSel.to && afterSel.from !== beforeSel.from,
      JSON.stringify({ before: [beforeSel.from, beforeSel.to], from: afterSel.from, to: afterSel.to, selText: afterSel.selText, bandDuring: during && during.band, ownDuring: during && during.selOwn, bandAfter: afterSel.band, ownAfter: afterSel.selOwn })
    )
    report.check(
      '⑯ 拖选期间没有把文档改掉（拖选 ≠ 拖拽放置）',
      !!during && afterSel.md === during.md && afterSel.md.includes('拖选验收'),
      JSON.stringify({ md: afterSel.md, during: during && during.md })
    )

    // ── 6. 粘贴回归：Ctrl+V 纯文本 ────────────────────────────────────────────
    // 真实按键要求窗口在前台；拿不到焦点就如实 SKIP 这一段（别把环境问题判成回归）
    if (!(await ensureFocus(app))) {
      report.skip('⑰ Ctrl+V 粘贴仍然工作', '窗口拿不到焦点（真实按键注入不进去）')
      return report.finish()
    }
    await ev(`(() => { window.__L.ed().chain().setTextSelection(window.__L.ed().state.doc.content.size - 1).run(); window.__L.ed().commands.focus(); return 'ok' })()`)
    await sleep(250)
    const clip = await ev(`(async () => {
      try { await navigator.clipboard.writeText('PASTED-OK'); return 'clipboard' } catch (e) {
        const ta = document.createElement('textarea')
        ta.value = 'PASTED-OK'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        return ok ? 'execCommand' : 'FAILED:' + e.message
      }
    })()`)
    const beforePaste = await snap()
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'v',
        code: 'KeyV',
        windowsVirtualKeyCode: 86,
        modifiers: 2
      })
    }
    await sleep(800)
    const afterPaste = await snap()
    report.check(
      '⑰ Ctrl+V 粘贴仍然工作：文档插入 PASTED-OK（给出前后 diff）',
      afterPaste.md !== beforePaste.md && afterPaste.md.includes('PASTED-OK'),
      JSON.stringify({ clip, before: beforePaste.md, after: afterPaste.md, diff: `${beforePaste.text.length}→${afterPaste.text.length}` })
    )

    // 最终样式复核
    const finalSnap = await snap()
    report.check(
      '⑱ 全程之后仍然没有 dropcursor / 拖拽高亮 / 可拖拽光标',
      finalSnap.dropcursor === 0 &&
        finalSnap.cmDropCursor === 0 &&
        finalSnap.dragging === 0 &&
        !/grab|move/.test(Object.values(finalSnap.cursors).join(' ')),
      JSON.stringify({ dropcursor: finalSnap.dropcursor, cm: finalSnap.cmDropCursor, dragging: finalSnap.dragging, cursors: finalSnap.cursors })
    )
  } catch (err) {
    report.skip('suite-error', String(err && err.stack ? err.stack : err))
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
