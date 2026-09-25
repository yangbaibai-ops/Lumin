'use strict'
// ─── 回归：分屏双向实时同步 + 切文件（编辑器 :key 重建）──────────────────────
//
// 这条套件盯着的是 Wave 3.2 的**单向数据流**：分屏左右两个编辑面互相看得见对方，
// 全靠同一个账本（`files.contentRev` / `contentAuthor` / `contentIsStale`）驱动，
// 不再有第二条 setContent 定时器。所以断言分两层：
//   1. 行为：右侧输入左侧能看见、左侧输入右侧能看见（双向）；
//   2. 机制：每次输入之后账本都收敛（没有编辑面还落后），且作者记得对。
//
// 跑法（对着隔离实例）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-isolated.ps1
//   node tools/_regress-split-live.js

const path = require('path')
const os = require('os')
const fs = require('fs')
const { connect, settle, waitEditor, sleep, Reporter, fatal } = require('./lib/harness')

const WS = path.join(os.tmpdir(), 'lumin-split-live-ws')

/** 点模式分段控件：工具栏里那个有 3 个 role=tab 的 tablist（顺序 wysiwyg/split/source） */
async function clickMode(app, index) {
  const box = JSON.parse(
    await app.ev(`(() => {
      const list = [...document.querySelectorAll('[role="tablist"]')].find(
        (l) => l.querySelectorAll('[role="tab"]').length === 3
      )
      const btn = list?.querySelectorAll('[role="tab"]')[${index}]
      if (!btn) return 'null'
      const r = btn.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`)
  )
  if (!box || box === 'null') throw new Error('模式分段控件没找到（role=tablist/role=tab）')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1
    })
  }
  await sleep(450)
  return box
}

