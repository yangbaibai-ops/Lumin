<script setup lang="ts">
// ─── 表格插入按钮：点击默认 3×3，悬停弹出 WPS 式行列选择器 ───────────────────
// 交互约定（与 WPS/Office 一致）：
//  - 直接点击按钮 → 立即插入默认 3×3 表格（表头行 + 2 数据行）；
//  - 悬停按钮 ~300ms → 弹出网格选择器，以左上角为 1×1，悬停高亮 r×c；
//  - 点击格子 → 插入对应尺寸；弹出状态下点击按钮仅收起选择器。
//
// 弹层里还带**列对齐**四项（清单「表格列对齐（可设置）」）：此前 `:---` / `---:`
// 只能靠手改 Markdown，界面上没有入口。光标在表格里时点这四项即设当前列为左/中/右/默认，
// 走的是唯一入口 `lib/editor/tableColumnAlign.ts`（改整列 → 分隔行跟着变）。
import { computed, onBeforeUnmount, ref, toRaw } from 'vue'
import type { Editor } from '@tiptap/core'
import { useI18n } from 'vue-i18n'
import { useEditorStore } from '../stores/editor'
import { shouldCloseOnScrollOrResize } from '../lib/popoverClose'
import { useHoverPopover } from '../composables/useHoverPopover'
import {
  applyTableColumnAlign,
  tableColumnAlign,
  tableColumnIndex
} from '../lib/editor/tableColumnAlign'
import type { AlignValue } from '../lib/editor/tableAlign'
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
const hoverR = ref(2)
const hoverC = ref(2)

const rowIdx = computed(() => Array.from({ length: MAX_ROWS }, (_, i) => i))
const colIdx = computed(() => Array.from({ length: MAX_COLS }, (_, i) => i))

/**
 * 悬停弹层（开合时序 + 落点）：实现在 `composables/useHoverPopover`，与代码块按钮共用
 * （审计 §10 P1「popover 2 份」）。
 *
 * `width: GRID_WIDTH`：网格最宽 10 列，窄窗口下按钮贴近右边缘时要把弹层整体夹回视口内 ——
 * 这条规则过去只有代码块按钮有，表格这边会溢出（顺带修掉）。
 */
const GRID_WIDTH = 236
const {
  open,
  pos: popPos,
  onButtonEnter,
  onPopoverEnter,
  scheduleClose,
  openNow,
  cancelTimers
} = useHoverPopover(btnRef, { width: GRID_WIDTH })

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

// ─── 列对齐（见文件头注释）──────────────────────────────────────────────────
// 下拉项顺序固定为 左 / 中 / 右 / 默认：位置不随当前状态变化，肌肉记忆成立。
const alignChoices: { value: AlignValue; icon: string; labelKey: string }[] = [
  { value: 'left', icon: 'align-left', labelKey: 'editorMenu.tableAlign.left' },
  { value: 'center', icon: 'align-center', labelKey: 'editorMenu.tableAlign.center' },
  { value: 'right', icon: 'align-right', labelKey: 'editorMenu.tableAlign.right' },
  { value: null, icon: 'align-default', labelKey: 'editorMenu.tableAlign.none' }
]

/** 光标是否落在表格里：不在表格里这四项点了也不会有反应，直接灰显 */
const inTable = computed(() => {
  void editorStore.tick
  const ed = editorStore.instance
  if (!ed) return false
  try {
    return ed.isActive('table')
  } catch {
    return false
  }
})

/**
 * store 里的编辑器实例（`markRaw` 的同一个对象）。
 *
 * 为什么要这一层：Pinia 的 state 经 `_UnwrapAll` 后，`instance` 的类型丢掉了 Tiptap
 * `Editor` 的标识（工具函数签名要 `Editor`），运行期显然是同一个实例。
 * `toRaw` 只去 Vue 的响应式代理（实例本身就是 `markRaw`，不会二次包装），
 * 类型断言把丢掉的那部分补回来 —— 全组件只此一处转换。
 */
function activeEditor(): Editor | null {
  void editorStore.tick
  const ed = editorStore.instance
  return ed ? (toRaw(ed) as unknown as Editor) : null
}

/** 当前列的对齐（表头行为真源，与分隔行同一处判据） */
const currentAlign = computed<AlignValue>(() => {
  const editor = activeEditor()
  if (!editor) return null
  const colIndex = tableColumnIndex(editor)
  if (colIndex === null) return null
  return tableColumnAlign(editor, colIndex)
})

function applyAlign(align: AlignValue): void {
  const editor = activeEditor()
  if (!editor || !inTable.value) return
  applyTableColumnAlign(editor, align)
  open.value = false
  cancelTimers()
}

/** 按钮的键盘路径（Tab 到 → Enter/Space 开合弹层；弹层里 Esc 收起） */
function onButtonKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  if (open.value) {
    open.value = false
    cancelTimers()
    return
  }
  // 键盘路径（Enter/Space）：立刻弹层，不该等 300ms 的悬停延迟
  openNow()
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
      :aria-label="t('editor.table')"
      :aria-expanded="open"
      aria-haspopup="menu"
      :disabled="!editorStore.instance"
      @click="onButtonClick"
      @keydown="onButtonKeydown"
      @mouseenter="onButtonEnter"
    >
      <Icon name="table" :size="15" />
    </button>
  </div>

  <Teleport to="body">
    <Transition name="pop">
      <div
        v-if="open"
        class="table-size-popover fixed z-[var(--z-popover)] rounded-xl border border-edge bg-elevate p-3"
        :style="{ boxShadow: 'var(--shadow-2)', left: popPos.x + 'px', top: popPos.y + 'px' }"
        @mouseenter="onPopoverEnter"
        @mouseleave="scheduleClose"
        @keydown.esc="open = false"
      >
        <div class="mb-2 text-ui-sm text-ink-2">
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

        <!-- 列对齐：光标在表格里才可用（不在表格里点它不会有任何反应，所以灰显 + 提示） -->
        <div class="mt-2.5 border-t border-edge pt-2">
          <div class="mb-1.5 text-ui-sm text-ink-2b">
            {{ t('editor.tableAlign') }}
          </div>
          <div
            class="flex items-center justify-between"
            :class="inTable ? '' : 'opacity-50'"
            role="group"
            :aria-label="t('editor.tableAlign')"
            :title="inTable ? t('editor.tableAlignHint') : t('editor.tableAlignNeedTable')"
          >
            <button
              v-for="choice in alignChoices"
              :key="choice.labelKey"
              class="icon-btn icon-btn-sm"
              :class="{ active: inTable && currentAlign === choice.value }"
              :disabled="!inTable"
              :title="t(choice.labelKey)"
              :aria-label="t(choice.labelKey)"
              :aria-pressed="inTable && currentAlign === choice.value"
              @click="applyAlign(choice.value)"
            >
              <Icon :name="choice.icon" :size="14" />
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
