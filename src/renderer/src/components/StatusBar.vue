<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useWorkspaceDocsStore } from '../stores/workspaceDocs'
import { LANGUAGE_OPTIONS } from '../i18n'
import { encodingOf } from '../../../shared/encodings'
import { eolLabel } from '../../../shared/eol'
import { formatTagsInput, parseTagsInput } from '../lib/tags'
import { wordGoalProgress } from '../../../shared/readingTime'
import { toggleSpellcheckLanguage, ZH_SPELLCHECK_LANGUAGE } from '../../../shared/spellcheck'
import { exportStartupDiagnostics } from '../lib/startupDiagnostics'
import Icon from './Icon.vue'
import type { Language, ThemeMode } from '../../../shared/types'

const { t } = useI18n()
const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()
const router = useRouter()

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

/**
 * 标签格上显示的**就是标签本身**（`小说 · 第一章`）。
 *
 * ⚠️ 这一格**只在有标签时出现**（用户口径）：没标签时不占位、不写"添加标签" ——
 * 状态栏只放"当前状态"，不放"可以做什么"。所以"第一次加标签"的入口搬到了右侧的
 * `⋯` 菜单（`statusbar.addTags` 那一项），那里也是唯一不依赖"已经有标签"的入口。
 */
const tagsLabel = computed(() => docTags.value.join(' · '))

/** 编辑标签：一个输入框，逗号分隔（解析与去重在 lib/tags.ts） */
async function editTags(): Promise<void> {
  menuOpen.value = false
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

/** 当前文档的编码名（专有名，不走 i18n；文档本身没打开时整块不渲染） */
const currentEncodingLabel = computed(() => {
  const id = files.current?.encoding
  return id ? (encodingOf(id)?.label ?? String(id)) : ''
})

/** 当前文档的行尾标记（LF / CRLF）——点一下就在两者间切换并写回 */
const currentEolLabel = computed(() => eolLabel(files.current?.eol ?? 'lf'))

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

/**
 * 右侧那个 `⋯`：**视图与入口的唯一出口**（用户口径：左=文档，右=视图与入口 + 一个 ⋯）。
 *
 * 它承载的都是"低频、但必须到得了"的东西：主题、语言、加标签、设置、关于。
 * 把它们从这一行上摘下来的理由是同一条 —— 状态栏只放"会变化的状态"，
 * 主题/语言是设置、标签编辑是动作、关于是入口，常驻在那里只会让这一行变成控制台。
 */
const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)
/** `⋯` 触发按钮：Esc 关闭菜单后焦点要还给它（ARIA menu 的标准行为） */
const moreBtnRef = ref<HTMLButtonElement | null>(null)
const languageOptions = LANGUAGE_OPTIONS

/** 菜单里的可聚焦项（按 DOM 顺序） */
function menuItems(): HTMLElement[] {
  return Array.from(menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
}

/** 关菜单：默认把焦点还给触发按钮（报告 §5.2：浮层要有菜单语义 + Esc/方向键） */
function closeMenu(refocus = true): void {
  menuOpen.value = false
  if (refocus) void nextTick(() => moreBtnRef.value?.focus())
}

function toggleMenu(): void {
  if (menuOpen.value) {
    closeMenu(false)
    return
  }
  menuOpen.value = true
  // 打开即把焦点给第一项：键盘用户按 Enter 打开后可以直接上下选（鼠标用户也符合平台惯例）
  void nextTick(() => menuItems()[0]?.focus())
  // 日志路径按需取（打开菜单时才 IPC，不占启动路径）
  void loadLogPaths()
}

/**
 * 日志路径（状态栏「更多」菜单里展示）：用户报「启动慢/闪退」时，界面上直接能看到
 * `startup.log` 在哪、该发哪个文件。主进程算好路径返回，渲染层不拼路径。
 */
const logPaths = ref<{ dir: string; app: string; startup: string } | null>(null)
async function loadLogPaths(): Promise<void> {
  if (logPaths.value) return
  try {
    logPaths.value = await window.luminAPI.app.getLogPaths()
  } catch {
    /* 诊断信息拿不到不影响使用 */
  }
}

/** 「导出启动诊断」（与设置页/帮助菜单共用同一份实现，见 lib/startupDiagnostics.ts） */
function exportDiagnosticsFromMenu(): void {
  menuOpen.value = false
  void exportStartupDiagnostics()
}

/**
 * 菜单键盘导航：↑↓ 循环、Home/End 到两端、Esc 关闭并把焦点还给触发按钮。
 * 为什么值得写：这是一个十来项的浮层菜单，没有这套语义时键盘用户只能 Tab 走一遍全部项。
 */
function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMenu()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = menuItems()
  if (!items.length) return
  e.preventDefault()
  const cur = items.indexOf(document.activeElement as HTMLElement)
  let next = items.length - 1
  if (e.key === 'ArrowDown') next = (cur + 1) % items.length
  else if (e.key === 'ArrowUp') next = cur <= 0 ? items.length - 1 : cur - 1
  else if (e.key === 'Home') next = 0
  items[next]?.focus()
}

