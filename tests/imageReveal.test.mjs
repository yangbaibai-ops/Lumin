import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PENDING_TTL,
  isPendingExpired,
  revealDecision,
  selectionCoversSource,
  selectionIntersectsSource
} from '../src/renderer/src/lib/editor/imageReveal.ts'

/**
 * 标识符显隐契约（`docs/image-behavior.md` 第 3 节）—— 这是**唯一**落点，请勿在别处再写一份判据。
 * 夹具：标识符范围 `[10, 20]`（长度 10）。
 */
const IMG = { from: 10, to: 20 }
const sel = (from, to, extra = {}) => ({ from, to, empty: from === to, nodeSel: false, ...extra })

test('NodeSelection 正好盖住它 ⇒ 显示（点图片 = 选中这张图）', () => {
  assert.equal(revealDecision({ from: 10, to: 11, empty: false, nodeSel: true }, IMG), 'show')
})

test('空光标：与它有交集（含两端边界）⇒ 显示', () => {
  for (const p of [10, 15, 20]) {
    assert.equal(revealDecision(sel(p, p), IMG), 'show', `光标 ${p} 应显示`)
  }
})

test('空光标：完全在它之外 ⇒ 隐藏', () => {
  for (const p of [0, 9, 21, 30]) {
    assert.equal(revealDecision(sel(p, p), IMG), 'hide', `光标 ${p} 应隐藏`)
  }
})

test('非空选区被完全包含（严格子区间）⇒ 显示', () => {
  assert.equal(revealDecision(sel(11, 19), IMG), 'show')
  assert.equal(revealDecision(sel(12, 12 + 1), IMG), 'show')
})

test('非空选区恰好等于标识符范围 ⇒ 显示（"拖满不消失"，用户第七十二轮口径）', () => {
  assert.equal(revealDecision(sel(10, 20), IMG), 'show')
})

test('非空选区两端都超出（图片被夹在中间）⇒ 隐藏（用户第七十五轮口径）', () => {
  assert.equal(revealDecision(sel(9, 21), IMG), 'hide')
  assert.equal(revealDecision(sel(0, 30), IMG), 'hide')
})

test('非空选区一端在外、一端在内 ⇒ 隐藏（防闪烁：从别处拖过它不许闪出来）', () => {
  assert.equal(revealDecision(sel(9, 19), IMG), 'hide')
  assert.equal(revealDecision(sel(11, 21), IMG), 'hide')
})

test('非空选区与它无交集 ⇒ 隐藏', () => {
  assert.equal(revealDecision(sel(0, 9), IMG), 'hide')
  assert.equal(revealDecision(sel(21, 30), IMG), 'hide')
})

test('边界情形：非空选区右端齐平、左端在外 ⇒ 隐藏（齐平不等于被包含）', () => {
  assert.equal(revealDecision(sel(9, 20), IMG), 'hide')
})

test('边界情形：非空选区左端齐平、右端在内 ⇒ 显示（被包含）', () => {
  assert.equal(revealDecision(sel(10, 19), IMG), 'show')
})

test('登记到期：TTL 内有效、超过 TTL 视为已清理（第 9 节自愈契约）', () => {
  const at = 1_000
  assert.equal(PENDING_TTL, 900)
  assert.equal(isPendingExpired(at, at + 100), false)
  assert.equal(isPendingExpired(at, at + PENDING_TTL), false, '恰好等于 TTL 仍未过期（> 才过期）')
  assert.equal(isPendingExpired(at, at + PENDING_TTL + 1), true)
})

// 第一百零四轮（**DOM 身份快照**）：按"这次拖动的起点是否落在这段源码文本里"分流
test('dragging + 起点命中该源（dragInsideFrom === img.from）⇒ 覆盖也 show', () => {
  assert.equal(
    revealDecision(sel(1, 30), IMG, { dragging: true, dragInsideFrom: IMG.from }),
    'show'
  )
})

test('dragging + 起点未命中（null 或别的源）⇒ 一律 hide（第七十五轮防闪口径，㉑①/㉑②）', () => {
  assert.equal(revealDecision(sel(1, 30), IMG, { dragging: true, dragInsideFrom: null }), 'hide')
  assert.equal(revealDecision(sel(10, 19), IMG, { dragging: true, dragInsideFrom: null }), 'hide')
  assert.equal(
    revealDecision(sel(1, 30), IMG, { dragging: true, dragInsideFrom: IMG.from + 100 }),
    'hide'
  )
})

test('未拖动：覆盖 ⇒ hide、被包含 ⇒ show（既有口径不变）', () => {
  assert.equal(revealDecision(sel(1, 30), IMG), 'hide')
  assert.equal(revealDecision(sel(10, 19), IMG), 'show')
})

// ─── 第一百零六轮 B 段：「图片被选中」观感 = 选区与图片**有交**（浏览器语义）───────────────
// ⚠️ 这两条判据**必须**分开：`selectionIntersectsSource` 只管 `img-selected` 观感，
//    `selectionCoversSource` 只管"标识符该不该隐藏"。下面的对偶断言就是"不许合并"的护栏。
test('B：部分覆盖（选区只压住源码后半段）⇒ 图片算被选中', () => {
  assert.equal(selectionIntersectsSource(sel(15, 19), IMG), true)
})

test('B：一端在内、一端在外 ⇒ 图片算被选中（浏览器里也这样）', () => {
  assert.equal(selectionIntersectsSource(sel(9, 19), IMG), true)
  assert.equal(selectionIntersectsSource(sel(15, 21), IMG), true)
})

test('B：完全覆盖（含整齐等于）⇒ 图片算被选中', () => {
  assert.equal(selectionIntersectsSource(sel(10, 20), IMG), true)
  assert.equal(selectionIntersectsSource(sel(5, 25), IMG), true)
})

test('B：无交集 / 只在边界外侧 ⇒ 不算被选中', () => {
  assert.equal(selectionIntersectsSource(sel(0, 9), IMG), false)
  assert.equal(selectionIntersectsSource(sel(21, 30), IMG), false)
  assert.equal(selectionIntersectsSource(sel(20, 30), IMG), false, '左端齐平右边界不算相交')
  assert.equal(selectionIntersectsSource(sel(0, 10), IMG), false, '右端齐平左边界不算相交')
})

test('B：空光标不算"被选中"（浏览器不给图片画选区色）', () => {
  assert.equal(selectionIntersectsSource(sel(15, 15), IMG), false)
})

test('B：两条口径**没有**被合并 —— 部分覆盖时"图片选中"成立、"隐藏标识符"不成立', () => {
  const partial = sel(15, 19) // 只压住后半段
  assert.equal(selectionIntersectsSource(partial, IMG), true, '图片：要有选中观感')
  assert.equal(selectionCoversSource(partial, IMG), false, '标识符：不许被藏掉')
  assert.equal(revealDecision(partial, IMG), 'show', '标识符仍显示（显隐口径未放宽）')
})

test('B：整段选中 ⇒ 两条口径同时成立（既有"整段选中 ⇒ 图片高亮"不回归）', () => {
  const all = sel(5, 25)
  assert.equal(selectionIntersectsSource(all, IMG), true)
  assert.equal(selectionCoversSource(all, IMG), true)
  assert.equal(revealDecision(all, IMG), 'hide')
})
