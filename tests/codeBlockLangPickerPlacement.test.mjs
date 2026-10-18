// ─── 代码块语言浮层的「在块外」几何（纯函数）──────────────────────────────────
//
// 用户口径（本轮）：语言输入框要**放到代码块外面**，不遮挡、不影响代码查看。
// 这个"外面"不能靠肉眼调 margin 保证 —— 一旦块的位置/高度变化（滚动、窗口缩放、
// 只有一行高的新块），写死的偏移就会重新压回代码。所以位置由
// `lib/editor/codeBlockLangPicker.ts` 的 placePicker() 按两个 rect 算，
// 这里用真实尺寸的矩形把三条硬约束钉死：
//   ① 浮层 rect × 代码块 rect **交集面积 = 0**（上方/下方都要成立）；
//   ② 默认上方、右对齐、gap = 6px；顶部放不下 → 下方；下方仍放不下 → 夹高度、仍在块外；
//   ③ 宽度 ≤ min(240px, 代码块宽 × 40%, 视口宽 - 16px)，且不越出视口左右边缘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PICKER_GAP_PX,
  PICKER_MAX_WIDTH_PX,
  PICKER_MAX_WIDTH_RATIO,
  PICKER_VIEWPORT_PAD_PX,
  placePicker,
  rectIntersectionArea
} from '../src/renderer/src/lib/editor/codeBlockLangPicker.ts'

/** 造一个 rect（right/bottom 由宽高推出来，避免手抄不一致） */
function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height }
}

const VIEWPORT = { width: 1280, height: 900 }
/** 代码块外壳：与验收实例实测的一致（1280×900 视口、904×326 的块） */
const BLOCK = rect(320, 191.14, 904, 326)
const PANEL = { width: 218, height: 44.8 }

/** 把 placePicker 的结果还原成浮层 rect（宽度按 maxWidth 夹、高度按 maxHeight 夹） */
function pickerRect(placement, panel = PANEL) {
  const w = Math.min(panel.width, placement.maxWidth)
  const h = Math.min(panel.height, placement.maxHeight)
  return rect(placement.left, placement.top, w, h)
}

function assertOutside(placement, block, panel = PANEL, why = '') {
  const p = pickerRect(placement, panel)
  assert.equal(
    rectIntersectionArea(p, block),
    0,
    `${why}浮层压到代码块了：picker=${JSON.stringify(p)} block=${JSON.stringify(block)}`
  )
  return p
}

test('rectIntersectionArea：相交/相离/贴边都按面积算（贴边 = 0）', () => {
  assert.equal(rectIntersectionArea(rect(0, 0, 10, 10), rect(5, 5, 10, 10)), 25)
  assert.equal(rectIntersectionArea(rect(0, 0, 10, 10), rect(20, 20, 5, 5)), 0)
  // 边缘贴合（bottom === top）不算重叠
  assert.equal(rectIntersectionArea(rect(0, 0, 10, 10), rect(0, 10, 10, 10)), 0)
})

test('默认贴代码块上方、右对齐、留 6px 缝（交集 = 0）', () => {
  const p = placePicker({
    block: BLOCK,
    viewport: VIEWPORT,
    panelWidth: PANEL.width,
    panelHeight: PANEL.height,
    side: null
  })
  assert.equal(p.side, 'above')
  // 右缘与块右缘对齐（没有触到视口夹取）
  assert.equal(p.left + Math.min(PANEL.width, p.maxWidth), BLOCK.right)
  // 底边落在"块顶 - 6px"上（整数像素取整，最多差半像素；"贴合但不重叠"）
  const gap = BLOCK.top - (p.top + Math.min(PANEL.height, p.maxHeight))
  assert.ok(
    Math.abs(gap - PICKER_GAP_PX) <= 0.5,
    `浮层与块顶的缝应为 ${PICKER_GAP_PX}px，实际 ${gap}`
  )
  assertOutside(p, BLOCK, PANEL, '默认位置')
})

test('顶部空间不足 → 自动贴到代码块下方，仍然不重叠', () => {
  // 块顶在 40px：上方净空间只有 40-6-8=26px，放不下 44.8px 的浮层
  const block = rect(320, 40, 904, 326)
  const p = placePicker({
    block,
    viewport: VIEWPORT,
    panelWidth: PANEL.width,
    panelHeight: PANEL.height,
    side: null
  })
  assert.equal(p.side, 'below')
  assert.equal(p.top, Math.round(block.bottom + PICKER_GAP_PX))
  const pr = assertOutside(p, block, PANEL, '下方位置')
  assert.ok(pr.bottom <= VIEWPORT.height - PICKER_VIEWPORT_PAD_PX, '下方位置越出视口底边')
})

