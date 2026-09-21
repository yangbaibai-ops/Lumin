<script setup lang="ts">
// ─── 代码块按钮：点击插入/取消代码块，悬停弹出「代码块行号」快捷开关 ──────────
// 交互与表格按钮同款（WPS/Office 式）：
//  - 直接点击按钮 → 立即插入/取消代码块（弹层是否展开都不影响这个主操作）；
//  - 悬停按钮 ~300ms → 弹出小选项，内含与「设置 → 编辑器 → 代码块行号」同一个
//    setting 的开关（settings.set 即时生效，已打开的 CodeMirror 行号槽会实时增减）；
//  - 指针离开按钮/弹层 180ms 后收起：这段宽限同时让指针跨过两者之间的空隙，
//    不会出现「移向弹层时弹层先消失」。
// 弹层 Teleport 到 body：工具栏是 overflow-x-auto 容器，常规弹层会被裁掉。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEditorStore } from '../stores/editor'
import { useSettingsStore } from '../stores/settings'
import { shouldCloseOnScrollOrResize } from '../lib/popoverClose'
import Icon from './Icon.vue'

const { t } = useI18n()
const editorStore = useEditorStore()
const settings = useSettingsStore()

// 同 ToolbarTableButton：两个根节点（按钮容器 + Teleport 弹层）导致属性无法自动继承，
// 工具栏的 `data-toolbar-item` 必须手动挂到按钮容器上（否则警告 + 右键被当空白区）。
defineOptions({ inheritAttrs: false })

const POP_WIDTH = 188
const OPEN_DELAY = 300
const CLOSE_DELAY = 180

const btnRef = ref<HTMLElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
const open = ref(false)
const popPos = ref({ x: 0, y: 0 })

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

/** 打开时留出边距钳制，窄窗口下工具栏可横向滚动，按钮可能贴近右边缘 */
function showPopover(): void {
  const rect = btnRef.value?.getBoundingClientRect()
  if (!rect) return
  popPos.value = {
    x: Math.max(8, Math.min(rect.left, window.innerWidth - POP_WIDTH - 8)),
    y: rect.bottom + 8
  }
  open.value = true
}

function onButtonEnter(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  openTimer = setTimeout(showPopover, OPEN_DELAY)
}

function scheduleClose(): void {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  closeTimer = setTimeout(() => {
    closeTimer = null
    open.value = false
  }, CLOSE_DELAY)
}

function onPopoverEnter(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}

/** 点击外部任意处收起（弹层浮在编辑器上方，别让它挡住编辑区的点击） */
function onDocMouseDown(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target as Node
  if (btnRef.value?.contains(target) || popRef.value?.contains(target)) return
  cancelTimers()
  open.value = false
}

/** 滚动/缩放收起：弹层内部滚动不收起（见 lib/popoverClose.ts） */
function onWindowScrollOrResize(e: Event): void {
  if (!open.value) return
  if (!shouldCloseOnScrollOrResize(e, popRef.value)) return
  cancelTimers()
  open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('scroll', onWindowScrollOrResize, true)
  window.addEventListener('resize', onWindowScrollOrResize)
})
onBeforeUnmount(() => {
  cancelTimers()
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('scroll', onWindowScrollOrResize, true)
  window.removeEventListener('resize', onWindowScrollOrResize)
})

/** 工具栏激活态（依赖 editor store 的 tick 驱动重渲染） */
const active = computed(() => {
  void editorStore.tick
  const ed = editorStore.instance
  if (!ed) return false
  try {
    return ed.isActive('codeBlock')
  } catch {
    return false
  }
})

function toggleCodeBlock(): void {
  cancelTimers()
  open.value = false
  editorStore.instance?.chain().focus().toggleCodeBlock().run()
}

/** 源码模式下没有编辑器实例：按钮灰显（此前可点但静默无效，见工具栏审计 F1） */
const disabled = computed(() => !editorStore.instance)

function toggleLineNumbers(): void {
  // 与设置面板共用同一个 setting：立即应用到已打开的代码块，并持久化到 SQLite
  settings.set('codeLineNumbers', !settings.codeLineNumbers)
}
</script>

<template>
  <div ref="btnRef" v-bind="$attrs" class="shrink-0" @mouseleave="scheduleClose">
    <button
      class="icon-btn"
      :class="{ active }"
      :title="t('editor.codeBlock')"
      :aria-label="t('editor.codeBlock')"
      :disabled="disabled"
      @click="toggleCodeBlock"
      @mouseenter="onButtonEnter"
    >
      <Icon name="braces" :size="15" />
    </button>
  </div>

  <Teleport to="body">
    <Transition name="pop">
      <div
        v-if="open"
        ref="popRef"
        class="code-block-popover fixed z-[100] rounded-xl border border-edge bg-elevate p-1.5"
        :style="{
          boxShadow: 'var(--shadow-2)',
          width: POP_WIDTH + 'px',
          left: popPos.x + 'px',
          top: popPos.y + 'px'
        }"
        @mouseenter="onPopoverEnter"
        @mouseleave="scheduleClose"
        @mousedown.prevent
      >
        <!-- 动作文案走 aria-label：全局 tooltip 会在悬停时移除 title 属性
             （lib/tooltip.ts），「随状态变化的 title」会和它互相打架（移出后把旧值
             写回，导致提示与实际动作不一致）。静态可见文案 + switch 已足够表达，
             读屏器仍能拿到动作措辞 -->
        <button
          class="flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink transition-colors duration-100 hover:bg-panel-2"
          role="switch"
          :aria-checked="settings.codeLineNumbers"
          :aria-label="
            settings.codeLineNumbers ? t('editor.lineNumbersOff') : t('editor.lineNumbersOn')
          "
          @click="toggleLineNumbers"
        >
          <span>{{ t('editor.codeLineNumbers') }}</span>
          <span class="switch" :class="{ on: settings.codeLineNumbers }" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
