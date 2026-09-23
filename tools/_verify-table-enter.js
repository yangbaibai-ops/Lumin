// 验收：表格单元格里按回车不会毁掉表格（数据保真回归）
//
// 用户报障：分屏下在表格单元格「**实测痛点**」后面按一下回车，源码与渲染面同时变成
// `<table style="min-width: 50px;">…` 一整段 HTML —— 这段 HTML 一旦落盘，再打开时 markdown-it
// 只把它当 HTML 块解析，**表格结构就此损坏**。根因两处（本轮都修了）：
//   1. 回车在单元格里切出了第二个（空的）段落 ⇒ 表格序列化器判「复杂表格」⇒ 退回 HTML；
//   2. 序列化器把「一格多块」一律当复杂表格，连**空**段落都不容忍。
//
// 所以本套件守三件事：
//   * 回车**不改动任何内容**（只把光标挪到下一格）⇒ 序列化前后源码逐字节一致；
//   * 历史上已经写成「一格两段」的文档、以及外来的粘贴内容，也仍然写回管道表；
//   * 真正表达不了的（合并单元格）**照旧**退回 HTML —— 这条是刻意钉住的行为，别被"顺手修好"。
//
// 已用 harness（改到谁迁谁，见 tools/README.md）。
'use strict'
const { connect, settle, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')

const MD = [
  '| **项** | **内容** |',
  '| :--- | :--- |',
  '| **实测痛点** | 36,005 字符 / 500 个围栏 → **打开 22.8s** |',
  '| **根因** | `CodeBlockView.vue` 是每个代码块一个 Vue NodeView |',
  ''
].join('\n')

const CONTENT = `window.__L.files().current.content`

/** 把光标放到第一个含 needle 的文本末尾并聚焦 */
const careAfter = (needle) => `(() => {
  const ed = window.__L.ed()
  let target = null
  ed.state.doc.descendants((n, pos) => {
    if (n.isText && n.text.includes(${JSON.stringify(needle)})) target = pos + n.text.length
    return true
  })
  if (target === null) return 'no-text'
  ed.chain().focus().setTextSelection(target).run()
  const pm = document.querySelector('.ProseMirror')
  if (pm && document.activeElement !== pm) pm.focus()
  return 'ok'
})()`

/** 当前形状：光标所在段文字 / 「实测痛点」格的块数 / 表格行数 */
const SHAPE = `(() => {
  const ed = window.__L.ed()
  let blocks = 0
  let rows = 0
  ed.state.doc.descendants((n) => {
    if (n.type.name === 'tableCell' && n.textContent.includes('实测痛点')) blocks = n.childCount
    if (n.type.name === 'table') rows = n.childCount
    return true
  })
  const $from = ed.state.selection.$from
  return JSON.stringify({ blocks, rows, sel: $from.parent.textContent.slice(0, 12) })
})()`

async function pressEnter(app) {
  await app.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await sleep(500)
}

/**
 * 按回车直到 `done(shape)` 成立（最多 3 次）。
 *
 * ⚠️ 为什么要重试：CDP 注入的按键**偶发不到达**（批量连跑时实测约每 4 次里有 1 次），
 * 表现是「回车完全没生效」。重试对它有效，而真回归会三次全部失败 —— 不会把红洗成绿。
 * 用了几次会记进 note，不藏。
 */
async function pressEnterUntil(app, ev, done, tries = 3) {
  let shape = JSON.parse(await ev(SHAPE))
  for (let i = 0; i < tries && !done(shape); i++) {
    await pressEnter(app)
    shape = JSON.parse(await ev(SHAPE))
    if (done(shape)) return { shape, tries: i + 1 }
  }
  return { shape, tries: 0 }
}

/** 构造一张表（可选：第一行第一格带 colspan=2），灌进编辑器 */
const buildTable = (colspan) => `(() => {
  const ed = window.__L.ed()
  const s = ed.schema
  const p = (t) => s.nodes.paragraph.create(null, t ? s.text(t) : null)
  const cell = s.nodes.tableCell
  const head = s.nodes.tableHeader
  const row = (cells) => s.nodes.tableRow.create(null, cells)
  const firstRowCells = ${colspan}
    ? [head.create({ colspan: 2 }, p('合并表头')), head.create(null, p('B'))]
    : [head.create(null, p('A')), head.create(null, p('B'))]
  const table = s.nodes.table.create(null, [
    row(firstRowCells),
    row([cell.create(null, [p('一格'), p()]), cell.create(null, p('两段'))]),
    row([cell.create(null, p('x')), cell.create(null, p('y'))])
  ])
  ed.commands.setContent({ type: 'doc', content: [table.toJSON(), s.nodes.paragraph.create().toJSON()] })
  return 'ok'
})()`

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('表格单元格回车：不切段落 / 不动源码 / 重载仍是表格')

  // 前序套件可能把现场留在别的模式、甚至留下一条待恢复的草稿（草稿弹窗会拦掉所有按键、
  // 并把编辑器设成不可编辑 —— 那是它的职责）。本套件只验表格，先把现场收拾干净。
  // ⚠️ 这条是实测教训：单独跑 9/9，跟在 _regress-layout 后面跑时回车完全没生效。
  await ev(`(() => {
    const f = window.__L.files()
    if (f.draftRestore) f.draftRestore = null
    window.__L.ui().editorMode = 'wysiwyg'
    return 'ok'
  })()`)
  await sleep(700)
  report.note(
    '起始状态 ' +
      (await ev(`(() => JSON.stringify({
        mode: window.__L.ui().editorMode,
        draftModal: !!document.querySelector('.draft-modal'),
        editable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable') ?? null,
        active: document.activeElement ? document.activeElement.className.slice(0, 24) : null
      }))()`))
  )

  await openDocWith(app, MD, 'table-enter.md')
  await sleep(900)

  const before = String(await ev(CONTENT))
  report.check(
    'fixture-is-pipe-table',
    before.startsWith('| **项** | **内容** |') && before.includes('| :--- | :--- |'),
    JSON.stringify(before.split('\n')[0])
  )

  // ① 在「实测痛点」后面回车：光标跳到下一格，**内容一个字都不许变**
  await ev(careAfter('实测痛点'))
  await sleep(200)
  const r1 = await pressEnterUntil(app, ev, (s) => !s.sel.includes('实测痛点'))
  if (r1.tries > 1) report.note(`① 回车重试 ${r1.tries} 次才生效（键注入偶发丢失）`)
  const after = String(await ev(CONTENT))
  const cellShape = r1.shape
  report.note('回车后 ' + JSON.stringify(cellShape))
  report.check('enter-keeps-single-paragraph', cellShape.blocks === 1, JSON.stringify(cellShape))
  report.check('enter-moves-caret-out', !cellShape.sel.includes('实测痛点'), JSON.stringify(cellShape))
  report.check(
    'enter-does-not-touch-markdown',
    after === before,
    `before=${JSON.stringify(before.split('\n')[2])} after=${JSON.stringify(after.split('\n')[2])}`
  )
  report.check('no-html-fallback', !after.includes('<table'), '含 <table> = ' + after.includes('<table'))

  // ② 最后一格回车：补一行（与 Tab 同语义），仍然不许退化成 HTML
  await ev(`(() => {
    const ed = window.__L.ed()
    let last = null
    ed.state.doc.descendants((n, pos) => { if (n.type.name === 'tableCell') last = pos; return true })
    if (last === null) return 'no-cell'
    ed.chain().focus().setTextSelection(last + 1).run()
    const pm = document.querySelector('.ProseMirror')
    if (pm && document.activeElement !== pm) pm.focus()
    return 'ok'
  })()`)
  await sleep(200)
  const rowsBefore = JSON.parse(await ev(SHAPE)).rows
  const r2 = await pressEnterUntil(app, ev, (s) => s.rows > rowsBefore)
  if (r2.tries > 1) report.note(`② 回车重试 ${r2.tries} 次才生效（键注入偶发丢失）`)
  const grown = String(await ev(CONTENT))
  const rows = { rows: r2.shape.rows }
  report.note('末格回车后 ' + JSON.stringify(rows) + ' 末行=' + JSON.stringify(grown.trim().split('\n').pop()))
  report.check('enter-at-last-cell-adds-row', rows.rows > rowsBefore, JSON.stringify({ rowsBefore, ...rows }))
  report.check('grown-table-still-pipe', !grown.includes('<table'), '含 <table> = ' + grown.includes('<table'))

  // ③ 历史上已经写成「一格两段」的文档：仍然写回管道表（这是用户现场已经产生的坏文档）
  await ev(buildTable(false))
  await sleep(900)
  const legacy = String(await ev(CONTENT))
  report.note('一格两段 → ' + JSON.stringify(legacy.split('\n').slice(2, 4).join(' / ')))
  report.check(
    'legacy-multi-block-cell-stays-pipe',
    legacy.includes('| 一格 | 两段 |') && !legacy.includes('<table'),
    JSON.stringify(legacy.split('\n')[2])
  )

  // ④ 真表达不了的（合并单元格）**照旧**退回 HTML —— 刻意钉住，别被顺手改成坏管道表
  await ev(buildTable(true))
  await sleep(900)
  const merged = String(await ev(CONTENT))
  report.check(
    'colspan-still-falls-back-to-html',
    merged.includes('<table') && merged.includes('colspan'),
    JSON.stringify(merged.slice(0, 90))
  )

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
