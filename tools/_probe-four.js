'use strict'
// 临时诊断：① 查找命中处是否露出 `**`；③ 选区末端是否包含收尾标记；④ 行尾点击落点
const { connect, settle, waitEditor, sleep, openDocWith } = require('./lib/harness')

const MD = ['**派出所和诊室不是两个地方，是同一个地方的两层。** 全片', '', '**诊室（底层空间）**'].join(
  '\n'
)

const DUMP = `(() => {
  const ed = window.__L.ed()
  const s = ed.state
  let info = null
  s.doc.descendants((n, pos) => {
    if (!n.isTextblock || info) return true
    const txt = n.textContent
    if (!txt.includes('派出所') && !txt.includes('诊室')) return true
    const kids = []
    n.forEach((c, off) => kids.push({ t: c.isText ? c.text : '[' + c.type.name + ']', off,
      marks: c.marks.map((m) => m.type.name + ':' + JSON.stringify(m.attrs)) }))
    info = { blockFrom: pos, blockTo: pos + n.nodeSize, txt, kids }
    return false
  })
  const sel = s.selection
  return JSON.stringify({
    info,
    sel: { from: sel.from, to: sel.to, empty: sel.empty,
      text: s.doc.textBetween(sel.from, sel.to, '|') },
    reveal: [...document.querySelectorAll('.md-reveal-inline')].map((el) => ({
      cls: el.className, text: el.textContent, w: Math.round(el.getBoundingClientRect().width * 100) / 100,
      fs: getComputedStyle(el).fontSize }))
  })
})()`

async function clickAt(app, x, y) {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0, clickCount: 0 })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1 })
  await sleep(320)
}

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) return console.log('not ready')
  const { ev, send } = app
  await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await openDocWith(app, MD, 'four-issues.md')
  await waitEditor(ev)
  await sleep(1200)

  console.log('P0 ' + (await ev(DUMP)))

  // ① 查找「派出所」：命中后标记是否露出
  await ev(`(() => { const f = window.__L.store('find'); f.show(false); f.setQuery('派出所'); return 'ok' })()`)
  await sleep(700)
  console.log('P1-find ' + (await ev(DUMP)))

  // ③ 选中「**…两层。** 全片」整段（模拟用户拖选到末尾）：先看终点在标记之后的情形
  const geo = await ev(`(() => {
    const ps = [...document.querySelectorAll('.ProseMirror p')]
    const out = []
    for (const p of ps) {
      const r = p.getBoundingClientRect()
      // 每个字符的矩形（用 Range 逐字取），找出 「」和「」两端
      const tn = [...p.childNodes].filter((n) => n.nodeType === 3 || n.nodeType === 1)
      out.push({ text: p.textContent, rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width) },
        nodes: tn.map((n) => ({ type: n.nodeType, text: n.textContent, cls: n.className || '' })) })
    }
    return JSON.stringify(out)
  })()`)
  console.log('GEO ' + geo)

  // ④ 在第二段末尾（「**」之后）点击
  const clickPt = await ev(`(() => {
    const ps = [...document.querySelectorAll('.ProseMirror p')]
    const p = ps.find((x) => x.textContent.includes('诊室（底层空间）'))
    if (!p) return JSON.stringify({ err: 'no-p' })
    const r = p.getBoundingClientRect()
    const rng = document.createRange()
    rng.selectNodeContents(p)
    const rects = [...rng.getClientRects()]
    const last = rects[rects.length - 1]
    return JSON.stringify({ x: Math.round(last.right + 6), y: Math.round(r.top + r.height / 2),
      lastRight: Math.round(last.right), rowLeft: Math.round(r.left), rowRight: Math.round(r.right) })
  })()`).then(JSON.parse)
  console.log('CLICKPT ' + JSON.stringify(clickPt))
  if (!clickPt.err) {
    await clickAt(app, clickPt.x, clickPt.y)
    console.log('P4-after-click-right-of-line ' + (await ev(DUMP)))
    // 再点在文字内部（“）”）之后紧贴处
    await clickAt(app, clickPt.lastRight - 2, clickPt.y)
    console.log('P4b-click-near-end ' + (await ev(DUMP)))
  }

  app.close()
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
