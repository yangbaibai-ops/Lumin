<script setup lang="ts">
// ─── 设置：**整页**（占据整个界面，不再是浮在窗口上的小盒子）────────────────────
//
// 用户口径：「打开设置界面不要弹出一个小的窗口在原窗口的上方，而是占据整个界面，
// 同时重构优化下设置的样式」。所以：
//   * 根节点是 `fixed inset-0` 的不透明整页（顶栏 + 左导航 + 纸面内容区），
//     **没有遮罩层**（后面没有东西需要压暗，整页自己就是那层）；
//   * 去掉了「拖动小窗」那一整套（dragOffset / startDialogDrag / is-dragging 样式）——
//     整页没有可拖的意义；
//   * 样式收口成一组 class（`.settings-*`，见 assets/base.css）：卡片、行、说明文字
//     不再逐处写 Tailwind 长串，六个页签观感一致。
// 所有设置项仍经 settings store（SQLite kv 持久化）读写，原生菜单栏/自动保存等即时同步主进程。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { FONT_OPTIONS } from '../../../shared/defaults'
import { ENCODINGS, type EncodingId } from '../../../shared/encodings'
import { EOL_OPTIONS, eolLabel, type Eol } from '../../../shared/eol'

/** 本地历史的可选项（保留策略见 shared/history.ts；这里只给几档常用值） */
const HISTORY_LIMIT_CHOICES = [10, 20, 30, 50, 100]
const HISTORY_AGE_CHOICES = [7, 30, 90, 365]
import { LANGUAGE_OPTIONS } from '../i18n'
import type { EditorMode, LinkCreateMode, LinkHistoryEntry, ThemeMode } from '../../../shared/types'
import Icon from '../components/Icon.vue'
import SettingsKeymap from '../components/SettingsKeymap.vue'
import SettingsToolbar from '../components/SettingsToolbar.vue'

const router = useRouter()
const { t } = useI18n()
const settings = useSettingsStore()
const files = useFilesStore()
const ui = useUiStore()

/** 页签：文案统一走 i18n（settings.* 命名空间，三语言同步维护） */
const tabs = computed(() => [
  { id: 'general', label: t('settings.general'), icon: 'settings' },
  { id: 'editor', label: t('settings.editor'), icon: 'pencil' },
  { id: 'appearance', label: t('settings.appearance'), icon: 'sun' },
  { id: 'keymap', label: t('settings.keymap'), icon: 'keyboard' },
  { id: 'export', label: t('settings.export'), icon: 'download' },
  { id: 'links', label: t('settings.links'), icon: 'link' }
])

/** 语言选项（由 i18n/LANGUAGE_OPTIONS 单一数据源驱动，便于扩展新语言） */
const languageOptions = LANGUAGE_OPTIONS

const activeTab = computed(() => {
  const t0 = String(ui.settingsSection ?? 'general')
  return tabs.value.some((x) => x.id === t0) ? t0 : 'general'
})

function switchTab(id: string): void {
  ui.settingsSection = id
}

/** 顶部菜单栏开关：控制应用内菜单栏（TopMenuBar）显隐，持久化即可 */
function toggleMenuBar(): void {
  settings.set('nativeMenuBar', !settings.nativeMenuBar)
}

/**
 * 大纲放在编辑区右侧（三栏）。
 * 打开时顺手把右侧面板设为展开、并把左栏页签收回「文件」——
 * 否则开完开关看到的可能是「左栏还停在大纲页签」或「右侧大纲是折叠的窄轨」，
 * 与「打开就能同时看到目录和大纲」的预期不符。
 */
function toggleOutlineRight(): void {
  const on = !settings.outlineOnRight
  settings.set('outlineOnRight', on)
  if (on) {
    settings.set('outlineRightExpanded', true)
    ui.sidebarTab = 'files'
  }
}

/** 自动保存开关：关闭时取消未触发的磁盘定时器（草稿崩溃保护不受影响） */
function toggleAutoSave(): void {
  const v = !settings.autoSave
  settings.set('autoSave', v)
  if (!v) files.cancelAutoSave()
}

// ─── 关于页入口 ──────────────────────────────────────────────────────────────
// 顶栏那一枚「关于 Lumin」：先收起设置再走路由（否则设置整页会把关于页盖住）
function goAbout(): void {
  ui.closeSettings()
  void router.push('/about')
}

