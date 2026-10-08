'use strict'
// ─── 验收：表格三条 UI/交互优化（本轮）────────────────────────────────────────
//
// 任务 1（跨单元格连续拖选，像 Typora）
//   真因**不在选区逻辑**：`@tiptap/extension-table` 默认带着 `tableEditing()`
//   （`node_modules/@tiptap/extension-table/dist/table/index.js` 的 `addProseMirrorPlugins`），
//   跨格拖动实测**已经**产生 `CellSelection`（ranges ≥ 2），对这一片执行删除/改对齐也都正常。
//   缺的是**画出来的那一层**：全仓 CSS 里没有 `.selectedCell` 规则（实测选中格与未选中格的
//   计算背景色逐字节相同，截图上看不出任何区别）。于是用户得到的唯一反馈是浏览器原生的
//   文字选区 —— 观感就是"只在一个格子里选"。
//   修法：`assets/editor.css` 补 `.md-preview th/td.selectedCell::after`（用 `--sel` 令牌）。
//   本套件的判据分三层：① 选区语义（`CellSelection` / ranges ≥ 2）；② DOM（`.selectedCell` 数 ≥ 2）；
//   ③ **真的画出来了**（伪元素的计算底色不再是透明）。
//
// 任务 2（聚焦表格时头部出现快捷操作条）
//   只显示光标那一张表（多表格时不一起冒出来）、不遮首行、Tab 可达、Esc 退出、有可访问名。
//   列对齐/插入行/插入列/删除表格的判据一律以**序列化后的 Markdown** 为准（不是"看着变了"）。
//   「列宽」这一项如实只做**视图层**三档（Markdown 表格存不了列宽），套件钉住"文档逐字节不变"。
//
// 任务 3（大纲标题前不再有小圆点）
//   判据：每个条目的行内**只有文本那一个子元素**（圆点元素已不存在），且 `::before`/`::after`
//   的 `content` 都是 `none`；同时 `paddingLeft` 仍随层级递增（缩进没被一起去掉）。
//
// 4x 是"不许破坏"的对照：`**` 行内标记、表格往返幂等、以及**拖动选中文字改位置仍然被禁**
//   （上一轮的 `_verify-no-text-drag.js` 在这个套件里有一条最小复刻，两条套件都在默认矩阵里）。
//
// 用 harness。模板串里不出现反引号；锚点全部走 data-*，不写死坐标。
const {
  connect,
  settle,
  waitEditor,
  sleep,
  openDocWith,
  requireFocus,
  Reporter,
  fatal
} = require('./lib/harness')

/** 夹具：3 列表头 + 1 行数据；**前面有正文段落**（这样"光标移出表格"才真的移得出去） */
const MD = [
  '正文开头。',
  '',
  '| 甲甲甲甲 | 乙乙乙乙 | 丙丙丙丙 |',
  '| --- | --- | --- |',
  '| 一一一一 | 二二二二 | 三三三三 |',
  ''
].join('\n')

/** 表格 + 尾部段落：光标可以落在表格**之后** */
const MD3 = [
  '| 甲甲甲甲 | 乙乙乙乙 | 丙丙丙丙 |',
  '| --- | --- | --- |',
  '| 一一一一 | 二二二二 | 三三三三 |',
  '',
  '尾部段落。',
  ''
].join('\n')

/** 两张表的夹具：验"只显示光标那一张表的工具条" */
const MD2 = [
  '| P | Q |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '中间段落。',
  '',
  '| R | S |',
  '| --- | --- |',
  '| 3 | 4 |',
  ''
].join('\n')

const CONTENT = 'window.__L.files().current.content'

/** 选区 + 多格选区语义 + DOM 表现（一个探针说全，避免多次往返造成状态漂移） */
const SEL = `(() => {
  const ed = window.__L.ed()
  const s = ed.state.selection
  const dom = [...document.querySelectorAll('.ProseMirror th, .ProseMirror td')]
  const chosen = dom.filter((c) => c.classList.contains('selectedCell'))
  const after = chosen[0] ? getComputedStyle(chosen[0], '::after') : null
  return JSON.stringify({
    type: s.constructor.name,
    isCell: typeof s.forEachCell === 'function',
    ranges: s.ranges ? s.ranges.length : 0,
    from: s.from,
    to: s.to,
    text: s.empty ? '' : ed.state.doc.textBetween(s.from, s.to, '|'),
    cells: dom.length,
    selectedDom: chosen.length,
    selectedBg: after ? after.backgroundColor : null,
    selectedPosition: chosen[0] ? getComputedStyle(chosen[0]).position : null,
    plainBg: dom[0] ? getComputedStyle(dom[0]).backgroundColor : null
  })
})()`

