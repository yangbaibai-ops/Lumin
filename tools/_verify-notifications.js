// 验收：全局通知中心
// A. 数据层：SQLite CRUD（增/查/改/合并/软关闭/全关/硬删/清理）+ 跨渲染层重载持久化
// B. 界面层：单卡片、宽高、无左侧色条、级别图标+文字、标题/详情、X、不自动消失、
//    ‹ n/m › 切换（默认最新）、全部关闭、多语言、动效
const CDP = 'http://127.0.0.1:9222/json'
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
async function clickPoint(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
/** 点击卡片内某个按钮（按 aria-label 精确定位，避免依赖顺序） */
async function clickByLabel(label) {
  const p = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('.ntf-card button')).find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.getAttribute('title') === ${JSON.stringify(label)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!p) return false
  const pt = JSON.parse(p)
  await clickPoint(pt.x, pt.y)
  return true
}
const CARD = `(() => {
  const cards = Array.from(document.querySelectorAll('.ntf-card'))
  const card = cards[0]
  if (!card) return JSON.stringify({ cards: 0 })
  const r = card.getBoundingClientRect()
  const cs = getComputedStyle(card)
  const icon = card.querySelector('span svg')
  const title = card.querySelector('p')?.textContent?.trim() ?? ''
  const footer = Array.from(card.querySelectorAll('footer span')).map((s) => s.textContent.trim()).filter(Boolean)
  const navBtns = Array.from(card.querySelectorAll('footer button')).map((b) => b.getAttribute('aria-label') || b.textContent.trim())
  return JSON.stringify({
    cards: cards.length,
    width: Math.round(r.width),
    height: Math.round(r.height),
    padding: cs.padding,
    radius: cs.borderTopLeftRadius,
    shadow: cs.boxShadow !== 'none',
    blur: cs.backdropFilter,
    transition: cs.transitionDuration,
    leftBars: card.querySelectorAll('span.absolute').length,
    title,
    body: card.querySelector('p + p, .ntf-body')?.textContent?.trim() ?? '',
    footer,
    iconPaths: icon ? icon.querySelectorAll('path, circle, rect').length : 0,
    iconD: icon ? Array.from(icon.querySelectorAll('path')).map((p) => p.getAttribute('d')).join('|') : null,
    iconColor: icon ? getComputedStyle(icon.parentElement).color : null,
    navBtns,
    footerFits: (() => { const f = card.querySelector('footer'); return !!f && f.scrollWidth <= f.clientWidth + 1 })(),
    closeBtn: !!Array.from(card.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('关闭此通知') || (b.getAttribute('title') || '').includes('关闭此通知'))
  })
})()`

