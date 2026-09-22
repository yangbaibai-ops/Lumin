// 验证：通知条改为「编辑区上方」的文档流顶条之后，四件事仍然成立 ——
//   1) 位置：卡片排在 [data-editor-kernel] **之前**、整张在视口内、不被窗口底边裁掉；
//   2) 布局：卡片是 static（真占位），不是 fixed/absolute 的浮层；
//   3) 动效：进场自上方淡入、离场向上淡出（CSS 规则 + 真实采样两路证据）；
//   4) tooltip：悬停贴左缘的元素时完整显示在视口内。
//
// 为什么原来那版必须改：它按 `.fixed.bottom-12.right-4` 找容器，并对右下角偏移做断言
// （bottom>=40 / right>=8）。通知条搬到文档流顶部后这个容器**根本不存在** ——
// 断言会全都变成 null 比较，即使实现完全正确也会红，等于用一个过期假设去测新位置。
//
// 已用 harness（改到谁迁谁，见 tools/README.md）。
'use strict'
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

const MARK_ANIM = '动效采样-' + Date.now()
const MARK_POS = '位置校验-' + Date.now()

/** 页面侧：卡片几何 + 文档流证据 + 状态栏顶边 */
const GEOM = `(() => {
  const card = document.querySelector('.ntf-card')
  if (!card) return JSON.stringify({ cards: 0 })
  const r = card.getBoundingClientRect()
  const kernel = document.querySelector('[data-editor-kernel]')
  const kr = kernel ? kernel.getBoundingClientRect() : null
  const strip = card.parentElement
  const bar = document.querySelector('[data-status-encoding]')
  const statusEl = bar ? bar.closest('div[class*="h-7"]') : null
  const statusTop = statusEl ? statusEl.getBoundingClientRect().top : window.innerHeight
  return JSON.stringify({
    count: document.querySelectorAll('.ntf-card').length,
    width: Math.round(r.width),
    left: Math.round(r.left),
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    position: getComputedStyle(card).position,
    stripPosition: strip ? getComputedStyle(strip).position : null,
    gapToKernel: kr ? Math.round(kr.top - r.bottom) : null,
    aboveKernel: kr ? r.top < kr.top : null,
    // 文档流证据：卡片的容器在 DOM 里正好是编辑器内核的**前一个兄弟**
    stripBeforeKernel: !!(strip && strip.nextElementSibling && strip.nextElementSibling.hasAttribute('data-editor-kernel')),
    fitsViewport: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
    aboveStatusBar: Math.round(r.bottom) <= Math.round(statusTop) + 1,
    vw: window.innerWidth,
    vh: window.innerHeight,
    statusTop: Math.round(statusTop)
  })
})()`

