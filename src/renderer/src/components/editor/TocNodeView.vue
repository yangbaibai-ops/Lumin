<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { useI18n } from 'vue-i18n'
import { useEditorStore } from '../../stores/editor'

// 声明 NodeViewProps（VueNodeViewRenderer 类型要求），实际无需读取
defineProps(nodeViewProps)

const { t } = useI18n()
const editorStore = useEditorStore()

// 依赖 tick（每次事务自增）保持目录与文档标题实时同步
const items = computed(() => {
  void editorStore.tick
  return editorStore.outline
})

/** 点击目录条目 → 光标定位并滚动到对应标题（与大纲侧边栏一致） */
function jump(pos: number): void {
  editorStore.jumpToHeading(pos)
}
</script>

<template>
  <node-view-wrapper class="md-toc" contenteditable="false">
    <div class="md-toc-title">{{ t('editor.toc') }}</div>
    <template v-if="items.length">
      <a
        v-for="(h, i) in items"
        :key="i"
        :class="h.level > 1 ? 'toc-l' + Math.min(h.level, 3) : ''"
        @mousedown.prevent.stop
        @click.prevent.stop="jump(h.pos)"
      >
        {{ h.text }}
      </a>
    </template>
    <div v-else class="md-toc-empty">{{ t('sidebar.emptyOutline') }}</div>
  </node-view-wrapper>
</template>
