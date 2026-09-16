'use strict'
// ─── 回归：代码块经过「源码模式往返」之后仍然能聚焦与输入 ────────────────────
//
// 背景：代码块里的 CodeMirror 曾被源码模式的 `display:none` 影响（隐藏期间宽度为 0，
// 切回来行号/视口尺寸失真、点击落不到 CM 上）。这条回归守着「源码面改一圈再回来，
// 代码块仍然可点、可输入，且源码里改的内容确实同步过来了」。
//
// 跑法：node tools/_regress-source-roundtrip.js（先起隔离实例）

const { connect, settle, waitEditor, sleep, Reporter, clickMode, waitRestored, fatal } = require('./lib/harness')

const MD = ['# 标题', '正文', '', '```js', 'const a = 1', '```', '', '## 尾部'].join('\n')

async function main() {
  const report = new Reporter('回归：源码模式往返后的代码块可用性')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const backupMode = await app.ev(`window.__L.ui().editorMode`)
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(350)
  await app.ev(`(async () => { if (!window.__L.files().current) await window.__L.files().openUntitled(); return 'ok' })()`)
  await waitEditor(app.ev)
  await app.ev(`(() => {
    window.__L.files().setContent(${JSON.stringify(MD)}, 'external')
    window.__L.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false })
    return 'ok'
  })()`)
  await sleep(900)

  // 源码模式：在末尾加一行，再切回渲染
  await clickMode(app, 2)
  await waitRestored(app.ev)
  await app.ev(`(() => {
    const ta = document.querySelector('textarea.source-editor')
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    return 'ok'
  })()`)
  await sleep(150)
  await app.send('Input.insertText', { text: '\n### 源码加了一行' })
  await sleep(300)
  await clickMode(app, 0)
  await waitRestored(app.ev)
  await sleep(400)

  const synced = await app.ev(`(() => {
    const ed = window.__L.ed()
    let ok = false
    ed.state.doc.descendants((n) => { if (n.type.name === 'heading' && n.textContent.includes('源码加了一行')) ok = true })
    return ok
  })()`)
  report.check('S1 源码里加的标题同步进渲染面', synced === true)

  // 代码块：点得到、焦点进得去
  const box = await app.ev(`(() => {
    const el = document.querySelector('.cm-content')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) })
  })()`)
  report.check('S2 往返后代码块尺寸正常（隐藏期间被量成 0 过）', box !== null && JSON.parse(box).w > 50, String(box))

  let focused = false
  for (let i = 0; i < 5 && !focused; i++) {
    const p = JSON.parse(
      await app.ev(`(() => {
        const el = document.querySelector('.cm-content')
        const r = el.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + Math.max(10, r.height / 2)) })
      })()`)
    )
    for (const type of ['mousePressed', 'mouseReleased']) {
      await app.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
    }
    await sleep(250)
    focused = await app.ev(
      `(() => { const el = document.querySelector('.cm-content'); return el ? document.activeElement === el || el.contains(document.activeElement) : false })()`
    )
  }
  report.check('S3 往返后点击能把焦点交进 CM', focused === true)

  await app.send('Input.insertText', { text: 'zz' })
  await sleep(400)
  const code = await app.ev(`(() => {
    const ed = window.__L.ed()
    let c = ''
    ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c = n.textContent })
    return c
  })()`)
  report.check('S4 往返后代码块仍可输入', typeof code === 'string' && code.includes('zz'), JSON.stringify(code))

  await app.ev(`(() => { window.__L.ui().editorMode = ${JSON.stringify(backupMode)}; return 'ok' })()`)
  await sleep(200)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
