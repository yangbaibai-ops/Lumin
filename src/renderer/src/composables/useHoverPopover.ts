/**
 * ─── 工具栏按钮的「悬停弹层」通用件（审计 §10 P1「重复实现：popover 2 份」）────────
 *
 * 此前 `ToolbarCodeBlockButton.vue` 与 `ToolbarTableButton.vue` 各写了一份**逐字相同**的
 * 开合时序（300ms 打开 / 180ms 关闭宽限、按钮与弹层之间互不移出）与定位代码，
 * 差别只有"要不要按弹层宽度做右侧钳制"。重复的代价不是难看，而是**改一处忘一处**：
 * 延迟、宽限、边距这类手感参数一旦不一致，用户会觉得"两个按钮行为不一样"。
 *
 * 落点计算做成**纯函数**（`planPopoverPos`），时序做成这个 composable ——
 * 于是"窄窗口下别溢出"这条规则只需要在一处测。
 *
 * ⚠️ 这里 import `menuPlacement` 时写了显式 `.ts`：本模块会被 `tests/hoverPopover.test.mjs`
 * 直接加载（Node 原生 ESM 不做扩展名补全），与 `src/renderer/src/lib/findReplace.ts`
 * 那个再导出 shim 同一口径。
 */
import { ref, type Ref } from 'vue'
import { MENU_MARGIN, placeAtPoint } from '../lib/menuPlacement.ts'

export interface HoverPopoverOptions {
  /** 弹层宽度：给了就按视口做右侧钳制（工具栏可横向滚动，按钮可能贴近右边缘） */
  width?: number
  /** 悬停多久才打开（ms） */
  openDelay?: number
  /** 移开后多久关闭（ms，给指针从按钮走到弹层的宽限） */
  closeDelay?: number
  /** 弹层与按钮底边的间距（px） */
  gap?: number
  /** 视口边距（px） */
  margin?: number
}

export const POPOVER_OPEN_DELAY = 300
export const POPOVER_CLOSE_DELAY = 180
export const POPOVER_GAP = 8

/**
 * 弹层落点（纯函数）：默认贴在按钮左缘下方 `gap` 像素；给了 `width` 就把整体夹进视口，
 * 窄窗口下不会溢出右边缘。
 */
export function planPopoverPos(
  anchor: { left: number; bottom: number },
  viewport: { width: number; height: number },
  options: HoverPopoverOptions = {}
): { x: number; y: number } {
  const gap = options.gap ?? POPOVER_GAP
  const y = anchor.bottom + gap
  if (options.width === undefined) return { x: anchor.left, y }
  const p = placeAtPoint(
    anchor.left,
    y,
    { width: options.width, height: 0 },
    viewport,
    options.margin ?? MENU_MARGIN
  )
  // 高度为 0 时 placeAtPoint 的纵向钳制对 y 无意义（它只知道宽度），所以只取横向结果
  return { x: p.left, y }
}

export interface HoverPopover {
  open: Ref<boolean>
  pos: Ref<{ x: number; y: number }>
  /** 按钮 `mouseenter`：延时打开 */
  onButtonEnter: () => void
  /** 弹层 `mouseenter`：取消关闭计时 */
  onPopoverEnter: () => void
  /** 离开按钮/弹层：延时关闭（宽限期内回来就不关） */
  scheduleClose: () => void
  /** 立刻打开（键盘路径：Enter/Space 时不该等 300ms） */
  openNow: () => void
  /** 清掉两个计时器（组件卸载时必须调用） */
  cancelTimers: () => void
}

export function useHoverPopover(
  btnRef: Ref<HTMLElement | null>,
  options: HoverPopoverOptions = {}
): HoverPopover {
  const openDelay = options.openDelay ?? POPOVER_OPEN_DELAY
  const closeDelay = options.closeDelay ?? POPOVER_CLOSE_DELAY

  const open = ref(false)
  const pos = ref({ x: 0, y: 0 })
  let openTimer: ReturnType<typeof setTimeout> | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  function cancelTimers(): void {
    if (openTimer) {
      clearTimeout(openTimer)
      openTimer = null
    }
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  function openNow(): void {
    const rect = btnRef.value?.getBoundingClientRect()
    if (!rect) return
    pos.value = planPopoverPos(
      { left: rect.left, bottom: rect.bottom },
      { width: window.innerWidth, height: window.innerHeight },
      options
    )
    open.value = true
  }

  function onButtonEnter(): void {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    openTimer = setTimeout(openNow, openDelay)
  }

  function onPopoverEnter(): void {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  function scheduleClose(): void {
    if (openTimer) {
      clearTimeout(openTimer)
      openTimer = null
    }
    closeTimer = setTimeout(() => {
      closeTimer = null
      open.value = false
    }, closeDelay)
  }

  return { open, pos, onButtonEnter, onPopoverEnter, scheduleClose, openNow, cancelTimers }
}