function onDocClick(e: MouseEvent): void {
  if (menuOpen.value && menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))

/** 主题弹层里选一种主题 */
function pickTheme(mode: ThemeMode): void {
  settings.setTheme(mode)
  menuOpen.value = false
}

/** 语言：选一种即切换（同设置页那一组按钮，走 settings.setLanguage） */
function pickLanguage(value: Language): void {
  settings.setLanguage(value)
  menuOpen.value = false
}

function openSettingsFromMenu(): void {
  menuOpen.value = false
  ui.openSettings('general')
}

function openAboutFromMenu(): void {
  menuOpen.value = false
  void router.push('/about')
}

// ─── 拼写检查快捷设置（`⋯` 菜单里；与设置卡同一份 settings store）──────────────
// 为什么放在这里：拼写检查是"写作时会随手开关"的东西，进设置页太深；
// 但完整语言清单仍在设置卡里（这里只给中文/英文两个常用项 + 「更多语言…」）。
interface SpellState {
  enabled: boolean
  /** Chromium 当前真正生效的语言（用户没手选时用它显示勾选态） */
  languages: string[]
  available: string[]
}

const spellState = ref<SpellState | null>(null)

/** 界面上的"已选"口径与设置卡完全一致：用户选过看持久化，没选过看真正生效的 */
const spellEffective = computed<string[]>(() =>
  settings.spellcheckLanguages.length > 0
    ? settings.spellcheckLanguages
    : (spellState.value?.languages ?? [])
)
const spellZhChecked = computed(() => spellEffective.value.some((code) => /^zh(-|$)/i.test(code)))
const spellEnChecked = computed(() => spellEffective.value.some((code) => /^en(-|$)/i.test(code)))

async function refreshSpellState(): Promise<void> {
  try {
    spellState.value = await window.luminAPI.spell.getState()
  } catch {
    spellState.value = null
  }
}

/** 开关：settings store 立即生效；主进程在 settings:update 里同步 Chromium */
function setSpellcheckEnabled(value: boolean): void {
  settings.set('spellcheckEnabled', value)
  void settings.flush().then(refreshSpellState)
}

/** 快捷语言勾选：与设置卡共用 toggleSpellcheckLanguage（不能把最后一个也取消） */
function toggleQuickSpellLanguage(code: string): void {
  const next = toggleSpellcheckLanguage(spellEffective.value, code)
  if (next === null) {
    ui.toast(t('settings.spellcheckKeepOne'), 'info')
    return
  }
  settings.set('spellcheckLanguages', next)
  void settings.flush().then(refreshSpellState)
}

/** 「更多语言…」：设置卡里的拼写检查区在「编辑器」页 */
function openSpellSettings(): void {
  menuOpen.value = false
  ui.openSettings('editor')
}

// 从设置页/主进程改过之后，状态栏这边的勾选态要跟着走（两处同一份 store + 同一次查询）
watch(
  () => [settings.spellcheckEnabled, settings.spellcheckLanguages.length] as const,
  () => void refreshSpellState()
)
onMounted(() => void refreshSpellState())

const themes: { mode: ThemeMode; icon: string; labelKey: string }[] = [
  { mode: 'auto', icon: 'monitor', labelKey: 'settings.themeAuto' },
  { mode: 'light', icon: 'sun', labelKey: 'settings.themeLight' },
  { mode: 'dark', icon: 'moon', labelKey: 'settings.themeDark' },
  { mode: 'sepia', icon: 'book', labelKey: 'settings.themeSepia' }
]

/**
 * 状态栏的历史口径（都写在手册里，免得后来人按老文档改回去）：
 *   * §4.81 去掉最左那格「保存状态」（保存中/未保存的更改/已保存 + 保存方式弹层）；
 *   * §4.83 去掉版本号、语言切换、主题切换、预计阅读时长，并把标签格改成"有标签才显示"，
 *     整条重排为「左=文档（统计/目标/标签）｜右=视图与入口（行列/编码/行尾 + ⋯）」。
 * 阅读时长的**口径与纯函数**保留在 `shared/readingTime.ts`（仍被目标字数共用、单测仍在），
 * 只是不再在界面上显示。
 */
</script>

