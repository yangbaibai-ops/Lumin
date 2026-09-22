// 验收（非破坏式）：通知条样式 —— 本轮口径是**取消长方形组件**（像 Typora 一样把内容
// 直接展示在编辑区上方那块区域里），所以这里量的是「没有盒子」+「真的用上了横向空间」，
// 而不是旧的「宽 384 / 圆角 6px / 图标圆角 8px」。
// 只在库里临时插一条带标记的通知，量完硬删，并校验既有通知一行未变。
const CDP = 'http://127.0.0.1:9222/json'
const MARK = '样式校验-' + Date.now()
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
const SNAP = `(async () => { const all = await window.luminAPI.notifications.list({ includeClosed: true }); return JSON.stringify(all.map((n) => n.id + '|' + n.level + '|' + n.title + '|' + (n.closedAt !== null)).sort()) })()`
const ITEM = `(() => {
  const items = Array.from(document.querySelectorAll('.ntf-item'))
  const item = items[0]
  if (!item) return JSON.stringify({ items: 0 })
  const r = item.getBoundingClientRect()
  const cs = getComputedStyle(item)
  const strip = item.closest('.ntf-strip')
  const sr = strip ? strip.getBoundingClientRect() : null
  const meta = item.querySelector('[data-ntf-meta]')
  const body = item.querySelector('.ntf-body')
  return JSON.stringify({
    items: items.length,
    width: Math.round(r.width),
    height: Math.round(r.height),
    stripWidth: sr ? Math.round(sr.width) : null,
    border: cs.borderTopWidth,
    radius: cs.borderTopLeftRadius,
    shadow: cs.boxShadow,
    blur: cs.backdropFilter,
    background: cs.backgroundColor,
    title: item.querySelector('p')?.textContent?.trim() ?? '',
    iconCount: item.querySelectorAll('svg').length,
    metaText: meta?.textContent?.trim() ?? '',
    metaFits: !!meta && meta.scrollWidth <= meta.clientWidth + 1,
    bodyFits: !!body && body.scrollWidth <= body.clientWidth + 1,
    bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
    bodyMaxH: body ? getComputedStyle(body).maxHeight : null
  })
})()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = app._context.provides[sym]
    window.__vt = { notif: () => pinia._s.get('notifications') }
    return 'ok'
  })()`)

  const before = JSON.parse(await ev(SNAP))
  console.log('ROWS(before) ' + JSON.stringify(before))

  const created = JSON.parse(await ev(`(async () => JSON.stringify(await window.__vt.notif().notify({ level: 'warning', title: ${JSON.stringify(MARK)}, body: '这是一条用于量取通知条样式的临时通知，量完即删。它可以很长，长到需要在区域内滚动。' })))()`))
  await sleep(700)
  const item = JSON.parse(await ev(ITEM))
  console.log('ITEM ' + JSON.stringify(item))

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  // 「取消长方形组件」的四条硬证据：无边框、无圆角、无阴影、无毛玻璃、无底色
  c('no-border', item.border === '0px', 'border=' + item.border)
  c('no-radius', item.radius === '0px', 'radius=' + item.radius)
  c('no-shadow-and-blur', item.shadow === 'none' && item.blur === 'none', `shadow=${item.shadow} blur=${item.blur}`)
  c('no-background', item.background === 'rgba(0, 0, 0, 0)', 'bg=' + item.background)
  // 铺满可读栏宽（旧的 384px 窄条是这次要取消的东西）
  c('uses-horizontal-room', item.width >= 480, `w=${item.width}（旧实现固定 384）`)
  c('within-strip', item.stripWidth !== null && item.width <= item.stripWidth, `item=${item.width} strip=${item.stripWidth}`)
  c('shows-marker', item.title === MARK, item.title)
  c('single-notice-amid-existing', item.items === 1, `items=${item.items}（库中未关闭通知数 > 1 时仍只渲染一条）`)
  c('icon-rendered', item.iconCount >= 1, 'svg=' + item.iconCount)
  c('meta-and-body-no-overflow', item.metaFits === true && item.bodyFits === true, JSON.stringify({ metaFits: item.metaFits, bodyFits: item.bodyFits, meta: item.metaText }))
  // 长正文只在这块区域内滚动（不再把编辑区一路往下推，也不再被窗口底边裁掉）
  c('long-body-scrolls-in-place', item.bodyOverflowY === 'auto' && parseFloat(item.bodyMaxH) > 0, `overflowY=${item.bodyOverflowY} maxH=${item.bodyMaxH}`)

  // 关闭键的 tooltip：不得被压成竖排（贴着区域右缘时收缩适应会算出极窄可用宽度）
  const closeBtn = await ev(`(() => {
    const b = Array.from(document.querySelectorAll('.ntf-item button')).find((x) => (x.getAttribute('aria-label') || '').includes('关闭此通知'))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (closeBtn) {
    const pt = JSON.parse(closeBtn)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y - 2, button: 'none', buttons: 0 })
    await sleep(80)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 })
    await sleep(1100)
    const tip = await ev(`(() => {
      const el = document.querySelector('.lm-tooltip')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const lh = parseFloat(cs.lineHeight) || 18
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      return JSON.stringify({ text: el.textContent.trim(), width: Math.round(r.width), height: Math.round(r.height), lines: Math.max(1, Math.round((r.height - pad) / lh)), left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, writingMode: cs.writingMode, wordBreak: cs.wordBreak })
    })()`)
    console.log('TOOLTIP ' + tip)
    const t = tip ? JSON.parse(tip) : null
    c('tooltip-not-vertical', !!t && t.lines <= 2 && t.width >= 60, JSON.stringify(t))
    c('tooltip-inside-viewport', !!t && t.left >= 0 && t.right <= t.vw, JSON.stringify(t))
    // 移开鼠标收起浮层
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20, button: 'none', buttons: 0 })
    await sleep(300)
  } else {
    c('tooltip-not-vertical', false, 'close button not found')
  }

  // 清理：硬删临时通知（不动既有行，也不调用 clearClosed）
  await ev(`(async () => { const n = window.__vt.notif(); await n.remove(${created.id}); return 'ok' })()`)
  await sleep(400)
  const after = JSON.parse(await ev(SNAP))
  const cleanedUi = await ev(`document.querySelectorAll('.ntf-item').length`)
  console.log('ROWS(after)  ' + JSON.stringify(after) + ' items=' + cleanedUi)
  c('existing-rows-untouched', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }))
  c('marker-removed', !after.some((r) => r.includes(MARK)), MARK)

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  ws.close()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