const LEVELS = [
  { level: 'info', zh: '通知' },
  { level: 'success', zh: '已完成' },
  { level: 'warning', zh: '告警' },
  { level: 'error', zh: '报错' }
]

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
    const pinia = app._context.provides[sym] ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map) ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), notif: () => pinia._s.get('notifications'), settings: () => pinia._s.get('settings') }
    return 'ok'
  })()`)

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  const pre = JSON.parse(await ev(`(async () => {
    const open = await window.luminAPI.notifications.list()
    const all = await window.luminAPI.notifications.list({ includeClosed: true })
    return JSON.stringify({ open: open.length, total: all.length })
  })()`))
  console.log('PRE ' + JSON.stringify(pre))
  if (pre.open > 0) {
    console.log('SKIP: 存在未关闭的真实通知，跳过（避免影响既有数据）')
    ws.close()
    return
  }
  // 只清掉历史（已关闭）行，测试全程结束后 DB 恢复为空
  if (pre.total > 0) {
    await ev(`window.luminAPI.notifications.clearClosed()`)
    console.log('cleared stale closed rows: ' + pre.total)
  }

  // ── A. 数据层 ────────────────────────────────────────────────────────────
  const a = JSON.parse(await ev(`(async () => {
    const api = window.luminAPI.notifications
    const created = await api.add({ level: 'warning', title: '磁盘空间不足', body: '剩余 512 MB' })
    const merged = await api.add({ level: 'warning', title: '磁盘空间不足', body: '剩余 256 MB' })
    const listed = await api.list()
    const updated = await api.update(created.id, { level: 'error', title: '磁盘空间严重不足' })
    await api.close(created.id)
    const openAfterClose = await api.list()
    const withClosed = await api.list({ includeClosed: true })
    const closedRow = withClosed.find((n) => n.id === created.id)
    const removed = await api.remove(created.id)
    const afterRemove = await api.list({ includeClosed: true })
    const cleared = await api.clearClosed()
    const finalList = await api.list({ includeClosed: true })
    return JSON.stringify({
      createdId: created.id, mergedId: merged.id, sameRow: created.id === merged.id,
      listedCount: listed.length, mergedBody: listed[0]?.body, mergedLevel: listed[0]?.level,
      updated: { level: updated?.level, title: updated?.title, body: updated?.body },
      openAfterClose: openAfterClose.length,
      closedAtSet: closedRow ? closedRow.closedAt !== null : null,
      afterRemove: afterRemove.length, cleared, finalList: finalList.length, removed: removed === undefined
    })
  })()`))
  console.log('DATA ' + JSON.stringify(a))
  c('add-creates-row', typeof a.createdId === 'number' && a.listedCount === 1, JSON.stringify(a))
  c('merge-same-key-updates', a.sameRow === true && a.mergedBody === '剩余 256 MB', JSON.stringify(a))
  c('update-title-body-level', a.updated?.level === 'error' && a.updated?.title === '磁盘空间严重不足' && a.updated?.body === '剩余 256 MB', JSON.stringify(a.updated))
  c('close-is-soft-delete', a.openAfterClose === 0 && a.closedAtSet === true, JSON.stringify(a))
  c('hard-remove-and-clear', a.afterRemove === 0 && a.finalList === 0, JSON.stringify({ afterRemove: a.afterRemove, finalList: a.finalList, cleared: a.cleared }))

  const all = JSON.parse(await ev(`(async () => {
    const api = window.luminAPI.notifications
    await api.add({ level: 'info', title: 'A', body: 'a' })
    await api.add({ level: 'success', title: 'B', body: 'b' })
    const beforeCount = (await api.list()).length
    const closedCount = await api.closeAll()
    const afterCount = (await api.list()).length
    const clearedClosed = await api.clearClosed()
    return JSON.stringify({ beforeCount, closedCount, afterCount, clearedClosed })
  })()`))
  console.log('CLOSE-ALL ' + JSON.stringify(all))
  c('close-all-marks-everything', all.beforeCount === 2 && all.closedCount === 2 && all.afterCount === 0, JSON.stringify(all))

  // ── B. 界面层 ────────────────────────────────────────────────────────────
  // 造三条通知（含标题/详情），并确认只渲染一张卡片
  await ev(`(async () => {
    const n = window.__vt.notif()
    await n.notify({ level: 'info', title: '通知标题一', body: '第一条通知的详细内容' })
    await n.notify({ level: 'warning', title: '告警标题二', body: '第二条通知的详细内容' })
    await n.notify({ level: 'error', title: '报错标题三', body: '第三条通知的详细内容' })
    return 'ok'
  })()`)
  await sleep(600)
  const card = JSON.parse(await ev(CARD))
  console.log('CARD ' + JSON.stringify(card))
  c('only-one-card', card.cards === 1, 'cards=' + card.cards)
  // 卡片尺寸与圆角按当前设计：宽 384、小圆角 6px（rounded-md）。此前写死 400/12px 已与实现脱节。
  c('compact-width-and-taller', card.width === 384 && card.height >= 96, `w=${card.width} h=${card.height}`)
  c('smaller-radius', card.radius === '6px', 'radius=' + card.radius)
  c('footer-fits', card.footerFits === true, JSON.stringify({ footerFits: card.footerFits, footer: card.footer }))
  c('no-left-color-bar', card.leftBars === 0, 'leftBars=' + card.leftBars)
  c('has-title-and-body', card.title === '报错标题三' && card.body === '第三条通知的详细内容', JSON.stringify({ t: card.title, b: card.body }))
  c('default-shows-newest', card.title === '报错标题三' && card.footer.includes('1/3'), JSON.stringify(card.footer))
  c('level-label-from-i18n', card.footer.includes('报错'), JSON.stringify(card.footer))
  c('has-close-button', card.closeBtn === true, JSON.stringify(card.navBtns))
  c('has-stepper-and-close-all', card.navBtns.length >= 3, JSON.stringify(card.navBtns))
  c('animated-card', parseFloat(card.transition) > 0 && card.blur !== 'none', `transition=${card.transition} blur=${card.blur}`)

  // 级别图标各不相同（依次切换三条通知）
  const iconFingerprints = []
  for (let i = 0; i < 3; i++) {
    const snap = JSON.parse(await ev(CARD))
    iconFingerprints.push({ title: snap.title, iconD: snap.iconD, color: snap.iconColor, label: snap.footer.find((f) => LEVELS.some((l) => l.zh === f)) })
    await clickByLabel('下一条通知')
    await sleep(450)
  }
  // 切了 3 次回到起点（循环）
  const backToStart = JSON.parse(await ev(CARD))
  console.log('ICONS ' + JSON.stringify(iconFingerprints) + ' -> ' + backToStart.title)
  const uniqueIcons = new Set(iconFingerprints.map((f) => String(f.iconD)))
  const uniqueColors = new Set(iconFingerprints.map((f) => String(f.color)))
  c('level-icons-distinct', uniqueIcons.size === 3, iconFingerprints.map((f) => f.label + ':' + String(f.iconD).slice(0, 24)).join(' || '))
  c('level-colors-distinct', uniqueColors.size === 3, JSON.stringify([...uniqueColors]))
  c('stepper-wraps-around', backToStart.title === '报错标题三', backToStart.title)

  // 切换顺序：› 显示更旧的一条
  await clickByLabel('下一条通知')
  await sleep(400)
  const older = JSON.parse(await ev(CARD))
  c('next-shows-older', older.title === '告警标题二' && older.footer.includes('2/3'), JSON.stringify({ t: older.title, f: older.footer }))
  await clickByLabel('上一条通知')
  await sleep(400)
  const newer = JSON.parse(await ev(CARD))
  c('prev-shows-newer', newer.title === '报错标题三' && newer.footer.includes('1/3'), JSON.stringify({ t: newer.title, f: newer.footer }))

  // 不自动消失：等待 6 秒仍在
  await sleep(6000)
  const stillThere = JSON.parse(await ev(CARD))
  c('no-auto-dismiss', stillThere.cards === 1 && (await ev(`window.__vt.notif().items.length`)) === 3, JSON.stringify({ cards: stillThere.cards }))

  // 关闭当前 → 自动展示相邻一条，且数据库侧关闭
  const closedFirst = await clickByLabel('关闭此通知')
  await sleep(700)
  const afterClose = JSON.parse(await ev(CARD))
  const openInDb = await ev(`(async () => (await window.luminAPI.notifications.list()).length)()`)
  console.log('AFTER-CLOSE ' + JSON.stringify(afterClose) + ' dbOpen=' + openInDb)
  c('close-button-works', closedFirst === true && afterClose.cards === 1 && openInDb === 2, JSON.stringify({ afterClose: afterClose.title, openInDb }))
  c('counter-updates', afterClose.footer.includes('1/2'), JSON.stringify(afterClose.footer))

  // 多语言：切到英文看级别文案
  await ev(`window.__vt.settings().set('language', 'en-US')`)
  await sleep(600)
  const en = JSON.parse(await ev(CARD))
  c('i18n-en', en.footer.includes('Warning') || en.footer.includes('Notice'), JSON.stringify(en.footer))
  await ev(`window.__vt.settings().set('language', 'zh-CN')`)
  await sleep(600)

  // 跨渲染层重载持久化：reload 后应重新从 SQLite 恢复
  await send('Page.reload')
  for (let i = 0; i < 80; i++) { await sleep(250); if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break }
  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym] ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map) ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), notif: () => pinia._s.get('notifications'), settings: () => pinia._s.get('settings') }
    return 'ok'
  })()`)
  for (let i = 0; i < 60; i++) { await sleep(250); if ((await ev(`window.__vt.ui().booting ? 'booting' : 'ready'`)) === 'ready') break }
  await sleep(500)
  const restored = JSON.parse(await ev(`(() => JSON.stringify({ storeCount: window.__vt.notif().items.length, cards: document.querySelectorAll('.ntf-card').length, title: document.querySelector('.ntf-card p')?.textContent?.trim() ?? null }))()`))
  console.log('AFTER-RELOAD ' + JSON.stringify(restored))
  c('survives-renderer-reload', restored.storeCount === 2 && restored.cards === 1, JSON.stringify(restored))

  // 全部关闭（一并关闭）
  const closeAllOk = await clickByLabel('全部关闭')
  await sleep(700)
  const emptyUi = JSON.parse(await ev(`(() => JSON.stringify({ cards: document.querySelectorAll('.ntf-card').length, store: window.__vt.notif().items.length }))()`))
  const dbOpen = await ev(`(async () => (await window.luminAPI.notifications.list()).length)()`)
  console.log('CLOSE-ALL-UI ' + JSON.stringify(emptyUi) + ' dbOpen=' + dbOpen)
  c('close-all-button', closeAllOk === true && emptyUi.cards === 0 && dbOpen === 0, JSON.stringify({ emptyUi, dbOpen }))

  // 兼容层：旧的 ui.toast(message, type) 应落到通知中心，并且同级别+同标题自动合并
  await ev(`(async () => { const ui = window.__vt.ui(); ui.toast('已保存', 'success'); await new Promise((r) => setTimeout(r, 400)); ui.toast('已保存', 'success'); return 'ok' })()`)
  await sleep(800)
  const legacy = JSON.parse(await ev(CARD))
  const legacyDb = await ev(`(async () => (await window.luminAPI.notifications.list()).length)()`)
  console.log('LEGACY-TOAST ' + JSON.stringify(legacy) + ' dbOpen=' + legacyDb)
  c('legacy-toast-routes-to-center', legacy.cards === 1 && legacy.title === '已保存' && legacy.footer.includes('已完成'), JSON.stringify({ t: legacy.title, f: legacy.footer }))
  c('legacy-toast-merges-repeat', legacyDb === 1, 'dbOpen=' + legacyDb)

  // 复原：把测试期间的通知全部关闭并清掉历史行
  const cleaned = await ev(`(async () => { await window.luminAPI.notifications.closeAll(); const n = await window.luminAPI.notifications.clearClosed(); const left = await window.luminAPI.notifications.list({ includeClosed: true }); window.__vt.notif().items = []; window.__vt.notif().activeId = null; return JSON.stringify({ cleared: n, left: left.length }) })()`)
  console.log('CLEANUP ' + cleaned)
  c('db-left-clean', JSON.parse(cleaned).left === 0, cleaned)

  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