async function main() {
  const report = new Reporter('回归：分屏双向同步（账本驱动的单向数据流）')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const backup = JSON.parse(
    await app.ev(`JSON.stringify({
      mode: window.__L.ui().editorMode,
      autoSave: window.__L.settings().autoSave,
      recentFiles: window.__L.settings().recentFiles
    })`)
  )
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  // 快捷工具栏出厂默认收起（清单 §1.E 选项②）；本套件要按工具栏上的模式分段控件切面，
  // 且工具栏的高度会影响编辑区几何 ⇒ 显式打开，别依赖 profile 里残留的状态
  await app.ev(`(() => { window.__L.settings().set('toolbarVisible', true); return 'ok' })()`)
  await sleep(300)

  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  const alpha = path.join(WS, 'alpha.md')
  const beta = path.join(WS, 'beta.md')
  fs.writeFileSync(alpha, '# alpha\n\n正文 A。\n')
  fs.writeFileSync(beta, '# beta\n\n正文 B。\n')

  await app.ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(alpha)}); return 'ok' })()`
  )
  await sleep(800)
  await waitEditor(app.ev)
  await clickMode(app, 1) // split
  report.check('M1 切到分屏', (await app.ev(`window.__L.ui().editorMode`)) === 'split')

  // ── 右 → 左：源码 textarea 输入，左侧实时渲染跟上 ──
  const right = await app.ev(`(async () => {
    const f = window.__L.files()
    const ta = document.querySelector('textarea.source-editor')
    if (!ta) return JSON.stringify({ err: 'no-textarea' })
    ta.focus()
    const before = f.contentRev
    ta.value = ta.value + '\\n## 分屏右侧新增\\n'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({ err: null, bumped: f.contentRev > before, author: f.contentAuthor, stale: f.contentIsStale('wysiwyg') })
  })()`)
  const right2 = JSON.parse(right)
  report.check(
    'R1 源码面输入记进账本（作者=source、Tiptap 落后）',
    right2.err === null &&
      right2.bumped === true &&
      right2.author === 'source' &&
      right2.stale === true,
    right
  )
  await sleep(800)
  const leftHas = await app.ev(`(() => {
    const ed = window.__L.ed()
    if (!ed) return false
    let ok = false
    ed.state.doc.descendants((n) => {
      if (n.type.name === 'heading' && n.textContent.includes('分屏右侧新增')) ok = true
    })
    return ok
  })()`)
  report.check('R2 右侧输入 → 左侧渲染出现该标题', leftHas === true)
  report.check(
    'R3 左侧渲染后账本收敛（没有编辑面落后）',
    (await app.ev(`window.__L.files().contentIsStale('wysiwyg')`)) === false
  )

  // ── 左 → 右：Tiptap 输入，右侧 textarea 跟上（声明式 :value） ──
  const left = await app.ev(`(async () => {
    const f = window.__L.files()
    const ed = window.__L.ed()
    ed.commands.focus()
    ed.commands.setTextSelection(1)
    ed.commands.insertContent('分屏左侧')
    await new Promise((r) => setTimeout(r, 700))
    const ta = document.querySelector('textarea.source-editor')
    return JSON.stringify({
      author: f.contentAuthor,
      rightHas: ta ? ta.value.includes('分屏左侧') : false,
      stale: f.contentIsStale('wysiwyg'),
      storeHas: (f.current?.content ?? '').includes('分屏左侧')
    })
  })()`)
  const left2 = JSON.parse(left)
  report.check('L1 左侧输入 → 右 textarea 跟上', left2.rightHas === true, left)
  report.check('L2 左侧输入已落进真源', left2.storeHas === true, left)
  report.check(
    'L3 作者记成 wysiwyg 且账本收敛',
    left2.author === 'wysiwyg' && left2.stale === false,
    left
  )

  // ── P. 分屏：左侧序列化不许把右侧的光标与滚动顶到末尾（审计 §3 P2）──
  // 「左侧序列化」用一次作者=wysiwyg 的内容写入来模拟（真实路径就是 Tiptap 防抖后落库）。
  const caret = JSON.parse(
    await app.ev(`(async () => {
      const f = window.__L.files()
      // 先把文档写长：不然右栏没有滚动余地，"滚动不被打断"那条断言是空转（before=0）
      f.setContent(
        Array.from({ length: 160 }, (_, i) => '第 ' + (i + 1) + ' 行内容，用于制造可滚动的右栏。').join('\\n'),
        'wysiwyg'
      )
      await new Promise((r) => setTimeout(r, 400))
      const ta = document.querySelector('textarea.source-editor')
      ta.focus()
      const n = Math.round(ta.value.length * 0.4)
      ta.setSelectionRange(n, n)
      ta.scrollTop = Math.round((ta.scrollHeight - ta.clientHeight) * 0.5)
      const scrollBefore = ta.scrollTop
      f.setContent(ta.value + '\\n\\n## 左侧序列化新增\\n', 'wysiwyg')
      await new Promise((r) => setTimeout(r, 500))
      const ta2 = document.querySelector('textarea.source-editor')
      return JSON.stringify({
        want: n,
        got: ta2.selectionStart,
        end: ta2.value.length,
        scrollBefore,
        scrollAfter: ta2.scrollTop
      })
    })()`)
  )
  report.note('P ' + JSON.stringify(caret))
  report.check(
    'P1 左侧序列化后右侧光标还在原处（不再被顶到末尾）',
    Math.abs(caret.got - caret.want) < 20 && caret.got < caret.end - 5,
    JSON.stringify(caret)
  )
  report.check(
    'P2 右侧滚动位置不被打断（护栏：实测 value setter 本身不动 scrollTop）',
    caret.scrollBefore > 0 && Math.abs(caret.scrollAfter - caret.scrollBefore) < 60,
    `before=${caret.scrollBefore} after=${caret.scrollAfter}`
  )

  // ── 切文件：编辑器按 :key 重建，内容跟着换 ──
  const swapped = JSON.parse(
    await app.ev(`(async () => {
      const f = window.__L.files()
      await f.openPath(${JSON.stringify(beta)})
      await new Promise((r) => setTimeout(r, 700))
      const ed = window.__L.ed()
      const ta = document.querySelector('textarea.source-editor')
      return JSON.stringify({
        path: f.current?.path ?? null,
        editorHas: (ed ? ed.state.doc.textContent : '').includes('beta'),
        textareaHas: ta ? ta.value.includes('beta') : false,
        stale: f.contentIsStale('wysiwyg')
      })
    })()`)
  )
  report.check(
    'S1 切文件后两个面都换成新文档',
    swapped.path === beta &&
      swapped.editorHas === true &&
      swapped.textareaHas === true &&
      swapped.stale === false,
    JSON.stringify(swapped)
  )

  // 收尾：恢复设置与模式
  await app.ev(`(() => {
    window.__L.ui().editorMode = ${JSON.stringify(backup.mode)}
    window.__L.settings().set('autoSave', ${backup.autoSave})
    return 'ok'
  })()`)
  fs.rmSync(WS, { recursive: true, force: true })
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
