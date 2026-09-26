<script setup lang="ts">
// ─── 编辑器右键菜单（两级结构）───────────────────────────────────────────────
// 一级：顶部横向常用操作（复制/剪切/粘贴/全选）+ 分类总览（最近使用/表格/段落/格式/插入）
// 二级：鼠标悬停（或 → / 点击）某个分类时，在其右侧弹出该分类的动作列表
// 交互：↑↓ 移动、→/Enter 进入二级、←/Esc 退回一级、Esc 退出、点击外部关闭。
// 组件只渲染 store 给的分区并处理交互，不认识任何编辑器命令。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEditorMenuStore } from '../stores/editorMenu'
import { placeAtPoint, placeSubmenu } from '../lib/menuPlacement'
import Icon from './Icon.vue'

const { t } = useI18n()
const menu = useEditorMenuStore()
const menuRef = ref<HTMLElement | null>(null)
const subRef = ref<HTMLElement | null>(null)
const catRefs = ref<Record<string, HTMLElement | null>>({})
const pos = ref({ left: 0, top: 0 })
const subPos = ref({ left: 0, top: 0 })

/** 按实测尺寸把菜单钳制在视口内（贴边显示，不溢出）——几何在 lib/menuPlacement（三处共用） */
function measureAndClamp(): void {
  const el = menuRef.value
  if (!el) return
  // 用 offsetWidth/Height 而不是 getBoundingClientRect：入场动效带 scale，
  // 后者会返回缩放后的尺寸（96%），据此钳制会导致贴边时仍溢出几个像素
  pos.value = placeAtPoint(
    menu.x,
    menu.y,
    { width: el.offsetWidth, height: el.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight }
  )
}

async function place(): Promise<void> {
  await nextTick()
  measureAndClamp()
  requestAnimationFrame(measureAndClamp)
}

/**
 * 二级菜单定位：贴在一级面板右侧，**不留缝隙**（重叠 1px），右侧放不下则翻到左侧。
 * 贴死是「指针一定移得进二级」的第一道保障：两块之间不留任何空隙，安全区（见
 * inSafeZone）才是一个连通区域，指针从分类行走向二级的全程都被视为「还在菜单上」。
 * 曾经留 2px 空档，配合 mouseleave 立即收起，就出现了「怎么都移不到二级菜单上」——
 * 这条规则现在三处共用（`lib/menuPlacement` 的 SUBMENU_OVERLAP）。
 */
async function placeSub(): Promise<void> {
  await nextTick()
  const cat = menu.activeSectionId ? catRefs.value[menu.activeSectionId] : null
  const panel = menuRef.value
  const sub = subRef.value
  if (!cat || !panel || !sub) return
  const compute = (): void => {
    const row = cat.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    subPos.value = placeSubmenu({
      parentLeft: panelRect.left,
      parentRight: panelRect.right,
      rowTop: row.top,
      size: { width: sub.offsetWidth, height: sub.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    })
  }
  compute()
  // 补一帧：二级内容换行/字体就绪后尺寸可能变化
  requestAnimationFrame(compute)
}

watch(
  () => menu.open,
  async (open) => {
    if (!open) {
      cancelSubClose()
      return
    }
    pos.value = { left: menu.x, top: menu.y }
    await place()
    menuRef.value?.focus()
  }
)

watch(
  () => menu.activeSectionId,
  (id) => {
    if (!id) return
    cancelSubClose() // 刚展开的二级不该被上一段悬停留下的计时器收掉
    void placeSub()
  }
)

function onDocMouseDown(e: MouseEvent): void {
  if (!menu.open) return
  const target = e.target as Node
  if (menuRef.value?.contains(target)) return
  if (subRef.value?.contains(target)) return
  menu.close()
}

/**
 * 滚动时关闭菜单（锚点位置的语义会失效），但**菜单内部滚动不关闭**：
 * 监听挂在 window 的捕获阶段，若不排除菜单自身，滚动二级列表就会把菜单关掉。
 */
function onScrollCapture(e: Event): void {
  if (!menu.open) return
  const target = e.target as Node | null
  if (target && (menuRef.value?.contains(target) || subRef.value?.contains(target))) return
  menu.close()
}
function onResize(): void {
  if (menu.open) menu.close()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onScrollCapture, true)
  window.addEventListener('pointermove', onDocPointerMove, true)
})
onBeforeUnmount(() => {
  cancelSubClose()
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', onScrollCapture, true)
  window.removeEventListener('pointermove', onDocPointerMove, true)
})

/**
 * 收起二级菜单的「悬停意图」宽限：
 * 二级比一级高（一级 159px、二级可达 299px），下半段挂在面板下方；指针从分类行移向
 * 二级下半段时常常先向下、再向右，中途会短暂处于「既不在面板、也不在二级」的位置。
 * 宽限用于兜住这类越界：短暂越界不收起，持续越界才收起。
 */
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
    menu.closeSection()
  }, SUB_CLOSE_DELAY)
}

/**
 * 安全区：一级面板与二级菜单的整体外接矩形（外扩几像素）。
 * 不能只判断「是否在面板内、是否在二级内」——两矩形之间（尤其是面板下方、二级左侧
 * 那块）属于两者的补集，指针经过时会被判为「离开」，二级随即消失，用户表现为
 * 「怎么都移不到二级菜单上」。用外接矩形把两块之间的通路一并纳入，任何从一级
 * 走向二级的路径都不会触发收起。
 */
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

/**
 * 指针在安全区内 → 撤销待收起；越出安全区 → 开始宽限计时。
 * 用 pointermove 而不是 mouseleave：mouseleave 只在跨出元素边界的那一瞬触发，
 * 既无法区分「正走向二级」和「真的要离开」，也表达不了「两块合一」的安全区。
 */
