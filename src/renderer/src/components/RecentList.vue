<script setup lang="ts">
// ─── 最近列表（文件 / 文件夹）：侧栏下拉与顶部菜单二级共用 ──────────────────
// 只负责「渲染一列最近项 + 固定/移除等行内操作」，容器（点击展开的下拉、
// 悬停展开的二级菜单）由调用方决定——两处展示同一份数据，避免各写一套。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RecentFile, RecentFolder } from '../../../shared/types'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    kind: 'files' | 'folders'
    /** 最多显示条数 */
    max?: number
    /** 紧凑模式：二级菜单里用，行更矮 */
    dense?: boolean
  }>(),
  { max: 8, dense: false }
)

const emit = defineEmits<{ (e: 'select', path: string): void }>()

const { t } = useI18n()
const files = useFilesStore()
const settings = useSettingsStore()

/** 文档：固定优先 + 按打开时间倒序；文件夹：直接按时间倒序 */
const items = computed<RecentFile[] | RecentFolder[]>(() => {
  if (props.kind === 'folders') return files.recentFolderList().slice(0, props.max)
  const pinned = new Set(settings.pinnedFiles)
  return [...settings.recentFiles]
    .sort(
      (a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path)) || b.openedAt - a.openedAt
    )
    .slice(0, props.max)
})

function label(item: RecentFile | RecentFolder): string {
  return 'title' in item ? item.title : item.name
}

function sub(item: RecentFile | RecentFolder): string {
  return item.path
}

function isPinned(path: string): boolean {
  return settings.pinnedFiles.includes(path)
}
</script>

<template>
  <div>
    <p
      v-if="!items.length"
      class="rounded-lg border border-dashed border-edge px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-3"
    >
      {{ kind === 'folders' ? t('open.emptyFolders') : t('open.emptyRecent') }}
    </p>

    <div v-else class="max-h-[min(46vh,360px)] overflow-y-auto overscroll-contain">
      <div
        v-for="item in items"
        :key="item.path"
        class="group flex items-center gap-2 rounded-lg px-2 transition-colors hover:bg-panel-2"
        :class="dense ? 'py-1' : 'py-1.5'"
      >
        <button
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          :title="item.path"
          @click="emit('select', item.path)"
        >
          <Icon
            :name="kind === 'folders' ? 'folder' : isPinned(item.path) ? 'pin' : 'file'"
            :size="13"
            :class="
              kind === 'folders'
                ? 'text-ink-3'
                : isPinned(item.path)
                  ? 'rotate-45 text-accent'
                  : 'text-ink-3'
            "
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12.5px] text-ink">{{ label(item) }}</span>
            <span v-if="!dense" class="block truncate text-[11px] text-ink-3">{{ sub(item) }}</span>
          </span>
        </button>

        <template v-if="kind === 'files'">
          <button
            class="icon-btn !h-6 !w-6 opacity-0 group-hover:opacity-100"
            :class="{ active: isPinned(item.path) }"
            :title="isPinned(item.path) ? t('open.unpin') : t('open.pin')"
            @click="files.togglePin(item.path)"
          >
            <Icon name="pin" :size="12" />
          </button>
          <button
            class="icon-btn !h-6 !w-6 opacity-0 hover:!text-danger group-hover:opacity-100"
            :title="t('open.removeRecent')"
            @click="files.removeRecent(item.path)"
          >
            <Icon name="x" :size="12" />
          </button>
        </template>
        <button
          v-else
          class="icon-btn !h-6 !w-6 opacity-0 hover:!text-danger group-hover:opacity-100"
          :title="t('open.removeRecent')"
          @click="files.removeRecentFolder(item.path)"
        >
          <Icon name="x" :size="12" />
        </button>
      </div>
    </div>

    <button
      v-if="items.length"
      class="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-danger"
      @click="
        () => {
          if (kind === 'folders') settings.set('recentFolders', [])
          else {
            settings.set('recentFiles', [])
            settings.set('pinnedFiles', [])
          }
        }
      "
    >
      <Icon name="trash" :size="13" />
      {{ kind === 'folders' ? t('open.clearFolders') : t('open.clearRecent') }}
    </button>
  </div>
</template>
