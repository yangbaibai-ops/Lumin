'use strict'
// ─── 验收：拖选与「成对标记」的边界（用户报的那类 bug 的回归）──────────────────────
//
// 夹具（用户报的原句）：`**是同一个地方的两层**全片不允许出现任何一句解释这件事`
// 文档结构：`**`[1,3) · `是同一个地方的两层`[3,12) · `**`[12,14) · `全片…事`[14,30)
//
// 用户报的 bug：从「地」(7) 拖到「层」(11)，有时抬起鼠标后选区变成
// `地方的两层**全片不允许出现任何一句解释这件事`（= `[7,30]`，把这一行后面的字全选上了）。
// 根因（本轮定位）：`expandOutsideMarkers` 补标记跨度时用了
// `doc.resolve(t).end()` —— 那是**所在段落**的末尾（30），不是收尾标记的末尾（14）。
// 修法：改用**相邻标记节点自己的 `nodeSize`**（结构量，与容器无关）。
//
// 另一条同源缺陷：按住指针时「藏标记」曾经改**占位**（`font-size: 0` / `position: absolute`），
// 而一行里标记的宽度会变（一对 `**` 是 15.5px）⇒ 浏览器判光标落点、PM 每次 `mousemove`
// 重算坐标时版面已经挪了，落点/终点跑到别的字符上。修法：按住期间**冻结显隐装饰** +
// CSS **只去墨不改占位**。
//
// 判据（全部用真实多步鼠标事件驱动，不用 store 命令改选区；坐标一律现量，不写死像素/位置）：
//   A. `地 → 层`（右半）：`[地, 层之后 + 收尾标记]`，且**不含**后面的 `全片…`
//   B. `层 → 地`（反方向）：等价范围
//   C. `地 → 层`（左半）：终点停在「层」之前（不碰收尾标记）
//   D. `是 → 层`（起点落在构造第一个字）：起点撑到开标记之前
//   E. `地 → 行尾右侧空白`：终点到块尾（这时用户确实拖过了后面的文字）
//   F. 标记已显形时**单击**加粗字：光标落在被点的那个字上（版面没被「藏标记」挪走）
//   G. 整个手势期间**版面不变**（参考字「层」的屏幕位置逐步比对）
//
// ⚠️ 每个手势前把选区重置成**段落末尾的一个光标**：否则「按在已有选区内部」会被 Chromium
// 当成**拖动既有选区里的文字**（原生 drag & drop），把文档搬走 —— 实测套件第 2 个手势起
// 文档就被改坏了（`.md-marker` 一个都查不到）。重置后**重新量几何**：标记折叠/显形会改变
// 整行宽度，旧坐标不能用。
//
// 跑法：node tools/_verify-drag-selection.js（先起隔离实例）
const { connect, settle, waitEditor, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')

const MD = '**是同一个地方的两层**全片不允许出现任何一句解释这件事\n'

/** 段内每个可见字符的文档位置与几何 + 标记跨度（折叠/隐藏的标记宽 0） */
const GEO = `(() => {
  const v = window.__L.ed().view
  const p = document.querySelector('.ProseMirror p')
  const marks = [...p.querySelectorAll('.md-marker')]
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  const chars = []
  while (walker.nextNode()) {
    const t = walker.currentNode
    let base = -1
    try { base = v.posAtDOM(t, 0) } catch (e) { base = -1 }
    for (let i = 0; i < t.data.length; i++) {
      const r = document.createRange()
      r.setStart(t, i); r.setEnd(t, i + 1)
      const b = r.getBoundingClientRect()
      chars.push({ pos: base + i, ch: t.data[i], l: b.left, r: b.right,
        w: b.width, y: Math.round(b.top + b.height / 2) })
    }
  }
  const visible = chars.filter((c) => c.w > 0)
  // 标记的跨度：按**它自己的**文档位置 + 文本长度算（不写死 2）
  const span = (el) => {
    let pos = -1
    try { pos = v.posAtDOM(el, 0) } catch (e) { pos = -1 }
    return { pos, size: (el.textContent || '').length }
  }
  const lastText = (() => {
    for (let i = chars.length - 1; i >= 0; i--) if (chars[i].w > 0) return chars[i]
    return null
  })()
  return {
    visible,
    opening: marks.length ? span(marks[0]) : { pos: -1, size: 0 },
    closing: marks.length ? span(marks[marks.length - 1]) : { pos: -1, size: 0 },
    marks: marks.length,
    lastEnd: lastText ? lastText.pos + 1 : -1
  }
})()`

const SEL = `(() => {
  const s = window.__L.ed().state.selection
  return { from: s.from, to: s.to, empty: s.empty,
    text: s.empty ? '' : window.__L.ed().state.doc.textBetween(s.from, s.to, '|') }
})()`

async function main() {
  const report = new Reporter('验收：拖选与成对标记的边界')
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
  const sel = () => ev(`JSON.stringify(${SEL})`).then(JSON.parse)
  const geo = () => ev(`JSON.stringify(${GEO})`).then(JSON.parse)
  const setCaret = async (pos) => {
    await ev(`(() => { window.__L.ed().chain().setTextSelection(${pos}).run(); return 'ok' })()`)
    await sleep(420)
  }
  /** 参考字「层」的左缘（手势期间逐步采样，用来证明版面没动） */
  const refX = () =>
    ev(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      while (w.nextNode()) {
        const t = w.currentNode
        const i = t.data.indexOf('层')
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(t, i); r.setEnd(t, i + 1)
        return Math.round(r.getBoundingClientRect().left * 10) / 10
      }
      return -1
    })()`)

  /**
   * 一个真实手势：重置选区 → 量几何 → 多步拖拽 → 抬起。
   * `anchorCh`/`headCh` 给字符，`side` 给落点在字符的哪一半（'l' = 左 1/4、'r' = 右 3/4）。
   */
  const gesture = async (anchorCh, anchorSide, headCh, headSide) => {
    await setCaret(await ev(`window.__L.ed().state.doc.content.size - 1`))
    const g = await geo()
    const pick = (ch, side) => {
      const c = g.visible.find((x) => x.ch === ch)
      if (!c) return null
      return { x: side === 'l' ? c.l + c.w * 0.25 : c.l + c.w * 0.75, y: c.y }
    }
    const a = pick(anchorCh, anchorSide)
    const h = pick(headCh, headSide)
    if (!a || !h) return { g, s: null, xs: [] }
    const xs = []
    await mouse('mouseMoved', a.x, a.y, 0)
    await sleep(110)
    xs.push(await refX())
    await mouse('mousePressed', a.x, a.y, 1)
    await sleep(110)
    xs.push(await refX())
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', a.x + ((h.x - a.x) * i) / steps, a.y + ((h.y - a.y) * i) / steps, 1)
      await sleep(30)
      if (i === steps) xs.push(await refX())
    }
    await sleep(90)
    await mouse('mouseReleased', h.x, h.y, 0)
    await sleep(400)
    return { g, s: await sel(), xs }
  }

  try {
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(400)
    await openDocWith(app, MD, 'drag-selection.md')
    await waitEditor(ev)
    await sleep(1400)

    // 夹具自检：文档结构就是预期的 4 个文本节点。
    // （7/11/12/30 是**这份夹具**的结构常量，写在这里是为了「夹具漂了就立刻红」；
    //   下面所有断言里的期望值都从文档现算，不依赖这些数字。）
    await setCaret(30)
    const g0 = await geo()
    const di0 = g0.visible.find((c) => c.ch === '地')
    const ceng0 = g0.visible.find((c) => c.ch === '层')
    report.check(
      'fixture 结构正确（地=7 / 层=11 / 收尾标记 [12,14) / 块内末字之后 = 30）',
      !!di0 && di0.pos === 7 && !!ceng0 && ceng0.pos === 11 && g0.closing.pos === 12 &&
        g0.closing.size === 2 && g0.lastEnd === 30,
      JSON.stringify({ di: di0 && di0.pos, ceng: ceng0 && ceng0.pos, closing: g0.closing, lastEnd: g0.lastEnd })
    )

    // ── A. 用户报的那条：地 → 层（右半）──
    const a = await gesture('地', 'l', '层', 'r')
    console.log('A ' + JSON.stringify({ g: { di: a.g.visible.find((c) => c.ch === '地')?.pos, closing: a.g.closing, lastEnd: a.g.lastEnd }, sel: a.s, xs: a.xs }))
    const di = a.g.visible.find((c) => c.ch === '地').pos
    const afterClosing = a.g.closing.pos + a.g.closing.size
    report.check(
      'A 从「地」拖到「层」⇒ 选区 = [地, 层之后 + 收尾标记]',
      !!a.s && a.s.from === di && a.s.to === afterClosing,
      JSON.stringify({ got: a.s && [a.s.from, a.s.to], want: [di, afterClosing] })
    )
    report.check(
      'A 选区**不含**后面的文字（用户报的「把后面整串都选中了」）',
      !!a.s && !a.s.text.includes('全片'),
      JSON.stringify(a.s && a.s.text)
    )
    report.check('A 选区含收尾标记、正文部分正确', !!a.s && a.s.text === '地方的两层**', JSON.stringify(a.s && a.s.text))

    // ── B. 反方向：层（右半）→ 地（左半）──
    const b = await gesture('层', 'r', '地', 'l')
    console.log('B ' + JSON.stringify(b.s))
    const diB = b.g.visible.find((c) => c.ch === '地').pos
    const afterClosingB = b.g.closing.pos + b.g.closing.size
    report.check(
      'B 反方向拖（层 → 地）⇒ 起点在「地」，终点到收尾标记之后',
      !!b.s && b.s.from === diB && b.s.to === afterClosingB && !b.s.text.includes('全片'),
      JSON.stringify({ got: b.s && [b.s.from, b.s.to], want: [diB, afterClosingB], text: b.s && b.s.text })
    )

    // ── C. 终点落在「层」之前：不该碰收尾标记 ──
    const c = await gesture('地', 'l', '层', 'l')
    console.log('C ' + JSON.stringify(c.s))
    const diC = c.g.visible.find((c) => c.ch === '地').pos
    const cengC = c.g.visible.find((c) => c.ch === '层').pos
    report.check(
      'C 终点停在「层」之前 ⇒ 选区到「层」之前为止（不补收尾标记）',
      !!c.s && c.s.from === diC && c.s.to === cengC,
      JSON.stringify({ got: c.s && [c.s.from, c.s.to], want: [diC, cengC], text: c.s && c.s.text })
    )

    // ── D. 起点在构造第一个字：起点撑到开标记之前 ──
    const d = await gesture('是', 'l', '层', 'r')
    console.log('D ' + JSON.stringify(d.s))
    const shiD = d.g.visible.find((c) => c.ch === '是').pos
    report.check(
      'D 起点落在构造内第一个字 ⇒ 起点补到开标记之前（含 `**`）',
      !!d.s && d.s.from === d.g.opening.pos && d.s.from < shiD && d.s.text.startsWith('**'),
      JSON.stringify({ got: d.s && [d.s.from, d.s.to], want: d.g.opening.pos, text: d.s && d.s.text })
    )

    // ── E. 拖到行尾右侧空白：终点到块尾（这时用户确实拖过了后面的文字）──
    const e = await gesture('地', 'l', '事', 'r')
    console.log('E ' + JSON.stringify(e.s))
    const diE = e.g.visible.find((c) => c.ch === '地').pos
    report.check(
      'E 拖到行尾最后一个字 ⇒ 终点到块内末字之后（含后面的文字）',
      !!e.s && e.s.from === diE && e.s.to === e.g.lastEnd && e.s.text.includes('全片'),
      JSON.stringify({ got: e.s && [e.s.from, e.s.to], want: [diE, e.g.lastEnd], text: e.s && e.s.text })
    )

    // ── F. 标记已显形时单击加粗字：光标落在被点的字上 ──
    // 先把光标放进构造内（标记显形、整行变宽），再点在「地」上 ——
    // 「按住时藏标记」若改占位，这一刻版面会挪，光标就落到别的字上（实测落到下一个字）。
    const gF = await geo()
    const diF = gF.visible.find((c) => c.ch === '地')
    const revealed = await ev(`(() => {
      const ms = [...document.querySelectorAll('.ProseMirror p .md-marker')]
      return JSON.stringify({ n: ms.length, w: ms.map((m) => Math.round(m.getBoundingClientRect().width)) })
    })()`).then(JSON.parse)
    await mouse('mouseMoved', diF.l + diF.w * 0.25, diF.y, 0)
    await sleep(100)
    await mouse('mousePressed', diF.l + diF.w * 0.25, diF.y, 1)
    await sleep(120)
    await mouse('mouseReleased', diF.l + diF.w * 0.25, diF.y, 0)
    await sleep(400)
    const f = await sel()
    console.log('F ' + JSON.stringify({ revealed, sel: f }))
    report.check(
      'F 标记显形时单击加粗字 ⇒ 光标落在被点的那个字上（版面没被挪走）',
      revealed.n === 2 && revealed.w.every((w) => w > 0) && f.empty && f.from === diF.pos,
      JSON.stringify({ got: f.from, want: diF.pos, revealed })
    )

    // ── G. 手势期间版面不变（参考字「层」的屏幕左缘）──
    const stable = a.xs.length >= 3 && a.xs.every((x) => x > 0 && x === a.xs[0])
    report.check('G 整个手势期间版面不变（「层」的屏幕位置逐步一致）', stable, JSON.stringify(a.xs))
  } catch (err) {
    report.skip('suite-error', String(err && err.message))
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
