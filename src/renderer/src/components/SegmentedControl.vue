<script setup lang="ts">
// ─── 分段控件（segmented control）────────────────────────────────────────────
// 一处实现、两处使用：编辑器工具栏的「实时渲染 / 分屏 / 源码」、侧栏的「树 / 列表」。
// 做法是当代主流的「滑动指示块（sliding thumb）」：一条中性轨道 + 一个随选中项平移的
// 抬升色块，而不是每个按钮各自填充——视觉上是一个控件在切换，而不是三个小按钮。
//
// 关键实现细节：指示块宽度 = 内轨道宽度 / 段数，位移用 `translateX(index * 100%)`
// （百分比是相对**指示块自身**宽度），因此不需要测量任何 DOM 尺寸，也就没有布局抖动；
// 动画只走 transform（合成层），配合 prefers-reduced-motion 关闭。
import { computed } from 'vue'
import Icon from './Icon.vue'

export interface SegmentItem {
  /** 取值（v-model） */
  id: string
  /** 图标名（Icon 组件） */
  icon: string
  /** 无障碍/提示文案（已本地化） */
  label: string
  /** 悬停提示；缺省用 label */
  title?: string
}

const props = defineProps<{
  modelValue: string
  items: SegmentItem[]
  /** 轨道整体尺寸：md = 工具栏（30px），sm = 侧栏头部（26px） */
  size?: 'sm' | 'md'
  /** 分组无障碍名称（已本地化）；渲染成根元素的 aria-label */
  groupLabel: string
  /** 是否显示文字标签（窄控件默认只显示图标 + 提示） */
  showLabels?: boolean
  /** 段宽：不传则各段等宽（按内容自适应） */
  minWidth?: number
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const activeIndex = computed(() =>
  Math.max(
    0,
    props.items.findIndex((i) => i.id === props.modelValue)
  )
)
const pad = computed(() => (props.size === 'sm' ? 2 : 2))
const height = computed(() => (props.size === 'sm' ? 26 : 30))
const innerHeight = computed(() => height.value - pad.value * 2 - 2) // 减去上下 padding 与 1px 边框
</script>

<template>
  <div
    class="seg"
    role="tablist"
    :aria-label="groupLabel"
    :style="{ height: `${height}px`, padding: `${pad}px` }"
  >
    <!-- 滑动指示块：宽度 = 一段，位移 = 序号 × 自身宽度 -->
    <span
      v-if="items.length > 1"
      class="seg-thumb"
      aria-hidden="true"
      :style="{
        width: `calc((100% - ${pad * 2}px) / ${items.length})`,
        height: `${innerHeight}px`,
        transform: `translateX(${activeIndex * 100}%)`
      }"
    />
    <button
      v-for="it in items"
      :key="it.id"
      class="seg-btn"
      :class="{ active: it.id === modelValue }"
      :style="{ height: `${innerHeight}px`, ...(minWidth ? { minWidth: `${minWidth}px` } : {}) }"
      role="tab"
      :aria-selected="it.id === modelValue"
      :aria-label="it.label"
      :title="it.title ?? it.label"
      @click="emit('update:modelValue', it.id)"
    >
      <Icon :name="it.icon" :size="size === 'sm' ? 13.5 : 14" />
      <span v-if="showLabels" class="seg-label">{{ it.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.seg {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  border: 1px solid var(--edge);
  border-radius: 10px;
  background: var(--panel-2);
  /* 轨道本身稍微内收，指示块才显得“浮”在上面 */
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 3%);
  user-select: none;
}

/* 指示块 = 抬升表面 + 发丝描边 + 极轻投影（三件套让它在任何主题下都立得住） */
.seg-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  border-radius: 8px;
  background: var(--elevate);
  box-shadow:
    0 1px 2px rgb(0 0 0 / 7%),
    0 0 0 1px var(--edge-strong);
  transition: transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

.seg-btn {
  position: relative;
  z-index: 1;
  display: inline-flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: 8px;
  color: var(--ink-3);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color 0.18s ease,
    opacity 0.18s ease;
}
.seg-btn:hover {
  color: var(--ink-2);
}
.seg-btn.active {
  color: var(--ink);
  font-weight: 560;
}
/* 选中项的图标用品牌色点一下，比整块染色更克制 */
.seg-btn.active :deep(svg) {
  color: var(--accent);
}
.seg-label {
  letter-spacing: 0.01em;
}

@media (prefers-reduced-motion: reduce) {
  .seg-thumb {
    transition: none;
  }
}
</style>
