'use strict'
// ─── 回归：快速连续回车不能丢（代码块里的「丢字」类数据损坏）─────────────────
//
// 曾经的 bug：在代码块里快速连敲回车（或按住不放），CM 的 state 已经往前跑了，
// 而外部同步用的是**过期快照**，于是把 CM 的整块内容回滚到旧文本 —— 敲出来的换行
// 一层层丢掉。修法见手册 §4.59（CM 侧「现读节点文本 + 文本一致就不动 +
// CM 拿着光标绝不覆盖」）。
//
// 这条守住的是三处必须一致：CM 的可见行数、Tiptap 文档里的行数、**落进 store 的正文**。
// 少一处就说明某条同步链路在回滚。
//
// 跑法：node tools/_repro-rapidenter.js（先起隔离实例）

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

const MD = ['```js', 'const a = 1', '```', '', '尾部段落。'].join('\n')

/** 三处一起读：CM 可见行 / PM 代码块行 / store 正文行 */
const SNAPSHOT = `(() => {
  const ed = window.__L.ed()
  let pmCode = null
  ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') pmCode = n.textContent })
  const store = window.__L.files().current?.content ?? ''
  // 数 store 里围栏之间的行数：用「开围栏行号 → 下一个围栏行号」差值，
  // 别用 /\`\`\`\\n([\\s\\S]*?)\\n\`\`\`/ 那种正则 —— 内容以空行结尾时，
  // 它会把最后那个换行当成「围栏前换行」吃掉，平白少一行（实测差 1）。
  const storeCodeLines = (() => {
    const lines = store.split('\\n')
    const open = lines.findIndex((l) => /^\`\`\`/.test(l))
    if (open < 0) return -1
    for (let i = open + 1; i < lines.length; i++) {
      if (/^\`\`\`/.test(lines[i])) return i - open - 1
    }
    return -1
  })()
  return JSON.stringify({
    active: (() => {
      const ae = document.activeElement
      return ae ? ae.tagName + '.' + (typeof ae.className === 'string' ? ae.className.split(' ')[0] : '') : null
    })(),
    cmLines: document.querySelectorAll('.cm-line').length,
    pmLines: pmCode === null ? -1 : pmCode.split('\\n').length,
    storeCodeLines
  })
})()`

async function main() {
  const report = new Reporter('回归：快速连续回车全部落盘（CM / PM / store 三处一致）')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const backupAutoSave = await app.ev(`window.__L.settings().autoSave`)
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await openDocWith(app, MD, 'rapidenter.md')
  await waitEditor(app.ev)
  await sleep(400)

  // 点进代码块行尾
  const box = await app.ev(`(() => {
    const el = document.querySelector('.cm-content')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.bottom - 10) })
  })()`)
  if (box === null) {
    report.skip('rapidenter', '没有代码块（.cm-content）')
    return report.finish()
  }
  const p = JSON.parse(box)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
  }
  await sleep(300)
  await clickCenter(app.send, app.ev, '.cm-content')
  await sleep(200)

  const before = JSON.parse(await app.ev(SNAPSHOT))
  report.check('R0 起始态：代码块 1 行、焦点在 CM', before.cmLines === 1 && before.pmLines === 1, JSON.stringify(before))

  // 快速回车 ×8（35ms）+ 模拟按键重复 ×10（15ms）
  for (let i = 0; i < 8; i++) {
    await app.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r'
    })
    await key(app.send, 'keyUp', 'Enter', 'Enter', 13)
    await sleep(35)
  }
  for (let i = 0; i < 10; i++) {
    await app.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r'
    })
    await key(app.send, 'keyUp', 'Enter', 'Enter', 13)
    await sleep(15)
  }
  await sleep(900) // 等序列化防抖（250ms）落进 store

  const after = JSON.parse(await app.ev(SNAPSHOT))
  report.check(
    'R1 CM 里 18 次回车 → 19 行（可见行没被回滚）',
    after.cmLines === 19,
    `cm=${after.cmLines} active=${after.active}`
  )
  report.check('R2 Tiptap 文档里的代码块也是 19 行', after.pmLines === 19, `pm=${after.pmLines}`)
  report.check(
    'R3 落进 store 的正文同样是 19 行（序列化没丢换行）',
    after.storeCodeLines === 19,
    `store=${after.storeCodeLines}`
  )

  await app.ev(`(() => { window.__L.settings().set('autoSave', ${JSON.stringify(backupAutoSave)}); return 'ok' })()`)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
