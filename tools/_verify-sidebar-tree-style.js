// 验收：侧栏文件树的视觉规范（简约大气 / 大厂风）
//
// 断言（全部按 DOM 实测，不写死观感）：
//  A. 行：等高 29px、圆角 0（直角）、字号 13px；每级缩进 16px（图标槽与文字各测一次）
//     行高 29px（原 27px）：`.tree-label` 的 overflow:hidden 会把 13px 字号的降部
//     （`g`/`y`/`p`）裁掉，行盒必须比字形高（见 CSS 里的说明与断言 row-label-line-height-fits-glyphs）
//  B. 图标：文件夹与文件**同色且中性**（不再用琥珀色的 warning 混色）；选中时一起转 accent
//  C. 状态：默认 ink-2；悬停（真实指针）底色 panel-2 + 文字 ink；选中 accent-soft + accent + 500 字重，
//     且**没有**左侧那条 3px 浅灰色条（用户口径 §4.79：选中已有三重提示，灰条是第四重噪音）
//  D. 展开箭头：收起时不变换、展开时正好旋转 90°
//  E. 空文件夹提示文字与同级子项文字左对齐（±1px）
//  F. 展开/收起用轻量过渡（≤200ms 内完成且不带 scale）
//  G. 三套主题下选中底色/字色都来自令牌
//  H. 两段式：侧栏是**外壳（chrome）**不是纸 —— 底色 = --app，且纸（--paper）比它亮一档；
//     选中药丸（accent-soft）压在 chrome 上仍然看得清（否则文件树的选中态失去依托）
//  （另存三张侧栏截图到 %TEMP% 供人工看观感）
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { contrast, over, rgbText, rat, sameColor } = require('./lib/color')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
}

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
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
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails)
      throw new Error(
        'EXC ' +
          JSON.stringify(
            r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text
          ).slice(0, 300)
      )
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = app._context.provides[sym]
  window.__S = {
    files: () => pinia._s.get('files'),
    ui: () => pinia._s.get('ui'),
    settings: () => pinia._s.get('settings'),
    ed: () => pinia._s.get('editor')?.instance ?? null
  }
  return 'ok'
})()`

/**
 * 等启动骨架（z-[300] 的全屏占位）退场。
 *
 * 为什么必须先等：骨架盖在整个窗口之上，`elementFromPoint` 会命中骨架元素本身，真实指针
 * 也点不到文件树（实测那把命中的是 `w-[264px] … space-y-2.5` 的侧栏骨架）。此前的 hover
 * 探针就是因此拿到 null → `null.closest()` 抛 TypeError，整套 0/0 FAIL；点击选中那几条
 * 也会静默失效（读到的永远是未选中态）。
 */
async function waitSkeletonGone(ev, maxMs = 20000) {
  const end = Date.now() + maxMs
  while (Date.now() < end) {
    const busy = await ev(
      `window.__S.ui().booting ? true : !!document.querySelector('.skeleton')`
    ).catch(() => true)
    if (!busy) return true
    await sleep(200)
  }
  return false
}

/** 采样：所有树行的几何/颜色/箭头状态 + 令牌解析值 */
const MEASURE = `(() => {
  const tok = (name) => {
    const p = document.createElement('span')
    p.style.color = 'var(' + name + ')'
    document.body.appendChild(p)
    const c = getComputedStyle(p).color
    p.remove()
    return c
  }
  const rows = [...document.querySelectorAll('[data-tree-row]')]
  const rowInfo = rows.map((r) => {
    const cs = getComputedStyle(r)
    const typeIcon = r.querySelector('[data-tree-icon]') ?? r.querySelector('svg')
    const chevron = r.querySelector('[data-tree-chevron]')
    const label = [...r.children].find((c) => c.tagName === 'SPAN' && c.textContent.trim())
    const rect = r.getBoundingClientRect()
    const labelRect = label?.getBoundingClientRect()
    return {
      depth: Number(r.getAttribute('data-depth')),
      type: r.getAttribute('data-tree-type'),
      name: (label?.textContent || '').trim().slice(0, 24),
      height: Math.round(rect.height * 10) / 10,
      left: Math.round(rect.left),
      labelLeft: labelRect ? Math.round(labelRect.left) : null,
      radius: cs.borderRadius,
      fontSize: cs.fontSize,
      // 行盒（.tree-label 的 line-height，无单位 → computed 给 px）：必须比字号大，
      // 否则 overflow:hidden 会裁掉 g/y/p 的降部（用户报「字母显示不全」）
      labelLineHeight: label ? parseFloat(getComputedStyle(label).lineHeight) || 0 : 0,
      fontWeight: cs.fontWeight,
      color: cs.color,
      bg: cs.backgroundColor,
      transition: cs.transitionProperty + ' ' + cs.transitionDuration,
      iconColor: typeIcon ? getComputedStyle(typeIcon).color : null,
      iconSize: typeIcon ? Math.round(typeIcon.getBoundingClientRect().width) : null,
      slotLeft: r.querySelector('.tree-chevron-slot') ? Math.round(r.querySelector('.tree-chevron-slot').getBoundingClientRect().left) : null,
      // 箭头旋转可能在 transform 上，也可能在 rotate 长属性上；两个都取
      chevronTransform: chevron ? getComputedStyle(chevron).transform : null,
      chevronRotate: chevron ? getComputedStyle(chevron).rotate : null,
      chevronTransition: chevron ? getComputedStyle(chevron).transitionProperty + ' ' + getComputedStyle(chevron).transitionDuration : null
    }
  })
  const scroll = document.querySelector('[data-tree-scroll]')
  const hint = document.querySelector('[data-tree-empty-folder]')
  const aside = document.querySelector('aside')
  return JSON.stringify({
    tokens: { ink: tok('--ink'), ink2: tok('--ink-2'), ink3: tok('--ink-3'), panel2: tok('--panel-2'), accent: tok('--accent'), accentSoft: tok('--accent-soft'), paper: tok('--paper'), app: tok('--app'), panel: tok('--panel') },
    // 外壳（chrome）实测色：侧栏自己 + body（body 的底色就是 --app）
    chrome: { sidebar: aside ? getComputedStyle(aside).backgroundColor : null, body: getComputedStyle(document.body).backgroundColor },
    rows: rowInfo,
    hint: hint
      ? {
          // 文本左边缘 = 盒子左边缘 + padding-left（提示没有图标，要对齐到子项「文字」的位置）
          textLeft: Math.round(hint.getBoundingClientRect().left + parseFloat(getComputedStyle(hint).paddingLeft)),
          fontSize: getComputedStyle(hint).fontSize,
          text: hint.textContent.trim()
        }
      : null,
    scrollPad: scroll ? getComputedStyle(scroll).padding : null
  })
})()`

;(async () => {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const pages = (await get('/json/list')).filter(
    (t) => t.type === 'page' && /index\.html|5173/.test(t.url)
  )
  if (!pages.length) return console.log('SKIP: 没有可用窗口')
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  await w.send('Page.bringToFront')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (
      (await w.ev(SETUP)) === 'ok' &&
      (await w.ev(`window.__S.ui().booting ? 'booting' : 'ready'`)) === 'ready'
    )
      break
  }
  await w.ev(SETUP)
  // 骨架没退场就往下走的话，后面所有「真实指针」的断言都会量到骨架而不是文件树
  const booted = await waitSkeletonGone(w.ev)
  console.log('BOOT ' + JSON.stringify({ skeletonGone: booted }))
  c(
    'boot-skeleton-gone',
    booted,
    '启动骨架必须在量指针类断言前退场（否则 elementFromPoint 命中骨架）'
  )

  // 夹具工作区：三层目录 + 空目录 + 根下文件
  const ws = path.join(os.tmpdir(), 'lumin-tree-ws')
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'docs', 'deep', 'nested'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'empty'), { recursive: true })
  // 留一个**不展开**的目录，用来量未展开时箭头的状态
  fs.mkdirSync(path.join(ws, 'later'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'notes.md'), '# notes\n\nhello\n', 'utf-8')
  fs.writeFileSync(path.join(ws, 'docs', 'guide.md'), '# guide\n', 'utf-8')
  fs.writeFileSync(path.join(ws, 'docs', 'deep', 'inner.md'), '# inner\n', 'utf-8')
  fs.writeFileSync(path.join(ws, 'docs', 'deep', 'nested', 'deep.md'), '# deep\n', 'utf-8')
  fs.writeFileSync(path.join(ws, 'later', 'later.md'), '# later\n', 'utf-8')

  try {
    await w.ev(
      `(async () => { await window.__S.files().openUntitled(); await window.__S.files().setRoot(${JSON.stringify(ws)}); return 'ok' })()`
    )
    await w.ev(
      `(() => { window.__S.ui().sidebarVisible = true; window.__S.ui().sidebarTab = 'files'; window.__S.ui().sidebarFilesView = 'tree'; return 'ok' })()`
    )
    await sleep(1200)
    // 展开 docs → deep → nested，张开空目录 empty
    for (const rel of ['docs', 'docs\\deep', 'docs\\deep\\nested', 'empty']) {
      await w.ev(
        `(async () => { await window.__S.files().toggleDir(${JSON.stringify(path.join(ws, rel))}); return 'ok' })()`
      )
      await sleep(350)
    }
    await sleep(600)

    const m = JSON.parse(await w.ev(MEASURE))
    console.log('SCROLLPAD ' + JSON.stringify(m.scrollPad))
    console.log(
      'ROWS ' +
        JSON.stringify(
          m.rows.map((r) => ({
            d: r.depth,
            t: r.type,
            n: r.name,
            h: r.height,
            ll: r.labelLeft,
            col: r.color,
            bg: r.bg,
            icon: r.iconColor
          })),
          null,
          0
        )
    )
    console.log('HINT ' + JSON.stringify(m.hint))
    const rows = m.rows
    c('has-rows', rows.length >= 6, 'rows=' + rows.length)
    if (!rows.length) {
      console.log(results.join('\n'))
      console.log(
        `--- ${results.filter((r) => r.startsWith('PASS')).length}/${results.length} PASS`
      )
      w.ws.close()
      return process.exit(1)
    }

    // A. 几何
    const heights = [...new Set(rows.map((r) => r.height))]
    c(
      'row-height-32',
      heights.length === 1 && Math.abs(heights[0] - 32) <= 0.6,
      JSON.stringify(heights)
    )
    // 行高必须装得下字形：`.tree-label` 的 overflow:hidden 会裁掉降部（`g`/`y`/`p`）。
    // 判据用 line-height（行盒）而不是实测墨迹 —— 墨迹测量受字体回退影响，行盒是确定值。
    c(
      'row-label-line-height-fits-glyphs',
      rows.every((r) => r.labelLineHeight >= 13 * 1.25 - 0.1),
      JSON.stringify([...new Set(rows.map((r) => r.labelLineHeight))])
    )
    // 直角（本轮起）：树行的选中/hover 底色要贯通侧栏整宽，圆形药丸与两侧边界对不齐
    c(
      'row-square-corners',
      rows.every((r) => r.radius === '0px' || r.radius === '0'),
      rows[0].radius
    )
    c(
      'font-13',
      rows.every((r) => r.fontSize === '13px'),
      rows[0].fontSize
    )
    const byDepth = (d) => rows.find((r) => r.depth === d)
    const steps = []
    for (let d = 0; d < 3; d++) {
      const a = byDepth(d)
      const b = byDepth(d + 1)
      if (a && b) steps.push({ d, label: b.labelLeft - a.labelLeft, slot: b.slotLeft - a.slotLeft })
    }
    // 行盒子是整宽的（left 不变是设计如此），缩进体现在图标槽与文字上
    c(
      'indent-step-16',
      steps.length >= 2 && steps.every((s) => s.label === 16 && s.slot === 16),
      JSON.stringify(steps)
    )

    // B. 图标：类型图标（文件夹/文件）同色且就是 --ink-3，不再有琥珀混色
    const typeIconCols = [...new Set(rows.map((r) => r.iconColor))]
    c('icons-monochrome-same', typeIconCols.length === 1, JSON.stringify(typeIconCols))
    c(
      'icons-match-ink3-token',
      typeIconCols[0] === m.tokens.ink3,
      JSON.stringify({ icon: typeIconCols[0], ink3: m.tokens.ink3 })
    )
    c(
      'type-icon-15px',
      rows.every((r) => r.iconSize === 15),
      JSON.stringify([...new Set(rows.map((r) => r.iconSize))])
    )

    // C. 状态色
    c(
      'default-text-ink2',
      rows.filter((r) => r.bg === 'rgba(0, 0, 0, 0)').every((r) => r.color === m.tokens.ink2),
      JSON.stringify({ color: rows[0].color, ink2: m.tokens.ink2 })
    )
    c(
      'no-transparent-selection',
      rows.every((r) => r.bg === 'rgba(0, 0, 0, 0)' || r.bg === m.tokens.accentSoft),
      JSON.stringify([...new Set(rows.map((r) => r.bg))])
    )
    c(
      'color-transition-kept',
      rows.every((r) => r.transition.includes('color')),
      rows[0].transition
    )

    // 悬停：真实指针（挑一个文件行）
    // 量坐标前先把它滚进视口：`elementFromPoint` 对**视口之外**的坐标返回 null，
    // 而 null.closest(...) 会直接抛 TypeError —— 那一版在这里整套 0/0 FAIL（行多/窗矮时必现）。
    const fileRow = rows.find((r) => r.type === 'file' && r.depth > 0)
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fileRow.left + 60, y: 0 })
    const fileRect = JSON.parse(
      await w.ev(
        `(() => {
          const el = [...document.querySelectorAll('[data-tree-row]')].find((r) => Number(r.getAttribute('data-depth')) === ${fileRow.depth} && r.getAttribute('data-tree-type') === 'file')
          if (!el) return JSON.stringify({ err: 'no-row' })
          el.scrollIntoView({ block: 'center' })
          const b = el.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) })
        })()`
      )
    )
    console.log('HOVER-TARGET ' + JSON.stringify(fileRect))
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fileRect.x, y: fileRect.y })
    await sleep(300)
    const hovered = JSON.parse(
      await w.ev(
        `(() => {
          const hit = document.elementFromPoint(${fileRect.x}, ${fileRect.y})
          const el = (hit && hit.closest('[data-tree-row]')) || document.querySelector('[data-tree-row]:hover')
          if (!el) return JSON.stringify({ err: 'no-row-at-point', hit: hit ? hit.className || hit.tagName : null })
          const cs = getComputedStyle(el)
          return JSON.stringify({ bg: cs.backgroundColor, color: cs.color })
        })()`
      )
    )
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
    await sleep(200)
    console.log(
      'HOVER ' +
        JSON.stringify({ ...hovered, expectBg: m.tokens.panel2, expectColor: m.tokens.ink })
    )
    c(
      'hover-panel2-ink',
      hovered.bg === m.tokens.panel2 && hovered.color === m.tokens.ink,
      JSON.stringify(hovered)
    )

    // 选中：点一个文件行（先开空白文档，避免脏确认弹窗）
    await w.ev(`(async () => { await window.__S.files().openUntitled(); return 'ok' })()`)
    await sleep(400)
    await w.ev(
      `(() => { const el = [...document.querySelectorAll('[data-tree-row]')].find((r) => r.getAttribute('data-tree-type') === 'file' && r.textContent.includes('guide')); el.click(); return 'ok' })()`
    )
    await sleep(900)
    const sel = JSON.parse(
      await w.ev(
        `(() => { const el = document.querySelector('[data-tree-row].bg-accent-soft') || [...document.querySelectorAll('[data-tree-row]')].find((r) => r.textContent.includes('guide')); const cs = getComputedStyle(el); const icon = getComputedStyle(el.querySelector('svg')); const bar = getComputedStyle(el, '::before'); const rb = el.getBoundingClientRect(); return JSON.stringify({ bg: cs.backgroundColor, color: cs.color, weight: cs.fontWeight, icon: icon.color, barWidth: parseFloat(bar.width) || 0, barColor: bar.backgroundColor, barContent: bar.content, rowLeft: Math.round(rb.left), rowHeight: Math.round(rb.height * 10) / 10 }) })()`
      )
    )
    console.log(
      'SELECTED ' +
        JSON.stringify({ ...sel, expectBg: m.tokens.accentSoft, expectColor: m.tokens.accent })
    )
    c(
      'selected-accent-soft-and-ink',
      sel.bg === m.tokens.accentSoft && sel.color === m.tokens.accent,
      JSON.stringify(sel)
    )
    c(
      'selected-icon-follows-accent',
      sel.icon === m.tokens.accent,
      JSON.stringify({ icon: sel.icon, accent: m.tokens.accent })
    )
    c('selected-weight-500', sel.weight === '500', sel.weight)
    // 选中项**不再有左侧那条 3px 浅灰色条**（用户口径，§4.79）：层级靠 1px 参考线表达、
    // 选中靠底色 + 文字 + 图标三重提示，灰条是"第四重提示 + 中性色与强调色打架"。
    // 判据用 `::before` 的 content/宽度：没有伪元素时 content 是 'none'（宽度 0 不足以区分
    // "存在但透明"的写法）。
    const barRgb = (() => {
      const n = (sel.barColor || '').match(/-?\d*\.?\d+/g)
      return n ? n.map(Number) : null
    })()
    const barSpread = barRgb ? Math.max(...barRgb.slice(0, 3)) - Math.min(...barRgb.slice(0, 3)) : NaN
    const barAlpha = barRgb && barRgb.length > 3 ? barRgb[3] : 1
    console.log('SELECTED-BAR ' + JSON.stringify({ w: sel.barWidth, color: sel.barColor, content: sel.barContent, spread: barSpread }))
    c(
      'selected-row-has-no-left-bar',
      sel.barContent === 'none' && Math.abs(sel.barWidth) <= 0.6,
      JSON.stringify({ content: sel.barContent, w: sel.barWidth, color: sel.barColor, alpha: barAlpha })
    )
    // 选中态不能把行内内容右推（缩进是按 --tree-pad 精确算的）：伪元素已删、底色只改
    // background-color、字重 500 只影响字宽不影响左缘 —— 所以「同一行挂上/摘掉 is-current」
    // 时 label 左缘必须完全一致（不依赖夹具里有同级行）。
    const shift = await w.ev(
      `(() => {
        const el = document.querySelector('[data-tree-row].bg-accent-soft') || [...document.querySelectorAll('[data-tree-row]')].find((r) => r.classList.contains('is-current'))
        if (!el) return 'no-current'
        const pick = () => { const l = [...el.children].find((c) => c.tagName === 'SPAN' && c.textContent.trim()); return l ? Math.round(l.getBoundingClientRect().left * 10) / 10 : -1 }
        const withCurrent = pick()
        el.classList.remove('is-current')
        const withoutCurrent = pick()
        el.classList.add('is-current')
        return JSON.stringify({ withCurrent, withoutCurrent, delta: Math.round((withCurrent - withoutCurrent) * 10) / 10 })
      })()`
    )
    const shiftObj = (() => {
      try {
        return JSON.parse(String(shift))
      } catch {
        return { delta: String(shift) }
      }
    })()
    c(
      'selected-state-does-not-shift-content',
      shiftObj.delta === 0,
      `挂/摘选中态 labelLeft 差=${shiftObj.delta}（${shiftObj.withCurrent} vs ${shiftObj.withoutCurrent}）`
    )
    // 选中项悬停：底色比选中态略强（同色系加深，不换成 panel-2）
    const selRect = JSON.parse(
      await w.ev(
        `(() => {
          const el = [...document.querySelectorAll('[data-tree-row]')].find((r) => r.textContent.includes('guide'))
          if (!el) return JSON.stringify({ err: 'no-row' })
          el.scrollIntoView({ block: 'center' })
          const b = el.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) })
        })()`
      )
    )
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: selRect.x, y: selRect.y })
    await sleep(280)
    const selHoverBg = await w.ev(
      `(() => {
        const hit = document.elementFromPoint(${selRect.x}, ${selRect.y})
        const el = (hit && hit.closest('[data-tree-row]')) || document.querySelector('[data-tree-row]:hover')
        return el ? getComputedStyle(el).backgroundColor : null
      })()`
    )
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
    await sleep(200)
    const alphaOf = (s) => {
      const m = /\/\s*(0?\.\d+)\s*\)/.exec(s)
      if (m) return Number(m[1])
      const n = (s.match(/-?\d*\.?\d+/g) || []).map(Number)
      return n.length === 4 ? n[3] : 1
    }
    console.log(
      'SELECTED-HOVER ' +
        JSON.stringify({ bg: selHoverBg, base: m.tokens.accentSoft, alpha: alphaOf(selHoverBg) })
    )
    c(
      'selected-hover-stronger-same-hue',
      selHoverBg !== m.tokens.accentSoft &&
        selHoverBg !== m.tokens.panel2 &&
        alphaOf(selHoverBg) > alphaOf(m.tokens.accentSoft),
      JSON.stringify({
        bg: selHoverBg,
        alpha: alphaOf(selHoverBg),
        base: alphaOf(m.tokens.accentSoft)
      })
    )

    // D. 箭头旋转 90°（transform 或 rotate 长属性任一即可，但必须是 90°）
    const chev = JSON.parse(
      await w.ev(`(() => {
      const dirs = [...document.querySelectorAll('[data-tree-row][data-tree-type="directory"]')]
      const read = (r) => { const cs = getComputedStyle(r.querySelector('[data-tree-chevron]')); return { t: cs.transform, rot: cs.rotate, trans: cs.transitionProperty + ' ' + cs.transitionDuration } }
      const open = dirs.map((r) => ({ r, v: read(r) })).find((x) => x.v.rot !== 'none' || (x.v.t && x.v.t !== 'none'))
      const closed = dirs.map((r) => ({ r, v: read(r) })).find((x) => x.v.rot === 'none' && x.v.t === 'none')
      return JSON.stringify({ open: open ? { name: open.r.textContent.trim(), ...open.v } : null, closed: closed ? { name: closed.r.textContent.trim(), ...closed.v } : null })
    })()`)
    )
    console.log('CHEVRON ' + JSON.stringify(chev))
    // rotate: 90deg → matrix(0, 1, -1, 0, 0, 0)；若用 rotate 长属性则是 "90deg"
    const is90 = (v) =>
      v.rot && v.rot !== 'none'
        ? /^90deg$/.test(v.rot)
        : /matrix\(\s*0,\s*1,\s*-1,\s*0/.test(String(v.t).replace(/\s+/g, ' '))
    c(
      'chevron-rotates-90',
      !!chev.open && !!chev.closed && is90(chev.open) && !is90(chev.closed),
      JSON.stringify(chev)
    )
    c(
      'chevron-transition-on-rotated-property',
      !!chev.open &&
        chev.open.trans.includes('transform') &&
        /0\.1[0-9]?s|0\.2s/.test(chev.open.trans),
      JSON.stringify(chev.open?.trans)
    )

    // E. 空目录提示的**文字**与同级子项的文字左对齐
    if (m.hint) {
      const emptyRow = rows.find((r) => r.name === 'empty')
      const sameLevelChild = rows.find((r) => r.depth === (emptyRow?.depth ?? -1) + 1)
      const expect = sameLevelChild ? sameLevelChild.labelLeft : null
      console.log(
        'HINTALIGN ' +
          JSON.stringify({
            hintTextLeft: m.hint.textLeft,
            childLabel: expect,
            hintFont: m.hint.fontSize
          })
      )
      c(
        'empty-folder-hint-aligned',
        expect === null || Math.abs(m.hint.textLeft - expect) <= 1,
        JSON.stringify({ hint: m.hint.textLeft, child: expect })
      )
      c('empty-folder-hint-12px', m.hint.fontSize === '12px', m.hint.fontSize)
    } else {
      c('empty-folder-hint-aligned', false, 'SKIP: 空目录提示未渲染')
      c('empty-folder-hint-12px', false, 'SKIP')
    }

    // F. 展开/收起过渡：读 .tree-* 规则本身（往页面里塞一个同名的临时元素取计算值），
    //    再行为验证一次收起后子节点在 250ms 内真的从 DOM 消失
    const trans = JSON.parse(
      await w.ev(`(() => {
      const el = document.createElement('div')
      el.className = 'tree-enter-active'
      document.body.appendChild(el)
      const cs = getComputedStyle(el)
      const v = { property: cs.transitionProperty, duration: cs.transitionDuration, timing: cs.transitionTimingFunction }
      el.remove()
      const wrap = document.querySelector('[data-tree-children]')
      return JSON.stringify({ ...v, hasChildrenHook: !!wrap })
    })()`)
    )
    console.log('TREE-TRANSITION ' + JSON.stringify(trans))
    c(
      'child-transition-no-scale',
      trans.property.includes('opacity') &&
        trans.property.includes('transform') &&
        !trans.property.includes('scale') &&
        /0\.1[0-9]?s|0\.2s/.test(trans.duration),
      JSON.stringify(trans)
    )
    c('children-hook-present', trans.hasChildrenHook === true, String(trans.hasChildrenHook))
    const collapsed = await w.ev(`(async () => {
      const count = () => document.querySelectorAll('[data-tree-row]').length
      const names = () => [...document.querySelectorAll('[data-tree-row]')].map((r) => r.textContent.trim())
      const before = count()
      const dir = ${JSON.stringify(path.join(ws, 'docs'))}
      const wasExpanded = window.__S.files().expanded.has(dir)
      await window.__S.files().toggleDir(dir)
      const t0 = performance.now()
      // 注意：leaving 的子树在过渡期间仍在 DOM 里，所以不能「连续几帧不变」就收工，
      // 必须等行数真的**掉下来**为止（否则量到的是过渡开始的那一瞬）。
      // 用 setTimeout 而不是 requestAnimationFrame：窗口被别的窗口挡住（Chromium 判定
      // occluded）时 rAF 会被暂停，那样这个 await 会**永远不返回**，整套挂死（实测踩过）。
      while (performance.now() - t0 < 800 && count() >= before) {
        await new Promise((r) => setTimeout(r, 16))
      }
      return JSON.stringify({ ms: Math.round(performance.now() - t0), wasExpanded, before, after: count(), nowExpanded: window.__S.files().expanded.has(dir), names: names().slice(0, 12) })
    })()`)
    console.log('COLLAPSE ' + collapsed)
    const col2 = JSON.parse(collapsed)
    c('collapse-completes-quickly', col2.after < col2.before && col2.ms <= 400, collapsed)
    // 再展开回来，方便后面截图
    await w.ev(
      `(async () => { await window.__S.files().toggleDir(${JSON.stringify(path.join(ws, 'docs'))}); return 'ok' })()`
    )
    await sleep(500)

    // G. 三主题令牌驱动 + 截图
    //
    // ⚠️ 这里是清单 §1.C.2 记的「批次敏感」现场：原来 `set('theme')` 之后**固定 sleep 900ms**
    // 就去读计算样式，10 套件批量跑时（机器更忙、样式重算与过渡更慢）会读到**上一套主题**的颜色，
    // 于是单独跑 32/32、批量跑 29/32。
    //
    // 只等「CSS 变量变了」还不够 —— 侧栏/行/body 都在 `transition: background-color` 上，
    // 变量一换就立刻读，读到的是**过渡途中的插值色**（实测：dark 那一轮 sel 仍是 light 的
    // rgba(17,24,39,.07)）。所以判据取「变量已换 + 关键颜色**连续两次采样相同**（过渡结束）」。
    const themeSeen = {}
    let prevPaper = null
    for (const th of ['light', 'dark', 'sepia']) {
      await w.ev(`(() => { window.__S.settings().set('theme', '${th}'); return 'ok' })()`)
      let settled = false
      let lastSig = null
      for (let i = 0; i < 60; i++) {
        const probe = JSON.parse(
          await w.ev(`(() => {
            const cs = getComputedStyle(document.documentElement)
            const row = document.querySelector('[data-tree-row]')
            return JSON.stringify({
              cls: document.documentElement.className,
              paper: cs.getPropertyValue('--paper').trim(),
              rowBg: row ? getComputedStyle(row).backgroundColor : '',
              bodyBg: getComputedStyle(document.body).backgroundColor
            })
          })()`)
        )
        const sig = `${probe.rowBg}|${probe.bodyBg}`
        if (probe.cls.includes(`theme-${th}`) && probe.paper && probe.paper !== prevPaper) {
          if (sig === lastSig) {
            prevPaper = probe.paper
            settled = true
            break
          }
          lastSig = sig
        } else {
          lastSig = null
        }
        await sleep(50)
      }
      if (!settled) console.log(`WARN 主题 ${th} 在 3s 内没切到位（继续量，断言会如实反映）`)
      const t = JSON.parse(await w.ev(MEASURE))
      themeSeen[th] = {
        sel: t.rows.find((r) => r.bg !== 'rgba(0, 0, 0, 0)')?.bg || null,
        accentSoft: t.tokens.accentSoft,
        paper: t.tokens.paper,
        app: t.tokens.app,
        sidebar: t.chrome.sidebar,
        body: t.chrome.body
      }
      const shot = await w.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: 300, height: 520, scale: 2 }
      })
      if (shot.result?.data) {
        const out = path.join(os.tmpdir(), `lumin-tree-${th}.png`)
        fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
        console.log('saved ' + out)
      }
    }
    console.log('THEMES ' + JSON.stringify(themeSeen))
    c(
      'theme-driven-selection',
      Object.values(themeSeen).every((v) => v.sel && v.sel === v.accentSoft),
      JSON.stringify(themeSeen)
    )

    // H. 两段式：侧栏属于「外壳（chrome）」，纸是写作区的事 —— 三主题都必须成立
    const twoTier = Object.entries(themeSeen).map(([th, v]) => ({
      th,
      paperVsChrome: contrast(v.paper, v.app),
      sidebarIsChrome: sameColor(v.sidebar, v.app),
      sidebarIsPaper: sameColor(v.sidebar, v.paper),
      bodyIsChrome: sameColor(v.body, v.app),
      pillOnChrome: contrast(over(v.accentSoft, v.app), v.app)
    }))
    console.log(
      'TWO-TIER ' +
        JSON.stringify(
          twoTier.map((x) => ({
            th: x.th,
            paper: rgbText(themeSeen[x.th].paper),
            chrome: rgbText(themeSeen[x.th].app),
            sidebar: rgbText(themeSeen[x.th].sidebar),
            paperVsChrome: rat(x.paperVsChrome),
            pillOnChrome: rat(x.pillOnChrome)
          }))
        )
    )
    c(
      'sidebar-is-chrome-not-paper',
      twoTier.every((x) => x.sidebarIsChrome && x.bodyIsChrome && !x.sidebarIsPaper),
      JSON.stringify(
        twoTier.map((x) => ({ th: x.th, chrome: x.sidebarIsChrome, paper: x.sidebarIsPaper }))
      )
    )
    c(
      'paper-brighter-than-chrome',
      twoTier.every((x) => x.paperVsChrome >= 1.03),
      JSON.stringify(twoTier.map((x) => `${x.th}:${rat(x.paperVsChrome)}:1`))
    )
    c(
      'selection-pill-visible-on-chrome',
      twoTier.every((x) => x.pillOnChrome >= 1.05),
      JSON.stringify(twoTier.map((x) => `${x.th}:${rat(x.pillOnChrome)}:1`))
    )
    c(
      'three-themes-have-distinct-paper',
      new Set(Object.values(themeSeen).map((v) => rgbText(v.paper))).size === 3,
      JSON.stringify(Object.entries(themeSeen).map(([th, v]) => `${th}:${rgbText(v.paper)}`))
    )
    await w.ev(`(() => { window.__S.settings().set('theme', 'light'); return 'ok' })()`)
  } finally {
    await w.ev(`(async () => { await window.__S.files().close(); return 'ok' })()`).catch(() => {})
    await sleep(200)
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w.ws.close()
  // 必须无条件退出：漏掉的 WebSocket 会让 Node 的事件循环一直挂着（全套通过时也不会结束）
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
