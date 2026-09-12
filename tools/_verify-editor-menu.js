// 验收：编辑器右键菜单（两级结构）
// A. 一级=分类总览：段落/格式/插入（表格内多一个表格），面板不再冗长、无动作项
// B. 二级：悬停分类即展开；位置贴在一级右侧；含一级/二级/三级标题等动作
// C. 文档滚动关闭菜单，但**菜单内部滚动不关闭**（本次修复点）
// D. 上下文识别：表格内出现表格分类，8 个表格操作齐全；表格内「插入表格」禁用
// E. 执行 + SQLite 持久化：执行动作 → 文档变化、菜单关闭、menu_usage 落库
// F. 最近使用：由使用记录驱动出现在一级；清除记录后消失
// G. 交互：↑↓ 一级、→/Enter 进二级、← 退回、Esc 逐级退出、点击外部关闭、贴边钳制
// H. 源码视图不接管
const CDP = 'http://127.0.0.1:9222/json'
let ws,
  id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) {
  return new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
}
async function ev(e) {
  const r = await send('Runtime.evaluate', {
    expression: e,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails)
    throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description || ''))
  return r.result?.result?.value
}
async function mouseMove(x, y) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y: y - 2,
    button: 'none',
    buttons: 0
  })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await sleep(200)
}
/** 单步移动（不做 y-2 预热、不等待），用于精确模拟指针轨迹 */
async function moveTo(x, y, wait = 20) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    button: 'none',
    buttons: 0
  })
  await sleep(wait)
}
async function clickPoint(x, y) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await sleep(40)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await sleep(250)
}
async function rightClick(x, y) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'right',
    clickCount: 1
  })
  await sleep(40)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'right',
    clickCount: 1
  })
  await sleep(500)
}
async function wheelAt(x, y, deltaY) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY,
    button: 'none',
    buttons: 0
  })
  await sleep(400)
}
async function key(k, code, vk) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: k,
    code,
    windowsVirtualKeyCode: vk
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  await sleep(250)
}
const rectOf = async (selector) =>
  JSON.parse(
    await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) })
    })()`)
  )
/** 一级分类行（面板内的 .ecm-item 全是分类） */
async function catPoint(label, hoverOnly = false) {
  const p = await ev(`(() => {
    const panel = document.querySelector('.ecm-panel:not(.ecm-sub)')
    if (!panel) return null
    const el = Array.from(panel.querySelectorAll('.ecm-item')).find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!p) return false
  const pt = JSON.parse(p)
  if (hoverOnly) await mouseMove(pt.x, pt.y)
  else await clickPoint(pt.x, pt.y)
  return true
}
/** 二级菜单里的动作 */
async function subPoint(label) {
  const p = await ev(`(() => {
    const sub = document.querySelector('.ecm-sub')
    if (!sub) return null
    const el = Array.from(sub.querySelectorAll('.ecm-item')).find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: el.disabled })
  })()`)
  return p ? JSON.parse(p) : null
}
const MENU = `(() => {
  const panel = document.querySelector('.ecm-panel:not(.ecm-sub)')
  const sub = document.querySelector('.ecm-sub')
  if (!panel) return JSON.stringify({ open: false })
  const r = panel.getBoundingClientRect()
  const subR = sub ? sub.getBoundingClientRect() : null
  return JSON.stringify({
    open: true,
    toolbar: Array.from(panel.querySelectorAll('.ecm-tool')).map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })),
    categories: Array.from(panel.querySelectorAll('.ecm-item')).map((b) => ({
      text: b.textContent.trim(), open: b.classList.contains('is-open'), active: b.classList.contains('is-active'), caret: !!b.querySelector('.ecm-caret')
    })),
    hasFooter: !!panel.querySelector('.ecm-foot'),
    panel: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
    sub: sub ? {
      title: sub.querySelector('.ecm-section')?.textContent?.trim() ?? null,
      items: Array.from(sub.querySelectorAll('.ecm-item')).map((b) => ({ text: b.textContent.trim().replace(/\\s+/g, ' '), disabled: b.disabled, danger: b.classList.contains('is-danger'), active: b.classList.contains('is-active') })),
      rect: { left: Math.round(subR.left), top: Math.round(subR.top), right: Math.round(subR.right), bottom: Math.round(subR.bottom) }
    } : null,
    vw: window.innerWidth, vh: window.innerHeight
  })
})()`
const USAGE = `(async () => JSON.stringify(await window.luminAPI.menuUsage.list(20)))()`
const SCROLL_TOP = `(() => { const el = document.querySelector('.editor-scroll') || document.scrollingElement; el.scrollTop = 0; return el.scrollTop })()`
const TABLE_INFO = `(() => {
  const ed = window.__vt.ed()
  let rows = 0, cols = 0
  ed.state.doc.descendants((n) => { if (n.type.name === 'table' && !rows) { rows = n.childCount; cols = n.child(0).childCount } })
  return JSON.stringify({ rows, cols })
})()`

