// 验证：通知改成「编辑区上方一整幅带」（没有通知时整块不存在）之后，四件事仍然成立 ——
//   1) 位置：通知带排在 [data-editor-kernel] **之前**、整条在视口内、不被窗口底边裁掉；
//   2) 形态：是 static（真占位）而不是 fixed/absolute 浮层；组件本身没有盒子（无边框/圆角/底色/外投影），
//      面在「带」上 —— 整幅铺满编辑区宽度、只有底部 1px 分界 + 顶部内高光；
//   3) 动效：进场自上方淡入**且高度是动画**（grid-template-rows 0fr↔1fr 真的生效），离场向上淡出；
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

/** 页面侧：通知带几何 + 文档流证据 + 「整幅带而不是卡片」证据 + 状态栏顶边 */
const GEOM = `(() => {
  const item = document.querySelector('.ntf-item')
  if (!item) return JSON.stringify({ cards: 0 })
  const r = item.getBoundingClientRect()
  const ics = getComputedStyle(item)
  const strip = item.closest('.ntf-strip')
  const reveal = item.closest('.ntf-reveal')
  const sr = strip ? strip.getBoundingClientRect() : null
  const scs = strip ? getComputedStyle(strip) : null
  const kernel = document.querySelector('[data-editor-kernel]')
  const kr = kernel ? kernel.getBoundingClientRect() : null
  const bar = document.querySelector('[data-status-encoding]')
  const statusEl = bar ? bar.closest('div[class*="h-7"]') : null
  const statusTop = statusEl ? statusEl.getBoundingClientRect().top : window.innerHeight
  return JSON.stringify({
    count: document.querySelectorAll('.ntf-item').length,
    width: Math.round(r.width),
    left: Math.round(r.left),
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    position: ics.position,
    revealPosition: reveal ? getComputedStyle(reveal).position : null,
    // 组件本身不是盒子：无边框 / 无圆角 / 无底色（面在「带」上，不在组件上）
    item: { border: ics.borderTopWidth, radius: ics.borderTopLeftRadius, bg: ics.backgroundColor, shadow: ics.boxShadow },
    // 带：整幅 + 只有底部 1px 分界 + 顶部内高光 + 半透明中性淡底
    band: scs
      ? {
          left: Math.round(sr.left),
          right: Math.round(sr.right),
          borderTop: scs.borderTopWidth,
          borderRight: scs.borderRightWidth,
          borderBottom: scs.borderBottomWidth,
          borderLeft: scs.borderLeftWidth,
          radius: scs.borderTopLeftRadius,
          bg: scs.backgroundColor,
          shadow: scs.boxShadow
        }
      : null,
    kernel: kr ? { left: Math.round(kr.left), right: Math.round(kr.right), top: Math.round(kr.top) } : null,
    // 文档流证据：通知带所在的 reveal 容器排在**内核之前**
    // ⚠️ 判据用 compareDocumentPosition，不判"紧邻的兄弟"：内核外面还套着一层 panes 容器
    // （div.flex.min-h-0.flex-1，三栏大纲那轮加的），所以 nextElementSibling 是那层容器、
    // 不是内核本身 —— 实测红过一次（同款修法见 _verify-notifications.js 与手册 §4.83）。
    // （这段在模板字符串里，注释中不能出现反引号。）
    stripBeforeKernel: !!(reveal && kernel && (reveal.compareDocumentPosition(kernel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
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
  const report = new Reporter(
    '通知带（编辑区上方整幅）/ 位置与形态 / 进出场动效 / tooltip 边缘显示'
  )
  const openCount = () => ev(`window.__L.notifications().items.length`)
  const hardRemove = (id) =>
    ev(`(async () => { await window.__L.notifications().remove(${id}); return 'ok' })()`)

  // ─── 1) 动效：CSS 规则（确定性）+ 真实进出场采样（需要空库，拿不到就如实 SKIP）───
  const css = JSON.parse(
    await ev(`(() => {
      // ① 计算值：opacity / transform / 过渡属性（这些与布局无关，读 computedStyle 就够）
      const probe = document.createElement('div')
      probe.className = 'ntf-reveal-enter-from'
      document.body.appendChild(probe)
      const fromOp = getComputedStyle(probe).opacity
      const fromTf = getComputedStyle(probe).transform
      probe.className = 'ntf-reveal-leave-to'
      const leaveOp = getComputedStyle(probe).opacity
      const leaveTf = getComputedStyle(probe).transform
      probe.className = 'ntf-reveal-enter-active'
      const active = getComputedStyle(probe)
      const dur = active.transitionDuration
      const prop = active.transitionProperty
      probe.remove()

      // ② grid-template-rows 读**规则声明**而不是计算值：0fr 的已用值取决于轨道尺寸算法
      //（内容驱动的高度下，fr 轨道的自动最小尺寸会让计算值仍是内容高度），
      // 拿计算值判「塌成 0」会得出错误结论 —— 真正能判定的是规则里写的是 0fr。
      // 样式是 @import 进来的，所以要递归进 CSSImportRule。
      const collect = (sheet, out) => {
        let rules = []
        try { rules = Array.from(sheet.cssRules || []) } catch { return }
        for (const r of rules) {
          if (r.styleSheet) collect(r.styleSheet, out)
          else if (r.selectorText) out.push(r)
        }
      }
      const all = []
      for (const s of Array.from(document.styleSheets)) collect(s, all)
      // ⚠️ 生产构建里 CSS 是压缩过的（.ntf-reveal>.ntf-strip 没有空格），
      //    所以比较选择器前先把空白全部去掉。
      const norm = (s) => String(s).replace(/\s+/g, '')
      const decl = (sel, propName) => {
        const want = norm(sel)
        const hit = all.find((r) => norm(r.selectorText).includes(want))
        return hit ? hit.style.getPropertyValue(propName) : null
      }
      return JSON.stringify({
        fromOp, fromTf, leaveOp, leaveTf, dur, prop,
        baseRows: decl('.ntf-reveal', 'grid-template-rows'),
        fromRows: decl('.ntf-reveal-enter-from', 'grid-template-rows'),
        leaveRows: decl('.ntf-reveal-leave-to', 'grid-template-rows'),
        strippedMinHeight: decl('.ntf-strip', 'min-height'),
        strippedOverflow: decl('.ntf-strip', 'overflow')
      })
    })()`)
  )
  /** matrix(a,b,c,d,e,f) → f 是 translateY */
  const tyOf = (tf) => {
    const m = /matrix\(([^)]+)\)/.exec(tf || '')
    return m ? parseFloat(m[1].split(',')[5]) : NaN
  }
  /**
   * 投影里**只允许 inset**（带子是内高光，不是浮层外投影）。
   * 先摘掉颜色函数再按逗号切 —— 注意 Chromium 把 `color-mix()` 序列化成 `color(srgb …)`，
   * 只认 `rgba()` 会漏（实测踩过：`color(srgb 1 1 1 / 0.55) 0px 1px 0px 0px inset`）。
   */
  const onlyInset = (shadow) => {
    const parts = String(shadow)
      .replace(/rgba?\([^)]*\)|color\([^)]*\)/g, 'C')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return parts.length > 0 && parts.every((p) => p.includes('inset'))
  }
  report.check('enter-from-hidden', css.fromOp === '0', `opacity=${css.fromOp}`)
  report.check(
    'enter-from-above',
    tyOf(css.fromTf) < 0,
    `transform=${css.fromTf}（负 Y = 自上而下进场）`
  )
  report.check(
    'enter-rule-collapses-height',
    // 0fr 要真的塌成 0 高度，还要求带子本身 min-height:0 + overflow:hidden
    //（否则 fr 轨道的自动最小尺寸会把 0fr 撑回内容高度）
    css.fromRows === '0fr' &&
      css.baseRows === '1fr' &&
      /^0/.test(css.strippedMinHeight || '') &&
      css.strippedOverflow === 'hidden',
    `enter-from=${css.fromRows} base=${css.baseRows} stripMinHeight=${css.strippedMinHeight} overflow=${css.strippedOverflow}`
  )
  report.check(
    'leave-rule-collapses-and-hides',
    css.leaveRows === '0fr' && css.leaveOp === '0' && tyOf(css.leaveTf) < 0,
    `rows=${css.leaveRows} opacity=${css.leaveOp} transform=${css.leaveTf}`
  )
  report.check(
    'transition-covers-height-opacity-transform',
    parseFloat(css.dur) > 0 &&
      /grid-template-rows/.test(css.prop) &&
      /opacity/.test(css.prop) &&
      /transform/.test(css.prop),
    `duration=${css.dur} property=${css.prop}`
  )

  const created = []
  const before = await openCount()
  if (before === 0) {
    // 进场采样：每 25ms 读一次**整条带**（`.ntf-reveal`，动效就挂在它身上）的 opacity 与高度，
    // 直到连续两次 opacity=1（或 3s 超时）
    const enter = JSON.parse(
      await ev(`(async () => {
        const n = window.__L.notifications()
        void n.notify({ level: 'info', title: ${JSON.stringify(MARK_ANIM)}, body: '用于采样进场动效的临时通知。' })
        const t0 = performance.now()
        const series = []
        for (;;) {
          const band = document.querySelector('.ntf-reveal')
          series.push({
            op: band ? Math.round(parseFloat(getComputedStyle(band).opacity) * 1000) / 1000 : null,
            h: band ? Math.round(band.getBoundingClientRect().height * 10) / 10 : null
          })
          if (series.length >= 2 && series[series.length - 1].op === 1 && series[series.length - 2].op === 1) break
          if (performance.now() - t0 > 3000) break
          await new Promise((r) => setTimeout(r, 25))
        }
        return JSON.stringify({ series: series.slice(0, 40), ms: Math.round(performance.now() - t0) })
      })()`)
    )
    await sleep(200)
    const after = await ev(
      `(async () => { const l = await window.luminAPI.notifications.list({ includeClosed: true }); const m = l.find((x) => x.title === ${JSON.stringify(MARK_ANIM)}); return JSON.stringify({ id: m ? m.id : null, cards: document.querySelectorAll('.ntf-item').length }) })()`
    )
    const info = JSON.parse(after)
    const ops = enter.series.map((s) => s.op)
    const hs = enter.series.map((s) => s.h).filter((h) => h !== null)
    const first = ops.find((v) => v !== null)
    const last = [...ops].reverse().find((v) => v !== null)
    report.check(
      'enter-really-animates',
      first !== null && first < 1 && last === 1,
      `首帧=${first} 末帧=${last} 采样=${enter.series.length} 用时=${enter.ms}ms`
    )
    // 「通知带挤开正文」本身要是动画：高度必须出现**中间值**（0 < h < 终值），
    // 否则 grid-template-rows 的 0fr↔1fr 没生效（正文会被瞬间顶下去）。
    const finalH = hs.length ? hs[hs.length - 1] : 0
    const mid = hs.filter((h) => h > 0.5 && h < finalH - 1)
    report.check(
      'band-height-animates',
      finalH > 0 && mid.length >= 2,
      `终值=${finalH}px 中间值 ${mid.length} 个：${mid.slice(0, 6).join(', ')}`
    )

    // 离场采样：点 X 之后整条带应「先淡出、再消失」（离场期间计数仍为 1 且 opacity < 1）
    const leave = JSON.parse(
      await ev(`(async () => {
        const before = document.querySelectorAll('.ntf-item').length
        const b = Array.from(document.querySelectorAll('.ntf-item button')).find((x) => (x.getAttribute('aria-label') || '').includes('关闭此通知'))
        if (!b) return JSON.stringify({ noButton: true })
        b.click()
        const t0 = performance.now()
        const series = []
        for (;;) {
          const band = document.querySelector('.ntf-reveal')
          series.push({
            cards: document.querySelectorAll('.ntf-item').length,
            op: band ? Math.round(parseFloat(getComputedStyle(band).opacity) * 1000) / 1000 : null,
            h: band ? Math.round(band.getBoundingClientRect().height * 10) / 10 : null
          })
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
    report.skip(
      'enter-really-animates',
      `库中已有 ${before} 条未关闭通知，通知条不会重新挂载（CSS 规则那条已覆盖）`
    )
    report.skip(
      'leave-really-animates',
      `库中已有 ${before} 条未关闭通知，离场采样会误测旧的通知条`
    )
  }

  // ─── 2) 形态：编辑区上方一整幅带（不是浮层卡片），整条在视口内 ───
  await ev(
    `(() => { window.__L.ui().toast(${JSON.stringify(MARK_POS)}, 'success'); return 'ok' })()`
  )
  await sleep(500)
  const pos = JSON.parse(await ev(GEOM))
  report.note('几何 ' + JSON.stringify(pos))
  report.check('notice-rendered', pos.count === 1, `items=${pos.count}`)
  report.check(
    'component-is-not-a-box',
    pos.item.border === '0px' &&
      pos.item.radius === '0px' &&
      pos.item.bg === 'rgba(0, 0, 0, 0)' &&
      pos.item.shadow === 'none',
    JSON.stringify(pos.item)
  )
  report.check(
    'band-is-flush-and-hairline-only',
    !!pos.band &&
      pos.band.borderTop === '0px' &&
      pos.band.borderLeft === '0px' &&
      pos.band.borderRight === '0px' &&
      pos.band.borderBottom === '1px' &&
      pos.band.radius === '0px' &&
      onlyInset(pos.band.shadow),
    JSON.stringify(pos.band)
  )
  report.check(
    'band-spans-editor-width',
    !!pos.band &&
      !!pos.kernel &&
      Math.abs(pos.band.left - pos.kernel.left) <= 1 &&
      Math.abs(pos.band.right - pos.kernel.right) <= 1,
    JSON.stringify({
      band: pos.band && [pos.band.left, pos.band.right],
      kernel: pos.kernel && [pos.kernel.left, pos.kernel.right]
    })
  )
  report.check(
    'uses-horizontal-room',
    pos.width >= 480,
    `w=${pos.width}（旧实现固定 384 窄条）vw=${pos.vw}`
  )
  report.check(
    'in-document-flow',
    pos.position === 'static',
    `item=${pos.position} reveal=${pos.revealPosition}`
  )
  report.check(
    'strip-before-kernel-in-document-order',
    pos.stripBeforeKernel === true,
    `stripBeforeKernel=${pos.stripBeforeKernel}`
  )
  report.check(
    'above-editor-kernel',
    !!pos.kernel && pos.bottom <= pos.kernel.top + 1,
    `item.bottom=${pos.bottom} kernel.top=${pos.kernel && pos.kernel.top}`
  )
  report.check(
    'fully-inside-viewport',
    pos.fitsViewport === true,
    `top=${pos.top} bottom=${pos.bottom} vh=${pos.vh}`
  )
  report.check(
    'not-clipped-by-window-bottom',
    pos.bottom < pos.vh - 24,
    `bottom=${pos.bottom} vh=${pos.vh}（状态栏 h-7=28px）`
  )
  report.check(
    'above-status-bar',
    pos.aboveStatusBar === true,
    `item.bottom=${pos.bottom} statusTop=${pos.statusTop}`
  )

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
  report.check(
    'cleanup-no-residue',
    left === before,
    `items ${before} → ${left}（造了 ${created.length} 条并删掉）`
  )

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
      report.check(
        'tooltip-fully-in-viewport',
        t.fullyVisible === true,
        `left=${t.left} right=${t.right} vw=${t.vw}`
      )
    } else {
      // 不假装通过：把「这一档在隔离实例里造不出来」如实打出来（GlobalTooltip 依赖真实悬停时序）
      report.skip(
        'tooltip-fully-in-viewport',
        '没造出 .lm-tooltip（GlobalTooltip 需要真实悬停事件）'
      )
    }
  } else {
    report.skip('tooltip-fully-in-viewport', '没找到靠左的 [title] 元素')
  }

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
