<script setup lang="ts">
// ─── 编辑器右键菜单（两级结构）───────────────────────────────────────────────
// 一级：顶部横向常用操作（复制/剪切/粘贴/全选）+ 分类总览（最近使用/表格/段落/格式/插入）
// 二级：鼠标悬停（或 → / 点击）某个分类时，在其右侧弹出该分类的动作列表
// 交互：↑↓ 移动、→/Enter 进入二级、←/Esc 退回一级、Esc 退出、点击外部关闭。
// 组件只渲染 store 给的分区并处理交互，不认识任何编辑器命令。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEditorMenuStore } from '../stores/editorMenu'
import Icon from './Icon.vue'

const { t } = useI18n()
const menu = useEditorMenuStore()
const menuRef = ref<HTMLElement | null>(null)
const subRef = ref<HTMLElement | null>(null)
const catRefs = ref<Record<string, HTMLElement | null>>({})
const pos = ref({ left: 0, top: 0 })
const subPos = ref({ left: 0, top: 0 })

/** 按实测尺寸把菜单钳制在视口内（贴边显示，不溢出） */
function measureAndClamp(): void {
  const el = menuRef.value
  if (!el) return
  // 用 offsetWidth/Height 而不是 getBoundingClientRect：入场动效带 scale，
  // 后者会返回缩放后的尺寸（96%），据此钳制会导致贴边时仍溢出几个像素
  const w = el.offsetWidth
  const h = el.offsetHeight
  const margin = 8
  pos.value = {
    left: Math.max(margin, Math.min(menu.x, window.innerWidth - w - margin)),
    top: Math.max(margin, Math.min(menu.y, window.innerHeight - h - margin))
  }
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
 * 曾经留 2px 空档，配合 mouseleave 立即收起，就出现了「怎么都移不到二级菜单上」。
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
    const w = sub.offsetWidth
    const h = sub.offsetHeight
    const margin = 8
    const flip = panelRect.right + w > window.innerWidth - margin
    subPos.value = {
      left: Math.max(margin, flip ? panelRect.left - w + 1 : panelRect.right - 1),
      top: Math.max(margin, Math.min(row.top - 6, window.innerHeight - h - margin))
    }
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
      cancelCatSwitch()
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
  cancelCatSwitch()
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
 * 指针是否停在一级面板内（用于判断「只是路过某个分类行」还是「真的停在上面」）
 */
function inPanelRect(x: number, y: number): boolean {
  const r = menuRef.value?.getBoundingClientRect()
  if (!r) return false
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

/**
 * 切换分类的「悬停意图」延迟：
 * 二级比一级高，取二级下半段的条目时指针常常要斜向穿过下面几个分类行；若每次路过
 * 都立即切换分类，用户想要的那一项就被换走了 —— 表现出来同样是「移不到二级菜单上」。
 * 因此只有指针真的停在某个分类行上超过 CAT_SWITCH_DELAY 才切换（首次展开不延迟）。
 */
const CAT_SWITCH_DELAY = 180
let switchTimer: ReturnType<typeof setTimeout> | null = null
let switchTarget: { index: number; id: string } | null = null

function cancelCatSwitch(): void {
  if (switchTimer) {
    clearTimeout(switchTimer)
    switchTimer = null
  }
  switchTarget = null
}

/**
 * 指针在安全区内 → 撤销待收起；越出安全区 → 开始宽限计时。
 * 用 pointermove 而不是 mouseleave：mouseleave 只在跨出元素边界的那一瞬触发，
 * 既无法区分「正走向二级」和「真的要离开」，也表达不了「两块合一」的安全区。
 */
function onDocPointerMove(e: PointerEvent): void {
  if (!menu.open) return
  // 离开一级面板就不再是「停在该分类行上」，撤销待切换的分类
  if (!inPanelRect(e.clientX, e.clientY)) cancelCatSwitch()
  if (!menu.activeSectionId) return
  if (inSafeZone(e.clientX, e.clientY)) cancelSubClose()
  else scheduleSubClose()
}

/** 指针进入二级：取消待收起与待切换 */
function onEnterSub(): void {
  cancelCatSwitch()
  cancelSubClose()
}

function onKeydown(e: KeyboardEvent): void {
  if (!menu.open) return
  // 键盘接管后，撤销悬停留下的待切换：否则 Esc 关掉二级后它会被计时器重新打开
  cancelCatSwitch()
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
 * 悬停一级分类：展开其二级菜单（抽成方法，模板里的多语句会被换行拆坏）。
 * 尚未展开、或悬停的正是已展开的分类 → 立即生效；已有其它分类展开 → 延迟切换，
 * 避免指针斜向穿过分类行时把用户要的二级菜单换掉。
 */
function onCategoryHover(index: number, id: string): void {
  cancelSubClose() // 回到一级：撤销上一个分类的待收起
  if (!menu.activeSectionId || menu.activeSectionId === id) {
    cancelCatSwitch()
    menu.setActive(index)
    menu.openSection(id)
    return
  }
  if (switchTarget && switchTarget.id === id && switchTarget.index === index) return
  cancelCatSwitch()
  switchTarget = { index, id }
  switchTimer = setTimeout(() => {
    switchTimer = null
    const target = switchTarget
    switchTarget = null
    if (!target || !menu.open) return
    menu.setActive(target.index)
    menu.openSection(target.id)
  }, CAT_SWITCH_DELAY)
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
        class="ecm-panel fixed z-[170] select-none"
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
        class="ecm-panel ecm-sub fixed z-[171] select-none"
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