function onDocPointerMove(e: PointerEvent): void {
  if (!menu.open || !menu.activeSectionId) return
  if (inSafeZone(e.clientX, e.clientY)) cancelSubClose()
  else scheduleSubClose()
}

/** 指针进入二级：取消待收起 */
function onEnterSub(): void {
  cancelSubClose()
}

function onKeydown(e: KeyboardEvent): void {
  if (!menu.open) return
  const inSub = !!menu.activeSectionId
  if (e.key === 'Escape') {
    e.preventDefault()
    if (inSub) menu.closeSection()
    else menu.close()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (inSub) menu.moveSubActive(1)
    else menu.moveActive(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (inSub) menu.moveSubActive(-1)
    else menu.moveActive(-1)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    if (!inSub) menu.openSection(menu.categories[menu.activeIndex]?.id ?? '')
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    if (inSub) menu.closeSection()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (inSub) void menu.runSubActive()
    else menu.openSection(menu.categories[menu.activeIndex]?.id ?? '')
  }
}

/**
 * 悬停一级分类：立即展开其二级菜单（抽成方法，模板里的多语句会被换行拆坏）。
 * 与主流系统菜单一致：**悬停即切换、零延迟**（早先为「防止斜穿分类行把二级换掉」
 * 加过 180ms 悬停意图延迟，实测手感明显发木，已移除）。
 * 斜穿分类行时二级会跟着指针换到那条分类上——这正是系统菜单的行为；而「移不到
 * 二级菜单上」由安全区（面板 ∪ 二级的外接矩形）+ 收起宽限保证，与本函数无关。
 */
function onCategoryHover(index: number, id: string): void {
  cancelSubClose() // 回到一级：撤销上一个分类的待收起
  menu.setActive(index)
  menu.openSection(id)
}

const panelStyle = computed(() => ({ left: `${pos.value.left}px`, top: `${pos.value.top}px` }))
const subStyle = computed(() => ({ left: `${subPos.value.left}px`, top: `${subPos.value.top}px` }))
</script>

<template>
  <Teleport to="body">
    <Transition name="ecm">
      <div
        v-if="menu.open"
        ref="menuRef"
        class="ecm-panel fixed z-[var(--z-editor-menu)] select-none"
        :style="panelStyle"
        tabindex="-1"
        role="menu"
        @keydown="onKeydown"
        @contextmenu.prevent
      >
        <!-- 顶部：横向常用操作 -->
        <div
          v-if="menu.toolbarSection"
          class="flex items-center gap-0.5 border-b border-edge/70 p-1.5"
        >
          <button
            v-for="item in menu.toolbarSection.items"
            :key="item.id"
            class="ecm-tool"
            :disabled="item.disabled"
            :title="t(item.labelKey)"
            @click="menu.run(item)"
          >
            <Icon :name="item.icon || 'dot'" :size="16" />
            <span>{{ t(item.labelKey) }}</span>
          </button>
        </div>

        <!-- 一级：分类总览（自身即滚动容器：滚轮在菜单内被消化，不会滚到下方文档
             而把菜单关掉；overscroll-contain 见 style.css） -->
        <div class="ecm-cats p-1.5">
          <button
            v-for="(section, index) in menu.categories"
            :key="section.id"
            :ref="(el) => (catRefs[section.id] = el as HTMLElement | null)"
            class="ecm-item"
            :class="[
              index === menu.activeIndex ? 'is-active' : '',
              section.id === menu.activeSectionId ? 'is-open' : ''
            ]"
            @mouseenter="onCategoryHover(index, section.id)"
            @click="menu.openSection(section.id)"
          >
            <span class="flex-1 truncate">{{ section.labelKey ? t(section.labelKey) : '' }}</span>
            <Icon name="chevron-right" :size="13" class="ecm-caret" />
          </button>
        </div>

        <!-- 底部：清除最近使用（仅当有记录时出现） -->
        <div v-if="menu.recentIds.length" class="border-t border-edge/70 px-1.5 py-1">
          <button class="ecm-foot" @click="menu.clearUsage()">
            <Icon name="trash" :size="13" />
            <span>{{ t('editorMenu.clearRecent') }}</span>
          </button>
        </div>
      </div>
    </Transition>

    <!-- 二级菜单：独立浮层（不放在面板内，避免被一级的滚动/裁剪影响） -->
    <Transition name="ecm-sub">
      <div
        v-if="menu.open && menu.activeSection"
        ref="subRef"
        class="ecm-panel ecm-sub fixed z-[var(--z-editor-menu-sub)] select-none"
        :style="subStyle"
        role="menu"
        @mouseenter="onEnterSub"
        @contextmenu.prevent
      >
        <p v-if="menu.activeSection.labelKey" class="ecm-section">
          {{ t(menu.activeSection.labelKey) }}
        </p>
        <div class="p-1.5 pt-0">
          <button
            v-for="(item, index) in menu.activeSectionItems"
            :key="item.id"
            class="ecm-item"
            :class="[
              item.danger ? 'is-danger' : '',
              index === menu.activeSubIndex ? 'is-active' : ''
            ]"
            :disabled="item.disabled"
            @click="menu.run(item)"
            @mouseenter="menu.setSubActive(index)"
          >
            <Icon :name="item.icon || 'dot'" :size="14" class="ecm-icon" />
            <span class="flex-1 truncate">{{ t(item.labelKey) }}</span>
            <span v-if="item.shortcut" class="ecm-key">{{ item.shortcut }}</span>
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
