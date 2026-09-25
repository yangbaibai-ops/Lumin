<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useWorkspaceDocsStore } from '../stores/workspaceDocs'
import { useSettingsStore } from '../stores/settings'
import { confirmDiscardIfDirty } from '../lib/dialog'
import Icon from './Icon.vue'

// ─── 文件列表视图（Typora 式侧边栏「列表」）────────────────────────────────
// 展示工作区全部 Markdown 文章的扁平列表。视觉遵循 Typora 侧边栏语言：
// 条目之间用 1px 细分隔线分区（容器上边框 + 每行下边框，--edge-strong），
// hover / 选中态用整块底色区分；元数据（所在文件夹、修改时间）与后缀标签
// 整体弱化，去后缀的文件名为视觉主体，正文预览最多两行。
// 数据来自主进程一次递归扫描（docsStore.docs，由 workspace 结构变化/保存就地
// 刷新失效，见 files store）。
const { t } = useI18n()
const files = useFilesStore()
// 列表视图的数据与失效世代在 workspaceDocs store（从 files store 拆出来的派生缓存）
const docsStore = useWorkspaceDocsStore()
const settings = useSettingsStore()

const props = defineProps<{ filter: string }>()

// 扫描触发：进入列表 / 根目录切换 / 结构失效世代变化 / 手动刷新
const forceTick = ref(0)
watch(
  () => [files.root, docsStore.epoch, forceTick.value],
  () => void docsStore.load(),
  { immediate: true }
)

const items = computed(() => {
  const q = props.filter.trim().toLowerCase()
  let list = docsStore.docs
  if (q) {
    list = list.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.relPath.toLowerCase().includes(q) ||
        d.preview.toLowerCase().includes(q)
    )
  }
  return list
})

const currentPath = computed(() => files.current?.path ?? null)

/** 工作区根目录短名（根目录下文件的「所在文件夹」回退显示用） */
const rootShortName = computed(() =>
  files.root ? files.root.split(/[\\/]/).filter(Boolean).pop() || '' : ''
)

/**
 * 文件名 → { base, ext }：ext 为末尾扩展名（小写、带点），无扩展名返回空串。
 * 只认「点 + 1~9 位字母开头的字母数字」，因此 `第1章.初稿`、`.gitignore`、`v1.2`
 * 这类不会被误拆。
 */
function splitName(name: string): { base: string; ext: string } {
  const m = /\.([A-Za-z][A-Za-z0-9]{0,8})$/.exec(name)
  if (!m || m.index === 0) return { base: name, ext: '' }
  return { base: name.slice(0, m.index), ext: '.' + m[1].toLowerCase() }
}

/** 行内标题 = 去掉扩展名的文件名 */
function titleOf(doc: { name: string }): string {
  return splitName(doc.name).base
}

/** 行内后缀标签（.md / .txt / .markdown …），无后缀返回空串 */
function extOf(doc: { name: string }): string {
  return splitName(doc.name).ext
}

/** 行内「所在文件夹」标签：子目录显示相对路径；根目录下回退显示工作区名 */
function folderOf(doc: { relPath: string }): string {
  return doc.relPath || rootShortName.value
}

