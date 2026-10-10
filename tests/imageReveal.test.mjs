import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PENDING_TTL,
  isPendingExpired,
  revealDecision
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
