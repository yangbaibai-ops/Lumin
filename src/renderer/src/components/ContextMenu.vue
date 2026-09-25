<script setup lang="ts">
// ─── 通用右键菜单（文件树 / 工具栏空白区等）──────────────────────────────────
// 数据全部来自 ui.contextMenu：位置 + 条目 + onSelect 回调，组件本身不认识任何业务。
//
// 两级结构（可选）：条目带 `children` 时右侧出现 ›，悬停或 → 展开子菜单。
// 子菜单是**独立浮层**（不放在一级面板里），避免被面板的滚动/裁剪影响——
// 与编辑器右键菜单（EditorContextMenu.vue）同一套做法，包括「贴死不留缝」
// 的安全区判定：两块之间不留空隙，指针从一级走向二级的全程都算「还在菜单上」。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUiStore, type ContextMenuItem } from '../stores/ui'
import Icon from './Icon.vue'

const ui = useUiStore()
const menuRef = ref<HTMLElement | null>(null)
const subRef = ref<HTMLElement | null>(null)
const rowRefs = ref<Record<number, HTMLElement | null>>({})
const pos = ref({ left: 0, top: 0 })
const subPos = ref({ left: 0, top: 0 })
/** 已展开的条目下标（null = 无子菜单展开） */
const openIndex = ref<number | null>(null)

const items = computed<ContextMenuItem[]>(() => ui.contextMenu?.items ?? [])

/** 按实测尺寸把菜单钳制在视口内（贴边显示，不溢出） */
function measureAndClamp(): void {
  const el = menuRef.value
  if (!el) return
  const c = ui.contextMenu
  if (!c) return
  // 用 offsetWidth/Height 而不是 getBoundingClientRect：入场动效带 scale，
  // 后者返回的是缩放后的尺寸（96%），据此钳制会导致贴边时仍溢出几个像素
  const margin = 8
  pos.value = {
    left: Math.max(margin, Math.min(c.x, window.innerWidth - el.offsetWidth - margin)),
    top: Math.max(margin, Math.min(c.y, window.innerHeight - el.offsetHeight - margin))
  }
}

async function place(): Promise<void> {
  await nextTick()
  measureAndClamp()
  requestAnimationFrame(measureAndClamp)
}

/** 子菜单定位：贴在一级面板右侧（重叠 1px），右侧放不下则翻到左侧 */
async function placeSub(): Promise<void> {
  await nextTick()
  const idx = openIndex.value
  const row = idx === null ? null : rowRefs.value[idx]
  const panel = menuRef.value
  const sub = subRef.value
  if (idx === null || !row || !panel || !sub) return
  const compute = (): void => {
    const rowRect = row.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const w = sub.offsetWidth
    const h = sub.offsetHeight
    const margin = 8
    const flip = panelRect.right + w > window.innerWidth - margin
    subPos.value = {
      left: Math.max(margin, flip ? panelRect.left - w + 1 : panelRect.right - 1),
      top: Math.max(margin, Math.min(rowRect.top - 6, window.innerHeight - h - margin))
    }
  }
  compute()
  // 补一帧：子菜单换行/字体就绪后尺寸可能变化
  requestAnimationFrame(compute)
}

watch(
  () => ui.contextMenu,
  (c) => {
    openIndex.value = null
    if (!c) return
    pos.value = { left: c.x, top: c.y }
    void place()
  }
)

watch(openIndex, (idx) => {
  if (idx === null) return
  cancelSubClose()
  void placeSub()
})

// ─── 子菜单的「悬停意图」宽限与安全区（与 EditorContextMenu 同一套判据）──────
// 子菜单可能比一级高（挂在面板下方），指针从条目移向子菜单下半段时常常先向下、
// 再向右，中途会短暂处于「既不在面板、也不在子菜单」的位置——宽限兜住这类越界。
const SUB_CLOSE_DELAY = 160
let closeTimer: ReturnType<typeof setTimeout> | null = null

function cancelSubClose(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}
function scheduleSubClose(): void {
  cancelSubClose()
  closeTimer = setTimeout(() => {
    closeTimer = null
    openIndex.value = null
  }, SUB_CLOSE_DELAY)
}

/** 安全区 = 一级面板与子菜单的整体外接矩形（外扩几像素），保证两级之间是连通的 */
function inSafeZone(x: number, y: number): boolean {
  const panel = menuRef.value
  if (!panel) return false
  const a = panel.getBoundingClientRect()
  const b = subRef.value?.getBoundingClientRect() ?? a
  const slack = 4
  return (
    x >= Math.min(a.left, b.left) - slack &&
    x <= Math.max(a.right, b.right) + slack &&
    y >= Math.min(a.top, b.top) - slack &&
    y <= Math.max(a.bottom, b.bottom) + slack
  )
}

