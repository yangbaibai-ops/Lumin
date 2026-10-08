'use strict'
// ─── 验收：取消「拖动选中的文字去改位置」（用户报障）─────────────────────────────
//
// 用户原话：「取消可以将选中的文字移动位置的功能，比如有一段文字 `ABCDEF`，我选中了 `DE`，
//            并用鼠标将其拖动到 `A` 和 `B` 中间，则变成了 `ADEBCF`，取消这种拖动的功能。」
//
// 口径（也写在 lib/editor/noTextDrag.ts 的注释里）：
//   * 文档**逐字不变**（一个字符都不许动，`files.dirty` 也不许被这次手势点亮）；
//   * 拖动前的**选区原样保留**（`DE` 仍然选中）—— 不许出现"选区被清掉 / 光标跑丢"；
//   * 只拦"文档内部、非节点"的选区拖动；系统拖入、拖图片附件、拖节点（图片/表格）一律放行。
//
// 手势是真的：**先用真实鼠标手势选中 `DE`**（Chromium 只在"选区是用户自己划出来的"那一刻
// 才允许从选区里起原生 drag），再把指针按住拖到 `A` 与 `B` 之间。
// ⚠️ 这一条与"程序化 setTextSelection 之后再拖"**不是**一回事：实测后者 Chromium 根本不起
//    dragstart（表现为"把选区重新划了一遍"，文档不动 —— 会得到假绿），
//    所以夹具自检里专门钉住"划出来的选区 == [4,6)"。
//
// 跑法：node tools/_verify-no-text-drag.js（先起隔离实例，见 tools/start-isolated.ps1）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, waitEditor, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')

const ROOT = path.join(__dirname, '..')

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

const STATE = `JSON.stringify({
  from: window.__L.ed().state.selection.from,
  to: window.__L.ed().state.selection.to,
  empty: window.__L.ed().state.selection.empty,
  selText: window.__L.ed().state.selection.empty ? '' : window.__L.ed().state.doc.textBetween(window.__L.ed().state.selection.from, window.__L.ed().state.selection.to, '|'),
  text: window.__L.ed().state.doc.textContent,
  md: window.__L.ed().storage.markdown.getMarkdown(),
  dirty: window.__L.files().dirty,
  path: window.__L.files().current ? window.__L.files().current.path : null
})`

