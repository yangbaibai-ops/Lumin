'use strict'
// ─── 回归：切换文件（编辑器按 `:key` 重建）与「在源码模式下切文件」────────────
//
// 这一组盯的是「编辑器常驻」这个架构决定的边界：两个编辑面都只挂载一次，
// 换文档靠 `:key=path` 重建 —— 所以**切文件必须让两个面都换成新文档**，
// 而且在源码模式下切文件不能把渲染面留在旧文档上（第 4 条）。
//
// 跑法：node tools/_regress-fileswitch.js（先起隔离实例）

const { connect, settle, waitEditor, sleep, Reporter, clickMode, waitRestored, fatal } = require('./lib/harness')

/** 渲染面里的标题文本（用来判断「现在显示的是哪份文档」） */
const HEADINGS = `(() => {
  const ed = window.__L.ed()
  if (!ed) return null
  let t = ''
  ed.state.doc.descendants((n) => { if (n.type.name === 'heading') t += n.textContent })
  return t
})()`

const MD_A = ['# 文档A', 'AAA 内容。', '', '```js', 'aaa', '```'].join('\n')
const MD_B = ['# 文档B', 'BBB 内容。', '', '```py', 'bbb', '```'].join('\n')

/** 直接改 `current` 触发 `:key` 重建（套件要测的就是这条渲染路径本身） */
const swapDoc = (path, name, md, mtime) => `(() => {
  const f = window.__L.files()
  f.current = { path: ${JSON.stringify(path)}, name: ${JSON.stringify(name)}, content: ${JSON.stringify(md)}, mtimeMs: ${mtime}, savedContent: ${JSON.stringify(md)} }
  return 'ok'
})()`

async function main() {
  const report = new Reporter('回归：切文件（:key 重建）与源码模式切文件')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const backupMode = await app.ev(`window.__L.ui().editorMode`)
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await app.ev(`(async () => { if (!window.__L.files().current) await window.__L.files().openUntitled(); return 'ok' })()`)
  await waitEditor(app.ev)

  await app.ev(swapDoc('/tmp/lumin-a.md', 'a.md', MD_A, 1))
  await sleep(700)
  const headingA = await app.ev(HEADINGS)
  report.check('F1 换到文档 A → 渲染面重建为新文档', headingA === '文档A', JSON.stringify(headingA))

  await clickMode(app, 2) // 源码
  await waitRestored(app.ev)
  const sourceA = await app.ev(
    `(() => { const ta = document.querySelector('textarea.source-editor'); return ta ? ta.value.includes('AAA') : false })()`
  )
  report.check('F2 源码模式显示 A', sourceA === true)

  await app.ev(swapDoc('/tmp/lumin-b.md', 'b.md', MD_B, 2))
  await sleep(800)
  const sourceB = await app.ev(
    `(() => { const ta = document.querySelector('textarea.source-editor'); return ta ? ta.value.includes('BBB') : false })()`
  )
  report.check('F3 源码模式下切文件 → 源码面换成 B', sourceB === true)

  await clickMode(app, 0) // 实时渲染
  await waitRestored(app.ev)
  const headingB = await app.ev(HEADINGS)
  report.check('F4 切回渲染 → 渲染面是 B（没有停在 A）', headingB === '文档B', JSON.stringify(headingB))
  report.check('F5 渲染模式编辑器实例已恢复', (await app.ev(`window.__L.ed() !== null`)) === true)

  await app.ev(`(() => { window.__L.ui().editorMode = ${JSON.stringify(backupMode)}; return 'ok' })()`)
  await sleep(200)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
