<script setup lang="ts">
import { tooltipState } from '../lib/tooltip'
</script>

<template>
  <Teleport to="body">
    <Transition name="lm-tip">
      <div
        v-if="tooltipState.visible"
        class="lm-tooltip"
        :class="tooltipState.above ? 'is-above' : 'is-below'"
        :style="{ left: tooltipState.x + 'px', top: tooltipState.y + 'px' }"
      >
        {{ tooltipState.text }}
      </div>
    </Transition>
  </Teleport>
</template>
