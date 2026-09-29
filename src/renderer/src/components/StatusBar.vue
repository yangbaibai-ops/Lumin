<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useWorkspaceDocsStore } from '../stores/workspaceDocs'
import { LANGUAGE_OPTIONS, nextLanguage } from '../i18n'
import { encodingOf } from '../../../shared/encodings'
import { eolLabel } from '../../../shared/eol'
import { formatTagsInput, parseTagsInput } from '../lib/tags'
import {
  CJK_CHARS_PER_MINUTE,
  LATIN_WORDS_PER_MINUTE,
  readingMinutesOf,
  splitReadingMinutes,
  wordGoalProgress
} from '../../../shared/readingTime'
import Icon from './Icon.vue'
import type { ThemeMode } from '../../../shared/types'

const { t } = useI18n()
const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()

// ─── 当前文档的标签（SQLite `documents.tags`）────────────────────────────────
// 审计 §7 第 19 条：标签的 DB 与 IPC 早就有，**界面一处都没有**。
// 读：`db.getDocument(path)`（返回 DocMeta，含 tags）；写：`db.setTags(path, tags)`。
// 未落盘的文档没有 DB 行 —— 这时按钮给一句"先保存"，而不是静默无反应。
const docTags = ref<string[]>([])

async function loadTags(): Promise<void> {
  const p = files.current?.path
  if (!p) {
    docTags.value = []
    return
  }
  try {
    const meta = await window.luminAPI.db.getDocument(p)
    docTags.value = meta?.tags ?? []
  } catch {
    docTags.value = []
  }
}
// 换文档 / 首次保存（有了路径）都要重新读
watch(
  () => files.current?.path ?? null,
  () => void loadTags(),
  { immediate: true }
)

const tagsLabel = computed(() =>
  docTags.value.length ? docTags.value.join(' · ') : t('statusbar.addTags')
)

/** 编辑标签：一个输入框，逗号分隔（解析与去重在 lib/tags.ts） */
async function editTags(): Promise<void> {
  const p = files.current?.path
  if (!p) {
    ui.toast(t('toast.tagsNeedSave'), 'warning')
    return
  }
  const input = await ui.prompt(
    t('statusbar.tagsTooltip'),
    t('statusbar.tagsPlaceholder'),
    formatTagsInput(docTags.value)
  )
  if (input === null || input === undefined) return
  const tags = parseTagsInput(input)
  try {
    await window.luminAPI.db.setTags(p, tags)
    docTags.value = tags
    // 列表视图的标签来自工作区扫描的缓存 → 标脏让它下次进入时重扫
    useWorkspaceDocsStore().invalidate()
  } catch (err) {
    ui.toast(
      t('toast.tagsFailed', { reason: err instanceof Error ? err.message : String(err) }),
      'error'
    )
  }
}

const langShort = computed(
  () => LANGUAGE_OPTIONS.find((o) => o.value === settings.language)?.short ?? 'EN'
)

/** 当前文档的编码名（专有名，不走 i18n；文档本身没打开时整块不渲染） */
const currentEncodingLabel = computed(() => {
  const id = files.current?.encoding
  return id ? (encodingOf(id)?.label ?? String(id)) : ''
})

/** 当前文档的行尾标记（LF / CRLF）——点一下就在两者间切换并写回 */
const currentEolLabel = computed(() => eolLabel(files.current?.eol ?? 'lf'))

// ─── 阅读时长 / 目标字数（审计清单「目标字数 / 阅读时长」）──────────────────────
// 两个口径都由 shared/readingTime.ts 的纯函数决定（中文 ~400 字/分钟、拉丁 ~200 词/分钟，
// 混排时分别计时再相加；空文档 0 分钟、非空至少 1 分钟），这里只负责取数与拼文案。
const readingTimeLabel = computed(() => {
  // 走 store 里**已缓存**的拆分计数（files.textMeasure），不在这里重扫全文：
  // 状态栏每敲一个键就要重算，而字数的缓存已经扫过一遍了（见 stores/files.ts 的 countsOf）
  const total = readingMinutesOf(files.textMeasure)
  if (total <= 0) return ''
  const { hours, minutes } = splitReadingMinutes(total)
  if (hours === 0) return t('statusbar.readingTime', { n: minutes })
  if (minutes === 0) return t('statusbar.readingTimeHours', { h: hours })
  return t('statusbar.readingTimeHourMin', { h: hours, m: minutes })
})

/** 悬停说明速率：「这个 5 分钟是怎么算出来的」必须查得到，否则它只是个没来由的数字 */
const readingTimeTooltip = computed(() =>
  t('statusbar.readingTimeTooltip', { cjk: CJK_CHARS_PER_MINUTE, latin: LATIN_WORDS_PER_MINUTE })
)

