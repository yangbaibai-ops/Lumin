// 验收：全局通知中心
// A. 数据层：SQLite CRUD（增/查/改/合并/软关闭/全关/硬删/清理）+ 跨渲染层重载持久化
// B. 界面层：单条通知、**组件本身不是盒子**（面在编辑区上方一整幅「带」上）、
//    在编辑区上方、无级别图标与级别名、标题/详情、X、不自动消失、
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
    const el = Array.from(document.querySelectorAll('.ntf-item button')).find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.getAttribute('title') === ${JSON.stringify(label)})
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
  const items = Array.from(document.querySelectorAll('.ntf-item'))
  const item = items[0]
  if (!item) return JSON.stringify({ cards: 0 })
  const r = item.getBoundingClientRect()
  const cs = getComputedStyle(item)
  const strip = item.closest('.ntf-strip')
  const reveal = item.closest('.ntf-reveal')
  const scs = strip ? getComputedStyle(strip) : null
  const kernel = document.querySelector('[data-editor-kernel]')
  const icons = Array.from(item.querySelectorAll('svg'))
  const title = item.querySelector('p')?.textContent?.trim() ?? ''
  const meta = item.querySelector('[data-ntf-meta]')
  const count = item.querySelector('[data-ntf-count]')?.textContent?.trim() ?? ''
  const metaBtns = Array.from(meta?.querySelectorAll('button') ?? [])
  const navBtns = metaBtns.map((b) => b.getAttribute('aria-label') || b.textContent.trim())
  // 关闭键永远是信息条里最后一个按钮（它的可访问名会随语言变，不能按中文文案去找）
  const closeBtnEl = metaBtns.length ? metaBtns[metaBtns.length - 1] : null
  return JSON.stringify({
    cards: items.length,
    width: Math.round(r.width),
    height: Math.round(r.height),
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    // 组件不是盒子：无边框 / 无圆角 / 无底色；面在「带」上（底部 1px 分界 + 顶部内高光）
    borderWidth: cs.borderTopWidth,
    radius: cs.borderTopLeftRadius,
    background: cs.backgroundColor,
    band: scs ? { borderBottom: scs.borderBottomWidth, radius: scs.borderTopLeftRadius, shadow: scs.boxShadow } : null,
    position: cs.position,
    // 带子必须在内核**之前**（契约是「在编辑区上方、文档流里的一块」，不是「必须是内核的前一个兄弟」）。
    // ⚠️ 原来比的是 reveal.nextElementSibling 有没有 data-editor-kernel —— 三栏模式给内核套了
    // 一层横排容器（编辑区 + 右侧大纲）之后，下一个兄弟变成那个容器，这条会假红（实测矩阵里红过一次）。
    // 注意：这段代码整体在模板字符串里，**注释里不能出现反引号**（会提前结束模板串）。
    stripBeforeKernel: !!(reveal && kernel && (reveal.compareDocumentPosition(kernel) & Node.DOCUMENT_POSITION_FOLLOWING)),
    kernelTop: kernel ? Math.round(kernel.getBoundingClientRect().top) : null,
    transition: cs.transitionDuration,
    bandTransition: reveal ? getComputedStyle(reveal).transitionDuration : null,
    iconCount: icons.length,
    title,
    body: item.querySelector('p + p, .ntf-body')?.textContent?.trim() ?? '',
    metaText: meta?.textContent?.trim() ?? '',
    count,
    closeLabel: closeBtnEl ? closeBtnEl.getAttribute('aria-label') : null,
    navBtns,
    metaFits: !!meta && meta.scrollWidth <= meta.clientWidth + 1,
    closeBtn: !!closeBtnEl
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
  // 造三条通知（含标题/详情），并确认只渲染一条
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
  c('only-one-notice', card.cards === 1, 'items=' + card.cards)
  // 本轮口径：**组件本身不是盒子**（无边框/圆角/底色）—— 面在「带」上，
  // 而带是编辑区上方一整幅（只有底部 1px 分界 + 顶部内高光），宽度不再写死 384。
  c(
    'no-card-box',
    card.borderWidth === '0px' && card.radius === '0px' && card.background === 'rgba(0, 0, 0, 0)',
    JSON.stringify({ border: card.borderWidth, radius: card.radius, bg: card.background })
  )
  c(
    'band-shape',
    !!card.band && card.band.borderBottom === '1px' && card.band.radius === '0px' && /inset/.test(card.band.shadow),
    JSON.stringify(card.band)
  )
  c('uses-horizontal-room', card.width >= 480, `w=${card.width}`)
  c('shown-above-editor-kernel', card.position === 'static' && card.stripBeforeKernel === true && card.bottom <= card.kernelTop + 1, JSON.stringify({ position: card.position, stripBeforeKernel: card.stripBeforeKernel, bottom: card.bottom, kernelTop: card.kernelTop }))
  c('meta-fits', card.metaFits === true, JSON.stringify({ metaFits: card.metaFits, meta: card.metaText }))
  c('has-title-and-body', card.title === '报错标题三' && card.body === '第三条通知的详细内容', JSON.stringify({ t: card.title, b: card.body }))
  c('default-shows-newest', card.title === '报错标题三' && card.count === '1/3', JSON.stringify({ t: card.title, count: card.count }))
  // 用户口径：级别图标与级别名都取消 —— 右侧信息条里只剩时间与操作按钮，
  // 且切换三条通知时**看不出级别差异**（同一条带子、同一套图标）。
  const levelWord = /通知|已完成|告警|报错|Notice|Warning|Error|Done/
  c(
    'no-level-icon-or-label',
    card.iconCount === 3 && /^\d{1,2}:\d{2}/.test(card.metaText) && !levelWord.test(card.metaText),
    `icons=${card.iconCount}（只有步进 2 + 关闭 1）meta=${card.metaText}`
  )
  c('has-close-button', card.closeBtn === true && card.closeLabel === '关闭此通知', JSON.stringify({ closeBtn: card.closeBtn, closeLabel: card.closeLabel }))
  c('has-stepper-and-close-all', card.navBtns.length >= 3, JSON.stringify(card.navBtns))
  // 动效挂在整条带上（`.ntf-reveal`），且过渡只在进出场类上声明 —— 所以按**规则声明**判定
  const bandAnim = JSON.parse(
    await ev(`(() => {
      const all = []
      const collect = (sheet) => {
        let rules = []
        try { rules = Array.from(sheet.cssRules || []) } catch { return }
        for (const r of rules) {
          if (r.styleSheet) collect(r.styleSheet)
          else if (r.selectorText) all.push(r)
        }
      }
      for (const s of Array.from(document.styleSheets)) collect(s)
      const norm = (s) => String(s).replace(/\\s+/g, '')
      const hit = all.find((r) => norm(r.selectorText).includes('.ntf-reveal-enter-active'))
      return JSON.stringify({
        dur: hit ? hit.style.getPropertyValue('transition-duration') : null,
        prop: hit ? hit.style.getPropertyValue('transition-property') : null,
        rows: hit ? hit.style.getPropertyValue('grid-template-rows') : null
      })
    })()`)
  )
  c(
    'animated-notice',
    parseFloat(bandAnim.dur) > 0 && /grid-template-rows/.test(bandAnim.prop || ''),
    `duration=${bandAnim.dur} property=${bandAnim.prop}`
  )

  // 依次切换三条通知：标题随步进变化、且**不再有级别视觉差异**（同一条带子、同一套图标）
  const switcher = []
  for (let i = 0; i < 3; i++) {
    const snap = JSON.parse(await ev(CARD))
    switcher.push({ title: snap.title, iconCount: snap.iconCount, meta: snap.metaText })
    await clickByLabel('下一条通知')
    await sleep(450)
  }
  // 切了 3 次回到起点（循环）
  const backToStart = JSON.parse(await ev(CARD))
  console.log('SWITCH ' + JSON.stringify(switcher) + ' -> ' + backToStart.title)
  c('titles-rotate-with-stepper', new Set(switcher.map((s) => s.title)).size === 3, JSON.stringify(switcher.map((s) => s.title)))
  c(
    'no-level-visual-difference',
    switcher.every((s) => s.iconCount === 3) && switcher.every((s) => /^\d{1,2}:\d{2}/.test(s.meta) && !levelWord.test(s.meta)),
    JSON.stringify(switcher.map((s) => ({ t: s.title, icons: s.iconCount, meta: s.meta })))
  )
  c('stepper-wraps-around', backToStart.title === '报错标题三', backToStart.title)

  // 切换顺序：› 显示更旧的一条
  await clickByLabel('下一条通知')
  await sleep(400)
  const older = JSON.parse(await ev(CARD))
  c('next-shows-older', older.title === '告警标题二' && older.count === '2/3', JSON.stringify({ t: older.title, count: older.count }))
  await clickByLabel('上一条通知')
  await sleep(400)
  const newer = JSON.parse(await ev(CARD))
  c('prev-shows-newer', newer.title === '报错标题三' && newer.count === '1/3', JSON.stringify({ t: newer.title, count: newer.count }))

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
  c('counter-updates', afterClose.count === '1/2', JSON.stringify(afterClose.count))

  // 多语言：切到英文后右侧信息条上的可访问名（关闭键）随之变化
  // （级别名已按用户口径从界面上取消，所以这里改测关闭键的 aria-label）
  await ev(`window.__vt.settings().set('language', 'en-US')`)
  await sleep(600)
  const en = JSON.parse(await ev(CARD))
  c(
    'i18n-en',
    !!en.closeLabel && en.closeLabel !== '关闭此通知' && !/[\u4e00-\u9fff]/.test(en.closeLabel),
    `closeLabel=${en.closeLabel}（中文时为 ${card.closeLabel}）`
  )
  await ev(`window.__vt.settings().set('language', 'zh-CN')`)
  await sleep(600)

  // 跨渲染层重载持久化：reload 后应重新从 SQLite 恢复
  await send('Page.reload')
  for (let i = 0; i < 80; i++) { await sleep(250); if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break }
  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = app._context.provides[sym]
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), notif: () => pinia._s.get('notifications'), settings: () => pinia._s.get('settings') }
    return 'ok'
  })()`)
  for (let i = 0; i < 60; i++) { await sleep(250); if ((await ev(`window.__vt.ui().booting ? 'booting' : 'ready'`)) === 'ready') break }
  await sleep(500)
  const restored = JSON.parse(await ev(`(() => JSON.stringify({ storeCount: window.__vt.notif().items.length, cards: document.querySelectorAll('.ntf-item').length, title: document.querySelector('.ntf-item p')?.textContent?.trim() ?? null }))()`))
  console.log('AFTER-RELOAD ' + JSON.stringify(restored))
  c('survives-renderer-reload', restored.storeCount === 2 && restored.cards === 1, JSON.stringify(restored))

  // 全部关闭（一并关闭）
  const closeAllOk = await clickByLabel('全部关闭')
  await sleep(700)
  const emptyUi = JSON.parse(await ev(`(() => JSON.stringify({ cards: document.querySelectorAll('.ntf-item').length, store: window.__vt.notif().items.length }))()`))
  const dbOpen = await ev(`(async () => (await window.luminAPI.notifications.list()).length)()`)
  console.log('CLOSE-ALL-UI ' + JSON.stringify(emptyUi) + ' dbOpen=' + dbOpen)
  c('close-all-button', closeAllOk === true && emptyUi.cards === 0 && dbOpen === 0, JSON.stringify({ emptyUi, dbOpen }))

  // 兼容层：旧的 ui.toast(message, type) 应落到通知中心，并且同级别+同标题自动合并
  await ev(`(async () => { const ui = window.__vt.ui(); ui.toast('已保存', 'success'); await new Promise((r) => setTimeout(r, 400)); ui.toast('已保存', 'success'); return 'ok' })()`)
  await sleep(800)
  const legacy = JSON.parse(await ev(CARD))
  const legacyDb = await ev(`(async () => (await window.luminAPI.notifications.list()).length)()`)
  console.log('LEGACY-TOAST ' + JSON.stringify(legacy) + ' dbOpen=' + legacyDb)
  c('legacy-toast-routes-to-center', legacy.cards === 1 && legacy.title === '已保存', JSON.stringify({ t: legacy.title, meta: legacy.metaText }))
  c('legacy-toast-merges-repeat', legacyDb === 1, 'dbOpen=' + legacyDb)

  // 复原：把测试期间的通知全部关闭并清掉历史行
  const cleaned = await ev(`(async () => { await window.luminAPI.notifications.closeAll(); const n = await window.luminAPI.notifications.clearClosed(); const left = await window.luminAPI.notifications.list({ includeClosed: true }); window.__vt.notif().items = []; window.__vt.notif().activeId = null; return JSON.stringify({ cleared: n, left: left.length }) })()`)
  console.log('CLEANUP ' + cleaned)
  c('db-left-clean', JSON.parse(cleaned).left === 0, cleaned)

  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
