/**
 * ─── 「最近一次交互落在哪个区域」───────────────────────────────────────────────
 *
 * 为什么需要它（Ctrl+F 分流的第三次修正）：`lib/ctrlFRoute.ts` 判"人在不在侧栏里"时，
 * 原先只看两件事 —— 焦点在不在侧栏、指针**此刻**在不在侧栏（`aside:hover`）。这两件
 * 都描述"现在"，而用户的意图是"我刚才在哪儿操作"：
 *
 *   * 「鼠标停在侧栏上、然后点进正文按 Ctrl+F」→ 想找正文（指针是**上一次**的残留）；
 *   * 「鼠标刚移到侧栏的树行上、焦点其实还在正文」→ 想筛文件名（指针是**这一次**的动作）。
 *
 * 两种情况在"焦点 + 此刻指针"上完全一样，只有**时间顺序**能区分 —— 所以这里记两个序号：
 * 指针事件（move/down）落点的序号，与焦点落点的序号。谁更新，谁的意图更"当下"。
 *
 * 只读 DOM 语义锚点（`[data-sidebar-root]` / `[data-editor-kernel]`），不 import 任何 store，
 * 因此在挂载时装上即可。返回卸载函数。
 */
export type PointerRegion = 'sidebar' | 'editor'

let seq = 0
let pointerSeq = 0
let pointerRegion: PointerRegion | null = null
let focusSeq = 0

function regionOf(target: EventTarget | null): PointerRegion | null {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return null
  if (el.closest('[data-sidebar-root]')) return 'sidebar'
  if (el.closest('[data-editor-kernel]')) return 'editor'
  return null
}

function handlePointer(e: Event): void {
  const region = regionOf(e.target)
  if (!region) return
  pointerRegion = region
  pointerSeq = ++seq
}

function handleFocus(e: Event): void {
  if (!regionOf(e.target)) return
  focusSeq = ++seq
}

/** 最近一次指针交互落在 `region` 里，**且比最近一次焦点落点更晚** */
export function pointerIsMoreRecentThanFocus(region: PointerRegion): boolean {
  return pointerRegion === region && pointerSeq > focusSeq
}

/** 最近一次指针交互的区域（诊断/测试用） */
export function lastPointerRegion(): PointerRegion | null {
  return pointerRegion
}

/** 仅供测试/复位：把记录清空 */
export function resetPointerRegion(): void {
  seq = 0
  pointerSeq = 0
  pointerRegion = null
  focusSeq = 0
}

let installed = false
let teardown: (() => void) | null = null

/**
 * 装上监听（幂等：重复调用只保留一份监听器，返回同一个卸载函数）。
 * `pointermove` 与 `mousemove` 都听：CDP 合成的 `mouseMoved` 在个别版本上只派发后者。
 * `focusin` 用捕获阶段（focus 不冒泡）。
 */
export function installPointerRegionTracker(): () => void {
  if (installed) return teardown ?? (() => {})
  installed = true
  document.addEventListener('pointermove', handlePointer, true)
  document.addEventListener('mousemove', handlePointer, true)
  document.addEventListener('pointerdown', handlePointer, true)
  document.addEventListener('focusin', handleFocus, true)
  teardown = () => {
    document.removeEventListener('pointermove', handlePointer, true)
    document.removeEventListener('mousemove', handlePointer, true)
    document.removeEventListener('pointerdown', handlePointer, true)
    document.removeEventListener('focusin', handleFocus, true)
    installed = false
    teardown = null
  }
  return teardown
}
