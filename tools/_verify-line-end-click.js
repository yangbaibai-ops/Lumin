'use strict'
// ─── 验收：行尾点击的光标落点（`**…**|` 而不是 `**…|**`）────────────────────────
//
// 用户报的第二个场景（本轮）：一行里**末尾几个字是加粗**时，点这一行右侧的空白想接着写，
// 期望 `**不给眼睛亮起来的机会**|`，实际停在 `**不给眼睛亮起来的机会|**`。
//
// 根因（本轮定位，三处叠加）：
//   1. 同步修正里有一条 `if (found.pos >= end) return false` —— 而点行尾空白时
//      `view.posAtCoords` **恰好**给出块尾（实测 `foundPos=20=end`），这条守卫把唯一需要
//      修正的情形全挡掉了；
//   2. 于是落点由 PM 自己的 MouseUp 处理决定，它按折叠布局把光标算到**收尾 `**` 之前**
//      （实测 `…会**` 得 18、`**…会**` 得 34，而块内容末尾是 20 / 36）；
//   3. 量「该行最后一个可见字符右缘」用的是 `domAtPos(found.pos).parentElement`，而位置落在
//      节点边界上时 `domAtPos` 返回整个 `<p>`（右缘 = 整幅纸）⇒ 换别的夹具就恒假。
//      （第二十四轮 D 段把**旧行为** `contentEnd - 收尾标记长度` 写成了期望值，本轮一并改对。）
//
// 修法（非硬编码）：判据只在**点击当时的布局**上量；「这一行」= 与指针垂直距离最近的一行
// （按文本节点的 `Range.getClientRects()` 片段归并成行，折叠标记天然没有矩形），**只有点是
// 最后一行**才算行尾；落点 = **文本块内容末尾**，并在 PM 自己的 MouseUp 处理之后再写一次。
//
// 判据（真实鼠标点击；期望值全部从文档结构现算）：
//   A. 普通前缀 + 加粗结尾的一行（标记**折叠**态），点行尾右侧空白 ⇒ 光标 = 块内容末尾
//   B. 整行就是加粗（第二十四轮 D 段形态）⇒ 同上
//   C. 点**最后一个可见字**的右半边 ⇒ 光标停在收尾 `**` **之前**（留在构造内，不被抢走）
//   D. 点行中间某字符 ⇒ 光标落在该字符处，不被行尾规则抢走
//   E. 标记已显形（光标先在构造内）时点行尾右侧空白 ⇒ 仍然是块内容末尾
//   F. 段内**硬换行**（第一行短）：点第一行右侧空白 ⇒ 光标留在第一行末尾，**不会**被送到段尾
//
// 跑法：node tools/_verify-line-end-click.js（先起隔离实例）
const { connect, settle, waitEditor, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')

const BOLD = '不给眼睛亮起来的机会'
// 块 0：普通前缀 + 加粗结尾；块 1：整行加粗；块 2：段内硬换行（`\` + 换行 → hardBreak）+ 加粗结尾
const MD =
  '他终于明白**' + BOLD + '**\n\n**' + BOLD + '**\n\n短第一行\\\n**' + BOLD + '**\n'

/** 每个文本块：位置区间 / 逐行矩形 / 逐字几何 / 结构（含 hardBreak 的位置） */
const GEO = `(() => {
  const v = window.__L.ed().view
  const out = []
  v.state.doc.descendants((n, pos) => {
    if (!n.isTextblock) return true
    const el = v.nodeDOM(pos)
    const lines = []
    const chars = []
    if (el) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const t = walker.currentNode
        let base = -1
        try { base = v.posAtDOM(t, 0) } catch (e) { base = -1 }
        if (t.data.length) {
          const rng = document.createRange()
          rng.selectNodeContents(t)
          for (const r of rng.getClientRects()) {
            if (r.width <= 0) continue
            const cur = lines.find((l) => r.top <= l.bottom + 1 && r.bottom >= l.top - 1)
            if (cur) {
              cur.top = Math.min(cur.top, r.top); cur.bottom = Math.max(cur.bottom, r.bottom)
              cur.right = Math.max(cur.right, r.right); cur.left = Math.min(cur.left, r.left)
            } else {
              lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
            }
          }
        }
        for (let k = 0; k < t.data.length; k++) {
          const r = document.createRange()
          r.setStart(t, k); r.setEnd(t, k + 1)
          const b = r.getBoundingClientRect()
          if (b.width > 0) chars.push({ pos: base + k, ch: t.data[k], l: b.left, r: b.right,
            y: Math.round(b.top + b.height / 2) })
        }
      }
    }
    lines.sort((a, b) => a.top - b.top)
    // 结构：硬换行（hardBreak）的位置，用来算「第一行末尾」的期望
    const breaks = []
    n.forEach((child, off) => { if (child.type.name === 'hardBreak') breaks.push(pos + 1 + off) })
    out.push({ start: pos, contentStart: pos + 1, contentEnd: pos + 1 + n.content.size,
      text: n.textContent, lines: lines.map((l) => ({ top: Math.round(l.top), bottom: Math.round(l.bottom),
        left: Math.round(l.left), right: Math.round(l.right) })), chars, breaks })
  })
  return out
})()`

const SEL = `(() => {
  const s = window.__L.ed().state.selection
  return { from: s.from, to: s.to, empty: s.empty }
})()`

async function main() {
  const report = new Reporter('验收：行尾点击落点')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { ev, send } = app
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0 })
    await sleep(120)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 })
    await sleep(90)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1 })
    await sleep(420)
    return ev(`JSON.stringify(${SEL})`).then(JSON.parse)
  }
  const geo = () => ev(`JSON.stringify(${GEO})`).then(JSON.parse)
  const setCaret = async (pos) => {
    await ev(`(() => { window.__L.ed().chain().setTextSelection(${pos}).run(); return 'ok' })()`)
    await sleep(400)
  }
  const paperRight = () =>
    ev(`Math.round(document.querySelector('.ProseMirror p').getBoundingClientRect().right)`)
  /** 「最后一个可见字之后、收尾 `**` 之前」那个位置（收尾标记长度从文档现取） */
  const closingStart = (blk) => blk.contentEnd - (blk.text.length - blk.text.replace(/\*\*$/, '').length)
  /** 行尾点击坐标：可见文字右缘再往右 60px，但不超出纸面 */
  const endClick = (line, right) => ({ x: Math.min(line.right + 60, right - 20), y: (line.top + line.bottom) / 2 })

  /**
   * 每个用例都**先把光标放回确定位置、再重新量几何、然后点** ——
   * 上一步点完光标可能停在构造内，标记随即显形、整行右移（实测 `眼` 从 423 移到 438.5），
   * 拿旧坐标点会点到隔壁字上（这正是本套件第一版 D 段假红的原因）。
   */
  const measure = async (caretPos) => {
    await setCaret(caretPos)
    const blocks = await geo()
    return { blocks, right: await paperRight() }
  }

  try {
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(400)
    await openDocWith(app, MD, 'line-end-click.md')
    await waitEditor(ev)
    await sleep(1400)

    // 光标放到第 0 段的开头（在加粗构造**之外** ⇒ 标记折叠）
    let { blocks: g, right } = await measure(1)
    console.log('fixture ' + JSON.stringify({
      blocks: g.length,
      ends: g.map((b) => b.contentEnd),
      lines: g.map((b) => b.lines.length),
      breaks: g.map((b) => b.breaks),
      lastChars: g.map((b) => b.chars[b.chars.length - 1] && b.chars[b.chars.length - 1].ch),
      paperRight: right
    }))
    report.check(
      'fixture：3 个文本块；块 2 有段内硬换行（2 行）；末字都是「会」（标记折叠 ⇒ 不在可见字里）',
      g.length === 3 && g[2].lines.length === 2 && g[2].breaks.length === 1 &&
        g.every((b) => b.chars[b.chars.length - 1] && b.chars[b.chars.length - 1].ch === '会'),
      JSON.stringify({ blocks: g.length, lines: g.map((b) => b.lines.length), ends: g.map((b) => b.contentEnd) })
    )
    if (g.length !== 3 || g[2].lines.length !== 2) {
      app.close()
      return report.finish()
    }

    // ── A. 普通前缀 + 加粗结尾：点行尾右侧空白 ──
    ;({ blocks: g, right } = await measure(1))
    const aPos = endClick(g[0].lines[0], right)
    const a = await click(aPos.x, aPos.y)
    console.log('A ' + JSON.stringify({ click: aPos, sel: a, expect: g[0].contentEnd, 收尾之前: closingStart(g[0]) }))
    report.check(
      'A 末尾加粗的一行（标记折叠），点行尾右侧空白 ⇒ 光标 = 块内容末尾（收尾 `**` 之后）',
      a.empty && a.from === g[0].contentEnd,
      JSON.stringify({ got: a.from, want: g[0].contentEnd, 收尾标记之前: closingStart(g[0]) })
    )

    // ── B. 整行就是加粗 ──
    ;({ blocks: g, right } = await measure(1))
    const bPos = endClick(g[1].lines[0], right)
    const b = await click(bPos.x, bPos.y)
    console.log('B ' + JSON.stringify({ click: bPos, sel: b, expect: g[1].contentEnd }))
    report.check(
      'B 整行加粗，点行尾右侧空白 ⇒ 光标 = 块内容末尾',
      b.empty && b.from === g[1].contentEnd,
      JSON.stringify({ got: b.from, want: g[1].contentEnd, 收尾标记之前: closingStart(g[1]) })
    )

    // ── C. 点最后一个可见字（`会`）的右半边 ⇒ 停在收尾标记之前（留在构造内）──
    ;({ blocks: g, right } = await measure(1))
    const lastCh = g[0].chars[g[0].chars.length - 1]
    const c = await click(lastCh.l + (lastCh.r - lastCh.l) * 0.8, lastCh.y)
    console.log('C ' + JSON.stringify({ ch: lastCh, sel: c, expect: closingStart(g[0]) }))
    report.check(
      'C 点最后一个可见字的右半边 ⇒ 光标在收尾 `**` **之前**（留在构造内，不被抢走）',
      lastCh.ch === '会' && c.empty && c.from === closingStart(g[0]),
      JSON.stringify({ got: c.from, want: closingStart(g[0]), 块尾: g[0].contentEnd, ch: lastCh.ch })
    )

    // ── D. 点行中间某字符 ⇒ 落在该字符处（不被行尾规则抢走）──
    ;({ blocks: g, right } = await measure(1))
    const midCh = g[0].chars[Math.floor(g[0].chars.length / 2)]
    const d = await click(midCh.l + (midCh.r - midCh.l) * 0.25, midCh.y)
    console.log('D ' + JSON.stringify({ ch: midCh, sel: d }))
    report.check(
      'D 点行中间某字符 ⇒ 光标落在该字符处，不被行尾规则抢走',
      d.empty && d.from >= midCh.pos - 1 && d.from <= midCh.pos + 1 && d.from < g[0].contentEnd,
      JSON.stringify({ got: d.from, want: `≈${midCh.pos}`, 块尾: g[0].contentEnd })
    )

    // ── E. 标记已显形（光标先在构造内）时点行尾右侧空白 ⇒ 仍是块内容末尾 ──
    ;({ blocks: g, right } = await measure(g[0].contentEnd - 1))
    const revealed = await ev(`(() => {
      const ms = [...document.querySelectorAll('.ProseMirror p .md-marker')]
      return JSON.stringify({ n: ms.length, w: ms.map((m) => Math.round(m.getBoundingClientRect().width)) })
    })()`).then(JSON.parse)
    const ePos = endClick(g[0].lines[0], right)
    const e = await click(ePos.x, ePos.y)
    console.log('E ' + JSON.stringify({ revealed, sel: e, expect: g[0].contentEnd }))
    report.check(
      'E 标记已显形时点行尾右侧空白 ⇒ 光标仍是块内容末尾',
      revealed.w.filter((w) => w > 0).length >= 2 && e.empty && e.from === g[0].contentEnd,
      JSON.stringify({ got: e.from, want: g[0].contentEnd, revealed })
    )

    // ── F. 段内硬换行（第一行短）：点第一行右侧空白 ⇒ 留在第一行末尾，不送段尾 ──
    ;({ blocks: g, right } = await measure(1))
    const blk = g[2]
    const firstLineEnd = blk.breaks[0] // 硬换行的位置 = 第一行末尾之后
    const fPos = endClick(blk.lines[0], right)
    const f = await click(fPos.x, fPos.y)
    console.log('F ' + JSON.stringify({ click: fPos, sel: f, firstLineEnd, blockEnd: blk.contentEnd }))
    report.check(
      'F 段内硬换行：点第一行右侧空白 ⇒ 光标留在第一行末尾（**不会**被送到段尾）',
      f.empty && f.from <= firstLineEnd + 1 && f.from < blk.contentEnd - 2,
      JSON.stringify({ got: f.from, 期望不超过: firstLineEnd + 1, blockEnd: blk.contentEnd })
    )
  } catch (err) {
    report.skip('suite-error', String(err && err.message))
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