test('上下都放不下整份列表 → 用 max-height 夹住，仍在块外且不越出视口', () => {
  // 块高 600、顶在 150：上方 136px、下方 136px，都放不下 260px 的展开列表
  const block = rect(320, 150, 904, 600)
  const panel = { width: 218, height: 260 }
  const p = placePicker({
    block,
    viewport: VIEWPORT,
    panelWidth: panel.width,
    panelHeight: panel.height,
    side: null
  })
  assert.equal(p.maxHeight, 136, '高度上限应等于所贴那一侧的空间')
  const pr = assertOutside(p, block, panel, '夹高度后')
  assert.ok(pr.bottom <= VIEWPORT.height - PICKER_VIEWPORT_PAD_PX, '夹高度后越出视口底边')
  assert.ok(pr.top >= PICKER_VIEWPORT_PAD_PX, '夹高度后越出视口顶边')
})

test('列表展开长高时粘住已选边（不因高度变化在上下之间跳）', () => {
  const first = placePicker({
    block: BLOCK,
    viewport: VIEWPORT,
    panelWidth: PANEL.width,
    panelHeight: PANEL.height,
    side: null
  })
  const grown = placePicker({
    block: BLOCK,
    viewport: VIEWPORT,
    panelWidth: PANEL.width,
    panelHeight: 260,
    side: first.side
  })
  assert.equal(grown.side, 'above')
  assertOutside(grown, BLOCK, { width: 218, height: 260 }, '展开列表')
})

test('滚动把块顶到视口上沿 → 翻到下方（翻边后也不重叠）', () => {
  const block = rect(320, 10, 904, 326)
  const p = placePicker({
    block,
    viewport: VIEWPORT,
    panelWidth: PANEL.width,
    panelHeight: PANEL.height,
    side: 'above' // 上一拍还贴在上方
  })
  assert.equal(p.side, 'below')
  assertOutside(p, block, PANEL, '滚动翻边')
})

test('宽度上限 = min(240px, 代码块宽 × 40%, 视口宽 - 16px)', () => {
  assert.equal(PICKER_MAX_WIDTH_RATIO, 0.4)
  const cases = [
    // [块宽, 期望 maxWidth, 说明]
    [904, 240, '常规块：40% = 361.6 > 240，取 240'],
    [500, 200, '窄块：40% = 200 < 240'],
    [300, 120, '更窄：40% = 120'],
    [100, 40, '极窄：仍然是 40%（用户口径是硬上限）']
  ]
  for (const [width, want, why] of cases) {
    const block = rect(320, 191.14, width, 326)
    const p = placePicker({
      block,
      viewport: VIEWPORT,
      panelWidth: 218,
      panelHeight: PANEL.height,
      side: null
    })
    assert.equal(p.maxWidth, want, `${why}：width=${width}`)
    assert.ok(p.maxWidth <= PICKER_MAX_WIDTH_PX, '不得超过 240px 的绝对上限')
    assert.ok(
      p.maxWidth <= Math.floor(width * 0.4),
      `不得超过代码块宽的 40%（width=${width}, maxWidth=${p.maxWidth}）`
    )
    assertOutside(p, block, PANEL, `块宽 ${width}`)
  }
})

test('窄窗口（1000px）下右对齐 + 视口夹取：不越界、不压块', () => {
  const viewport = { width: 1000, height: 900 }
  const block = rect(200, 191.14, 704, 326)
  const p = placePicker({
    block,
    viewport,
    panelWidth: PANEL.width,
    panelHeight: PANEL.height,
    side: null
  })
  assert.equal(p.maxWidth, 240)
  const pr = assertOutside(p, block, PANEL, '窄窗口')
  assert.ok(pr.left >= PICKER_VIEWPORT_PAD_PX, '越出视口左缘')
  assert.ok(pr.right <= viewport.width - PICKER_VIEWPORT_PAD_PX, '越出视口右缘')
})

test('扫一遍纵向位置：只要这一侧够放，浮层永远不压代码、不出视口', () => {
  for (const height of [326, 220, 96]) {
    for (let top = 0; top + height <= VIEWPORT.height; top += 13) {
      const block = rect(320, top, 904, height)
      const p = placePicker({
        block,
        viewport: VIEWPORT,
        panelWidth: PANEL.width,
        panelHeight: PANEL.height,
        side: null
      })
      const pr = assertOutside(p, block, PANEL, `top=${top}, height=${height}`)
      assert.ok(
        pr.top >= PICKER_VIEWPORT_PAD_PX && pr.bottom <= VIEWPORT.height - PICKER_VIEWPORT_PAD_PX,
        `top=${top}, height=${height}: 浮层越出视口（${pr.top}..${pr.bottom}）`
      )
    }
  }
})