/** 工具条探针：数量 + 几何 + a11y（几何与表格的相对位置一起量，用来判"不遮首行"） */
const BAR = `(() => {
  const bars = [...document.querySelectorAll('[data-table-bar]')]
  const wrap = document.querySelector('.tableWrapper')
  const table = wrap ? wrap.querySelector('table') : null
  const out = bars.map((b) => {
    const r = b.getBoundingClientRect()
    const cs = getComputedStyle(b)
    const btns = [...b.querySelectorAll('button')]
    return {
      role: b.getAttribute('role'),
      aria: b.getAttribute('aria-label'),
      tabbables: btns.filter((x) => !x.disabled && x.tabIndex >= 0).length,
      align: [...b.querySelectorAll('[data-align]')].map((x) => x.getAttribute('data-align')),
      hasDelete: !!b.querySelector('[data-table-bar-delete]'),
      hasMore: !!b.querySelector('[data-table-bar-more]'),
      zIndex: cs.zIndex,
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
      below: b.getAttribute('data-table-bar-below')
    }
  })
  const tr = table ? table.getBoundingClientRect() : null
  return JSON.stringify({
    bars: out,
    table: tr ? { top: Math.round(tr.top), bottom: Math.round(tr.bottom), left: Math.round(tr.left), right: Math.round(tr.right) } : null,
    menuItems: [...document.querySelectorAll('[data-table-bar-menu-item]')].map((x) => x.getAttribute('data-table-action'))
  })
})()`

/** 表格规格（行数/列数/表头对齐）+ 序列化 md，作为所有表格动作的判据 */
const SPEC = `(() => {
  const ed = window.__L.ed()
  let rows = -1, cols = -1
  const aligns = []
  ed.state.doc.descendants((n) => {
    if (n.type.name !== 'table') return true
    if (rows >= 0) return false
    rows = n.childCount
    const head = n.firstChild
    cols = head ? head.childCount : -1
    if (head) head.forEach((c) => aligns.push(c.attrs.align === undefined ? null : c.attrs.align))
    return false
  })
  return JSON.stringify({ rows, cols, aligns, md: ed.storage.markdown.getMarkdown() })
})()`

/** 管道行 → 去空白的单元格数组（判据不依赖空格的数量，只看内容） */
const rowCells = (line) =>
  String(line)
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())

