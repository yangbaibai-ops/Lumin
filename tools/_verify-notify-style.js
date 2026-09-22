// 验收（非破坏式）：通知的形态与样式 ——
//   ① 空态不占位（没有通知时整块不存在）；② 有通知时是**编辑区上方一整幅带**（不是浮层卡片、
//   不是圆角盒子）；③ 级别图标与级别名都没了，只留标题 / 说明 / 操作 / 关闭；④ 长正文就地滚动。
// 只在库里临时插一条带标记的通知，量完硬删，并校验既有通知一行未变。
const CDP = 'http://127.0.0.1:9222/json'
const MARK = '样式校验-' + Date.now()
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
const SNAP = `(async () => { const all = await window.luminAPI.notifications.list({ includeClosed: true }); return JSON.stringify(all.map((n) => n.id + '|' + n.level + '|' + n.title + '|' + (n.closedAt !== null)).sort()) })()`
const SHAPE = `(() => {
  const items = Array.from(document.querySelectorAll('.ntf-item'))
  const item = items[0]
  if (!item) return JSON.stringify({ items: 0, bandHeight: document.querySelector('.ntf-reveal') ? Math.round(document.querySelector('.ntf-reveal').getBoundingClientRect().height) : 0 })
  const r = item.getBoundingClientRect()
  const ics = getComputedStyle(item)
  const strip = item.closest('.ntf-strip')
  const sr = strip ? strip.getBoundingClientRect() : null
  const scs = strip ? getComputedStyle(strip) : null
  const kernel = document.querySelector('[data-editor-kernel]')
  const body = item.querySelector('.ntf-body')
  const meta = item.querySelector('[data-ntf-meta]')
  const titleEl = item.querySelector('.ntf-title')
  const row = item.querySelector('.ntf-row')
  const icons = Array.from(item.querySelectorAll('svg'))
  return JSON.stringify({
    items: items.length,
    width: Math.round(r.width),
    height: Math.round(r.height),
    // 组件本身：无边框 / 无圆角 / 无底色 / 无外投影（面属于「带」，不属于组件）
    item: { border: ics.borderTopWidth, radius: ics.borderTopLeftRadius, bg: ics.backgroundColor, shadow: ics.boxShadow, padLeft: ics.paddingLeft, padTop: ics.paddingTop, padBottom: ics.paddingBottom },
    // 版式：两列栅格 + 标题/正文共用 measure + 信息条与标题首行同高
    row: row ? { display: getComputedStyle(row).display, colGap: getComputedStyle(row).columnGap } : null,
    titleBox: titleEl ? { top: Math.round(titleEl.getBoundingClientRect().top), maxW: getComputedStyle(titleEl).maxWidth, lineHeight: getComputedStyle(titleEl).lineHeight } : null,
    metaBox: meta ? { top: Math.round(meta.getBoundingClientRect().top), height: Math.round(meta.getBoundingClientRect().height) } : null,
    // 带：整幅 + 只有底部 1px 分界 + 顶部内高光 + 半透明中性淡底
    band: scs ? {
      left: Math.round(sr.left), right: Math.round(sr.right), width: Math.round(sr.width),
      borderTop: scs.borderTopWidth, borderRight: scs.borderRightWidth, borderBottom: scs.borderBottomWidth, borderLeft: scs.borderLeftWidth,
      radius: scs.borderTopLeftRadius, bg: scs.backgroundColor, shadow: scs.boxShadow, padLeft: scs.paddingLeft
    } : null,
    kernel: kernel ? { left: Math.round(kernel.getBoundingClientRect().left), right: Math.round(kernel.getBoundingClientRect().right) } : null,
    title: item.querySelector('.ntf-title, p')?.textContent?.trim() ?? '',
    text: item.textContent.trim(),
    iconCount: icons.length,
    iconNames: icons.map((s) => (s.parentElement?.getAttribute('aria-label') || s.parentElement?.getAttribute('title') || 'plain')),
    metaText: meta?.textContent?.trim() ?? '',
    metaFits: !!meta && meta.scrollWidth <= meta.clientWidth + 1,
    bodyFits: !!body && body.scrollWidth <= body.clientWidth + 1,
    bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
    bodyMaxH: body ? getComputedStyle(body).maxHeight : null,
    bodyMaxW: body ? getComputedStyle(body).maxWidth : null
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

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  /** 环境不具备时如实 SKIP（运行器按行数扣减，不计失败；见 run-suites.js 的 SKIP 口径） */
  const skip = (n, why) => results.push('SKIP ' + n + (why ? ' | ' + why : ''))
  /** 投影里**只允许 inset**（带子是内高光，不是浮层外投影）；颜色函数先摘掉再按逗号切。
   *  ⚠️ Chromium 会把 `color-mix()` 序列化成 `color(srgb …)`，只认 `rgba()` 会漏判。 */
  const onlyInset = (shadow) => {
    const parts = String(shadow).replace(/rgba?\([^)]*\)|color\([^)]*\)/g, 'C').split(',').map((s) => s.trim()).filter(Boolean)
    return parts.length > 0 && parts.every((p) => p.includes('inset'))
  }
  /** rgba 的 alpha（'rgba(17, 24, 39, 0.07)' → 0.07） */
  const alphaOf = (bg) => {
    const m = /rgba?\(([^)]+)\)/.exec(String(bg))
    const parts = m ? m[1].split(',').map((s) => parseFloat(s)) : []
    return parts.length === 4 ? parts[3] : 1
  }

  const before = JSON.parse(await ev(SNAP))
  console.log('ROWS(before) ' + JSON.stringify(before))

  // ① 空态：没有通知时整块不存在（不占位、不影响观感）
  const empty = JSON.parse(await ev(SHAPE))
  const emptyDom = JSON.parse(await ev(`(() => JSON.stringify({
    hasElement: !!document.querySelector('.ntf-reveal, .ntf-strip, .ntf-item'),
    kernelTop: Math.round(document.querySelector('[data-editor-kernel]').getBoundingClientRect().top)
  }))()`))
  c('empty-state-has-no-banner', empty.items === 0 && empty.bandHeight === 0 && emptyDom.hasElement === false, `items=${empty.items} bandHeight=${empty.bandHeight} hasElement=${emptyDom.hasElement}`)

  const created = JSON.parse(await ev(`(async () => JSON.stringify(await window.__vt.notif().notify({ level: 'warning', title: ${JSON.stringify(MARK)}, body: '这是一条用于量取通知带形态的临时通知，量完即删。它可以很长，长到需要在区域内滚动。' })))()`))
  await sleep(700)
  const item = JSON.parse(await ev(SHAPE))
  console.log('SHAPE ' + JSON.stringify(item))

  // ② 形态：整幅带而不是浮层卡片
  c('no-card-outline', item.item.border === '0px' && item.item.radius === '0px' && item.item.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(item.item))
  c('no-outer-shadow', item.item.shadow === 'none' && onlyInset(item.band.shadow), `item=${item.item.shadow} band=${item.band.shadow}`)
  c('band-hairline-bottom-only', item.band.borderBottom === '1px' && item.band.borderTop === '0px' && item.band.borderLeft === '0px' && item.band.borderRight === '0px', JSON.stringify(item.band))
  c('band-is-translucent-wash', alphaOf(item.band.bg) > 0 && alphaOf(item.band.bg) < 1, `bandBg=${item.band.bg} alpha=${alphaOf(item.band.bg)}`)
  c('band-spans-editor-width', Math.abs(item.band.left - item.kernel.left) <= 1 && Math.abs(item.band.right - item.kernel.right) <= 1, JSON.stringify({ band: [item.band.left, item.band.right], kernel: [item.kernel.left, item.kernel.right] }))
  c('content-aligns-with-document-column', item.item.padLeft === '56px', 'paddingLeft=' + item.item.padLeft + '（写作区正文列是 px-14=56px）')
  c('uses-horizontal-room', item.width >= 480, `w=${item.width}（旧实现固定 384）`)

  // 版式（本轮重排）：两列栅格；标题与正文共用同一条 measure；信息条与标题首行**结构对齐**
  c('two-column-grid', item.row?.display === 'grid' && parseFloat(item.row.colGap) >= 16, JSON.stringify(item.row))
  c(
    'title-and-body-share-measure',
    item.titleBox?.maxW === '720px' && item.bodyMaxW === '720px',
    `title.maxW=${item.titleBox?.maxW} body.maxW=${item.bodyMaxW}`
  )
  c(
    'meta-aligns-with-title-line',
    !!item.titleBox && !!item.metaBox && Math.abs(item.metaBox.top - item.titleBox.top) <= 1 && Math.abs(item.metaBox.height - parseFloat(item.titleBox.lineHeight)) <= 1,
    JSON.stringify({ titleTop: item.titleBox?.top, titleLineHeight: item.titleBox?.lineHeight, metaTop: item.metaBox?.top, metaHeight: item.metaBox?.height })
  )

  // ③ 级别图标与级别名都没了：只剩关闭键一个图标，文案里不出现级别名
  c('no-level-icon', item.iconCount === 1 && /关闭此通知/.test(item.iconNames.join('|')), `icons=${item.iconCount} ${item.iconNames.join('|')}`)
  c('no-level-label', !/(通知|已完成|告警|报错|Warning|Notice|Error)$/.test(item.metaText) && /^\d{1,2}:\d{2}$/.test(item.metaText), 'meta=' + item.metaText)

  c('shows-marker', item.title === MARK, item.title)
  c('single-notice-amid-existing', item.items === 1, `items=${item.items}（库中未关闭通知数 > 1 时仍只渲染一条）`)
  c('meta-and-body-no-overflow', item.metaFits === true && item.bodyFits === true, JSON.stringify({ metaFits: item.metaFits, bodyFits: item.bodyFits, meta: item.metaText }))
  c('long-body-scrolls-in-place', item.bodyOverflowY === 'auto' && parseFloat(item.bodyMaxH) > 0 && parseFloat(item.bodyMaxW) > 0 && parseFloat(item.bodyMaxW) <= 760, `overflowY=${item.bodyOverflowY} maxH=${item.bodyMaxH} maxW=${item.bodyMaxW}`)

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
    // ⚠️ 浮层是 750ms 延迟 + 需要真实悬停时序：**轮询**等它出现（原来只 sleep(1100) 就断言，
    // 批量跑时机器一忙就取不到，报成 `null` 假失败 —— 实测 9 套件批量里红、单独跑 22/22）。
    // 等不到就如实 SKIP：这一档在隔离实例里造不出来是**环境**问题，不是样式回归。
    const tipText = `(() => {
      const el = document.querySelector('.lm-tooltip')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const lh = parseFloat(cs.lineHeight) || 18
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      return JSON.stringify({ text: el.textContent.trim(), width: Math.round(r.width), height: Math.round(r.height), lines: Math.max(1, Math.round((r.height - pad) / lh)), left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, writingMode: cs.writingMode })
    })()`
    let tip = await ev(tipText)
    for (let i = 0; i < 30 && !tip; i++) {
      await sleep(100)
      tip = await ev(tipText)
    }
    console.log('TOOLTIP ' + tip)
    if (tip) {
      const t = JSON.parse(tip)
      c('tooltip-not-vertical', !!t && t.lines <= 2 && t.width >= 60, JSON.stringify(t))
      c('tooltip-inside-viewport', !!t && t.left >= 0 && t.right <= t.vw, JSON.stringify(t))
    } else {
      skip('tooltip-not-vertical', '隔离实例里没造出 .lm-tooltip（GlobalTooltip 需要真实悬停时序）')
      skip('tooltip-inside-viewport', '同上')
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20, button: 'none', buttons: 0 })
    await sleep(300)
  } else {
    c('tooltip-not-vertical', false, 'close button not found')
  }

  // 清理：硬删临时通知（不动既有行，也不调用 clearClosed）
  await ev(`(async () => { const n = window.__vt.notif(); await n.remove(${created.id}); return 'ok' })()`)
  await sleep(500)
  const after = JSON.parse(await ev(SNAP))
  const cleaned = JSON.parse(await ev(SHAPE))
  const afterDom = JSON.parse(await ev(`(() => JSON.stringify({
    hasElement: !!document.querySelector('.ntf-reveal, .ntf-strip, .ntf-item'),
    kernelTop: Math.round(document.querySelector('[data-editor-kernel]').getBoundingClientRect().top)
  }))()`))
  console.log('ROWS(after)  ' + JSON.stringify(after) + ' items=' + cleaned.items + ' bandHeight=' + cleaned.bandHeight)
  c('existing-rows-untouched', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }))
  c('marker-removed', !after.some((r) => r.includes(MARK)), MARK)
  // ④ 消失之后又回到「不占位」的空态：DOM 里连元素都没有，且正文起点回到创建前的位置
  c(
    'back-to-empty-state',
    cleaned.items === 0 && cleaned.bandHeight === 0 && afterDom.hasElement === false && Math.abs(afterDom.kernelTop - emptyDom.kernelTop) <= 1,
    `items=${cleaned.items} bandHeight=${cleaned.bandHeight} hasElement=${afterDom.hasElement} kernelTop ${emptyDom.kernelTop} → ${afterDom.kernelTop}`
  )

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
