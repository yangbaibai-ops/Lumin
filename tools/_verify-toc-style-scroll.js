// 验收：目录（[TOC]）样式对齐 Typora + 点击标题**平滑**滚动
//
// 断言：
//  A. 样式：没有左侧色条（border-left 宽度 0 / style none）、没有外框与底色、没有「目录」标题行、
//     条目是按层级缩进的圆点列表（::before 内容 • / ◦ / ▪）
//  B. 缩进随层级递增（padding-left 单调）
//  C. 点击 → 光标落到标题 + **滚动是动画的**（中途采样到介于起止之间的 scrollTop，且最终停在目标附近）
//  D. 系统「减少动态效果」时退化为瞬时定位（Emulation.setEmulatedMedia 模拟）
//  E. 侧栏大纲点击同样平滑（同一个动作）
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
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
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym] ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map) ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
  window.__T = {
    files: () => pinia._s.get('files'),
    ui: () => pinia._s.get('ui'),
    ed: () => pinia._s.get('editor')?.instance ?? null,
    store: () => pinia._s.get('editor'),
    settings: () => pinia._s.get('settings')
  }
  return 'ok'
})()`

const TOC_STYLE = `(() => {
  const toc = document.querySelector('.md-toc')
  if (!toc) return JSON.stringify({ present: false })
  const cs = getComputedStyle(toc)
  const items = [...toc.querySelectorAll('.toc-item')]
  const itemStyle = items.map((a) => {
    const s = getComputedStyle(a)
    const b = getComputedStyle(a, '::before')
    return {
      level: Number(a.getAttribute('data-level')),
      depth: a.style.getPropertyValue('--toc-depth'),
      text: (a.textContent || '').trim(),
      paddingLeft: Math.round(parseFloat(s.paddingLeft)),
      bullet: b.content,
      bulletColor: b.color,
      color: s.color,
      cursor: s.cursor,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      borderLeftWidth: s.borderLeftWidth,
      background: s.backgroundColor,
      boxShadow: s.boxShadow,
      bulletBackground: b.backgroundColor,
      outlineWidth: s.outlineWidth
    }
  })
  return JSON.stringify({
    present: true,
    borderLeftWidth: cs.borderLeftWidth,
    borderLeftStyle: cs.borderLeftStyle,
    borderTopWidth: cs.borderTopWidth,
    background: cs.backgroundColor,
    hasTitle: !!toc.querySelector('.md-toc-title'),
    anchors: items.length,
    itemStyle,
    boxShadow: cs.boxShadow
  })
})()`

/** 滚动采样：点击后连续记录 scrollTop，用来判断「动画」还是「瞬移」 */
const SCROLL_SAMPLER = `
window.__samples = []
window.__stopSampler = false
;(function loop() {
  const el = document.querySelector('.editor-scroll')
  if (!el || window.__stopSampler) return
  window.__samples.push(Math.round(el.scrollTop))
  requestAnimationFrame(loop)
})()
'ok'`

/**
 * 滚动调用探针：记录面页内每一次「滚动入口」调用。
 * 目的：抓「平滑动画被别的瞬时滚动打断」这类回归——Tiptap 的 focus() 默认会在
 * requestAnimationFrame 里补一次 scrollIntoView，打断我们的平滑滚动（表现为瞬移）。
 */
const SCROLL_HOOK = `(() => {
  if (window.__scrollHooked) { window.__sc = []; return 'already' }
  window.__scrollHooked = true
  window.__sc = []
  const rec = (kind) => window.__sc.push({ kind, stack: String(new Error().stack).split('\\n').slice(2, 5).join(' <- ') })
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get: d.get,
    set(v) { if (String(this.className).includes('editor-scroll')) rec('scrollTop=' + Math.round(v)); return d.set.call(this, v) }
  })
  const st = Element.prototype.scrollTo
  Element.prototype.scrollTo = function (...a) {
    if (String(this.className).includes('editor-scroll')) rec('scrollTo ' + JSON.stringify(a).slice(0, 80))
    return st.apply(this, a)
  }
  const si = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (...a) {
    if (String(this.className).includes('editor-scroll')) rec('scrollIntoView ' + JSON.stringify(a).slice(0, 60))
    return si.apply(this, a)
  }
  return 'hooked'
})()`

;(async () => {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const pages = (await get('/json/list')).filter(
    (t) => t.type === 'page' && /index\.html|5173/.test(t.url)
  )
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (
      (await w.ev(SETUP)) === 'ok' &&
      (await w.ev(`window.__T.ui().booting ? 'booting' : 'ready'`)) === 'ready'
    )
      break
  }
  await w.ev(SETUP)

  try {
    // 造一篇长文档：多级标题 + 足够长的正文，保证能滚起来；末尾放 [TOC]
    await w.ev(`(async () => { await window.__T.files().openUntitled(); return 'ok' })()`)
    await sleep(500)
    const md = [
      '# 一级标题 Alpha',
      ...Array.from({ length: 12 }, (_, i) => `段落 ${i + 1}：` + '内容文字。'.repeat(20)),
      '',
      '## 二级标题 Beta',
      ...Array.from({ length: 12 }, (_, i) => `段落 B${i + 1}：` + '更多内容。'.repeat(20)),
      '',
      '### 三级标题 Gamma',
      ...Array.from({ length: 12 }, (_, i) => `段落 C${i + 1}：` + '结尾内容。'.repeat(20)),
      '',
      '[TOC]'
    ].join('\n\n')
    await w.ev(
      `(() => { window.__T.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`
    )
    await sleep(900)

    // ── A/B. 样式 ──
    const st = JSON.parse(await w.ev(TOC_STYLE))
    console.log('STYLE ' + JSON.stringify(st))
    c(
      'toc-rendered',
      st.present === true && st.anchors >= 3,
      JSON.stringify({ present: st.present, anchors: st.anchors })
    )
    // 注意：Tailwind preflight 给所有元素写了 `border-style: solid; border-width: 0`，
    // 所以「没有色条」的判据是**宽度为 0**（visible 的色条必然有非 0 宽度），而不是 style 为 none。
    c(
      'no-left-color-bar',
      st.borderLeftWidth === '0px',
      JSON.stringify({ w: st.borderLeftWidth, s: st.borderLeftStyle })
    )
    c(
      'items-have-no-bar-or-chip',
      st.itemStyle.every(
        (x) =>
          x.borderLeftWidth === '0px' &&
          x.background === 'rgba(0, 0, 0, 0)' &&
          x.boxShadow === 'none' &&
          x.outlineWidth === '0px' &&
          x.bulletBackground === 'rgba(0, 0, 0, 0)'
      ),
      JSON.stringify(
        st.itemStyle.map((x) => ({
          bl: x.borderLeftWidth,
          bg: x.background,
          sh: x.boxShadow,
          ol: x.outlineWidth,
          pbg: x.bulletBackground
        }))
      )
    )
    c(
      'no-box-no-background',
      st.borderTopWidth === '0px' &&
        st.background === 'rgba(0, 0, 0, 0)' &&
        st.boxShadow === 'none',
      JSON.stringify({ top: st.borderTopWidth, bg: st.background, shadow: st.boxShadow })
    )
    c('no-title-row', st.hasTitle === false, String(st.hasTitle))
    c(
      'bulleted-by-level',
      st.itemStyle.map((x) => x.bullet).join('|') === '"•"|"◦"|"▪"',
      JSON.stringify(st.itemStyle.map((x) => x.bullet))
    )
    c(
      'indent-increases-with-level',
      st.itemStyle[0].paddingLeft < st.itemStyle[1].paddingLeft &&
        st.itemStyle[1].paddingLeft < st.itemStyle[2].paddingLeft,
      JSON.stringify(st.itemStyle.map((x) => ({ l: x.level, pad: x.paddingLeft })))
    )
    c(
      'typora-like-typography',
      st.itemStyle.every((x) => x.cursor === 'pointer') && st.itemStyle[0].lineHeight !== 'normal',
      JSON.stringify(st.itemStyle.map((x) => ({ lh: x.lineHeight, cursor: x.cursor })))
    )

    // ── C. 点击平滑滚动 ──
    // 显式把媒体特性固定在 no-preference：否则若上一次运行残留了 reduce 模拟，
    // 平滑滚动会**正确地**退化成瞬移，套件就会误判成「没动画」。
    await w.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    })
    await sleep(150)
    console.log(
      'MEDIA ' +
        (await w.ev(
          `JSON.stringify({ reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, noPref: matchMedia('(prefers-reduced-motion: no-preference)').matches })`
        ))
    )
    // 先把视图滚到底部（目录所在处），确保点击第一级标题时要往上滚一大段；
    // 注意顺序：**先滚动、再量坐标**——否则量到的是滚动前的位置，点击会落空。
    await w.ev(
      `(() => { const el = document.querySelector('.editor-scroll'); el.scrollTop = el.scrollHeight; return 'ok' })()`
    )
    await sleep(600)
    const startTop = await w.ev(`Math.round(document.querySelector('.editor-scroll').scrollTop)`)
    const targetInfo = JSON.parse(
      await w.ev(`(() => {
        const toc = document.querySelector('.md-toc')
        const a = toc.querySelectorAll('.toc-item')[0]
        const r = a.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2), text: a.textContent.trim() })
      })()`)
    )
    console.log('CLICK-TARGET ' + JSON.stringify(targetInfo))
    console.log('HOOK ' + (await w.ev(SCROLL_HOOK)))
    await w.ev(SCROLL_SAMPLER)
    await w.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: targetInfo.x,
      y: targetInfo.y,
      button: 'left',
      clickCount: 1
    })
    await w.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: targetInfo.x,
      y: targetInfo.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(140)
    const mid = await w.ev(`JSON.stringify(window.__samples.slice())`)
    await sleep(1400)
    const samples = JSON.parse(
      await w.ev(`(window.__stopSampler = true, JSON.stringify(window.__samples.slice()))`)
    )
    await sleep(300)
    const finalTop = await w.ev(`Math.round(document.querySelector('.editor-scroll').scrollTop)`)
    const headingTop = await w.ev(
      `(() => { const h = document.querySelector('.md-preview h1, .ProseMirror h1'); const el = document.querySelector('.editor-scroll'); return h ? Math.round(el.scrollTop + h.getBoundingClientRect().top - el.getBoundingClientRect().top) : null })()`
    )
    const distinct = new Set(samples).size
    console.log(
      'SCROLL ' +
        JSON.stringify({ startTop, finalTop, headingTop, samples: samples.slice(0, 12), distinct })
    )
    c('scroll-moved-upward', finalTop < startTop - 200, JSON.stringify({ startTop, finalTop }))
    c(
      'scroll-is-animated-not-instant',
      distinct > 6,
      JSON.stringify({ distinct, first: samples.slice(0, 8) })
    )
    c(
      'mid-flight-intermediate-value',
      JSON.parse(mid).some(
        (v) => v > Math.min(startTop, finalTop) + 20 && v < Math.max(startTop, finalTop) - 20
      ),
      JSON.stringify(JSON.parse(mid).slice(0, 10))
    )
    c(
      'lands-near-heading',
      typeof headingTop === 'number' && Math.abs(finalTop - headingTop) <= 24,
      JSON.stringify({ finalTop, headingTop })
    )
    const sel = await w.ev(`(() => {
      const ed = window.__T.ed(); const s = ed.state.selection; const size = ed.state.doc.content.size
      // 夹紧上界：越界会让 textBetween 内部取到 undefined 子节点（Cannot read properties of undefined）
      const to = Math.max(s.from, Math.min(s.from + 5, size))
      return JSON.stringify({ from: s.from, size, text: ed.state.doc.textBetween(s.from, to) })
    })()`)
    c('cursor-moved-to-heading', JSON.parse(sel).text.includes('一级'), sel)
    // 关键回归：平滑调用之后不允许再有任何「瞬时」滚动写入（否则动画会被打断 = 瞬移）
    const sc = JSON.parse(await w.ev(`JSON.stringify(window.__sc)`))
    console.log('SCROLLCALLS ' + JSON.stringify(sc.map((x) => x.kind)))
    const smoothIdx = sc.findIndex((x) => x.kind.includes('smooth'))
    // 动画自身由浏览器内部推进，不会经过 scrollTop 的 IDL setter；所以平滑调用之后
    // 再出现任何一条记录，就说明有别的代码在瞬时抢滚动。
    const afterSmooth = smoothIdx >= 0 ? sc.slice(smoothIdx + 1) : []
    c(
      'smooth-scroll-not-interrupted',
      smoothIdx >= 0 && afterSmooth.length === 0,
      JSON.stringify({
        calls: sc.map((x) => x.kind),
        after: afterSmooth.map((x) => x.kind + ' @ ' + x.stack)
      })
    )

    // ── D. prefers-reduced-motion：瞬时定位 ──
    await w.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await sleep(200)
    await w.ev(
      `(() => { const el = document.querySelector('.editor-scroll'); el.scrollTop = el.scrollHeight; return 'ok' })()`
    )
    await sleep(400)
    const start2 = await w.ev(`Math.round(document.querySelector('.editor-scroll').scrollTop)`)
    const target2 = JSON.parse(
      await w.ev(`(() => {
        const a = document.querySelector('.md-toc .toc-item')
        const r = a.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) })
      })()`)
    )
    await w.ev(SCROLL_SAMPLER)
    await w.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: target2.x,
      y: target2.y,
      button: 'left',
      clickCount: 1
    })
    await w.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: target2.x,
      y: target2.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(260)
    const samples2 = JSON.parse(
      await w.ev(`(window.__stopSampler = true, JSON.stringify(window.__samples.slice()))`)
    )
    const final2 = await w.ev(`Math.round(document.querySelector('.editor-scroll').scrollTop)`)
    const distinct2 = new Set(samples2).size
    console.log(
      'REDUCED-MOTION ' +
        JSON.stringify({ start2, final2, distinct2, samples: samples2.slice(0, 6) })
    )
    c(
      'reduced-motion-jumps-instantly',
      distinct2 <= 3 && Math.abs(final2 - start2) > 200,
      JSON.stringify({ distinct2, start2, final2 })
    )
    await w.send('Emulation.setEmulatedMedia', { features: [] })

    // ── E. 侧栏大纲点击也平滑（同一个 jumpToHeading） ──
    await w.ev(
      `(() => { window.__T.ui().sidebarVisible = true; window.__T.ui().sidebarTab = 'outline'; return 'ok' })()`
    )
    await sleep(700)
    const outlineOk = await w.ev(`document.querySelectorAll('[data-outline-item]').length`)
    if (outlineOk > 0) {
      await w.ev(
        `(() => { const el = document.querySelector('.editor-scroll'); el.scrollTop = el.scrollHeight; return 'ok' })()`
      )
      await sleep(400)
      const start3 = await w.ev(`Math.round(document.querySelector('.editor-scroll').scrollTop)`)
      await w.ev(SCROLL_SAMPLER)
      await w.ev(
        `(() => { document.querySelectorAll('[data-outline-item]')[0].click(); return 'ok' })()`
      )
      await sleep(140 + 1200)
      const samples3 = JSON.parse(
        await w.ev(`(window.__stopSampler = true, JSON.stringify(window.__samples.slice()))`)
      )
      const final3 = await w.ev(`Math.round(document.querySelector('.editor-scroll').scrollTop)`)
      console.log('OUTLINE ' + JSON.stringify({ start3, final3, distinct: new Set(samples3).size }))
      c(
        'outline-click-also-smooth',
        new Set(samples3).size > 6 && Math.abs(final3 - start3) > 200,
        JSON.stringify({ distinct: new Set(samples3).size, start3, final3 })
      )
    } else {
      c('outline-click-also-smooth', false, 'SKIP: 侧栏大纲不可用')
    }

    // ── F. 默认字色 = 蓝色（--toc-link 令牌），悬停仍是蓝的 ──
    const colorProbe = `(() => {
      const a = document.querySelector('.md-toc .toc-item')
      const cs = getComputedStyle(a)
      // 令牌实际解析出来的颜色：用一个临时元素取计算值，避免把色值写死在套件里
      const probe = document.createElement('span')
      probe.style.color = 'var(--toc-link)'
      document.body.appendChild(probe)
      const tokenColor = getComputedStyle(probe).color
      probe.remove()
      return JSON.stringify({
        item: cs.color,
        token: tokenColor,
        ink: getComputedStyle(document.querySelector('.ProseMirror')).color,
        theme: document.documentElement.className
      })
    })()`
    // 颜色可能是 `rgb(37, 99, 235)`，也可能是 color-mix 出来的浮点格式 `color(srgb 0.14 0.33 0.76)`
    const rgb = (s) => {
      const m = String(s)
      const nums = m.match(/-?\d*\.?\d+/g) || []
      if (m.startsWith('color(')) return nums.slice(0, 3).map((v) => Math.round(Number(v) * 255))
      return nums.slice(0, 3).map(Number)
    }
    const isBlue = (s) => {
      const [r, g, b] = rgb(s)
      return r !== undefined && b > r + 20 && b > g + 20
    }
    const col = JSON.parse(await w.ev(colorProbe))
    console.log('COLOR ' + JSON.stringify(col))
    c('default-color-is-blue', isBlue(col.item), JSON.stringify(col.item))
    c(
      'default-color-follows-token',
      col.item === col.token,
      JSON.stringify({ item: col.item, token: col.token })
    )
    c(
      'default-color-not-body-ink',
      col.item !== col.ink,
      JSON.stringify({ item: col.item, ink: col.ink })
    )
    // 悬停：真实指针移上去（:hover 取不到计算值，只能用真事件）——先把目录滚进视口
    await w.ev(
      `(() => { document.querySelector('.md-toc').scrollIntoView({ block: 'center' }); return 'ok' })()`
    )
    await sleep(400)
    const hoverRect = JSON.parse(
      await w.ev(
        `(() => { const r = document.querySelector('.md-toc .toc-item').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }) })()`
      )
    )
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverRect.x, y: hoverRect.y })
    await sleep(250)
    const hovered = await w.ev(
      `getComputedStyle(document.querySelector('.md-toc .toc-item')).color`
    )
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
    await sleep(200)
    console.log('HOVER ' + JSON.stringify({ default: col.item, hover: hovered }))
    c(
      'hover-stays-blue-and-changes',
      isBlue(hovered) && hovered !== col.item,
      JSON.stringify({ default: col.item, hover: hovered })
    )

    // 截图：目录区域（3 主题，顺便断言三套主题下默认字色都是蓝的）
    for (const th of ['light', 'dark', 'sepia']) {
      await w.ev(`(() => { window.__T.settings().set('theme', '${th}'); return 'ok' })()`)
      await sleep(1000)
      const tc = JSON.parse(await w.ev(colorProbe))
      console.log(
        `THEME-COLOR ${th} ` + JSON.stringify({ item: tc.item, token: tc.token, ink: tc.ink })
      )
      c(
        `theme-${th}-toc-color-is-blue`,
        isBlue(tc.item) && tc.item === tc.token && tc.item !== tc.ink,
        JSON.stringify(tc)
      )
      await w.ev(
        `(() => { const toc = document.querySelector('.md-toc'); toc.scrollIntoView({ block: 'center' }); return 'ok' })()`
      )
      await sleep(500)
      const rect = JSON.parse(
        await w.ev(
          `(() => { const r = document.querySelector('.md-toc').getBoundingClientRect(); return JSON.stringify({ x: Math.max(0, Math.round(r.left) - 16), y: Math.max(0, Math.round(r.top) - 16), width: Math.min(460, Math.round(r.width) + 32), height: Math.round(r.height) + 32 }) })()`
        )
      )
      const shot = await w.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...rect, scale: 2 }
      })
      if (shot.result?.data) {
        const out = path.join(os.tmpdir(), `lumin-toc-${th}.png`)
        fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
        console.log('saved ' + out)
      }
    }
    await w.ev(`(() => { window.__T.settings().set('theme', 'light'); return 'ok' })()`)
  } finally {
    await w
      .ev(`(async () => { const f = window.__T.files(); f.close(); return 'ok' })()`)
      .catch(() => {})
    await sleep(300)
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
