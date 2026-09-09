<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { tooltipState } from '../lib/tooltip'

const tooltipRef = ref<HTMLElement | null>(null)

// 浮层渲染完成后实测其尺寸，做精确钳制/翻转，保证整块都显示在视口内、
// 且始终贴附在目标元素上方或下方（不遮挡目标本身）
watch(
  () => tooltipState.visible,
  async (visible) => {
    if (!visible) return
    await nextTick()
    const tip = tooltipRef.value
    if (!tip) return
    const r = tip.getBoundingClientRect()
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    const target = tooltipState.targetRect
    const gap = 7

    // 水平：以目标中心为锚点，把整块钳制进视口（translate(-50%) 居中）
    const halfW = r.width / 2
    tooltipState.x = Math.min(Math.max(tooltipState.x, margin + halfW), vw - margin - halfW)

    // 垂直：当前侧放不下时翻到另一侧；另一侧也放不下则保持（贴边）
    const tipH = r.height
    const fitsAbove = target.top - tipH - gap >= margin
    const fitsBelow = target.bottom + tipH + gap <= vh - margin
    if (tooltipState.above && !fitsAbove && fitsBelow) {
      tooltipState.above = false
      tooltipState.y = target.bottom
    } else if (!tooltipState.above && !fitsBelow && fitsAbove) {
      tooltipState.above = true
      tooltipState.y = target.top
    }
  }
)
</script>

<template>
  <Teleport to="body">
    <Transition name="lm-tip">
      <div
        v-if="tooltipState.visible"
        ref="tooltipRef"
        class="lm-tooltip"
        :class="tooltipState.above ? 'is-above' : 'is-below'"
        :style="{ left: tooltipState.x + 'px', top: tooltipState.y + 'px' }"
      >
        {{ tooltipState.text }}
      </div>
    </Transition>
  </Teleport>
</template>
