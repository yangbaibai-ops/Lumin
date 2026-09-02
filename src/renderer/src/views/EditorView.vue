<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import Toolbar from '../components/Toolbar.vue'
import StatusBar from '../components/StatusBar.vue'
import TyporaEditor from '../components/editor/TyporaEditor.vue'

// ─── 编辑器页面：工具栏 + Tiptap 所见即所得内核 + 状态栏 ────────────────────
const files = useFilesStore()
const ui = useUiStore()

function onEditorUpdate(md: string): void {
  files.setContent(md)
}

// 外部文件拖放打开（文件系统逻辑，与内核无关）
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
  if (!files.current) void files.openUntitled()
})
onBeforeUnmount(() => void files.flushAll())
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" @drop.prevent="onDrop" @dragover="onDragOver">
    <Toolbar />

    <!-- 草稿恢复横幅（文件状态逻辑，与内核无关） -->
    <Transition name="slide">
      <div
        v-if="files.draftRestore"
        class="restore-bar mx-4 mt-3 flex items-center gap-3 px-4 py-2.5 text-[13px]"
      >
        <span class="flex-1">检测到未保存的草稿（比磁盘文件更新）</span>
        <button class="btn btn-primary !px-3 !py-1 text-[12px]" @click="files.applyDraftRestore(true)">
          恢复
        </button>
        <button class="btn btn-ghost !px-3 !py-1 text-[12px]" @click="files.applyDraftRestore(false)">
          丢弃
        </button>
      </div>
    </Transition>

    <!-- 编辑器内核（按文件重建，避免撤销历史/光标残留） -->
    <div class="relative min-h-0 flex-1">
      <TyporaEditor
        :key="files.current?.path ?? 'untitled'"
        :model-value="files.current?.content ?? ''"
        @update:model-value="onEditorUpdate"
      />
    </div>

    <StatusBar />
  </div>
</template>
