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
const subRefs = ref<Record<number, HTMLElement | null>>({})
const pos = ref({ left: 0, top: 0 })
const subPos = ref({ left: 0, top: 0 })
/** 已展开的条目下标（null = 无子菜单展开） */
const openIndex = ref<number | null>(null)

// ─── 键盘状态（详见下方 onMenuKeydown）──────────────────────────────────────
/** 一级面板的键盘高亮（与"展开了哪一项"分开：普通条目也能被高亮） */
const cursorIndex = ref<number | null>(null)
/** 二级子菜单的键盘高亮 */
const subCursor = ref<number | null>(null)
/** 打开菜单前的焦点元素（关闭后归还给它，否则键盘用户会掉到 body 上） */
let restoreFocusTo: HTMLElement | null = null

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
    cursorIndex.value = null
    subCursor.value = null
    if (!c) return
    pos.value = { left: c.x, top: c.y }
    // 记住唤起菜单时的焦点元素，关闭后归还（见 closeAndRestore 的说明）
    restoreFocusTo = (document.activeElement as HTMLElement | null) ?? null
    void place()
    // 焦点进菜单：面板自身可聚焦（tabindex=-1），这样 ↑↓/Esc 才收得到
    requestAnimationFrame(() => menuRef.value?.focus())
  }
)

// 键盘高亮跟随（长菜单要滚动跟住光标；高亮本身由 cursorIndex / subCursor 驱动）
watch(cursorIndex, (i) => {
  if (i === null) return
  rowRefs.value[i]?.scrollIntoView({ block: 'nearest' })
})

// 子菜单高亮同理（子菜单可能高于视口，长列表要靠它跟住光标）
watch(subCursor, (i) => {
  if (i === null) return
  subRefs.value[i]?.scrollIntoView({ block: 'nearest' })
})

watch(openIndex, (idx) => {
  if (idx === null) {
    subCursor.value = null
    return
  }
  cancelSubClose()
  void placeSub()
  // 展开即把二级高亮放到第一个可选项：→ 之后直接按回车就能执行（无需先 ↓）
  const children = ui.contextMenu?.items[idx]?.children?.() ?? []
  subCursor.value = enabledIndexes(children)[0] ?? null
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
  closeAndRestore()
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
  closeAndRestore()
  handler?.(item.action)
}

// ─── 键盘可达（审计 §8：「重命名 / 删除只能鼠标」）────────────────────────────
// 菜单此前只有 `role="menu"` / `role="menuitem"` 的语义，却没有任何键盘路径：
// 打开时焦点不进菜单、方向键/回车不生效、关闭后焦点也不归还。
// 这里的口径与系统菜单一致：↑↓ 在可选项之间移动、→ 展开子菜单并把高亮交给它、
// ← 退回一级、Enter/Space 激活、Esc 关闭并把焦点还给触发元素。
//
// 为什么焦点始终留在**一级面板**、二级只记下标：
// 两级是各自独立的浮层，来回搬 DOM 焦点会带来一串边界情况（子菜单重渲染、
// 焦点落在被移除的节点上、Tab 顺序被破坏）；由面板统一收键、用两个下标记状态，
// 既满足 WAI-ARIA menu 模式的按键口径，又只有一条焦点路径。

/** 可选项的下标（跳过 disabled —— 键盘不该停在灰掉的条目上） */
function enabledIndexes(list: ContextMenuItem[]): number[] {
  return list.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0)
}

/** 在可选下标集合里按 delta 环绕走一步（还没高亮时：↓ 取首个、↑ 取末个） */
function step(enabled: number[], cur: number | null, delta: number): number | null {
  if (!enabled.length) return null
  if (cur === null || !enabled.includes(cur))
    return delta > 0 ? enabled[0] : enabled[enabled.length - 1]
  const at = enabled.indexOf(cur)
  return enabled[(at + delta + enabled.length) % enabled.length]
}

/** ↑↓ 在一级面板里移动高亮（环绕） */
function moveCursor(delta: number): void {
  const list = ui.contextMenu?.items ?? []
  const next = step(enabledIndexes(list), cursorIndex.value, delta)
  if (next === null) return
  cursorIndex.value = next
  // 高亮落到带子菜单的条目上就顺手展开（与鼠标悬停同一套行为），否则收起旧的二级
  openIndex.value = list[next]?.children ? next : null
}

/** ↑↓ 在已展开的子菜单里移动高亮（环绕） */
function moveSubCursor(delta: number): void {
  subCursor.value = step(enabledIndexes(subItems.value), subCursor.value, delta)
}

function closeAndRestore(): void {
  ui.closeContextMenu()
  // 归还焦点：菜单是从键盘/鼠标唤起的，关闭后应当回到触发它的那个元素上
  const el = restoreFocusTo
  restoreFocusTo = null
  if (el && document.contains(el)) el.focus?.()
}

function onMenuKeydown(e: KeyboardEvent): void {
  const list = ui.contextMenu?.items ?? []
  const inSub = openIndex.value !== null
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      if (inSub) moveSubCursor(1)
      else moveCursor(1)
      break
    case 'ArrowUp':
      e.preventDefault()
      if (inSub) moveSubCursor(-1)
      else moveCursor(-1)
      break
    case 'ArrowRight': {
      // → 只对"有子菜单"的条目有效；已在子菜单里则不动
      if (inSub) break
      const i = cursorIndex.value
      if (i !== null && list[i]?.children) {
        e.preventDefault()
        openIndex.value = i
      }
      break
    }
    case 'ArrowLeft':
      // ← 退回一级（子菜单未展开时是空操作，焦点本来就在面板上）
      if (inSub) {
        e.preventDefault()
        cancelSubClose()
        openIndex.value = null
      }
      break
    case 'Enter':
    case ' ': {
      e.preventDefault()
      if (inSub) {
        const sub = subCursor.value === null ? null : subItems.value[subCursor.value]
        if (sub) pickSub(sub)
        break
      }
      const item = cursorIndex.value === null ? null : list[cursorIndex.value]
      if (!item) break
      if (item.children) openIndex.value = cursorIndex.value
      else pick(item)
      break
    }
    case 'Escape':
      e.preventDefault()
      closeAndRestore()
      break
  }
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
       验收脚本与读屏器都靠它，而不是靠 Tailwind 生成的那条 z-index 类名（现在是 `--z-critical`） -->
  <Teleport to="body">
    <Transition name="pop">
      <div
        v-if="ui.contextMenu"
        ref="menuRef"
        class="fixed z-[var(--z-critical)] min-w-[172px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl outline-none"
        role="menu"
        tabindex="-1"
        :aria-label="ui.contextMenu.ariaLabel ?? undefined"
        :style="panelStyle"
        @keydown="onMenuKeydown"
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
              index === openIndex || index === cursorIndex ? 'bg-panel-2' : ''
            ]"
            role="menuitem"
            tabindex="-1"
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
        class="fixed z-[var(--z-critical-sub)] min-w-[168px] max-w-[260px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
        :style="subStyle"
        role="menu"
        aria-label="submenu"
      >
        <button
          v-for="(sub, si) in subItems"
          :key="sub.action"
          :ref="(el) => (subRefs[si] = el as HTMLElement | null)"
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui text-ink transition-colors duration-100 hover:bg-panel-2"
          :class="[
            sub.disabled ? 'cursor-default opacity-40' : '',
            si === subCursor ? 'bg-panel-2' : ''
          ]"
          :role="sub.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
          tabindex="-1"
          :aria-checked="sub.checked === undefined ? undefined : sub.checked"
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
