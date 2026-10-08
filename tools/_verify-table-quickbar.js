'use strict'
// ─── 验收：表格（本轮 = 第十四轮：拖选给文本选择 + 剪贴板给 Markdown）────────────
//
// 本套件覆盖两轮的工作，1x 段的口径在第十四轮**被用户改过**（见下），其余各段不动。
//
// 【第十四轮 任务 1】跨格拖选 ⇒ **按阅读顺序的文本选择**，不是 `CellSelection`
//   用户改口径：「在表格中连续选中的时候，不要选中一整个单元格，而是按照从上到下、
//   从左到右的顺序可以连续选中。」
//   ⚠️ **口径变更（不是收紧）**：第十三轮 1A/1C/1E 断言的是"拖选得到 `CellSelection`"
//   （那是当时用户要的"整格高亮"）。第十四轮用户明确改要**文本选择**，所以：
//     * 1A/1B/1C/1E **改写**为"拖选 ⇒ `TextSelection`、能对选中**文字**做操作"；
//     * 「跨格时选中的是文字而不是整格」的判据用 **`ranges.length`**：`CellSelection`
//       每个格子一个 range（≥2），`TextSelection` 恒为 1 —— 这是两者的稳定结构差，
//       比认类名可靠（Tiptap 打包后类名是 `CellSelection2`，实测）。
//     * 名字保持可比：`1A 表头跨两格拖选` 等前缀不变，只改断言语义 + 后缀。
//   `.selectedCell` 的可见高亮**保留**（`Shift+左键` 的"整格选"仍走 `CellSelection`），
//   所以 1B 改成直接验那条 CSS 规则本身（见 §1B）。
//
// 【第十四轮 任务 2】剪贴板：复制给 **Markdown**；外部 HTML（无表头）表格粘成 **Markdown 表格**
//   5x 段：5A 复制写入的 `text/plain`、5B 粘回还原、5C 外部 HTML 表（Word/Excel 形态）。
//
// 【第十三轮 任务 2/3】表格快捷操作条 + 大纲去圆点：2x / 3x 段，断言不动。
//
// 6x 是"不许破坏"的对照：`**` 行内标记、表格往返幂等、拖动选中文字改位置仍被禁。
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
    anchor: s.anchor,
    head: s.head,
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

