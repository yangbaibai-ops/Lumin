<script setup lang="ts">
import { computed } from 'vue'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { analyzeDoc } from '../lib/markdown'
import Icon from './Icon.vue'

const files = useFilesStore()
const ui = useUiStore()

const headings = computed(() => {
  if (!files.current) return []
  return analyzeDoc(files.current.content).headings
})
</script>

<template>
  <div class="h-full overflow-y-auto px-2 pb-4">
    <TransitionGroup name="list">
      <button
        v-for="h in headings"
        :key="`${h.line}-${h.text}`"
        class="group flex w-full items-center gap-1.5 rounded-lg py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-100"
        :class="
          ui.activeHeading === h.blockIndex
            ? 'bg-accent-soft text-accent'
            : 'text-ink-2 hover:bg-panel-2 hover:text-ink'
        "
        :style="{ paddingLeft: `${10 + (h.level - 1) * 14}px` }"
        @click="ui.scrollToHeading(h.blockIndex)"
      >
        <span
          class="h-1.5 w-1.5 flex-none rounded-full transition-colors"
          :class="ui.activeHeading === h.blockIndex ? 'bg-accent' : 'bg-ink-3/50 group-hover:bg-ink-3'"
        />
        <span class="min-w-0 flex-1 truncate">{{ h.text }}</span>
      </button>
    </TransitionGroup>
    <div v-if="!headings.length" class="mt-6 flex flex-col items-center gap-2 px-4 text-center">
      <Icon name="heading" :size="24" :stroke-width="1.3" class="text-ink-3/60" />
      <p class="text-[12px] leading-relaxed text-ink-3">暂无标题<br />使用 # 创建大纲</p>
    </div>
  </div>
</template>
