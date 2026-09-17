'use strict'
// 粘贴路径取证：用**真的系统剪贴板** + CDP 发 Ctrl+V（合成 ClipboardEvent 走不通，
// 实测它落下的内容与真实粘贴不同）。跑法：
//   powershell -File tools/start-isolated.ps1 -UserData "$env:TEMP\lumin-taskA" -Port 9251
//   $env:LUMIN_DEBUG_PORT=9251; node tools/_probe-paste.js
const { execFileSync } = require('child_process')
const { connect, settle, waitEditor, sleep, openDocWith, pressKey, fatal } = require('./lib/harness')

const FLUSH = `(() => {
  window.dispatchEvent(new Event('beforeunload'))
  return window.__L.files().current?.content ?? null
})()`
const DUMP = `JSON.stringify((() => {
  const ed = window.__L.ed()
  const nodes = []
  ed.state.doc.descendants((n, pos) => {
    if (!n.isText) return
    nodes.push({ pos, text: n.text, marks: n.marks.map((m) => m.type.name) })
  })
  const p = document.querySelector('.ProseMirror p')
  return { text: ed.state.doc.textContent, nodes, dom: p ? p.textContent : null }
})())`

let app = null

function setClipboard(text) {
  execFileSync('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value '${text}'`], {
    stdio: 'inherit'
  })
}

async function pasteInto(text) {
  setClipboard(text)
  await sleep(300)
  await app.ev(`(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    ed.commands.focus('end')
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`)
  await sleep(150)
  await pressKey(app.send, { key: 'v', code: 'KeyV', vk: 86, modifiers: 2 })
  await sleep(500)
  const d = JSON.parse(await app.ev(DUMP))
  const bytes = await app.ev(FLUSH)
  console.log(`\n### 粘贴 ${JSON.stringify(text)}`)
  console.log('  doc.textContent : ' + JSON.stringify(d.text))
  console.log('  字节            : ' + JSON.stringify(bytes))
  console.log('  DOM 文本        : ' + JSON.stringify(d.dom))
  for (const n of d.nodes) console.log(`    ${JSON.stringify(n.text)} <${n.marks.join(',')}>`)
  console.log('  判定            : ' + (bytes === text + '\n' ? 'OK 逐字节' : 'MISMATCH'))
  return bytes
}

async function main() {
  app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  for (const s of ['**2****2**', '**a * b**', '\\*\\*\\*\\*', '**加粗**']) {
    await openDocWith(app, '\n')
    await sleep(400)
    await pasteInto(s)
  }
  app.close()
}

main()
  .then(() => process.exit(0))
  .catch(fatal)
