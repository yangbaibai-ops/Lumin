// ─── 窗口位置/尺寸的纯规则（`main/windowPlacement.ts`）单测 ─────────────────────
//
// 抽出这两条判定是为了**能测**：它们此前埋在 `main/index.ts`（644 行启动编排）里，
// 而这种"用户看得见、但只在特定显示器配置下才出问题"的逻辑，靠人工点几乎必然漏。
// 审计 §6 P2 把 `main/index.ts` 列为"职责混杂"的典型；这是"先补覆盖再动刀"的第一刀。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  canRestoreWindow,
  intersectsAnyWorkArea,
  windowStateFor
} from '../src/main/windowPlacement.ts'

/** 一块 1920×1080 的显示器（工作区扣掉任务栏 40px） */
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
/** 右侧第二块显示器 */
const SECOND = { x: 1920, y: 0, width: 1920, height: 1040 }
const saved = (over = {}) => ({
  x: 100,
  y: 80,
  width: 1320,
  height: 860,
  isMaximized: false,
  ...over
})

test('相交判定：完全在内 / 只露一角 / 完全在外', () => {
  assert.equal(intersectsAnyWorkArea({ x: 100, y: 80, width: 800, height: 600 }, [PRIMARY]), true)
  // 右下角只压住 1 像素（仍算"看得见"）
  assert.equal(
    intersectsAnyWorkArea({ x: 1919, y: 1039, width: 800, height: 600 }, [PRIMARY]),
    true
  )
  // 完全在右边那块显示器之外
  assert.equal(
    intersectsAnyWorkArea({ x: 4000, y: 0, width: 800, height: 600 }, [PRIMARY, SECOND]),
    false
  )
})

test('相交判定：只在边上贴住不算（一个像素都看不到）', () => {
  assert.equal(
    intersectsAnyWorkArea({ x: 1920, y: 0, width: 800, height: 600 }, [PRIMARY]),
    false,
    '左边贴着 PRIMARY 的右边界 —— 在 PRIMARY 上一个像素都没有'
  )
  assert.equal(
    intersectsAnyWorkArea({ x: 1920, y: 0, width: 800, height: 600 }, [PRIMARY, SECOND]),
    true,
    '但它在第二块显示器上是可见的'
  )
  // 另一侧同理：窗口**右边界**正好压在工作区左边界上（整块都在屏幕左边之外）
  assert.equal(
    intersectsAnyWorkArea({ x: -800, y: 0, width: 800, height: 600 }, [PRIMARY]),
    false,
    'x + width === 工作区.x —— 一个像素都没进来'
  )
  assert.equal(
    intersectsAnyWorkArea({ x: -800, y: 0, width: 801, height: 600 }, [PRIMARY]),
    true,
    '多一个像素就该算可见'
  )
})

test('canRestoreWindow：拔掉外接屏之后，落在屏幕外的记录不采用', () => {
  const offscreen = saved({ x: 2400, y: 100 })
  assert.equal(canRestoreWindow(offscreen, [PRIMARY]), false)
  assert.equal(canRestoreWindow(offscreen, [PRIMARY, SECOND]), true, '那块屏插着时是合法的')
})

test('canRestoreWindow：小于最小窗口的记录不采用（否则窗口一起来就被夹）', () => {
  assert.equal(
    canRestoreWindow(saved({ width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT }), [PRIMARY]),
    true
  )
  assert.equal(canRestoreWindow(saved({ width: MIN_WINDOW_WIDTH - 1 }), [PRIMARY]), false)
  assert.equal(canRestoreWindow(saved({ height: MIN_WINDOW_HEIGHT - 1 }), [PRIMARY]), false)
})

test('canRestoreWindow：坏数据与空显示器列表都退回默认尺寸（不恢复到屏幕外）', () => {
  assert.equal(canRestoreWindow(null, [PRIMARY]), false)
  assert.equal(canRestoreWindow(undefined, [PRIMARY]), false)
  assert.equal(canRestoreWindow(saved(), []), false, '拿不到显示器时宁可不用保存的位置')
  assert.equal(canRestoreWindow(saved({ x: Number.NaN }), [PRIMARY]), false)
  assert.equal(canRestoreWindow(saved({ width: Number.POSITIVE_INFINITY }), [PRIMARY]), false)
})

test('canRestoreWindow：最大化标志不参与判定（它只决定"还原时要不要最大化"）', () => {
  assert.equal(canRestoreWindow(saved({ isMaximized: true }), [PRIMARY]), true)
})

test('windowStateFor：最大化时存正常尺寸，非最大化时存当前 bounds', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 } // 被撑满的屏幕矩形
  const normalBounds = { x: 120, y: 90, width: 1320, height: 860 }
  assert.deepEqual(windowStateFor({ bounds, normalBounds, isMaximized: true }), {
    ...normalBounds,
    isMaximized: true
  })
  assert.deepEqual(windowStateFor({ bounds, normalBounds, isMaximized: false }), {
    ...bounds,
    isMaximized: false
  })
  // 存下来的记录本身仍要通过"可恢复"判定（两者是同一条链的两端）
  assert.equal(
    canRestoreWindow(windowStateFor({ bounds, normalBounds, isMaximized: true }), [PRIMARY]),
    true
  )
})