async function main() {
  const app = await connect()
  const { send, ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态（ui.booting 未结束）')
  const report = new Reporter('通知条位置（编辑区上方）/ 进出场动效 / tooltip 边缘显示')
  const openCount = () => ev(`window.__L.notifications().items.length`)
  const hardRemove = (id) => ev(`(async () => { await window.__L.notifications().remove(${id}); return 'ok' })()`)

  // ─── 1) 动效：CSS 规则（确定性）+ 真实进出场采样（需要空库，拿不到就如实 SKIP）───
  const css = JSON.parse(
    await ev(`(() => {
      const probe = document.createElement('div')
      probe.className = 'ntf-enter-from'
      document.body.appendChild(probe)
      const fromOp = getComputedStyle(probe).opacity
      const fromTf = getComputedStyle(probe).transform
      probe.className = 'ntf-leave-to'
      const leaveOp = getComputedStyle(probe).opacity
      const leaveTf = getComputedStyle(probe).transform
      probe.className = 'ntf-enter-active'
      const active = getComputedStyle(probe)
      const dur = active.transitionDuration
      const prop = active.transitionProperty
      probe.remove()
      return JSON.stringify({ fromOp, fromTf, leaveOp, leaveTf, dur, prop })
    })()`)
  )
  /** matrix(a,b,c,d,e,f) → f 是 translateY */
  const tyOf = (tf) => {
    const m = /matrix\(([^)]+)\)/.exec(tf || '')
    return m ? parseFloat(m[1].split(',')[5]) : NaN
  }
  report.check('enter-from-hidden', css.fromOp === '0', `opacity=${css.fromOp}`)
  report.check('enter-from-above', tyOf(css.fromTf) < 0, `transform=${css.fromTf}（负 Y = 自上而下进场）`)
  report.check('leave-to-hidden', css.leaveOp === '0' && tyOf(css.leaveTf) < 0, `opacity=${css.leaveOp} transform=${css.leaveTf}`)
  report.check(
    'transition-covers-opacity-and-transform',
    parseFloat(css.dur) > 0 && /opacity/.test(css.prop) && /transform/.test(css.prop),
    `duration=${css.dur} property=${css.prop}`
  )

  const created = []
  const before = await openCount()
  if (before === 0) {
    // 进场采样：每 25ms 读一次 opacity，直到连续两次为 1（或 3s 超时）
    const enter = JSON.parse(
      await ev(`(async () => {
        const n = window.__L.notifications()
        void n.notify({ level: 'info', title: ${JSON.stringify(MARK_ANIM)}, body: '用于采样进场动效的临时通知。' })
        const t0 = performance.now()
        const series = []
        for (;;) {
          const el = document.querySelector('.ntf-card')
          series.push(el ? Math.round(parseFloat(getComputedStyle(el).opacity) * 1000) / 1000 : null)
          if (series.length >= 2 && series[series.length - 1] === 1 && series[series.length - 2] === 1) break
          if (performance.now() - t0 > 3000) break
          await new Promise((r) => setTimeout(r, 25))
        }
        return JSON.stringify({ series: series.slice(0, 40), ms: Math.round(performance.now() - t0) })
      })()`)
    )
    await sleep(200)
    const after = await ev(`(async () => { const l = await window.luminAPI.notifications.list({ includeClosed: true }); const m = l.find((x) => x.title === ${JSON.stringify(MARK_ANIM)}); return JSON.stringify({ id: m ? m.id : null, cards: document.querySelectorAll('.ntf-card').length }) })()`)
    const info = JSON.parse(after)
    const first = enter.series.find((v) => v !== null)
    const last = [...enter.series].reverse().find((v) => v !== null)
    report.check(
      'enter-really-animates',
      first !== null && first < 1 && last === 1,
      `首帧=${first} 末帧=${last} 采样=${enter.series.length} 用时=${enter.ms}ms`
    )

    // 离场采样：点 X 之后卡片应「先淡出、再消失」（离场期间计数仍为 1 且 opacity < 1）
    const leave = JSON.parse(
      await ev(`(async () => {
        const before = document.querySelectorAll('.ntf-card').length
        const b = Array.from(document.querySelectorAll('.ntf-card button')).find((x) => (x.getAttribute('aria-label') || '').includes('关闭此通知'))
        if (!b) return JSON.stringify({ noButton: true })
        b.click()
        const t0 = performance.now()
        const series = []
        for (;;) {
          const el = document.querySelector('.ntf-card')
          series.push({ cards: document.querySelectorAll('.ntf-card').length, op: el ? Math.round(parseFloat(getComputedStyle(el).opacity) * 1000) / 1000 : null })
          if (series[series.length - 1].cards === 0 && performance.now() - t0 > 60) break
          if (performance.now() - t0 > 3000) break
          await new Promise((r) => setTimeout(r, 25))
        }
        return JSON.stringify({ before, series: series.slice(0, 60), ms: Math.round(performance.now() - t0) })
      })()`)
    )
    const midFade = leave.series.find((s) => s.cards === 1 && s.op !== null && s.op < 1)
    const gone = leave.series[leave.series.length - 1]
    report.check(
      'leave-really-animates',
      !leave.noButton && !!midFade && gone.cards === 0,
      leave.noButton
        ? '找不到关闭按钮'
        : `离场中渐隐=${midFade ? midFade.op : 'null'} 末帧 cards=${gone.cards} 用时=${leave.ms}ms`
    )
    if (info.id !== null && !created.includes(info.id)) created.push(info.id)
  } else {
    report.skip('enter-really-animates', `库中已有 ${before} 条未关闭通知，卡片不会重新挂载（CSS 规则那条已覆盖）`)
    report.skip('leave-really-animates', `库中已有 ${before} 条未关闭通知，离场采样会误测旧卡片`)
  }

  // ─── 2) 位置：文档流顶条，在编辑器内核之前、整张在视口内 ───
  await ev(`(() => { window.__L.ui().toast(${JSON.stringify(MARK_POS)}, 'success'); return 'ok' })()`)
  await sleep(500)
  const pos = JSON.parse(await ev(GEOM))
  report.note('几何 ' + JSON.stringify(pos))
  report.check('card-rendered', pos.count === 1, `cards=${pos.count}`)
  report.check('width-384', pos.width === 384, `w=${pos.width} vw=${pos.vw}`)
  report.check('in-document-flow', pos.position === 'static' && pos.stripPosition === 'static', `card=${pos.position} strip=${pos.stripPosition}`)
  report.check('strip-is-previous-sibling-of-kernel', pos.stripBeforeKernel === true, `stripBeforeKernel=${pos.stripBeforeKernel}`)
  report.check('above-editor-kernel', pos.aboveKernel === true, `card.bottom=${pos.bottom} 距内核 ${pos.gapToKernel}px`)
  report.check('fully-inside-viewport', pos.fitsViewport === true, `top=${pos.top} bottom=${pos.bottom} vh=${pos.vh}`)
  report.check('not-clipped-by-window-bottom', pos.bottom < pos.vh - 24, `bottom=${pos.bottom} vh=${pos.vh}（状态栏 h-7=28px）`)
  report.check('above-status-bar', pos.aboveStatusBar === true, `card.bottom=${pos.bottom} statusTop=${pos.statusTop}`)

  // 清理：硬删本脚本造出来的行（不动库里既有通知）
  const list = JSON.parse(
    await ev(`(async () => {
      const l = await window.luminAPI.notifications.list({ includeClosed: true })
      const m = l.find((x) => x.title === ${JSON.stringify(MARK_POS)})
      return JSON.stringify({ id: m ? m.id : null })
    })()`)
  )
  if (list.id !== null && !created.includes(list.id)) created.push(list.id)
  for (const id of created) await hardRemove(id)
  await sleep(300)
  const left = await ev(`window.__L.notifications().items.length`)
  report.check('cleanup-no-residue', left === before, `items ${before} → ${left}（造了 ${created.length} 条并删掉）`)

  // ─── 3) tooltip：找一个靠左边的带 title 元素（侧边栏按钮），悬停后检查完整在视口内 ───
  const el = await ev(`(() => {
    const b = [...document.querySelectorAll('[title]')].find((x) => x.title && x.getBoundingClientRect().left < 120)
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: b.title }
  })()`)
  if (el) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: el.x, y: el.y })
    await sleep(900)
    const tip = await ev(`(() => {
      const t = document.querySelector('.lm-tooltip')
      if (!t) return null
      const r = t.getBoundingClientRect()
      return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), vw: window.innerWidth, vh: window.innerHeight, fullyVisible: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight })
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    if (tip) {
      const t = JSON.parse(tip)
      report.check('tooltip-fully-in-viewport', t.fullyVisible === true, `left=${t.left} right=${t.right} vw=${t.vw}`)
    } else {
      // 不假装通过：把「这一档在隔离实例里造不出来」如实打出来（GlobalTooltip 依赖真实悬停时序）
      report.skip('tooltip-fully-in-viewport', '没造出 .lm-tooltip（GlobalTooltip 需要真实悬停事件）')
    }
  } else {
    report.skip('tooltip-fully-in-viewport', '没找到靠左的 [title] 元素')
  }

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
