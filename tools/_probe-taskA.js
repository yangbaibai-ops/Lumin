'use strict'
// 任务 A 的**取证探针**（一次性，不入 run-suites）：跑四条路径，每步打印
// doc.textContent + 每个 text 节点的文本与 marks + 段落 innerHTML + 落盘字节。
const { connect, settle, waitEditor, sleep, openDocWith, fatal } = require('./lib/harness')

const FLUSH = `(() => {
  window.dispatchEvent(new Event('beforeunload'))
  return window.__L.files().current?.content ?? null
})()`

const DUMP = `JSON.stringify((() => {
  const ed = window.__L.ed()
  if (!ed) return { err: 'no-editor' }
  const nodes = []
  ed.state.doc.descendants((n, pos) => {
    if (!n.isText) return
    nodes.push({ pos, text: n.text, marks: n.marks.map((m) => m.type.name + '(' + JSON.stringify(m.attrs) + ')') })
  })
  const pm = document.querySelector('.ProseMirror')
  const para = pm ? pm.querySelector('p') : null
  return {
    textContent: ed.state.doc.textContent,
    nodes,
    html: para ? para.innerHTML : null,
    domText: para ? para.textContent : null
  }
})())`

let app = null

async function dump(label) {
  const d = JSON.parse(await app.ev(DUMP))
  const content = await app.ev(FLUSH)
  console.log(`\n### ${label}`)
  console.log('  textContent : ' + JSON.stringify(d.textContent))
  console.log('  字节(flush) : ' + JSON.stringify(content))
  console.log('  DOM 文本    : ' + JSON.stringify(d.domText))
  console.log('  DOM HTML    : ' + d.html)
  for (const n of d.nodes) console.log(`    ${JSON.stringify(n.text)} <${n.marks.join(',')}>`)
  return { d, content }
}

async function typeChars(text, stepLabel) {
  for (const ch of text) {
    await app.send('Input.insertText', { text: ch })
    await sleep(40)
    if (stepLabel) await dump(stepLabel + ' 打到 ' + JSON.stringify(ch))
  }
  await sleep(150)
}

async function focusEnd() {
  await app.ev(`(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    ed.commands.focus('end')
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`)
  await sleep(120)
}

async function openDoc(md) {
  await openDocWith(app, md)
  await sleep(500)
}

async function main() {
  app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(150)

  const TARGET = '**2****2**'

  // ── 路径 1：逐字键入（每步都打印）
  console.log('\n══════ 路径 1：逐字键入 ══════')
  await openDoc('\n')
  await focusEnd()
  await typeChars(TARGET, '[P1]')
  await dump('[P1] 终态')

  // ── 路径 2：一次性 insertContent
  console.log('\n══════ 路径 2：一次性 insertContent ══════')
  await openDoc('\n')
  await app.ev(`(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    ed.commands.focus('end')
    ed.commands.insertContent(${JSON.stringify(TARGET)})
    return 'ok'
  })()`)
  await sleep(300)
  await dump('[P2] insertContent 后')

  // ── 路径 3：setContent / 直接装载 → getMarkdown
  console.log('\n══════ 路径 3：装载源码 ══════')
  await openDoc(TARGET + '\n')
  await dump('[P3] 装载后')
  const gm = await app.ev(`(() => {
    const ed = window.__L.ed()
    try {
      return typeof ed.getMarkdown === 'function' ? ed.getMarkdown() : '(no getMarkdown)'
    } catch (e) { return 'ERR ' + e.message }
  })()`)
  console.log('  getMarkdown : ' + JSON.stringify(gm))

  // ── 路径 4：先 `**2**`（干净中间态）再整段插入 `**2**`
  console.log('\n══════ 路径 4：先 `**2**` 再插入 `**2**` ══════')
  await openDoc('\n')
  await focusEnd()
  await typeChars('**2**')
  await dump('[P4] 打完 `**2**`')
  await focusEnd()
  await app.ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.insertContent(${JSON.stringify('**2**')})
    return 'ok'
  })()`)
  await sleep(300)
  await dump('[P4] 追加 `**2**` 后（终态）')

  // ── 路径 5：粘贴同内容（剪贴板 paste 路径）
  console.log('\n══════ 路径 5：粘贴 ══════')
  await openDoc('\n')
  await focusEnd()
  const pasted = await app.ev(`(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    ed.commands.focus('end')
    const dt = new DataTransfer()
    dt.setData('text/plain', ${JSON.stringify(TARGET)})
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    pm.dispatchEvent(ev)
    return 'ok'
  })()`)
  void pasted
  await sleep(400)
  await dump('[P5] 粘贴后')

  // ── 参考：相邻/嵌套场景
  console.log('\n══════ 参考：相邻与嵌套 ══════')
  for (const s of ['***x***', '**a**b**c**', '*a**b*', '**a`b`c**', '~~x~~', '_x_', '**a * b**', '**2***']) {
    await openDoc(s + '\n')
    const { content } = await dump('装载 ' + JSON.stringify(s))
    void content
  }

  app.close()
}

main()
  .then(() => process.exit(0))
  .catch(fatal)
