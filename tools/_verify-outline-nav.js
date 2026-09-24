'use strict'
// 验收：目录（大纲）的**当前章节高亮** —— 点条目 / 滚到底 / 自己滚回去
//
// 为什么单开一条：目录的「点在谁身上就亮谁」此前**没有任何套件覆盖**
// （`_verify-toc.js` 测的是正文里的 `[TOC]` 节点，`_verify-outline-right.js` 测的是右侧面板的
// 布局/折叠/宽度）。而用户报障正是这条：
//
//   「最后三个标题特别近（同一屏能显示）。点最后一个标题时本应最后一条高亮，
//     但因为文档最后一屏显示的是三个标题，目录只能高亮到倒数第三上。」
//
// 根因（见 `TyporaEditor.onScroll` 与 `stores/editor.ts` 的 `activePinnedUntil`）：
// 滚动侦测按「滚动容器上沿往下 90px 那条线」取章节，而**最后一屏里最后几个标题全在线的下面**，
// 于是那条线一直停在倒数第三个标题上 —— 高亮把用户点的那条覆盖掉了。
// 两条修法都在这条套件里守着：① 点目录立刻点亮并短锁；② 滚到底就点亮最后一条。
const { connect, settle, sleep, openDocWith, waitEditor, Reporter, fatal } = require('./lib/harness')

const HEADINGS = 11
/** 前 8 节各占近一屏（长正文），最后 3 节很短 ⇒ 三节同屏，复现用户那个布局 */
const MD =
  Array.from({ length: HEADINGS }, (_, i) => {
    const n = i + 1
    const body = n <= 8 ? '这一节占满一屏，用来把滚动位置拉开。'.repeat(30) : '最后三节里的第 ' + n + ' 节。'
    return `## 标题 ${n}\n\n${body}\n`
  }).join('\n') + '\n'

/** 目录里高亮的是第几条（-1 = 没有）+ 滚动容器的几何 */
const STATE = `(() => {
  const rows = [...document.querySelectorAll('[data-outline-item]')]
  const activeIdx = rows.findIndex((r) => r.className.includes('bg-accent-soft'))
  const el = document.querySelector('.editor-scroll')
  const store = window.__L.editor()
  return JSON.stringify({
    rows: rows.length,
    activeIdx,
    activeHeading: store.activeHeading,
    lastPos: store.outline.length ? store.outline[store.outline.length - 1].pos : null,
    activeIsLast: store.outline.length ? store.activeHeading === store.outline[store.outline.length - 1].pos : null,
    scrollTop: el ? Math.round(el.scrollTop) : null,
    maxScroll: el ? Math.round(el.scrollHeight - el.clientHeight) : null,
    atBottom: el ? el.scrollTop + el.clientHeight >= el.scrollHeight - 1 : null
  })
})()`

const clickRow = (i) => `(() => {
  const rows = [...document.querySelectorAll('[data-outline-item]')]
  const r = rows[${i}]
  if (!r) return 'no-row'
  r.click()
  return 'ok'
})()`

async function main() {
  const app = await connect()
  const { ev, send } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  if (!(await waitEditor(ev))) throw new Error('编辑器未就绪')
  const report = new Reporter('目录高亮：点最后一条 / 滚到底 / 自己滚回去')

  // 目录放在左侧栏的「大纲」页签（默认在「文件」页签上）
  await ev(`(() => {
    const ui = window.__L.ui()
    ui.sidebarVisible = true
    ui.sidebarTab = 'outline'
    window.__L.settings().set('outlineOnRight', false)
    return 'ok'
  })()`)
  await openDocWith(app, MD, 'outline-nav.md')
  await sleep(1500)

  const initial = JSON.parse(await ev(STATE))
  report.note('初始 ' + JSON.stringify(initial))
  report.check('outline-lists-all-headings', initial.rows === HEADINGS, JSON.stringify(initial))
  report.check(
    'doc-is-actually-scrollable',
    initial.maxScroll > 200,
    `maxScroll=${initial.maxScroll}（文档不够长就复现不了用户那个布局）`
  )

  // ── ① 用户报障的那条：点**最后一个**标题 → 最后一条必须高亮（而不是倒数第三）──
  const clickedLast = await ev(clickRow(HEADINGS - 1))
  await sleep(120)
  const immediate = JSON.parse(await ev(STATE))
  report.note('点最后一条（立刻）' + JSON.stringify(immediate))
  report.check(
    'click-last-highlights-immediately',
    clickedLast === 'ok' && immediate.activeIdx === HEADINGS - 1,
    JSON.stringify({ activeIdx: immediate.activeIdx, rows: immediate.rows })
  )
  await sleep(1600) // 等平滑滚动 + 80ms 防抖 + 高亮锁（800ms）全部过去
  const settled = JSON.parse(await ev(STATE))
  report.note('点最后一条（滚动落地后）' + JSON.stringify(settled))
  report.check(
    'click-last-still-active-after-settle',
    settled.activeIdx === HEADINGS - 1 && settled.activeIsLast === true,
    JSON.stringify({ activeIdx: settled.activeIdx, atBottom: settled.atBottom })
  )

  // ── ② 不点，直接滚到底 → 当前章节就是最后一节（滚动侦测的边界规则）──
  await ev(`(() => { const el = document.querySelector('.editor-scroll'); el.scrollTop = el.scrollHeight; return 'ok' })()`)
  await sleep(600)
  const bottom = JSON.parse(await ev(STATE))
  report.note('滚到底 ' + JSON.stringify(bottom))
  report.check(
    'scroll-to-bottom-lights-last-heading',
    bottom.activeIsLast === true && bottom.activeIdx === HEADINGS - 1,
    JSON.stringify({ activeIdx: bottom.activeIdx, atBottom: bottom.atBottom })
  )

  // ── ③ 中间那条照常：点第 5 条 → 落定后仍是第 5 条（高亮锁不会把中间情形带偏）──
  await ev(clickRow(4))
  await sleep(1800)
  const mid = JSON.parse(await ev(STATE))
  report.note('点第 5 条 ' + JSON.stringify(mid))
  report.check(
    'click-mid-heading-highlights-it',
    mid.activeIdx === 4,
    JSON.stringify({ activeIdx: mid.activeIdx })
  )

  // ── ④ 高亮锁**不是永久的**：点最后一条后自己滚一格（wheel）→ 侦测重新接管 ──
  await ev(clickRow(HEADINGS - 1))
  await sleep(1500)
  const beforeWheel = JSON.parse(await ev(STATE))
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 700,
    y: 400,
    deltaX: 0,
    deltaY: -1200,
    button: 'none'
  })
  await sleep(900)
  const afterWheel = JSON.parse(await ev(STATE))
  report.note('自己滚回去 ' + JSON.stringify({ beforeWheel, afterWheel }))
  report.check(
    'user-wheel-release-pin-and-spy-takes-over',
    beforeWheel.activeIdx === HEADINGS - 1 && afterWheel.activeIdx !== HEADINGS - 1,
    JSON.stringify({ before: beforeWheel.activeIdx, after: afterWheel.activeIdx, scrollTop: afterWheel.scrollTop })
  )

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
