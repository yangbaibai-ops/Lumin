// ─── 滚动侦测（目录/大纲的当前章节）：纯函数单测 ─────────────────────────────
//
// 对应 `src/renderer/src/lib/editor/scrollSpy.ts`。用户两轮报障都落在这两个边界上：
//   ① 点目录「点谁就该亮谁」—— 那是**选择**与**侦测**的优先级问题（在 store 的 pin 里解决，
//      见 `_verify-outline-nav.js`）；
//   ② 文档最后几节很短、标题压不到判定线上 —— 旧行为是高亮停在倒数第四，一补 bottom clamp，
//      又变成「一到底就跳最后一个，跳过中间两节」。本文件把 ② 的规则枚举清楚。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeHeadingIndex,
  SCROLL_SPY_OFFSET_PX
} from '../src/renderer/src/lib/editor/scrollSpy.ts'

/** 造一屏能显示 800px、文档总高 docHeight 的几何：返回各标题在「当前 scrollTop」下的 tops */
const topsAt = (docTops, scrollTop) => docTops.map((t) => t - scrollTop)

test('常规：判定线之上最后一个标题就是当前章节', () => {
  // 文档位置 130 / 900 / 1700 / 2500；maxScroll 2800 ⇒ 每个标题都压得到判定线（尾部补偿不参与）
  const doc = [130, 900, 1700, 2500]
  const at = (x) => activeHeadingIndex({ tops: topsAt(doc, x), scrollTop: x, maxScroll: 2800 })
  assert.equal(at(0), -1, '开头还没越过判定线')
  assert.equal(at(200), 0)
  assert.equal(at(1000), 1)
  assert.equal(at(1800), 2)
  assert.equal(at(2500), 3, '滚到底=最后一条')
})

test('末尾补偿：压不到判定线的几节按剩余滚动距离等分，不是一到底就跳最后', () => {
  /**
   * 用户那个布局：视口 800px、总内容 3900px ⇒ maxScroll = 3100。
   * 末尾 3 节很短（文档位置 3000 / 3200 / 3400），倒数第 4 节在 2700。
   * 滚到底时：2700→-400、3000→-100、3200→100、3400→300（相对容器上沿）。
   * ⇒ 3000 及以后都压不到判定线（3000-3100 = -100 ≤ 90 其实压到了…用真实值算见断言）。
   */
  const doc = [130, 900, 1700, 2700, 3000, 3200, 3400]
  const maxScroll = 3100
  const at = (x) => activeHeadingIndex({ tops: topsAt(doc, x), scrollTop: x, maxScroll })

  // 还没滚到「末尾那几节」的区间之前，尾部补偿不参与（否则开头就跳到最后）
  assert.equal(at(0), -1)
  assert.equal(at(2000), 2)
  assert.equal(at(2700), 3, '倒数第 4 节压线')

  // 从「倒数第 4 节压线」到滚到底之间，剩下的标题要**依次**点亮（旧行为会跳过中间项）
  const walked = []
  let last = -1
  for (let x = 2700; x <= maxScroll; x += 10) {
    const v = at(x)
    assert.ok(v >= last, `单调性：scrollTop ${x} 时 ${v} 不该小于 ${last}`)
    last = v
    if (walked[walked.length - 1] !== v) walked.push(v)
  }
  assert.deepEqual(
    walked.filter((v, i, a) => a.indexOf(v) === i),
    [3, 4, 5, 6],
    '走过的顺序：倒数第 4 → 倒数第 3 → 倒数第 2 → 倒数第 1（一个都不跳过）'
  )
  assert.equal(at(maxScroll), 6, '滚到底 = 最后一条')
})

test('末尾补偿：中间几节各自都拿到了一段滚动距离（不是瞬间划过）', () => {
  const doc = [0, 1000, 2000, 2900, 3000, 3100]
  const maxScroll = 3100
  const at = (x) => activeHeadingIndex({ tops: topsAt(doc, x), scrollTop: x, maxScroll })
  // 统计每个下标被点亮时的 scrollTop 区间长度
  const firstSeen = new Map()
  for (let x = 0; x <= maxScroll; x += 5) {
    const v = at(x)
    if (!firstSeen.has(v)) firstSeen.set(v, x)
  }
  const t4 = firstSeen.get(4)
  const t5 = firstSeen.get(5)
  assert.ok(
    t4 !== undefined && t5 !== undefined,
    `倒数第二 / 最后一条都要有被点亮的时刻：${JSON.stringify([...firstSeen])}`
  )
  assert.ok(t5 > t4, `顺序必须递增：${t4} → ${t5}`)
  assert.ok(t5 - t4 >= 5, `最后一条不该与上一条在同一像素内点亮（实测间隔 ${t5 - t4}px）`)
})

test('极端：滚到底也没有标题能压线（标题全挤在末尾）', () => {
  const doc = [400, 500, 600] // 视口 800：都在判定线下面，滚到底也压不到
  const maxScroll = 300
  const at = (x) => activeHeadingIndex({ tops: topsAt(doc, x), scrollTop: x, maxScroll })
  // 这种几何下没有任何标题能压线，只能把整段滚动距离平分给三条：
  // 第一条的份额从 0 开始 —— 所以「还没滚」时点亮的就是第一条（而不是一条都不亮）。
  assert.equal(at(0), 0, '第一条的份额从 0 起')
  assert.equal(at(150), 1)
  assert.equal(at(300), 2, '滚到底 = 最后一条')
})

test('不可滚动（短文档）时不乱点亮', () => {
  const doc = [130, 200, 270]
  const v = activeHeadingIndex({ tops: topsAt(doc, 0), scrollTop: 0, maxScroll: 0 })
  assert.equal(v, -1, '标题都在判定线之下、又不可滚动 ⇒ 还没有当前章节')
  // 第一屏内压线的那种：第一条在 60（判定线之上）
  assert.equal(activeHeadingIndex({ tops: [60, 200, 270], scrollTop: 0, maxScroll: 0 }), 0)
  assert.equal(
    activeHeadingIndex({ tops: [60, 88, 270], scrollTop: 0, maxScroll: 0 }),
    1,
    '两条都在线上 ⇒ 取后一条'
  )
})

test('空大纲 / 默认判定线常量', () => {
  assert.equal(activeHeadingIndex({ tops: [], scrollTop: 0, maxScroll: 0 }), -1)
  assert.equal(SCROLL_SPY_OFFSET_PX, 90, '判定线是 90px（改了要同步手册与套件）')
  assert.equal(activeHeadingIndex({ tops: [95, 300], scrollTop: 0, maxScroll: 0 }), -1)
  assert.equal(
    activeHeadingIndex({ tops: [95, 300], scrollTop: 0, maxScroll: 0, offset: 100 }),
    0,
    'offset 可调'
  )
})
