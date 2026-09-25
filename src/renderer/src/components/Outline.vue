<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useEditorStore } from '../stores/editor'
import Icon from './Icon.vue'

// ─── 大纲侧栏：标题来自 Tiptap 文档 AST（editor store 维护）──────────────────
const { t } = useI18n()
const editorStore = useEditorStore()
</script>

<template>
  <!-- 大纲列表**不做左右内边距、行也用直角**：行自身的 hover/选中底色要铺满侧栏宽度，
       与「文件」页签（文件树行）的观感一致；行内左侧留白由下面的 paddingLeft 负责。

       ⚠️ 这里**不能用 `<TransitionGroup name="list">`**（用户报障：右侧大纲切文档时闪烁、
       动画很乱）。原因很具体：切文档时所有行一起换 key ⇒ 旧行全部"离场"、新行全部"入场"，
       而 `.list-leave-active` 没写 `position:absolute`，离场的行在 0.25s 里**仍占着文档流**，
       于是新旧两批同时在列表里（高度翻倍、位置互撞）—— 看起来就是闪一下 + 乱。
       大纲是**导航**，不是需要"出现感"的内容：直接换掉最干净。 -->
  <div class="h-full overflow-y-auto pb-4">
    <button
      v-for="(h, i) in editorStore.outline"
      :key="`${i}-${h.level}-${h.text}`"
      data-outline-item
      class="group flex w-full items-center gap-1.5 py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-100"
      :class="
        editorStore.activeHeading === h.pos
          ? 'bg-accent-soft text-accent'
          : 'text-ink-2 hover:bg-panel-2 hover:text-ink'
      "
      :style="{ paddingLeft: `${10 + (h.level - 1) * 14}px` }"
      @click="editorStore.jumpToHeading(h.pos)"
    >
      <span
        class="h-1.5 w-1.5 flex-none rounded-full transition-colors"
        :class="
          editorStore.activeHeading === h.pos ? 'bg-accent' : 'bg-ink-3/50 group-hover:bg-ink-3'
        "
      />
      <span class="min-w-0 flex-1 truncate">{{ h.text }}</span>
    </button>
    <div
      v-if="!editorStore.outline.length"
      class="mt-6 flex flex-col items-center gap-2 px-4 text-center"
    >
      <Icon name="heading" :size="24" :stroke-width="1.3" class="text-ink-3/60" />
      <p class="text-[12px] leading-relaxed text-ink-2b">{{ t('sidebar.emptyOutline') }}</p>
    </div>
  </div>
</template>
