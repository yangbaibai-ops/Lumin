// 工具栏悬停弹层的**落点几何**与"去重"守卫（审计 §10 P1「重复实现：popover 2 份」）。
//
// 为什么值得测：这段几何此前在 `ToolbarCodeBlockButton.vue` 与 `ToolbarTableButton.vue` 里
// 各写了一遍（开合时序也各一份，300ms/180ms 逐字相同）。重复的代价是"改一处忘一处"——
// 两个按钮的手感或边界行为会悄悄分叉，而用户只会觉得"有时候怪怪的"。
// 现在落点计算是纯函数，时序是 `useHoverPopover`，两个组件都必须用它。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  POPOVER_CLOSE_DELAY,
  POPOVER_GAP,
  POPOVER_OPEN_DELAY,
  planPopoverPos
} from '../src/renderer/src/composables/useHoverPopover.ts'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const VIEWPORT = { width: 1000, height: 800 }

test('悬停弹层落点：默认贴在按钮左缘下方固定间距处', () => {
  const p = planPopoverPos({ left: 120, bottom: 300 }, VIEWPORT)
  assert.deepEqual(p, { x: 120, y: 300 + POPOVER_GAP })
  // 不传宽度 = 不做横向钳制（调用方自己负责，保持原行为可复现）
  assert.equal(planPopoverPos({ left: 980, bottom: 10 }, VIEWPORT).x, 980)
})

test('悬停弹层落点：给了宽度就夹进视口（窄窗口下按钮贴近右边缘时不溢出）', () => {
  const width = 188
  const p = planPopoverPos({ left: 980, bottom: 300 }, VIEWPORT, { width })
  assert.equal(p.x, VIEWPORT.width - width - 8, '右边缘必须留出 margin，而不是让弹层溢出')
  assert.equal(p.y, 300 + POPOVER_GAP)
  // 左边缘同理（负坐标/极窄容器）
  assert.equal(planPopoverPos({ left: -50, bottom: 0 }, VIEWPORT, { width }).x, 8)
  // 间距可覆盖
  assert.equal(planPopoverPos({ left: 10, bottom: 100 }, VIEWPORT, { gap: 0 }).y, 100)
})

test('开合时序常量是"数据"：300ms 打开 / 180ms 宽限（改它们等于改手感，必须显式）', () => {
  assert.equal(POPOVER_OPEN_DELAY, 300)
  assert.equal(POPOVER_CLOSE_DELAY, 180)
  assert.equal(POPOVER_GAP, 8)
})

test('两个工具栏按钮共用这一份实现：组件里不许再出现自己的计时器/定位公式', () => {
  const files = [
    'src/renderer/src/components/ToolbarCodeBlockButton.vue',
    'src/renderer/src/components/ToolbarTableButton.vue'
  ]
  // 这些特征串代表"自己又写了一份"：openTimer/closeTimer 局部变量、手写的 innerWidth 钳制、
  // 以及 300/180 这两个魔法数字出现在组件里
  const FORBIDDEN = [
    /let openTimer: ReturnType<typeof setTimeout>/,
    /window\.innerWidth - POP_WIDTH - 8/,
    /setTimeout\(showPopover,\s*300\)/,
    /setTimeout\(\(\) => \{\s*open\.value = false\s*\},\s*180\)/
  ]
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf-8')
    assert.match(
      src,
      /from '\.\.\/composables\/useHoverPopover'/,
      `${f} 没有 import useHoverPopover`
    )
    for (const re of FORBIDDEN) {
      assert.doesNotMatch(src, re, `${f} 里还有本地的弹层时序/定位实现（${re}）`)
    }
  }
})
