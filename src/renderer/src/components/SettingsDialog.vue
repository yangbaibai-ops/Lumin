<script setup lang="ts">
// ─── 设置：浮层（Modal）面板 ────────────────────────────────────────────────
// 覆盖在项目视图之上，带遮罩与 X / Esc / 点击遮罩关闭——不再占据路由与整页，
// 提供大厂主流的「模态设置中心」交互。所有设置项均经由 settings store
// （SQLite kv 持久化）读写；原生菜单栏/自动保存等系统级设置即时同步主进程。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { FONT_OPTIONS } from '../../../shared/defaults'
import { LANGUAGE_OPTIONS } from '../i18n'
import type { EditorMode, LinkCreateMode, LinkHistoryEntry, ThemeMode } from '../../../shared/types'
import Icon from '../components/Icon.vue'

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

/** 自动保存开关：关闭时取消未触发的磁盘定时器（草稿崩溃保护不受影响） */
function toggleAutoSave(): void {
  const v = !settings.autoSave
  settings.set('autoSave', v)
  if (!v) files.cancelAutoSave()
}

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

// 打开时记住上一次所在分组（复用 ui.settingsSection）
watch(
  () => ui.settingsOpen,
  (open) => {
    if (!open) return
    // 自动保存关闭时清理挂起的落盘定时器，避免“刚关闭又保存”
    if (!settings.autoSave) files.cancelAutoSave()
  }
)

const themes: { mode: ThemeMode; icon: string; label: string; desc: string; colors: string[] }[] = [
  { mode: 'auto', icon: 'monitor', label: '跟随系统', desc: '随系统外观自动切换', colors: ['#f5f6f8', '#0f1116'] },
  { mode: 'light', icon: 'sun', label: '浅色', desc: '明亮清爽的日间主题', colors: ['#f5f6f8', '#ffffff'] },
  { mode: 'dark', icon: 'moon', label: '深色', desc: '护眼的夜间主题', colors: ['#0f1116', '#16181f'] },
  { mode: 'sepia', icon: 'book', label: '羊皮纸', desc: '温暖的阅读护眼模式', colors: ['#f1e9d5', '#faf4e4'] }
]

const modes: { mode: EditorMode; icon: string; label: string; desc: string }[] = [
  { mode: 'wysiwyg', icon: 'eye', label: '实时渲染', desc: '所见即所得，点击块即可编辑' },
  { mode: 'split', icon: 'columns', label: '分屏对比', desc: '左右实时对比渲染与源码，拖拽调比例' },
  { mode: 'source', icon: 'source', label: '源码模式', desc: '显示原始 Markdown 语法' }
]

