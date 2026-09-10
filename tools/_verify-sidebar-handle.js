// 验收：侧边栏折叠时的「左缘悬停展开把手」（阈值版）
// 覆盖：默认不可见且完全不吃点击 → 进入左缘阈值内滑出 → 阈值外自动隐藏 →
//       指针停在把手上不消失 → 点击展开并持久化 → 键盘聚焦浮现 → 真实过渡路径
//
// 注意：Electron 窗口处于后台时会被 Chromium 节流，合成指针事件与 CSS transition
// 都有延迟，因此所有可见性断言都走「先确认相反态 → 移动 → 轮询到期望态」的
// transitionTo()，既不会因延迟误判，也不会把遗留状态当成通过。
const CDP = 'http://127.0.0.1:9222/json'
const IN_PX = 31 // 阈值内（阈值 32）
const OUT_PX = 33 // 阈值外
const FAR_PX = 700 // 远离左缘
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function moveTo(x, y) {
  // 首次移动可能被当作指针 warp，发两次；y 差 1px 确保是真实位移
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y - 1, button: 'none', buttons: 0 })
  await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
}
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(30)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
/** 强制出帧：后台窗口会节流 CSS transition，否则 computed style 读数不收敛 */
async function frame() { await send('Page.captureScreenshot', { format: 'jpeg', quality: 1 }) }

const HANDLE = 'button.absolute.left-0'
const snapshot = `(() => {
  const btn = document.querySelector(${JSON.stringify(HANDLE)})
  if (!btn) return JSON.stringify({ present: false, sidebarVisible: window.__vt.ui().sidebarVisible, opacity: null })
  const cs = getComputedStyle(btn), r = btn.getBoundingClientRect()
  const cy = Math.round(r.top + r.height / 2)
  const at2 = document.elementFromPoint(2, cy)
  return JSON.stringify({
    present: true,
    opacity: cs.opacity,
    pointerEvents: cs.pointerEvents,
    rect: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
    cy,
    aria: btn.getAttribute('aria-label'),
    at2: at2 ? at2.tagName : null,
    at2InHandle: at2 ? btn.contains(at2) : false
  })
})()`

let cy = 492

