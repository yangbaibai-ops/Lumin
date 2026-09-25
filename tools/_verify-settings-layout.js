'use strict'
// ─── 验收：设置页在**最小窗口 / 125% 缩放**下的横向布局 ────────────────────────
//
// 审计 §8 P2：「最小窗口 940×600 下设置页横向偏紧」——实测口径是
//   280(左导航) + 30(两栏间距) + 内容列 + 48(px-6) ≈ 942px，正好卡在 940 这个临界值；
//   1366×768 的机器在 125% 缩放下逻辑宽只有 1093，主题缩略图也被挤。
//
// 修法（本轮）：左导航宽度 `clamp(200px, 24vw, 280px)`、主题卡在 <1180px 走 3 列。
// 这条套件把"收紧之后还剩多少"量出来，并断言三件事：**没有横向溢出**、
// 内容列**够宽**、主题卡**没被挤扁**。三个视口各量一遍：940×600（窗口下限）、
// 1093×700（1366@125%）、1400×900（宽窗口，确认没有把原来的观感改坏）。
//
// 视口用 CDP 的 `Emulation.setDeviceMetricsOverride` 覆盖（**不动用户窗口**）：
// CSS 媒体查询与 vw/% 都按页面视口算，因此这等价于把窗口缩到那个尺寸。
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

const PROBE = `(() => {
  const page = document.querySelector('[data-settings-page]')
  const nav = document.querySelector('.settings-nav')
  const card = document.querySelector('.settings-card')
  const grid = document.querySelector('[data-theme-grid]')
  const cards = grid ? Array.from(grid.children) : []
  const firstTop = cards.length ? cards[0].getBoundingClientRect().top : null
  // 列数 = **与第一张同顶**的卡片数（同顶 = 同一行）；行数 = 不同的 top 个数。
  // ⚠️ 不能写 cards.length / rows：4 张卡排成 3 列时是 3+1（rows=2），那样会算出 2 列。
  const cols =
    firstTop === null
      ? 0
      : cards.filter((c) => Math.abs(c.getBoundingClientRect().top - firstTop) < 2).length
  const rows = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)))].length
  const navW = nav ? Math.round(nav.getBoundingClientRect().width) : null
  const cardW = card ? Math.round(card.getBoundingClientRect().width) : null
  return JSON.stringify({
    vw: document.documentElement.clientWidth,
    navW,
    cardW,
    // 内容列 = 卡片宽 − 导航 − 30 的两栏间距
    contentW: navW !== null && cardW !== null ? Math.round(cardW - navW - 30) : null,
    rows,
    cols,
    themeCardW: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : null,
    // 横向溢出：设置页自己是滚动容器，所以量它 + 文档两级
    pageOverflow: page ? Math.round(page.scrollWidth - page.clientWidth) : null,
    docOverflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)
  })
})()`

/** 覆盖视口并等布局稳定 */
async function atViewport(app, width, height) {
  await app.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(700)
  return JSON.parse(await app.ev(PROBE))
}

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('设置页在最小窗口 / 125% 缩放下的横向布局')

  // 打开设置页（走 store，与用户按 Ctrl+, 同一条路径），并切到「外观」页签 ——
  // 主题卡在那一个页签里（每个页签是 `v-if` 渲染的，不切过去页面上根本没有那个 grid）
  const opened = await ev(`(async () => {
    window.__L.ui().openSettings()
    for (let i = 0; i < 40 && !document.querySelector('[data-settings-page] .settings-nav'); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const tab = document.querySelector('[data-settings-nav="appearance"]')
    if (tab) tab.click()
    for (let i = 0; i < 40 && !document.querySelector('[data-theme-grid]'); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    return !!document.querySelector('[data-settings-page] .settings-nav')
  })()`)
  if (!opened) {
    report.skip('settings-page-open', '设置页没打开（拿不到 .settings-nav）')
    app.close()
    return report.finish()
  }

  const narrow = await atViewport(app, 940, 600)
  report.note('940×600 ' + JSON.stringify(narrow))
  report.check(
    'narrow-no-horizontal-overflow',
    narrow.pageOverflow <= 0 && narrow.docOverflow <= 0,
    JSON.stringify({ page: narrow.pageOverflow, doc: narrow.docOverflow })
  )
  report.check(
    'narrow-nav-follows-window',
    narrow.navW >= 200 && narrow.navW <= 240,
    `navW=${narrow.navW}（clamp(200px, 24vw, 280px) 在 940 下应约 226）`
  )
  report.check(
    'narrow-content-column-wide-enough',
    narrow.contentW >= 600,
    `contentW=${narrow.contentW}（改前是 582）`
  )
  report.check(
    'narrow-theme-cards-3-cols-and-not-squeezed',
    narrow.cols === 3 && narrow.themeCardW >= 170,
    JSON.stringify({ cols: narrow.cols, card: narrow.themeCardW })
  )

  const scaled = await atViewport(app, 1093, 700)
  report.note('1093×700（1366@125%）' + JSON.stringify(scaled))
  report.check(
    'scaled-theme-cards-3-cols-and-not-squeezed',
    scaled.cols === 3 && scaled.themeCardW >= 170 && scaled.docOverflow <= 0,
    JSON.stringify({ cols: scaled.cols, card: scaled.themeCardW, doc: scaled.docOverflow })
  )

  const wide = await atViewport(app, 1400, 900)
  report.note('1400×900 ' + JSON.stringify(wide))
  report.check(
    'wide-nav-restored-280',
    wide.navW === 280,
    `navW=${wide.navW}（宽窗口下必须还是 280，观感不能变）`
  )
  report.check(
    'wide-theme-cards-4-cols',
    wide.cols === 4 && wide.themeCardW >= 130 && wide.docOverflow <= 0,
    JSON.stringify({ cols: wide.cols, card: wide.themeCardW })
  )

  // 收尾：撤掉视口覆盖、关掉设置页（下一轮套件应从干净状态开始）
  await app.send('Emulation.clearDeviceMetricsOverride')
  await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)
  await sleep(300)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
