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
  <!-- 样式对齐主流编辑器：一颗朴素的嵌套列表（圆点 + 缩进），没有外框、底色与左侧色条 -->
  <node-view-wrapper class="md-toc" contenteditable="false">
    <template v-if="items.length">
      <a
        v-for="(h, i) in items"
        :key="i"
        class="toc-item"
        :data-level="h.level"
        :style="{ '--toc-depth': Math.min(h.level, 4) - 1 }"
        @mousedown.prevent.stop
        @click.prevent.stop="jump(h.pos)"
      >
        {{ h.text }}
      </a>
    </template>
    <div v-else class="md-toc-empty">{{ t('sidebar.emptyOutline') }}</div>
  </node-view-wrapper>
</template>