const fontLabel = computed(() => {
  const f = FONT_OPTIONS.find((x) => x.value === settings.fontFamily)
  return f ? (f.label === 'sans' ? '无衬线（现代）' : f.label === 'serif' ? '衬线（典雅）' : '等宽（极客）') : '自定义'
})

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
    <!-- 注：Teleport 内层 Transition 的 leave 卸载在此版本偶发残留，
         改为即时显隐 + 入场动画（关闭无需离场过渡） -->
    <div v-if="ui.settingsOpen" class="settings-mask fixed inset-0 z-[120] flex items-center justify-center p-6">
      <!-- 遮罩：点击关闭 -->
      <div class="absolute inset-0 backdrop-blur-[2px]" @click="ui.closeSettings()" />

        <!-- 面板 -->
        <div
          class="settings-panel relative flex h-[min(680px,86vh)] w-[min(1080px,94vw)] overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl"
        >
          <!-- 左侧导航 -->
          <nav class="flex w-[196px] flex-none flex-col gap-1 border-r border-edge bg-panel-2/70 p-3">
            <div class="px-2 pb-2 pt-1">
              <h1 class="text-[15px] font-semibold text-ink">设置</h1>
              <p class="text-[11.5px] text-ink-3">个性化你的 Lumin</p>
            </div>
            <button
              v-for="x in tabs"
              :key="x.id"
              class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-all duration-150"
              :class="activeTab === x.id ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-panel hover:text-ink'"
              @click="switchTab(x.id)"
            >
              <Icon :name="x.icon" :size="14" />
              {{ x.label }}
            </button>
            <div class="flex-1" />
            <button
              class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-ink-3 transition-colors hover:bg-panel hover:text-ink"
              @click="goAbout"
            >
              <Icon name="info" :size="14" />
              关于 Lumin
            </button>
          </nav>

          <!-- 右侧内容 -->
          <div class="flex min-w-0 flex-1 flex-col">
            <!-- 面板头：标题 + X 关闭 -->
            <header class="flex flex-none items-center justify-between border-b border-edge px-6 py-3.5">
              <div>
                <h2 class="text-[15px] font-semibold text-ink">{{ sectionTitle(activeTab) }}</h2>
                <p class="text-[11.5px] text-ink-3">设置将自动保存到本机 SQLite 数据库</p>
              </div>
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-panel-2 hover:text-ink"
                :title="'关闭'"
                @click="ui.closeSettings()"
              >
                <Icon name="close" :size="16" />
              </button>
            </header>

            <div class="min-h-0 flex-1 overflow-y-auto">
              <div class="mx-auto max-w-[680px] px-7 py-6">
                <Transition name="page" mode="out-in">
                  <div :key="activeTab">
                    <!-- ── 通用 ── -->
                    <template v-if="activeTab === 'general'">
                      <section class="surface mb-4 p-5">
                        <h3 class="mb-4 text-[13px] font-semibold text-ink">语言</h3>
                        <div class="flex items-center justify-between gap-4">
                          <div>
                            <p class="text-[13.5px] text-ink">界面语言</p>
                            <p class="mt-0.5 text-[12px] text-ink-3">界面显示语言</p>
                          </div>
                          <div class="flex rounded-lg bg-panel-2 p-0.5">
                            <button
                              v-for="opt in languageOptions"
                              :key="opt.value"
                              class="rounded-md px-3 py-1 text-[12.5px] font-medium transition-all"
                              :class="settings.language === opt.value ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'"
                              @click="settings.setLanguage(opt.value)"
                            >
                              {{ opt.label }}
                            </button>
                          </div>
                        </div>
                      </section>

                      <section class="surface mb-4 p-5">
                        <div class="flex items-center justify-between gap-4">
                          <div>
                            <p class="text-[13.5px] text-ink">自动保存</p>
                            <p class="mt-0.5 text-[12px] text-ink-3">
                              编辑时自动保存到磁盘（间隔 {{ settings.autoSaveInterval }} 秒）；手动模式下仅在保存按钮 / Ctrl+S 时写入，也可点击底部状态栏的保存状态区域随时切换保存方式
                            </p>
                          </div>
                          <button class="switch" :class="{ on: settings.autoSave }" @click="toggleAutoSave" />
                        </div>
                        <div v-if="settings.autoSave" class="mt-5">
                          <div class="mb-2 flex items-center justify-between">
                            <span class="text-[12.5px] text-ink-2">自动保存间隔</span>
                            <span class="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{{ settings.autoSaveInterval }}s</span>
                          </div>
                          <input
                            type="range"
                            class="range w-full"
                            min="1"
                            max="30"
                            :value="settings.autoSaveInterval"
                            @input="settings.set('autoSaveInterval', Number(($event.target as HTMLInputElement).value))"
                          />
                        </div>
                      </section>

                      <section class="surface mb-4 p-5">
                        <div class="flex items-center justify-between gap-4">
                          <div>
                            <p class="text-[13.5px] text-ink">顶部菜单栏</p>
                            <p class="mt-0.5 text-[12px] text-ink-3">
                              窗口顶部的应用菜单（文件(F) / 编辑(E) / 视图(V) / 帮助(H)）；关闭后界面更纯净，快捷键（Ctrl+N/O/S、Alt+F/E/V/H 等）照常生效
                            </p>
                          </div>
                          <button class="switch" :class="{ on: settings.nativeMenuBar }" @click="toggleMenuBar" />
                        </div>
                      </section>

                      <section class="surface p-5">
                        <div class="flex items-center justify-between gap-4">
                          <div>
                            <p class="text-[13.5px] text-ink">{{ t('settings.restoreSession') }}</p>
                            <p class="mt-0.5 text-[12px] text-ink-3">{{ t('settings.restoreSessionDesc') }}</p>
                          </div>
                          <button
                            class="switch"
                            :class="{ on: settings.restoreSession }"
                            :aria-checked="settings.restoreSession"
                            @click="settings.set('restoreSession', !settings.restoreSession)"
                          />
                        </div>
                      </section>

                      <section class="surface p-5">
                        <div class="flex items-center justify-between gap-4">
                          <div>
                            <p class="text-[13.5px] text-ink">侧边栏</p>
                            <p class="mt-0.5 text-[12px] text-ink-3">默认显示左侧边栏</p>
                          </div>
                          <button class="switch" :class="{ on: settings.sidebarVisible }" @click="settings.set('sidebarVisible', !settings.sidebarVisible)" />
                        </div>
                      </section>
                    </template>

                    <!-- ── 编辑器 ── -->
                    <template v-else-if="activeTab === 'editor'">
                      <section class="surface mb-4 p-5">
                        <h3 class="mb-4 text-[13px] font-semibold text-ink">默认编辑器模式</h3>
                        <div class="grid grid-cols-2 gap-2.5">
                          <button
                            v-for="m in modes"
                            :key="m.mode"
                            class="flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all duration-200"
                            :class="settings.editorMode === m.mode ? 'border-accent bg-accent-soft' : 'border-edge hover:border-edge-strong'"
                            @click="settings.set('editorMode', m.mode)"
                          >
                            <span class="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg" :class="settings.editorMode === m.mode ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-ink-3'">
                              <Icon :name="m.icon" :size="15" />
                            </span>
                            <span>
                              <span class="block text-[13.5px] font-medium text-ink">{{ m.label }}</span>
                              <span class="mt-0.5 block text-[11.5px] leading-snug text-ink-3">{{ m.desc }}</span>
                            </span>
                          </button>
                        </div>
                      </section>

                      <section class="surface mb-4 p-5">
                        <div class="flex items-center justify-between gap-4">
                          <div>
                            <p class="text-[13.5px] text-ink">分屏同步滚动</p>
                            <p class="mt-0.5 text-[12px] text-ink-3">分屏对比视图中左右两侧按滚动进度同步</p>
                          </div>
                          <button class="switch" :class="{ on: settings.syncScroll }" @click="settings.set('syncScroll', !settings.syncScroll)" />
                        </div>
                      </section>

                      <section class="surface mb-4 p-5">
                        <div class="flex items-center justify-between gap-4">
                          <div>
                            <p class="text-[13.5px] text-ink">代码块行号</p>
                            <p class="mt-0.5 text-[12px] text-ink-3">在代码块左侧显示行号；关闭后代码块只显示代码文本</p>
                          </div>
                          <button class="switch" :class="{ on: settings.codeLineNumbers }" @click="settings.set('codeLineNumbers', !settings.codeLineNumbers)" />
                        </div>
                      </section>

                      <section class="surface mb-4 p-5">
                        <h3 class="mb-4 text-[13px] font-semibold text-ink">字体与排版</h3>
                        <div class="mb-5">
                          <div class="mb-2 flex items-center justify-between">
                            <span class="text-[12.5px] text-ink-2">字号</span>
                            <span class="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{{ settings.fontSize }}px</span>
                          </div>
                          <input
                            type="range"
                            class="range w-full"
                            min="13"
                            max="26"
                            :value="settings.fontSize"
                            @input="settings.set('fontSize', Number(($event.target as HTMLInputElement).value))"
                          />
                        </div>
                        <div class="mb-5">
                          <div class="mb-2 flex items-center justify-between">
                            <span class="text-[12.5px] text-ink-2">行高</span>
                            <span class="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{{ settings.lineHeight.toFixed(1) }}</span>
                          </div>
                          <input
                            type="range"
                            class="range w-full"
                            min="1.3"
                            max="2.6"
                            step="0.1"
                            :value="settings.lineHeight"
                            @input="settings.set('lineHeight', Number(($event.target as HTMLInputElement).value))"
                          />
                        </div>
                        <div>
                          <div class="mb-2 flex items-center justify-between">
                            <span class="text-[12.5px] text-ink-2">正文字体</span>
                            <span class="text-[12px] text-ink-3">{{ fontLabel }}</span>
                          </div>
                          <div class="flex gap-2">
                            <button
                              v-for="f in FONT_OPTIONS"
                              :key="f.label"
                              class="flex-1 rounded-lg border px-2 py-2.5 text-[12.5px] transition-all duration-150"
                              :class="settings.fontFamily === f.value ? 'border-accent bg-accent-soft text-accent' : 'border-edge text-ink-2 hover:border-edge-strong'"
                              @click="settings.set('fontFamily', f.value)"
                            >
                              {{ f.label === 'sans' ? '无衬线' : f.label === 'serif' ? '衬线' : '等宽' }}
                            </button>
                          </div>
                        </div>
                      </section>

                      <section class="surface p-5">
                        <h3 class="mb-4 text-[13px] font-semibold text-ink">预览效果</h3>
                        <div
                          class="md-preview rounded-xl border border-edge bg-app/60 p-5"
                          :style="{ '--editor-size': settings.fontSize + 'px', '--editor-lh': String(settings.lineHeight), '--editor-font': settings.fontFamily }"
                        >
                          <h3 style="font-size: 1.22em; font-weight: 700; margin: 0 0 0.4em; letter-spacing: -0.01em">标题示例 Heading</h3>
                          <p style="margin: 0.3em 0">所见即所得的正文排版，支持 <strong>加粗</strong>、<em>斜体</em> 与 <code>行内代码</code>。</p>
                        </div>
                      </section>
                    </template>

                    <!-- ── 外观 ── -->
                    <template v-else-if="activeTab === 'appearance'">
                      <section class="surface p-5">
                        <h3 class="mb-1 text-[13px] font-semibold text-ink">主题</h3>
                        <p class="mb-4 text-[12px] text-ink-3">切换主题会立即生效，并伴随平滑过渡</p>
                        <div class="grid grid-cols-2 gap-3">
                          <button
                            v-for="th in themes"
                            :key="th.mode"
                            class="group overflow-hidden rounded-xl border text-left transition-all duration-200 hover:-translate-y-0.5"
                            :class="settings.theme === th.mode ? 'border-accent shadow-lg' : 'border-edge hover:border-edge-strong'"
                            :style="settings.theme === th.mode ? { boxShadow: '0 4px 16px var(--glow)' } : {}"
                            @click="settings.setTheme(th.mode)"
                          >
                            <div class="flex h-16 items-center justify-center gap-1.5" :style="{ background: th.colors[0] }">
                              <div class="h-9 w-16 rounded-md border border-black/5" :style="{ background: th.colors[1] }">
                                <div class="mt-2 h-1 w-8 rounded-sm bg-black/15" style="margin-left: 5px" />
                                <div class="mt-1.5 h-1 w-12 rounded-sm bg-black/10" style="margin-left: 5px" />
                                <div class="mt-1.5 h-1 w-9 rounded-sm bg-black/10" style="margin-left: 5px" />
                              </div>
                            </div>
                            <div class="flex items-center gap-2.5 border-t border-edge p-3">
                              <Icon :name="th.icon" :size="14" :class="settings.theme === th.mode ? 'text-accent' : 'text-ink-3'" />
                              <div class="min-w-0 flex-1">
                                <p class="text-[13px] font-medium text-ink">{{ th.label }}</p>
                                <p class="text-[11px] text-ink-3">{{ th.desc }}</p>
                              </div>
                              <span class="flex h-4 w-4 items-center justify-center rounded-full border-2 transition-all" :class="settings.theme === th.mode ? 'border-accent bg-accent' : 'border-edge-strong'">
                                <Icon v-if="settings.theme === th.mode" name="check" :size="10" class="text-white" />
                              </span>
                            </div>
                          </button>
                        </div>
                      </section>
                    </template>

                    <!-- ── 导出 ── -->
                    <template v-else-if="activeTab === 'export'">
                      <section class="surface mb-4 p-5">
                        <h3 class="mb-4 text-[13px] font-semibold text-ink">PDF 导出</h3>
                        <div class="mb-5">
                          <div class="mb-2 flex items-center justify-between">
                            <span class="text-[12.5px] text-ink-2">页边距</span>
                            <span class="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{{ settings.export.pdf.margin }}mm</span>
                          </div>
                          <input
                            type="range"
                            class="range w-full"
                            min="8"
                            max="50"
                            :value="settings.export.pdf.margin"
                            @input="settings.set('export', { ...settings.export, pdf: { ...settings.export.pdf, margin: Number(($event.target as HTMLInputElement).value) } })"
                          />
                        </div>
                        <div>
                          <span class="mb-2 block text-[12.5px] text-ink-2">页面尺寸</span>
                          <div class="flex gap-2">
                            <button
                              v-for="size in (['A4', 'A5', 'Letter'] as const)"
                              :key="size"
                              class="rounded-lg border px-4 py-2 text-[12.5px] transition-all duration-150"
                              :class="settings.export.pdf.pageSize === size ? 'border-accent bg-accent-soft text-accent' : 'border-edge text-ink-2 hover:border-edge-strong'"
                              @click="settings.set('export', { ...settings.export, pdf: { ...settings.export.pdf, pageSize: size } })"
                            >
                              {{ size }}
                            </button>
                          </div>
                        </div>
                      </section>

                      <section class="surface p-5">
                        <h3 class="mb-4 text-[13px] font-semibold text-ink">支持的格式</h3>
                        <div class="space-y-2.5">
                          <div v-for="row in [
                            { icon: 'file', name: 'PDF', desc: '矢量排版，适合打印与分享' },
                            { icon: 'code', name: 'HTML', desc: '保留完整样式与交互的网页文件' },
                            { icon: 'file', name: 'Word (.doc)', desc: 'Word 可直接打开编辑' },
                            { icon: 'book', name: 'EPUB', desc: '标准 epub 3 电子书格式' }
                          ]" :key="row.name" class="flex items-center gap-3 rounded-xl border border-edge px-3.5 py-2.5">
                            <span class="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent">
                              <Icon :name="row.icon" :size="14" />
                            </span>
                            <div class="min-w-0 flex-1">
                              <p class="text-[13px] font-medium text-ink">{{ row.name }}</p>
                              <p class="text-[11.5px] text-ink-3">{{ row.desc }}</p>
                            </div>
                          </div>
                        </div>
                        <p class="mt-4 text-[11.5px] leading-relaxed text-ink-3">
                          Word 导出使用 Word 兼容的 HTML 文档格式；EPUB 为标准 epub 3 格式。在编辑器工具栏点击「导出」即可使用。
                        </p>
                      </section>
                    </template>

                    <!-- 链接：Ctrl/Cmd+左键打开链接时的行为与历史 -->
                    <template v-else-if="activeTab === 'links'">
                      <section class="surface mb-4 p-5">
                        <h3 class="mb-1 text-[13.5px] text-ink">{{ t('settings.linksCreateMode') }}</h3>
                        <p class="mb-4 text-[12px] text-ink-3">{{ t('settings.linksCreateModeDesc') }}</p>
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

                      <section class="surface p-5">
                        <div class="mb-1 flex items-center justify-between gap-3">
                          <h3 class="text-[13.5px] text-ink">{{ t('settings.linksHistory') }}</h3>
                          <button
                            v-if="linkHistory.length"
                            class="rounded-lg border border-edge px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
                            @click="clearLinkHistory()"
                          >
                            {{ t('settings.linksClear') }}
                          </button>
                        </div>
                        <p class="mb-4 text-[12px] text-ink-3">{{ t('settings.linksHistoryDesc') }}</p>

                        <p
                          v-if="!linkHistory.length"
                          class="rounded-xl border border-dashed border-edge px-3.5 py-6 text-center text-[12.5px] text-ink-3"
                        >
                          {{ t('settings.linksHistoryEmpty') }}
                        </p>

                        <TransitionGroup v-else name="link-row" tag="div" class="relative space-y-2">
                          <div
                            v-for="item in linkHistory"
                            :key="item.target"
                            class="flex items-center gap-3 rounded-xl border border-edge px-3.5 py-2.5"
                          >
                            <span class="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-panel-2 text-ink-3">
                              <Icon name="link" :size="14" />
                            </span>
                            <div class="min-w-0 flex-1">
                              <p class="truncate text-[13px] text-ink" :title="item.target">{{ item.target }}</p>
                              <p class="mt-0.5 truncate text-[11.5px] text-ink-3" :title="item.path ?? ''">
                                {{ formatTime(item.lastUsed) }} · {{ t('settings.linksCount', { count: item.count }) }}
                              </p>
                            </div>
                            <span class="flex-none rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-3">
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
                              <Icon name="trash" :size="14" />
                            </button>
                          </div>
                        </TransitionGroup>
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
