// ─── 窗口默认尺寸 / 恢复夹取 / 跨 DPI 保持 DIP 尺寸（`main/windowBounds.ts`）──────
//
// 这些规则只在“换一块屏、改一次缩放、拔掉副屏”时才出错，手工验证几乎必然漏。
// 这里用**模拟显示器数组**把三种场景钉死：
//   ① computeDefaultBounds：1366×768 / 1920×1080 / 2560×1440@1.25 / 3840×2160@2 /
//      带任务栏偏移的工作区 ⇒ 不越界、≥最小尺寸、居中、宽高在 clamp 区间；
//   ② clampBoundsToWorkArea：4K 上存的 1800×1150 掉到 1366×768 上 ⇒ 收进工作区且标题栏可见；
//   ③ preserveDipSize：1→1.5 / 1.5→1 / 2→1 ⇒ 输出 DIP 尺寸不变（±1px），x/y 在新工作区内。
//
// 注意口径：Electron 的 `workArea` 是 **DIP**，所以 3840×2160@200% 的工作区约为
// 1920×1080（不是 3840×2160）；要验证“大屏上限”，另加一组 3840×2160@100%。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

// windowBounds.ts 里 import './windowPlacement'（无扩展名），先装解析钩子再动态 import
installTsExtensionResolve()
const {
  DEFAULT_MAX_HEIGHT,
  DEFAULT_MAX_WIDTH,
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MIN_WIDTH,
  MIN_WINDOW_SIZE,
  clampBoundsToWorkArea,
  computeDefaultBounds,
  displayStateKey,
  preserveDipSize,
  rectsClose
} = await import('../src/main/windowBounds.ts')

const MIN = { width: 760, height: 520 }

/**
 * 五组验收显示器（workArea 为 DIP；scaleFactor 只影响分屏 key，不影响默认尺寸公式）。
 * 第 4 组是 4K@200%：物理 3840×2160，但 DIP 工作区与 1080p 相当 —— 这正是 Electron 的口径。
 */
const DISPLAYS = [
  {
    name: '1366×768@1',
    scaleFactor: 1,
    workArea: { x: 0, y: 0, width: 1366, height: 728 },
    expected: { x: 133, y: 4, width: 1100, height: 720 }
  },
  {
    name: '1920×1080@1',
    scaleFactor: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    expected: { x: 211, y: 94, width: 1498, height: 853 }
  },
  {
    name: '2560×1440@1.25',
    scaleFactor: 1.25,
    workArea: { x: 0, y: 0, width: 2048, height: 1120 },
    expected: { x: 226, y: 101, width: 1597, height: 918 }
  },
  {
    name: '3840×2160@2',
    scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    expected: { x: 211, y: 94, width: 1498, height: 853 }
  },
  {
    name: '带任务栏偏移的工作区',
    scaleFactor: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    expected: { x: 211, y: 94, width: 1498, height: 853 }
  }
]

test('computeDefaultBounds：五组显示器都不越界、≥最小窗口、居中、在 clamp 区间内', () => {
  for (const d of DISPLAYS) {
    const b = computeDefaultBounds(d.workArea)
    assert.deepEqual(b, d.expected, `${d.name} 的默认 bounds`)
    assert.ok(b.width >= MIN.width && b.height >= MIN.height, `${d.name} 不小于最小窗口`)
    assert.ok(
      b.width >= DEFAULT_MIN_WIDTH && b.width <= DEFAULT_MAX_WIDTH,
      `${d.name} 宽度在 1100–1800`
    )
    assert.ok(
      b.height >= DEFAULT_MIN_HEIGHT && b.height <= DEFAULT_MAX_HEIGHT,
      `${d.name} 高度在 720–1150`
    )
    assert.ok(b.width <= d.workArea.width, `${d.name} 宽度不超过工作区`)
    assert.ok(b.height <= d.workArea.height, `${d.name} 高度不超过工作区`)
    assert.ok(b.x >= d.workArea.x && b.x + b.width <= d.workArea.x + d.workArea.width)
    assert.ok(b.y >= d.workArea.y && b.y + b.height <= d.workArea.y + d.workArea.height)
    // 居中：允许 round 的 ±1
    assert.ok(Math.abs(b.x - (d.workArea.x + (d.workArea.width - b.width) / 2)) <= 1)
    assert.ok(Math.abs(b.y - (d.workArea.y + (d.workArea.height - b.height) / 2)) <= 1)
  }
})

