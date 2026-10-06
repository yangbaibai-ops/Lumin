'use strict'
// ─── 验收：指针手势期间标记的显隐时机（`.md-marker` 的「去墨」）──────────────────────
//
// 需求两条，**触发时机不同**（第二十六轮把「去墨」从按下挪到真的拖动之后）：
//   * **拖选**一段加粗文字时，标记不要跟着选区一起进/出（视觉上很吵）⇒ 拖动期间去墨；
//   * **按下不拖动**（点一下选光标、双击选词）**不该让已经显形的 `**` 消失** ——
//     用户实测报障：光标在构造内（正显示着 `**`）时在别处按一下，`**` 立刻消失、
//     松手又回来（闪动）。成因就是「`mousedown` 即挂 `.press-hidden`」。
//
// 实现口径（第二十四轮定稿 + 第二十六轮时机修正，见 typoraInlineMarks 的
// `pressHeld` / `pressInkHidden` / `PRESS_DRAG_SLOP`）：
//   * 按下即 **冻结显隐装饰**（手势期间谁显形谁折叠不变、版面一个像素不动）；
//   * **指针移动超过 4px 之后**才由 CSS
//     `.press-hidden .md-marker:has(> .md-reveal-inline) { color: transparent }` 去墨 ——
//     只去墨，宽度/占位照旧。
// 为什么不能改占位（`font-size: 0` 真折叠、或 `position: absolute` 脱离流）：一行里标记的
// 宽度会因此变化（一对 `**` 是 15.5px），而浏览器判光标落点、PM 在拖拽每次 `mousemove` 上
// 重算坐标，都发生在「当时的布局」上 —— 布局一变落点就跑到别的字符（实测：光标在构造内时
// 按下、标记一收起 ⇒ 整行左移 15px，「点在『地』」落到了下一个字；拖拽中途折叠 ⇒ 整段拖选
// 塌成一个光标）。
//
// 判据分六拍（都在同一份文档上、用**真实鼠标事件**驱动，不假手 store 调用）：
//   A. 光标落进加粗构造内 → `**` **显形**（有宽度、有字色）
//   B. 按下左键**不移动** → 标记**仍显形**（字色不透明、宽度照旧），且**版面一个像素都不动**
//   C. 拖动中（仍按住）→ 去墨（字色透明）、宽度与位置仍不变
//   D. 松开 → 立刻恢复显形（字色回来）
//   E. 单击（不拖动）后也恢复正常
//   F. 按住后拖到编辑区外：按下那一拍仍显形、拖出去才去墨；松手不会留下隐藏态
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

/**
 * 标记现状：总数 / 已展开数 / 每个标记的实测宽度 / 字号 / 字色 / 透明度 / 整行宽度
 * + **两个参考字的屏幕左缘**（`bravo` 的第一个字、标记之后的 `charlie` 的第一个字）。
 * `xBravo`/`xCharlie` 是关键断言：只去墨的隐藏**不该让任何文字移位**（真折叠/脱离流会移）。
 */
const PROBE = `JSON.stringify((() => {
  const marks = [...document.querySelectorAll('.ProseMirror .md-marker')]
  const root = document.querySelector('.ProseMirror')
  const p = document.querySelector('.ProseMirror p')
  const cs = marks.map((m) => getComputedStyle(m))
  const xOf = (word) => {
    if (!p) return -1
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const t = walker.currentNode
      const i = t.data.indexOf(word)
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(t, i); r.setEnd(t, i + 1)
      return Math.round(r.getBoundingClientRect().left * 10) / 10
    }
    return -1
  }
  const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
  return {
    total: marks.length,
    revealed: marks.filter((m) => m.querySelector('.md-reveal-inline')).length,
    texts: marks.map((m) => m.textContent),
    widths: marks.map((m) => Math.round(m.getBoundingClientRect().width)),
    fontSizes: cs.map((c) => c.fontSize),
    colors: cs.map((c) => c.color),
    opacities: cs.map((c) => c.opacity),
    inkHidden: cs.map((c) => transparent(c.color)),
    xBravo: xOf('bravo'),
    xCharlie: xOf('charlie'),
    paraWidth: p ? Math.round(p.getBoundingClientRect().width) : -1,
    pressHidden: !!root && root.classList.contains('press-hidden')
  }
})())`

