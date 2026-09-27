<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { SAMPLE_DOC_KEY } from '../lib/onboarding'
import Icon from './Icon.vue'

/**
 * ─── 首次引导块（侧栏文件区的空态）────────────────────────────────────────────
 *
 * 挂在 `FileTree.vue` 里，但**什么时候出现由纯函数 `shouldShowOnboarding` 说了算**
 * （那边算，这边只负责画）：没有任何工作区、也没有真正在编辑的东西时才出现，
 * 有工作区或有文档时组件根本不渲染。判据与它的单测见 `lib/onboarding.ts` 与
 * `tests/onboarding.test.mjs`。
 *
 * 三个入口，克制到只有三个按钮：
 *   1. **新建文件** —— `files.openUntitled()`：未命名缓冲，**不碰磁盘**（Ctrl+S 时才问存哪）；
 *   2. **打开文件夹** —— `files.openFolder()`：系统选择器 + 建工作区，就是菜单里那一条；
 *   3. **插入示例文档** —— 把内置示例 Markdown 灌进**未命名缓冲**（`openUntitled` +
 *      `setContent` 的既有路径）。**绝不静默落盘**：文案里明说"保存时才写进文件"，
 *      而且插入前先问一句 —— 这一下会替换掉当前缓冲区的内容（未保存草稿除外的那类损失
 *      不该由一次"试用示例"造成）。
 *
 * 键盘可达性：三个都是原生 `<button>`（Tab 顺序进入、Enter/Space 触发），每个都有
 * `title` + `aria-label`（图标按钮的读屏名字），焦点环**不删**（不写 `outline: none`，
 * 走浏览器默认焦点环）。
 */
const { t } = useI18n()
const files = useFilesStore()
const ui = useUiStore()

/** 新建：未命名缓冲（与 Ctrl+N 的"无工作区分支"同一条路径，见 files.newDocInWorkspace） */
async function onNewFile(): Promise<void> {
  await files.openUntitled()
}

/** 打开文件夹：走 store 的公开 action（选择器 + setRoot + 最近文件夹都在它里面） */
async function onOpenFolder(): Promise<void> {
  await files.openFolder()
}

/**
 * 插入示例：确认 → 未命名缓冲 → 灌入示例正文。
 *
 * 为什么用 `ui.confirm` 而不是直接插：这一下会**替换当前缓冲区**。空态下缓冲区是空白的
 * （判据保证），但"输入法/粘贴刚写进去一个字的那一瞬间"仍然存在 —— 那一个字是用户的，
 * 不能由一次点击悄悄吃掉。确认框里说清"会替换当前未保存的内容"。
 */
async function onInsertSample(): Promise<void> {
  const ok = await ui.confirm({
    title: t('onboarding.sampleTitle'),
    body: t('onboarding.sampleReplace')
  })
  if (!ok) return
  await files.openUntitled()
  files.setContent(t(SAMPLE_DOC_KEY), 'external')
}
</script>

<template>
  <section
    class="flex flex-col gap-3 px-4 pb-4 pt-6"
    data-sidebar-onboarding
    :aria-label="t('onboarding.title')"
  >
    <Icon name="sparkles" :size="22" :stroke-width="1.3" class="text-ink-3" aria-hidden="true" />
    <div class="flex flex-col gap-1.5">
      <h2 class="text-ui font-medium tracking-[-0.01em] text-ink">{{ t('onboarding.title') }}</h2>
      <p class="text-ui-sm leading-relaxed text-ink-2b">{{ t('onboarding.body') }}</p>
    </div>

    <div class="flex flex-col gap-1.5">
      <button
        type="button"
        class="btn btn-outline w-full px-3 py-1.5 text-ui-sm"
        :title="t('onboarding.newFile')"
        :aria-label="t('onboarding.newFile')"
        @click="onNewFile"
      >
        <Icon name="file-plus" :size="13" aria-hidden="true" />
        <span>{{ t('onboarding.newFile') }}</span>
      </button>
      <button
        type="button"
        class="btn btn-outline w-full px-3 py-1.5 text-ui-sm"
        :title="t('onboarding.openFolder')"
        :aria-label="t('onboarding.openFolder')"
        @click="onOpenFolder"
      >
        <Icon name="folder" :size="13" aria-hidden="true" />
        <span>{{ t('onboarding.openFolder') }}</span>
      </button>
      <button
        type="button"
        class="btn btn-primary w-full px-3 py-1.5 text-ui-sm"
        :title="t('onboarding.insertSample')"
        :aria-label="t('onboarding.insertSample')"
        @click="onInsertSample"
      >
        <Icon name="book" :size="13" aria-hidden="true" />
        <span>{{ t('onboarding.insertSample') }}</span>
      </button>
    </div>

    <p class="text-ui-sm leading-relaxed text-ink-2b">{{ t('onboarding.sampleNote') }}</p>
  </section>
</template>