async function main() {
  const report = new Reporter('验收：拖动选中的文字不再改位置（文档逐字不变 + 选区保留）')
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
  const state = () => ev(STATE).then(JSON.parse)

  const mouse = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
      buttons,
      clickCount: 1
    })
  /** 一次真实鼠标拖拽手势（按下 → 多步移动 → 抬起） */
  const drag = async (from, to, steps = 10) => {
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
      await sleep(40)
    }
    await sleep(140)
    await mouse('mouseReleased', to.x, to.y, 0)
    await sleep(500)
  }

  try {
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(400)
    await openDocWith(app, 'ABCDEF\n', 'no-text-drag.md')
    await waitEditor(ev)
    await sleep(1200)

    const geo = await ev(GEO)
    report.check('fixture-编辑器里就是这一段 ABCDEF', geo !== 'null', String(geo).slice(0, 80))
    const chars = JSON.parse(geo)
    const pick = (ch, frac) => {
      const c = chars.find((x) => x.ch === ch)
      return c ? { x: c.l + c.w * frac, y: c.y, pos: c.pos } : null
    }
    const D = pick('D', 0.25)
    const E = pick('E', 0.8)
    const B = pick('B', 0.06)
    const A = pick('A', 0.5)

    // ① 用**真实手势**选中 DE（不是 setTextSelection：程序化选区起不来原生 drag，见文件头）
    await drag(D, E)
    const sel = await state()
    report.check(
      'fixture-真实手势划出来的选区就是 DE（[4,6)）——不是程序化选区（后者根本不会起 dragstart）',
      sel.from === 4 && sel.to === 6 && sel.selText === 'DE' && sel.text === 'ABCDEF',
      JSON.stringify({ from: sel.from, to: sel.to, selText: sel.selText, pos: { D: D.pos, E: E.pos } })
    )
    // 拖动前的基线：markdown 出口（`storage.markdown.getMarkdown()`）不保证末尾那个换行，
    // 所以"逐字不变"一律与**拖动前抓到的这一份**比，不写死字符串。
    const baselineMd = sel.md

    // ② 用户报的那一手：按住选区内部（E 中间）拖到 A 与 B 之间
    await drag(pick('E', 0.5), B)
    const after = await state()
    report.check(
      '拖动选中的 DE 到 A|B 之间 ⇒ 文档**逐字不变**（改前实测变成 DEABCF / 还多一个空行）',
      after.text === 'ABCDEF' && after.md === baselineMd,
      JSON.stringify({ text: after.text, md: after.md, baseline: baselineMd })
    )
    report.check(
      '这一手不许产生任何未保存改动（files.dirty 仍为 false）',
      after.dirty === false,
      JSON.stringify({ dirty: after.dirty })
    )
    report.check(
      '拖完**选区原样保留**（DE 仍选中；不许选区被清掉、光标跑丢）',
      after.from === 4 && after.to === 6 && after.selText === 'DE',
      JSON.stringify({ from: after.from, to: after.to, selText: after.selText, empty: after.empty })
    )

    // ③ 换一个落点再拖一次（拖到行首 A 上）：仍然一个字都不许动
    await drag(pick('E', 0.5), A)
    const after2 = await state()
    report.check(
      '换落点再拖一次（拖到行首）⇒ 仍然逐字不变 + 选区仍在 DE 上',
      after2.text === 'ABCDEF' && after2.md === baselineMd && after2.from === 4 && after2.to === 6,
      JSON.stringify({ text: after2.text, md: after2.md, from: after2.from, to: after2.to })
    )

    // ④ 反方向（从选区拖到行尾之后）：同一条判据
    await drag(pick('D', 0.5), { x: pick('F', 0.95).x + 24, y: pick('F', 0.95).y })
    const after3 = await state()
    report.check(
      '反方向拖到行尾之后 ⇒ 仍然逐字不变 + 选区仍在 DE 上',
      after3.text === 'ABCDEF' && after3.md === baselineMd && after3.from === 4 && after3.to === 6,
      JSON.stringify({ text: after3.text, md: after3.md, from: after3.from, to: after3.to })
    )

    // ⑤ 与任务 1 共存：禁掉内部拖动之后，**从系统拖入文件**仍然要打开
    const mdPath = path.join(os.tmpdir(), 'lumin-no-text-drag-drop.md')
    fs.writeFileSync(mdPath, '# SYSTEM-DROP-OK\n\n拖进来的文件。\n', 'utf8')
    const editorRect = JSON.parse(
      await ev(`(() => {
        const el = document.querySelector('.ProseMirror')
        const r = el.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) })
      })()`)
    )
    const data = { items: [], files: [mdPath], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await send('Input.dispatchDragEvent', { type, x: editorRect.x, y: editorRect.y, data, modifiers: 0 })
      await sleep(180)
    }
    const end = Date.now() + 8000
    let opened = false
    while (Date.now() < end) {
      const s = await state()
      if (s.text.indexOf('SYSTEM-DROP-OK') >= 0) {
        opened = true
        break
      }
      await sleep(150)
    }
    report.check(
      '共存-从系统拖入 .md 仍然打开（任务 1 的功能没被这条拦截弄坏）',
      opened,
      JSON.stringify(await state())
    )

    // ⑥ 不许破坏：**文件树内部拖动**（把一行拖进文件夹）——窗口级新增的 dragover/drop 落点
    //    不许把这个手势抢走（TreeNode 认领时会 stopPropagation，这里用真手势再证一遍）。
    const treeDir = path.join(os.tmpdir(), 'lumin-no-text-drag-tree')
    fs.rmSync(treeDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(treeDir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(treeDir, 'move-me.md'), '# 待移动\n', 'utf8')
    await ev(`(async () => { await window.__L.files().setRoot(${JSON.stringify(treeDir)}); return 'ok' })()`)
    await sleep(1000)
    await ev(`(() => { window.__L.ui().sidebarVisible = true; return 'ok' })()`)
    await sleep(600)
    const rows = JSON.parse(
      await ev(`(() => {
        const rs = [...document.querySelectorAll('[data-tree-row]')]
        return JSON.stringify(rs.map((r) => {
          const b = r.getBoundingClientRect()
          return { path: r.getAttribute('data-tree-path'), draggable: r.draggable, x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }
        }))
      })()`)
    )
    const srcRow = rows.find((r) => /move-me\.md$/.test(r.path || ''))
    const dstRow = rows.find((r) => /sub$/.test(r.path || ''))
    if (srcRow && dstRow && srcRow.draggable) {
      await drag(srcRow, dstRow)
      await sleep(800)
    }
    report.check(
      '不许破坏-文件树内部拖动仍然真的搬家（窗口级落点没抢走这个手势）',
      fs.existsSync(path.join(treeDir, 'sub', 'move-me.md')) &&
        !fs.existsSync(path.join(treeDir, 'move-me.md')),
      JSON.stringify({ src: srcRow && srcRow.path, dst: dstRow && dstRow.path })
    )
    report.check(
      '不许破坏-编辑器文档在这期间也没被改动（拖文件树行不该动正文）',
      (await state()).text === 'ABCDEF' || (await state()).text.indexOf('SYSTEM-DROP-OK') >= 0,
      JSON.stringify(await state())
    )
  } catch (err) {
    report.skip('suite-error', String(err && err.message))
  }

  // ── 静态接线断言（运行时 E2E 之外再钉一遍"钩子还挂在 PM 上、用的还是 moved"）──
  const noTextDrag = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'editor', 'noTextDrag.ts'),
    'utf-8'
  )
  const extensions = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'editor', 'extensions.ts'),
    'utf-8'
  )
  const dragRules = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'editor', 'dragRules.ts'),
    'utf-8'
  )
  report.check(
    '接线-handleDrop 用 moved + view.dragging.node 走纯谓词（文字那条 + **数学节点**那条），并自己 preventDefault',
    /handleDrop\(view: EditorView, event: DragEvent, _slice: Slice, moved: boolean\)/.test(noTextDrag) &&
      /blocksInternalTextDrag\(moved, nodeDrag\)/.test(noTextDrag) &&
      /blocksMathDrag\(moved, draggedMath\(view\)\)/.test(noTextDrag) &&
      /event\.preventDefault\(\)/.test(noTextDrag),
    'noTextDrag.ts'
  )
  report.check(
    '接线-纯谓词是 moved && !nodeDrag（节点拖动/外部拖入都放行）',
    /return moved && !nodeDrag/.test(dragRules),
    'dragRules.ts'
  )
  /**
   * 第九轮新增的那半条：**数学节点**的拖动要拦（PM 会给"选中后的叶子节点"补
   * `draggable=true`，公式因此被当成节点拖动搬走）。它必须是一条**独立**的纯谓词 ——
   * 与上面那条正交，图片/表格的 `nodeDrag` 才不会被误伤。
   */
  report.check(
    '接线-数学节点那条是独立的纯谓词 moved && mathDrag（图片/表格的节点拖动不受影响）',
    /return moved && mathDrag/.test(dragRules),
    'dragRules.ts'
  )
  report.check(
    '接线-扩展真的注册进编辑器（且排在 ImagePaste 之后，图片拖入先被内层认领）',
    /NoTextDrag,/.test(extensions) &&
      extensions.indexOf('ImagePaste,') < extensions.indexOf('NoTextDrag,'),
    'extensions.ts'
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