<template>
  <!-- 整条状态栏用**纸**色（`bg-paper`）：与菜单栏 / 快捷工具栏 / 写作区同一块纸色，
       整个窗口只剩左侧栏是外壳灰（用户口径的最终口径 —— "一张纸到底"，见 §4.82）。
       这里经历过两版：先是透明（透出外壳色，看着是一条淡灰带子），
       再按"要么一张纸、要么全外壳色"的判据收敛到纸色。
       **顶上不画分隔线**（`border-t` 保持没有）：这一行是信息，不是一条"带子"，
       与正文之间靠留白区分即可；上方的两条栏各自有 `border-b` 发丝线，足够交代边界。 -->
  <div
    class="flex h-7 shrink-0 items-center gap-2.5 bg-paper px-3 text-[11.5px] text-ink-2b"
    data-status-bar
  >
    <!-- 标语只在"没打开文档"时出现（打开文档后这一格让给统计信息）；
         它走语言包而不是硬编码（报告 §5.4 P2-2）：三语的文案**都是这句英文**品牌语，
         但至少它现在是"可翻译的"，而不是模板里一段谁也管不到的字符串。 -->
    <span v-if="!files.current">{{ t('app.name') }} — {{ t('app.tagline') }}</span>

    <!-- ── 左：文档（统计 / 目标 / 标签）────────────────────────────────────
         全部是"这一篇是什么"的信息，会随打字变化；一眼扫过去就能读完。 -->
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
      <!--
        标签：**只在有标签时出现**（用户口径；没标签就不占位、不写"添加标签"）。
        有标签时它是**编辑入口**（点开同一个逗号分隔的输入框）；第一次加标签走右侧 `⋯` 菜单，
        那条入口不依赖"已经有标签"，所以不会出现"没标签就永远加不上"的死角。
        列表视图会把这些标签画在每条上，并按标签过滤。
      -->
      <button
        v-if="docTags.length"
        class="flex max-w-[220px] items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
        :title="t('statusbar.tagsTooltip')"
        :aria-label="t('statusbar.tagsTooltip')"
        data-status-tags
        @click="editTags()"
      >
        <Icon name="tag" :size="12" class="flex-none" />
        <span class="truncate">{{ tagsLabel }}</span>
      </button>
    </template>

    <div class="flex-1" />

    <!-- ── 右：视图与入口（行列 / 编码 / 行尾 + `⋯`）─────────────────────────
         这里全是"怎么看这一篇"以及偶尔要改的技术元信息；最后那个 `⋯` 是低频入口的唯一出口
         （主题、语言、加标签、设置、关于），这样这一行本身只留"会变化的状态"。 -->
    <template v-if="files.current">
      <span class="tabular-nums">{{
        t('editor.cursor', { line: ui.cursor.line, col: ui.cursor.col })
      }}</span>

      <!-- 当前文档编码（只读展示 + tooltip；有替换字符时转警示色） -->
      <span
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
        class="flex items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-panel-2 hover:text-ink-2"
        :title="t('statusbar.eolTooltip', { eol: currentEolLabel })"
        data-status-eol
        @click="files.toggleEol()"
      >
        <Icon name="align-left" :size="12" />
        <span>{{ currentEolLabel }}</span>
      </button>

      <span class="h-3 w-px bg-edge" />
    </template>

    <!-- ── `⋯`：低频入口。**始终在**（不受"有没有文档"影响）───────────────────
         主题 / 语言 / 设置这些跟当前文档无关，没有文档时也得够得着；菜单向上弹（它在窗口最底边）。 -->
    <div ref="menuRef" class="relative flex items-center">
      <button
        ref="moreBtnRef"
        class="flex items-center rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
        :title="t('statusbar.more')"
        :aria-label="t('statusbar.more')"
        :aria-expanded="menuOpen"
        aria-haspopup="menu"
        data-status-more
        @click="toggleMenu"
      >
        <Icon name="more" :size="14" />
      </button>
      <Transition name="pop">
        <div
          v-if="menuOpen"
          class="absolute bottom-7 right-0 z-[var(--z-popover)] w-[188px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
          :style="{ boxShadow: 'var(--shadow-2)' }"
          role="menu"
          :aria-label="t('statusbar.more')"
          data-status-more-menu
          @keydown="onMenuKeydown"
        >
          <p
            class="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-2b"
          >
            {{ t('settings.appearance') }}
          </p>
          <button
            v-for="th in themes"
            :key="th.mode"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
            :class="
              settings.theme === th.mode
                ? 'bg-accent-soft text-accent-ink'
                : 'text-ink hover:bg-panel-2'
            "
            role="menuitem"
            :data-more-theme="th.mode"
            @click="pickTheme(th.mode)"
          >
            <Icon :name="th.icon" :size="14" />
            {{ t(th.labelKey) }}
            <Icon v-if="settings.theme === th.mode" name="check" :size="13" class="ml-auto" />
          </button>

          <div class="my-1 border-t border-edge" />
          <p
            class="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-2b"
          >
            {{ t('settings.language') }}
          </p>
          <button
            v-for="opt in languageOptions"
            :key="opt.value"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
            :class="
              settings.language === opt.value
                ? 'bg-accent-soft text-accent-ink'
                : 'text-ink hover:bg-panel-2'
            "
            role="menuitem"
            :data-more-language="opt.value"
            @click="pickLanguage(opt.value)"
          >
            <Icon name="globe" :size="14" />
            {{ opt.label }}
            <Icon v-if="settings.language === opt.value" name="check" :size="13" class="ml-auto" />
          </button>

          <div class="my-1 border-t border-edge" />
          <p
            class="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-2b"
          >
            {{ t('statusbar.spellcheck') }}
          </p>
          <!-- 开关：勾选态直接绑定 settings（与设置卡同一个 store，立即双向同步） -->
          <button
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
            :class="
              settings.spellcheckEnabled
                ? 'bg-accent-soft text-accent-ink'
                : 'text-ink hover:bg-panel-2'
            "
            role="menuitem"
            data-more-spellcheck
            @click="setSpellcheckEnabled(!settings.spellcheckEnabled)"
          >
            <Icon :name="settings.spellcheckEnabled ? 'check' : 'dot'" :size="14" />
            <span class="flex-1">{{ t('settings.spellcheckEnabled') }}</span>
            <Icon v-if="settings.spellcheckEnabled" name="check" :size="13" class="ml-auto" />
          </button>
          <!-- 快捷语言：中文（启发式，非词典）/ English（Chromium 词典），可同时勾选 -->
          <button
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
            :class="spellZhChecked ? 'bg-accent-soft text-accent-ink' : 'text-ink hover:bg-panel-2'"
            role="menuitem"
            data-more-spell-zh
            :title="t('settings.spellcheckZhNote')"
            @click="toggleQuickSpellLanguage(ZH_SPELLCHECK_LANGUAGE)"
          >
            <Icon name="globe" :size="14" />
            <span class="flex-1">{{ t('statusbar.spellcheckZh') }}</span>
            <Icon v-if="spellZhChecked" name="check" :size="13" class="ml-auto" />
          </button>
          <button
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
            :class="spellEnChecked ? 'bg-accent-soft text-accent-ink' : 'text-ink hover:bg-panel-2'"
            role="menuitem"
            data-more-spell-en
            @click="toggleQuickSpellLanguage('en-US')"
          >
            <Icon name="globe" :size="14" />
            <span class="flex-1">{{ t('statusbar.spellcheckEn') }}</span>
            <Icon v-if="spellEnChecked" name="check" :size="13" class="ml-auto" />
          </button>
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-sm text-ink-2b transition-colors hover:bg-panel-2 hover:text-ink-2"
            role="menuitem"
            data-more-spell-more
            @click="openSpellSettings"
          >
            <Icon name="settings" :size="12" />
            {{ t('statusbar.spellcheckMore') }}
          </button>

          <div class="my-1 border-t border-edge" />
          <!-- 加标签是"文档属性"，没打开文档时这一项不出现（否则点了只会得到一句"先保存"） -->
          <button
            v-if="files.current"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-sm text-ink-2b transition-colors hover:bg-panel-2 hover:text-ink-2"
            role="menuitem"
            data-more-edit-tags
            @click="editTags()"
          >
            <Icon name="tag" :size="12" />
            {{ t('statusbar.addTags') }}
          </button>
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-sm text-ink-2b transition-colors hover:bg-panel-2 hover:text-ink-2"
            role="menuitem"
            data-more-settings
            @click="openSettingsFromMenu"
          >
            <Icon name="settings" :size="12" />
            {{ t('menu.settings') }}
          </button>
          <!-- 版本号从这一行挪走了（用户口径）：它现在只在「关于」里出现，
                 这里给的是**到关于的入口**，不再显示 `v1.0.0`。 -->
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-sm text-ink-2b transition-colors hover:bg-panel-2 hover:text-ink-2"
            role="menuitem"
            data-more-about
            @click="openAboutFromMenu"
          >
            <Icon name="info" :size="12" />
            {{ t('menu.about') }}
          </button>
          <div class="my-1 border-t border-edge" />
          <!-- 启动诊断：入口与设置页/帮助菜单同一份实现；下面一行是日志路径（脱敏后展示） -->
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-sm text-ink-2b transition-colors hover:bg-panel-2 hover:text-ink-2"
            role="menuitem"
            data-more-export-startup
            @click="exportDiagnosticsFromMenu"
          >
            <Icon name="download" :size="12" />
            {{ t('menu.exportStartupDiagnostics') }}
          </button>
          <p
            v-if="logPaths?.startup"
            class="max-w-64 break-all px-2.5 pb-1 text-ui-sm leading-snug text-ink-3/70"
            data-more-startup-log-path
            :title="logPaths.startup"
          >
            {{ logPaths.startup }}
          </p>
        </div>
      </Transition>
    </div>
  </div>
</template>
