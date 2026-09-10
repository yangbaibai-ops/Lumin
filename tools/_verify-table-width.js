// 验收：WYSIWYG 表格宽度 —— 始终占满写作区宽度 + 每个单元格有 min-width
// 1) 真实文档里的表格（2 列）必须撑满 .ProseMirror 宽度，单元格随之均分；
// 2) 离屏 .md-preview 复刻容器（与真实表格同样带 Tiptap 的 inline min-width），
//    对 1/2/3/12/20 列验证：能放下时表格 == 容器宽度；放不下时单元格不小于
//    min-width 并由 .tableWrapper 出横向滚动。
const CDP = 'http://127.0.0.1:9222/json'
const MIN_W = 96
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }

/** 离屏复刻容器里造一张 cols 列的表格并量测（CSP 禁内联脚本/eval，故直接内联表达式） */
function harnessExpr(cols, width) {
  return `(() => {
  let host = document.getElementById('tbl-probe')
  if (!host) {
    host = document.createElement('div')
    host.id = 'tbl-probe'
    host.className = 'md-preview'
    host.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;'
    document.body.appendChild(host)
  }
  host.style.width = '${width}px'
  const colsHtml = '<col style="min-width: 25px">'.repeat(${cols})
  host.innerHTML =
    '<div class="tableWrapper"><table style="min-width: 50px"><colgroup>' + colsHtml + '</colgroup><tbody>' +
    '<tr>' + '<th><p>列A</p></th>'.repeat(${cols}) + '</tr>' +
    '<tr>' + '<td><p>内容</p></td>'.repeat(${cols}) + '</tr>' +
    '</tbody></table></div>'
  const wrap = host.querySelector('.tableWrapper')
  const table = host.querySelector('table')
  const cells = Array.from(host.querySelectorAll('tr:first-child > *'))
  const cs = getComputedStyle(table)
  const ws = cells.map((c) => +c.getBoundingClientRect().width.toFixed(1))
  return JSON.stringify({
    container: wrap.clientWidth,
    wrapScroll: wrap.scrollWidth,
    scrolls: wrap.scrollWidth > wrap.clientWidth + 0.5,
    tableW: +table.getBoundingClientRect().width.toFixed(1),
    display: cs.display,
    layout: cs.tableLayout,
    minCell: Math.min(...ws),
    maxCell: Math.max(...ws)
  })
})()`
}

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // ── 1) 真实文档里的表格 ──────────────────────────────────────────────
  const real = JSON.parse(await ev(`(() => {
    const table = document.querySelector('.ProseMirror table, .md-preview table')
    const prose = document.querySelector('.ProseMirror')
    if (!table || !prose) return JSON.stringify({ present: false })
    const cs = getComputedStyle(table)
    const cells = Array.from(table.querySelectorAll('tr:first-child > *')).map((c) => +c.getBoundingClientRect().width.toFixed(1))
    return JSON.stringify({
      present: true,
      containerW: prose.clientWidth,
      tableW: +table.getBoundingClientRect().width.toFixed(1),
      cells,
      minCell: Math.min(...cells),
      cols: cells.length,
      wrapped: table.parentElement.classList.contains('tableWrapper'),
      tableMarginTop: cs.marginTop,
      wrapperMarginTop: getComputedStyle(table.parentElement).marginTop,
      display: cs.display,
      layout: cs.tableLayout,
      wrapperScrolls: table.parentElement.scrollWidth > table.parentElement.clientWidth + 0.5
    })
  })()`))
  console.log('REAL ' + JSON.stringify(real))
  c('real-table-exists', real.present === true)
  if (real.present) {
    c('real-table-fills-column', Math.abs(real.tableW - real.containerW) <= 1, `${real.tableW} / ${real.containerW}`)
    c('real-cells-fill', Math.abs(real.minCell * real.cols - real.tableW) <= 2, `${real.minCell} x ${real.cols}`)
    c('real-min-width-ok', real.minCell >= MIN_W, 'minCell=' + real.minCell)
    c('real-no-block-hack', real.display === 'table' && real.layout === 'auto', `${real.display}/${real.layout}`)
    c('real-inside-wrapper', real.wrapped === true)
    c('no-double-margin', real.tableMarginTop === '0px' && real.wrapperMarginTop !== '0px', `table=${real.tableMarginTop} wrapper=${real.wrapperMarginTop}`)
  }

  // ── 1b) 变宽后表格仍可正常编辑（点进单元格 → 选区落在 tableCell/tableHeader）──
  if (real.present) {
    const savedPos = await ev(`(() => { const app = document.querySelector('#app').__vue_app__; const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)'); const pinia = app._context.provides[sym]; window.__vt = { ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui') }; const ed = window.__vt.ed(); return ed ? ed.state.selection.from : null })()`)
    const pt = JSON.parse(await ev(`(() => { const cell = document.querySelector('.ProseMirror table th, .ProseMirror table td'); if (!cell) return JSON.stringify({ none: true }); const r = cell.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`))
    if (!pt.none) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await sleep(350)
      const sel = JSON.parse(await ev(`(() => {
        const ed = window.__vt.ed()
        if (!ed) return JSON.stringify({ inCell: null })
        const { $from } = ed.state.selection
        let name = null
        for (let d = $from.depth; d > 0; d--) { const n = $from.node(d).type.name; if (n === 'tableCell' || n === 'tableHeader') { name = n; break } }
        return JSON.stringify({ inCell: name, docSize: ed.state.doc.content.size })
      })()`))
      c('cell-clickable-after-widening', sel.inCell === 'tableHeader' || sel.inCell === 'tableCell', JSON.stringify(sel))
      if (savedPos != null) await ev(`(() => { const ed = window.__vt.ed(); if (ed) ed.commands.setTextSelection(${savedPos}); return 'ok' })()`)
    }
  }

  // ── 2) 离屏复刻容器：多列形态 ────────────────────────────────────────
  const containerW = real.present ? real.containerW : await ev(`Math.round(document.querySelector('.ProseMirror').clientWidth)`)
  console.log('container width =', containerW)

  for (const cols of [1, 2, 3, 12, 20]) {
    const m = JSON.parse(await ev(harnessExpr(cols, containerW)))
    const fits = cols * MIN_W <= containerW
    console.log(`COL ${String(cols).padStart(2)} ` + JSON.stringify(m))
    if (fits) {
      c(`cols-${cols}-fills-width`, Math.abs(m.tableW - containerW) <= 1, `${m.tableW} / ${containerW}`)
    } else {
      c(`cols-${cols}-scrolls`, m.scrolls === true, 'scrollWidth=' + m.wrapScroll)
      c(`cols-${cols}-table-overflows`, m.tableW > containerW, `${m.tableW} > ${containerW}`)
    }
    c(`cols-${cols}-cell-min-width`, m.minCell >= MIN_W - 0.5, 'minCell=' + m.minCell)
  }
  await ev(`(() => { document.getElementById('tbl-probe')?.remove(); return 'ok' })()`)

  // ── 3) 写作区变窄时表格自动重新撑满（用 CDP 视口覆盖缩窄页面，不动用户窗口）──
  if (real.present) {
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 820, deviceScaleFactor: 1, mobile: false })
    await sleep(900)
    const narrowProse = await ev(`Math.round(document.querySelector('.ProseMirror').clientWidth)`)
    const narrow = JSON.parse(await ev(`(() => {
      const t = document.querySelector('.ProseMirror table')
      const p = document.querySelector('.ProseMirror')
      const cells = Array.from(t.querySelectorAll('tr:first-child > *')).map((c) => +c.getBoundingClientRect().width.toFixed(1))
      return JSON.stringify({ prose: p.clientWidth, tableW: +t.getBoundingClientRect().width.toFixed(1), minCell: Math.min(...cells) })
    })()`))
    console.log('NARROW ' + JSON.stringify(narrow))
    if (narrowProse < real.containerW) {
      c('refills-narrow-column', Math.abs(narrow.tableW - narrow.prose) <= 1, `${narrow.tableW} / ${narrow.prose}`)
      c('refills-keeps-min-width', narrow.minCell >= MIN_W, 'minCell=' + narrow.minCell)
      const m12 = JSON.parse(await ev(harnessExpr(12, narrowProse)))
      console.log('NARROW COL 12 ' + JSON.stringify(m12))
      c('narrow-12cols-scrolls', m12.scrolls === true, `scrollWidth=${m12.wrapScroll} / ${narrowProse}`)
      c('narrow-12cols-min-width', m12.minCell >= MIN_W - 0.5, 'minCell=' + m12.minCell)
      await ev(`(() => { document.getElementById('tbl-probe')?.remove(); return 'ok' })()`)
    } else {
      c('viewport-override-effective', false, 'ProseMirror 宽度未变化 = ' + narrowProse)
    }
    await send('Emulation.clearDeviceMetricsOverride')
    await sleep(900)
    const back = JSON.parse(await ev(`(() => { const t = document.querySelector('.ProseMirror table'); const p = document.querySelector('.ProseMirror'); return JSON.stringify({ prose: p.clientWidth, tableW: +t.getBoundingClientRect().width.toFixed(1) }) })()`))
    c('refills-back', Math.abs(back.tableW - back.prose) <= 1, `${back.tableW} / ${back.prose}`)
  }

  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