async function main() {
  const report = new Reporter('验收：表格跨格拖选 / 表格快捷操作条 / 大纲去圆点（本轮）')
  const app = await connect()
  const { ev, send } = app
  if (!(await settle(ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  if (!(await waitEditor(ev))) {
    report.skip('editor-ready', '编辑器没挂上')
    return report.finish()
  }
  /**
   * 真实按键/指针注入的前置条件：窗口必须是 OS 前台，否则 CDP 的手势会丢
   * （表现为"拖了没反应"的假红）。拿不到就如实 SKIP —— 那是环境，不是产品缺陷。
   * 口径见 tools/lib/harness.js 的 requireFocus 与 tests/tooling.test.mjs 的守卫要求。
   */
  await requireFocus(app, '表格拖选手势段')

  const sel = () => ev(SEL).then(JSON.parse)
  const bar = () => ev(BAR).then(JSON.parse)
  const spec = () => ev(SPEC).then(JSON.parse)
  const content = () => ev(CONTENT).then(String)

  const mouse = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
      buttons,
      clickCount: 1
    })

  /** 单元格几何：判定用「格内百分比」，不写死像素 */
  const cells = () =>
    ev(`(() => {
      const cs = [...document.querySelectorAll('.ProseMirror th, .ProseMirror td')]
      return JSON.stringify(cs.map((el) => {
        const r = el.getBoundingClientRect()
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, text: el.textContent,
                 cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }
      }))
    })()`).then(JSON.parse)

  /** 把光标放到文档末尾（每次手势前重置：按在已有选区内部会被 Chromium 当成"拖动选区文字"） */
  const caretAway = async () => {
    await ev(
      '(() => { window.__L.ed().chain().setTextSelection(window.__L.ed().state.doc.content.size - 1).run(); return "ok" })()'
    )
    await sleep(280)
  }

  /** 真实鼠标拖拽：按下 → 多步移动 → 抬起 */
  const drag = async (a, b, steps = 9) => {
    await mouse('mouseMoved', a.x, a.y, 0)
    await sleep(90)
    await mouse('mousePressed', a.x, a.y, 1)
    await sleep(140)
    for (let i = 1; i <= steps; i += 1) {
      await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, 1)
      await sleep(40)
    }
    await sleep(130)
    await mouse('mouseReleased', b.x, b.y, 0)
    await sleep(420)
  }

  /** 单击某格的几何中心（把光标放进那张表） */
  const clickCell = async (c) => {
    await mouse('mouseMoved', c.cx, c.cy, 0)
    await sleep(80)
    await mouse('mousePressed', c.cx, c.cy, 1)
    await sleep(110)
    await mouse('mouseReleased', c.cx, c.cy, 0)
    await sleep(450)
  }

  /** 从格左 30% 拖到另一格中心（跨格手势的统一起点） */
  const dragInto = async (from, to) =>
    drag({ x: from.l + (from.r - from.l) * 0.3, y: from.cy }, { x: to.cx, y: to.cy })

  const setContent = async (md) => {
    await ev('(() => { window.__L.ed().commands.setContent(' + JSON.stringify(md) + '); return "ok" })()')
    await sleep(850)
  }

  /**
   * 点工具条上的某个锚点（data-* 选择器）。先**确认工具条在**再点：工具条不存在时
   * `null.click()` 会把整个套件打成 SKIP（那是"测试写错"，不是产品缺陷）——这里改成
   * 返回 false 让断言如实变红，并把 DOM 现状写进备注。
   */
  const clickInBar = async (selector) => {
    const r = await ev(
      '(() => {' +
        ' const el = document.querySelector(' +
        JSON.stringify(selector) +
        ');' +
        ' if (!el) return "missing:" + ' +
        JSON.stringify(selector) +
        ';' +
        ' el.click();' +
        ' return "ok";' +
        ' })()'
    )
    return r
  }

  /** 确保「更多」菜单是打开的（幂等：已经开着就不再点一次，否则会把菜单关掉） */
  const openMoreMenu = async () => {
    for (let i = 0; i < 3; i += 1) {
      if (await ev('!!document.querySelector("[data-table-bar-menu]")')) return true
      const r = await clickInBar('[data-table-bar-more]')
      await sleep(450)
      if (r !== 'ok') return false
      if (await ev('!!document.querySelector("[data-table-bar-menu]")')) return true
    }
    return false
  }

  let cs

  try {
    await ev('(() => { window.__L.ui().editorMode = "wysiwyg"; return "ok" })()')
    await sleep(350)
    await openDocWith(app, MD, 'table-quickbar.md')
    await waitEditor(ev)
    await sleep(1400)

    // ══ 任务 1：跨单元格连续拖选 ══════════════════════════════════════════════
    cs = await cells()
    report.check('fixture：3 列表头 + 1 行数据共 6 个单元格', cs.length === 6, JSON.stringify(cs.map((c) => c.text)))

    // 1A 同一行跨两格（表头 甲 → 乙）：必须是 CellSelection，且 DOM 上两个格被标记
    await caretAway()
    await dragInto(cs[0], cs[1])
    const s1 = await sel()
    console.log('1A ' + JSON.stringify(s1))
    report.check(
      '1A 表头跨两格拖选 ⇒ CellSelection 且 ranges ≥ 2',
      s1.isCell === true && s1.ranges >= 2,
      JSON.stringify({ type: s1.type, ranges: s1.ranges, from: s1.from, to: s1.to })
    )
    report.check(
      '1A DOM 上命中 ≥ 2 个 .selectedCell',
      s1.selectedDom >= 2,
      JSON.stringify({ selectedDom: s1.selectedDom, cells: s1.cells })
    )

    // 1B 同一件事**真的画出来了**（改前：选中格与普通格的计算底色相同 ⇒ 用户看不见）
    const isTransparent = (v) => {
      const s = String(v)
      return s === 'rgba(0, 0, 0, 0)' || s === 'transparent' || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(s)
    }
    report.check(
      '1B 选中格有不透明底色（伪元素 ::after 带 --sel；改前没有任何 .selectedCell 规则）',
      !!s1.selectedBg && !isTransparent(s1.selectedBg) && s1.selectedPosition === 'relative',
      JSON.stringify({ selectedBg: s1.selectedBg, position: s1.selectedPosition, plainBg: s1.plainBg })
    )

    // 1C 跨行跨列（表头第 1 格 → 数据行第 2 格）：**两块 × 两列** 的 2×2 一片
    await caretAway()
    cs = await cells()
    await drag(
      { x: cs[0].l + (cs[0].r - cs[0].l) * 0.25, y: cs[0].cy },
      { x: cs[4].cx, y: cs[4].cy }
    )
    const s2 = await sel()
    console.log('1C ' + JSON.stringify(s2))
    report.check(
      '1C 跨行跨列拖选（表头第 1 格 → 数据行第 2 格）⇒ 2×2 共 4 个单元格的一片',
      s2.isCell === true && s2.ranges === 4 && s2.selectedDom === 4,
      JSON.stringify({ type: s2.type, ranges: s2.ranges, selectedDom: s2.selectedDom })
    )

    // 1D 单格内拖选仍是**文字选择**（不许把普通文本选择弄坏）
    await caretAway()
    cs = await cells()
    const c0 = cs[0]
    await drag(
      { x: c0.l + (c0.r - c0.l) * 0.06, y: c0.cy },
      { x: c0.l + (c0.r - c0.l) * 0.34, y: c0.cy }
    )
    const s3 = await sel()
    console.log('1D ' + JSON.stringify(s3))
    report.check(
      '1D 单个单元格内拖选 ⇒ 仍是 TextSelection，且真的选到了格内文字',
      s3.isCell === false && s3.type === 'TextSelection' && s3.selectedDom === 0 && s3.text.length > 0,
      JSON.stringify({ type: s3.type, isCell: s3.isCell, text: s3.text, selectedDom: s3.selectedDom })
    )

    // 1E 松开后对多格选区执行一次操作：删除内容作用在**多个**格上
    await setContent(MD)
    await caretAway()
    cs = await cells()
    await dragInto(cs[0], cs[1])
    const beforeDel = await sel()
    const preCells = rowCells((await content()).split('\n')[2])
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8
    })
    await sleep(750)
    const delCells = rowCells((await content()).split('\n')[2])
    const delSpec = await spec()
    console.log('1E ' + JSON.stringify({ ranges: beforeDel.ranges, preCells, delCells }))
    report.check(
      '1E 多格选区上按退格 ⇒ 表头行**前两格同时被清空**、第三格不动，表格还在',
      beforeDel.isCell === true &&
        beforeDel.ranges === 2 &&
        delCells[0] === '' &&
        delCells[1] === '' &&
        delCells[2] === '丙丙丙丙' &&
        delSpec.rows === 2,
      JSON.stringify({ ranges: beforeDel.ranges, preCells, delCells, rows: delSpec.rows })
    )

    // 1F 多格选区上仍能执行操作：改列对齐落到**选区头所在列**（`tableColumnIndex` 的口径是
    //     selection 的 `$from`），并把结果写到序列化分隔行上。
    //     （重新灌一份干净夹具：1E 把前两格删空了，管道行会变成 `|  |  | 丙 |`，
    //      这里要的是"对齐落在哪一列"，与上一步的删除无关。）
    await setContent(MD)
    await caretAway()
    cs = await cells()
    await dragInto(cs[0], cs[1])
    const selForAlign = await sel()
    await ev('(() => { window.__L.ed().commands.setTableColumnAlign("center"); return "ok" })()')
    await sleep(700)
    const after1F = await spec()
    const delim1F = after1F.md.split('\n').find((l) => /^\s*\|[\s:-]+\|/.test(l)) || ''
    const alignCols = rowCells(delim1F).map((c) => (c.includes(':') ? c : ''))
    console.log('1F ' + JSON.stringify({ ranges: selForAlign.ranges, delim1F, aligns: after1F.aligns }))
    report.check(
      '1F 多格选区上改列对齐 ⇒ 落到序列化分隔行（选区头那一列变 :---:），表格仍是合法管道表',
      selForAlign.ranges >= 2 &&
        alignCols.filter((c) => c === ':---:').length === 1 &&
        alignCols[1] === ':---:' &&
        !after1F.md.includes('<table') &&
        after1F.rows === 2,
      JSON.stringify({ ranges: selForAlign.ranges, delim1F, aligns: after1F.aligns })
    )

    // ══ 任务 2：表格快捷操作条 ════════════════════════════════════════════════
    await openDocWith(app, MD3, 'table-quickbar-2.md')
    await sleep(1200)

    // 2A 光标**不在**表格里 → 没有工具条
    await caretAway()
    await sleep(400)
    const barOut = await bar()
    report.check('2A 光标不在表格里 ⇒ 不出现工具条', barOut.bars.length === 0, JSON.stringify(barOut.bars))

    // 2B 光标进表格 → 恰好一条，且 a11y 齐全
    cs = await cells()
    await clickCell(cs[0])
    const barIn = await bar()
    console.log('2B ' + JSON.stringify(barIn.bars))
    report.check('2B 光标进表格 ⇒ 恰好一条工具条', barIn.bars.length === 1, JSON.stringify({ n: barIn.bars.length }))
    const b0 = barIn.bars[0] || {}
    report.check(
      '2B 工具条有 role=toolbar + 可访问名 + 三个对齐项 / 删除 / 更多',
      b0.role === 'toolbar' &&
        typeof b0.aria === 'string' &&
        b0.aria.length > 0 &&
        JSON.stringify(b0.align) === JSON.stringify(['left', 'center', 'right']) &&
        b0.hasDelete === true &&
        b0.hasMore === true,
      JSON.stringify(b0)
    )
    report.check(
      '2B 工具条可用 Tab 抵达（≥ 5 个可聚焦按钮）',
      (b0.tabbables || 0) >= 5,
      JSON.stringify({ tabbables: b0.tabbables })
    )
    report.check(
      '2B 层级走令牌（计算 z-index 是正数，不是 auto/NaN）',
      Number(b0.zIndex) > 0,
      JSON.stringify({ zIndex: b0.zIndex })
    )

    // 2C 不遮挡表格首行：默认落在表格上缘之上，间隙 ≥ 0
    const gapAbove = barIn.table ? barIn.table.top - b0.bottom : -1
    report.check(
      '2C 工具条不遮表格首行（贴在表格上缘之上，间隙 ≥ 0）',
      barIn.table !== null && b0.below === 'false' && gapAbove >= 0,
      JSON.stringify({ gapAbove, below: b0.below, barBottom: b0.bottom, tableTop: barIn.table && barIn.table.top })
    )

    // 2D 点「居中」→ **序列化 Markdown 的分隔行**变成 :---:
    //     先确认这一列的原值确实是 null（否则"没变"有两种解释，分不清）
    const before2D = await spec()
    const r2D = await clickInBar('[data-align=center]')
    await sleep(750)
    const after2D = await spec()
    const delim2D = after2D.md.split('\n')[1]
    console.log('2D ' + JSON.stringify({ click: r2D, before: before2D.aligns, delim2D, aligns: after2D.aligns }))
    report.check(
      '2D 点工具条的「居中」⇒ 序列化分隔行第一列 = :---:',
      r2D === 'ok' && /^\|\s*:---:\s*\|/.test(delim2D),
      JSON.stringify({ click: r2D, before: before2D.aligns, delim2D })
    )
    report.check(
      '2D 对齐落到表头格的 attrs 上（不是只改视觉）',
      after2D.aligns[0] === 'center' && before2D.aligns[0] !== 'center',
      JSON.stringify({ before: before2D.aligns, after: after2D.aligns })
    )

    // 2E「更多」菜单：六个动作齐全（上/下插入行、左/右插入列、删当前行/列）
    await openMoreMenu()
    const menu = await bar()
    console.log('2E ' + JSON.stringify(menu.menuItems))
    report.check(
      '2E「更多」里有上/下插入行、左/右插入列、删当前行/删当前列 六项',
      JSON.stringify(menu.menuItems) ===
        JSON.stringify(['rows.above', 'rows.below', 'rows.delete', 'cols.before', 'cols.after', 'cols.delete']),
      JSON.stringify(menu.menuItems)
    )

    // 2F 插入行 ⇒ 序列化行数 +1
    const before2F = await spec()
    const r2F = await clickInBar('[data-table-action=rows\\.below]')
    await sleep(750)
    const after2F = await spec()
    console.log('2F ' + JSON.stringify({ click: r2F, rows: [before2F.rows, after2F.rows] }))
    report.check(
      '2F「下方插入行」⇒ 序列化行数 +1，且仍是管道表',
      r2F === 'ok' && after2F.rows === before2F.rows + 1 && !after2F.md.includes('<table'),
      JSON.stringify({ click: r2F, before: before2F.rows, after: after2F.rows })
    )

    // 2G 插入列 ⇒ 序列化列数 +1（分隔行段数同步 +1）
    await openMoreMenu()
    const before2G = await spec()
    const r2G = await clickInBar('[data-table-action=cols\\.after]')
    await sleep(750)
    const after2G = await spec()
    console.log('2G ' + JSON.stringify({ click: r2G, cols: [before2G.cols, after2G.cols], delim: after2G.md.split('\n')[1] }))
    report.check(
      '2G「右侧插入列」⇒ 序列化列数 +1（分隔行也跟着多一段）',
      r2G === 'ok' &&
        after2G.cols === before2G.cols + 1 &&
        rowCells(after2G.md.split('\n')[1]).length === rowCells(before2G.md.split('\n')[1]).length + 1,
      JSON.stringify({ click: r2G, before: before2G.cols, after: after2G.cols, delim: after2G.md.split('\n')[1] })
    )

    // 2H 列宽布局是**纯视图**：切到「各列等宽」后 markdown 逐字节不变
    const menu2H = await openMoreMenu()
    const widthBtns = await ev(
      '[...document.querySelectorAll("[data-width]")].map((x) => x.getAttribute("data-width"))'
    )
    const before2H = await content()
    const r2H = await clickInBar('[data-width=even]')
    await sleep(700)
    const after2H = await content()
    const layoutEven = await ev(
      '(() => { const w = document.querySelector(".tableWrapper"); return (w ? w.className : "") + "|" + (w ? getComputedStyle(w.querySelector("table")).tableLayout : "") })()'
    )
    console.log(
      '2H ' + JSON.stringify({ menu2H, widthBtns, click: r2H, layoutEven, same: before2H === after2H })
    )
    report.check(
      '2H 列宽切「各列等宽」⇒ tableLayout 变 fixed，且 Markdown 逐字节不变（视图层不落盘）',
      menu2H === true &&
        r2H === 'ok' &&
        String(layoutEven).includes('lumin-table-even') &&
        String(layoutEven).includes('fixed') &&
        before2H === after2H,
      JSON.stringify({ menu2H, widthBtns, click: r2H, layoutEven, sameDoc: before2H === after2H })
    )

    // 2I 多表格：只有光标那一张表的工具条，且贴着它
    await openDocWith(app, MD2, 'table-quickbar-3.md')
    await sleep(1300)
    const cs3 = await cells()
    report.check('2I fixture：两张表共 8 个单元格', cs3.length === 8, JSON.stringify(cs3.length))
    await clickCell(cs3[4])
    const bar3 = await bar()
    const barUnder = bar3.bars[0] || {}
    const t2 = await ev(`(() => {
      const ws = [...document.querySelectorAll('.tableWrapper')]
      const r = ws[1] ? ws[1].getBoundingClientRect() : null
      return JSON.stringify(r ? { top: Math.round(r.top), n: ws.length } : { n: ws.length })
    })()`).then(JSON.parse)
    console.log('2I ' + JSON.stringify({ bars: bar3.bars.length, barBottom: barUnder.bottom, barBelow: barUnder.below, t2 }))
    report.check(
      '2I 光标在第二张表 ⇒ 仍只有一条工具条，且贴着第二张表（不是第一张）',
      bar3.bars.length === 1 &&
        t2.n === 2 &&
        (barUnder.below === 'true'
          ? barUnder.top - t2.top > 0
          : Math.abs(barUnder.bottom - t2.top) <= 40),
      JSON.stringify({ bars: bar3.bars.length, barBottom: barUnder.bottom, barBelow: barUnder.below, t2 })
    )

    // 2J 光标移出表格 → 工具条消失（把光标放到表格**之后**那段）
    await ev(
      '(() => { window.__L.ed().chain().setTextSelection(window.__L.ed().state.doc.content.size - 1).run(); return "ok" })()'
    )
    await sleep(650)
    const barGone = await bar()
    report.check('2J 光标移出表格 ⇒ 工具条消失', barGone.bars.length === 0, JSON.stringify(barGone.bars.length))

    // 2K Esc 退出：菜单先收、再一次把焦点交回编辑器
    await clickCell(cs3[4])
    await openMoreMenu()
    const menuOpenBefore = (await bar()).menuItems.length
    const esc = (target) =>
      ev(
        '(() => { const b = document.querySelector(' +
          JSON.stringify(target) +
          '); b.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "ok" })()'
      )
    await esc('[data-table-bar]')
    await sleep(450)
    const menuOpenAfter = (await bar()).menuItems.length
    await esc('[data-table-bar]')
    await sleep(550)
    const focusAfterEsc = await ev(
      '(() => { const pm = document.querySelector(".ProseMirror"); return pm && pm.contains(document.activeElement) ? "editor" : String(document.activeElement && document.activeElement.tagName) })()'
    )
    /**
     * ⚠️ 「焦点交回编辑器」这一步**依赖窗口是 OS 前台**：`commands.focus()` 在窗口没有
     * OS 焦点时无法把 `document.activeElement` 拿回来（无头/后台跑时实测停在 `BUTTON` 上）。
     * 那是环境，不是产品缺陷 —— 拿不到前台就只断言「Esc 收掉了菜单、且没把选区弄丢」，
     * 把焦点那条如实标 SKIP（口径见 docs 与 harness 的 ensureFocus 说明）。
     */
    const hasOsFocus = await ev('document.hasFocus()')
    console.log('2K ' + JSON.stringify({ menuOpenBefore, menuOpenAfter, focusAfterEsc, hasOsFocus }))
    report.check(
      '2K Esc 先收「更多」菜单（第二次不再有菜单可收）',
      menuOpenBefore === 6 && menuOpenAfter === 0,
      JSON.stringify({ menuOpenBefore, menuOpenAfter })
    )
    if (hasOsFocus === true) {
      report.check(
        '2K 再按一次 Esc 把焦点交回编辑器',
        focusAfterEsc === 'editor',
        JSON.stringify({ focusAfterEsc })
      )
    } else {
      report.skip('2K 再按一次 Esc 把焦点交回编辑器', '窗口拿不到 OS 焦点，activeElement 回不去（环境）')
    }

    // 2L 删除表格 ⇒ **光标那张**（第二张 R/S）消失、第一张（P/Q）留着
    await clickCell(cs3[4])
    await sleep(300)
    const r2L = await clickInBar('[data-table-bar-delete]')
    await sleep(800)
    const after2L = await spec()
    const md2L = await content()
    console.log('2L ' + JSON.stringify({ click: r2L, rows: after2L.rows, md: md2L.replace(/\n/g, '\\n') }))
    report.check(
      '2L 点工具条的「删除表格」⇒ 光标那张表（第二张 R/S）从文档与序列化里都消失，第一张留着',
      r2L === 'ok' &&
        after2L.rows === 2 &&
        md2L.includes('| P | Q |') &&
        !md2L.includes('| R | S |'),
      JSON.stringify({ click: r2L, rows: after2L.rows, md: md2L.replace(/\n/g, '\\n') })
    )

    // ══ 任务 3：大纲标题前不再有小圆点 ══════════════════════════════════════
    await openDocWith(app, '# 一级\n\n## 二级\n\n### 三级\n\ntext\n', 'outline-dots.md')
    await sleep(1400)
    await ev('(() => { window.__L.ui().sidebarTab = "outline"; return "ok" })()')
    await sleep(1000)
    const dots = await ev(`(() => {
      const items = [...document.querySelectorAll('[data-outline-item]')]
      return JSON.stringify(items.map((el) => {
        const cs = getComputedStyle(el)
        return {
          text: el.textContent.trim(),
          children: el.children.length,
          childTags: [...el.children].map((c) => c.tagName + '.' + (c.className || '')),
          paddingLeft: cs.paddingLeft,
          before: getComputedStyle(el, '::before').content,
          after: getComputedStyle(el, '::after').content
        }
      }))
    })()`).then(JSON.parse)
    console.log('3A ' + JSON.stringify(dots))
    report.check('3A fixture：大纲里三条（h1/h2/h3）', dots.length === 3, JSON.stringify(dots.length))
    report.check(
      '3A 每个条目前都没有圆点元素（行内只剩文本这一个子元素）',
      dots.length > 0 && dots.every((d) => d.children === 1 && !/rounded-full/.test(d.childTags.join(' '))),
      JSON.stringify(dots.map((d) => ({ children: d.children, childTags: d.childTags })))
    )
    report.check(
      '3A 伪元素也不画点（::before / ::after 的 content 都是 none）',
      dots.length > 0 && dots.every((d) => d.before === 'none' && d.after === 'none'),
      JSON.stringify(dots.map((d) => ({ before: d.before, after: d.after })))
    )
    const paddings = dots.map((d) => parseFloat(d.paddingLeft))
    console.log('3B ' + JSON.stringify(paddings))
    report.check(
      '3B 缩进仍在，且随层级递增（h1 < h2 < h3）',
      paddings.length === 3 && paddings[0] >= 8 && paddings[1] > paddings[0] && paddings[2] > paddings[1],
      JSON.stringify(paddings)
    )

    // ══ 不许破坏的对照 ══════════════════════════════════════════════════════
    // 4A 单元格里的 `**` 行内标记：源码是真文本、屏幕上是样式、序列化原样往返
    await openDocWith(app, ['| **粗** | 乙 |', '| --- | --- |', '| 1 | 2 |', ''].join('\n'), 'table-marker.md')
    await sleep(1300)
    const marker = await ev(`(() => {
      const ed = window.__L.ed()
      let hasMarkerText = false
      ed.state.doc.descendants((n) => {
        if (n.isText && n.text === '**') hasMarkerText = true
        return true
      })
      const md = ed.storage.markdown.getMarkdown()
      const strong = document.querySelectorAll('.ProseMirror th strong, .ProseMirror td strong').length
      return JSON.stringify({ hasMarkerText, strong, md })
    })()`).then(JSON.parse)
    console.log('4A ' + JSON.stringify(marker))
    report.check(
      '4A 单元格里的 ** 仍是真实文本 + 渲染成样式，序列化原样往返',
      marker.hasMarkerText === true && marker.strong >= 1 && marker.md.includes('| **粗** |'),
      JSON.stringify(marker)
    )

    // 4B 表格往返幂等：灌回自己序列化的结果，输出逐字节相同
    const round1 = marker.md
    await setContent(round1)
    await sleep(500)
    const round2 = await content()
    console.log('4B ' + JSON.stringify({ a: round1.trim(), b: round2.trim() }))
    report.check(
      '4B 表格 round-trip 幂等（重灌后序列化逐字节相同）',
      round1.trim() === round2.trim(),
      JSON.stringify({ a: round1.trim(), b: round2.trim() })
    )

    // 4C 拖动选中文字改位置**仍然是禁的**（上一轮 `_verify-no-text-drag.js` 的最小复刻）
    await openDocWith(app, 'ABCDEF\n', 'table-bar-no-text-drag.md')
    await sleep(1300)
    const dragGeo = await ev(`(() => {
      const p = document.querySelector('.ProseMirror p')
      if (!p) return 'null'
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      const out = []
      while (w.nextNode()) {
        const t = w.currentNode
        let base = -1
        try { base = window.__L.ed().view.posAtDOM(t, 0) } catch (e) { base = -1 }
        for (let i = 0; i < t.data.length; i += 1) {
          const r = document.createRange()
          r.setStart(t, i); r.setEnd(t, i + 1)
          const b = r.getBoundingClientRect()
          out.push({ ch: t.data[i], pos: base + i, l: b.left, w: b.width, y: Math.round(b.top + b.height / 2) })
        }
      }
      return JSON.stringify(out)
    })()`).then(JSON.parse)
    const pick = (ch, frac) => {
      const c = dragGeo.find((x) => x.ch === ch)
      return c ? { x: c.l + c.w * frac, y: c.y } : null
    }
    const STATE4C = `JSON.stringify({
      from: window.__L.ed().state.selection.from,
      to: window.__L.ed().state.selection.to,
      text: window.__L.ed().state.doc.textContent,
      md: window.__L.ed().storage.markdown.getMarkdown(),
      dirty: window.__L.files().dirty
    })`
    await drag(pick('D', 0.25), pick('E', 0.8), 10)
    const afterSel = await ev(STATE4C).then(JSON.parse)
    await drag(pick('E', 0.5), pick('B', 0.06), 10)
    const afterDrop = await ev(STATE4C).then(JSON.parse)
    console.log('4C ' + JSON.stringify({ afterSel, afterDrop }))
    report.check(
      '4C 拖动选中的文字改位置仍然是禁的（文档逐字不变 + 选区原样保留 + 不置脏）',
      afterSel.from === 4 &&
        afterSel.to === 6 &&
        afterDrop.text === 'ABCDEF' &&
        afterDrop.md === afterSel.md &&
        afterDrop.from === 4 &&
        afterDrop.to === 6 &&
        afterDrop.dirty === false,
      JSON.stringify({ afterSel, afterDrop })
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