/** 修改时间格式化（本地化短格式；完整时间放 title）——响应语言切换 */
const timeFmt = computed(
  () =>
    new Intl.DateTimeFormat(settings.language, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
)
const timeTitleFmt = computed(
  () =>
    new Intl.DateTimeFormat(settings.language, {
      dateStyle: 'medium',
      timeStyle: 'medium'
    })
)

async function openDoc(path: string): Promise<void> {
  // 打开另一篇文档前先问（唯一实现在 lib/dialog）
  if (!(await confirmDiscardIfDirty(() => files.dirty && files.current?.path !== path))) return
  if (await files.openPath(path)) {
    document.dispatchEvent(new CustomEvent('lumin:file-opened'))
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶栏：文章数 + 刷新（Typora 式极简弱化） -->
    <div class="flex flex-none items-center gap-2 px-3 pb-1.5">
      <span class="flex-1 truncate text-[11px] text-ink-3/80">
        {{ t('sidebar.docsCount', { n: items.length }) }}
      </span>
      <button
        class="icon-btn !h-6 !w-6 opacity-60 hover:opacity-100"
        :title="t('sidebar.refresh')"
        @click="forceTick++"
      >
        <Icon name="refresh" :size="13" />
      </button>
    </div>

    <!-- 滚动列表 -->
    <div class="min-h-0 flex-1 overflow-y-auto px-0 pb-4">
      <div
        v-if="docsStore.loading && !docsStore.docs.length"
        class="mt-8 flex items-center justify-center gap-2 px-4 text-[12px] text-ink-3"
      >
        <Icon name="refresh" :size="13" class="animate-spin" style="animation-duration: 1.2s" />
        {{ t('sidebar.loading') }}
      </div>

      <!-- 列表条目用分割线分区：容器上边框 + 每行下边框，1px 实线（--edge-strong） -->
      <TransitionGroup
        v-else-if="items.length"
        name="list"
        tag="div"
        class="flex flex-col border-t border-edge-strong"
      >
        <button
          v-for="doc in items"
          :key="doc.path"
          class="group flex w-full cursor-pointer flex-col border-b border-edge-strong px-3 py-2.5 text-left transition-colors duration-150"
          :class="doc.path === currentPath ? 'bg-accent-soft' : 'hover:bg-panel-2'"
          style="min-height: 96px"
          :title="`${doc.relPath ? doc.relPath + '/' : ''}${doc.name}\n${t('sidebar.modifiedAt', { time: timeTitleFmt.format(doc.mtimeMs) })}`"
          @click="openDoc(doc.path)"
        >
          <!-- 元数据行：所在文件夹（左）· 修改时间（右），整体弱化 -->
          <span class="flex items-baseline justify-between gap-2 text-[10.5px] leading-none">
            <span
              class="truncate"
              :class="doc.path === currentPath ? 'text-accent/75' : 'text-ink-3/75'"
            >
              {{ folderOf(doc) }}
            </span>
            <span
              class="flex-none tabular-nums"
              :class="doc.path === currentPath ? 'text-accent/70' : 'text-ink-3/60'"
            >
              {{ timeFmt.format(doc.mtimeMs) }}
            </span>
          </span>

          <!-- 标题：视觉主体（去后缀文件名 + 弱化后缀标签） -->
          <span class="mt-1.5 flex min-w-0 items-center gap-1.5">
            <Icon
              name="file"
              :size="13"
              class="flex-none"
              :class="doc.path === currentPath ? 'text-accent/80' : 'text-ink-3/60'"
            />
            <span
              class="truncate text-[12.5px] font-medium tracking-[-0.01em]"
              :class="doc.path === currentPath ? 'text-accent' : 'text-ink'"
            >
              {{ titleOf(doc) }}
            </span>
            <span
              v-if="extOf(doc)"
              class="flex-none text-[10.5px] leading-none"
              :class="doc.path === currentPath ? 'text-accent/60' : 'text-ink-3/65'"
            >
              {{ extOf(doc) }}
            </span>
          </span>

          <!-- 正文预览：次要信息，最多两行 -->
          <span
            v-if="doc.preview"
            class="mt-1.5 line-clamp-2 text-[11.5px] leading-[1.6] text-ink-3/90"
          >
            {{ doc.preview }}
          </span>
        </button>
      </TransitionGroup>

      <div
        v-else
        class="mt-10 flex flex-col items-center gap-2.5 px-4 text-center text-[12px] leading-relaxed text-ink-3"
      >
        <Icon name="file" :size="24" :stroke-width="1.3" class="text-ink-3/50" />
        <p v-if="props.filter">
          {{ t('sidebar.noMatch') }}
        </p>
        <p v-else>
          {{ t('sidebar.listEmpty') }}<br />
          {{ t('sidebar.listEmptyHint') }}
        </p>
      </div>
    </div>
  </div>
</template>
