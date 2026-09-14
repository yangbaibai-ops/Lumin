// 验收：分段控件（编辑器模式 / 侧栏文件视图）——滑动指示块、点击切换、主题令牌、截图
//
// 断言：
//  A. 编辑器工具栏里是一个 3 段的分段控件（只有图标，文案在 title/aria-label 上）
//  B. 指示块几何：宽度 = 一段、位置与当前激活段重合（±1px）
//  C. 点击第 3 段 → 模式变成 source，且指示块**位移正好一段宽**（滑动动画的落点）
//  D. aria：role=tablist/tab + aria-selected 跟随；提示里带 Ctrl+/ 快捷键
//  E. 侧栏是同一个控件的 2 段版本，点击切换 tree/list 并真的换渲染
//  F. 主题：指示块/轨道颜色随 light / dark / sepia 令牌变化
//  G. 工具栏不产生横向溢出（换控件后更窄）
//  （截图另存到 %TEMP%，供人工看观感）
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => res(JSON.parse(d)))
    }).on('error', rej)
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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym]
  window.__G = { ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), files: () => pinia._s.get('files'), app }
  return 'ok'
})()`

/** 读两个分段控件的几何与状态：栏内第一个是编辑器模式，侧栏头部是文件视图 */
const PROBE = `(() => {
  const segs = [...document.querySelectorAll('.seg')]
  const info = (seg) => {
    if (!seg) return null
    const r = seg.getBoundingClientRect()
    const thumb = seg.querySelector('.seg-thumb')
    const btns = [...seg.querySelectorAll('.seg-btn')]
    const tr = thumb?.getBoundingClientRect()
    const rects = btns.map((b) => { const x = b.getBoundingClientRect(); return { left: Math.round(x.left), w: Math.round(x.width), h: Math.round(x.height) } })
    const activeIdx = btns.findIndex((b) => b.classList.contains('active'))
    const tcs = thumb ? getComputedStyle(thumb) : null
    const scs = getComputedStyle(seg)
    return {
      count: btns.length,
      segments: rects,
      activeIdx,
      selected: btns.map((b) => b.getAttribute('aria-selected')),
      labels: btns.map((b) => b.getAttribute('aria-label')),
      titles: btns.map((b) => b.getAttribute('title')),
      hasVisibleText: btns.map((b) => (b.textContent || '').trim()),
      iconCount: btns.map((b) => b.querySelectorAll('svg').length),
      seg: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), radius: scs.borderRadius, bg: scs.backgroundColor },
      thumb: tr ? { left: Math.round(tr.left), w: Math.round(tr.width), h: Math.round(tr.height), bg: tcs.backgroundColor, radius: tcs.borderRadius, transition: tcs.transitionProperty + ' ' + tcs.transitionDuration, shadow: tcs.boxShadow !== 'none', transform: tcs.transform } : null,
      role: seg.getAttribute('role'),
      ariaLabel: seg.getAttribute('aria-label'),
      unifiedWidth: new Set(rects.map((x) => x.w)).size === 1
    }
  }
  const toolbarSeg = document.querySelector('div.h-11 .seg')
  const asideSeg = document.querySelector('aside .seg')
  const toolbar = document.querySelector('div.h-11')
  return JSON.stringify({
    toolbarSeg: info(toolbarSeg),
    asideSeg: info(asideSeg),
    segCount: segs.length,
    mode: window.__G.ui().editorMode,
    filesView: window.__G.ui().sidebarFilesView,
    listRendered: !!document.querySelector('aside .list-view, aside ul'),
    toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : null
  })
})()`

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const pages = (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await w.ev(SETUP)) === 'ok' && (await w.ev(`window.__G.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await w.ev(SETUP)
  const probe = async () => JSON.parse(await w.ev(PROBE))
  const clickSeg = async (which, index) => {
    const pos = JSON.parse(
      await w.ev(`(() => {
        const seg = ${which === 'toolbar' ? "document.querySelector('div.h-11 .seg')" : "document.querySelector('aside .seg')"}
        const b = seg.querySelectorAll('.seg-btn')[${index}]
        const r = b.getBoundingClientRect()
        b.click()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`)
    )
    await sleep(500)
    return pos
  }

  try {
    // 打开一个文档，工具栏与侧栏都进入正常工作态
    const tmp = path.join(os.tmpdir(), 'lumin-seg')
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'a.md'), '# a\n\nseg test\n', 'utf-8')
    await w.ev(`(async () => { const f = window.__G.files(); await f.setRoot(${JSON.stringify(tmp)}); await f.openPath(${JSON.stringify(path.join(tmp, 'a.md'))}); return 'ok' })()`)
    // 全新配置目录里侧栏默认是收起的，标签页也可能停在「大纲」：都显式摆正，
    // 否则拿不到侧栏的那个分段控件（FileTree 只在 files 标签页里挂载）
    await w.ev(`(() => { window.__G.ui().sidebarVisible = true; window.__G.ui().sidebarTab = 'files'; return 'ok' })()`)
    await sleep(600)
    // 编辑器模式会跨会话持久化（上次套件可能留在「源码」）：点第一段回到「实时渲染」
    await w.ev(`(() => { document.querySelector('div.h-11 .seg .seg-btn')?.click(); return 'ok' })()`)
    await sleep(800)

    const s0 = await probe()
    console.log('INIT ' + JSON.stringify({ mode: s0.mode, toolbar: s0.toolbarSeg, aside: s0.asideSeg, overflow: s0.toolbarOverflow }))
    c('two-segments-controls', s0.segCount === 2 && s0.toolbarSeg?.count === 3 && s0.asideSeg?.count === 2, JSON.stringify({ total: s0.segCount, toolbar: s0.toolbarSeg?.count, aside: s0.asideSeg?.count }))
    c('toolbar-segments-icon-only', s0.toolbarSeg.hasVisibleText.every((x) => x === '') && s0.toolbarSeg.iconCount.every((n) => n === 1), JSON.stringify({ text: s0.toolbarSeg.hasVisibleText, icons: s0.toolbarSeg.iconCount }))
    c('labels-and-shortcut-in-tooltip', s0.toolbarSeg.labels.every((l) => l && l.length > 0) && s0.toolbarSeg.titles.every((t) => t && t.includes('Ctrl+/')), JSON.stringify({ labels: s0.toolbarSeg.labels, titles: s0.toolbarSeg.titles }))
    c('roles-and-aria-selected', s0.toolbarSeg.role === 'tablist' && s0.toolbarSeg.selected.join(',') === 'true,false,false' && s0.toolbarSeg.ariaLabel.length > 0, JSON.stringify({ role: s0.toolbarSeg.role, selected: s0.toolbarSeg.selected, aria: s0.toolbarSeg.ariaLabel }))
    c('segments-equal-width', s0.toolbarSeg.unifiedWidth === true, JSON.stringify(s0.toolbarSeg.segments))

    // 指示块几何：宽度 = 一段（±1px），left 与激活段 left 重合（±1px）
    const segW = s0.toolbarSeg.segments[0].w
    const segL = s0.toolbarSeg.segments[0].left
    const th = s0.toolbarSeg.thumb
    c('thumb-width-matches-segment', !!th && Math.abs(th.w - segW) <= 1, JSON.stringify({ thumb: th?.w, segment: segW }))
    c('thumb-sits-on-active-segment', !!th && Math.abs(th.left - segL) <= 1, JSON.stringify({ thumbLeft: th?.left, segLeft: segL }))
    c('thumb-animated-with-transform', !!th && th.transition.includes('transform') && /0\.[12]\d?s/.test(th.transition), JSON.stringify(th?.transition))
    c('thumb-elevated-surface', !!th && th.shadow === true && th.bg !== s0.toolbarSeg.seg.bg, JSON.stringify({ thumbBg: th?.bg, trackBg: s0.toolbarSeg.seg.bg }))

    // 点击第 3 段（源码）→ 模式切换，指示块位移正好一段宽
    await clickSeg('toolbar', 2)
    const s1 = await probe()
    console.log('AFTER-CLICK ' + JSON.stringify({ mode: s1.mode, activeIdx: s1.toolbarSeg.activeIdx, thumb: s1.toolbarSeg.thumb, selected: s1.toolbarSeg.selected }))
    c('click-switches-mode', s1.mode === 'source' && s1.toolbarSeg.activeIdx === 2, JSON.stringify({ mode: s1.mode, activeIdx: s1.toolbarSeg.activeIdx }))
    c('aria-selected-follows', s1.toolbarSeg.selected.join(',') === 'false,false,true', JSON.stringify(s1.toolbarSeg.selected))
    c('thumb-slid-exactly-one-segment', Math.abs(s1.toolbarSeg.thumb.left - (s0.toolbarSeg.thumb.left + segW * 2)) <= 2, JSON.stringify({ from: s0.toolbarSeg.thumb.left, to: s1.toolbarSeg.thumb.left, segW }))

    // 侧栏两段：切到列表视图
    await clickSeg('aside', 1)
    const s2 = await probe()
    c('aside-switches-view', s2.filesView === 'list' && s2.asideSeg.activeIdx === 1, JSON.stringify({ view: s2.filesView, activeIdx: s2.asideSeg.activeIdx }))
    c('aside-thumb-follows', Math.abs(s2.asideSeg.thumb.left - s2.asideSeg.segments[1].left) <= 1, JSON.stringify({ thumb: s2.asideSeg.thumb.left, seg: s2.asideSeg.segments[1].left }))
    await clickSeg('aside', 0)
    await clickSeg('toolbar', 0)

    // 主题：令牌驱动 → 指示块/轨道颜色随主题变化（切主题后等一帧，颜色过渡 150ms）
    const themes = {}
    for (const th2 of ['light', 'dark', 'sepia']) {
      await w.ev(`(() => { window.__G.settings().set('theme', '${th2}'); return 'ok' })()`)
      await sleep(1200)
      const s = await probe()
      themes[th2] = { thumbBg: s.toolbarSeg.thumb.bg, trackBg: s.toolbarSeg.seg.bg }
      const shot = await w.send('Page.captureScreenshot', {
        format: 'png',
        clip: (() => {
          const t = s.toolbarSeg.seg
          return { x: Math.max(0, t.left - 12), y: Math.max(0, t.top - 8), width: Math.min(420, t.w + 24), height: t.h + 16, scale: 3 }
        })()
      })
      const data = shot.result?.data
      if (data) {
        const out = path.join(os.tmpdir(), `lumin-seg-${th2}.png`)
        fs.writeFileSync(out, Buffer.from(data, 'base64'))
        console.log('saved ' + out)
      }
    }
    console.log('THEMES ' + JSON.stringify(themes))
    c('theme-tokens-drive-colors', new Set(Object.values(themes).map((x) => x.thumbBg)).size === 3 && new Set(Object.values(themes).map((x) => x.trackBg)).size === 3, JSON.stringify(themes))
    await w.ev(`(() => { window.__G.settings().set('theme', 'light'); return 'ok' })()`)
    await sleep(800)

    // 工具栏不横向溢出
    const s3 = await probe()
    c('toolbar-no-horizontal-overflow', (s3.toolbarOverflow ?? 0) <= 1, 'overflow=' + s3.toolbarOverflow)

    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    await w.ev(`(async () => { const f = window.__G.files(); f.close(); await f.setRoot(null); return 'ok' })()`).catch(() => {})
    await sleep(300)
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