/**
 * 目标字数（设置里 0 = 未设置 ⇒ 这一格整块不渲染，没设目标的人不该多看到一个 0）。
 *
 * 达成提示**不用弹窗、不发通知**：写作中途弹一次框正是"打断打字"的那类打扰；
 * 这一格转强调色 + 显示对勾已是常驻的醒目反馈（抬眼就在那儿），且随时可以再点开设置改目标。
 */
const goal = computed(() => wordGoalProgress(files.wordCount, settings.wordGoal))
const goalLabel = computed(() =>
  t('statusbar.wordGoal', { current: files.wordCount, goal: settings.wordGoal })
)
const goalTooltip = computed(() => {
  const args = {
    current: files.wordCount,
    goal: settings.wordGoal,
    percent: Math.round(goal.value.ratio * 100)
  }
  return goal.value.reached
    ? t('statusbar.wordGoalReachedTooltip', args)
    : t('statusbar.wordGoalTooltip', args)
})

const themeOpen = ref(false)
const themeRef = ref<HTMLElement | null>(null)
const version = ref('')

function onDocClick(e: MouseEvent): void {
  if (themeOpen.value && themeRef.value && !themeRef.value.contains(e.target as Node)) {
    themeOpen.value = false
  }
}
onMounted(async () => {
  document.addEventListener('mousedown', onDocClick)
  version.value = await window.luminAPI.app.getVersion()
})
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))

/**
 * 状态栏**不再有"保存状态"那一格**（用户口径，见 §4.81）。
 *
 * 原先最左边那格写着「保存中 / 未保存的更改 / 已保存」，点开还能切「自动保存 / 手动保存」。
 * 本轮整块去掉：
 *   * 保存结果本身已经在别处有反馈 —— 保存成功是"内容落盘 + 标题栏脏标记消失"，
 *     失败会往通知中心留一张**持久卡片**（`files.saveNow` 那条路），
 *     而"正在保存"这种瞬时态不值得常驻一行文字；
 *   * 保存方式改在「设置 → 通用 → 自动保存」里选（唯一入口，不再两处并存）。
 * 于是保存方式的弹层与它的三个 i18n 键（`statusbar.saveMode` / `autoSave` / `manualSave` …）
 * 一起删除 —— 留着就是零引用的死键（`tests/i18nKeys.test.mjs` 会红）。
 */

/** 主题弹层里选一种主题 */
function pickTheme(mode: ThemeMode): void {
  settings.setTheme(mode)
  themeOpen.value = false
}

const themes: { mode: ThemeMode; icon: string; labelKey: string }[] = [
  { mode: 'auto', icon: 'monitor', labelKey: 'settings.themeAuto' },
  { mode: 'light', icon: 'sun', labelKey: 'settings.themeLight' },
  { mode: 'dark', icon: 'moon', labelKey: 'settings.themeDark' },
  { mode: 'sepia', icon: 'book', labelKey: 'settings.themeSepia' }
]
</script>

