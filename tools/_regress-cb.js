'use strict'
// ─── 回归：代码块的核心修复（打字 / 回车 / 退格三类）─────────────────────────
//
// 这一组是「代码块里输入会丢字」那一类 bug 的守卫。它们此前写成一次性脚本
// （自己连 CDP、自己打印 PASS/FAIL），本轮迁到 `lib/harness.js` + `Reporter`，
// 于是能进矩阵、能被 `--- N/M PASS` 机器聚合。
//
// 跑法（对着隔离实例）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-isolated.ps1
//   node tools/_regress-cb.js

const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  key,
  clickCenter,
  openDocWith,
  fatal
} = require('./lib/harness')

/** 代码块（CodeMirror）里的文本 */
const CODE_TEXT = `(() => {
  const ed = window.__L.ed()
  let c = ''
  ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c += '[' + n.textContent + ']' })
  return c
})()`

const CODE_BLOCKS = `(() => {
  const ed = window.__L.ed()
  let n = 0
  ed.state.doc.descendants((x) => { if (x.type.name === 'codeBlock') n++ })
  return n
})()`

/** 代码块里 CodeMirror 看到的文本（与节点文本区分：两者不一致就说明外部同步没生效） */
const CM_TEXT = `(() => {
  const el = document.querySelector('.cm-content')
  return el ? el.textContent : null
})()`

async function tapKey(app, name, vk) {
  await key(app.send, 'keyDown', name, name, vk)
  await key(app.send, 'keyUp', name, name, vk)
}

/**
 * 点进代码块并确认焦点**稳定**落在 CM 里。
 *
 * 为什么要确认两次：账本收敛会触发渲染面再 `setContent` 一次，CM 的 NodeView 随之
 * 重建 —— 我们在重建前点到的是**即将被换掉的那个** `.cm-content`（它当时还在 DOM 里、
 * 也能通过一次焦点检查），换掉之后焦点就丢了，退格键落不到 CM 上（实测：B 段
 * `focused=true` 却 `blocks=1`）。所以点完要隔一拍再确认一次仍然聚焦。
 */
async function focusCodeBlock(app) {
  const isFocused = `(() => {
    const el = document.querySelector('.cm-content')
    return !!el && el.isConnected && (document.activeElement === el || el.contains(document.activeElement))
  })()`
  for (let i = 0; i < 6; i++) {
    await clickCenter(app.send, app.ev, '.cm-content')
    await sleep(220)
    if (await app.ev(isFocused)) {
      await sleep(160)
      if (await app.ev(isFocused)) return true
    }
  }
  return false
}

async function main() {
  const report = new Reporter('回归：代码块打字 / 回车 / 退格')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  await app.ev(`(async () => { if (!window.__L.files().current) await window.__L.files().openUntitled(); return 'ok' })()`)
  await waitEditor(app.ev)

  // A：代码块内输入 + 回车 + 继续输入（换行不能丢）
  await openDocWith(app, ['正文', '', '```js', 'const a = 1', '```'].join('\n'), 'cb-a.md')
  await sleep(400)
  const focused = await focusCodeBlock(app)
  await app.send('Input.insertText', { text: 'hello' })
  await sleep(150)
  await tapKey(app, 'Enter', 13)
  await sleep(150)
  await app.send('Input.insertText', { text: 'world' })
  await sleep(500)
  const codeA = await app.ev(CODE_TEXT)
  report.check(
    'A 代码块内输入 + 回车换行',
    focused === true && typeof codeA === 'string' && codeA.includes('hello') && codeA.includes('world'),
    `focused=${focused} code=${JSON.stringify(codeA)}`
  )

  // B：空代码块按退格 → 整块删除（否则空块「卡住」删不掉）
  await openDocWith(app, ['正文', '', '```', '', '```', '', '尾部'].join('\n'), 'cb-b.md')
  await sleep(400)
  const focusedB = await focusCodeBlock(app)
  const cmTextB = await app.ev(CM_TEXT)
  await tapKey(app, 'Backspace', 8)
  await sleep(400)
  const blocksB = await app.ev(CODE_BLOCKS)
  report.check(
    'B 空代码块退格 → 整块删除',
    focusedB === true && blocksB === 0,
    `focused=${focusedB} blocks=${blocksB} cm=${JSON.stringify(cmTextB)}`
  )

  // C：代码块后段落行首退格 → 光标进入代码块末尾（而不是删掉内容）
  await openDocWith(app, ['正文', '', '```js', 'code line', '```', '', ''].join('\n'), 'cb-c.md')
  await sleep(400)
  await app.ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    ed.commands.focus()
    return 'ok'
  })()`)
  await sleep(150)
  await tapKey(app, 'Backspace', 8)
  await sleep(300)
  const infoC = JSON.parse(
    await app.ev(`(() => {
      const ed = window.__L.ed()
      let code = ''
      ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') code = n.textContent })
      return JSON.stringify({ from: ed.state.selection.from, code })
    })()`)
  )
  report.check(
    'C 代码块后空段落退格 → 光标落入块尾（内容不动）',
    typeof infoC.code === 'string' && infoC.code.endsWith('code line'),
    JSON.stringify(infoC)
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