const FILLER = Array.from({ length: 40 }, (_, i) => `填充段落 ${i + 1}。`)
const MD = [
  '# 右键菜单验收',
  '',
  '正文段落一。',
  '',
  ...FILLER.flatMap((t) => [t, '']),
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用段落',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '| 列A | 列B | 列C |',
  '| --- | --- | --- |',
  '| 1 | 2 | 3 |',
  '| 4 | 5 | 6 |',
  '',
  '结尾段落。'
].join('\n')

async function main() {
  const targets = await (await fetch(CDP)).json()
  let page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  if (!page) {
    console.log('NO-APP-PAGE')
    return
  }
  // NEW_WINDOW=1：在当前 app 里另开一个窗口跑验收，完全不碰用户窗口里的文档
  let tempWindow = null
  if (process.env.NEW_WINDOW === '1') {
    const opener = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      opener.onopen = res
      opener.onerror = rej
    })
    let oid = 0
    const opending = new Map()
    opener.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && opending.has(m.id)) {
        opending.get(m.id)(m)
        opending.delete(m.id)
      }
    }
    const osend = (method, params) =>
      new Promise((res) => {
        const i = ++oid
        opending.set(i, res)
        opener.send(JSON.stringify({ id: i, method, params }))
      })
    await osend('Runtime.evaluate', {
      expression: '(window.luminAPI.app.newWindow(), "ok")',
      returnByValue: true
    })
    // 以「窗口 id 集合的差集」判定新窗口：只看数量会在有残留窗口时误判（也可能选到用户窗口）
    const preexisting = new Set(
      targets.filter((t) => t.type === 'page' && t.url.includes('5173')).map((t) => t.id)
    )
    for (let i = 0; i < 60; i++) {
      await sleep(400)
      const list = await (await fetch(CDP)).json()
      const fresh = list.filter(
        (t) => t.type === 'page' && t.url.includes('5173') && !preexisting.has(t.id)
      )
      if (fresh.length) {
        page = fresh[fresh.length - 1]
        tempWindow = page
        break
      }
    }
    opener.close()
    if (!tempWindow) {
      console.log('SKIP: 第二个窗口未出现')
      return
    }
    console.log('（在第二个窗口里验收，用户窗口不受影响）')
  }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  await send('Page.enable')
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break
  }

  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym]
    window.__vt = { ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, menu: () => pinia._s.get('editorMenu') }
    return 'ok'
  })()`)
  await ev(
    `(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`
  )
  await sleep(400)

  const before = JSON.parse(
    await ev(
      `(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`
    )
  )
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (before.dirty) {
    console.log('SKIP: 当前文档有未保存修改')
    if (tempWindow) await send('Page.close').catch(() => {})
    ws.close()
    return
  }

  await ev(`window.luminAPI.menuUsage.reset()`)
  await ev(`(() => { window.__vt.menu().usage = {}; return 'ok' })()`)
  await ev(
    `(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`
  )
  await ev(
    `(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`
  )
  await ev(
    `(() => { window.__vt.files().setContent(${JSON.stringify(MD)}); window.__vt.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false }); return 'ok' })()`
  )
  await sleep(900)

  const paraPt = JSON.parse(
    await ev(`(() => {
    const ed = window.__vt.ed(); let pos = -1
    ed.state.doc.descendants((n, p) => { if (n.type.name === 'paragraph' && n.textContent.includes('正文段落一')) pos = p })
    const co = ed.view.coordsAtPos(pos + 3)
    return JSON.stringify({ x: Math.round(co.left + 16), y: Math.round(co.bottom - 4) })
  })()`)
  )

  // ── A. 一级总览 ──────────────────────────────────────────────────────────
  await rightClick(paraPt.x, paraPt.y)
  const menuA = JSON.parse(await ev(MENU))
  console.log(
    'A ' +
      JSON.stringify({
        categories: menuA.categories?.map((x) => x.text),
        panel: menuA.panel,
        sub: menuA.sub
      })
  )
  c('opens-on-right-click', menuA.open === true)
  c('toolbar-has-4-clipboard', menuA.toolbar?.length === 4, JSON.stringify(menuA.toolbar))
  c(
    'level1-is-categories',
    menuA.categories?.map((x) => x.text).join(',') === '段落,格式,插入',
    JSON.stringify(menuA.categories?.map((x) => x.text))
  )
  c('categories-have-caret', menuA.categories?.every((x) => x.caret === true) === true)
  c('no-submenu-before-hover', menuA.sub === null)
  c('panel-much-shorter', menuA.panel.h <= 220, 'h=' + menuA.panel.h + '（此前单级 578）')
  c(
    'no-table-category-outside-table',
    !menuA.categories?.some((x) => x.text === '表格'),
    JSON.stringify(menuA.categories?.map((x) => x.text))
  )
  c(
    'clamped-in-viewport',
    menuA.panel.left >= 0 &&
      menuA.panel.top >= 0 &&
      menuA.panel.right <= menuA.vw &&
      menuA.panel.bottom <= menuA.vh,
    JSON.stringify(menuA.panel)
  )

  // ── B. 悬停展开二级 ──────────────────────────────────────────────────────
  await catPoint('段落', true)
  const menuB = JSON.parse(await ev(MENU))
  console.log('B ' + JSON.stringify(menuB.sub))
  c(
    'hover-opens-submenu',
    !!menuB.sub && menuB.sub.title === '段落',
    JSON.stringify(menuB.sub?.title)
  )
  c(
    'submenu-has-headings',
    ['正文', '一级标题', '二级标题', '三级标题'].every((x) =>
      menuB.sub.items.some((i) => i.text.startsWith(x))
    ),
    JSON.stringify(menuB.sub.items.map((i) => i.text))
  )
  c(
    'submenu-right-of-panel',
    menuB.sub.rect.left >= menuB.panel.right - 2,
    JSON.stringify({ panelRight: menuB.panel.right, subLeft: menuB.sub.rect.left })
  )
  c(
    'category-marked-open',
    menuB.categories.find((x) => x.text.startsWith('段落'))?.open === true,
    JSON.stringify(menuB.categories)
  )

  // ── B2. 悬停连续性：指针必须能从一级分类行走到二级菜单上（本次修复点）────
  // 曾经的 bug：二级与一级之间留了 2px 空档，且 mouseleave 立即收起二级；
  // 指针移向二级的途中先离开一级面板（快速/斜向时 relatedTarget 常为 null），
  // 二级在指针到达前消失，表现为「怎么都移不到二级菜单上」。
  c(
    'submenu-flush-no-dead-gap',
    menuB.sub.rect.left <= menuB.panel.right,
    JSON.stringify({ panelRight: menuB.panel.right, subLeft: menuB.sub.rect.left })
  )

  /** 一级分类行靠外的一侧（离二级最近，最容易踩到空档）：fromRight=false 时取左端（翻转到左侧时用） */
  const rowEdge = async (label, fromRight = true) =>
    JSON.parse(
      await ev(`(() => {
        const panel = document.querySelector('.ecm-panel:not(.ecm-sub)')
        if (!panel) return 'null'
        const el = Array.from(panel.querySelectorAll('.ecm-item')).find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))
        if (!el) return 'null'
        const r = el.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(${fromRight ? 'r.right - 10' : 'r.left + 10'}), y: Math.round(r.top + r.height / 2), left: Math.round(r.left), right: Math.round(r.right) })
      })()`)
    )

  await ev(`window.__vt.menu().close()`)
  await sleep(250)
  await rightClick(paraPt.x, paraPt.y)
  const rowPt = await rowEdge('段落')
  await moveTo(rowPt.x, rowPt.y, 220)
  const subTarget = await rectOf('.ecm-sub')
  // 终点：二级最左边缘内侧 12px，**保持与分类行同一水平带**（真实用户的移动方式）。
  // 二级顶部与分类行对齐（row.top - 6），同一水平带内必定命中二级；
  // 斜向下横穿其它分类行时语义上就该切换分类，那不是本 bug。
  const landing = { x: subTarget.left + 12, y: rowPt.y }
  const steps = 14
  let keptOpen = 0
  for (let i = 1; i <= steps; i++) {
    await moveTo(rowPt.x + ((landing.x - rowPt.x) * i) / steps, landing.y, 25)
    if (await ev(`!!document.querySelector('.ecm-sub')`)) keptOpen++
  }
  const atSub = JSON.parse(
    await ev(`(() => {
      const el = document.elementFromPoint(${landing.x}, ${landing.y})
      return JSON.stringify({
        insideSub: !!el?.closest?.('.ecm-sub'),
        tag: el?.className ?? null,
        title: document.querySelector('.ecm-sub .ecm-section')?.textContent?.trim() ?? null,
        section: window.__vt.menu().activeSectionId
      })
    })()`)
  )
  console.log('B2-cross ' + JSON.stringify({ steps, keptOpen, landing, subTarget, atSub }))
  c('pointer-crosses-into-submenu-keeps-open', keptOpen === steps, `keptOpen=${keptOpen}/${steps}`)
  c('pointer-lands-inside-submenu', atSub.insideSub === true, JSON.stringify(atSub))
  c(
    'crossing-keeps-category',
    atSub.title === '段落' && atSub.section === 'paragraph',
    JSON.stringify({ title: atSub.title, section: atSub.section })
  )

  // 悬停二级条目应即时高亮（证明指针真的在二级上，而非二级只是「渲染着」）
  const itemPt = await subPoint('一级标题')
  if (!itemPt) throw new Error('subPoint 未找到「一级标题」：' + (await ev(MENU)))
  await moveTo(itemPt.x, itemPt.y, 200)
  const hoverState = JSON.parse(
    await ev(`(() => {
      const sub = document.querySelector('.ecm-sub'); if (!sub) return 'null'
      const items = Array.from(sub.querySelectorAll('.ecm-item'))
      return JSON.stringify({ hasActive: !!sub.querySelector('.ecm-item.is-active'), activeIdx: window.__vt.menu().activeSubIndex, idx: items.indexOf(document.elementFromPoint(${itemPt.x}, ${itemPt.y})?.closest?.('.ecm-item')) })
    })()`)
  )
  c(
    'submenu-item-hover-highlights',
    hoverState.hasActive === true && hoverState.activeIdx === hoverState.idx,
    JSON.stringify(hoverState)
  )

  // 宽限窗口：离开二级 8px 内外、80ms 内折返 → 仍保持展开（160ms 宽限）
  const outPt = { x: subTarget.right + 10, y: landing.y }
  await moveTo(outPt.x, outPt.y, 80)
  await moveTo(landing.x, landing.y, 260)
  const keptByGrace = await ev(`!!document.querySelector('.ecm-sub')`)
  c('reenter-within-grace-keeps-submenu', keptByGrace === true, 'kept=' + keptByGrace)
  // 反向对照：离开并超过宽限 → 应收起（宽限不能变成「永不收起」）
  await moveTo(outPt.x, outPt.y, 420)
  const closedByGrace = await ev(`!!document.querySelector('.ecm-sub')`)
  c('leave-beyond-grace-closes-submenu', closedByGrace === false, 'open=' + closedByGrace)
  // 回到分类行：应立即重新展开（不残留延迟）
  await moveTo(rowPt.x, rowPt.y, 220)
  const reopened = await ev(`!!document.querySelector('.ecm-sub')`)
  c('rehover-reopens-submenu', reopened === true, 'open=' + reopened)

  // ── B2b. 「先向下、再向右」取二级下半段：指针会经过面板下方的空档 ─────────
  // 二级(299px)比一级(159px)高，下半段挂在面板下方；用户取下半段的条目时自然
  // 先向下再向右，途中短暂处于「既不在面板、也不在二级」的区域 —— 这正是
  // 「偶发移不到二级菜单上」的残留路径（比纯横向移动更容易触发）。
  const panelNow = await rectOf('.ecm-panel:not(.ecm-sub)')
  const subNow = await rectOf('.ecm-sub')
  const downLeg = { x: rowPt.x, y: subNow.bottom - 30 }
  let downKept = true
  for (let i = 1; i <= 14; i++) {
    await moveTo(rowPt.x, rowPt.y + ((downLeg.y - rowPt.y) * i) / 14, 40)
    if (!(await ev(`!!document.querySelector('.ecm-sub')`))) downKept = false
  }
  const zoneState = JSON.parse(
    await ev(`(() => {
      const el = document.elementFromPoint(${downLeg.x}, ${downLeg.y})
      return JSON.stringify({
        inPanel: !!el?.closest?.('.ecm-panel:not(.ecm-sub)'),
        inSub: !!el?.closest?.('.ecm-sub'),
        over: el?.className?.toString?.().slice(0, 40) ?? null
      })
    })()`)
  )
  // 右移进入二级：**必须重新测量**二级矩形——向下这一路悬停到了别的分类行上，
  // 二级会跟着换到那条分类（悬停即切换），旧坐标已失效。
  const subNow2 = await rectOf('.ecm-sub')
  const rightLeg = { x: subNow2.left + 30, y: Math.min(subNow2.bottom - 20, downLeg.y) }
  let rightKept = 0
  for (let i = 1; i <= 8; i++) {
    await moveTo(downLeg.x + ((rightLeg.x - downLeg.x) * i) / 8, rightLeg.y, 30)
    if (await ev(`!!document.querySelector('.ecm-sub')`)) rightKept++
  }
  const landState = JSON.parse(
    await ev(`(() => {
      const el = document.elementFromPoint(${rightLeg.x}, ${rightLeg.y})
      return JSON.stringify({ insideSub: !!el?.closest?.('.ecm-sub'), title: document.querySelector('.ecm-sub .ecm-section')?.textContent?.trim() ?? null })
    })()`)
  )
  console.log(
    'B2b-below-panel ' +
      JSON.stringify({
        panelBottom: panelNow.bottom,
        subBottom: subNow.bottom,
        downLeg,
        downKept,
        zoneState,
        rightLeg,
        rightKept,
        landState
      })
  )
  c(
    'below-panel-path-keeps-submenu',
    downKept === true,
    'kept=' + downKept + ' | ' + JSON.stringify(zoneState)
  )
  c(
    'deadzone-is-outside-both',
    zoneState.inPanel === false && zoneState.inSub === false,
    JSON.stringify(zoneState)
  )
  c(
    'reaching-submenu-from-below',
    rightKept === 8 && landState.insideSub === true,
    JSON.stringify({ rightKept, landState })
  )
  // 向下这一路会穿过「格式」「插入」两个分类行。**悬停即切换（零延迟）**是主流系统
  // 菜单的行为，所以此处断言的是「分类跟着指针走」：最后停在哪个分类行上，二级就是它。
  // （早先这里断言「路过不切换」，对应的是后来被用户否掉的那个 180ms 悬停延迟。）
  const lastCatLabel = await ev(`(() => {
      const panel = document.querySelector('.ecm-panel:not(.ecm-sub)')
      const rows = panel ? [...panel.querySelectorAll('.ecm-item')] : []
      const last = rows[rows.length - 1]
      return last ? last.textContent.trim() : null
    })()`)
  c(
    'pass-through-follows-hover',
    landState.title !== null && landState.title === lastCatLabel,
    JSON.stringify({ title: landState.title, expectLast: lastCatLabel })
  )
  // 悬停另一个分类行 → 立即切换（无延迟，用户反馈的正是这个「慢」）
  const fmtRow = await rowEdge('格式')
  await moveTo(fmtRow.x, fmtRow.y, 300)
  const fmtState = JSON.parse(
    await ev(
      `(() => JSON.stringify({ title: document.querySelector('.ecm-sub .ecm-section')?.textContent?.trim() ?? null, section: window.__vt.menu().activeSectionId }))()`
    )
  )
  console.log('B2b-hover ' + JSON.stringify(fmtState))
  c(
    'hover-switches-category-instantly',
    fmtState.title === '格式' && fmtState.section === 'format',
    JSON.stringify(fmtState)
  )

  // ── B3. 贴右边缘翻转（二级出现在左侧）时同样必须可移入 ───────────────────
  await ev(`window.__vt.menu().close()`)
  await sleep(250)
  const rightPt = JSON.parse(
    await ev(
      `(() => { const co = window.__vt.ed().view.coordsAtPos(0); return JSON.stringify({ x: window.innerWidth - 30, y: Math.round(co.bottom) }) })()`
    )
  )
  await rightClick(rightPt.x, rightPt.y)
  const menuFlip = JSON.parse(await ev(MENU))
  const flipRow = await rowEdge('段落', false)
  await moveTo(flipRow.x, flipRow.y, 240)
  const flipSub = await rectOf('.ecm-sub')
  const flipLanding = { x: flipSub.right - 12, y: flipRow.y }
  let flipKeptOpen = 0
  const flipSteps = 12
  for (let i = 1; i <= flipSteps; i++) {
    await moveTo(flipRow.x - ((flipRow.x - flipLanding.x) * i) / flipSteps, flipLanding.y, 25)
    if (await ev(`!!document.querySelector('.ecm-sub')`)) flipKeptOpen++
  }
  const flipState = JSON.parse(
    await ev(`(() => {
      const el = document.elementFromPoint(${flipLanding.x}, ${flipLanding.y})
      return JSON.stringify({ insideSub: !!el?.closest?.('.ecm-sub'), tag: el?.className ?? null, title: document.querySelector('.ecm-sub .ecm-section')?.textContent?.trim() ?? null })
    })()`)
  )
  console.log(
    'B3-flip ' +
      JSON.stringify({
        panel: menuFlip.panel,
        flipRow,
        flipSub,
        flipLanding,
        flipKeptOpen,
        flipState
      })
  )
  c(
    'flipped-submenu-left-of-panel',
    flipSub.right <= menuFlip.panel.left + 1,
    JSON.stringify({ panelLeft: menuFlip.panel.left, subRight: flipSub.right })
  )
  c('flipped-crossing-keeps-open', flipKeptOpen === flipSteps, `kept=${flipKeptOpen}/${flipSteps}`)
  c(
    'flipped-lands-inside-submenu',
    flipState.insideSub === true && flipState.title === '段落',
    JSON.stringify(flipState)
  )

  // ── C. 菜单内部滚动不关闭；文档滚动关闭 ─────────────────────────────────
  const subRect = await rectOf('.ecm-sub .ecm-item')
  await wheelAt(subRect.x, subRect.y, 120)
  const afterInnerScroll = await ev(`!!document.querySelector('.ecm-panel')`)
  console.log('C-inner-scroll open=' + afterInnerScroll)
  c('inner-scroll-keeps-menu', afterInnerScroll === true)

  await rightClick(paraPt.x, paraPt.y)
  const paneRect = JSON.parse(
    await ev(
      `(() => { const el = document.querySelector('.editor-scroll') || document.querySelector('.ProseMirror'); const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width - 40), y: Math.round(r.top + 40) }) })()`
    )
  )
  await wheelAt(paneRect.x, paneRect.y, 400)
  const afterDocScroll = await ev(`!!document.querySelector('.ecm-panel')`)
  const scrolled = await ev(
    `(() => { const el = document.querySelector('.editor-scroll') || document.scrollingElement; return Math.round(el.scrollTop) })()`
  )
  console.log('C-doc-scroll open=' + afterDocScroll + ' scrollTop=' + scrolled)
  c(
    'doc-scroll-closes-menu',
    afterDocScroll === false && scrolled > 0,
    JSON.stringify({ afterDocScroll, scrolled })
  )
  await ev(SCROLL_TOP)
  await sleep(300)

  // ── G. 键盘：↓ 移动一级、→ 进二级、↓↓ 移动、Esc 逐级退出 ──────────────
  await ev(SCROLL_TOP)
  await sleep(300)
  await rightClick(paraPt.x, paraPt.y)
  // 把指针移开面板，避免鼠标悬停干扰高亮，同时确定 store 里的初始状态
  await mouseMove(24, 24)
  const gState = async () =>
    JSON.parse(
      await ev(
        `(() => { const m = window.__vt.menu(); return JSON.stringify({ open: m.open, activeIndex: m.activeIndex, section: m.activeSectionId, subIndex: m.activeSubIndex, cats: m.categories.length, subOpen: !!document.querySelector('.ecm-sub') }) })()`
      )
    )
  const g0 = await gState()
  await key('ArrowDown', 'ArrowDown', 40)
  const g1 = await gState()
  console.log('G-nav ' + JSON.stringify({ g0, g1 }))
  c(
    'arrow-down-moves-category',
    g1.activeIndex === (g0.activeIndex + 1) % g0.cats,
    JSON.stringify({ from: g0.activeIndex, to: g1.activeIndex })
  )
  await key('ArrowRight', 'ArrowRight', 39)
  const g2 = await gState()
  const catLabel = JSON.parse(
    await ev(
      `(() => { const m = window.__vt.menu(); const c = m.categories[m.activeIndex]; return JSON.stringify({ id: c.id, items: c.items.length }) })()`
    )
  )
  c(
    'arrow-right-opens-submenu',
    g2.section === catLabel.id && g2.subOpen === true,
    JSON.stringify({ section: g2.section, expect: catLabel.id })
  )
  await key('ArrowDown', 'ArrowDown', 40)
  const g3 = await gState()
  c('arrow-down-in-submenu', g3.subIndex === 1, 'subIndex=' + g3.subIndex)
  await key('Escape', 'Escape', 27)
  const g4 = await gState()
  c(
    'esc-closes-submenu-first',
    g4.open === true && g4.section === null && g4.subOpen === false,
    JSON.stringify(g4)
  )
  await key('Escape', 'Escape', 27)
  c('esc-then-closes-menu', (await ev(`!!document.querySelector('.ecm-panel')`)) === false)

  // Esc 关掉二级后，不能被「悬停在别的分类行上」留下的待切换计时器重新打开
  await rightClick(paraPt.x, paraPt.y)
  const escRow = await rowEdge('段落')
  await moveTo(escRow.x, escRow.y, 250)
  const otherRow = await rowEdge('格式')
  await moveTo(otherRow.x, otherRow.y, 60) // 只停留 60ms（< CAT_SWITCH_DELAY 180ms）
  await key('Escape', 'Escape', 27)
  await sleep(400)
  const escState = JSON.parse(
    await ev(
      `(() => JSON.stringify({ open: !!document.querySelector('.ecm-panel'), sub: !!document.querySelector('.ecm-sub'), section: window.__vt.menu().activeSectionId }))()`
    )
  )
  console.log('G-esc-stale ' + JSON.stringify(escState))
  c(
    'esc-not-reopened-by-stale-switch',
    escState.open === true && escState.sub === false && escState.section === null,
    JSON.stringify(escState)
  )
  await ev(`window.__vt.menu().close()`)
  await sleep(200)

  // 点击外部关闭
  await rightClick(paraPt.x, paraPt.y)
  await clickPoint(30, 30)
  c('outside-click-closes', (await ev(`!!document.querySelector('.ecm-panel')`)) === false)

  // ── E. 执行 + 持久化：把「正文段落一」变成二级标题 ───────────────────────
  await rightClick(paraPt.x, paraPt.y)
  await catPoint('段落', true)
  const subClick = await subPoint('二级标题')
  await clickPoint(subClick.x, subClick.y)
  await sleep(700)
  const docState = JSON.parse(
    await ev(`(() => {
    const ed = window.__vt.ed()
    let h2 = 0
    ed.state.doc.descendants((n) => { if (n.type.name === 'heading' && n.attrs.level === 2 && n.textContent.includes('正文段落一')) h2++ })
    return JSON.stringify({ h2 })
  })()`)
  )
  const usageE = JSON.parse(await ev(USAGE))
  console.log(
    'E ' +
      JSON.stringify({
        docState,
        usageE,
        menuClosed: (await ev(`!!document.querySelector('.ecm-panel')`)) === false
      })
  )
  c('submenu-action-executes', docState.h2 === 1, JSON.stringify(docState))
  c('menu-closed-after-run', (await ev(`!!document.querySelector('.ecm-panel')`)) === false)
  c(
    'usage-persisted',
    usageE.some((u) => u.actionId === 'paragraph.h2' && u.count >= 1),
    JSON.stringify(usageE)
  )
  c('editor-refocused', (await ev(`!!document.querySelector('.ProseMirror-focused')`)) === true)

  // ── F. 最近使用分类 ──────────────────────────────────────────────────────
  await rightClick(paraPt.x, paraPt.y)
  const menuF = JSON.parse(await ev(MENU))
  const firstCat = menuF.categories?.[0]?.text
  await catPoint('最近使用', true)
  const menuF2 = JSON.parse(await ev(MENU))
  console.log(
    'F ' +
      JSON.stringify({
        cats: menuF.categories?.map((x) => x.text),
        recentItems: menuF2.sub?.items.map((i) => i.text)
      })
  )
  c(
    'recent-category-appears',
    firstCat === '最近使用',
    JSON.stringify(menuF.categories?.map((x) => x.text))
  )
  c(
    'recent-lists-used-action',
    menuF2.sub?.items.some((i) => i.text.startsWith('二级标题')) === true,
    JSON.stringify(menuF2.sub?.items.map((i) => i.text))
  )

  const footClicked = await ev(
    `(() => { const btn = document.querySelector('.ecm-foot'); if (!btn) return false; btn.click(); return true })()`
  )
  await sleep(600)
  const usageF = JSON.parse(await ev(USAGE))
  const clearedState = JSON.parse(
    await ev(
      `(() => { const m = window.__vt.menu(); return JSON.stringify({ recent: m.recentIds.length }) })()`
    )
  )
  await ev(`window.__vt.menu().close()`)
  await sleep(250)
  await rightClick(paraPt.x, paraPt.y)
  const menuF3 = JSON.parse(await ev(MENU))
  console.log(
    'F-clear ' +
      JSON.stringify({
        footClicked,
        usageF,
        clearedState,
        cats: menuF3.categories?.map((x) => x.text)
      })
  )
  c(
    'clear-recent-works',
    footClicked === true &&
      usageF.length === 0 &&
      clearedState.recent === 0 &&
      !menuF3.categories?.some((x) => x.text === '最近使用'),
    JSON.stringify({ usageF, clearedState, cats: menuF3.categories?.map((x) => x.text) })
  )
  await ev(`window.__vt.menu().close()`)

  // ── D. 表格上下文 ───────────────────────────────────────────────────────
  await ev(
    `(() => { const tb = document.querySelector('.ProseMirror table'); if (tb) tb.scrollIntoView({ block: 'center' }); return 'ok' })()`
  )
  await sleep(500)
  const cellPt = JSON.parse(
    await ev(
      `(() => { const c = document.querySelector('.ProseMirror table td, .ProseMirror table th'); const r = c.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`
    )
  )
  await rightClick(cellPt.x, cellPt.y)
  const menuD = JSON.parse(await ev(MENU))
  await catPoint('表格', true)
  const menuD2 = JSON.parse(await ev(MENU))
  console.log(
    'D ' +
      JSON.stringify({
        cats: menuD.categories?.map((x) => x.text),
        items: menuD2.sub?.items.map((i) => i.text)
      })
  )
  c(
    'table-category-in-table',
    menuD.categories?.[0]?.text === '表格',
    JSON.stringify(menuD.categories?.map((x) => x.text))
  )
  c(
    'table-actions-complete',
    menuD2.sub?.items.length === 8,
    JSON.stringify(menuD2.sub?.items.map((i) => i.text))
  )
  c(
    'danger-styled-deletions',
    menuD2.sub?.items.filter((i) => i.danger).length === 3,
    JSON.stringify(menuD2.sub?.items.filter((i) => i.danger).map((i) => i.text))
  )

  const t0 = JSON.parse(await ev(TABLE_INFO))
  const rowBtn = await subPoint('下方插入行')
  await clickPoint(rowBtn.x, rowBtn.y)
  await sleep(700)
  const t1 = JSON.parse(await ev(TABLE_INFO))
  c('table-action-executes', t1.rows === t0.rows + 1, JSON.stringify({ before: t0, after: t1 }))

  // 表格分类里的「插入表格」应在「插入」二级菜单中被禁用
  await rightClick(cellPt.x, cellPt.y)
  await catPoint('插入', true)
  const insertSub = JSON.parse(await ev(MENU))
  const insertTableItem = insertSub.sub?.items.find((i) => i.text.startsWith('插入表格'))
  c(
    'insert-table-disabled-in-table',
    insertTableItem?.disabled === true,
    JSON.stringify(insertTableItem)
  )
  await ev(`window.__vt.menu().close()`)

  // ── H. 源码视图不接管 ───────────────────────────────────────────────────
  await ev(`(() => { window.__vt.ui().editorMode = 'source'; return 'ok' })()`)
  await sleep(500)
  const srcPt = JSON.parse(
    await ev(
      `(() => { const ta = document.querySelector('textarea'); const r = ta.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 60), y: Math.round(r.top + 40) }) })()`
    )
  )
  await rightClick(srcPt.x, srcPt.y)
  c('source-mode-not-hijacked', (await ev(`!!document.querySelector('.ecm-panel')`)) === false)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)

  // 复原
  await ev(`(async () => {
    window.__vt.menu().close()
    const f = window.__vt.files()
    await f.close()
    ${before.path ? `await f.openPath(${JSON.stringify(before.path)})` : ''}
    await window.luminAPI.drafts.remove('untitled')
    await window.luminAPI.menuUsage.reset()
    window.__vt.menu().usage = {}
    return 'ok'
  })()`)
  await sleep(500)
  const restored = JSON.parse(
    await ev(
      `(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`
    )
  )
  c('state-restored', restored.path === before.path, JSON.stringify(restored))

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  if (tempWindow) {
    await send('Page.close').catch(() => {})
    await sleep(400)
  }
  ws.close()
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
