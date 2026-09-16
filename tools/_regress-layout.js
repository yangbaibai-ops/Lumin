'use strict'
// ─── 回归：常驻布局下的核心编辑路径 + 模式切换的位置保持 ────────────────────
//
// 这是 `_regress-*` 里覆盖最广的一条（8 条断言）：代码块可聚焦可输入、
// 「渲染 → 分屏 → 源码 → 渲染」往返后光标比例仍在原处、源码输入写进 store 并回灌渲染面、
// 源码模式编辑器实例为 null、大纲在源码模式清空。
//
// 跑法：node tools/_regress-layout.js（先起隔离实例）

const { connect, settle, waitEditor, sleep, Reporter, clickMode, waitRestored, key, fatal } =
  require('./lib/harness')

const MD = [
  '# 标题',
  '正文段落用于测试，足够长以产生滚动。',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '## 小节',
  '更多正文。'
].join('\n')

async function main() {
  const report = new Reporter('回归：常驻布局的核心编辑路径与位置保持')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const backupMode = await app.ev(`window.__L.ui().editorMode`)
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  await app.ev(`(async () => { if (!window.__L.files().current) await window.__L.files().openUntitled(); return 'ok' })()`)
  await waitEditor(app.ev)
  await app.ev(`(() => {
    window.__L.files().setContent(${JSON.stringify(MD)}, 'external')
    window.__L.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false })
    return 'ok'
  })()`)
  await sleep(900)

  // 1) 代码块：可见 → 点击聚焦 → 输入 + 回车
  const cm = JSON.parse(
    await app.ev(`(() => {
      const el = document.querySelector('.cm-content')
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) })
    })()`)
  )
  report.check('L1 代码块 CodeMirror 可见', cm !== 'null' && cm.w > 50 && cm.h > 10, JSON.stringify(cm))
  let focused = false
  if (cm !== 'null') {
    for (let attempt = 0; attempt < 5 && !focused; attempt++) {
      await waitRestored(app.ev)
      const p = JSON.parse(
        await app.ev(`(() => {
          const el = document.querySelector('.cm-content')
          const r = el.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + Math.max(12, r.height / 2)) })
        })()`)
      )
      for (const type of ['mousePressed', 'mouseReleased']) {
        await app.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
      }
      await sleep(200)
      focused = await app.ev(
        `(() => { const el = document.querySelector('.cm-content'); return el ? document.activeElement === el || el.contains(document.activeElement) : false })()`
      )
    }
    report.check('L2 点击后焦点在 CM 里（没被 PM 抢回）', focused === true)
    await app.send('Input.insertText', { text: 'hello' })
    await sleep(200)
    await key(app.send, 'keyDown', 'Enter', 'Enter', 13)
    await key(app.send, 'keyUp', 'Enter', 'Enter', 13)
    await sleep(200)
    await app.send('Input.insertText', { text: 'world' })
    await sleep(400)
    const code = await app.ev(`(() => {
      const ed = window.__L.ed()
      let c = ''
      ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c = n.textContent })
      return c
    })()`)
    report.check(
      'L3 代码块输入 + 回车换行都落到文档里',
      typeof code === 'string' && code.includes('hello') && code.includes('world'),
      JSON.stringify(code)
    )
  }

  // 2) 位置保持：光标放到 50% → 渲染→分屏→源码→渲染 往返后仍在 40%~60%
  await app.ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.setTextSelection(Math.floor(ed.state.doc.content.size * 0.5))
    return 'ok'
  })()`)
  await sleep(200)
  await clickMode(app, 1)
  await waitRestored(app.ev)
  await clickMode(app, 2)
  await waitRestored(app.ev)
  const inSource = await app.ev(
    `(() => { const ta = document.querySelector('textarea.source-editor'); return ta ? ta.value.length : -1 })()`
  )
  await clickMode(app, 0)
  await waitRestored(app.ev)
  await sleep(250)
  const pos = JSON.parse(
    await app.ev(`(() => {
      const ed = window.__L.ed()
      const size = ed.state.doc.content.size
      return JSON.stringify({ from: ed.state.selection.from, size, ratio: size ? ed.state.selection.from / size : 0 })
    })()`)
  )
  report.check(
    'L4 跨面往返后光标比例保持（≈0.5）',
    pos.ratio > 0.4 && pos.ratio < 0.6,
    `from=${pos.from} size=${pos.size} ratio=${pos.ratio.toFixed(3)} sourceLen=${inSource}`
  )

  // 3) 源码输入 → 写进 store → 切回渲染后出现
  await clickMode(app, 2)
  await waitRestored(app.ev)
  await app.ev(`(() => {
    const ta = document.querySelector('textarea.source-editor')
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    return 'ok'
  })()`)
  await sleep(150)
  await app.send('Input.insertText', { text: '\n## 源码新增' })
  await sleep(400)
  const inStore = await app.ev(`window.__L.files().current.content.includes('源码新增')`)
  report.check('L5 源码输入写进 files store', inStore === true)
  await clickMode(app, 0)
  await waitRestored(app.ev)
  await sleep(300)
  const synced = await app.ev(`(() => {
    const ed = window.__L.ed()
    let ok = false
    ed.state.doc.descendants((n) => { if (n.type.name === 'heading' && n.textContent.includes('源码新增')) ok = true })
    return ok
  })()`)
  report.check('L6 源码编辑回灌渲染面', synced === true)

  // 4) 源码模式：编辑器实例应为 null（工具栏富文本命令失活）
  await clickMode(app, 2)
  await waitRestored(app.ev)
  report.check('L7 源码模式 instance=null', (await app.ev(`window.__L.ed() !== null`)) === false)

  // 5) 大纲：渲染模式非空，源码模式清空
  await clickMode(app, 0)
  await waitRestored(app.ev)
  await sleep(250)
  const outlineWysiwyg = await app.ev(`window.__L.editor().outline.length`)
  report.check('L8 渲染模式大纲非空', outlineWysiwyg >= 2, `count=${outlineWysiwyg}`)
  await clickMode(app, 2)
  await waitRestored(app.ev)
  const outlineSource = await app.ev(`window.__L.editor().outline.length`)
  report.check('L9 源码模式大纲清空', outlineSource === 0, `count=${outlineSource}`)

  await app.ev(`(() => { window.__L.ui().editorMode = ${JSON.stringify(backupMode)}; return 'ok' })()`)
  await sleep(200)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
