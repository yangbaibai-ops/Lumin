'use strict'
// ─── 验收：按住指针期间标记折叠、抬手即显示（`.md-marker` 的显隐时机）──────────
//
// 背景：拖选一段加粗文字时，鼠标还没松开两侧的 `**` 就跟着选区一起冒出来，拖选过程里
// 标记不断进/出。产品口径：**标记在指针抬起之后再显示**。
//
// 判据分四拍（都在同一份文档上、用**真实鼠标事件**驱动，不假手 store 调用）：
//   A. 光标落进加粗构造内 → `**` 显示（原有行为，别被本轮改动弄坏）
//   B. 按住左键（拖选进行中）→ 全部折叠（`.md-reveal-inline` 数为 0，且 `**` 实测零宽）
//   C. 拖动中（仍按住）→ 仍然折叠（说明不是只在按下那一瞬折叠）
//   D. 松开 → 立刻恢复显示（这一拍最容易坏：松开本身不改文档也不改选区，
//      不主动踢一次事务就永远回不来）
//
// 跑法：node tools/_verify-marker-hold.js（先起隔离实例）
const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  openDocWith,
  fatal
} = require('./lib/harness')

const MD = 'alfa **bravo** charlie\n'

/** 标记现状：总数 / 已展开数 / 每个标记的实测宽度（折叠 = font-size:0 → 宽 0） */
const PROBE = `JSON.stringify((() => {
  const marks = [...document.querySelectorAll('.ProseMirror .md-marker')]
  const width = (el) => Math.round(el.getBoundingClientRect().width)
  return {
    total: marks.length,
    revealed: marks.filter((m) => m.querySelector('.md-reveal-inline')).length,
    texts: marks.map((m) => m.textContent),
    widths: marks.map(width),
    revealedWidths: marks.filter((m) => m.querySelector('.md-reveal-inline')).map(width)
  }
})())`

/**
 * 把「返回对象的页面表达式」取值回来。
 *
 * 为什么不直接 `JSON.parse(await ev(expr))`：CDP 的 `returnByValue` 把对象压成 `[object Object]`，
 * 而表达式自己 `JSON.stringify` 又会让调用方拿到「字符串的字符串」（`pt.x` 变 undefined，
 * 鼠标事件全部落在 (undefined, undefined) —— 实测踩到，且全程不报错）。
 * 统一在这里包一层序列化，表达式本身保持裸对象。
 */
async function objectOf(ev, expr) {
  return JSON.parse(await ev(`JSON.stringify(${expr})`))
}

/** 段落里某个词的中点（用来落光标 / 起拖） */
const POINT_OF = (word) => `(() => {
  const p = document.querySelector('.ProseMirror p')
  if (!p) return { found: false }
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  let node = null
  while (walker.nextNode()) { if (walker.currentNode.textContent.includes(${JSON.stringify(word)})) { node = walker.currentNode; break } }
  if (!node) return { found: false }
  const range = document.createRange()
  const i = node.textContent.indexOf(${JSON.stringify(word)})
  range.setStart(node, i + 1)
  range.setEnd(node, i + 2)
  const r = range.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)
  const at = document.elementFromPoint(x, y)
  return { found: true, x, y, inEditor: !!(at && at.closest && at.closest('.ProseMirror')) }
})()`

