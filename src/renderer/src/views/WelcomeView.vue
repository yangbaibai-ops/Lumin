<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { confirmIfDirty } from '../composables/useAppActions'
import type { DraftInfo } from '../../../shared/types'
import Icon from '../components/Icon.vue'

const router = useRouter()
const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()

const untitledDraft = ref<DraftInfo | null>(null)
const version = ref('')

const recents = computed(() => {
  const pinned = new Set(settings.pinnedFiles)
  const list = [...settings.recentFiles]
  return list.sort((a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path)) || b.openedAt - a.openedAt)
})

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

async function newDoc(): Promise<void> {
  if (!(await confirmIfDirty())) return
  await files.newDocInWorkspace()
  await router.push('/editor')
}

async function openFileDialog(): Promise<void> {
  if (!(await confirmIfDirty())) return
  const path = await window.luminAPI.file.chooseOpenFile()
  if (!path) return
  if (await files.openPath(path)) await router.push('/editor')
}

async function openRecent(path: string): Promise<void> {
  if (!(await confirmIfDirty())) return
  if (await files.openPath(path)) await router.push('/editor')
}

async function openFolderDialog(): Promise<void> {
  await files.openFolder()
  ui.toast('已打开文件夹', 'success')
}

async function recoverUntitled(): Promise<void> {
  await files.openUntitled()
  await router.push('/editor')
}

async function dropOpen(e: DragEvent): Promise<void> {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const path = window.luminAPI.file.getPathForFile(file)
  if (!path || !/\.(md|markdown|mdown|mkd|txt)$/i.test(path)) return
  if (await files.openPath(path)) await router.push('/editor')
}

const shortcuts: { keys: string; label: string }[] = [
  { keys: 'Ctrl+N', label: '新建文档' },
  { keys: 'Ctrl+O', label: '打开文件' },
  { keys: 'Ctrl+S', label: '保存' },
  { keys: 'Ctrl+F', label: '查找替换' },
  { keys: 'Ctrl+B / I', label: '加粗 / 斜体' },
  { keys: 'Ctrl+Shift+E', label: '导出 PDF' },
  { keys: 'Ctrl+Shift+F', label: '专注模式' },
  { keys: 'Ctrl+Shift+T', label: '打字机模式' }
]

onMounted(async () => {
  untitledDraft.value = await window.luminAPI.drafts.hasUntitled()
  version.value = await window.luminAPI.app.getVersion()
})
</script>