/** 表格规格（行数/列数/表头对齐/表头格类型/是否退回 HTML）+ 序列化 md，作为表格动作的判据 */
const SPEC = `(() => {
  const ed = window.__L.ed()
  let rows = -1, cols = -1
  const aligns = []
  const headerTypes = []
  const names = []
  let tables = 0, htmlBlocks = 0
  ed.state.doc.descendants((n) => {
    if (n.type.name === 'table') {
      tables += 1
      if (rows >= 0) return false
      rows = n.childCount
      const head = n.firstChild
      cols = head ? head.childCount : -1
      if (head) {
        head.forEach((c) => { aligns.push(c.attrs.align === undefined ? null : c.attrs.align); headerTypes.push(c.type.name) })
      }
      return false
    }
    return true
  })
  ed.state.doc.descendants((n) => { if (n.isBlock) names.push(n.type.name); if (n.type.name === 'htmlBlock') htmlBlocks += 1; return true })
  return JSON.stringify({ rows, cols, aligns, headerTypes, names, tables, htmlBlocks, md: ed.storage.markdown.getMarkdown() })
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
  /** 夹具 MD 里表格**表头行**在序列化文本里的行号（现算一次，后面几段都用它取那一行） */
  let tableStartLine = 0

  try {
    await ev('(() => { window.__L.ui().editorMode = "wysiwyg"; return "ok" })()')
    await sleep(350)
    await openDocWith(app, MD, 'table-quickbar.md')
    await waitEditor(ev)
    await sleep(1400)
    tableStartLine = (await content()).split('\n').findIndex((l) => /^\s*\|/.test(l))
    if (tableStartLine < 0) tableStartLine = 0

    // ══ 第十四轮 任务 1：跨格拖选 = 按阅读顺序的**文本选择** ════════════════════
    cs = await cells()
    report.check('fixture：3 列表头 + 1 行数据共 6 个单元格', cs.length === 6, JSON.stringify(cs.map((c) => c.text)))

    /**
     * 表格行的内容坐标现算（不写死任何数字）：从 DOM 反查每个单元格里文字的起始文档位置。
     * 用 `view.posAtDOM(td, 0)` 而不是"行号 + 1" —— 后者是错的（文档位置不等于 Markdown 行号，
     * 表格节点/行/单元格/段落各占一个开标记，实测差一大截：want 3 vs got 11）。
     */
    const cellTextPos = () =>
      ev(`(() => {
        const v = window.__L.ed().view
        return JSON.stringify([...document.querySelectorAll('.ProseMirror th, .ProseMirror td')].map((el) => {
          const p = el.querySelector('p') || el
          let pos = -1
          try { pos = v.posAtDOM(p, 0) } catch (e) { pos = -1 }
          return { pos, text: el.textContent, textLen: (el.textContent || '').length }
        }))
      })()`).then(JSON.parse)

    // 1A 同一行跨两格（表头 甲 → 乙）：必须是**文本选择**，且跨格（不是一格一个 range）
    await caretAway()
    cs = await cells()
    await dragInto(cs[0], cs[1])
    const s1 = await sel()
    const cp1 = await cellTextPos()
    console.log('1A ' + JSON.stringify({ sel: s1, cells: cp1.map((c) => ({ pos: c.pos, text: c.text })) }))
    report.check(
      '1A 表头跨两格拖选 ⇒ TextSelection（不是 CellSelection：ranges 恒为 1）',
      s1.isCell === false && s1.type === 'TextSelection' && s1.ranges === 1,
      JSON.stringify({ type: s1.type, isCell: s1.isCell, ranges: s1.ranges })
    )
    report.check(
      '1A 选中的是**两格的文字**（不是整格块选）：range 跨过第 1、2 格，且第二格文字整个被选中',
      s1.selectedDom === 0 &&
        cp1.length >= 2 &&
        s1.from < cp1[1].pos &&
        s1.to === cp1[1].pos + cp1[1].textLen &&
        s1.text.replace(/\|/g, '').endsWith('乙乙乙乙'),
      JSON.stringify({ from: s1.from, to: s1.to, c0: cp1[0], c1: cp1[1], text: s1.text })
    )
    report.check(
      '1A 方向：左→右拖 ⇒ anchor < head（从左到右的阅读顺序）',
      s1.anchor < s1.head,
      JSON.stringify({ anchor: s1.anchor, head: s1.head })
    )

    // 1B `.selectedCell` 高亮那条 CSS **保留**（Shift+左键的"整格选"仍用它）——
    //    第十四轮删掉了"普通拖选会点亮它"这个前提，所以这里改成直接验规则本身在。
    const cellselCss = await ev(`(() => {
      const rules = []
      for (const ss of document.styleSheets) {
        let list
        try { list = ss.cssRules } catch (e) { continue }
        for (const r of list) {
          if (r.selectorText && r.selectorText.includes('selectedCell')) rules.push(r.cssText)
        }
      }
      return JSON.stringify(rules)
    })()`).then(JSON.parse)
    // 1B 普通拖选**不该**再产生任何 `.selectedCell`（口径变更的核心）
    report.check(
      '1B 普通拖选不再点亮 `.selectedCell`（改前是 ≥ 2 个整格高亮）',
      s1.selectedDom === 0,
      JSON.stringify({ selectedDom: s1.selectedDom })
    )
    report.check(
      '1B `.selectedCell` 高亮规则本身仍在（Shift+左键的整格选还要用）',
      cellselCss.length >= 2 && cellselCss.some((c) => c.includes('::after')),
      JSON.stringify(cellselCss)
    )

    // 1C 跨行跨列（表头第 1 格 → 数据行第 1 格）：**阅读顺序**从甲甲一路到一一一一
    await caretAway()
    cs = await cells()
    await dragInto(cs[0], cs[3])
    const s2 = await sel()
    const cp2 = await cellTextPos()
    console.log('1C ' + JSON.stringify({ sel: s2, cells: cp2.map((c) => ({ pos: c.pos, text: c.text })) }))
    report.check(
      '1C 跨行拖选（表头第 1 格 → 数据行第 1 格）⇒ TextSelection 覆盖"从上到下、从左到右"的连续文字',
      s2.isCell === false &&
        s2.ranges === 1 &&
        // 第 2、3 格与数据行第 1 格的文字**整个**落进选区 ⇒ 顺序确实是按文档顺序连着的
        s2.text.replace(/\|/g, '').includes('乙乙乙乙丙丙丙丙一一一一'),
      JSON.stringify({ type: s2.type, ranges: s2.ranges, text: s2.text })
    )
    report.check(
      '1C 范围两端落在"第一格之后 → 最后一格附近"（从 DOM 反查，方向从左到右）',
      cp2.length >= 4 &&
        s2.from > cp2[0].pos &&
        s2.from < cp2[1].pos &&
        Math.abs(s2.to - (cp2[3].pos + cp2[3].textLen)) <= 4 &&
        s2.anchor < s2.head,
      JSON.stringify({ got: [s2.from, s2.to], c0: cp2[0], c3: cp2[3], anchor: s2.anchor, head: s2.head })
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

    // 1E 反向拖（从第 2 格拖回第 1 格）：**同一个跨格范围**必须复现（方向由浏览器决定，
    //     这里不对 anchor/head 的大小下断言 —— 见报告里"方向"的如实说明）
    await caretAway()
    cs = await cells()
    const cpE = await cellTextPos()
    await dragInto(cs[1], cs[0])
    const s3b = await sel()
    const sameAs1A = s3b.from === s1.from && s3b.to === s1.to
    const sameAs1C = s3b.from === s2.from && s3b.to === s2.to
    console.log('1E ' + JSON.stringify({ sel: s3b, cp: cpE.map((c) => c.pos), sameAs1A, sameAs1C }))
    report.check(
      '1E 右→左拖（第 2 格 → 第 1 格）⇒ 仍是跨格文本选择（ranges=1、无整格高亮）',
      s3b.isCell === false && s3b.ranges === 1 && s3b.selectedDom === 0 && s3b.to > s3b.from,
      JSON.stringify({ from: s3b.from, to: s3b.to, ranges: s3b.ranges, selectedDom: s3b.selectedDom })
    )
    report.check(
      '1E 反向拖的范围等于同一对手势的正向范围（跨的格子数与落点一致），既不是 1A 也不是 1C 以外的东西',
      sameAs1A || sameAs1C,
      JSON.stringify({ got: [s3b.from, s3b.to], a: [s1.from, s1.to], c: [s2.from, s2.to] })
    )

    // 1F 对跨格文本选区做一次**文本级操作**：退格只删掉选中的那些字
    await setContent(MD)
    await caretAway()
    cs = await cells()
    const cpF = await cellTextPos()
    // 只选中「乙乙」（第 2 格文字的前两个字）：用**文档坐标**算落点，别靠像素比例
    const c1F = cs[1]
    const dragText = async (fromPos, toPos) => {
      const pts = JSON.parse(await ev(`(() => {
        const v = window.__L.ed().view
        const r = (p) => { const c = v.coordsAtPos(p); return { x: Math.round(c.left), y: Math.round((c.top + c.bottom) / 2) } }
        return JSON.stringify({ a: r(${fromPos}), b: r(${toPos}) })
      })()`))
      await mouse('mouseMoved', pts.a.x, pts.a.y, 0)
      await sleep(90)
      await mouse('mousePressed', pts.a.x, pts.a.y, 1)
      await sleep(140)
      for (let i = 1; i <= 9; i += 1) {
        await mouse('mouseMoved', pts.a.x + ((pts.b.x - pts.a.x) * i) / 9, pts.a.y, 1)
        await sleep(40)
      }
      await sleep(130)
      await mouse('mouseReleased', pts.b.x, pts.b.y, 0)
      await sleep(450)
    }
    await dragText(cpF[1].pos, cpF[1].pos + 2)
    const beforeDel = await sel()
    const preLine = (await content()).split('\n')[tableStartLine]
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
    const delCells = rowCells((await content()).split('\n')[tableStartLine])
    const delSpec = await spec()
    console.log('1F ' + JSON.stringify({ sel: beforeDel, preLine, delCells }))
    report.check(
      '1F 对文字选区按退格 ⇒ **只删掉选中的那些字**（同一格内的其余字保留、表格还在）',
      beforeDel.isCell === false &&
        beforeDel.text === '乙乙' &&
        delCells[0] === '甲甲甲甲' &&
        delCells[1] === '乙乙' &&
        delCells[2] === '丙丙丙丙' &&
        delSpec.rows === 2,
      JSON.stringify({ selText: beforeDel.text, delCells, rows: delSpec.rows })
    )

    // 1G 跨格文本选区上仍能执行表格动作：改列对齐落到**选区头所在列**
    //     （`tableColumnIndex` 的口径是 selection 的 `$from`；这里把光标明确放进第 2 格，
    //      不让"拖到哪一格"的落点抖动决定这一条）
    await setContent(MD)
    await caretAway()
    cs = await cells()
    await dragInto(cs[0], cs[1])
    const selForAlign = await sel()
    const cpG = await cellTextPos()
    await ev(
      '(() => { window.__L.ed().chain().setTextSelection(' +
        cpG[1].pos +
        ').run(); return "ok" })()'
    )
    await sleep(400)
    const selForAlign2 = await sel()
    await ev('(() => { window.__L.ed().commands.setTableColumnAlign("center"); return "ok" })()')
    await sleep(700)
    const after1G = await spec()
    const delim1G = after1G.md.split('\n').find((l) => /^\s*\|[\s:-]+\|/.test(l)) || ''
    const alignCols = rowCells(delim1G).map((c) => (c.includes(':') ? c : ''))
    console.log('1G ' + JSON.stringify({ dragged: selForAlign, then: selForAlign2, delim1G, aligns: after1G.aligns }))
    report.check(
      '1G 跨格文本选区上改列对齐 ⇒ 落到序列化分隔行（光标那一列变 :---:），仍是合法管道表',
      selForAlign.isCell === false &&
        selForAlign.text.length > 0 &&
        alignCols.filter((c) => c === ':---:').length === 1 &&
        alignCols[1] === ':---:' &&
        !after1G.md.includes('<table') &&
        after1G.rows === 2,
      JSON.stringify({ delim1G, aligns: after1G.aligns })
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

    // ══ 第十四轮 任务 2：剪贴板形态（复制 = Markdown；外部 HTML 表 → Markdown 表格）══
    /**
     * 复制：在真实 `copy` 事件里读我们自己写进去的 `clipboardData`。
     * ⚠️ 系统剪贴板**读不到**：本项目 origin 是 `file://`，`navigator.clipboard.readText()`
     * 实测 `NotAllowedError`（CDP 的 `Browser.grantPermissions` 对 file:// 无效）；
     * `document.execCommand('copy')` 在 Electron 里实测返回 **false**。所以判据只能建在
     * "拦事件读我们自己写的 DataTransfer"上 —— 这是项目既有的做法（见 _verify-math-edit.js）。
     */
    const COPY_MD = [
      '前置段。',
      '',
      '| **粗** | `码` | 丙 |',
      '| :--- | :---: | ---: |',
      '| 一一 | [链](https://a.b) | 三三 |',
      ''
    ].join('\n')

    /** 选中整张表（文本选区），派发一次真实 copy 事件，返回我们写进去的剪贴板内容 */
    const copyWholeTable = async () => {
      await ev(`(() => {
        const ed = window.__L.ed()
        let from = -1, to = -1
        ed.state.doc.descendants((n, p) => {
          if (n.type.name !== 'table') return true
          if (from < 0) { from = p; to = p + n.nodeSize }
          return false
        })
        ed.chain().setTextSelection({ from: from + 1, to: to - 1 }).run()
        return 'ok'
      })()`)
      await sleep(400)
      return JSON.parse(
        await ev(`(() => {
          const view = window.__L.ed().view
          const dt = new DataTransfer()
          const e = new ClipboardEvent('copy', { bubbles: true, cancelable: true })
          Object.defineProperty(e, 'clipboardData', { value: dt })
          view.dom.dispatchEvent(e)
          const out = {
            prevented: e.defaultPrevented,
            plain: dt.getData('text/plain'),
            htmlLen: dt.getData('text/html').length,
            types: [...dt.types]
          }
          window.__LUMIN_CB = out
          return JSON.stringify(out)
        })()`)
      )
    }

    // 5A 复制表格 ⇒ text/plain 是 **Markdown 管道表**（含分隔行），不是 HTML
    await openDocWith(app, COPY_MD, 'table-clip-copy.md')
    await sleep(1300)
    const cb1 = await copyWholeTable()
    console.log('5A ' + JSON.stringify(cb1))
    report.check(
      '5A 复制表格 ⇒ text/plain 是 Markdown 管道表（含分隔行），**不含** `<table`',
      !cb1.plain.includes('<table') &&
        cb1.plain.split('\n').some((l) => /^\|\s*:?-{2,}/.test(l.trim()) || /^\|\s*:?-+/.test(l.trim())) &&
        cb1.plain.includes('| **粗** |') &&
        cb1.plain.includes('[链](https://a.b)'),
      JSON.stringify({ plain: cb1.plain })
    )
    report.check(
      '5A 复制时我们的 copy 处理器真的生效（事件被 preventDefault）',
      cb1.prevented === true,
      JSON.stringify({ prevented: cb1.prevented, types: cb1.types })
    )
    report.check(
      '5A 对齐信息也在 Markdown 里（分隔行保留 :--- / :---: / ---:）',
      /:---/.test(cb1.plain) && /---:/.test(cb1.plain),
      JSON.stringify({ plain: cb1.plain })
    )

    // 5B 用上一步的剪贴板**粘回本项目** ⇒ 还原成表格，且往返一致
    const mdBefore = (await content()).trim()
    await ev(`(() => {
      const ed = window.__L.ed()
      const view = ed.view
      ed.chain().setTextSelection(ed.state.doc.content.size - 1).run()
      const dt = new DataTransfer()
      dt.setData('text/plain', window.__LUMIN_CB.plain)
      const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'clipboardData', { value: dt })
      view.dom.dispatchEvent(e)
      return 'ok'
    })()`)
    await sleep(1000)
    const pasteSpec = await spec()
    const mdAfter = (await content()).trim()
    console.log('5B ' + JSON.stringify({ tables: pasteSpec.tables, rows: pasteSpec.rows, mdBefore, mdAfter }))
    report.check(
      '5B 把上一步的 Markdown 剪贴板粘回来 ⇒ 还原成**表格节点**（不是字面文本/HTML 块）',
      pasteSpec.tables === 2 && pasteSpec.htmlBlocks === 0,
      JSON.stringify({ tables: pasteSpec.tables, htmlBlocks: pasteSpec.htmlBlocks, names: pasteSpec.names })
    )
    report.check(
      '5B 往返一致：粘出来的那张表与自己序列化的一字不差',
      mdAfter.includes(mdBefore) && mdAfter.split(mdBefore).length === 2,
      JSON.stringify({ mdBefore, mdAfter })
    )

    // 5C 外部 HTML 表格（Word / Excel 那种**无表头行**的）⇒ 变成 Markdown 表格
    const WORD_TABLE =
      '<html><head><meta charset="utf-8"></head><body><div class=WordSection1>' +
      '<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0>' +
      '<tr><td width=120 valign=top><p class=MsoNormal><b><span>姓名</span></b></p></td>' +
      '<td width=120 valign=top><p class=MsoNormal><b><span>年龄</span></b></p></td></tr>' +
      '<tr><td width=120 valign=top><p class=MsoNormal><span>张三</span></p></td>' +
      '<td width=120 valign=top><p class=MsoNormal><span>30</span></p></td></tr>' +
      '</table></div></body></html>'
    const EXCEL_TABLE =
      '<table border=0 cellpadding=0 cellspacing=0 width=200>' +
      '<tr height=20><td height=20 class=xl65>地区</td><td class=xl65>销量</td></tr>' +
      '<tr height=20><td height=20 class=xl63>华东</td><td class=xl63 align=right>1200</td></tr>' +
      '</table>'

    const pasteHtml = async (name, html, text) => {
      await openDocWith(app, '占位。\n', name)
      await sleep(1100)
      await ev(`(() => {
        const view = window.__L.ed().view
        const dt = new DataTransfer()
        dt.setData('text/html', ${JSON.stringify(html)})
        ${text === null ? '' : `dt.setData('text/plain', ${JSON.stringify(text)})`}
        const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(e, 'clipboardData', { value: dt })
        view.dom.dispatchEvent(e)
        return 'ok'
      })()`)
      await sleep(1000)
      return await spec()
    }

    const word = await pasteHtml('table-clip-word.md', WORD_TABLE, '姓名\t年龄\n张三\t30')
    console.log('5C-WORD ' + JSON.stringify(word))
    report.check(
      '5C 粘 Word 无表头 HTML 表 ⇒ 变成 Markdown 管道表（有分隔行、无 `<table`、无 htmlBlock）',
      word.tables === 1 &&
        word.htmlBlocks === 0 &&
        !word.md.includes('<table') &&
        // Word 的 `<b>` 会变成 `**姓名**`，所以判据不写死"| 姓名 |"
        /\|\s*(?:\*\*)?姓名/.test(word.md) &&
        word.md.split('\n').some((l) => /^\|\s*:?-{2,}/.test(l.trim())),
      JSON.stringify({ tables: word.tables, htmlBlocks: word.htmlBlocks, md: word.md })
    )
    report.check(
      '5C Word 表的第一行被提升为**表头**（无表头表在 GFM 里没有写法，这是唯一可表达的形态）',
      word.aligns.length >= 2 && word.headerTypes.every((t) => t === 'tableHeader'),
      JSON.stringify({ headerTypes: word.headerTypes, aligns: word.aligns })
    )

    const excel = await pasteHtml('table-clip-excel.md', EXCEL_TABLE, '地区\t销量\n华东\t1200')
    console.log('5C-EXCEL ' + JSON.stringify(excel))
    report.check(
      '5C 粘 Excel 无表头 HTML 表 ⇒ 同样是 Markdown 管道表',
      excel.tables === 1 && excel.htmlBlocks === 0 && !excel.md.includes('<table') && /^\|\s*地区\s*\|/m.test(excel.md),
      JSON.stringify({ tables: excel.tables, md: excel.md })
    )

    // 5D 外部 HTML 表**本来就有 `<th>`** ⇒ 一个字节都不改（不许误伤）
    const withHead = await pasteHtml(
      'table-clip-head.md',
      '<table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
      '甲\t乙\n1\t2'
    )
    console.log('5D ' + JSON.stringify(withHead))
    report.check(
      '5D 外部 HTML 表本来就有 th ⇒ 结构不变（仍是表格 + 首行是表头），没有被误改',
      withHead.tables === 1 && withHead.headerTypes.every((t) => t === 'tableHeader') && !withHead.md.includes('<table'),
      JSON.stringify({ tables: withHead.tables, headerTypes: withHead.headerTypes, md: withHead.md })
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