test('computeDefaultBounds：大 DIP 工作区顶到上限 1800×1150（4K@100%），不铺满', () => {
  const b = computeDefaultBounds({ x: 0, y: 0, width: 3840, height: 2120 })
  assert.deepEqual(b, { x: 1020, y: 485, width: 1800, height: 1150 })
  assert.ok(b.width < 3840 && b.height < 2120, '不要铺满整屏')
})

test('computeDefaultBounds：极小工作区（1366×768@150%）以不越界优先', () => {
  // 150% 缩放下 1366×768 的可用逻辑尺寸约 911×512 —— 最小窗口 760×520 高度都放不下
  const b = computeDefaultBounds({ x: 0, y: 0, width: 911, height: 512 })
  assert.deepEqual(b, { x: 0, y: 0, width: 911, height: 512 })
})

test('clampBoundsToWorkArea：4K 上存的 1800×1150 掉到 1366×768 ⇒ 收进工作区且标题栏可见', () => {
  const saved = { x: 1080, y: 520, width: 1800, height: 1150 }
  const out = clampBoundsToWorkArea(saved, { x: 0, y: 0, width: 1366, height: 728 }, MIN)
  assert.deepEqual(out, { x: 0, y: 0, width: 1366, height: 728 })
  assert.ok(out.y >= 0, '标题栏必须可见')
  assert.ok(out.x + out.width <= 1366 && out.y + out.height <= 728)
})

test('clampBoundsToWorkArea：小于最小尺寸抬到 760×520；负数/越界坐标夹回', () => {
  const out = clampBoundsToWorkArea(
    { x: 9999, y: -500, width: 500, height: 300 },
    { x: 0, y: 0, width: 1920, height: 1040 },
    MIN
  )
  assert.deepEqual(out, { x: 1160, y: 0, width: 760, height: 520 })
})

test('clampBoundsToWorkArea：工作区比最小尺寸还窄时服从工作区（不越界优先）', () => {
  const out = clampBoundsToWorkArea(
    { x: 0, y: 0, width: 1200, height: 800 },
    { x: 0, y: 0, width: 700, height: 480 },
    MIN
  )
  assert.deepEqual(out, { x: 0, y: 0, width: 700, height: 480 })
})

test('clampBoundsToWorkArea：坏数据退回当前工作区的默认尺寸', () => {
  const workArea = { x: 0, y: 0, width: 1366, height: 728 }
  const out = clampBoundsToWorkArea(
    { x: Number.NaN, y: 0, width: 1200, height: 800 },
    workArea,
    MIN
  )
  assert.deepEqual(out, computeDefaultBounds(workArea))
})

test('clampBoundsToWorkArea：带偏移/负原点的副屏工作区也能居中夹取', () => {
  const wa = { x: -1920, y: 0, width: 1920, height: 1040 }
  const out = clampBoundsToWorkArea({ x: -3000, y: -200, width: 1800, height: 1150 }, wa, MIN)
  assert.deepEqual(out, { x: -1920, y: 0, width: 1800, height: 1040 })
})