<template>
  <div
    class="h-full overflow-y-auto"
    @drop.prevent="dropOpen"
    @dragover.prevent
  >
    <div class="mx-auto max-w-[920px] px-10 pb-16 pt-14">
      <!-- 主视觉 -->
      <div class="relative mb-12 text-center">
        <div
          class="pointer-events-none absolute left-1/2 top-[-60px] h-[280px] w-[560px] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
          style="background: radial-gradient(closest-side, var(--accent), transparent 70%)"
        />
        <div
          class="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-2 text-white"
          :style="{ animation: 'lm-pop 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.2)', boxShadow: '0 8px 30px var(--glow)' }"
        >
          <Icon name="logo" :size="32" :stroke-width="1.7" />
        </div>
        <h1 class="relative text-[34px] font-bold tracking-tight text-ink" style="animation: lm-slide-up 0.5s ease both">
          开始你的灵感之旅
        </h1>
        <p class="relative mt-2 text-[14px] text-ink-2" style="animation: lm-slide-up 0.55s 0.06s ease both">
          所见即所得的 Markdown 写作体验 · Write in Light.
        </p>
      </div>

      <!-- 未命名草稿恢复 -->
      <Transition name="pop">
        <button
          v-if="untitledDraft"
          class="mx-auto mb-6 flex w-full max-w-[480px] items-center gap-3 rounded-2xl border border-dashed px-4 py-3 text-left transition-all duration-200 hover:-translate-y-0.5"
          style="border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft)"
          @click="recoverUntitled"
        >
          <span class="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent/15 text-accent">
            <Icon name="clock" :size="15" />
          </span>
          <span class="flex-1">
            <span class="block text-[13.5px] font-semibold text-ink">恢复上次未保存的草稿</span>
            <span class="block text-[12px] text-ink-2">草稿时间：{{ new Date(untitledDraft.savedAt).toLocaleString('zh-CN') }}</span>
          </span>
          <Icon name="chevron-right" :size="15" class="text-ink-3" />
        </button>
      </Transition>

      <!-- 操作 -->
      <div class="mb-10 flex items-center justify-center gap-3">
        <button class="btn btn-primary h-11 px-6 text-[14px]" @click="newDoc">
          <Icon name="file-plus" :size="16" />
          新建文档
        </button>
        <button class="btn btn-outline h-11 px-6 text-[14px]" @click="openFileDialog">
          <Icon name="folderOpen" :size="16" />
          打开文件
        </button>
        <button class="btn btn-ghost h-11 px-5 text-[14px]" @click="openFolderDialog">
          <Icon name="folder" :size="16" />
          打开文件夹
        </button>
      </div>

      <!-- 最近文档 -->
      <section class="mb-10">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-[13px] font-semibold uppercase tracking-[0.1em] text-ink-3">最近文档</h2>
          <div class="h-px flex-1 bg-edge" />
          <button
            v-if="settings.recentFiles.length"
            class="flex items-center gap-1 text-[12px] text-ink-3 transition-colors hover:text-danger"
            @click="
              () => {
                settings.set('recentFiles', [])
                settings.set('pinnedFiles', [])
              }
            "
          >
            <Icon name="trash" :size="12" />
            清除记录
          </button>
        </div>

        <div v-if="recents.length" class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <TransitionGroup name="list" appear>
            <div
              v-for="r in recents"
              :key="r.path"
              class="group relative cursor-pointer rounded-xl border border-edge bg-panel p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lg"
              :style="{ boxShadow: 'var(--shadow-1)' }"
              @click="openRecent(r.path)"
            >
              <div class="flex items-start gap-2.5">
                <span
                  class="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors"
                  :class="settings.pinnedFiles.includes(r.path) ? 'bg-accent-soft text-accent' : 'bg-panel-2 text-ink-3 group-hover:text-accent'"
                >
                  <Icon name="file" :size="15" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate text-[13.5px] font-medium text-ink">{{ r.title }}</span>
                    <Icon
                      v-if="settings.pinnedFiles.includes(r.path)"
                      name="pin"
                      :size="11"
                      class="flex-none rotate-45 text-accent"
                    />
                  </div>
                  <div class="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-3">
                    <span class="truncate" :title="r.path">{{ r.path }}</span>
                    <span class="flex-none">·</span>
                    <span class="flex-none">{{ fmtTime(r.openedAt) }}</span>
                  </div>
                </div>
              </div>
              <div class="absolute right-2 top-2 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                <button
                  class="icon-btn !h-6 !w-6 !rounded-md"
                  :class="settings.pinnedFiles.includes(r.path) ? 'active' : ''"
                  :title="settings.pinnedFiles.includes(r.path) ? '取消固定' : '固定'"
                  @click.stop="files.togglePin(r.path)"
                >
                  <Icon name="pin" :size="12" />
                </button>
                <button
                  class="icon-btn !h-6 !w-6 !rounded-md hover:!text-danger"
                  title="从列表移除"
                  @click.stop="files.removeRecent(r.path)"
                >
                  <Icon name="x" :size="12" />
                </button>
              </div>
            </div>
          </TransitionGroup>
        </div>
        <div
          v-else
          class="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-edge py-10 text-center"
        >
          <Icon name="file" :size="24" :stroke-width="1.3" class="text-ink-3/50" />
          <p class="text-[13px] text-ink-3">暂无最近文档，创建或打开一个 Markdown 文件开始写作吧</p>
        </div>
      </section>

      <!-- 底部两栏 -->
      <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
        <section class="rounded-2xl border border-edge bg-panel p-5">
          <h2 class="mb-3 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.1em] text-ink-3">
            <Icon name="keyboard" :size="14" />
            快捷键
          </h2>
          <div class="grid grid-cols-2 gap-x-4 gap-y-2">
            <div v-for="s in shortcuts" :key="s.keys" class="flex items-center justify-between gap-2">
              <span class="text-[12.5px] text-ink-2">{{ s.label }}</span>
              <kbd class="rounded-md border border-edge bg-panel-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{{ s.keys }}</kbd>
            </div>
          </div>
        </section>

        <section class="rounded-2xl border border-edge bg-panel p-5">
          <h2 class="mb-3 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.1em] text-ink-3">
            <Icon name="sparkles" :size="14" />
            写作小贴士
          </h2>
          <ul class="space-y-2">
            <li v-for="(tip, i) in ['使用 # 快速创建标题，Ctrl+B 加粗文字', '输入 $$ 公式以插入数学公式，如 E = mc²', '使用 ```mermaid 代码块绘制流程图与图表', '在文档中插入 [TOC] 可自动生成目录', '按 Ctrl+Shift+F 进入专注模式，享受沉浸写作']" :key="i" class="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-2">
              <Icon name="dot" :size="9" class="mt-1.5 flex-none text-accent" />
              {{ tip }}
            </li>
          </ul>
        </section>
      </div>

      <footer class="mt-10 text-center text-[11.5px] text-ink-3/80">
        Lumin · Write in Light. — v{{ version }} · 免费开源
      </footer>
    </div>
  </div>
</template>
