'use strict'
// ─── 验收：编辑器内查找替换（菜单/Ctrl+F · 两个编辑面 · 替换与全部替换）──────
//
// 三件事一起验：
//   1. **入口**：Ctrl+F 打开查找栏（再按一次关闭；Esc 关闭）；
//   2. **命中**：WYSIWYG 面按文档位置选中最前/下一个/上一个（循环），
//      大小写开关真的改变命中数；
//   3. **替换**：只替换当前命中；「全部替换」一次改完并落进 store（两个编辑面各自验一次）。
//
// 跑法：node tools/_verify-find-replace.js（先起隔离实例）

const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  pressKey,
  clickCenter,
  clickMode,
  waitRestored,
  openDocWith,
  fatal
} = require('./lib/harness')

const MD = ['Alpha alpha ALPHA alpha.', '', '第二段里也有 beta beta。'].join('\n')

/** 查找栏状态 + 当前命中（WYSIWYG 面用文档选区文本，源码面用 textarea 选区文本） */
const STATE = `(() => {
  const f = window.__L.store('find')
  const ed = window.__L.ed()
  let selText = null
  if (ed) {
    const s = ed.state.selection
    selText = ed.state.doc.textBetween(s.from, s.to, ' ')
  }
  const ta = document.querySelector('textarea.source-editor')
  const taSel = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : null
  return JSON.stringify({
    open: f.open,
    query: f.query,
    count: f.count,
    index: f.index,
    surface: f.surface,
    bars: document.querySelectorAll('.find-bar').length,
    selText,
    taSel,
    taFocused: !!ta && document.activeElement === ta,
    content: window.__L.files().current?.content ?? ''
  })
})()`

async function ctrlF(app) {
  await pressKey(app.send, { key: 'f', code: 'KeyF', vk: 70, modifiers: 2 })
  await sleep(350)
}

async function main() {
  const report = new Reporter('验收：编辑器内查找替换')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const backupMode = await app.ev(`window.__L.ui().editorMode`)
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(350)
  await openDocWith(app, MD, 'find-replace.md')
  await waitEditor(app.ev)
  await sleep(400)

  // 1) Ctrl+F 打开
  await ctrlF(app)
  let s = JSON.parse(await app.ev(STATE))
  report.check('F1 Ctrl+F 打开查找栏', s.open === true && s.bars === 1, JSON.stringify(s).slice(0, 160))

  // 2) 输入查询 → 命中 5 处（大小写不敏感），并选中最前一处
  await app.send('Input.insertText', { text: 'alpha' })
  await sleep(400)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F2 查询命中 4 处且自动选中第一个',
    s.count === 4 && s.index === 0 && s.selText === 'Alpha',
    `count=${s.count} index=${s.index} sel=${JSON.stringify(s.selText)}`
  )

  // 3) 下一个 / 上一个（含循环）
  await pressKey(app.send, { key: 'Enter', code: 'Enter', vk: 13 })
  await sleep(250)
  s = JSON.parse(await app.ev(STATE))
  report.check('F3 Enter → 下一个命中', s.index === 1 && s.selText === 'alpha', `index=${s.index} sel=${s.selText}`)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 8 }) // Shift+Enter
  await sleep(250)
  s = JSON.parse(await app.ev(STATE))
  report.check('F4 Shift+Enter → 上一个命中', s.index === 0 && s.selText === 'Alpha', `index=${s.index} sel=${s.selText}`)
  // 从第一个往上 → 绕回最后一个
  await pressKey(app.send, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 8 })
  await sleep(250)
  s = JSON.parse(await app.ev(STATE))
  report.check('F5 在第一个上「上一个」→ 绕回最后一个', s.index === 3, `index=${s.index}`)

  // 4) 大小写开关
  await clickCenter(app.send, app.ev, '.find-case')
  await sleep(350)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F6 「Aa」区分大小写 → 只剩 2 处（都是小写）',
    s.count === 2 && s.selText === 'alpha',
    `count=${s.count} sel=${JSON.stringify(s.selText)}`
  )
  await clickCenter(app.send, app.ev, '.find-case')
  await sleep(300)

  // 5) 替换当前命中（选中的是 Alpha → 换成 Omega）
  await clickCenter(app.send, app.ev, '.find-row:last-of-type .find-input')
  await app.send('Input.insertText', { text: 'Omega' })
  await sleep(250)
  await clickCenter(app.send, app.ev, '.find-replace-btn')
  await sleep(450)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F7 「替换」只改当前命中（Alpha → Omega）',
    s.content.includes('Omega alpha ALPHA alpha') && !s.content.includes('Alpha alpha'),
    JSON.stringify(s.content).slice(0, 120)
  )

  // 6) 全部替换（剩下 4 处 alpha → Omega）
  await clickCenter(app.send, app.ev, '.find-replace-all-btn')
  await sleep(500)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F8 「全部替换」改完剩下的 3 处',
    s.content.includes('Omega Omega Omega Omega') && s.count === 0,
    `content=${JSON.stringify(s.content).slice(0, 100)} count=${s.count}`
  )

  // 7) Esc 关闭
  await pressKey(app.send, { key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(300)
  s = JSON.parse(await app.ev(STATE))
  report.check('F9 Esc 关闭查找栏', s.open === false && s.bars === 0, JSON.stringify(s).slice(0, 120))

  // 8) 源码模式：在 textarea 里找 + 替换（走 store 文本，渲染面随之跟上）
  await openDocWith(app, MD, 'find-replace-source.md')
  await sleep(400)
  await clickMode(app, 2) // 源码
  await waitRestored(app.ev)
  await ctrlF(app)
  await app.send('Input.insertText', { text: 'beta' })
  await sleep(400)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F10 源码面：查询命中 2 处且 textarea 里选中第一个（不抢输入框焦点）',
    s.surface === 'source' && s.count === 2 && s.taSel === 'beta' && s.taFocused === false,
    `surface=${s.surface} count=${s.count} taSel=${s.taSel} focused=${s.taFocused}`
  )
  // 替换值直接写 store：点输入框再 insertText 会接在上一轮的值后面（实测变成 OmegaBETA）
  await app.ev(`window.__L.store('find').setReplacement('BETA')`)
  await sleep(150)
  await clickCenter(app.send, app.ev, '.find-replace-all-btn')
  await sleep(500)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F11 源码面「全部替换」落进 store 正文',
    s.content.includes('BETA BETA') && !s.content.includes('beta'),
    JSON.stringify(s.content).slice(0, 120)
  )
  await pressKey(app.send, { key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(200)
  await clickMode(app, 0) // 回到渲染
  await waitRestored(app.ev)
  const rendered = await app.ev(`(() => {
    const ed = window.__L.ed()
    return ed ? ed.state.doc.textContent.includes('BETA BETA') : null
  })()`)
  report.check('F12 源码面的替换回灌到渲染面', rendered === true, String(rendered))

  await app.ev(`(() => { window.__L.ui().editorMode = ${JSON.stringify(backupMode)}; return 'ok' })()`)
  await sleep(200)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