test('preserveDipSize：1→1.5 / 1.5→1 / 2→1 输出 DIP 尺寸保持不变', () => {
  const input = { x: 400, y: 300, width: 1320, height: 860 }
  const cases = [
    { prev: 1, next: 1.5, workArea: { x: 0, y: 0, width: 2560, height: 1400 } },
    { prev: 1.5, next: 1, workArea: { x: 0, y: 0, width: 3840, height: 2120 } },
    { prev: 2, next: 1, workArea: { x: 0, y: 0, width: 3840, height: 2120 } }
  ]
  for (const c of cases) {
    const out = preserveDipSize(input, c.prev, c.next, c.workArea, MIN)
    assert.ok(
      Math.abs(out.width - input.width) <= 1 && Math.abs(out.height - input.height) <= 1,
      `${c.prev}→${c.next} 的 DIP 尺寸应不变：${out.width}×${out.height}`
    )
    assert.ok(out.x >= c.workArea.x && out.x + out.width <= c.workArea.x + c.workArea.width)
    assert.ok(out.y >= c.workArea.y && out.y + out.height <= c.workArea.y + c.workArea.height)
  }
})

test('preserveDipSize：坐标按缩放比例换算到新 DIP 坐标（锚定工作区原点）', () => {
  const input = { x: 400, y: 300, width: 1320, height: 860 }
  const zoomIn = preserveDipSize(input, 1, 1.5, { x: 0, y: 0, width: 2560, height: 1400 }, MIN)
  assert.equal(zoomIn.x, 267)
  assert.equal(zoomIn.y, 200)
  const zoomOut = preserveDipSize(input, 1.5, 1, { x: 0, y: 0, width: 3840, height: 2120 }, MIN)
  assert.equal(zoomOut.x, 600)
  assert.equal(zoomOut.y, 450)
})

test('preserveDipSize：新工作区放不下时收到工作区（DIP 尺寸可小于原值，但不越界）', () => {
  const out = preserveDipSize(
    { x: 100, y: 100, width: 1800, height: 1150 },
    1,
    1.5,
    { x: 0, y: 0, width: 1366, height: 728 },
    MIN
  )
  assert.deepEqual(out, { x: 0, y: 0, width: 1366, height: 728 })
})

test('preserveDipSize：坐标换算把窗口甩出工作区时保留当前坐标（只做边界修正）', () => {
  // 从 150% 屏拖回 100% 屏：坐标乘 1.5 会超出右边界，此时应保留当前可见坐标
  const out = preserveDipSize(
    { x: 500, y: 300, width: 1320, height: 860 },
    1.5,
    1,
    { x: 0, y: 0, width: 1920, height: 1040 },
    MIN
  )
  assert.equal(out.x, 500, '换算后越界 ⇒ 保留当前 x')
  assert.ok(out.x + out.width <= 1920)
  assert.ok(Math.abs(out.width - 1320) <= 1 && Math.abs(out.height - 860) <= 1)
})

test('displayStateKey：display.id + scaleFactor 组成 key，A 屏与 B 屏（及不同缩放）互不覆盖', () => {
  assert.equal(displayStateKey({ id: 1, scaleFactor: 1 }), '1@1')
  assert.equal(displayStateKey({ id: 1, scaleFactor: 1.25 }), '1@1.25')
  assert.equal(displayStateKey({ id: 2, scaleFactor: 1 }), '2@1')
  assert.notEqual(
    displayStateKey({ id: 1, scaleFactor: 1.5 }),
    displayStateKey({ id: 1, scaleFactor: 2 })
  )
})

test('rectsClose：1px 容差内视为同一 bounds（防 setBounds 回环）', () => {
  assert.equal(
    rectsClose({ x: 1, y: 2, width: 3, height: 4 }, { x: 2, y: 3, width: 4, height: 5 }),
    true
  )
  assert.equal(
    rectsClose({ x: 1, y: 2, width: 3, height: 4 }, { x: 3, y: 2, width: 3, height: 4 }),
    false
  )
})

test('常量同源：windowBounds 的最小尺寸与 windowPlacement 的 760×520 一致', () => {
  assert.deepEqual(MIN_WINDOW_SIZE, { width: 760, height: 520 })
})
