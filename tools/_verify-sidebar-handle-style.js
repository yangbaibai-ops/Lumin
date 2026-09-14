// 验收：侧边栏折叠时的左缘展开把手——热区阈值/迟滞、动效、外观、点击展开
//
// 断言：
//  A. 侧边栏折叠后把手存在；样式类为 .sidebar-handle（不再用 Tailwind translate 工具类拼）
//  B. 热区：指针进到 SHOW(120px) 内 → 浮现；退到 HIDE(200px) 外 → 收起；
//     介于两者之间（迟滞带）**保持当前状态**（不闪）
//  C. 收起态整体在窗口之外（right <= 0）且 opacity 0 + pointer-events none；浮现态左边贴 0
//  D. 动效：过渡作用在 **transform** 上（不是 Tailwind 的 translate 长属性——
//     长属性没被过渡时位移不参与动画，就是「跳一下」），并有 easing/时长
//  E. 外观：圆角只在右侧、玻璃质感（backdrop-filter）、投影、颜色随主题令牌变化
//  F. 悬停/键盘聚焦时都会浮现；点击后侧边栏展开且设置落库
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
  window.__H = { ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
  return 'ok'
})()`

/** 把手状态：是否挂载、类名、几何、计算样式里的动效/外观要素 */
const PROBE = `(() => {
  const el = document.querySelector('.sidebar-handle')
  if (!el) return JSON.stringify({ present: false })
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const shown = el.classList.contains('is-shown')
  return JSON.stringify({
    present: true,
    shown,
    rect: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    opacity: cs.opacity,
    pointerEvents: cs.pointerEvents,
    transform: cs.transform,
    translateLonghand: cs.translate,
    transitionProperty: cs.transitionProperty,
    transitionDuration: cs.transitionDuration,
    transitionTiming: cs.transitionTimingFunction,
    radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].join(' '),
    backdrop: cs.backdropFilter,
    shadow: cs.boxShadow !== 'none',
    color: cs.color,
    background: cs.backgroundColor,
    width: cs.width,
    willChange: cs.willChange,
    sidebarVisible: window.__H.ui().sidebarVisible
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
    if ((await w.ev(SETUP)) === 'ok' && (await w.ev(`window.__H.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await w.ev(SETUP)
  const probe = async () => JSON.parse(await w.ev(PROBE))
  /** 把指针移到指定横坐标（纵坐标取窗口中上部，避开浮层） */
  const moveTo = async (x, y = 300) => {
    await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await sleep(450)
  }
  const theme = async (name) => {
    await w.ev(`(() => { window.__H.settings().set('theme', '${name}'); return 'ok' })()`)
    await sleep(1100)
  }

  try {
    // 折叠侧边栏（走设置，等同工具栏/菜单的开关）
    await w.ev(`(() => { const u = window.__H.ui(); u.sidebarVisible = false; window.__H.settings().set('sidebarVisible', false); return 'ok' })()`)
    await sleep(900)

    // 指针在远处 → 收起态
    await moveTo(700)
    const hidden = await probe()
    console.log('HIDDEN ' + JSON.stringify(hidden))
    c('handle-present-when-collapsed', hidden.present === true, JSON.stringify(hidden.present))
    c('hidden-offscreen-entirely', hidden.shown === false && hidden.rect.right <= 0, JSON.stringify(hidden.rect))
    c('hidden-not-interactive', hidden.opacity === '0' && hidden.pointerEvents === 'none', JSON.stringify({ opacity: hidden.opacity, pe: hidden.pointerEvents }))

    // 热区：120 内浮现
    await moveTo(80)
    const shown80 = await probe()
    c('shows-inside-hot-zone', shown80.shown === true && shown80.opacity === '1', JSON.stringify({ shown: shown80.shown, opacity: shown80.opacity }))
    c('shown-flush-to-edge', shown80.rect.left === 0, JSON.stringify(shown80.rect))

    // 迟滞带：退到 150（> SHOW 但 < HIDE）仍保持浮现 → 不闪
    await moveTo(150)
    const held = await probe()
    c('hysteresis-holds-between-thresholds', held.shown === true, JSON.stringify({ shown: held.shown, x: 150 }))

    // 超出 HIDE(200) → 收起
    await moveTo(260)
    const hidden260 = await probe()
    c('hides-beyond-hide-threshold', hidden260.shown === false, JSON.stringify({ shown: hidden260.shown, x: 260 }))

    // 再次进入 → 又浮现（阈值内）
    await moveTo(100)
    const again = await probe()
    c('reshows-on-approach', again.shown === true, JSON.stringify({ shown: again.shown }))

    // 动效：过渡必须作用在 transform（而不是 Tailwind 的 translate 长属性）
    const anim = again
    c('transition-covers-transform', anim.transitionProperty.includes('transform') && anim.transitionProperty.includes('opacity'), JSON.stringify(anim.transitionProperty))
    c('transition-has-easing-and-duration', /cubic-bezier/.test(anim.transitionTiming) && /0\.[23]s/.test(anim.transitionDuration), JSON.stringify({ timing: anim.transitionTiming, duration: anim.transitionDuration }))
    c('movement-uses-transform-not-longhand', anim.transform !== 'none' && anim.translateLonghand === 'none', JSON.stringify({ transform: anim.transform, translate: anim.translateLonghand }))
    c('gpu-friendly-will-change', /transform/.test(anim.willChange || ''), JSON.stringify(anim.willChange))

    // 外观
    c('rounded-only-on-right', anim.radius === '0px 12px 12px 0px', JSON.stringify(anim.radius))
    c('glass-surface-with-shadow', /blur/.test(anim.backdrop || '') && anim.shadow === true, JSON.stringify({ backdrop: anim.backdrop, shadow: anim.shadow }))
    c('slim-pill-size', anim.rect.w <= 26 && anim.rect.h >= 48 && anim.rect.h <= 64, JSON.stringify(anim.rect))

    // 主题：颜色/底色随令牌变化
    const colors = { light: { color: anim.color, bg: anim.background } }
    await theme('dark')
    colors.dark = (await probe()) && { color: (await probe()).color, bg: (await probe()).background }
    await theme('sepia')
    colors.sepia = { color: (await probe()).color, bg: (await probe()).background }
    console.log('THEMES ' + JSON.stringify(colors))
    c('theme-tokens-adapt', new Set(Object.values(colors).map((x) => x.bg)).size === 3 && new Set(Object.values(colors).map((x) => x.color)).size >= 2, JSON.stringify(colors))
    await theme('light')

    // 截图（浮现态，3 主题）供人工看观感
    for (const th of ['light', 'dark', 'sepia']) {
      await theme(th)
      await moveTo(60)
      const r = (await probe()).rect
      const shot = await w.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: Math.max(0, r.top - 30), width: 220, height: r.h + 60, scale: 3 }
      })
      if (shot.result?.data) {
        const out = path.join(os.tmpdir(), `lumin-handle-${th}.png`)
        fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
        console.log('saved ' + out)
      }
    }
    await theme('light')

    // 键盘聚焦也会浮现（把手自身 focus）
    await moveTo(700)
    await w.ev(`(() => { document.querySelector('.sidebar-handle').focus(); return 'ok' })()`)
    await sleep(600)
    const focused = await probe()
    c('focus-reveals-handle', focused.shown === true, JSON.stringify({ shown: focused.shown }))

    // 点击展开 + 落库
    await w.ev(`(() => { document.querySelector('.sidebar-handle').click(); return 'ok' })()`)
    await sleep(900)
    const afterClick = JSON.parse(await w.ev(`JSON.stringify({ sidebarVisible: window.__H.ui().sidebarVisible, persisted: window.__H.settings().sidebarVisible, handlePresent: !!document.querySelector('.sidebar-handle') })`))
    c('click-expands-sidebar', afterClick.sidebarVisible === true && afterClick.persisted === true, JSON.stringify(afterClick))
    c('handle-removed-when-expanded', afterClick.handlePresent === false, JSON.stringify(afterClick.handlePresent))
  } finally {
    await w.ev(`(() => { window.__H.settings().set('sidebarVisible', true); window.__H.ui().sidebarVisible = true; return 'ok' })()`).catch(() => {})
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