<template>
  <!-- 整条状态栏**透明**（用户口径）：不铺自己的底色、也不画顶上那条分隔线，
       于是它不再是"压在页面底下的一条带子"，只剩一行贴在背景上的信息。
       好处是上面那块「纸」（`bg-paper`）与外壳的过渡不再被一条线切断；
       代价是极窄窗口下这一行与正文之间没有硬边界 —— 用户明确要的就是这个观感。 -->
  <div
    class="flex h-7 shrink-0 items-center gap-3 bg-transparent px-3 text-[11.5px] text-ink-2b"
    data-status-bar
  >
    <span v-if="!files.current">Lumin — Write in Light.</span>

    <div class="flex-1" />

    <!-- 中间：统计 -->
    <template v-if="files.current">
      <span class="tabular-nums">{{ files.wordCount }} {{ t('editor.words') }}</span>
      <!--
        目标字数（审计清单「目标字数 / 阅读时长」）：只在设置里填了目标时出现，显示「当前/目标」。
        达成时转强调色 + 加一个对勾 —— **不用弹窗、不发通知**（见脚本里 goal 的说明）。
        点一下直接进设置（和保存状态那格弹层里的「打开设置…」同一个入口口径）。
      -->
      <button
        v-if="goal.set"
        class="flex items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-panel-2"
        :class="goal.reached ? 'text-accent-ink' : ''"
        :title="goalTooltip"
        :aria-label="goalTooltip"
        :data-word-goal-reached="goal.reached ? '1' : undefined"
        data-status-word-goal
        @click="ui.openSettings('editor')"
      >
        <Icon v-if="goal.reached" name="check" :size="11" class="flex-none" />
        <span>{{ goalLabel }}</span>
      </button>
      <!--
        读屏器播报：达成目标在视觉上只是"这一格变色了"，看不见的人不会知道。
        但**不能**把 aria-live 挂在上面那格上 —— 它每敲一个字都变，会把每次按键都念出来。
        所以单开一个常驻的 live region，只在达成时才有文字（空文本不播报）。
      -->
      <span class="sr-only" role="status" aria-live="polite">{{
        goal.reached ? t('statusbar.wordGoalReached') : ''
      }}</span>
      <span class="tabular-nums">{{ files.lineCount }} {{ t('editor.lines') }}</span>
      <span class="hidden tabular-nums sm:inline"
        >{{ files.charCount }} {{ t('editor.chars') }}</span
      >
      <!-- 预计阅读时长（口径与速率见 shared/readingTime.ts；悬停可查速率） -->
      <span
        v-if="readingTimeLabel"
        class="flex items-center gap-1 tabular-nums"
        :title="readingTimeTooltip"
        data-status-reading-time
      >
        <Icon name="clock" :size="12" class="flex-none" />
        <span>{{ readingTimeLabel }}</span>
      </span>
      <span class="h-3 w-px bg-edge" />
      <span class="tabular-nums">{{
        t('editor.cursor', { line: ui.cursor.line, col: ui.cursor.col })
      }}</span>
    </template>

    <div class="flex-1" />

    <!-- 当前文档编码（次要信息：夹在统计与主题切换之间，只读展示 + tooltip） -->
    <span
      v-if="files.current"
      class="flex items-center gap-1 tabular-nums"
      :class="files.current.hadReplacement ? 'text-warning-ink' : ''"
      :title="
        files.current.hadReplacement
          ? t('statusbar.encodingReplaced')
          : t('statusbar.encodingTooltip')
      "
      :data-encoding-replaced="files.current.hadReplacement ? '1' : undefined"
      data-status-encoding
    >
      <Icon name="globe" :size="12" />
      <span>{{ currentEncodingLabel }}</span>
    </span>

    <!--
      行尾：**可点**（LF ⇄ CRLF，点击即按新行尾写回）。
      为什么放状态栏而不只放菜单：行尾是「打开→保存会不会整文件 diff」的直接原因，
      用户需要一眼看到它、并且一键改掉（见 shared/eol.ts 与 stores/files.setEol）。
    -->
    <button
      v-if="files.current"
      class="flex items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-panel-2 hover:text-ink-2"
      :title="t('statusbar.eolTooltip', { eol: currentEolLabel })"
      data-status-eol
      @click="files.toggleEol()"
    >
      <Icon name="align-left" :size="12" />
      <span>{{ currentEolLabel }}</span>
    </button>

    <!--
      标签：**唯一编辑入口**（审计 §7 第 19 条：标签的 DB/IPC 早就有、界面一处都没有）。
      放在状态栏的文档信息区（与编码/行尾同处）：它是文档级元数据，点一下即可改。
      列表视图会把这些标签画在每条上，并按标签过滤。
    -->
    <button
      v-if="files.current"
      class="flex max-w-[220px] items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
      :title="t('statusbar.tagsTooltip')"
      :aria-label="t('statusbar.tagsTooltip')"
      data-status-tags
      @click="editTags()"
    >
      <Icon name="tag" :size="12" class="flex-none" />
      <span class="truncate">{{ tagsLabel }}</span>
    </button>

    <!-- 右侧：主题 / 语言 -->
    <div ref="themeRef" class="relative flex items-center">
      <button
        class="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
        @click="themeOpen = !themeOpen"
      >
        <Icon
          :name="themes.find((th) => th.mode === settings.theme)?.icon || 'monitor'"
          :size="13"
        />
        <span>{{
          t(themes.find((th) => th.mode === settings.theme)?.labelKey || 'settings.themeAuto')
        }}</span>
        <Icon
          name="chevron-down"
          :size="11"
          :class="themeOpen ? 'rotate-180 transition-transform' : 'transition-transform'"
        />
      </button>
      <Transition name="pop">
        <div
          v-if="themeOpen"
          class="absolute bottom-8 right-0 z-50 w-[160px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
          :style="{ boxShadow: 'var(--shadow-2)' }"
        >
          <button
            v-for="th in themes"
            :key="th.mode"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
            :class="
              settings.theme === th.mode
                ? 'bg-accent-soft text-accent-ink'
                : 'text-ink hover:bg-panel-2'
            "
            @click="pickTheme(th.mode)"
          >
            <Icon :name="th.icon" :size="14" />
            {{ t(th.labelKey) }}
            <Icon v-if="settings.theme === th.mode" name="check" :size="13" class="ml-auto" />
          </button>
        </div>
      </Transition>
    </div>

    <button
      class="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
      :title="langShort + ' · ' + t('statusbar.switchLanguage')"
      @click="settings.setLanguage(nextLanguage(settings.language))"
    >
      <Icon name="globe" :size="13" />
      <span>{{ langShort }}</span>
    </button>

    <span class="text-ink-3/70">v{{ version }}</span>
  </div>
</template>
