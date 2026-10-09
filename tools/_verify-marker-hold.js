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
    s.pressHidden === false && s.revealed >= 1 && s.inkHidden.length === s.widths.length,
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
    duringPress.pressHidden === false && duringPress.inkHidden.length === s.widths.length,
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
    s.pressHidden === false && s.revealed === 2 && s.inkHidden.length === s.widths.length,
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
    'G1 ① 从 G 反向拖到 A（构造被选区完全包住）⇒ `**` 不显形：松手后按阅读态**折叠**（字号 0、宽度 0 —— 第十八轮口径：不留空隙）',
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

  // ═══ 第十五轮 H：嵌套标记的配对 + 拖选"模型层 vs 可视层" ═══════════════════════
  //
  // ① 用户报障源码：`**` + 反引号包住的 `****x****` + ` 逐字节留住**`。
  //    真因（文件:行号 = typoraInlineMarks.ts 的 blockInventory，原「只维护一个 cur run 且不看
  //    style」）：`code:start` 因 `bold` 还开着被整颗丢掉，紧接着的 `` ` ``（code:end）又把 `bold`
  //    的 run 提前闭合在**反引号**上 ⇒ 收尾那颗 `**` 没有可闭合的 run、`runs` 里没有任何区间
  //    覆盖它 ⇒ 光标放哪它都不显形（用户说的"后面的 `**` 怎么都不出现"）。
  //    修法：按 style 各开各的 run（同 style 重复 start 仍忽略），收尾按 style 取**最靠里**那个闭合。
  // ② "选中的字符数在松手后不一致"：这里把**模型层**（from/to/textBetween 长度）与**可视层**
  //    （选区矩形宽度、显形标记数）在拖拽中与松手后各读一遍 —— 模型层必须完全一致。
  const SPANS = `JSON.stringify((() => {
    const marks = [...document.querySelectorAll('.md-marker')]
    return {
      total: marks.length,
      revealed: marks.filter((m) => !!m.querySelector('.md-reveal-inline')).length,
      spans: marks.map((m) => ({ t: m.textContent, rev: !!m.querySelector('.md-reveal-inline'), fs: getComputedStyle(m).fontSize }))
    }
  })())`
  const BTQ = String.fromCharCode(96)
  await openDocWith(app, '**' + BTQ + '****x****' + BTQ + ' 逐字节留住**', 'marker-hold-h.md')
  await waitEditor(ev)
  await sleep(900)
  const hDocText = await ev(`window.__L.ed().state.doc.textContent`)
  const hPos = (s) => hDocText.indexOf(s) + 1
  const hSeen = []
  for (const item of [
    ['x 之前', hPos('x')],
    ['x 之后', hPos('x') + 1],
    ['「逐」之前', hPos('逐')],
    ['「住」之后', hPos('逐') + 4],
    ['段落开头', 1],
    ['段落末尾', hDocText.length + 1]
  ]) {
    await ev(
      `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection({ from: ${item[1]}, to: ${item[1]} }).run(); return 'ok' })()`
    )
    await sleep(260)
    const s = JSON.parse(await ev(SPANS))
    hSeen.push({
      label: item[0],
      p: item[1],
      revealed: s.revealed,
      total: s.total,
      last: s.spans[s.spans.length - 1]
    })
  }
  console.log('H1 明细 ' + JSON.stringify(hSeen))
  report.check(
    'H1 ① 嵌套源码：光标落 `x` 前/后、落「逐字节留住」前/后、落整段两端 ⇒ 四枚标记**全部显形**，含收尾那颗 `**`（改前它永不显形）',
    hSeen.length === 6 &&
      hSeen.every((s) => s.revealed === 4 && s.total === 4) &&
      hSeen.every((s) => s.last && s.last.t === '**' && s.last.rev === true),
    JSON.stringify(hSeen)
  )

  // ② 三种嵌套/相邻组合：光标在构造内 ⇒ 外层两侧标记都显形
  const comboSigs = []
  for (const c of [
    { name: '加粗里放行内代码', src: '**' + BTQ + 'code' + BTQ + '**' },
    { name: '加粗里放删除线', src: '**~~x~~**' },
    { name: '行内代码里放加粗', src: BTQ + '**x**' + BTQ }
  ]) {
    await openDocWith(app, c.src, 'marker-hold-h2.md')
    await waitEditor(ev)
    await sleep(850)
    await ev(
      `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection(${Math.floor(c.src.length / 2) + 1}).run(); return 'ok' })()`
    )
    await sleep(300)
    const s = JSON.parse(await ev(SPANS))
    comboSigs.push({
      name: c.name,
      src: c.src,
      total: s.total,
      revealed: s.revealed,
      texts: s.spans.map((x) => x.t)
    })
    report.check(
      'H2 ① 嵌套组合（' + c.name + '）：光标在构造内 ⇒ 标记**一枚不少**地显形（收尾那枚也在）',
      s.total >= 2 && s.revealed === s.total && s.spans[s.spans.length - 1].rev === true,
      JSON.stringify(comboSigs[comboSigs.length - 1])
    )
  }
  console.log('H2 明细 ' + JSON.stringify(comboSigs))

  // ③ 拖选：模型层（from/to/textBetween 长度）在拖拽中与松手后**完全相同**；可视层宽度另记
  const MODEL = `JSON.stringify((() => {
    const ed = window.__L.ed()
    const s = ed.state.selection
    const sel = window.getSelection()
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null
    const marks = [...document.querySelectorAll('.md-marker')]
    return {
      from: s.from, to: s.to,
      betweenLen: ed.state.doc.textBetween(s.from, s.to, '/').length,
      domLen: (sel && sel.rangeCount ? sel.getRangeAt(0).toString() : '').length,
      rectW: r ? Math.round(r.width) : null,
      revealed: marks.filter((m) => !!m.querySelector('.md-reveal-inline')).length
    }
  })())`
  const dragModel = async (fromWord, toWord, name) => {
    await openDocWith(app, 'alfa **bravo** charlie', name)
    await waitEditor(ev)
    await sleep(850)
    await ev(
      `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection(8).run(); return 'ok' })()`
    )
    await sleep(280)
    const a = await objectOf(ev, POINT_OF(fromWord))
    const b = await objectOf(ev, POINT_OF(toWord))
    await mouse('mouseMoved', a.x, a.y, 0)
    await mouse('mousePressed', a.x, a.y, 1)
    await sleep(110)
    for (let i = 1; i <= 4; i += 1) {
      await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 4, a.y, 1)
      await sleep(55)
    }
    const during = JSON.parse(await ev(MODEL))
    await mouse('mouseReleased', b.x, a.y, 0)
    await sleep(550)
    const after = JSON.parse(await ev(MODEL))
    console.log(
      'H3 ' + name + ' 拖拽中=' + JSON.stringify(during) + ' 松手后=' + JSON.stringify(after)
    )
    return { during, after }
  }
  const hd1 = await dragModel('charlie', 'alfa', 'marker-hold-h3.md')
  report.check(
    'H3 ② 真实拖选（构造被完全包住）：**模型层** from/to/textBetween 长度在拖拽中与松手后完全相同（"选中的字符数"变的只是可视层宽度，不是选区）',
    hd1.during.from === hd1.after.from &&
      hd1.during.to === hd1.after.to &&
      hd1.during.betweenLen === hd1.after.betweenLen &&
      hd1.during.domLen === hd1.after.domLen,
    JSON.stringify({ during: hd1.during, after: hd1.after })
  )
  report.check(
    'H3b ② 同一手势的**可视层**：拖拽中标记显形（119px），松手后按阅读态折叠 ⇒ 矩形变窄 31px（第十八轮口径：允许这一次跳，换取"不留空隙"）',
    hd1.after.revealed === 0 && hd1.during.revealed === 2 && hd1.after.rectW < hd1.during.rectW,
    JSON.stringify({
      during: { revealed: hd1.during.revealed, rectW: hd1.during.rectW },
      after: { revealed: hd1.after.revealed, rectW: hd1.after.rectW }
    })
  )
  const hd2 = await dragModel('ravo', 'arlie', 'marker-hold-h4.md')
  report.check(
    'H4 ② 反向真实拖选（边界切进构造）：模型层同样前后一致（可视层这侧是变宽 —— 松手时标记显形）',
    hd2.during.from === hd2.after.from &&
      hd2.during.to === hd2.after.to &&
      hd2.during.betweenLen === hd2.after.betweenLen &&
      hd2.after.revealed === 2 &&
      hd2.after.rectW >= hd2.during.rectW,
    JSON.stringify({ during: hd2.during, after: hd2.after })
  )

  // ═══ 第十七轮 I：布局中性（只去墨、不折叠）═══════════════════════════════════════
  //
  // 第十六轮把"拖拽期间折叠"否掉了（折叠改占位 ⇒ 指针下文字左移 ⇒ 选区塌成一个光标）。
  // 本轮改成**只去墨**：被非空选区完全包住的构造保留 `font-size: inherit`（占位与显形态一致），
  // 只把字色变透明（`.md-reveal-ink`，见 chrome.css 与本文件的注释）。
  // ⇒ 松手那一刻不再有布局位移，宽度差 0；选区收起（退回光标态）时才按折叠态闭合。
  const INK = `JSON.stringify((() => {
    const ed = window.__L.ed()
    const s = ed.state.selection
    const sel = window.getSelection()
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null
    const marks = [...document.querySelectorAll('.md-marker')]
    return {
      from: s.from, to: s.to,
      len: ed.state.doc.textBetween(s.from, s.to, '/').length,
      rectW: r ? Math.round(r.width) : null,
      rev: marks.filter((m) => !!m.querySelector('.md-reveal-inline')).length,
      ink: marks.filter((m) => !!m.querySelector('.md-reveal-ink')).length,
      fs: marks.map((m) => getComputedStyle(m).fontSize),
      widths: marks.map((m) => Math.round(m.getBoundingClientRect().width)),
      transparent: marks.map((m) => getComputedStyle(m).color === 'rgba(0, 0, 0, 0)')
    }
  })())`
  const inkDrag = async (name, fromWord, toWord, caretAt) => {
    await openDocWith(app, 'alfa **bravo** charlie', name)
    await waitEditor(ev)
    await sleep(850)
    await ev(
      `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection(${caretAt}).run(); return 'ok' })()`
    )
    await sleep(260)
    const a = await objectOf(ev, POINT_OF(fromWord))
    const b = await objectOf(ev, POINT_OF(toWord))
    await mouse('mouseMoved', a.x, a.y, 0)
    await mouse('mousePressed', a.x, a.y, 1)
    await sleep(110)
    const seq = []
    for (let i = 1; i <= 5; i += 1) {
      await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 5, a.y, 1)
      await sleep(60)
      seq.push(JSON.parse(await ev(INK)))
    }
    await mouse('mouseReleased', b.x, a.y, 0)
    await sleep(550)
    const after = JSON.parse(await ev(INK))
    const maxTo = Math.max(...seq.map((x) => x.to))
    const minFrom = Math.min(...seq.map((x) => x.from))
    const last = seq[seq.length - 1]
    console.log('I ' + name + ' 末拍=' + JSON.stringify(last) + ' 松手=' + JSON.stringify(after))
    return {
      seq,
      after,
      last,
      maxTo,
      minFrom,
      diff: after.rectW - last.rectW,
      collapsed: after.from === after.to
    }
  }
  const i1 = await inkDrag('完全包住（charlie→alfa，反向）', 'charlie', 'alfa', 8)
  report.check(
    'I1 ① 完全包住的真实拖选（G→A）：**松手后标记既不可见也不占位**（font-size 0px、宽 0 ⇒ 不留 30px 空隙），拖拽期间布局恒定（末拍仍 17px/15px），模型层逐字节一致，松手 = 拖拽最长范围（未塌）',
    i1.after.rev === 0 &&
      i1.after.ink === 0 &&
      i1.after.fs.every((f) => f === '0px') &&
      i1.after.widths.every((w) => w === 0) &&
      i1.last.fs.every((f) => f === '17px') &&
      i1.last.widths.every((w) => w > 0) &&
      i1.after.from === i1.minFrom &&
      i1.after.to === i1.maxTo &&
      i1.collapsed === false,
    JSON.stringify({ diff: i1.diff, last: i1.last, after: i1.after, range: [i1.minFrom, i1.maxTo] })
  )
  const i2 = await inkDrag('边界切进（ravo→arlie）', 'ravo', 'arlie', 5)
  report.check(
    'I2 ② 边界切进（G→D）的真实拖选：两侧标记**必须显形**（可见且占位 17px/15px），未塌、模型一致',
    i2.after.rev === 2 &&
      i2.after.fs.every((x) => x === '17px') &&
      i2.after.widths.every((w) => w > 0) &&
      i2.after.from === i2.minFrom &&
      i2.after.to === i2.maxTo &&
      i2.collapsed === false,
    JSON.stringify({ diff: i2.diff, last: i2.last, after: i2.after })
  )
  const i3 = await inkDrag('反向（charlie→ravo）', 'charlie', 'ravo', 8)
  report.check(
    'I3 ③ 反向（从行尾往左拖，边界切进内容）**绝不塌成光标**；松手按判据显形（这条手势不是"完全包住"，所以本来就该显形）',
    i3.collapsed === false &&
      i3.after.rev === 2 &&
      i3.after.widths.every((w) => w > 0) &&
      i3.after.from === i3.minFrom &&
      i3.after.to === i3.maxTo,
    JSON.stringify({ diff: i3.diff, collapsed: i3.collapsed, last: i3.last, after: i3.after })
  )
  // ⑤ 选区收起（点段首 = 光标态在构造外）⇒ 墨回到折叠、布局闭合
  await ev(
    `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection(1).run(); return 'ok' })()`
  )
  await sleep(350)
  const i4 = JSON.parse(await ev(INK))
  report.check(
    'I4 ⑤ 选区收起（点别处回到光标态）⇒ 标记回到**折叠**（font-size 0px、无去墨类），布局正常闭合',
    i4.rev === 0 && i4.ink === 0 && i4.fs.every((f) => f === '0px'),
    JSON.stringify(i4)
  )

  // ═══ 第二十六轮 J：**松手不再改布局**（用户第二十二轮报障的回归护栏）═══════════════
  //
  // 真因（第二十三轮顺序表实测）：`onUp` 里那次"按最终选区重算显隐"会**改布局**
  //（显隐两态差 31px），而它同时挂在 `pointerup` 上，`pointerup` **早于** `mouseup`
  //（PM 的定稿由 `mouseup` 驱动）⇒ PM 按改动后的布局定稿 ⇒ 用户看到"松手后选中的和拖的不一致"。
  // 第二十六轮修复：把这次重算挪到 `setTimeout(…, 0)`（`onUp` 同步部分只留不改布局的）。
  // 判据：四个时点 `from/to` 完全一致、锚点不变、松手后 == 拖拽最长范围。
  const TBL = '飘逸 **加粗** H 结尾\n\n| 已删功能 | 活文档 |\n| --- | --- |\n| a | b |'
  const PT2 = (w) =>
    `(() => { for (const p of [...document.querySelectorAll('.ProseMirror p, .ProseMirror td')]) { const it = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); while (it.nextNode()) { if (it.currentNode.textContent.includes(${JSON.stringify(w)})) { const n = it.currentNode; const i = n.textContent.indexOf(${JSON.stringify(w)}); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const b = r.getBoundingClientRect(); return { found: true, x: b.left + b.width / 2, y: b.top + b.height / 2 } } } } return { found: false } })()`
  const dragged = async (fromWord, toWord, name) => {
    await openDocWith(app, TBL, name)
    await waitEditor(ev)
    await sleep(900)
    const a = await objectOf(ev, PT2(fromWord))
    const b = await objectOf(ev, PT2(toWord))
    await mouse('mouseMoved', a.x, a.y, 0)
    await mouse('mousePressed', a.x, a.y, 1)
    await sleep(110)
    const anchor = await ev(`window.__L.ed().state.selection.anchor`)
    const seq = []
    for (let i = 1; i <= 5; i += 1) {
      await mouse('mouseMoved', a.x + ((b.x + 20 - a.x) * i) / 5, a.y + ((b.y - a.y) * i) / 5, 1)
      await sleep(70)
      seq.push(await objectOf(ev, ANS))
    }
    await mouse('mouseReleased', b.x + 20, b.y, 0)
    const four = []
    four.push(await objectOf(ev, ANS))
    await sleep(16)
    four.push(await objectOf(ev, ANS))
    await sleep(34)
    four.push(await objectOf(ev, ANS))
    await sleep(120)
    four.push(await objectOf(ev, ANS))
    return {
      anchor,
      anchorAfter: await ev(`window.__L.ed().state.selection.anchor`),
      seq,
      four,
      maxTo: Math.max(...seq.map((s) => s.to)),
      minFrom: Math.min(...seq.map((s) => s.from)),
      last: four[3]
    }
  }
  const ANS = `(() => { const s = window.__L.ed().state.selection; return { from: s.from, to: s.to } })()`
  const jA = await dragged('加粗', 'H', 'marker-hold-j1.md')
  const fourA = [...new Set(jA.four.map((s) => s.from + '-' + s.to))]
  console.log(
    'J1 夹具A 逐拍=' +
      JSON.stringify(jA.seq.map((s) => s.from + '-' + s.to)) +
      ' 四时点=' +
      JSON.stringify(fourA)
  )
  report.check(
    'J1 第二十六轮修复：夹具 A（按下点在构造内）`mouseup` 同拍/+1帧/+50ms/+170ms 四个时点 `from/to` **完全一致**',
    fourA.length === 1,
    JSON.stringify({ four: jA.four, distinct: fourA })
  )
  report.check(
    'J2 第二十六轮修复：夹具 A **锚点不变**且**松手 == 拖拽中的最长范围**',
    jA.anchor === jA.anchorAfter && jA.last.from === jA.minFrom && jA.last.to === jA.maxTo,
    JSON.stringify({
      anchor: jA.anchor,
      anchorAfter: jA.anchorAfter,
      range: [jA.minFrom, jA.maxTo],
      last: jA.last
    })
  )
  const jB = await dragged('飘逸', '已删功能', 'marker-hold-j2.md')
  const fourB = [...new Set(jB.four.map((s) => s.from + '-' + s.to))]
  console.log(
    'J3 夹具B 逐拍=' +
      JSON.stringify(jB.seq.map((s) => s.from + '-' + s.to)) +
      ' 四时点=' +
      JSON.stringify(fourB)
  )
  report.check(
    'J3 第二十六轮修复：夹具 B（按下点在构造外、终点落进表格单元格）四个时点 `from/to` **完全一致**',
    fourB.length === 1,
    JSON.stringify({ four: jB.four, distinct: fourB })
  )
  report.check(
    'J4 第二十六轮修复：夹具 B **锚点不变**且**松手 == 拖拽中的最长范围**',
    jB.anchor === jB.anchorAfter && jB.last.from === jB.minFrom && jB.last.to === jB.maxTo,
    JSON.stringify({
      anchor: jB.anchor,
      anchorAfter: jB.anchorAfter,
      range: [jB.minFrom, jB.maxTo],
      last: jB.last
    })
  )

  // ═══ 第四十一轮 K：**表格内跨单元格**时，折叠重算不得丢选区 ═══════════════════════
  //
  // 真因（用户侧 selTrace 日志）：松手后 +1 帧仍 `647-869`，+50ms 变 `782-782`（塌成光标），
  // **同拍标记由显形折叠成 0 宽** ⇒ 零宽折叠塌掉原生选区、PM 的 DOM 观察器采纳之；
  // 且用户实测"丢尾巴只在表格内部、跨单元格选择时出现"（叠加了 TableDragSelect 的 DOM 重建与
  // TableNoCellClamp/normalizeSelection 的归一化）。修法：跨单元格时把这次重算推迟到 +250ms 并
  // 在同事务里补回捕获的选区。本断言钉住"四个时点 from/to 逐字一致 + 确实跨格"。
  const TBL2 = '| 甲 **乙** 丙 | 丁 | 戊 |\n| --- | --- | --- |\n| x | y | z |'
  await openDocWith(app, TBL2, 'marker-hold-k1.md')
  await waitEditor(ev)
  await sleep(900)
  const kA = await objectOf(ev, PT2('乙'))
  const kB = await objectOf(ev, PT2('戊'))
  // 先让光标落到构造内 ⇒ 标记**显形**（否则手势不触发"折叠"，这条断言就是空跑）
  await ev(
    `(() => { const ed = window.__L.ed(); let p = -1; ed.state.doc.descendants((n, pos) => { if (n.isText && n.text.includes('乙')) p = pos + 1; return true }); ed.chain().focus().setTextSelection(p + 1).run(); return 'ok' })()`
  )
  await sleep(320)
  const kRevealed = JSON.parse(await ev(SPANS))
  await mouse('mouseMoved', kA.x, kA.y, 0)
  await mouse('mousePressed', kA.x, kA.y, 1)
  await sleep(110)
  const kSeq = []
  for (let i = 1; i <= 5; i += 1) {
    await mouse('mouseMoved', kA.x + ((kB.x - kA.x) * i) / 5, kA.y + ((kB.y - kA.y) * i) / 5, 1)
    await sleep(70)
    kSeq.push(JSON.parse(await ev(INK)))
  }
  await mouse('mouseReleased', kB.x, kB.y, 0)
  const kFour = [JSON.parse(await ev(INK))]
  await sleep(16)
  kFour.push(JSON.parse(await ev(INK)))
  await sleep(34)
  kFour.push(JSON.parse(await ev(INK)))
  await sleep(120)
  kFour.push(JSON.parse(await ev(INK)))
  const kSig = [...new Set(kFour.map((s) => s.from + '-' + s.to))]
  const kCross = await ev(
    `JSON.stringify((() => { const s = window.__L.ed().state.selection; return { text: window.__L.ed().state.doc.textBetween(s.from, s.to, '|') } })())`
  )
  const kCrossObj = JSON.parse(kCross)
  console.log(
    'K1 逐拍=' + JSON.stringify(kSeq.map((s) => s.from + '-' + s.to)) +
      ' 四时点=' + JSON.stringify(kSig) +
      ' 跨格文本=' + JSON.stringify(kCrossObj.text.slice(0, 40)) +
      ' 按下显形数=' + kRevealed.revealed
  )
  report.check(
    'K1 第四十一轮：表格跨单元格时，折叠重算不得丢选区（mouseup/+1帧/+50ms/+170ms 四时点 from/to 逐字一致，且选区确实跨格）',
    kSig.length === 1 && kCrossObj.text.includes('|') && kRevealed.revealed >= 2,
    JSON.stringify({ four: kSig, cross: kCrossObj.text.slice(0, 40), revealedAtPress: kRevealed.revealed, seq: kSeq.map((s) => s.from + '-' + s.to) })
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
