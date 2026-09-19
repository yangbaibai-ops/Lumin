<script setup lang="ts">
// ─── 表格插入按钮：点击默认 3×3，悬停弹出 WPS 式行列选择器 ───────────────────
// 交互约定（与 WPS/Office 一致）：
//  - 直接点击按钮 → 立即插入默认 3×3 表格（表头行 + 2 数据行）；
//  - 悬停按钮 ~300ms → 弹出网格选择器，以左上角为 1×1，悬停高亮 r×c；
//  - 点击格子 → 插入对应尺寸；弹出状态下点击按钮仅收起选择器。
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEditorStore } from '../stores/editor'
import { shouldCloseOnScrollOrResize } from '../lib/popoverClose'
import Icon from './Icon.vue'

const { t } = useI18n()
const editorStore = useEditorStore()

// 模板有两个根节点（按钮容器 + Teleport 到 body 的弹层），属性无法自动继承。
// 工具栏给本组件打了 `data-toolbar-item`（它靠这个属性判断「右键落在项目上」），
// 所以关掉自动继承、手动挂到按钮容器上——否则 Vue 每次都警告，且右键会被当成空白区。
defineOptions({ inheritAttrs: false })

const MAX_ROWS = 8
const MAX_COLS = 10

const btnRef = ref<HTMLElement | null>(null)
const open = ref(false)
const popPos = ref({ x: 0, y: 0 })
const hoverR = ref(2)
const hoverC = ref(2)

const rowIdx = computed(() => Array.from({ length: MAX_ROWS }, (_, i) => i))
const colIdx = computed(() => Array.from({ length: MAX_COLS }, (_, i) => i))

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

/** 弹出选择器：Teleport 到 body 固定定位（工具栏 overflow 裁剪会吃掉常规弹层） */
function showPopover(): void {
  const rect = btnRef.value?.getBoundingClientRect()
  if (!rect) return
  popPos.value = { x: rect.left, y: rect.bottom + 8 }
  open.value = true
}

function onButtonEnter(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  openTimer = setTimeout(showPopover, 300)
}

function scheduleClose(): void {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  closeTimer = setTimeout(() => {
    open.value = false
  }, 180)
}

function onPopoverEnter(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}

/** 滚动/缩放收起：弹层内部滚动不收起（见 lib/popoverClose.ts） */
function onWindowScrollOrResize(e: Event): void {
  if (!open.value) return
  if (!shouldCloseOnScrollOrResize(e, btnRef.value)) return
  open.value = false
}

function insertTable(rows: number, cols: number): void {
  open.value = false
  cancelTimers()
  const ed = editorStore.instance
  if (!ed) return
  const opts = { rows, cols, withHeaderRow: true }
  // 当前选区被表格/代码块等原子容器包裹时，insertTable 会因 schema 拒绝
  // 而静默失败（can() 恒为 true，检测不到）——此时落到文档末尾插入
  const { $from } = ed.state.selection
  let blocked = false
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'table' || name === 'codeBlock') {
      blocked = true
      break
    }
  }
  if (blocked) {
    ed.chain().focus('end').insertTable(opts).run()
    return
  }
  ed.chain().focus().insertTable(opts).run()
}

function onButtonClick(): void {
  if (open.value) {
    open.value = false
    return
  }
  insertTable(3, 3)
}

function onCellEnter(r: number, c: number): void {
  hoverR.value = r
  hoverC.value = c
}

onBeforeUnmount(() => {
  cancelTimers()
  window.removeEventListener('scroll', onWindowScrollOrResize, true)
  window.removeEventListener('resize', onWindowScrollOrResize)
})
window.addEventListener('scroll', onWindowScrollOrResize, true)
window.addEventListener('resize', onWindowScrollOrResize)
</script>

<template>
  <div ref="btnRef" v-bind="$attrs" class="relative shrink-0" @mouseleave="scheduleClose">
    <button
      class="icon-btn"
      :class="{ active: open }"
      :title="t('editor.table')"
      @click="onButtonClick"
      @mouseenter="onButtonEnter"
    >
      <Icon name="table" :size="15" />
    </button>
  </div>

  <Teleport to="body">
    <Transition name="pop">
      <div
        v-if="open"
        class="table-size-popover fixed z-[100] rounded-xl border border-edge bg-elevate p-3"
        :style="{ boxShadow: 'var(--shadow-2)', left: popPos.x + 'px', top: popPos.y + 'px' }"
        @mouseenter="onPopoverEnter"
        @mouseleave="scheduleClose"
      >
        <div class="mb-2 text-[12px] text-ink-2">
          {{ t('editor.tableSize', { rows: hoverR + 1, cols: hoverC + 1 }) }}
        </div>
        <div v-for="r in rowIdx" :key="r" class="flex gap-1">
          <button
            v-for="c in colIdx"
            :key="c"
            class="h-[18px] w-[18px] rounded-[4px] border transition-colors duration-75"
            :class="
              r <= hoverR && c <= hoverC ? 'border-accent bg-accent-soft' : 'border-edge bg-panel-2'
            "
            :aria-label="`${r + 1} × ${c + 1}`"
            @mouseenter="onCellEnter(r, c)"
            @click="insertTable(r + 1, c + 1)"
          />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
