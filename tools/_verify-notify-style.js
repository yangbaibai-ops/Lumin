// 验收（非破坏式）：通知卡片尺寸/圆角调整
// 只在库里临时插一条带标记的通知，量完尺寸后硬删，并校验既有通知一行未变。
const CDP = 'http://127.0.0.1:9222/json'
const MARK = '样式校验-' + Date.now()
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
const SNAP = `(async () => { const all = await window.luminAPI.notifications.list({ includeClosed: true }); return JSON.stringify(all.map((n) => n.id + '|' + n.level + '|' + n.title + '|' + (n.closedAt !== null)).sort()) })()`
const CARD = `(() => {
  const cards = Array.from(document.querySelectorAll('.ntf-card'))
  const card = cards[0]
  if (!card) return JSON.stringify({ cards: 0 })
  const r = card.getBoundingClientRect()
  const cs = getComputedStyle(card)
  const footer = card.querySelector('footer')
  return JSON.stringify({
    cards: cards.length,
    width: Math.round(r.width),
    radius: cs.borderTopLeftRadius,
    iconRadius: getComputedStyle(card.querySelector('span')).borderTopLeftRadius,
    title: card.querySelector('p')?.textContent?.trim() ?? '',
    footerFits: !!footer && footer.scrollWidth <= footer.clientWidth + 1,
    bodyFits: card.scrollWidth <= card.clientWidth + 1,
    height: Math.round(r.height)
  })
})()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym]
    window.__vt = { notif: () => pinia._s.get('notifications') }
    return 'ok'
  })()`)

  const before = JSON.parse(await ev(SNAP))
  console.log('ROWS(before) ' + JSON.stringify(before))

  const created = JSON.parse(await ev(`(async () => JSON.stringify(await window.__vt.notif().notify({ level: 'warning', title: ${JSON.stringify(MARK)}, body: '这是一条用于量取卡片尺寸的临时通知，量完即删。' })))()`))
  await sleep(700)
  const card = JSON.parse(await ev(CARD))
  console.log('CARD ' + JSON.stringify(card))

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  c('width-384', card.width === 384, 'w=' + card.width)
  c('radius-12', card.radius === '12px', 'radius=' + card.radius)
  c('icon-radius-8', card.iconRadius === '8px', 'iconRadius=' + card.iconRadius)
  c('shows-marker', card.title === MARK, card.title)
  c('single-card-amid-existing', card.cards === 1, `cards=${card.cards}（库中未关闭通知数 > 1 时仍只渲染一张）`)
  c('footer-no-overflow', card.footerFits === true && card.bodyFits === true, JSON.stringify({ footerFits: card.footerFits, bodyFits: card.bodyFits }))
  c('taller-than-before', card.height >= 130, 'h=' + card.height + '（此前 120）')

  // 关闭键的 tooltip：不得被压成竖排（目标贴右缘时收缩适应会算出极窄可用宽度）
  const closeBtn = await ev(`(() => {
    const b = Array.from(document.querySelectorAll('.ntf-card button')).find((x) => (x.getAttribute('aria-label') || '').includes('关闭此通知'))
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
  const cleanedUi = await ev(`document.querySelectorAll('.ntf-card').length`)
  console.log('ROWS(after)  ' + JSON.stringify(after) + ' cards=' + cleanedUi)
  c('existing-rows-untouched', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }))
  c('marker-removed', !after.some((r) => r.includes(MARK)), MARK)

  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