function onDocPointerMove(e: PointerEvent): void {
  if (!ui.contextMenu || openIndex.value === null) return
  if (inSafeZone(e.clientX, e.clientY)) cancelSubClose()
  else scheduleSubClose()
}

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node
  if (menuRef.value?.contains(target)) return
  if (subRef.value?.contains(target)) return
  ui.closeContextMenu()
}
function onResize(): void {
  ui.closeContextMenu()
}
/** 滚动时关闭（锚点位置的语义会失效），但菜单内部滚动不关闭 */
function onScrollCapture(e: Event): void {
  const target = e.target as Node | null
  if (target && (menuRef.value?.contains(target) || subRef.value?.contains(target))) return
  ui.closeContextMenu()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick, true)
  document.addEventListener('pointermove', onDocPointerMove, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onScrollCapture, true)
})
onBeforeUnmount(() => {
  cancelSubClose()
  document.removeEventListener('mousedown', onDocClick, true)
  document.removeEventListener('pointermove', onDocPointerMove, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', onScrollCapture, true)
})

function pick(item: ContextMenuItem): void {
  if (item.disabled) return
  // 带子菜单的条目只负责展开，不触发业务回调
  if (item.children) return
  const handler = ui.contextMenu?.onSelect
  ui.closeContextMenu()
  handler?.(item.action)
}

/** 展开/收起某个条目的子菜单 */
function toggleSub(index: number, item: ContextMenuItem): void {
  if (!item.children) {
    // 无子菜单：指针走过时收起上一个展开项（系统菜单的常规行为）
    if (openIndex.value !== null) scheduleSubClose()
    return
  }
  cancelSubClose()
  openIndex.value = index
}

/** 子菜单条目：执行后关掉整个菜单 */
function pickSub(item: ContextMenuItem): void {
  if (item.disabled) return
  if (item.children) return
  const handler = ui.contextMenu?.onSelect
  ui.closeContextMenu()
  handler?.(item.action)
}

/** 当前展开条目的子菜单内容（惰性求值，拿到最新勾选态） */
const subItems = computed<ContextMenuItem[]>(() => {
  const idx = openIndex.value
  if (idx === null || !ui.contextMenu) return []
  return ui.contextMenu.items[idx]?.children?.() ?? []
})

const panelStyle = computed(() => ({
  left: `${pos.value.left}px`,
  top: `${pos.value.top}px`,
  boxShadow: 'var(--shadow-2)'
}))
const subStyle = computed(() => ({
  left: `${subPos.value.left}px`,
  top: `${subPos.value.top}px`,
  boxShadow: 'var(--shadow-2)'
}))
</script>

<template>
  <!-- role=menu + aria-label 是工具栏右键菜单的定位锚点：
       验收脚本与读屏器都靠它，而不是靠 Tailwind 生成的 z-[160] 类名 -->
  <Teleport to="body">
    <Transition name="pop">
      <div
        v-if="ui.contextMenu"
        ref="menuRef"
        class="fixed z-[160] min-w-[172px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
        role="menu"
        :aria-label="ui.contextMenu.ariaLabel ?? undefined"
        :style="panelStyle"
      >
        <template v-for="(item, index) in items" :key="item.action">
          <button
            :ref="(el) => (rowRefs[index] = el as HTMLElement | null)"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100"
            :class="[
              item.danger
                ? 'text-danger hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]'
                : 'text-ink hover:bg-panel-2',
              item.disabled ? 'cursor-default opacity-40' : '',
              index === openIndex ? 'bg-panel-2' : ''
            ]"
            role="menuitem"
            :aria-haspopup="item.children ? 'menu' : undefined"
            :aria-expanded="item.children ? index === openIndex : undefined"
            :disabled="item.disabled"
            @mouseenter="toggleSub(index, item)"
            @click="pick(item)"
          >
            <!-- 勾选位：固定宽度，勾/图标/无 三态都对齐 -->
            <span class="flex h-4 w-4 flex-none items-center justify-center">
              <Icon v-if="item.checked" name="check" :size="13" class="text-accent" />
              <Icon v-else-if="item.icon" :name="item.icon" :size="14" />
            </span>
            <span class="flex-1">{{ item.label }}</span>
            <Icon
              v-if="item.children"
              name="chevron-right"
              :size="13"
              class="flex-none text-ink-2b"
            />
          </button>
        </template>
      </div>
    </Transition>

    <!-- 子菜单：独立浮层 -->
    <Transition name="pop">
      <div
        v-if="ui.contextMenu && openIndex !== null && subItems.length"
        ref="subRef"
        class="fixed z-[161] min-w-[168px] max-w-[260px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
        :style="subStyle"
        role="menu"
        aria-label="submenu"
      >
        <button
          v-for="sub in subItems"
          :key="sub.action"
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-100 hover:bg-panel-2"
          :class="sub.disabled ? 'cursor-default opacity-40' : ''"
          role="menuitemcheckbox"
          :aria-checked="sub.checked"
          :disabled="sub.disabled"
          @click="pickSub(sub)"
        >
          <span class="flex h-4 w-4 flex-none items-center justify-center">
            <Icon v-if="sub.checked" name="check" :size="13" class="text-accent" />
            <Icon v-else-if="sub.icon" :name="sub.icon" :size="13" class="text-ink-3" />
          </span>
          <span class="flex-1 truncate">{{ sub.label }}</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