/** 先确认当前处于「相反态」，再移动指针并轮询到期望态；返回 { ok, before, after } */
async function transitionTo(x, y, expect, ms = 6000) {
  await frame()
  await sleep(150)
  const before = JSON.parse(await ev(snapshot))
  if (before.opacity === expect) return { ok: false, reason: `stuck-at-${expect}`, before, after: before }
  await moveTo(x, y)
  const t0 = Date.now()
  let s = before
  while (Date.now() - t0 < ms && s.opacity !== expect) {
    await frame()
    await sleep(150)
    s = JSON.parse(await ev(snapshot))
  }
  return { ok: s.opacity === expect, before, after: s }
}

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await send('Page.reload')
  for (let i = 0; i < 80; i++) { await sleep(250); if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break }
  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym]
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'ok'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  for (let i = 0; i < 80; i++) { await sleep(250); if ((await ev(`window.__vt.ui().booting ? 'booting' : 'ready'`)) === 'ready') break }
  await sleep(400)

  const original = JSON.parse(await ev(`JSON.stringify({ sidebarVisible: window.__vt.ui().sidebarVisible, persisted: window.__vt.settings().sidebarVisible })`))
  console.log('ORIGINAL  ' + JSON.stringify(original))
  await ev(`(() => { const s = document.createElement('style'); s.id = 'no-trans'; s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'; document.head.appendChild(s); return 'ok' })()`)

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // 折叠 + 指针远离左缘 → 把手应不可见、完全不吃点击
  await ev(`(() => { window.__vt.ui().sidebarVisible = false; return 'ok' })()`)
  await moveTo(FAR_PX, 400)
  await frame()
  await sleep(350)
  const hidden = JSON.parse(await ev(snapshot))
  cy = hidden.cy ?? cy
  console.log('HIDDEN    ' + JSON.stringify(hidden))
  c('handle-exists-when-collapsed', hidden.present === true)
  c('hidden-opacity-0', hidden.opacity === '0', hidden.opacity)
  c('hidden-pointer-events-none', hidden.pointerEvents === 'none', hidden.pointerEvents)
  c('hidden-offscreen-4px', hidden.rect?.left === -4, 'left=' + hidden.rect?.left)
  c('no-hit-test-at-edge', hidden.at2InHandle === false, hidden.at2)
  c('aria-tooltip', hidden.aria === '展开侧边栏', hidden.aria)

  // 阈值内 20px：必须由「不可见 → 可见」发生翻转
  const r20 = await transitionTo(20, cy, '1')
  console.log('X=20      ' + JSON.stringify(r20.after))
  c('threshold-inside-20px', r20.ok, `${r20.before.opacity} -> ${r20.after.opacity}`)
  c('slid-in', r20.after.rect?.left === 0 && r20.after.rect?.w === 18 && r20.after.rect?.h === 48, JSON.stringify(r20.after.rect))
  c('interactive-at-edge', r20.after.at2InHandle === true, `${r20.after.at2InHandle} (${r20.after.at2})`)
  const centerY = r20.after.cy ?? cy

  // 停在把手上（x=9）不消失、不抖动：连续采样 10 次必须始终可见
  await moveTo(9, centerY)
  await frame()
  await sleep(400)
  const samples = []
  for (let i = 0; i < 10; i++) {
    await frame()
    samples.push(JSON.parse(await ev(snapshot)).opacity)
    await sleep(90)
  }
  const onHandle = JSON.parse(await ev(snapshot))
  c('stays-open-on-handle', onHandle.opacity === '1', onHandle.opacity)
  c('no-flicker-on-handle', samples.every((o) => o === '1'), samples.join(','))

  // 边界：31px 内应可见 / 33px 外应隐藏（每次都由相反态真实翻转）
  const rAway = await transitionTo(FAR_PX, 400, '0')
  c('hides-when-away', rAway.ok, `${rAway.before.opacity} -> ${rAway.after.opacity}`)
  const rIn = await transitionTo(IN_PX, centerY, '1')
  c(`threshold-${IN_PX}px-inside`, rIn.ok, `${rIn.before.opacity} -> ${rIn.after.opacity}`)
  const rOut = await transitionTo(OUT_PX, centerY, '0')
  c(`threshold-${OUT_PX}px-outside`, rOut.ok && rOut.after.pointerEvents === 'none', `${rOut.before.opacity} -> ${rOut.after.opacity} (${rOut.after.pointerEvents})`)

  // 点击 → 展开并持久化
  const rClick = await transitionTo(20, centerY, '1')
  c('reveal-before-click', rClick.ok, `${rClick.before.opacity} -> ${rClick.after.opacity}`)
  await clickAt(9, centerY)
  let after = null
  for (let i = 0; i < 40; i++) {
    await sleep(200)
    after = JSON.parse(await ev(`JSON.stringify({ ui: window.__vt.ui().sidebarVisible, persisted: window.__vt.settings().sidebarVisible, aside: !!document.querySelector('aside'), handle: !!document.querySelector(${JSON.stringify(HANDLE)}) })`))
    if (after.ui === true) break
  }
  console.log('AFTER-CLICK ' + JSON.stringify(after))
  c('click-expands', after.ui === true && after.aside === true, JSON.stringify(after))
  c('persisted', after.persisted === true, 'persisted=' + after.persisted)
  c('handle-removed-when-expanded', after.handle === false)

  // 键盘聚焦同样浮现（折叠态下 Tab 到把手）
  await ev(`(() => { window.__vt.ui().sidebarVisible = false; return 'ok' })()`)
  await moveTo(FAR_PX, 400)
  await frame()
  await sleep(300)
  await ev(`(() => { document.querySelector(${JSON.stringify(HANDLE)})?.focus(); return 'ok' })()`)
  await frame()
  await sleep(300)
  const focused = JSON.parse(await ev(`(() => { const b = document.querySelector(${JSON.stringify(HANDLE)}); if (!b) return JSON.stringify({ missing: true }); const cs = getComputedStyle(b); return JSON.stringify({ opacity: cs.opacity, pointerEvents: cs.pointerEvents, active: document.activeElement === b }) })()`))
  c('focus-reveals', focused.opacity === '1' && focused.pointerEvents === 'auto' && focused.active, JSON.stringify(focused))
  await ev(`(() => { document.activeElement?.blur(); return 'ok' })()`)
  await moveTo(FAR_PX, 400)
  await sleep(200)

  // 真实过渡路径（去掉禁用过渡）
  await ev(`(() => { document.getElementById('no-trans')?.remove(); return 'ok' })()`)
  await moveTo(FAR_PX, 400)
  for (let i = 0; i < 8; i++) { await frame(); await sleep(60) }
  const rAnim = await transitionTo(20, centerY, '1')
  c('transition-reveals', rAnim.ok && rAnim.after.rect?.left === 0, `${rAnim.before.opacity} -> ${rAnim.after.opacity} / left=${rAnim.after.rect?.left}`)
  await moveTo(FAR_PX, 400)

  // 还原测试前状态
  await ev(`(async () => { const ui = window.__vt.ui(), s = window.__vt.settings(); ui.sidebarVisible = ${original.sidebarVisible}; await s.set('sidebarVisible', ${original.persisted}); return 'ok' })()`)
  await sleep(400)
  const restored = JSON.parse(await ev(`JSON.stringify({ ui: window.__vt.ui().sidebarVisible, persisted: window.__vt.settings().sidebarVisible })`))
  c('restored', restored.ui === original.sidebarVisible && restored.persisted === original.persisted, JSON.stringify(restored))

  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