/**
 * 把「返回对象的页面表达式」取值回来。
 *
 * 为什么不直接 `JSON.parse(await ev(expr))`：CDP 的 `returnByValue` 把对象压成
 * `[object Object]`；而表达式自己 `JSON.stringify` 又会让调用方拿到「字符串的字符串」
 * （`pt.x` 变 undefined，鼠标事件全落在 (undefined, undefined) —— 实测踩到，且全程不报错）。
 * 统一在这里包一层序列化，表达式本身保持裸对象。
 */
async function objectOf(ev, expr) {
  return JSON.parse(await ev(`JSON.stringify(${expr})`))
}

/** 找 `word` 的首字符在视口里的坐标（真实命中点） */
const POINT_OF = (word) => `(() => {
  const p = document.querySelector('.ProseMirror p')
  if (!p) return { found: false }
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  let node = null
  while (walker.nextNode()) { if (walker.currentNode.textContent.includes(${JSON.stringify(word)})) { node = walker.currentNode; break } }
  if (!node) return { found: false }
  const idx = node.textContent.indexOf(${JSON.stringify(word)})
  const r = document.createRange()
  r.setStart(node, idx)
  r.setEnd(node, idx + 1)
  const b = r.getBoundingClientRect()
  const pm = document.querySelector('.ProseMirror').getBoundingClientRect()
  return {
    found: true,
    x: Math.round(b.left + b.width / 2),
    y: Math.round(b.top + b.height / 2),
    inEditor: b.left >= pm.left && b.right <= pm.right
  }
})()`

/** 标记是否「不显形」：折叠态（fontSize 0）或零占位隐藏态（opacity 0） */
const hidden = (s, i) => s.fontSizes[i] === '0px' || s.opacities[i] === '0'

