import { ref } from 'vue'

/**
 * ─── 文件树的键盘导航（ARIA tree 模式，roving tabindex）────────────────────────
 *
 * 为什么放在模块级 ref：树是**递归组件**（TreeNode 套 TreeNode），把「当前键盘焦点行」
 * 通过 props 逐层传下去既啰嗦又容易漏；而它本来就是全局唯一的一个值（整棵树同时只有
 * 一行可 Tab 到）。子组件只读它决定自己的 tabindex，导航逻辑全在这里。
 *
 * 为什么用 DOM 查询而不是从数据结构算：
 *   * 树是懒加载的（目录展开才拉子项），**渲染出来的行就是"可见行"**，
 *     它们的 DOM 顺序恰好等于 ARIA 树要求的遍历顺序；
 *   * 递归组件里拿不到"扁平化的可见列表"，而 DOM 里天然就有。
 * 每个行元素带 `data-tree-path` / `data-tree-parent` / `data-tree-type`，
 * 由 TreeNode.vue 写上（见那里的 role="treeitem"）。
 *
 * 交互语义按 WAI-ARIA Authoring Practices 的 Tree View：
 *   ↑/↓ 上下移动，→ 展开（已展开则进第一个子项），← 收起（已是收起态则回到父项），
 *   Home/End 首尾，Enter/Space 打开（文件）/展开收起（目录）。
 */

/** 键盘焦点所在的行路径（null = 还没进过树，Tab 进来时落到第一个可见行） */
export const activeTreePath = ref<string | null>(null)

function rowElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-tree-row]'))
}

function pathOf(el: HTMLElement | undefined | null): string | null {
  return el?.dataset.treePath ?? null
}

/** 把键盘焦点移到某一行（同时更新 roving tabindex 的单一真相） */
export function focusTreePath(path: string | null): boolean {
  if (!path) return false
  const el = rowElements().find((r) => r.dataset.treePath === path)
  if (!el) return false
  activeTreePath.value = path
  el.focus()
  return true
}

/** 当前焦点行（不在树里时为 null） */
export function activeRow(): HTMLElement | null {
  const list = rowElements()
  return list.find((r) => r.dataset.treePath === activeTreePath.value) ?? null
}

/** Tab 进树时的落点：优先当前文档那一行，否则第一个可见行 */
export function focusFirstAvailableRow(): boolean {
  const list = rowElements()
  if (!list.length) return false
  const current = list.find((r) => r.dataset.treeCurrent === 'true')
  const fallback =
    current ?? list.find((r) => r.dataset.treePath === activeTreePath.value) ?? list[0]
  return focusTreePath(pathOf(fallback))
}

/** 上下移动（delta = ±1） */
export function moveTreeFocus(delta: number): boolean {
  const list = rowElements()
  if (!list.length) return false
  const idx = list.findIndex((r) => r.dataset.treePath === activeTreePath.value)
  if (idx < 0) return focusFirstAvailableRow()
  const next = list[idx + delta]
  if (!next) return false
  return focusTreePath(pathOf(next))
}

/**
 * 「静息焦点行」：ARIA tree 要求**任何时候都有且只有一个**可 Tab 到的行。
 * 否则用户按 Tab 进来会落在树上但方向键没反应（roving tabindex 的 0 不存在）。
 * 这里只挑选并设置标记、**不抢焦点**（不调 .focus()），所以树渲染完就能安全调用。
 */
export function initRovingFocus(): void {
  const list = rowElements()
  if (!list.length) return
  if (activeTreePath.value && list.some((r) => r.dataset.treePath === activeTreePath.value)) return
  const current = list.find((r) => r.dataset.treeCurrent === 'true')
  activeTreePath.value = pathOf(current ?? list[0])
}

export function focusFirstRow(): boolean {
  return focusTreePath(pathOf(rowElements()[0]))
}

export function focusLastRow(): boolean {
  const list = rowElements()
  return focusTreePath(pathOf(list[list.length - 1]))
}

/** 行是不是已展开的目录（靠 aria-expanded，只有目录才有这个属性） */
function isExpanded(row: HTMLElement): boolean {
  return row.getAttribute('aria-expanded') === 'true'
}

function isDirectory(row: HTMLElement): boolean {
  return row.dataset.treeType === 'directory'
}

/** → ：目录展开；已展开则进第一个子项；文件无操作 */
export function expandOrEnter(): boolean {
  const row = activeRow()
  if (!row) return false
  if (!isDirectory(row)) return false
  if (!isExpanded(row)) {
    row.click()
    return true
  }
  // 子项要等**异步**加载 + 渲染完才在 DOM 里（展开是一次 IPC 读目录），
  // 单次 nextTick 太早 —— 轮询几轮，拿到真正的第一个子行再落焦；
  // 期间用户可能已按别的键，所以每次都重新确认本行仍是活跃行
  const path = row.dataset.treePath
  let tries = 0
  const look = (): void => {
    if (activeTreePath.value !== path) return
    const list = rowElements()
    const i = list.findIndex((r) => r.dataset.treePath === path)
    const child = list[i + 1]
    if (child && child.dataset.treeParent === path) {
      focusTreePath(pathOf(child))
      return
    }
    if (++tries < 10) setTimeout(look, 60)
  }
  setTimeout(look, 30)
  return true
}

/** ← ：目录收起；已收起（或本来就是文件）则回到父项 */
export function collapseOrParent(): boolean {
  const row = activeRow()
  if (!row) return false
  if (isDirectory(row) && isExpanded(row)) {
    row.click()
    return true
  }
  return focusTreePath(row.dataset.treeParent ?? null)
}

/** Enter / Space：打开文件（目录则展开收起） */
export function activateRow(): boolean {
  const row = activeRow()
  if (!row) return false
  row.click()
  return true
}

/** 容器的 keydown 入口：返回 true = 已处理（调用方 preventDefault） */
export function onTreeKeydown(e: KeyboardEvent): boolean {
  // 重命名输入框里打字不能触发树导航
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return false
  switch (e.key) {
    case 'ArrowDown':
      return moveTreeFocus(1)
    case 'ArrowUp':
      return moveTreeFocus(-1)
    case 'ArrowRight':
      return expandOrEnter()
    case 'ArrowLeft':
      return collapseOrParent()
    case 'Home':
      return focusFirstRow()
    case 'End':
      return focusLastRow()
    case 'Enter':
    case ' ':
      return activateRow()
    default:
      return false
  }
}
