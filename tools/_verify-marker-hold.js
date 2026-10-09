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
    JSON.stringify({
      colors: s.colors,
      now: { xBravo: s.xBravo, xCharlie: s.xCharlie },
      before: geom
    })
  )

  await mouse('mouseReleased', pt.x + 70, pt.y, 0)
  await sleep(450)
  s = JSON.parse(await ev(PROBE))
  console.log('D ' + JSON.stringify(s))
  /**
   * ⚠️ 第十四轮改了显隐判据（构造被选区完全包住 ⇒ 不显形），这条拖选松手后的选区
   * **正好把整个构造包了进去**，所以"松开就恢复成 2"不再是正确期望 —— 正确期望是
   * "松开解除冻结，显隐状态**恰好等于判据对该选区的结论**"。这里把判据算一遍再比，
   * 既保留了这条断言的意图（冻结必须解除、不许留下隐藏态），也不写死具体数值。
   */
  const expectReveal = await ev(`(() => {
    const ed = window.__L.ed()
    const s = ed.state.selection
    let c = null
    ed.state.doc.descendants((n, p) => {
      if (c || !n.isTextblock) return true
      let first = -1
      let last = -1
      n.forEach((ch, o) => {
        if (ch.isText && ch.marks.some((m) => m.type.name === 'mdMarker')) { if (first < 0) first = o; last = o + ch.nodeSize }
      })
      if (first >= 0) c = { from: p + 1 + first, to: p + 1 + last }
      return true
    })
    if (!c) return 0
    const ok = s.from === s.to
      ? s.from <= c.to && s.to >= c.from
      : (s.from > c.from && s.from < c.to) || (s.to > c.from && s.to < c.to)
    return ok ? 2 : 0
  })()`)
  const stable = JSON.parse(await ev(PROBE))
  report.check(
    'D 松开后解除冻结：显隐状态**恰好等于第十四轮判据对该选区的结论**，且字色不残留透明墨',
    s.pressHidden === false &&
      s.revealed === expectReveal &&
      s.widths.every((w) => (s.revealed === 2 ? w > 0 : w === 0)) &&
      s.inkHidden.every((h) => h === false),
    JSON.stringify({
      pressHidden: s.pressHidden,
      revealed: s.revealed,
      expectReveal,
      w: s.widths,
      colors: s.colors
    })
  )
  report.check(
    'D 松开后版面立刻稳定（再读一次一个像素都不动，没有半折叠/抖动残留）',
    stable.xBravo === s.xBravo && stable.xCharlie === s.xCharlie && stable.revealed === s.revealed,
    JSON.stringify({
      first: { xBravo: s.xBravo, xCharlie: s.xCharlie, revealed: s.revealed },
      again: { xBravo: stable.xBravo, xCharlie: stable.xCharlie, revealed: stable.revealed },
      before: geom
    })
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
    'F ' +
      JSON.stringify({
        press: duringPress.pressHidden,
        out: duringOutside.pressHidden,
        after: s.pressHidden
      })
  )
  report.check(
    'F 拖到编辑区外松手也不会留下隐藏态（且字色恢复）',
    s.pressHidden === false && s.revealed === 2 && s.inkHidden.every((h) => h === false),
    JSON.stringify({ during: duringOutside.pressHidden, after: s.pressHidden, colors: s.colors })
  )

  // ═══ 第十四轮 G：**非空选区的显隐判据**（构造被完全包住 ⇒ 不显形） ═══════════════
  //
  // 用户口径：`AB**CDE**FG` 里从 G 反向拖到 A（整个 `**CDE**` 被包在选区中间）**不该**显示 `**`；
  // 只有**选区边界严格切进构造内部**（`rs < from < re` 或 `rs < to < re`）才显示。
  // 空选区（光标）照旧：落在构造内或紧贴两端都显示（用户以前专门要过，不许被顺手改掉）。
  //
  // 为什么放在这个套件：本轮改的就是"显隐装饰的可见性判据"，而这个套件本来就是
  // 「标记显隐 + 真实鼠标手势」的家（有 `POINT_OF`/`mouse` 的拖选原语与 `revealed` 计数），
  // 与 `_verify-inline-formats.js` 里那套"拖选去墨/冷冻"的断言同源、互不重复。
  //
  // ⚠️ 读取时机：手势期间装饰是**冻结**的（`pressHeld`），所以断言一律在 `mouseReleased`
  // 之后读（那才是"这次选区的真值"）。
  const REVEAL = `JSON.stringify((() => {
    const marks = [...document.querySelectorAll('.md-marker')]
    return {
      revealed: marks.filter((m) => !!m.querySelector('.md-reveal-inline')).length,
      fs: marks.map((m) => getComputedStyle(m).fontSize),
      w: marks.map((m) => Math.round(m.getBoundingClientRect().width)),
      sel: window.__L.ed().state.selection.from + '-' + window.__L.ed().state.selection.to
    }
  })())`
  /** 真实拖选：从 fromWord 的首字拖到 toPoint 给出的坐标（按住 → 多步移动 → 松开）
   *  ⚠️ 必须**多步**移动：本仓库的实测经验是"单步大跳"会被浏览器/PM 当成整段选择
   *  （实测 `sel` 直接变成整段 `2-17`），分几步走才是用户真实拖动的手感。 */
  const dragTo = async (fromWord, toPointExpr) => {
    const a = await objectOf(ev, POINT_OF(fromWord))
    const b = await objectOf(ev, toPointExpr)
    await mouse('mouseMoved', a.x, a.y, 0)
    await mouse('mousePressed', a.x, a.y, 1)
    await sleep(90)
    const steps = 4
    for (let i = 1; i <= steps; i += 1) {
      await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, 1)
      await sleep(45)
    }
    await mouse('mouseReleased', b.x, b.y, 0)
    await sleep(430)
    return JSON.parse(await ev(REVEAL))
  }
  /** 第 n 个 `.md-marker`（0 起）的**首字符**中心坐标 —— 用来把选区边界丢进标记文本内部 */
  const POINT_IN_MARKER = (n) => `(() => {
    const m = document.querySelectorAll('.md-marker')[${n}]
    if (!m) return { found: false }
    const b = m.getBoundingClientRect()
    return { found: true, x: Math.round(b.left + 2), y: Math.round(b.top + b.height / 2) }
  })()`
  /** 用 PM API 设选区（拖不动/要精确到某一格时用） */
  const setSel = async (from, to) => {
    await ev(
      `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection({ from: ${from}, to: ${to} }).run(); return 'ok' })()`
    )
    await sleep(280)
    return JSON.parse(await ev(REVEAL))
  }
  /** 当前文档里第一个构造的 [起点, 终点]（第一颗标记文本的起点 → 最后一颗的终点） */
  const CONSTRUCT = `JSON.stringify((() => {
    const ed = window.__L.ed()
    let out = null
    ed.state.doc.descendants((node, pos) => {
      if (out || !node.isTextblock) return out ? false : true
      let first = -1
      let last = -1
      node.forEach((child, off) => {
        if (child.isText && child.marks.some((m) => m.type.name === 'mdMarker')) {
          if (first < 0) first = off
          last = off + child.nodeSize
        }
      })
      if (first >= 0) out = { from: pos + 1 + first, to: pos + 1 + last }
      return true
    })
    return out
  })())`

  await openDocWith(app, MD, 'marker-hold-g.md')
  await waitEditor(ev)
  await sleep(800)
  const c1 = JSON.parse(await ev(CONSTRUCT))
  // 先把光标放进构造内，保证"起点就是显形态"（后面每条都从干净态出发）
  await setSel(c1.from + 2, c1.from + 2)
  const gBase = JSON.parse(await ev(REVEAL))
  report.check(
    'G 前提：光标在构造内 ⇒ 两侧标记显形（与 A 同口径，作为后面每条的起点）',
    gBase.revealed === 2 && gBase.w.every((w) => w > 0),
    JSON.stringify({ revealed: gBase.revealed, w: gBase.w, sel: gBase.sel })
  )

  // ① 从 G 反向拖到 A（整个 `**bravo**` 被包在选区中间）⇒ **不显形**
  const g1 = await dragTo('charlie', POINT_OF('alfa'))
  report.check(
    'G1 ① 从 G 反向拖到 A（构造被选区完全包住）⇒ `**` **一枚都不显形**（字号 0、宽度 0）',
    g1.revealed === 0 && g1.fs.every((f) => f === '0px') && g1.w.every((w) => w === 0),
    JSON.stringify({ revealed: g1.revealed, fs: g1.fs, w: g1.w, sel: g1.sel })
  )

  // ② 边界切进构造内部（内容里 / 标记文本里）⇒ 显形
  //
  // ⚠️ 这三条**用 PM 选区 API**，不用合成拖选：本套件的合成拖选在"起点在构造右侧、终点在
  // 构造内部"这种**小幅反向**拖动上会退化成整段范围（实测每次都是 `2-17`，与终点坐标无关 ——
  // 是 harness 的已知限制，不是产品行为）。同一条判据的"整段包住"方向已经由 G1/G4 的**真实拖选**
  // 覆盖，"边界切进"方向在此用 API 精确设位（`from = rs+3`、`to = 段落末尾` 等）。
  const g2 = await setSel(c1.from + 3, c1.to + 5)
  report.check(
    'G2 ② 边界切进内容（`from` 落在 `bravo` 内部）⇒ `**` 重新显形',
    g2.revealed === 2 && g2.w.every((w) => w > 0),
    JSON.stringify({ revealed: g2.revealed, w: g2.w, sel: g2.sel })
  )
  const g3 = await setSel(c1.to - 1, c1.to + 5)
  report.check(
    'G3 ② 边界落在**收尾标记文本内部**（`rs < to < re`）⇒ `**` 显形',
    g3.revealed === 2 && g3.w.every((w) => w > 0),
    JSON.stringify({ revealed: g3.revealed, w: g3.w, sel: g3.sel })
  )

  // ③ 正向（A→G）与反向（G→A）结果一致
  const g4 = await dragTo('alfa', POINT_OF('arlie'))
  report.check(
    'G4 ③ 正向从 A 拖到 G（同样把构造完全包住）⇒ 不显形 —— 与 G1 的反向结果一致',
    g4.revealed === 0 && g1.revealed === 0,
    JSON.stringify({ forward: g4.revealed, backward: g1.revealed, sel: g4.sel })
  )
  const g5 = await setSel(1, c1.from + 4)
  report.check(
    'G5 ③ 正向把边界切进内容（`to` 落在 `bravo` 内部）⇒ 显形 —— 与 G2 的反向结果一致',
    g5.revealed === 2 && g2.revealed === 2,
    JSON.stringify({ forward: g5.revealed, backward: g2.revealed, sel: g5.sel })
  )

  // ⑤ 空选区（光标）回归：构造内 / 紧贴两端都仍然显形
  const gIn = await setSel(c1.from + 3, c1.from + 3)
  const gLeft = await setSel(c1.from, c1.from)
  const gRight = await setSel(c1.to, c1.to)
  const gOut = await setSel(1, 1)
  report.check(
    'G6 ⑤ 空选区回归：光标在构造内、紧贴左端、紧贴右端都**仍然显形**；移出构造才折叠',
    gIn.revealed === 2 && gLeft.revealed === 2 && gRight.revealed === 2 && gOut.revealed === 0,
    JSON.stringify({
      in: gIn.revealed,
      left: gLeft.revealed,
      right: gRight.revealed,
      out: gOut.revealed
    })
  )

  // ④ 同类标记（`*` 斜体 / `~~` 删除线 / 反引号行内代码）：完全包含 ⇒ 不显形；边界切进 ⇒ 显形
  const OTHER = [
    'ala *bravo* charlie',
    '',
    'ala ~~bravo~~ charlie',
    '',
    'ala ' + String.fromCharCode(96) + 'bravo' + String.fromCharCode(96) + ' charlie'
  ].join('\n')
  await openDocWith(app, OTHER, 'marker-hold-g2.md')
  await waitEditor(ev)
  await sleep(800)
  const kinds = [
    { name: '`*` 斜体', re: /^ala \*bravo\* charlie$/ },
    { name: '`~~` 删除线', re: /^ala ~~bravo~~ charlie$/ },
    { name: '反引号行内代码', re: /^ala .bravo. charlie$/ }
  ]
  const seen = []
  for (let i = 0; i < 3; i += 1) {
    // 第 i 段：先定位它的构造区间（按段落顺序取第 i 个文本块的标记范围）
    const c = JSON.parse(
      await ev(
        `JSON.stringify((() => {
        const ed = window.__L.ed()
        const blocks = []
        ed.state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return true
          let first = -1
          let last = -1
          node.forEach((child, off) => {
            if (child.isText && child.marks.some((m) => m.type.name === 'mdMarker')) {
              if (first < 0) first = off
              last = off + child.nodeSize
            }
          })
          blocks.push(first < 0 ? null : { from: pos + 1 + first, to: pos + 1 + last, text: node.textContent })
          return true
        })
        return blocks[${i}]
      })())`
      )
    )
    if (!c) {
      seen.push({ name: kinds[i].name, skip: true })
      continue
    }
    const full = await setSel(c.from, c.to)
    const cut = await setSel(c.from + 2, c.to)
    seen.push({
      name: kinds[i].name,
      text: c.text,
      hasRun: kinds[i].re.test(c.text),
      full: full.revealed,
      cut: cut.revealed
    })
    report.check(
      'G7.' + (i + 1) + ' ④ ' + kinds[i].name + '：整段构造被选中 ⇒ 不显形；边界切进 ⇒ 显形',
      full.revealed === 0 && cut.revealed === 2,
      JSON.stringify({
        text: c.text,
        range: [c.from, c.to],
        full: full.revealed,
        cut: cut.revealed
      })
    )
  }
  console.log('G7 明细 ' + JSON.stringify(seen))

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