async function main() {
  const report = new Reporter('验收：标记在指针抬起后再显示')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { send, ev } = app

  const mouse = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
      buttons,
      clickCount: 1
    })

  await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(350)
  await openDocWith(app, MD, 'marker-hold.md')
  await waitEditor(ev)
  await sleep(700)

  // 把光标放进 `**bravo**` 里面（构造内 → 标记应显示）
  const inside = await ev(`(() => {
    const ed = window.__L.ed()
    if (!ed) return -1
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (n.isText && n.text && n.text.includes('bravo')) pos = p + 2 })
    if (pos > 0) ed.commands.setTextSelection(pos)
    return pos
  })()`)
  await sleep(500)

  // ── A. 光标在构造内 → 显示 ──
  let s = JSON.parse(await ev(PROBE))
  console.log('A ' + JSON.stringify(s))
  report.check('A 标记渲染出来了（真实文本标记模型）', s.total >= 2, JSON.stringify(s.texts))
  report.check('A 光标在构造内 → 两侧标记显示', s.revealed === 2, JSON.stringify(s))

  // ── B/C/D. 真实鼠标按住 → 拖动 → 松开 ──
  const pt = await objectOf(ev, POINT_OF('bravo'))
  report.check(
    'point-found',
    pt.found === true && Number.isFinite(pt.x) && Number.isFinite(pt.y) && pt.inEditor === true,
    JSON.stringify(pt)
  )
  await mouse('mouseMoved', pt.x, pt.y, 0)
  await mouse('mousePressed', pt.x, pt.y, 1)
  await sleep(300)
  s = JSON.parse(await ev(PROBE))
  const dbgB = await ev(`JSON.stringify((() => {
    const at = document.elementFromPoint(${pt.x}, ${pt.y})
    return { at: at ? (at.className || at.tagName).toString().slice(0, 50) : null,
             inPM: !!(at && at.closest && at.closest('.ProseMirror')),
             pt: { x: ${pt.x}, y: ${pt.y} } }
  })())`)
  console.log('B ' + JSON.stringify(s) + ' ' + dbgB)
  report.check(
    'B 按住左键期间标记全部折叠',
    s.revealed === 0,
    JSON.stringify({ revealed: s.revealed, widths: s.widths }) + ' ' + dbgB
  )

  await mouse('mouseMoved', pt.x + 70, pt.y, 1)
  await sleep(300)
  s = JSON.parse(await ev(PROBE))
  console.log('C ' + JSON.stringify(s))
  report.check(
    'C 拖动中（仍按住）依旧折叠，且标记实测零宽（真折叠、不是变透明）',
    s.revealed === 0 && s.widths.every((w) => w === 0),
    JSON.stringify({ revealed: s.revealed, widths: s.widths })
  )

  await mouse('mouseReleased', pt.x + 70, pt.y, 0)
  await sleep(450)
  s = JSON.parse(await ev(PROBE))
  console.log('D ' + JSON.stringify(s))
  report.check(
    'D 松开后立刻恢复显示',
    s.revealed === 2 && s.revealedWidths.every((w) => w > 0),
    JSON.stringify({ revealed: s.revealed, revealedWidths: s.revealedWidths })
  )

  // ── E. 单击（不拖动）也不能把标记永久按掉：按下→抬起后仍要显示 ──
  await mouse('mouseMoved', pt.x, pt.y, 0)
  await mouse('mousePressed', pt.x, pt.y, 1)
  await sleep(120)
  await mouse('mouseReleased', pt.x, pt.y, 0)
  await sleep(400)
  s = JSON.parse(await ev(PROBE))
  console.log('E ' + JSON.stringify(s))
  report.check(
    'E 单击后标记仍显示（按住期间折叠不会「卡住」）',
    s.revealed >= 1 && s.revealedWidths.every((w) => w > 0),
    JSON.stringify(s)
  )

  // ── F. 在编辑区外松开也要恢复（拖到侧栏上放掉） ──
  await mouse('mouseMoved', pt.x, pt.y, 0)
  await mouse('mousePressed', pt.x, pt.y, 1)
  await sleep(200)
  await mouse('mouseMoved', 60, pt.y, 1) // 拖到左侧栏上方
  await sleep(200)
  s = JSON.parse(await ev(PROBE))
  const foldedOutside = s.revealed === 0
  await mouse('mouseReleased', 60, pt.y, 0)
  await sleep(450)
  s = JSON.parse(await ev(PROBE))
  console.log('F ' + JSON.stringify({ foldedOutside, after: s.revealed }))
  report.check(
    'F 拖到编辑区外松手也能恢复（document 级监听，不会永久折叠）',
    foldedOutside === true && s.revealed === 2,
    JSON.stringify({ foldedOutside, after: s.revealed })
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