// Esc 关闭（打开时才生效）
function onKeydown(e: KeyboardEvent): void {
  if (ui.settingsOpen && e.key === 'Escape') ui.closeSettings()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// 切到「链接」页签时读取历史（每次打开设置面板都刷新，避免看到过期数据）
watch(
  () => [ui.settingsOpen, activeTab.value] as const,
  ([open, tab]) => {
    if (open && tab === 'links') void loadLinkHistory()
  },
  { immediate: true }
)

// 打开时：自动保存关着的清掉挂起的落盘定时器，避免「刚关掉设置又保存一次」
// （链接历史的刷新在上面那个 [settingsOpen, activeTab] 的 watch 里，别重复写两处）
watch(
  () => ui.settingsOpen,
  (open) => {
    if (!open) return
    if (!settings.autoSave) files.cancelAutoSave()
  }
)

const themes: { mode: ThemeMode; icon: string; label: string; desc: string; colors: string[] }[] = [
  {
    mode: 'auto',
    icon: 'monitor',
    label: '跟随系统',
    desc: '随系统外观自动切换',
    colors: ['#f5f6f8', '#0f1116']
  },
  {
    mode: 'light',
    icon: 'sun',
    label: '浅色',
    desc: '明亮清爽的日间主题',
    colors: ['#f5f6f8', '#ffffff']
  },
  {
    mode: 'dark',
    icon: 'moon',
    label: '深色',
    desc: '护眼的夜间主题',
    colors: ['#0f1116', '#16181f']
  },
  {
    mode: 'sepia',
    icon: 'book',
    label: '羊皮纸',
    desc: '温暖的阅读护眼模式',
    colors: ['#f1e9d5', '#faf4e4']
  }
]

const modes: { mode: EditorMode; icon: string; label: string; desc: string }[] = [
  { mode: 'wysiwyg', icon: 'eye', label: '实时渲染', desc: '所见即所得，点击块即可编辑' },
  { mode: 'split', icon: 'columns', label: '分屏对比', desc: '左右实时对比渲染与源码，拖拽调比例' },
  { mode: 'source', icon: 'source', label: '源码模式', desc: '显示原始 Markdown 语法' }
]

function sectionTitle(id: string): string {
  const x = tabs.value.find((y) => y.id === id)
  return x ? x.label : ''
}

// ─── 链接：创建策略 + 打开历史（SQLite link_history，CRUD）────────────────────
const createModes: { value: LinkCreateMode; labelKey: string; icon: string }[] = [
  { value: 'ask', labelKey: 'settings.linksAsk', icon: 'info' },
  { value: 'always', labelKey: 'settings.linksAlways', icon: 'check' },
  { value: 'never', labelKey: 'settings.linksNever', icon: 'x' }
]

const linkHistory = ref<LinkHistoryEntry[]>([])

async function loadLinkHistory(): Promise<void> {
  try {
    linkHistory.value = await window.luminAPI.links.history(50)
  } catch {
    linkHistory.value = []
  }
}

async function forgetLink(target: string): Promise<void> {
  await window.luminAPI.links.forget(target).catch(() => {})
  await loadLinkHistory()
}

async function clearLinkHistory(): Promise<void> {
  await window.luminAPI.links.clear().catch(() => 0)
  await loadLinkHistory()
}

/** 历史记录的动作/类型徽章文案 */
function linkActionLabel(action: string): string {
  if (action === 'external') return t('links.actionExternal')
  if (action === 'window') return t('links.actionWindow')
  if (action === 'default-app') return t('links.actionDefault')
  return t('links.actionDeclined')
}

function linkKindLabel(kind: string): string {
  if (kind === 'url') return t('links.kindUrl')
  if (kind === 'relative') return t('links.kindRelative')
  if (kind === 'absolute') return t('links.kindAbsolute')
  return t('links.kindFile')
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <Teleport to="body">
    <!-- 设置 = **整页**（用户口径：不要弹一个小窗口盖在原窗口上）。
         `fixed inset-0` + 不透明底色 ⇒ 顶栏/侧栏/正文全被盖住，没有遮罩层、也不可拖动。
         z-[120] 与原来的浮层同档：通知带（z 更高）仍然浮在它上面，确认框（z-[150]）照样能弹。 -->
    <!-- 设置 = **整页**，而且**只有一条滚动条**（就是页面自己那条）。
         用户口径：「不要有限制组件 … 它有自己的滚动条，而不是整个界面的滚动条」——
         所以这里不再有内层 `overflow-y: auto` 的滚动容器：整页滚动，顶栏与左导航吸顶。 -->
    <div
      v-if="ui.settingsOpen"
      class="settings-page fixed inset-0 z-[120] bg-app text-ink"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.title')"
      data-settings-page
    >
      <!-- 顶栏：整页的身份与出口（左边是「设置」，右边是「关于」与关闭）。
           `sticky` ⇒ 页面滚动时它一直可见（关设置的出口不该被滚走）。 -->
      <header class="settings-topbar sticky top-0 z-10 flex h-12 items-center border-b border-edge">
        <div class="settings-wrap flex items-center justify-between px-6">
          <div class="flex min-w-0 items-center gap-2">
            <Icon name="settings" :size="15" class="flex-none text-ink-3" />
            <h1 class="text-[14px] font-semibold text-ink">{{ t('settings.title') }}</h1>
            <span class="ml-2 hidden truncate text-[11.5px] text-ink-3 sm:inline">
              {{ t('settings.persistHint') }}
            </span>
          </div>
          <div class="flex flex-none items-center gap-1">
            <button class="settings-topbar-btn" @click="goAbout">
              <Icon name="info" :size="14" />
              {{ t('menu.about') }}
            </button>
            <button
              class="settings-topbar-btn settings-topbar-btn--close"
              data-settings-close
              :title="t('common.close')"
              @click="ui.closeSettings()"
            >
              <Icon name="x" :size="15" />
              {{ t('common.close') }}
            </button>
          </div>
        </div>
      </header>

      <!-- 主体：两栏直接铺在界面上（无卡片外框），整页一起滚动 ⇒ 只有一条滚动条。
           左导航 `sticky` 吸顶：滚动长页签时它一直可见（Typora 的页签列表也是常驻的）。 -->
      <div class="flex px-6 pt-16">
        <div class="settings-card">
          <!-- 左导航 -->
          <nav class="settings-nav" :aria-label="t('settings.title')">
            <button
              v-for="x in tabs"
              :key="x.id"
              class="settings-nav-item"
              :class="{ 'is-active': activeTab === x.id }"
              :aria-current="activeTab === x.id ? 'page' : undefined"
              @click="switchTab(x.id)"
            >
              <Icon :name="x.icon" :size="15" class="flex-none" />
              <span class="min-w-0 flex-1 truncate">{{ x.label }}</span>
            </button>
          </nav>

          <!-- 内容区：与导航同一底色（--app），设置项直接列在界面上。
               **没有内层滚动容器** —— 长页签由整页那条滚动条滚（用户口径）。 -->
          <div class="settings-body min-w-0 flex-1">
            <div class="settings-column px-8 pb-12 pt-1">
              <h2 class="settings-section-title">{{ sectionTitle(activeTab) }}</h2>
              <Transition name="page" mode="out-in">
                <div :key="activeTab">
                  <!-- ── 通用 ──
                       用户口径：「该展示的展示，该折叠的折叠 … 尽可能简约简介」。
                       原来是 7 张单行卡片 + 2 张散卡（很长一列，滚动半天）；现在按主题合并成
                       3 张卡（界面 / 保存与会话 / 文本与编码）+ 1 个折叠块（高级），
                       低频与信息性的内容（详细说明、自动检查更新）默认收起。 -->
                  <template v-if="activeTab === 'general'">
                    <section class="set-card">
                      <h3 class="set-card-title">界面</h3>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">界面语言</p>
                        </div>
                        <div class="flex rounded-lg bg-panel-2 p-0.5">
                          <button
                            v-for="opt in languageOptions"
                            :key="opt.value"
                            class="rounded-md px-3 py-1 text-[12.5px] font-medium transition-all"
                            :class="
                              settings.language === opt.value
                                ? 'bg-panel text-ink shadow-sm'
                                : 'text-ink-3 hover:text-ink-2'
                            "
                            @click="settings.setLanguage(opt.value)"
                          >
                            {{ opt.label }}
                          </button>
                        </div>
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">侧边栏</p>
                          <p class="set-row-desc">启动时显示左侧边栏</p>
                        </div>
                        <button
                          class="switch"
                          :class="{ on: settings.sidebarVisible }"
                          :aria-label="'侧边栏'"
                          @click="settings.set('sidebarVisible', !settings.sidebarVisible)"
                        />
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">顶部菜单栏</p>
                          <p class="set-row-desc">关闭后界面更纯净（快捷键照常生效）</p>
                        </div>
                        <button
                          class="switch"
                          :class="{ on: settings.nativeMenuBar }"
                          @click="toggleMenuBar"
                        />
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.outlineRight') }}</p>
                          <p class="set-row-desc">三栏布局：目录与大细同时可见（可折叠）</p>
                        </div>
                        <button
                          class="switch"
                          :class="{ on: settings.outlineOnRight }"
                          :aria-checked="settings.outlineOnRight"
                          role="switch"
                          :aria-label="t('settings.outlineRight')"
                          @click="toggleOutlineRight"
                        />
                      </div>
                    </section>

                    <section class="set-card">
                      <h3 class="set-card-title">保存与会话</h3>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">自动保存</p>
                          <p class="set-row-desc">手动模式下用 Ctrl+S / 状态栏保存</p>
                        </div>
                        <button
                          class="switch"
                          :class="{ on: settings.autoSave }"
                          @click="toggleAutoSave"
                        />
                      </div>
                      <div v-if="settings.autoSave" class="set-row">
                        <p class="set-row-desc">间隔</p>
                        <div class="flex flex-1 items-center gap-3">
                          <input
                            type="range"
                            class="range flex-1"
                            min="1"
                            max="30"
                            :aria-label="'自动保存间隔'"
                            :value="settings.autoSaveInterval"
                            @input="
                              settings.set(
                                'autoSaveInterval',
                                Number(($event.target as HTMLInputElement).value)
                              )
                            "
                          />
                          <span class="w-9 text-right text-[12px] text-ink-2"
                            >{{ settings.autoSaveInterval }}s</span
                          >
                        </div>
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.restoreSession') }}</p>
                          <p class="set-row-desc">恢复上次的文档、光标与滚动位置</p>
                        </div>
                        <button
                          class="switch"
                          :class="{ on: settings.restoreSession }"
                          :aria-checked="settings.restoreSession"
                          :aria-label="t('settings.restoreSession')"
                          @click="settings.set('restoreSession', !settings.restoreSession)"
                        />
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.historyEnabled') }}</p>
                          <p class="set-row-desc">每次保存前留一份可回滚的快照</p>
                        </div>
                        <button
                          class="switch"
                          :class="{ on: settings.historyEnabled }"
                          :aria-label="t('settings.historyEnabled')"
                          data-setting-history-switch
                          @click="settings.set('historyEnabled', !settings.historyEnabled)"
                        />
                      </div>
                      <!-- 保留策略只在历史开着时出现（关掉时它是灰的、白白占两行） -->
                      <div v-if="settings.historyEnabled" class="set-row" data-setting-history>
                        <p class="set-row-desc">{{ t('settings.historyLimit') }}</p>
                        <div class="flex gap-2">
                          <select
                            class="input select !w-[110px] shrink-0"
                            :value="String(settings.historyLimitPerFile)"
                            :aria-label="t('settings.historyLimit')"
                            data-setting-history-limit
                            @change="
                              settings.set(
                                'historyLimitPerFile',
                                Number(($event.target as HTMLSelectElement).value)
                              )
                            "
                          >
                            <option v-for="n in HISTORY_LIMIT_CHOICES" :key="n" :value="String(n)">
                              {{ n }}
                            </option>
                          </select>
                          <select
                            class="input select !w-[130px] shrink-0"
                            :value="String(settings.historyMaxAgeDays)"
                            :aria-label="t('settings.historyMaxAge')"
                            data-setting-history-age
                            @change="
                              settings.set(
                                'historyMaxAgeDays',
                                Number(($event.target as HTMLSelectElement).value)
                              )
                            "
                          >
                            <option v-for="d in HISTORY_AGE_CHOICES" :key="d" :value="String(d)">
                              {{ t('settings.historyDays', { days: d }) }}
                            </option>
                          </select>
                        </div>
                      </div>
                    </section>

                    <section class="set-card">
                      <h3 class="set-card-title">文本与编码</h3>
                      <div class="set-row">
                        <p class="set-row-label">{{ t('settings.defaultEncoding') }}</p>
                        <select
                          class="input select !w-[190px] shrink-0"
                          :value="settings.defaultEncoding"
                          :aria-label="t('settings.defaultEncoding')"
                          @change="
                            settings.set(
                              'defaultEncoding',
                              ($event.target as HTMLSelectElement).value as EncodingId
                            )
                          "
                        >
                          <option value="auto">{{ t('encoding.auto') }}</option>
                          <option v-for="e in ENCODINGS" :key="e.id" :value="e.id">
                            {{ e.label }}
                          </option>
                        </select>
                      </div>
                      <div class="set-row">
                        <p class="set-row-label">{{ t('settings.defaultEol') }}</p>
                        <select
                          class="input select !w-[190px] shrink-0"
                          :value="settings.defaultEol"
                          :aria-label="t('settings.defaultEol')"
                          data-setting-eol
                          @change="
                            settings.set(
                              'defaultEol',
                              ($event.target as HTMLSelectElement).value as Eol
                            )
                          "
                        >
                          <option v-for="o in EOL_OPTIONS" :key="o" :value="o">
                            {{ eolLabel(o) }}
                          </option>
                        </select>
                      </div>
                      <!-- 详细说明默认收起：它是"要不要看"的信息，不是每次都要读的 -->
                      <details class="set-fold set-fold--plain">
                        <summary>
                          <Icon name="chevron-right" :size="13" class="set-fold-chevron" />
                          <span class="set-fold-hint">编码与行尾说明</span>
                        </summary>
                        <div class="set-fold-body">
                          <p class="set-row-desc">{{ t('settings.encodingHint') }}</p>
                          <p class="set-row-desc">{{ t('settings.defaultEolHint') }}</p>
                        </div>
                      </details>
                    </section>

                    <!-- 高级：低频项集中在这里，默认收起 -->
                    <details class="set-fold">
                      <summary>
                        <Icon name="chevron-right" :size="13" class="set-fold-chevron" />
                        高级
                      </summary>
                      <div class="set-fold-body">
                        <div class="set-row">
                          <div>
                            <p class="set-row-label">{{ t('settings.autoCheckUpdate') }}</p>
                            <p class="set-row-desc">仅打包版且配置了更新渠道时生效</p>
                          </div>
                          <button
                            class="switch"
                            :class="{ on: settings.autoCheckUpdate }"
                            :aria-checked="settings.autoCheckUpdate"
                            :aria-label="t('settings.autoCheckUpdate')"
                            @click="settings.set('autoCheckUpdate', !settings.autoCheckUpdate)"
                          />
                        </div>
                      </div>
                    </details>
                  </template>

                  <!-- ── 编辑器 ── -->
                  <template v-else-if="activeTab === 'editor'">
                    <!-- 快捷工具栏：开关常显；19 项排序/显隐是低频操作，收在折叠里（SettingsToolbar 内部） -->
                    <SettingsToolbar />

                    <section class="set-card">
                      <h3 class="set-card-title">默认编辑器模式</h3>
                      <div class="grid grid-cols-3 gap-2.5">
                        <button
                          v-for="m in modes"
                          :key="m.mode"
                          class="rounded-xl border px-3 py-3 text-center transition-all duration-150"
                          :class="
                            settings.editorMode === m.mode
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-edge text-ink-2 hover:border-edge-strong hover:text-ink'
                          "
                          :title="m.desc"
                          @click="settings.set('editorMode', m.mode)"
                        >
                          <Icon :name="m.icon" :size="16" class="mx-auto" />
                          <span class="mt-1.5 block text-[12.5px] font-medium">{{ m.label }}</span>
                        </button>
                      </div>
                      <p class="set-row-desc mt-3">
                        {{ modes.find((m) => m.mode === settings.editorMode)?.desc }}
                      </p>
                    </section>

                    <section class="set-card">
                      <h3 class="set-card-title">编辑行为</h3>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">分屏同步滚动</p>
                          <p class="set-row-desc">左右两侧按滚动进度同步</p>
                        </div>
                        <button
                          class="switch"
                          :class="{ on: settings.syncScroll }"
                          :aria-label="'分屏同步滚动'"
                          @click="settings.set('syncScroll', !settings.syncScroll)"
                        />
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">代码块行号</p>
                          <p class="set-row-desc">在代码块左侧显示行号</p>
                        </div>
                        <button
                          class="switch"
                          :class="{ on: settings.codeLineNumbers }"
                          :aria-label="'代码块行号'"
                          @click="settings.set('codeLineNumbers', !settings.codeLineNumbers)"
                        />
                      </div>
                    </section>

                    <!-- 字体与排版 + 就地预览：合成一张卡（预览就在滑杆下面，改一下立刻看到） -->
                    <section class="set-card">
                      <h3 class="set-card-title">字体与排版</h3>
                      <div class="set-row">
                        <p class="set-row-desc">字号</p>
                        <div class="flex flex-1 items-center gap-3">
                          <input
                            type="range"
                            class="range flex-1"
                            min="13"
                            max="26"
                            aria-label="字号"
                            :value="settings.fontSize"
                            @input="
                              settings.set(
                                'fontSize',
                                Number(($event.target as HTMLInputElement).value)
                              )
                            "
                          />
                          <span class="w-10 text-right text-[12px] text-ink-2"
                            >{{ settings.fontSize }}px</span
                          >
                        </div>
                      </div>
                      <div class="set-row">
                        <p class="set-row-desc">行高</p>
                        <div class="flex flex-1 items-center gap-3">
                          <input
                            type="range"
                            class="range flex-1"
                            min="1.3"
                            max="2.6"
                            step="0.1"
                            aria-label="行高"
                            :value="settings.lineHeight"
                            @input="
                              settings.set(
                                'lineHeight',
                                Number(($event.target as HTMLInputElement).value)
                              )
                            "
                          />
                          <span class="w-10 text-right text-[12px] text-ink-2">{{
                            settings.lineHeight.toFixed(1)
                          }}</span>
                        </div>
                      </div>
                      <div class="set-row">
                        <p class="set-row-desc">正文字体</p>
                        <div class="flex gap-1.5">
                          <button
                            v-for="f in FONT_OPTIONS"
                            :key="f.label"
                            class="rounded-lg border px-3 py-1.5 text-[12.5px] transition-all duration-150"
                            :class="
                              settings.fontFamily === f.value
                                ? 'border-accent bg-accent-soft text-accent'
                                : 'border-edge text-ink-2 hover:border-edge-strong'
                            "
                            @click="settings.set('fontFamily', f.value)"
                          >
                            {{
                              f.label === 'sans' ? '无衬线' : f.label === 'serif' ? '衬线' : '等宽'
                            }}
                          </button>
                        </div>
                      </div>
                      <!-- 就地预览：一小块纸（与真实写作区同色），随上面三个滑杆/按钮即时变化 -->
                      <div
                        class="md-preview mt-4 rounded-xl border border-edge bg-paper px-4 py-3"
                        :style="{
                          '--editor-size': settings.fontSize + 'px',
                          '--editor-lh': String(settings.lineHeight),
                          '--editor-font': settings.fontFamily
                        }"
                      >
                        <p style="margin: 0">
                          正文预览：所见即所得，支持 <strong>加粗</strong>、<em>斜体</em> 与
                          <code>行内代码</code>。
                        </p>
                      </div>
                    </section>
                  </template>

                  <!-- ── 外观 ── -->
                  <template v-else-if="activeTab === 'appearance'">
                    <section class="set-card">
                      <h3 class="set-card-title">主题</h3>
                      <div class="grid grid-cols-4 gap-2.5">
                        <button
                          v-for="th in themes"
                          :key="th.mode"
                          class="group overflow-hidden rounded-xl border text-left transition-all duration-200"
                          :class="
                            settings.theme === th.mode
                              ? 'border-accent'
                              : 'border-edge hover:border-edge-strong'
                          "
                          :style="
                            settings.theme === th.mode
                              ? { boxShadow: '0 3px 12px var(--glow)' }
                              : {}
                          "
                          :title="th.desc"
                          @click="settings.setTheme(th.mode)"
                        >
                          <div
                            class="flex h-12 items-center justify-center"
                            :style="{ background: th.colors[0] }"
                          >
                            <div
                              class="h-7 w-12 rounded-md border border-black/5"
                              :style="{ background: th.colors[1] }"
                            >
                              <div
                                class="mt-1.5 h-1 w-7 rounded-sm bg-black/15"
                                style="margin-left: 4px"
                              />
                              <div
                                class="mt-1 h-1 w-9 rounded-sm bg-black/10"
                                style="margin-left: 4px"
                              />
                            </div>
                          </div>
                          <div class="flex items-center gap-2 border-t border-edge px-2.5 py-2">
                            <Icon
                              :name="th.icon"
                              :size="13"
                              :class="settings.theme === th.mode ? 'text-accent' : 'text-ink-3'"
                            />
                            <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink">{{
                              th.label
                            }}</span>
                            <Icon
                              v-if="settings.theme === th.mode"
                              name="check"
                              :size="12"
                              class="text-accent"
                            />
                          </div>
                        </button>
                      </div>
                      <p class="set-row-desc mt-3">{{ t('settings.themeDesc') }}</p>
                    </section>
                  </template>

                  <!-- ── 导出 ── -->
                  <template v-else-if="activeTab === 'export'">
                    <section class="set-card">
                      <h3 class="set-card-title">PDF 导出</h3>
                      <div class="set-row">
                        <p class="set-row-desc">页边距</p>
                        <div class="flex flex-1 items-center gap-3">
                          <input
                            type="range"
                            class="range flex-1"
                            min="8"
                            max="50"
                            aria-label="页边距"
                            :value="settings.export.pdf.margin"
                            @input="
                              settings.set('export', {
                                ...settings.export,
                                pdf: {
                                  ...settings.export.pdf,
                                  margin: Number(($event.target as HTMLInputElement).value)
                                }
                              })
                            "
                          />
                          <span class="w-11 text-right text-[12px] text-ink-2"
                            >{{ settings.export.pdf.margin }}mm</span
                          >
                        </div>
                      </div>
                      <div class="set-row">
                        <p class="set-row-desc">页面尺寸</p>
                        <div class="flex gap-1.5">
                          <button
                            v-for="size in ['A4', 'A5', 'Letter'] as const"
                            :key="size"
                            class="rounded-lg border px-3.5 py-1.5 text-[12.5px] transition-all duration-150"
                            :class="
                              settings.export.pdf.pageSize === size
                                ? 'border-accent bg-accent-soft text-accent'
                                : 'border-edge text-ink-2 hover:border-edge-strong'
                            "
                            @click="
                              settings.set('export', {
                                ...settings.export,
                                pdf: { ...settings.export.pdf, pageSize: size }
                              })
                            "
                          >
                            {{ size }}
                          </button>
                        </div>
                      </div>
                    </section>

                    <!-- 支持的格式是「查一次就够」的信息 ⇒ 折叠（用户口径：该折叠的折叠） -->
                    <details class="set-fold">
                      <summary>
                        <Icon name="chevron-right" :size="13" class="set-fold-chevron" />
                        支持的格式
                        <span class="set-fold-hint">PDF · HTML · Word · EPUB</span>
                      </summary>
                      <div class="set-fold-body">
                        <div class="space-y-2">
                          <div
                            v-for="row in [
                              { icon: 'file', name: 'PDF', desc: '矢量排版，适合打印与分享' },
                              { icon: 'code', name: 'HTML', desc: '保留样式与交互的网页文件' },
                              { icon: 'file', name: 'Word (.doc)', desc: 'Word 可直接打开编辑' },
                              { icon: 'book', name: 'EPUB', desc: '标准 epub 3 电子书格式' }
                            ]"
                            :key="row.name"
                            class="flex items-center gap-3 rounded-xl border border-edge px-3.5 py-2"
                          >
                            <span
                              class="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent"
                            >
                              <Icon :name="row.icon" :size="13" />
                            </span>
                            <p class="min-w-0 flex-1 text-[12.5px] text-ink">{{ row.name }}</p>
                            <p class="truncate text-[11.5px] text-ink-3">{{ row.desc }}</p>
                          </div>
                        </div>
                        <p class="set-row-desc mt-3">在编辑器工具栏点击「导出」即可使用。</p>
                      </div>
                    </details>
                  </template>

                  <!-- 链接：Ctrl/Cmd+左键打开链接时的行为与历史 -->
                  <template v-else-if="activeTab === 'keymap'">
                    <SettingsKeymap />
                  </template>

                  <template v-else-if="activeTab === 'links'">
                    <section class="set-card">
                      <h3 class="mb-1 text-[13.5px] text-ink">
                        {{ t('settings.linksCreateMode') }}
                      </h3>
                      <p class="mb-4 text-[12px] text-ink-3">
                        {{ t('settings.linksCreateModeDesc') }}
                      </p>
                      <div class="grid grid-cols-3 gap-2">
                        <button
                          v-for="m in createModes"
                          :key="m.value"
                          class="flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[13px] transition-all duration-150"
                          :class="
                            settings.linkCreateMode === m.value
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-edge text-ink-2 hover:border-edge-strong hover:text-ink'
                          "
                          :aria-pressed="settings.linkCreateMode === m.value"
                          @click="settings.set('linkCreateMode', m.value)"
                        >
                          <Icon :name="m.icon" :size="14" />
                          <span>{{ t(m.labelKey) }}</span>
                        </button>
                      </div>
                    </section>

                    <section class="set-card">
                      <!-- 历史是「查一下」的列表 ⇒ 折叠（用户口径：该折叠的折叠）。
                           标题本身就是这一卡的全部标签（不再重复一遍行标题），条数跟在后面。 -->
                      <details class="set-fold set-fold--plain" data-links-history-fold>
                        <summary>
                          <Icon name="chevron-right" :size="13" class="set-fold-chevron" />
                          {{ t('settings.linksHistory') }}
                          <span class="set-fold-hint">{{ linkHistory.length }}</span>
                        </summary>
                        <div class="set-fold-body">
                          <div class="mb-3 flex items-center justify-between gap-3">
                            <p class="set-row-desc">{{ t('settings.linksHistoryDesc') }}</p>
                            <button
                              v-if="linkHistory.length"
                              class="flex-none rounded-lg border border-edge px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
                              @click="clearLinkHistory()"
                            >
                              {{ t('settings.linksClear') }}
                            </button>
                          </div>
                          <p
                            v-if="!linkHistory.length"
                            class="rounded-xl border border-dashed border-edge px-3.5 py-6 text-center text-[12.5px] text-ink-3"
                          >
                            {{ t('settings.linksHistoryEmpty') }}
                          </p>

                          <TransitionGroup
                            v-else
                            name="link-row"
                            tag="div"
                            class="relative space-y-2"
                          >
                            <div
                              v-for="item in linkHistory"
                              :key="item.target"
                              class="flex items-center gap-3 rounded-xl border border-edge px-3.5 py-2"
                            >
                              <span
                                class="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-panel-2 text-ink-3"
                              >
                                <Icon name="link" :size="13" />
                              </span>
                              <div class="min-w-0 flex-1">
                                <p class="truncate text-[13px] text-ink" :title="item.target">
                                  {{ item.target }}
                                </p>
                                <p
                                  class="mt-0.5 truncate text-[11.5px] text-ink-3"
                                  :title="item.path ?? ''"
                                >
                                  {{ formatTime(item.lastUsed) }} ·
                                  {{ t('settings.linksCount', { count: item.count }) }}
                                </p>
                              </div>
                              <span
                                class="flex-none rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-3"
                              >
                                {{ linkKindLabel(item.kind) }}
                              </span>
                              <span
                                class="flex-none rounded-md px-1.5 py-0.5 text-[11px]"
                                :class="
                                  item.action === 'declined'
                                    ? 'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning'
                                    : 'bg-accent-soft text-accent'
                                "
                              >
                                {{ linkActionLabel(item.action) }}
                              </span>
                              <span
                                v-if="item.created"
                                class="flex-none rounded-md bg-[color-mix(in_srgb,var(--ok)_16%,transparent)] px-1.5 py-0.5 text-[11px] text-ok"
                              >
                                {{ t('settings.linksCreatedBadge') }}
                              </span>
                              <button
                                class="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-panel-2 hover:text-danger"
                                :title="t('settings.linksForget')"
                                @click="forgetLink(item.target)"
                              >
                                <Icon name="trash" :size="13" />
                              </button>
                            </div>
                          </TransitionGroup>
                        </div>
                      </details>
                    </section>
                  </template>
                </div>
              </Transition>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
