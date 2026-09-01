<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import Toolbar from '../components/Toolbar.vue'
import StatusBar from '../components/StatusBar.vue'
import LiveEditor from '../components/LiveEditor.vue'
import SourceEditor from '../components/SourceEditor.vue'
import FindBar from '../components/FindBar.vue'
import Icon from '../components/Icon.vue'

const files = useFilesStore()
const ui = useUiStore()

const liveRef = ref<InstanceType<typeof LiveEditor> | null>(null)
const findOpen = ref(false)

watch(
  () => ui.findTick,
  () => {
    if (ui.editorMode === 'wysiwyg') findOpen.value = true
  }
)

const editorWidth = computed(() => (ui.focusMode ? '720px' : '900px'))

// ── 外部文件拖放 ──
async function onDrop(e: DragEvent): Promise<void> {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const path = window.luminAPI.file.getPathForFile(file)
  if (!path) return
  if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(path)) {
    ui.toast('仅支持打开 Markdown 文件', 'error')
    return
  }
  if (files.dirty) {
    const ok = await ui.confirm({
      title: '有未保存的更改',
      body: '当前文档有未保存的更改，确定要打开其他文件吗？',
      danger: true
    })
    if (!ok) return
  }
  await files.openPath(path)
}
function onDragOver(e: DragEvent): void {
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}

onMounted(() => {
  // 无文档时默认新建一个未命名文档
  if (!files.current) void files.openUntitled()
})
onBeforeUnmount(() => void files.flushAll())
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" @drop.prevent="onDrop" @dragover="onDragOver">
    <Toolbar />

    <!-- 草稿恢复横幅 -->
    <Transition name="slide">
      <div v-if="files.draftRestore" class="restore-bar mx-4 mt-3 flex items-center gap-3 px-4 py-2.5 text-[13px]">
        <Icon name="clock" :size="15" />
        <span class="flex-1">检测到未保存的草稿（比磁盘文件更新）</span>
        <button class="btn btn-primary !px-3 !py-1 text-[12px]" @click="files.applyDraftRestore(true)">
          恢复
        </button>
        <button class="btn btn-ghost !px-3 !py-1 text-[12px]" @click="files.applyDraftRestore(false)">
          丢弃
        </button>
      </div>
    </Transition>

    <!-- 编辑区 -->
    <div class="relative min-h-0 flex-1" :style="{ '--editor-maxw': editorWidth }">
      <Transition name="fade" mode="out-in">
        <LiveEditor v-if="ui.editorMode === 'wysiwyg'" key="live" ref="liveRef" />
        <SourceEditor v-else key="source" />
      </Transition>

      <!-- 实时渲染模式下的查找栏 -->
      <FindBar
        v-if="findOpen && ui.editorMode === 'wysiwyg'"
        :target="liveRef"
        @close="findOpen = false"
      />
    </div>

    <StatusBar />
  </div>
</template>
