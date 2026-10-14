// ─── 指针目标：widget（图片/公式）的定位抽象 ──────────────────────────────────
//
// 问题背景：行内公式与图片都是 contenteditable="false" 的 widget，
// ProseMirror 的 posAtCoords 在整个盒子宽度内恒返回同一点 ⇒ 无法连续拖选跨越它们。
//
// 本模块提供统一的"指针 → 盒子 → 文档区间"映射，支持图片与公式各自注册 resolver。

import type { EditorView } from '@tiptap/pm/view'

/** 一个"盒子"（图片 widget / 公式 widget）的信息 */
export interface BoxHit {
  /** 盒子类型 */
  kind: 'image' | 'math-inline' | 'math-block'
  /** 源码在文档中的起点（包含） */
  from: number
  /** 源码在文档中的终点（不包含） */
  to: number
  /** 盒子的 DOM 元素 */
  el: HTMLElement
}

/**
 * 盒子 resolver：给定一个 DOM 元素，判断它是否是某种盒子，并返回对应的文档区间。
 * 返回 null = 不是这个 resolver 负责的盒子。
 */
export type BoxResolver = (view: EditorView, el: HTMLElement) => BoxHit | null

/** 已注册的 resolver 清单 */
const resolvers: BoxResolver[] = []

/**
 * 注册一个盒子 resolver。
 * 调用时机：扩展初始化时（图片/公式插件各自注册一次）。
 */
export function registerBoxResolver(resolver: BoxResolver): void {
  resolvers.push(resolver)
}

/**
 * 给定一个 DOM 元素，查找它是否是某个盒子（或盒子的后代）。
 * 返回 null = 不是任何已注册盒子。
 */
export function boxAt(view: EditorView, target: HTMLElement | null): BoxHit | null {
  if (!target) return null
  let el: HTMLElement | null = target
  while (el && el !== view.dom && el !== document.body) {
    for (const resolver of resolvers) {
      const hit = resolver(view, el)
      if (hit) return hit
    }
    el = el.parentElement
  }
  return null
}

/**
 * 给定一个点坐标，找出它下面的盒子（如果有）。
 */
export function boxAtPoint(view: EditorView, x: number, y: number): BoxHit | null {
  const el = document.elementFromPoint(x, y)
  if (!el || el.nodeType !== 1) return null
  return boxAt(view, el as HTMLElement)
}

/**
 * 指针压在盒子的哪一侧（用于拖选结束时的"落定规则"）。
 * 返回 'start' | 'end' | null（null = 不在盒子上）。
 * 策略：盒子的横向范围二分，左半 = start，右半 = end。
 */
export function boxEdgeAtPoint(
  view: EditorView,
  x: number,
  y: number
): { edge: 'start' | 'end'; box: BoxHit } | null {
  const box = boxAtPoint(view, x, y)
  if (!box) return null
  const rect = box.el.getBoundingClientRect()
  const mid = (rect.left + rect.right) / 2
  return { edge: x < mid ? 'start' : 'end', box }
}