async function main() {
  const report = new Reporter('验收：标记按住不显形 / 松开显示')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { ev, send } = app
  const mouse = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
      buttons,
      clickCount: 1
    })

  await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(350)
  await openDocWith(app, MD, 'marker-hold.md')
  await waitEditor(ev)
  await sleep(700)

  // 把光标放进 `**bravo**` 里面（构造内 → 标记应显形）
  const inside = await ev(`(() => {
    const ed = window.__L.ed()
    if (!ed) return -1
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (n.isText && n.text && n.text.includes('bravo')) pos = p + 2 })
    if (pos > 0) ed.commands.setTextSelection(pos)
    return pos
  })()`)
  await sleep(500)

  // ── A. 光标在构造内 → 显形 ──
  let s = JSON.parse(await ev(PROBE))
  const geom = { xBravo: s.xBravo, xCharlie: s.xCharlie }
  console.log('A ' + JSON.stringify(s))
  report.check('A 标记渲染出来了（真实文本标记模型）', s.total >= 2, JSON.stringify(s.texts))
  report.check(
    'A 光标在构造内 → 两侧标记显形',
    s.revealed === 2 && s.fontSizes.every((f) => f !== '0px') && s.widths.every((w) => w > 0),
    JSON.stringify({ revealed: s.revealed, fs: s.fontSizes, w: s.widths })
  )
  report.check(
    'A 显形时标记有可见字色（后面「按住只剩透明墨」才有对照）',
    s.inkHidden.every((h) => h === false) && s.xBravo > 0 && s.xCharlie > 0,
    JSON.stringify({ colors: s.colors, geom })
  )

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
  console.log('B ' + JSON.stringify(s))
  report.check(
    'B 按住左键**不拖动** → 标记仍显形（字色不透明、宽度照旧）—— 用户报的「按住就闪」',
    s.revealed === 2 &&
      s.inkHidden.every((h) => h === false) &&
      s.fontSizes.every((f) => f !== '0px') &&
      s.widths.every((w) => w > 0),
    JSON.stringify({ revealed: s.revealed, colors: s.colors, fs: s.fontSizes, w: s.widths })
  )
  report.check(
    'B 按下（未拖动）不产生任何隐藏态（根节点没有 .press-hidden）',
    s.pressHidden === false,
    JSON.stringify({ pressHidden: s.pressHidden, colors: s.colors })
  )
  report.check(
    'B 按住期间版面不动：正文与标记之后文字的屏幕位置一个像素都不变',
    s.xBravo === geom.xBravo && s.xCharlie === geom.xCharlie,
    JSON.stringify({ now: { xBravo: s.xBravo, xCharlie: s.xCharlie }, before: geom })
  )

  await mouse('mouseMoved', pt.x + 70, pt.y, 1)
  await sleep(300)
  s = JSON.parse(await ev(PROBE))
  console.log('C ' + JSON.stringify(s))
  report.check(
    'C 拖动中（仍按住）依旧只剩透明墨，且文字位置仍不变',
    s.pressHidden === true &&
      s.inkHidden.every((h) => h === true) &&
      s.xBravo === geom.xBravo &&
      s.xCharlie === geom.xCharlie,
    JSON.stringify({ colors: s.colors, now: { xBravo: s.xBravo, xCharlie: s.xCharlie }, before: geom })
  )

  await mouse('mouseReleased', pt.x + 70, pt.y, 0)
  await sleep(450)
  s = JSON.parse(await ev(PROBE))
  console.log('D ' + JSON.stringify(s))
  report.check(
    'D 松开后立刻恢复显形（字色回来、宽度照旧）',
    s.pressHidden === false &&
      s.revealed === 2 &&
      s.widths.every((w) => w > 0) &&
      s.inkHidden.every((h) => h === false),
    JSON.stringify({ pressHidden: s.pressHidden, revealed: s.revealed, w: s.widths, colors: s.colors })
  )
  report.check(
    'D 松开后文字位置仍与按下前一致（整个过程版面没动）',
    s.xBravo === geom.xBravo && s.xCharlie === geom.xCharlie,
    JSON.stringify({ now: { xBravo: s.xBravo, xCharlie: s.xCharlie }, before: geom })
  )

  // ── E. 单击（不拖动）后也恢复 ──
  await mouse('mouseMoved', pt.x, pt.y, 0)
  await mouse('mousePressed', pt.x, pt.y, 1)
  await sleep(120)
  await mouse('mouseReleased', pt.x, pt.y, 0)
  await sleep(400)
  s = JSON.parse(await ev(PROBE))
  console.log('E ' + JSON.stringify(s))
  report.check(
    'E 单击后标记恢复显形（字色不透明）',
    s.pressHidden === false && s.revealed >= 1 && s.inkHidden.every((h) => h === false),
    JSON.stringify({ pressHidden: s.pressHidden, revealed: s.revealed, colors: s.colors })
  )

  // ── F. 按住后拖到编辑区外松手（拖到左侧栏上放掉）──
  // 两拍分开断言：**按下那一拍仍显形**（第二十六轮：按下不拖动不许闪），
  // **拖出去之后才去墨**；松手不留下隐藏态。
  await mouse('mouseMoved', pt.x, pt.y, 0)
  await mouse('mousePressed', pt.x, pt.y, 1)
  await sleep(200)
  const duringPress = JSON.parse(await ev(PROBE))
  report.check(
    'F 按住（还没移动）→ 标记仍显形（按下本身不改屏幕）',
    duringPress.pressHidden === false && duringPress.inkHidden.every((h) => h === false),
    JSON.stringify({ pressHidden: duringPress.pressHidden, colors: duringPress.colors })
  )
  await mouse('mouseMoved', 60, pt.y, 1)
  await sleep(200)
  const duringOutside = JSON.parse(await ev(PROBE))
  report.check(
    'F 拖出编辑区（仍按住）→ 去墨（只有透明墨，宽度与位置照旧）',
    duringOutside.pressHidden === true &&
      duringOutside.inkHidden.every((h) => h === true) &&
      duringOutside.widths.every((w) => w > 0) &&
      duringOutside.xBravo === geom.xBravo &&
      duringOutside.xCharlie === geom.xCharlie,
    JSON.stringify({
      pressHidden: duringOutside.pressHidden,
      colors: duringOutside.colors,
      w: duringOutside.widths
    })
  )
  await mouse('mouseReleased', 60, pt.y, 0)
  await sleep(450)
  s = JSON.parse(await ev(PROBE))
  console.log(
    'F ' + JSON.stringify({ press: duringPress.pressHidden, out: duringOutside.pressHidden, after: s.pressHidden })
  )
  report.check(
    'F 拖到编辑区外松手也不会留下隐藏态（且字色恢复）',
    s.pressHidden === false && s.revealed === 2 && s.inkHidden.every((h) => h === false),
    JSON.stringify({ during: duringOutside.pressHidden, after: s.pressHidden, colors: s.colors })
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)

