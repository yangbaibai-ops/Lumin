'use strict'
// 验收：目录（大纲）的**当前章节高亮** —— 点条目 / 滚到底 / 末尾那几节 / 自己滚回去
//
// 为什么单开一条：目录的「点在谁身上就亮谁」此前**没有任何套件覆盖**
// （`_verify-toc.js` 测的是正文里的 `[TOC]` 节点，`_verify-outline-right.js` 测的是右侧面板的
// 布局/折叠/宽度）。用户两轮报障都落在这里：
//
//   第一轮：「最后三个标题特别近（同一屏能显示）。点最后一个标题时本应最后一条高亮，
//           但因为文档最后一屏显示的是三个标题，目录只能高亮到倒数第三上。」
//   第二轮：「还不行 —— 现在直接跳过倒数第二和倒数第三；我点的是倒数第三个，但大纲亮到倒数第四。」
//
// 两轮的根因不同，修法也不同（都在这条套件里守着）：
//   ① **选择 vs 侦测的优先级**：点目录是「用户选的」，滚动侦测是「系统算的」。旧代码让侦测算的
//      覆盖用户选的（`TyporaEditor.onScroll` 每次滚动都重算）。现在点击立刻点亮 + 上锁
//      （`stores/editor.ts` 的 `activePinned`），只有**用户自己滚动**才解锁。
//   ② **末屏边界**：文档最后几节很短时，它们的标题压不到判定线上（滚到底也压不到）。
//      旧行为 = 高亮停在倒数第四；我第一版补的「到底就点亮最后一条」又会**跳过**中间那两节。
//      现在是**按剩余滚动距离等分**依次点亮（`lib/editor/scrollSpy.ts`，纯函数另有单测）。
const { connect, settle, sleep, openDocWith, waitEditor, bringToFront, Reporter, fatal } = require('./lib/harness')

const LONG = 7
const SHORT = 4
const HEADINGS = LONG + SHORT
/** 前 7 节各占近一屏（长正文），末尾 4 节很短 ⇒ 同一屏能显示好几节，复现用户那个布局 */
const MD =
  Array.from({ length: HEADINGS }, (_, i) => {
    const n = i + 1
    const body = n <= LONG ? '这一节占满一屏，用来把滚动位置拉开。'.repeat(30) : `末尾第 ${n} 节，短短一句话。`
    return `## 标题 ${n}\n\n${body}\n`
  }).join('\n') + '\n'

