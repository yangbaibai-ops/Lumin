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
       大纲是**导航**，不是需要"出现感"的内容：直接换掉最干净。

       ⚠️ 每条前面那枚小圆点（`<span class="h-1.5 w-1.5 rounded-full">`）**已按用户要求删掉**。
       层级感不靠它：`paddingLeft` 的 `${10 + (level - 1) * 14}px` 是一条**独立**的缩进来源
       （圆点当年只是行内第一个 flex 子项，一点 `padding` 都不占），所以去掉之后缩进一字未改 ——
       h1 起于 10px、每深一级多 14px，扫读靠左边距 + 行高 + 悬停/选中的整行底色分层。
       连 `gap-1.5` 也一并去掉：行内只剩一个子项，gap 已经产生不了任何间距（留着会误导下一个读代码的人）。
       （`lib/editor/tableOfContents.ts` 里**文档内 [TOC] 块**的那套 `•`/`◦`/`▪` 是另一回事：
       那是正文里用户看得见的列表，不在本次"大纲视图"的口径内，见 assets/editor.css 的 `.md-toc`。） -->
  <div class="h-full overflow-y-auto pb-4">
    <button
      v-for="(h, i) in editorStore.outline"
      :key="`${i}-${h.level}-${h.text}`"
      data-outline-item
      class="group flex w-full items-center py-[5px] pr-2 text-left text-ui transition-colors duration-100"
      :class="
        editorStore.activeHeading === h.pos
          ? 'bg-accent-soft text-accent-ink'
          : 'text-ink-2 hover:bg-panel-2 hover:text-ink'
      "
      :style="{ paddingLeft: `${10 + (h.level - 1) * 14}px` }"
      @click="editorStore.jumpToHeading(h.pos)"
    >
      <span class="min-w-0 flex-1 truncate">{{ h.text }}</span>
    </button>
    <div
      v-if="!editorStore.outline.length"
      class="mt-6 flex flex-col items-center gap-2 px-4 text-center"
    >
      <Icon name="heading" :size="24" :stroke-width="1.3" class="text-ink-3/60" />
      <p class="text-ui-sm leading-relaxed text-ink-2b">{{ t('sidebar.emptyOutline') }}</p>
    </div>
  </div>
</template>