/** 目录里高亮的是第几条（-1 = 没有）+ 滚动容器的几何 */
const STATE = `(() => {
  const rows = [...document.querySelectorAll('[data-outline-item]')]
  const activeIdx = rows.findIndex((r) => r.className.includes('bg-accent-soft'))
  const store = window.__L.editor()
  const el = document.querySelector('.editor-scroll')
  return JSON.stringify({
    rows: rows.length,
    activeIdx,
    activeHeading: store.activeHeading,
    activeIsLast: store.outline.length
      ? store.activeHeading === store.outline[store.outline.length - 1].pos
      : null,
    pinned: store.activePinned === true,
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
/** 从末尾数第 k 条（k=1 是最后一条） */
const clickFromEnd = (k) => `(() => {
  const rows = [...document.querySelectorAll('[data-outline-item]')]
  const r = rows[rows.length - ${k}]
  if (!r) return 'no-row'
  r.click()
  return 'ok'
})()`
const setScroll = (x) => `(() => {
  const el = document.querySelector('.editor-scroll')
  el.scrollTop = ${x === 'max' ? 'el.scrollHeight' : x}
  return 'ok'
})()`

const state = async (ev) => JSON.parse(await ev(STATE))

/**
 * 这个窗口**在不在产生帧**（`requestAnimationFrame` 会不会被派发）。
 *
 * 为什么要先问这一句：滚动事件与平滑滚动都挂在**帧**上。窗口被别的窗口挡住时 Chromium 会暂停
 * 出帧（实测：用户自己的 Lumin 在前台时，探针里 `scrollTop` 一直 0、滚动事件一个不来）。
 * 那种情况下「点目录没滚动」「侦测没重算」全是环境造成的 —— 与其红一片，不如**如实 SKIP**
 * （`SKIP 不算失败`，见 tools/run-suites.js 的口径）。
 */
async function framesAlive(app, ms = 2500) {
  for (let i = 0; i < 3; i++) {
    await bringToFront(app)
    await app.ev(`(() => { window.__RAF = 'pending'; requestAnimationFrame(() => { window.__RAF = 'ok' }); return 'ok' })()`)
    const end = Date.now() + Math.round(ms / 3)
    while (Date.now() < end) {
      if ((await app.ev('window.__RAF')) === 'ok') return true
      await sleep(100)
    }
  }
  return false
}

async function main() {
  const app = await connect()
  const { ev, send } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  if (!(await waitEditor(ev))) throw new Error('编辑器未就绪')
  const report = new Reporter('目录高亮：点谁亮谁 / 末尾几节不跳过 / 自己滚回去')

  await ev(`(() => {
    const ui = window.__L.ui()
    ui.sidebarVisible = true
    ui.sidebarTab = 'outline'
    window.__L.settings().set('outlineOnRight', false)
    return 'ok'
  })()`)
  await openDocWith(app, MD, 'outline-nav.md')
  await sleep(1500)

  const initial = await state(ev)
  report.note('初始 ' + JSON.stringify(initial))
  report.check('outline-lists-all-headings', initial.rows === HEADINGS, JSON.stringify(initial))
  report.check(
    'doc-is-actually-scrollable',
    initial.maxScroll > 200,
    `maxScroll=${initial.maxScroll}（文档不够长就复现不了用户那个布局）`
  )

  // 后面每一条都依赖「窗口在出帧」（滚动事件 / 平滑滚动 / rAF 都挂在帧上）。
  // 被遮挡时如实 SKIP，而不是红一片假失败。
  const alive = await framesAlive(app)
  if (!alive) {
    report.note('窗口不产生帧（多半被别的窗口遮挡）：滚动与侦测都不会跑，如实 SKIP 其余断言')
    for (const name of [
      'click-scrolls-the-document',
      'click-last-highlights-immediately',
      'click-last-still-active-after-settle',
      'click-3rd-from-last-stays-on-3rd',
      'click-2nd-from-last-stays-on-2nd',
      'click-mid-heading-highlights-it',
      'scroll-walks-tail-without-skipping',
      'tail-walk-order-is-strictly-increasing',
      'scroll-sequence-is-monotone',
      'scroll-to-bottom-lights-last-heading',
      'user-wheel-release-pin-and-spy-takes-over'
    ]) {
      report.skip(name, 'SKIP 窗口被遮挡：不产生帧 ⇒ 滚动事件与平滑滚动都不跑（请在窗口可见时重跑）')
    }
    app.close()
    process.exit(report.finish())
  }

  // ── ① 点远处的一条要**真的滚动**（守「rAF 不派发时点目录完全没反应」那个坑）──
  await ev(setScroll(0))
  await sleep(400)
  const clickedFar = await ev(clickRow(5))
  await sleep(1500)
  const far = await state(ev)
  report.note('点第 6 条 ' + JSON.stringify(far))
  report.check(
    'click-scrolls-the-document',
    clickedFar === 'ok' && far.scrollTop > 300,
    `scrollTop=${far.scrollTop}（点目录必须真的滚过去，不能因为 rAF 没派发就不动）`
  )

  // ── ② 用户报障第一轮：点**最后一个**标题 → 最后一条高亮（立刻 + 落定后） ──
  await ev(setScroll(0))
  await sleep(400)
  const clickedLast = await ev(clickFromEnd(1))
  await sleep(150)
  const immediate = await state(ev)
  report.note('点最后一条（立刻）' + JSON.stringify(immediate))
  report.check(
    'click-last-highlights-immediately',
    clickedLast === 'ok' && immediate.activeIdx === HEADINGS - 1,
    JSON.stringify({ activeIdx: immediate.activeIdx, pinned: immediate.pinned })
  )
  await sleep(2500) // 远超旧实现那个 800ms 自动解锁时刻
  const settled = await state(ev)
  report.note('点最后一条（落定后）' + JSON.stringify(settled))
  report.check(
    'click-last-still-active-after-settle',
    settled.activeIdx === HEADINGS - 1 && settled.activeIsLast === true,
    JSON.stringify({ activeIdx: settled.activeIdx, pinned: settled.pinned, atBottom: settled.atBottom })
  )

  // ── ③ 用户报障第二轮：点**倒数第三个** → 必须亮倒数第三，而不是倒数第四 ──
  await ev(setScroll(0))
  await sleep(400)
  const clickedThird = await ev(clickFromEnd(3))
  await sleep(2500)
  const third = await state(ev)
  report.note('点倒数第 3 条 ' + JSON.stringify(third))
  report.check(
    'click-3rd-from-last-stays-on-3rd',
    clickedThird === 'ok' && third.activeIdx === HEADINGS - 3,
    JSON.stringify({ activeIdx: third.activeIdx, expected: HEADINGS - 3, scrollTop: third.scrollTop })
  )

  // ── ④ 点倒数第二个同理（三条末尾标题都要能各自点亮）──
  await ev(setScroll(0))
  await sleep(400)
  await ev(clickFromEnd(2))
  await sleep(2500)
  const second = await state(ev)
  report.check(
    'click-2nd-from-last-stays-on-2nd',
    second.activeIdx === HEADINGS - 2,
    JSON.stringify({ activeIdx: second.activeIdx, expected: HEADINGS - 2 })
  )

  // ── ⑤ 中间那条照常 ──
  await ev(setScroll(0))
  await sleep(400)
  await ev(clickRow(4))
  await sleep(2500)
  const mid = await state(ev)
  report.note('点第 5 条 ' + JSON.stringify(mid))
  report.check('click-mid-heading-highlights-it', mid.activeIdx === 4, JSON.stringify({ activeIdx: mid.activeIdx }))

  // ── ⑥ 不点，只滚动：末尾那几节要**一节一节**走过，不能跳过 ──
  // 先把「点目录的高亮锁」解开（真实用户是靠自己滚动解锁的，那条单独在 ⑦ 验）
  await ev(`(() => { window.__L.editor().releaseActiveHeadingPin(); return 'ok' })()`)
  await ev(setScroll(0))
  await sleep(400)
  const seq = []
  const coarse = Math.max(1, Math.round((initial.maxScroll * 0.24) / 8))
  for (let x = 0; x <= initial.maxScroll; x += coarse) {
    await ev(setScroll(Math.min(x, initial.maxScroll)))
    await sleep(140)
    const s = await state(ev)
    if (seq[seq.length - 1] !== s.activeIdx) seq.push(s.activeIdx)
  }
  // 末尾这一段单独**细采样**：等分区间是按「最后一个能压线的标题」对齐的，粗步长会正好跨过
  // 某一条的份额（第一版就漏掉了倒数第四条）。30px 一步 ⇒ 每条至少被采到几次。
  const tailStart = Math.max(0, initial.maxScroll - 900)
  const tailSeq = []
  for (let x = tailStart; x <= initial.maxScroll; x += 30) {
    await ev(setScroll(Math.min(x, initial.maxScroll)))
    await sleep(140)
    const s = await state(ev)
    if (tailSeq[tailSeq.length - 1] !== s.activeIdx) tailSeq.push(s.activeIdx)
  }
  await ev(setScroll('max'))
  await sleep(400)
  const bottom = await state(ev)
  const visited = seq.filter((v, i, a) => a.indexOf(v) === i)
  report.note('滚动走过的序列 ' + JSON.stringify(visited) + '；末尾细采样 ' + JSON.stringify(tailSeq))
  report.check(
    'scroll-walks-tail-without-skipping',
    [HEADINGS - 4, HEADINGS - 3, HEADINGS - 2, HEADINGS - 1].every((i) => tailSeq.includes(i)),
    `末尾四节都要各自点亮过：tailSeq=${JSON.stringify(tailSeq)}`
  )
  report.check(
    'tail-walk-order-is-strictly-increasing',
    tailSeq.every((v, i) => i === 0 || v > tailSeq[i - 1]),
    `末尾细采样里下标必须严格递增（不回头、不跳级重复）：${JSON.stringify(tailSeq)}`
  )
  report.check(
    'scroll-sequence-is-monotone',
    seq.every((v, i) => i === 0 || v >= seq[i - 1]),
    `滚动触发的高亮只能往前：${JSON.stringify(seq)}`
  )
  report.check(
    'scroll-to-bottom-lights-last-heading',
    bottom.activeIsLast === true && bottom.activeIdx === HEADINGS - 1,
    JSON.stringify({ activeIdx: bottom.activeIdx, atBottom: bottom.atBottom })
  )

  // ── ⑦ 锁不是永久的：点最后一条后自己滚一格（wheel）→ 侦测接管 ──
  await ev(clickFromEnd(1))
  await sleep(1500)
  const beforeWheel = await state(ev)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 700,
    y: 400,
    deltaX: 0,
    deltaY: -1200,
    button: 'none'
  })
  await sleep(900)
  const afterWheel = await state(ev)
  report.note('自己滚回去 ' + JSON.stringify({ beforeWheel, afterWheel }))
  report.check(
    'user-wheel-release-pin-and-spy-takes-over',
    beforeWheel.activeIdx === HEADINGS - 1 &&
      beforeWheel.pinned === true &&
      afterWheel.pinned === false &&
      afterWheel.activeIdx !== HEADINGS - 1,
    JSON.stringify({ before: beforeWheel.activeIdx, after: afterWheel.activeIdx, pinned: afterWheel.pinned })
  )

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
