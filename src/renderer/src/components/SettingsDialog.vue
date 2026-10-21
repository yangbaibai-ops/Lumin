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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { FONT_OPTIONS } from '../../../shared/defaults'
// AI：预设清单与错误码→文案键的唯一映射（与主进程/面板共用）
import {
  AI_DEFAULT_MODEL,
  AI_ERROR_KEY,
  AI_MAX_INPUT_CHARS,
  AI_PROVIDER_PRESETS,
  normalizeBaseUrl,
  type AiStatus,
  type AiTestResult
} from '../../../shared/ai'
// 设置文件的信封校验 / 白名单过滤 / 隐私剔除（纯函数，单测 tests/settingsFile.test.mjs）：
// 导入的 JSON 是不可信输入，判据全在那边，这里只负责对话框、报错与确认
import { parseSettingsFile, type SettingsImportErrorCode } from '../../../shared/settingsFile'
// 字节数格式化只有一份（审计 §10「重复实现」）：数据库维护与备份共用
import { formatBytes } from '../../../shared/backup'
import { ENCODINGS, type EncodingId } from '../../../shared/encodings'
import { EOL_OPTIONS, eolLabel, type Eol } from '../../../shared/eol'
// 拼写检查的语言清单/排序规则（纯函数，主进程与这里共用；单测 tests/spellcheck.test.mjs）
import {
  buildSpellcheckLanguageOptions,
  sortSpellcheckLanguages,
  toggleSpellcheckLanguage,
  ZH_SPELLCHECK_LANGUAGE
} from '../../../shared/spellcheck'
// 主题缩略图的三套色（审计 §8 P2「token 未覆盖的硬编码色」）：原来写死在下面的 themes 里，
// 已成第二份真值且漂了（深色样机画的是近黑，而深色主题早改成中性灰）
import { PREVIEW_BY_THEME } from '../../../shared/theme'
// 导出格式的唯一清单（设置页那张表、原生菜单、快捷键表都从它派生，审计 §6 P2）
import { EXPORT_FORMATS } from '../../../shared/exportFormats'
// 「导出启动诊断」的唯一实现（帮助菜单/状态栏/设置页共用，见该文件头）
import { exportStartupDiagnostics } from '../lib/startupDiagnostics'

/** 本地历史的可选项（保留策略见 shared/history.ts；这里只给几档常用值） */
const HISTORY_LIMIT_CHOICES = [10, 20, 30, 50, 100]
const HISTORY_AGE_CHOICES = [7, 30, 90, 365]
/**
 * 目标字数的可选项（0 = 未设置）。
 * 用**档位选择**而不是自由输入框：一是不必为「输入 12.5 / 负数 / 空」另写一套校验与控件，
 * 二是现有设置页里「几档常用值」就是这个写法（见上面的 HISTORY_*_CHOICES）。
 * 档位按中文写作的常见体量排：短评/短文 → 长文 → 章节 → 长篇日更。
 */
const WORD_GOAL_CHOICES = [0, 500, 1000, 2000, 3000, 5000, 10000]
import { LANGUAGE_OPTIONS } from '../i18n'
import type {
  AppSettings,
  BackupStatus,
  EditorMode,
  LinkCreateMode,
  LinkHistoryEntry,
  ThemeMode
} from '../../../shared/types'
import Icon from '../components/Icon.vue'
import SettingSwitch from '../components/SettingSwitch.vue'
import SettingsKeymap from '../components/SettingsKeymap.vue'
import SettingsToolbar from '../components/SettingsToolbar.vue'
import { useOutlineSide } from '../composables/useOutlineSide'

const router = useRouter()
const { t } = useI18n()
const settings = useSettingsStore()
const files = useFilesStore()
const ui = useUiStore()
/** 大纲位置开关的唯一实现（顶部工具栏视图区与「视图」菜单共用它） */
const { setOutlineSide } = useOutlineSide()

/** 页签：文案统一走 i18n（settings.* 命名空间，三语言同步维护） */
const tabs = computed(() => [
  { id: 'general', label: t('settings.general'), icon: 'settings' },
  { id: 'editor', label: t('settings.editor'), icon: 'pencil' },
  { id: 'appearance', label: t('settings.appearance'), icon: 'sun' },
  { id: 'keymap', label: t('settings.keymap'), icon: 'keyboard' },
  { id: 'export', label: t('settings.export'), icon: 'download' },
  { id: 'ai', label: t('settings.ai'), icon: 'sparkles' },
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

// ─── 搜索（设置项 / 导航 / 描述）────────────────────────────────────────────
// 用户口径：「为设置增加可以搜索的功能，包括设置项和导航、描述等」。
//
// 做法是**按渲染出来的文本过滤**（不是手写一份索引表 —— 那种表一定会和模板漂移）：
//   * 搜索时把**所有页签**都渲染出来（`tabShown()`：搜索态下六页全真），于是能跨页签搜；
//   * 逐个 `.set-row` / `.set-fold` 看它的 `textContent` 是否含关键词（描述、控件文案、
//     分组标题都在里面）；命中的留下，没命中的加 `.is-filtered-out`（display:none）；
//   * 组里一条都不剩就整组隐藏；页签里一条都不剩就整页签隐藏；
//   * 导航项永远都在（不重排），但没命中的压暗、有命中的显示条数 —— 点一下就清空搜索并切过去；
//   * 页签标题本身命中时（例如搜「编辑器」），该页签整体保留（按页名搜 = 看这页）。
const searchEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const searching = computed(() => query.value.trim().length > 0)
/** 每个页签的命中条数（给导航项上的小徽标用） */
const hits = ref<Record<string, number>>({})
const totalHits = computed(() => Object.values(hits.value).reduce((a, b) => a + b, 0))
/** 内容区根节点：过滤时从这里往下找 */
const contentEl = ref<HTMLElement | null>(null)

/** 某个页签这次要不要渲染：平时只渲染当前页签，搜索时六页全渲染（跨页签搜索的前提） */
function tabShown(id: string): boolean {
  return searching.value || activeTab.value === id
}

function tabLabel(id: string): string {
  return tabs.value.find((x) => x.id === id)?.label ?? ''
}

/** 按当前关键词过滤已渲染的 DOM（幂等，可反复调用） */
function applyFilter(): void {
  const root = contentEl.value
  if (!root) return
  const q = query.value.trim().toLowerCase()
  const counts: Record<string, number> = {}
  for (const tab of root.querySelectorAll<HTMLElement>('[data-settings-tab]')) {
    const id = tab.dataset.settingsTab ?? ''
    // 页名命中 ⇒ 整页保留（"搜页签名 = 看这页"），否则逐条按文本过滤
    const labelHit = !!q && tabLabel(id).toLowerCase().includes(q)
    const units = [...tab.querySelectorAll<HTMLElement>('.set-row, .set-fold')]
    /**
     * 「快捷键」页签有自己的搜索框与行结构（`SettingsKeymap`，不是 `.set-row`）——
     * 没有可过滤的行时**整页按文本匹配**（命令名/按键都在 textContent 里），
     * 否则搜「保存」会把这一页整个藏掉、看起来像搜不到。
     */
    if (units.length === 0) {
      const textHit = !q || labelHit || (tab.textContent || '').toLowerCase().includes(q)
      tab.classList.toggle('is-filtered-out', !!q && !textHit)
      counts[id] = q && textHit ? 1 : 0
      continue
    }
    let n = 0
    for (const unit of units) {
      const hit = !q || labelHit || (unit.textContent || '').toLowerCase().includes(q)
      unit.classList.toggle('is-filtered-out', !!q && !hit)
      if (q && hit) n += 1
    }
    // 组：组标题命中 ⇒ 整组保留；否则组内一条都不剩就整组隐藏
    for (const card of tab.querySelectorAll<HTMLElement>('.set-card')) {
      const titleHit =
        !!q &&
        (labelHit ||
          (card.querySelector('.set-card-title')?.textContent || '').toLowerCase().includes(q))
      const anyRow = [...card.querySelectorAll<HTMLElement>('.set-row, .set-fold')].some(
        (u) => !u.classList.contains('is-filtered-out')
      )
      card.classList.toggle('is-filtered-out', !!q && !titleHit && !anyRow)
    }
    counts[id] = q ? n : 0
    tab.classList.toggle('is-filtered-out', !!q && n === 0)
  }
  hits.value = counts
}

/** 关键词 / 页签 / 开关变化后重新过滤（等 DOM 更新完再跑） */
watch([query, activeTab, () => ui.settingsOpen], () => {
  void nextTick(applyFilter)
})

function clearSearch(): void {
  query.value = ''
}

/** 点导航项：搜索态下先清空搜索（否则"切到一页却只看到它的过滤结果"很绕） */
function onNavClick(id: string): void {
  if (searching.value) query.value = ''
  switchTab(id)
}

/** 顶部菜单栏开关：控制应用内菜单栏（TopMenuBar）显隐。SettingSwitch 传新值进来，不再自己取反 */
function toggleMenuBar(v: boolean): void {
  settings.set('nativeMenuBar', v)
}

/**
 * 大纲放在编辑区右侧（三栏）。
 * 实现收在 `composables/useOutlineSide.ts`（顶部工具栏的视图开关与「视图」菜单共用同一份）：
 * 打开时顺手把右侧面板设为展开、并把左栏页签收回「文件」；关掉时把左栏页签切到「大纲」。
 * 这里只做一层转发，避免第二份"打开时要摆正哪些状态"的口径。
 */
function toggleOutlineRight(v: boolean): void {
  setOutlineSide(v)
}

/** 自动保存开关：SettingSwitch 传新值进来；关闭时取消未触发的磁盘定时器（草稿崩溃保护不受影响） */
function toggleAutoSave(v: boolean): void {
  settings.set('autoSave', v)
  if (!v) files.cancelAutoSave()
}

// ─── 关于页入口 ──────────────────────────────────────────────────────────────
// 顶栏那一枚「关于 Lumin」：先收起设置再走路由（否则设置整页会把关于页盖住）
function goAbout(): void {
  ui.closeSettings()
  void router.push('/about')
}

/**
 * 键盘：Esc 与 `/`（打开设置时才生效）。
 *  * Esc：**搜索框里有词就先清搜索**，空了才关设置 —— 否则用户想清搜索却把整页关了；
 *  * `/`：聚焦设置搜索框（GitHub 等应用的「快速查找」键）。
 *    ⚠️ **不抢 Ctrl+F**：那是编辑器的查找栏，而应用级快捷键在渲染层的捕获阶段**比本组件先注册**
 *    （设置页挂载时它早就在了），stopPropagation 拦不住 —— 实测按下 Ctrl+F 会「设置搜索聚焦了、
 *    编辑器查找栏也弹了」这种两头都动的状态。要抢这个键得改全局快捷键的分发，是另一件事。
 *    这里只在焦点不在输入类元素上时接管 `/`（否则那个字符都打不出来）。
 */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  )
}

function onKeydown(e: KeyboardEvent): void {
  if (!ui.settingsOpen) return
  if (e.key === 'Escape') {
    if (searching.value) {
      e.preventDefault()
      clearSearch()
      return
    }
    ui.closeSettings()
    return
  }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditable(e.target)) {
    e.preventDefault()
    searchEl.value?.focus()
    searchEl.value?.select()
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  // 语言清单来自主进程（availableSpellCheckerLanguages）：首次渲染前就问一次
  void refreshSpellState()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

// 切到「链接」页签时读取历史（每次打开设置面板都刷新，避免看到过期数据）
watch(
  () => [ui.settingsOpen, activeTab.value] as const,
  ([open, tab]) => {
    if (open && tab === 'links') void loadLinkHistory()
    // 备份现状（目录/份数/上次时间）也在「通用」页签里，同样每次刷新
    if (open && tab === 'general') void refreshBackup()
    // 每次打开设置页都重新问一次拼写检查状态（开关/语言可能被另一条路径改过）
    if (open) void refreshSpellState()
    // AI 页签：Key 状态只有主进程知道，进页面时问一次（只拿 hasKey/模型/地址）
    if (open && tab === 'ai') {
      aiNotice.value = ''
      aiTestState.value = null
      void refreshAiStatus()
    }
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

// 选项表写成 computed：文案来自语言包，**语言切换时标题/说明要跟着变**
// （写成模块级常量的话，切换语言后这一屏会停在旧语言 —— 见审计 §10）
const themes = computed<
  {
    mode: ThemeMode
    icon: string
    label: string
    desc: string
    preview: { shell: string; paper: string; line: string }
  }[]
>(() => [
  {
    mode: 'auto',
    icon: 'monitor',
    label: t('settings.themeAuto'),
    desc: t('settings.themeAutoDesc'),
    // 跟随系统的样机 = 浅色外壳 + 深色纸（一张图说明"两边都可能是它"）
    preview: {
      shell: PREVIEW_BY_THEME.light.shell,
      paper: PREVIEW_BY_THEME.dark.paper,
      line: PREVIEW_BY_THEME.dark.line
    }
  },
  {
    mode: 'light',
    icon: 'sun',
    label: t('settings.themeLight'),
    desc: t('settings.themeLightDesc'),
    preview: PREVIEW_BY_THEME.light
  },
  {
    mode: 'dark',
    icon: 'moon',
    label: t('settings.themeDark'),
    desc: t('settings.themeDarkDesc'),
    preview: PREVIEW_BY_THEME.dark
  },
  {
    mode: 'sepia',
    icon: 'book',
    label: t('settings.themeSepia'),
    desc: t('settings.themeSepiaDesc'),
    preview: PREVIEW_BY_THEME.sepia
  }
])

const modes = computed<{ mode: EditorMode; icon: string; label: string; desc: string }[]>(() => [
  { mode: 'wysiwyg', icon: 'eye', label: t('editor.wysiwyg'), desc: t('settings.modeWysiwygDesc') },
  {
    mode: 'split',
    icon: 'columns',
    label: t('settings.modeSplit'),
    desc: t('settings.modeSplitDesc')
  },
  {
    mode: 'source',
    icon: 'source',
    label: t('menu.source'),
    desc: t('settings.modeSourceDesc')
  }
])

/** 导出页那张「支持的格式」表：从**唯一清单**派生（审计 §6 P2「格式清单存在 5 处」） */
const exportFormats = computed<{ icon: string; name: string; desc: string }[]>(() =>
  EXPORT_FORMATS.map((f) => ({ icon: f.icon, name: f.brand, desc: t(f.descKey) }))
)

/**
 * 远程图片策略（SQLite 里就是 `settings.remoteImages: 'click' | 'always'`）：
 * 这个设置此前**没有任何界面入口** —— `lib/remoteImages.ts` 一直在按它工作，
 * 用户却改不了（对话框里的文案键 `settings.remoteImages*` 也就一直是死键）。
 */
const remoteImagePolicies = computed<{ value: 'click' | 'always'; label: string }[]>(() => [
  { value: 'click', label: t('settings.remoteImagesClick') },
  { value: 'always', label: t('settings.remoteImagesAlways') }
])

/** 恢复默认设置：store 里早有 `reset()`，但此前没有任何界面能调到它 */
async function resetAllSettings(): Promise<void> {
  const ok = await ui.confirm({
    title: t('settings.reset'),
    body: t('settings.resetConfirm'),
    danger: true
  })
  if (ok) await settings.reset()
}

// ─── 拼写检查（Electron/Chromium 内置检查器，不引第三方词典）──────────────────
// 语言**不写死**：可选项来自主进程返回的 `availableSpellCheckerLanguages` 原值，
// 只做"常见语言优先、其余字母序"的展示排序（shared/spellcheck.ts）。
interface SpellState {
  enabled: boolean
  /** 当前真正生效的语言（空数组 = 平台没有可用词典） */
  languages: string[]
  /** 系统提供的全部语言（原值） */
  available: string[]
}

const spellState = ref<SpellState | null>(null)

/**
 * 可选语言：**第一项固定为「中文（简体）」**（我们自己实现的启发式检查，不在
 * Chromium 的词典清单里）；其后是 Chromium 的可用语言（常见语言在前，其余字母序）。
 * 系统清单里若本来有 zh，会被收敛进第一项，不会出现两个中文。
 */
const spellAvailable = computed(() =>
  buildSpellcheckLanguageOptions(spellState.value?.available ?? [])
)

/** Chromium 侧到底有没有词典（中文项不算；用于"系统无词典"的提示） */
const spellChromiumAvailable = computed(() =>
  sortSpellcheckLanguages(spellState.value?.available ?? [])
)

/**
 * 界面上的"已选"：
 *   * 用户手动选过 ⇒ 就是持久化的那份（主进程会再过滤掉不可用的）；
 *   * 没选过（空数组 = 自动）⇒ 显示当前真正生效的语言，避免"开着却一个都没勾"的错觉。
 */
const spellEffective = computed<string[]>(() => {
  if (settings.spellcheckLanguages.length > 0) return settings.spellcheckLanguages
  return spellState.value?.languages ?? []
})

/** 语言显示名：中文项用语言包里的固定名（Intl 只给「中文」，看不出是简体） */
function spellLanguageLabel(code: string): string {
  if (code === ZH_SPELLCHECK_LANGUAGE) return t('settings.spellcheckZhLabel')
  try {
    const names = new Intl.DisplayNames([settings.language], { type: 'language' })
    return names.of(code) ?? code
  } catch {
    return code
  }
}

const spellEffectiveLabel = computed(() => spellEffective.value.map(spellLanguageLabel).join(', '))

/** 重新问主进程要状态（打开设置页时、每次改动落库后） */
async function refreshSpellState(): Promise<void> {
  try {
    spellState.value = await window.luminAPI.spell.getState()
  } catch {
    spellState.value = null
  }
}

/** 开关：落库 → 主进程在 settings:update 里立即 setSpellCheckerEnabled（不用重启） */
function setSpellcheckEnabled(value: boolean): void {
  settings.set('spellcheckEnabled', value)
  void settings.flush().then(refreshSpellState)
}

/**
 * 语言多选。至少保留一个：全不选在语义上等于关闭总开关，
 * 而"空数组"在持久化里另有含义（自动选择），两者混在一起会让界面显示与生效不一致。
 */
function toggleSpellLanguage(code: string): void {
  // 与状态栏快捷菜单共用同一套多选语义（不能把最后一个语言也取消）
  const next = toggleSpellcheckLanguage(spellEffective.value, code)
  if (next === null) {
    ui.toast(t('settings.spellcheckKeepOne'), 'info')
    return
  }
  settings.set('spellcheckLanguages', next)
  void settings.flush().then(refreshSpellState)
}

// ─── 设置的导出 / 导入（审计清单「设置/快捷键导入导出、恢复默认」里缺的那一半）──
// 文件长什么样、什么算合法、哪些字段不进文件：全在 `shared/settingsFile.ts`
// （纯函数、单测 tests/settingsFile.test.mjs）。这里只做三件事：开对话框、报错、确认后落库。
/** 导入失败的原因码 → 语言包键（**静态映射**：动态拼键会被「死键」守卫拦下，也不好翻译） */
const IMPORT_ERROR_KEYS: Record<SettingsImportErrorCode, string> = {
  'not-json': 'settings.importErrNotJson',
  'bad-envelope': 'settings.importErrBadEnvelope',
  'wrong-app': 'settings.importErrWrongApp',
  'unknown-version': 'settings.importErrUnknownVersion',
  'unsafe-path': 'settings.importErrUnsafePath',
  'too-large': 'settings.importErrTooLarge',
  'read-failed': 'settings.importErrReadFailed'
}

/** 文件操作期间禁用这两个按钮（否则连点两下会叠出两个原生对话框） */
const settingsFileBusy = ref(false)

/** 错误码 → 人话；`detail` 是字段名（或解析器的一句话），拼在括号里方便用户去定位/手改 */
function importErrorText(failure: { code: SettingsImportErrorCode; detail?: string }): string {
  const base = t(IMPORT_ERROR_KEYS[failure.code])
  return failure.detail ? `${base} (${failure.detail})` : base
}

/** 导出：写成一个 JSON 文件（用户选路径）。取消 = 什么都不发生；成功才提示落盘路径 */
async function exportSettingsFile(): Promise<void> {
  if (settingsFileBusy.value) return
  settingsFileBusy.value = true
  try {
    // 传**界面上这一份**而不是让主进程读库：设置落库是 250ms 节流的，
    // 刚改完就点导出时库里还是旧值，而用户要的显然是屏幕上看到的这份
    const plain = JSON.parse(JSON.stringify(settings.$state)) as AppSettings
    const saved = await window.luminAPI.settings.exportFile(plain)
    if (saved) ui.toast(t('settings.exportSettingsDone', { path: saved }), 'success')
  } catch (err) {
    ui.toast(
      t('settings.exportSettingsFailed', {
        reason: err instanceof Error ? err.message : String(err)
      }),
      'error'
    )
  } finally {
    settingsFileBusy.value = false
  }
}

/**
 * 导入：选文件 → 解析校验 → 二次确认 → 落库。
 *
 * 顺序是刻意的：**文件不合法就不弹确认框**（先告诉用户"为什么不行"，而不是先问一遍
 * "确定要覆盖吗"）；确认之后才调 `applyImport` —— 主进程那条通道是**整体替换**语义，
 * 于是文件里没有的自定义快捷键不会被合并回来。
 */
async function importSettingsFile(): Promise<void> {
  if (settingsFileBusy.value) return
  settingsFileBusy.value = true
  try {
    const picked = await window.luminAPI.settings.importFile()
    if (!picked) return // 用户取消
    if (!picked.ok) {
      ui.toast(t('settings.importSettingsFailed', { reason: importErrorText(picked) }), 'error')
      return
    }
    const parsed = parseSettingsFile(picked.text)
    if (!parsed.ok) {
      // 形状不对 / 版本不认 / 非法字段：都在这里变成一句能定位原因的话，**不半套用**
      ui.toast(t('settings.importSettingsFailed', { reason: importErrorText(parsed) }), 'error')
      return
    }
    const ok = await ui.confirm({
      title: t('settings.importSettings'),
      body: t('settings.importSettingsConfirm', { n: parsed.applied.length }),
      danger: true
    })
    if (!ok) return
    await settings.applyImport(parsed.patch)
    ui.toast(t('settings.importSettingsDone', { n: parsed.applied.length }), 'success')
  } catch (err) {
    ui.toast(
      t('settings.importSettingsFailed', {
        reason: err instanceof Error ? err.message : String(err)
      }),
      'error'
    )
  } finally {
    settingsFileBusy.value = false
  }
}

/**
 * 诊断信息（审计 §9 P1）：把"我这边卡/闪退"变成我们能修的问题。
 * 文案由主进程按 `shared/diagnostics.ts` 组装（**不含文档内容**），这里只负责复制到剪贴板。
 */
async function copyDiagnostics(): Promise<void> {
  try {
    const text = await window.luminAPI.app.getDiagnostics()
    await navigator.clipboard.writeText(text)
    ui.toast(t('settings.diagnosticsCopied'), 'success')
  } catch {
    ui.toast(t('toast.copyFailed'), 'error')
  }
}

/** 打开日志目录（主进程固定打开 `%TEMP%`，不接受路径参数） */
function openLogDir(): void {
  void window.luminAPI.app.openLogDir()
}

/**
 * 「导出启动诊断」的实现已移到 `lib/startupDiagnostics.ts`（帮助菜单/状态栏/设置页共用
 * 同一份 toast 与失败处理）。这里保留一句说明，避免后来者又在这里写第二份。
 */

// ─── 数据库维护（审计 §2 P1：全仓无 VACUUM / integrity_check / 重建索引入口）──
// 三条都只在用户点击时跑：`VACUUM` 会重建整个库（耗时与库大小成正比），
// 重建索引会重写全部 FTS 行 —— 放在启动路径上等于每次开窗都做一遍。
const dbBusy = ref(false)
async function runDbMaintenance(kind: 'check' | 'rebuild' | 'vacuum'): Promise<void> {
  if (dbBusy.value) return
  dbBusy.value = true
  try {
    if (kind === 'check') {
      const r = await window.luminAPI.db.integrityCheck()
      ui.toast(
        r.ok
          ? t('settings.dbCheckOk')
          : t('settings.dbCheckFailed', { detail: r.detail.slice(0, 120) }),
        r.ok ? 'success' : 'error'
      )
    } else if (kind === 'rebuild') {
      const r = await window.luminAPI.db.rebuildIndex()
      ui.toast(t('settings.dbReindexed', { n: r.rebuilt }), 'success')
    } else {
      const r = await window.luminAPI.db.vacuum()
      ui.toast(t('settings.dbVacuumed', { saved: formatBytes(r.saved) }), 'success')
    }
  } catch (err) {
    ui.toast(
      t('settings.dbMaintenanceFailed', {
        reason: err instanceof Error ? err.message : String(err)
      }),
      'error'
    )
  } finally {
    dbBusy.value = false
  }
}

/** 字节数 → 人读：**唯一实现**在 shared/backup.ts（备份与数据库维护两处都用它） */

// ─── 备份（审计 §2 P1：此前没有任何自动备份 / 工作区级导出）────────────────────
// 两条路：① 主进程每 24 小时把 SQLite 库复制到 `backupDir`（保留 7 份）；
// ② 用户点一下把整个工作区打成 zip。这里只负责显示现状 + 触发，判断都在主进程。
const backupState = ref<BackupStatus | null>(null)
const backupBusy = ref(false)

async function refreshBackup(): Promise<void> {
  try {
    backupState.value = await window.luminAPI.backup.status()
  } catch {
    backupState.value = null
  }
}

/** 备份目录：默认 = `<userData>/backups`（与程序数据同盘，界面上提示换盘） */
const backupDirLabel = computed(() => {
  const s = backupState.value
  if (!s) return ''
  return s.isDefaultDir ? t('settings.backupDefaultDir') : s.dir
})

/** 上次备份时刻（语言本地化；从没备过给一句明确的话，而不是"1970"） */
const backupLastLabel = computed(() => {
  const ms = backupState.value?.lastMs
  if (!ms) return t('settings.backupLastNever')
  // ⚠️ 传 locale（报告 §5.4 P2-4）：不传时用的是**系统**区域设置，俄语界面 + 中文系统
  // 会看到中文格式的日期（同文件列表与通知中心都传了 language，这里此前是漏的）。
  return t('settings.backupLastAt', { when: new Date(ms).toLocaleString(settings.language) })
})

/** 备份目录里现存的份数 */
const backupCountLabel = computed(() =>
  t('settings.backupCount', { n: backupState.value?.files.length ?? 0 })
)

async function runBackupNow(): Promise<void> {
  if (backupBusy.value) return
  backupBusy.value = true
  try {
    const r = await window.luminAPI.backup.run()
    if (r.ok) {
      ui.toast(
        t('settings.backupDone', {
          name: r.path ? r.path.split(/[\\/]/).pop() : '',
          size: formatBytes(r.bytes)
        }),
        'success'
      )
    } else {
      ui.toast(t('settings.backupFailed', { reason: r.error ?? '' }), 'error')
    }
    await refreshBackup()
  } finally {
    backupBusy.value = false
  }
}

/**
 * 把主进程那边的备份口径**同步回 settings store**。
 *
 * 为什么必须有这一步：`backup:chooseDir` 是直接写 kv 的（它不经过 store），
 * 而 store 的 `persist()` 会把**整份** AppSettings 回写 —— store 里的 `backupDir`
 * 还停在旧值（默认 profile 是 null），于是用户选完目录之后只要再动任何一个设置开关，
 * 目录就被悄悄打回默认。实测症状就是「选了别的盘，重启后变回默认目录」。
 */
function syncBackupSettings(): void {
  const s = backupState.value
  if (!s) return
  settings.$patch({ backupDir: s.isDefaultDir ? null : s.dir, backupAuto: s.auto })
}

async function chooseBackupDir(): Promise<void> {
  if (backupBusy.value) return
  backupBusy.value = true
  try {
    backupState.value = await window.luminAPI.backup.chooseDir()
    syncBackupSettings()
    await refreshBackup()
  } finally {
    backupBusy.value = false
  }
}

async function useDefaultBackupDir(): Promise<void> {
  backupState.value = await window.luminAPI.backup.useDefaultDir()
  syncBackupSettings()
  await refreshBackup()
}

async function revealBackupDir(): Promise<void> {
  await window.luminAPI.backup.revealDir()
}

// ─── AI（API Key / Base URL / 模型 / 测试连接）────────────────────────────────
// Key 的输入框**只进不出**：保存时经 IPC 交给主进程加密落库，之后渲染层只能拿到
// `hasKey` 布尔值；这里没有任何"读回 Key"的调用。
const aiStatus = ref<AiStatus | null>(null)
const aiBaseDraft = ref('')
const aiModelDraft = ref('')
const aiKeyInput = ref('')
const aiBusy = ref(false)
const aiTesting = ref(false)
const aiNotice = ref<'' | 'saved' | 'cleared'>('')
const aiTestState = ref<AiTestResult | null>(null)

const aiKeyLabel = computed(() =>
  aiStatus.value?.hasKey ? t('settings.aiKeySaved') : t('settings.aiKeyMissing')
)
const aiTestText = computed(() => {
  const s = aiTestState.value
  if (!s) return ''
  if (s.ok) return t('settings.aiTestOk', { ms: s.latencyMs ?? 0 })
  return t(AI_ERROR_KEY[s.code])
})
const aiNoticeText = computed(() => {
  if (aiNotice.value === 'saved') return t('settings.aiSaved')
  if (aiNotice.value === 'cleared') return t('settings.aiCleared')
  return ''
})
/** 当前 Base URL 命中了哪个预设（找不到 = 自定义） */
const aiPresetId = computed(
  () =>
    AI_PROVIDER_PRESETS.find((p) => p.baseUrl && p.baseUrl === aiBaseDraft.value)?.id ?? 'custom'
)
/** Base URL 非法时输入框描红（错误色只用 --danger，不写死色值） */
const aiBaseInvalid = computed(
  () => !!aiBaseDraft.value.trim() && normalizeBaseUrl(aiBaseDraft.value) === null
)

/** 对话默认上下文：只影响**新打开**的对话面板（面板内仍可随时改） */
function setAiContextDefault(value: 'selection' | 'document'): void {
  settings.set('aiContextDefault', value)
}

function syncAiDrafts(): void {
  aiBaseDraft.value = settings.aiBaseUrl
  aiModelDraft.value = settings.aiModel
}

async function refreshAiStatus(): Promise<void> {
  try {
    aiStatus.value = await window.luminAPI.ai.status()
  } catch {
    aiStatus.value = null
  }
  syncAiDrafts()
}

function onAiPresetChange(id: string): void {
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === id)
  if (preset && preset.baseUrl) aiBaseDraft.value = preset.baseUrl
}

/** 保存 Base URL / 模型（以及输入框里新填的 Key）；返回是否可以继续测试连接 */
async function saveAiSettings(): Promise<boolean> {
  const base = normalizeBaseUrl(aiBaseDraft.value)
  if (!base) {
    aiTestState.value = { ok: false, code: 'invalid-base-url' }
    return false
  }
  const model = aiModelDraft.value.trim() || AI_DEFAULT_MODEL
  aiBaseDraft.value = base
  aiModelDraft.value = model
  settings.set('aiBaseUrl', base)
  settings.set('aiModel', model)
  // Base URL/模型是普通设置（250ms 节流），保存后立刻落库；紧接着的测试连接读的是主进程那份
  await settings.flush()
  const key = aiKeyInput.value.trim()
  if (key) {
    const r = await window.luminAPI.ai.setKey(key)
    if (!r.ok) {
      aiTestState.value = { ok: false, code: r.code }
      return false
    }
    aiKeyInput.value = ''
    aiNotice.value = 'saved'
  }
  await refreshAiStatus()
  return true
}

async function saveAi(): Promise<void> {
  if (aiBusy.value) return
  aiBusy.value = true
  aiNotice.value = ''
  try {
    await saveAiSettings()
  } finally {
    aiBusy.value = false
  }
}

async function clearAiKey(): Promise<void> {
  if (aiBusy.value) return
  aiBusy.value = true
  try {
    await window.luminAPI.ai.setKey('')
    aiTestState.value = null
    aiNotice.value = 'cleared'
    await refreshAiStatus()
  } finally {
    aiBusy.value = false
  }
}

async function testAi(): Promise<void> {
  if (aiTesting.value) return
  aiTesting.value = true
  aiTestState.value = null
  try {
    if (!(await saveAiSettings())) return
    aiTestState.value = await window.luminAPI.ai.test()
  } catch {
    aiTestState.value = { ok: false, code: 'network' }
  } finally {
    aiTesting.value = false
  }
}

/**
 * 导出工作区快照（zip）。
 * 被跳过的条目要**如实报出来**：用户以为备份完整、真出事时才发现少了一半，
 * 比一开始就知道"跳过了 12 个大文件"糟糕得多。
 */
async function exportWorkspaceSnapshot(): Promise<void> {
  if (backupBusy.value) return
  backupBusy.value = true
  try {
    const r = await window.luminAPI.backup.snapshotWorkspace()
    if (!r) return // 另存为对话框取消
    const skipped = r.skipped.hidden + r.skipped.temp + r.skipped.huge + r.skipped.overflow
    ui.toast(
      t('settings.backupSnapshotDone', {
        n: r.files,
        size: formatBytes(r.zipBytes),
        skipped: skipped ? t('settings.backupSnapshotSkipped', { n: skipped }) : ''
      }),
      'success'
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ui.toast(
      t('settings.backupSnapshotFailed', {
        reason:
          reason === 'WORKSPACE_NOT_OPEN'
            ? t('settings.backupNoWorkspace')
            : reason === 'WORKSPACE_EMPTY'
              ? t('settings.backupSnapshotEmpty')
              : reason
      }),
      'error'
    )
  } finally {
    backupBusy.value = false
  }
}

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

/**
 * 删除单条链接记录 / 清空全部：**都要先确认**（审计 §8 P2「危险/不可逆操作还缺确认与撤销」）。
 * 与本地历史浮层的「清空」同一套口径（`ui.confirm` + danger）—— 这两处原先不一致：
 * 本地历史问了，链接历史没问。单条删除同样不可恢复（打开次数与时间会随行一起没）。
 */
async function forgetLink(target: string): Promise<void> {
  const ok = await ui.confirm({
    title: t('settings.linksForgetTitle'),
    body: t('settings.linksForgetBody', { target }),
    danger: true
  })
  if (!ok) return
  await window.luminAPI.links.forget(target).catch(() => {})
  await loadLinkHistory()
}

async function clearLinkHistory(): Promise<void> {
  const ok = await ui.confirm({
    title: t('settings.linksClearTitle'),
    body: t('settings.linksClearBody'),
    danger: true
  })
  if (!ok) return
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
         `--z-page` 与原来的浮层同档：通知带（z 更高）仍然浮在它上面，确认框（`--z-modal`）照样能弹。 -->
    <!-- 设置 = **整页**，而且**只有一条滚动条**（就是页面自己那条）。
         用户口径：「不要有限制组件 … 它有自己的滚动条，而不是整个界面的滚动条」——
         所以这里不再有内层 `overflow-y: auto` 的滚动容器：整页滚动，顶栏与左导航吸顶。 -->
    <div
      v-if="ui.settingsOpen"
      class="settings-page fixed inset-0 z-[var(--z-page)] bg-app text-ink"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.title')"
      data-settings-page
    >
      <!-- 顶栏：整页的身份与出口（左边是「设置」，右边是「关于」与关闭）。
           `sticky` ⇒ 页面滚动时它一直可见（关设置的出口不该被滚走）。
           按钮直接用项目自己的两档：`.btn.btn-ghost`（文字按钮）与 `.icon-btn`（图标按钮，
           与侧栏/工具栏上那排图标按钮同款：无边框、悬停浅底）—— 用户口径「关闭按钮的样式和
           项目不符，请优化，使其更简约简洁」。 -->
      <header class="settings-topbar sticky top-0 z-10 flex h-12 items-center border-b border-edge">
        <div class="settings-wrap flex items-center justify-between px-6">
          <div class="flex min-w-0 items-center gap-2">
            <Icon name="settings" :size="15" class="flex-none text-ink-3" />
            <h1 class="text-[14px] font-semibold text-ink">{{ t('settings.title') }}</h1>
            <span class="ml-2 hidden truncate text-[11.5px] text-ink-2b sm:inline">
              {{ t('settings.persistHint') }}
            </span>
          </div>
          <div class="flex flex-none items-center gap-1">
            <button class="btn btn-ghost px-3 py-1.5 text-ui" @click="goAbout">
              <Icon name="info" :size="14" />
              {{ t('menu.about') }}
            </button>
            <button
              class="icon-btn"
              data-settings-close
              :title="t('common.close')"
              :aria-label="t('common.close')"
              @click="ui.closeSettings()"
            >
              <Icon name="x" :size="16" />
            </button>
          </div>
        </div>
      </header>

      <!-- 主体：两栏直接铺在界面上（无卡片外框），整页一起滚动 ⇒ 只有一条滚动条。
           左导航 `sticky` 吸顶：滚动长页签时它一直可见（主流编辑器的页签列表也是常驻的）。 -->
      <!-- 主体：两栏直接铺在界面上（无卡片外框），整页一起滚动 ⇒ 只有一条滚动条。
           **留白落在两栏自己身上**（导航 64px 内边距 + 内容列 pt-16），不放在这一行上：
           这样导航一进页面就停在顶栏下沿、并且 `sticky` 一钉就再也不会随页面动
           （用户口径：① 搜索框放到导航栏上方；② 导航不随界面滚动）。 -->
      <div class="flex px-6">
        <div class="settings-card">
          <!-- 左导航：搜索框在最上面（搜设置项 / 描述 / 页签名），下面是六个分组 -->
          <nav class="settings-nav" :aria-label="t('settings.title')">
            <div class="settings-search">
              <Icon name="search" :size="13" class="settings-search__icon" />
              <input
                ref="searchEl"
                v-model="query"
                type="text"
                class="settings-search__input"
                :placeholder="t('settings.searchPlaceholder')"
                :aria-label="t('settings.searchPlaceholder')"
                data-settings-search
                spellcheck="false"
                @keydown.esc.prevent="clearSearch()"
              />
              <button
                v-if="searching"
                class="settings-search__clear"
                :title="t('common.close')"
                :aria-label="t('common.close')"
                data-settings-search-clear
                @click="clearSearch()"
              >
                <Icon name="x" :size="12" />
              </button>
            </div>
            <button
              v-for="x in tabs"
              :key="x.id"
              class="settings-nav-item"
              :aria-current="activeTab === x.id && !searching ? 'page' : undefined"
              :class="{
                'is-active': activeTab === x.id && !searching,
                'is-muted': searching && (hits[x.id] ?? 0) === 0
              }"
              :data-settings-nav="x.id"
              @click="onNavClick(x.id)"
            >
              <Icon :name="x.icon" :size="15" class="flex-none" />
              <span class="min-w-0 flex-1 truncate">{{ x.label }}</span>
              <span
                v-if="searching && (hits[x.id] ?? 0) > 0"
                class="settings-nav-item__count"
                :data-settings-nav-count="x.id"
                >{{ hits[x.id] }}</span
              >
            </button>
          </nav>

          <!-- 内容区：与导航同一底色（--app），设置项直接列在界面上。
               **没有内层滚动容器** —— 长页签由整页那条滚动条滚（用户口径）。
               搜索态下六个页签**全部渲染**，于是能跨页签搜；平时只渲染当前页签。 -->
          <div class="settings-body min-w-0 flex-1">
            <div ref="contentEl" class="settings-column px-8 pb-12 pt-16" data-settings-content>
              <h2 v-if="!searching" class="settings-section-title">
                {{ sectionTitle(activeTab) }}
              </h2>
              <p
                v-if="searching && totalHits === 0"
                class="settings-no-match"
                data-settings-no-match
              >
                {{ t('settings.searchNoMatch') }}
              </p>
              <!-- ⚠️ `v-if` 与 `v-for` 不能同挂一个元素（Vue 3 里 v-if 优先级更高、拿不到 `tab`），
                   所以外面套一层 `<template v-for>`，条件写在内层 div 上。 -->
              <template v-for="tab in tabs" :key="tab.id">
                <div v-if="tabShown(tab.id)" class="settings-tab" :data-settings-tab="tab.id">
                  <!-- 搜索态下每页自带小标题（否则只剩一列设置项，分不清来自哪一页） -->
                  <h3
                    v-if="searching"
                    class="settings-search-heading"
                    :data-settings-tab-heading="tab.id"
                  >
                    {{ tab.label }}
                    <span v-if="(hits[tab.id] ?? 0) > 0" class="settings-search-heading__count">{{
                      hits[tab.id]
                    }}</span>
                  </h3>
                  <!-- ── 通用 ──
                     用户口径：「该展示的展示，该折叠的折叠 … 尽可能简约简介」。
                     原来是 7 张单行卡片 + 2 张散卡（很长一列，滚动半天）；现在按主题合并成
                     3 张卡（界面 / 保存与会话 / 文本与编码）+ 1 个折叠块（高级），
                     低频与信息性的内容（详细说明、自动检查更新）默认收起。 -->
                  <template v-if="tab.id === 'general'">
                    <section class="set-card">
                      <h3 class="set-card-title">{{ t('settings.cardInterface') }}</h3>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.language') }}</p>
                          <p class="set-row-desc">{{ t('settings.languageDesc') }}</p>
                        </div>
                        <!-- 分段控件的语义（审计 §8 P1「同一个分段控件有 2 种实现」）：
                             每组给 role="group" + aria-label，每个按钮给 aria-pressed ——
                             读屏器才读得出"当前选的是哪一个"。视觉统一到 SegmentedControl
                             是后续项（组件要求每段带图标，文字型分组要先把 icon 变成可选）。 -->
                        <div
                          class="flex rounded-lg bg-panel-2 p-0.5"
                          role="group"
                          :aria-label="t('settings.language')"
                        >
                          <button
                            v-for="opt in languageOptions"
                            :key="opt.value"
                            class="rounded-md px-3 py-1 text-ui font-medium transition-all"
                            :class="
                              settings.language === opt.value
                                ? 'bg-panel text-ink shadow-sm'
                                : 'text-ink-2b hover:text-ink-2'
                            "
                            :aria-pressed="settings.language === opt.value"
                            @click="settings.setLanguage(opt.value)"
                          >
                            {{ opt.label }}
                          </button>
                        </div>
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.sidebarToggle') }}</p>
                          <p class="set-row-desc">{{ t('settings.sidebarDesc') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.sidebarVisible"
                          :label="t('settings.sidebarToggle')"
                          @update:model-value="(v) => settings.set('sidebarVisible', v)"
                        />
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.nativeMenuBar') }}</p>
                          <p class="set-row-desc">{{ t('settings.nativeMenuBarDesc') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.nativeMenuBar"
                          :label="t('settings.nativeMenuBar')"
                          @update:model-value="toggleMenuBar"
                        />
                      </div>
                      <div class="set-row" :title="t('settings.outlineRightDesc')">
                        <div>
                          <p class="set-row-label">{{ t('settings.outlineRight') }}</p>
                          <p class="set-row-desc">{{ t('settings.outlineRightShort') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.outlineOnRight"
                          :label="t('settings.outlineRight')"
                          @update:model-value="toggleOutlineRight"
                        />
                      </div>
                    </section>

                    <section class="set-card">
                      <h3 class="set-card-title">{{ t('settings.cardSession') }}</h3>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.autoSave') }}</p>
                          <p class="set-row-desc">{{ t('settings.autoSaveManualHint') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.autoSave"
                          :label="t('settings.autoSave')"
                          @update:model-value="toggleAutoSave"
                        />
                      </div>
                      <div v-if="settings.autoSave" class="set-row">
                        <p class="set-row-desc">{{ t('settings.interval') }}</p>
                        <div class="flex flex-1 items-center gap-3">
                          <input
                            type="range"
                            class="range flex-1"
                            min="1"
                            max="30"
                            :aria-label="t('settings.autoSaveInterval')"
                            :value="settings.autoSaveInterval"
                            @input="
                              settings.set(
                                'autoSaveInterval',
                                Number(($event.target as HTMLInputElement).value)
                              )
                            "
                          />
                          <span class="w-9 text-right text-ui-sm text-ink-2"
                            >{{ settings.autoSaveInterval }}s</span
                          >
                        </div>
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.restoreSession') }}</p>
                          <p class="set-row-desc">{{ t('settings.restoreSessionDesc') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.restoreSession"
                          :label="t('settings.restoreSession')"
                          @update:model-value="(v) => settings.set('restoreSession', v)"
                        />
                      </div>
                      <!-- 用户口径：「最小化/后台一会儿就报页面无响应，明明没卡死，取消掉」。
                           默认开（真卡死仍要提示）；关掉只停无响应巡检，崩溃恢复不受影响。 -->
                      <div class="set-row" :title="t('settings.unresponsivePromptEnabledDesc')">
                        <div>
                          <p class="set-row-label">{{ t('settings.unresponsivePromptEnabled') }}</p>
                          <p class="set-row-desc">
                            {{ t('settings.unresponsivePromptEnabledDesc') }}
                          </p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.unresponsivePromptEnabled"
                          :label="t('settings.unresponsivePromptEnabled')"
                          data-setting-unresponsive-prompt
                          @update:model-value="(v) => settings.set('unresponsivePromptEnabled', v)"
                        />
                      </div>
                      <div class="set-row" :title="t('settings.historyHint')">
                        <div>
                          <p class="set-row-label">{{ t('settings.historyEnabled') }}</p>
                          <p class="set-row-desc">{{ t('settings.historyEnabledDesc') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.historyEnabled"
                          :label="t('settings.historyEnabled')"
                          data-setting-history-switch
                          @update:model-value="(v) => settings.set('historyEnabled', v)"
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
                      <h3 class="set-card-title">{{ t('settings.cardText') }}</h3>
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
                          <span class="set-fold-hint">{{ t('settings.encodingFoldHint') }}</span>
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
                        {{ t('settings.advanced') }}
                      </summary>
                      <div class="set-fold-body">
                        <div class="set-row" :title="t('settings.autoCheckUpdateDesc')">
                          <div>
                            <p class="set-row-label">{{ t('settings.autoCheckUpdate') }}</p>
                            <p class="set-row-desc">{{ t('settings.autoCheckUpdateHint') }}</p>
                          </div>
                          <SettingSwitch
                            :model-value="settings.autoCheckUpdate"
                            :label="t('settings.autoCheckUpdate')"
                            @update:model-value="(v) => settings.set('autoCheckUpdate', v)"
                          />
                        </div>
                      </div>
                    </details>

                    <!-- 备份（审计 §2 P1）：历史库此前是**唯一副本**，且和文档躺在同一个盘 -->
                    <details class="set-fold" data-backup-block>
                      <summary>
                        <Icon name="chevron-right" :size="13" class="set-fold-chevron" />
                        {{ t('settings.backup') }}
                      </summary>
                      <div class="set-fold-body">
                        <p class="set-row-desc">{{ t('settings.backupHint') }}</p>

                        <div class="set-row mt-3" :title="t('settings.backupAutoDesc')">
                          <div>
                            <p class="set-row-label">{{ t('settings.backupAuto') }}</p>
                            <p class="set-row-desc">{{ t('settings.backupAutoDesc') }}</p>
                          </div>
                          <SettingSwitch
                            :model-value="settings.backupAuto !== false"
                            :label="t('settings.backupAuto')"
                            @update:model-value="
                              (v) => {
                                settings.set('backupAuto', v)
                                void refreshBackup()
                              }
                            "
                          />
                        </div>

                        <div class="set-row">
                          <div class="min-w-0">
                            <p class="set-row-label">{{ t('settings.backupDir') }}</p>
                            <p class="set-row-desc break-all" data-backup-dir>
                              {{ backupDirLabel }}
                            </p>
                            <p v-if="backupState?.isDefaultDir" class="set-row-desc">
                              {{ t('settings.backupDirSameDisk') }}
                            </p>
                            <p class="set-row-desc" data-backup-count>
                              {{ backupCountLabel }} · {{ backupLastLabel }}
                            </p>
                          </div>
                          <div class="flex shrink-0 flex-wrap justify-end gap-2">
                            <button
                              class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink disabled:opacity-50"
                              :disabled="backupBusy"
                              data-backup-choose-dir
                              @click="chooseBackupDir()"
                            >
                              {{ t('settings.backupChooseDir') }}
                            </button>
                            <button
                              v-if="backupState && !backupState.isDefaultDir"
                              class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
                              data-backup-default-dir
                              @click="useDefaultBackupDir()"
                            >
                              {{ t('settings.backupUseDefault') }}
                            </button>
                            <button
                              class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
                              data-backup-open-dir
                              @click="revealBackupDir()"
                            >
                              {{ t('settings.backupOpenDir') }}
                            </button>
                            <button
                              class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink disabled:opacity-50"
                              :disabled="backupBusy"
                              data-backup-run
                              @click="runBackupNow()"
                            >
                              {{ t('settings.backupRunNow') }}
                            </button>
                            <button
                              class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink disabled:opacity-50"
                              :disabled="backupBusy"
                              data-backup-snapshot
                              @click="exportWorkspaceSnapshot()"
                            >
                              {{ t('settings.backupSnapshot') }}
                            </button>
                          </div>
                        </div>
                        <p class="set-row-desc">{{ t('settings.backupSnapshotDesc') }}</p>
                      </div>
                    </details>

                    <!-- 数据库维护：低频、有破坏性（VACUUM 会重建库）⇒ 放最底下，单独一片 -->
                    <details class="set-fold">
                      <summary>
                        <Icon name="chevron-right" :size="13" class="set-fold-chevron" />
                        {{ t('settings.dbMaintenance') }}
                      </summary>
                      <div class="set-fold-body">
                        <p class="set-row-desc">{{ t('settings.dbMaintenanceHint') }}</p>
                        <div class="mt-3 flex flex-wrap gap-2">
                          <button
                            class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink disabled:opacity-50"
                            :disabled="dbBusy"
                            data-db-check
                            @click="runDbMaintenance('check')"
                          >
                            {{ t('settings.dbCheck') }}
                          </button>
                          <button
                            class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink disabled:opacity-50"
                            :disabled="dbBusy"
                            data-db-reindex
                            @click="runDbMaintenance('rebuild')"
                          >
                            {{ t('settings.dbReindex') }}
                          </button>
                          <button
                            class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink disabled:opacity-50"
                            :disabled="dbBusy"
                            data-db-vacuum
                            @click="runDbMaintenance('vacuum')"
                          >
                            {{ t('settings.dbVacuum') }}
                          </button>
                        </div>
                      </div>
                    </details>

                    <!-- 设置的搬运（导出/导入）+ 恢复默认：都是低频动作 ⇒ 放最底下；覆盖性的要二次确认 -->
                    <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
                      <button
                        class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink disabled:opacity-50"
                        data-settings-export
                        :disabled="settingsFileBusy"
                        :title="t('settings.exportSettingsHint')"
                        @click="exportSettingsFile()"
                      >
                        {{ t('settings.exportSettings') }}
                      </button>
                      <button
                        class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink disabled:opacity-50"
                        data-settings-import
                        :disabled="settingsFileBusy"
                        @click="importSettingsFile()"
                      >
                        {{ t('settings.importSettings') }}
                      </button>
                      <button
                        class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
                        data-settings-diagnostics
                        @click="copyDiagnostics()"
                      >
                        {{ t('settings.copyDiagnostics') }}
                      </button>
                      <button
                        class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
                        data-settings-export-startup
                        @click="exportStartupDiagnostics()"
                      >
                        {{ t('settings.exportStartupDiagnostics') }}
                      </button>
                      <button
                        class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
                        data-settings-open-logs
                        @click="openLogDir()"
                      >
                        {{ t('settings.openLogDir') }}
                      </button>
                      <button
                        class="rounded-lg border border-edge px-3 py-1.5 text-ui text-ink-2 transition-colors hover:border-[color-mix(in_srgb,var(--danger)_45%,transparent)] hover:text-danger-ink"
                        data-settings-reset
                        @click="resetAllSettings()"
                      >
                        {{ t('settings.reset') }}
                      </button>
                    </div>
                  </template>

                  <!-- ── 编辑器 ── -->
                  <template v-else-if="tab.id === 'editor'">
                    <!-- 快捷工具栏：开关常显；19 项排序/显隐是低频操作，收在折叠里（SettingsToolbar 内部） -->
                    <SettingsToolbar />

                    <section class="set-card">
                      <h3 class="set-card-title">{{ t('settings.editorMode') }}</h3>
                      <div
                        class="grid grid-cols-3 gap-2.5"
                        role="group"
                        :aria-label="t('settings.editorMode')"
                      >
                        <button
                          v-for="m in modes"
                          :key="m.mode"
                          class="rounded-xl border px-3 py-3 text-center transition-all duration-150"
                          :class="
                            settings.editorMode === m.mode
                              ? 'border-accent bg-accent-soft text-accent-ink'
                              : 'border-edge text-ink-2 hover:border-edge-strong hover:text-ink'
                          "
                          :title="m.desc"
                          :aria-pressed="settings.editorMode === m.mode"
                          @click="settings.set('editorMode', m.mode)"
                        >
                          <Icon :name="m.icon" :size="16" class="mx-auto" />
                          <span class="mt-1.5 block text-ui font-medium">{{ m.label }}</span>
                        </button>
                      </div>
                      <p class="set-row-desc mt-3">
                        {{ modes.find((m) => m.mode === settings.editorMode)?.desc }}
                      </p>
                    </section>

                    <section class="set-card">
                      <h3 class="set-card-title">{{ t('settings.cardEditBehavior') }}</h3>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.syncScroll') }}</p>
                          <p class="set-row-desc">{{ t('settings.syncScrollDesc') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.syncScroll"
                          :label="t('settings.syncScroll')"
                          @update:model-value="(v) => settings.set('syncScroll', v)"
                        />
                      </div>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.codeLineNumbers') }}</p>
                          <p class="set-row-desc">{{ t('settings.codeLineNumbersDesc') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.codeLineNumbers"
                          :label="t('settings.codeLineNumbers')"
                          @update:model-value="(v) => settings.set('codeLineNumbers', v)"
                        />
                      </div>
                      <!-- 行内标记字符（用户口径：默认**显示**，开关打开后「永不显形」）。
                           只影响所见即所得的显隐装饰层（inlineMarks）：标记仍是文档里的
                           真实文本，保存/导出/往返字节不变；字面量标记与转义反斜杠不在这个口径里
                           （见 shared/defaults.ts 的说明）。`data-setting-*` 是给 CDP 套件的
                           稳定锚点（与 data-setting-word-goal 同一约定，不按本地化文字找控件）。 -->
                      <div class="set-row" :title="t('settings.hideInlineMarkersDesc')">
                        <div>
                          <p class="set-row-label">{{ t('settings.hideInlineMarkers') }}</p>
                          <p class="set-row-desc">{{ t('settings.hideInlineMarkersDesc') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.hideInlineMarkers"
                          :label="t('settings.hideInlineMarkers')"
                          data-setting-hide-inline-markers
                          @update:model-value="(v) => settings.set('hideInlineMarkers', v)"
                        />
                      </div>
                      <div class="set-row" :title="t('settings.remoteImagesHint')">
                        <div>
                          <p class="set-row-label">{{ t('settings.remoteImages') }}</p>
                          <p class="set-row-desc">{{ t('settings.remoteImagesHint') }}</p>
                        </div>
                        <div
                          class="flex gap-1.5"
                          role="group"
                          :aria-label="t('settings.remoteImages')"
                        >
                          <button
                            v-for="p in remoteImagePolicies"
                            :key="p.value"
                            class="whitespace-nowrap rounded-lg border px-3 py-1.5 text-ui transition-all duration-150"
                            :class="
                              settings.remoteImages === p.value
                                ? 'border-accent bg-accent-soft text-accent-ink'
                                : 'border-edge text-ink-2 hover:border-edge-strong'
                            "
                            :aria-pressed="settings.remoteImages === p.value"
                            @click="settings.set('remoteImages', p.value)"
                          >
                            {{ p.label }}
                          </button>
                        </div>
                      </div>
                      <!-- 目标字数（审计清单「目标字数 / 阅读时长」）：0 = 未设置，
                           设了之后状态栏才出现「当前/目标」那一格；达成时变强调色 + 对勾。 -->
                      <div class="set-row" :title="t('settings.wordGoalHint')">
                        <div>
                          <p class="set-row-label">{{ t('settings.wordGoal') }}</p>
                          <p class="set-row-desc">{{ t('settings.wordGoalDesc') }}</p>
                        </div>
                        <select
                          class="input select !w-[130px] shrink-0"
                          :value="String(settings.wordGoal)"
                          :aria-label="t('settings.wordGoal')"
                          data-setting-word-goal
                          @change="
                            settings.set(
                              'wordGoal',
                              Number(($event.target as HTMLSelectElement).value)
                            )
                          "
                        >
                          <option v-for="n in WORD_GOAL_CHOICES" :key="n" :value="String(n)">
                            {{
                              n === 0
                                ? t('settings.wordGoalNone')
                                : t('settings.wordGoalValue', { n })
                            }}
                          </option>
                        </select>
                      </div>
                    </section>

                    <!-- 拼写检查：总开关 + 语言多选。
                         第一项**固定是「中文（简体）」**：它由渲染层的启发式规则完成，
                         不是 Chromium 词典（availableSpellCheckerLanguages 里没有 zh）；
                         其余项来自 availableSpellCheckerLanguages（常见语言前置、其余字母序）。 -->
                    <section class="set-card">
                      <h3 class="set-card-title">{{ t('settings.cardSpellcheck') }}</h3>
                      <div class="set-row">
                        <div>
                          <p class="set-row-label">{{ t('settings.spellcheckEnabled') }}</p>
                          <p class="set-row-desc">{{ t('settings.spellcheckEnabledDesc') }}</p>
                        </div>
                        <SettingSwitch
                          :model-value="settings.spellcheckEnabled"
                          :label="t('settings.spellcheckEnabled')"
                          data-setting-spellcheck
                          @update:model-value="setSpellcheckEnabled"
                        />
                      </div>
                      <div
                        v-if="settings.spellcheckEnabled"
                        class="set-row"
                        data-setting-spellcheck-languages
                      >
                        <div class="w-full">
                          <div class="flex items-baseline justify-between gap-3">
                            <p class="set-row-label">{{ t('settings.spellcheckLanguages') }}</p>
                            <p v-if="spellAvailable.length" class="text-ui-sm text-ink-3">
                              {{ t('settings.spellcheckAvailable') }}
                            </p>
                          </div>
                          <p class="set-row-desc">{{ t('settings.spellcheckLanguagesDesc') }}</p>
                          <p class="set-row-desc mt-1" data-spellcheck-zh-note>
                            {{ t('settings.spellcheckZhNote') }}
                          </p>
                          <p
                            v-if="spellState && !spellChromiumAvailable.length"
                            class="set-row-desc"
                            data-spellcheck-no-dictionary
                          >
                            {{ t('settings.spellcheckNoLanguages') }}
                          </p>
                          <div
                            class="mt-2 grid max-h-56 grid-cols-2 gap-x-4 gap-y-0.5 overflow-y-auto pr-1"
                          >
                            <label
                              v-for="code in spellAvailable"
                              :key="code"
                              class="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-ui text-ink-2 hover:bg-[var(--accent-soft)]"
                            >
                              <input
                                type="checkbox"
                                class="accent-[var(--accent)]"
                                :checked="spellEffective.includes(code)"
                                :disabled="
                                  spellEffective.includes(code) && spellEffective.length <= 1
                                "
                                :data-setting-spellcheck-lang="code"
                                @change="toggleSpellLanguage(code)"
                              />
                              <span class="min-w-0 flex-1 truncate">
                                {{ spellLanguageLabel(code) }}
                              </span>
                              <span class="shrink-0 text-ui-sm text-ink-3">{{ code }}</span>
                            </label>
                          </div>
                          <p
                            v-if="spellState && settings.spellcheckLanguages.length === 0"
                            class="set-row-desc mt-2"
                            data-spellcheck-auto
                          >
                            {{ t('settings.spellcheckAuto', { langs: spellEffectiveLabel }) }}
                          </p>
                        </div>
                      </div>
                    </section>

                    <!-- 字体与排版 + 就地预览：合成一张卡（预览就在滑杆下面，改一下立刻看到） -->
                    <section class="set-card">
                      <h3 class="set-card-title">{{ t('settings.cardTypography') }}</h3>
                      <div class="set-row">
                        <p class="set-row-desc">{{ t('settings.fontSize') }}</p>
                        <div class="flex flex-1 items-center gap-3">
                          <input
                            type="range"
                            class="range flex-1"
                            min="13"
                            max="26"
                            :aria-label="t('settings.fontSize')"
                            :value="settings.fontSize"
                            @input="
                              settings.set(
                                'fontSize',
                                Number(($event.target as HTMLInputElement).value)
                              )
                            "
                          />
                          <span class="w-10 text-right text-ui-sm text-ink-2"
                            >{{ settings.fontSize }}px</span
                          >
                        </div>
                      </div>
                      <div class="set-row">
                        <p class="set-row-desc">{{ t('settings.lineHeight') }}</p>
                        <div class="flex flex-1 items-center gap-3">
                          <input
                            type="range"
                            class="range flex-1"
                            min="1.3"
                            max="2.6"
                            step="0.1"
                            :aria-label="t('settings.lineHeight')"
                            :value="settings.lineHeight"
                            @input="
                              settings.set(
                                'lineHeight',
                                Number(($event.target as HTMLInputElement).value)
                              )
                            "
                          />
                          <span class="w-10 text-right text-ui-sm text-ink-2">{{
                            settings.lineHeight.toFixed(1)
                          }}</span>
                        </div>
                      </div>
                      <div class="set-row">
                        <p class="set-row-desc">{{ t('settings.fontFamilyLabel') }}</p>
                        <div
                          class="flex gap-1.5"
                          role="group"
                          :aria-label="t('settings.fontFamilyLabel')"
                        >
                          <button
                            v-for="f in FONT_OPTIONS"
                            :key="f.label"
                            class="rounded-lg border px-3 py-1.5 text-ui transition-all duration-150"
                            :class="
                              settings.fontFamily === f.value
                                ? 'border-accent bg-accent-soft text-accent-ink'
                                : 'border-edge text-ink-2 hover:border-edge-strong'
                            "
                            :aria-pressed="settings.fontFamily === f.value"
                            @click="settings.set('fontFamily', f.value)"
                          >
                            {{
                              f.label === 'sans'
                                ? t('settings.fontSansShort')
                                : f.label === 'serif'
                                  ? t('settings.fontSerifShort')
                                  : t('settings.fontMonoShort')
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
                          {{ t('settings.previewLead') }} <strong>{{ t('editor.bold') }}</strong
                          >{{ t('settings.previewSep') }}<em>{{ t('editor.italic') }}</em>
                          {{ t('settings.previewAnd') }} <code>{{ t('editor.inlineCode') }}</code
                          >{{ t('settings.previewDot') }}
                        </p>
                      </div>
                    </section>
                  </template>

                  <!-- ── 外观 ── -->
                  <template v-else-if="tab.id === 'appearance'">
                    <section class="set-card">
                      <h3 class="set-card-title">{{ t('settings.theme') }}</h3>
                      <!-- 主题卡：宽窗口 4 列；**窄窗口 3 列**（审计 §8 P2「最小窗口 940×600
                           下设置页横向偏紧」）—— 940×600 与 1366@125% 缩放（逻辑宽 1093）
                           都落在 3 列这一档，这时每张卡约 205px，缩略图与标签不再挤在一起。
                           ⚠️ 波次 2 把**最小窗口**降到 760×520（见 main/windowPlacement.ts）：
                           这一档 3 列在 760px 下每张卡约 150px，缩略图会明显变小但仍在网格里；
                           想再拆一档（760 下 2 列）的话，断点值要同时改这里与窄窗的四处口径。 -->
                      <div
                        class="grid grid-cols-3 gap-2.5 min-[1180px]:grid-cols-4"
                        data-theme-grid
                      >
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
                            :style="{ background: th.preview.shell }"
                          >
                            <div
                              class="h-7 w-12 rounded-md border"
                              :style="{
                                background: th.preview.paper,
                                borderColor: th.preview.line
                              }"
                            >
                              <div
                                class="mt-1.5 h-1 w-7 rounded-sm"
                                :style="{ background: th.preview.line, marginLeft: '4px' }"
                              />
                              <div
                                class="mt-1 h-1 w-9 rounded-sm"
                                :style="{ background: th.preview.line, marginLeft: '4px' }"
                              />
                            </div>
                          </div>
                          <div class="flex items-center gap-2 border-t border-edge px-2.5 py-2">
                            <Icon
                              :name="th.icon"
                              :size="13"
                              :class="settings.theme === th.mode ? 'text-accent' : 'text-ink-2b'"
                            />
                            <span class="min-w-0 flex-1 truncate text-ui text-ink">{{
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
                  <template v-else-if="tab.id === 'export'">
                    <section class="set-card">
                      <h3 class="set-card-title">{{ t('settings.pdfCard') }}</h3>
                      <div class="set-row">
                        <p class="set-row-desc">{{ t('settings.pdfMargin') }}</p>
                        <div class="flex flex-1 items-center gap-3">
                          <input
                            type="range"
                            class="range flex-1"
                            min="8"
                            max="50"
                            :aria-label="t('settings.pdfMargin')"
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
                          <span class="w-11 text-right text-ui-sm text-ink-2"
                            >{{ settings.export.pdf.margin }}mm</span
                          >
                        </div>
                      </div>
                      <div class="set-row">
                        <p class="set-row-desc">{{ t('settings.pdfPageSize') }}</p>
                        <div
                          class="flex gap-1.5"
                          role="group"
                          :aria-label="t('settings.pdfPageSize')"
                        >
                          <button
                            v-for="size in ['A4', 'A5', 'Letter'] as const"
                            :key="size"
                            class="rounded-lg border px-3.5 py-1.5 text-ui transition-all duration-150"
                            :class="
                              settings.export.pdf.pageSize === size
                                ? 'border-accent bg-accent-soft text-accent-ink'
                                : 'border-edge text-ink-2 hover:border-edge-strong'
                            "
                            :aria-pressed="settings.export.pdf.pageSize === size"
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
                        {{ t('settings.exportFormats') }}
                        <span class="set-fold-hint">PDF · HTML · Word · EPUB</span>
                      </summary>
                      <div class="set-fold-body">
                        <div class="space-y-2">
                          <div
                            v-for="row in exportFormats"
                            :key="row.name"
                            class="flex items-center gap-3 rounded-xl border border-edge px-3.5 py-2"
                          >
                            <span
                              class="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent"
                            >
                              <Icon :name="row.icon" :size="13" />
                            </span>
                            <p class="min-w-0 flex-1 text-ui text-ink">{{ row.name }}</p>
                            <p class="truncate text-[11.5px] text-ink-2b">{{ row.desc }}</p>
                          </div>
                        </div>
                        <p class="set-row-desc mt-3">{{ t('settings.exportUsageHint') }}</p>
                        <!-- 格式的**如实说明**（审计 §7 第 18 条：Word 若要真 docx 得引入
                             OOXML 写出，否则必须明确标注是降级格式，而不能含糊过去） -->
                        <p class="set-row-desc mt-1">{{ t('settings.exportNote') }}</p>
                      </div>
                    </details>
                  </template>

                  <!-- AI：三张分组卡片（连接 / 行为 / 安全说明）。
                       Key 输入框保存后立刻清空，界面只显示"已保存/未设置"——
                       渲染层没有任何读回 Key 的通道（见 preload 的 ai API）。 -->
                  <template v-else-if="tab.id === 'ai'">
                    <!-- ① 连接 -->
                    <section class="set-card set-card--boxed" data-ai-card="connection">
                      <header class="ai-card-head">
                        <span class="ai-card-head__icon"><Icon name="globe" :size="15" /></span>
                        <div class="ai-card-head__meta">
                          <h3 class="ai-card-head__title">{{ t('settings.aiCardConnection') }}</h3>
                          <p class="ai-card-head__desc">{{ t('settings.aiCardConnectionDesc') }}</p>
                        </div>
                      </header>

                      <div class="ai-card-body">
                        <div class="ai-settings-grid">
                          <label class="ai-field">
                            <span class="set-row-label">{{ t('settings.aiProvider') }}</span>
                            <select
                              class="input select"
                              :value="aiPresetId"
                              data-ai-provider
                              @change="onAiPresetChange(($event.target as HTMLSelectElement).value)"
                            >
                              <option
                                v-for="preset in AI_PROVIDER_PRESETS"
                                :key="preset.id"
                                :value="preset.id"
                              >
                                {{ t(preset.labelKey) }}
                              </option>
                            </select>
                          </label>
                          <label class="ai-field">
                            <span class="set-row-label">{{ t('settings.aiBaseUrl') }}</span>
                            <input
                              v-model="aiBaseDraft"
                              type="url"
                              class="input"
                              :class="{ 'input--invalid': aiBaseInvalid }"
                              spellcheck="false"
                              data-ai-base-url
                              :aria-invalid="aiBaseInvalid ? 'true' : 'false'"
                              :placeholder="t('settings.aiBaseUrlPlaceholder')"
                            />
                            <span class="set-row-desc">{{ t('settings.aiBaseUrlDesc') }}</span>
                          </label>
                          <label class="ai-field">
                            <span class="set-row-label">{{ t('settings.aiModel') }}</span>
                            <input
                              v-model="aiModelDraft"
                              type="text"
                              class="input"
                              spellcheck="false"
                              data-ai-model
                              :placeholder="t('settings.aiModelPlaceholder')"
                            />
                            <span class="set-row-desc">{{ t('settings.aiModelDesc') }}</span>
                          </label>
                        </div>

                        <div class="set-row ai-key-row">
                          <div>
                            <p class="set-row-label">{{ t('settings.aiKey') }}</p>
                            <p
                              class="ai-status mt-1"
                              :class="aiStatus?.hasKey ? 'is-ok' : 'is-muted'"
                              data-ai-key-status
                            >
                              <Icon v-if="aiStatus?.hasKey" name="check" :size="12" />{{
                                aiKeyLabel
                              }}
                            </p>
                          </div>
                          <div class="ai-key-controls">
                            <input
                              v-model="aiKeyInput"
                              type="password"
                              class="input ai-key-input"
                              spellcheck="false"
                              autocomplete="off"
                              data-ai-key-input
                              :placeholder="t('settings.aiKeyPlaceholder')"
                            />
                            <button
                              class="btn btn-primary px-4 py-2"
                              :disabled="aiBusy"
                              data-ai-save
                              @click="saveAi()"
                            >
                              {{ t('common.save') }}
                            </button>
                            <button
                              v-if="aiStatus?.hasKey"
                              class="btn btn-ghost px-3 py-2"
                              :disabled="aiBusy"
                              data-ai-clear
                              @click="clearAiKey()"
                            >
                              {{ t('settings.aiClearKey') }}
                            </button>
                          </div>
                        </div>

                        <div class="ai-test-row">
                          <button
                            class="btn btn-outline px-4 py-2"
                            :disabled="aiTesting || aiBusy"
                            data-ai-test
                            @click="testAi()"
                          >
                            {{ aiTesting ? t('settings.aiTesting') : t('settings.aiTest') }}
                          </button>
                          <span v-if="aiNoticeText" class="ai-status is-muted" data-ai-notice>
                            <Icon name="check" :size="12" />{{ aiNoticeText }}
                          </span>
                          <span
                            v-if="aiTestText"
                            class="ai-status"
                            :class="aiTestState?.ok ? 'is-ok' : 'is-error'"
                            data-ai-test-result
                          >
                            <Icon :name="aiTestState?.ok ? 'check' : 'info'" :size="12" />{{
                              aiTestText
                            }}
                          </span>
                        </div>
                        <p v-if="aiBaseInvalid" class="ai-status is-error" data-ai-base-invalid>
                          <Icon name="info" :size="12" />{{ t('ai.error.invalidBaseUrl') }}
                        </p>
                      </div>
                    </section>

                    <!-- ② 行为 -->
                    <section class="set-card set-card--boxed" data-ai-card="behavior">
                      <header class="ai-card-head">
                        <span class="ai-card-head__icon"><Icon name="settings" :size="15" /></span>
                        <div class="ai-card-head__meta">
                          <h3 class="ai-card-head__title">{{ t('settings.aiCardBehavior') }}</h3>
                          <p class="ai-card-head__desc">{{ t('settings.aiCardBehaviorDesc') }}</p>
                        </div>
                      </header>

                      <div class="ai-card-body">
                        <div class="set-row">
                          <div>
                            <p class="set-row-label">{{ t('settings.aiContextDefault') }}</p>
                            <p class="set-row-desc">{{ t('settings.aiContextDefaultDesc') }}</p>
                          </div>
                          <div
                            class="ai-context-choice"
                            role="group"
                            :aria-label="t('settings.aiContextDefault')"
                            data-ai-context-choice
                          >
                            <button
                              type="button"
                              :class="{ 'is-active': settings.aiContextDefault === 'selection' }"
                              :aria-pressed="settings.aiContextDefault === 'selection'"
                              data-ai-context-default="selection"
                              @click="setAiContextDefault('selection')"
                            >
                              {{ t('settings.aiContextSelection') }}
                            </button>
                            <button
                              type="button"
                              :class="{ 'is-active': settings.aiContextDefault === 'document' }"
                              :aria-pressed="settings.aiContextDefault === 'document'"
                              data-ai-context-default="document"
                              @click="setAiContextDefault('document')"
                            >
                              {{ t('settings.aiContextDocument') }}
                            </button>
                          </div>
                        </div>

                        <div class="set-row">
                          <div>
                            <p class="set-row-label">{{ t('settings.aiCharLimit') }}</p>
                            <p class="set-row-desc">{{ t('settings.aiCharLimitDesc') }}</p>
                          </div>
                          <span class="ai-status is-muted" data-ai-char-limit>
                            <Icon name="info" :size="12" />{{
                              t('settings.aiCharLimitValue', { n: AI_MAX_INPUT_CHARS })
                            }}
                          </span>
                        </div>

                        <div class="set-row">
                          <div>
                            <p class="set-row-label">{{ t('settings.aiStream') }}</p>
                            <p class="set-row-desc">{{ t('settings.aiStreamDesc') }}</p>
                          </div>
                          <SettingSwitch
                            :model-value="settings.aiStream"
                            :label="t('settings.aiStream')"
                            data-ai-stream-switch
                            @update:model-value="settings.set('aiStream', $event)"
                          />
                        </div>
                      </div>
                    </section>

                    <!-- ③ 安全说明 -->
                    <section class="set-card set-card--boxed" data-ai-card="security">
                      <header class="ai-card-head">
                        <span class="ai-card-head__icon"><Icon name="info" :size="15" /></span>
                        <div class="ai-card-head__meta">
                          <h3 class="ai-card-head__title">{{ t('settings.aiCardSecurity') }}</h3>
                          <p class="ai-card-head__desc">{{ t('settings.aiSecurityIntro') }}</p>
                        </div>
                      </header>
                      <ul class="ai-security-list">
                        <li>{{ t('settings.aiSecurityLocal') }}</li>
                        <li>{{ t('settings.aiSecurityEncrypted') }}</li>
                        <li>{{ t('settings.aiSecurityLogs') }}</li>
                      </ul>
                    </section>
                  </template>

                  <!-- 链接：Ctrl/Cmd+左键打开链接时的行为与历史 -->
                  <template v-else-if="tab.id === 'keymap'">
                    <SettingsKeymap />
                  </template>

                  <template v-else-if="tab.id === 'links'">
                    <section class="set-card">
                      <h3 class="mb-1 text-[13.5px] text-ink">
                        {{ t('settings.linksCreateMode') }}
                      </h3>
                      <p class="mb-4 text-ui-sm text-ink-2b">
                        {{ t('settings.linksCreateModeDesc') }}
                      </p>
                      <div
                        class="grid grid-cols-3 gap-2"
                        role="group"
                        :aria-label="t('settings.linksCreateMode')"
                      >
                        <button
                          v-for="m in createModes"
                          :key="m.value"
                          class="flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[13px] transition-all duration-150"
                          :class="
                            settings.linkCreateMode === m.value
                              ? 'border-accent bg-accent-soft text-accent-ink'
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
                              class="flex-none rounded-lg border border-edge px-2.5 py-1 text-ui-sm text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
                              @click="clearLinkHistory()"
                            >
                              {{ t('settings.linksClear') }}
                            </button>
                          </div>
                          <p
                            v-if="!linkHistory.length"
                            class="rounded-xl border border-dashed border-edge px-3.5 py-6 text-center text-ui text-ink-2b"
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
                                class="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-panel-2 text-ink-2b"
                              >
                                <Icon name="link" :size="13" />
                              </span>
                              <div class="min-w-0 flex-1">
                                <p class="truncate text-[13px] text-ink" :title="item.target">
                                  {{ item.target }}
                                </p>
                                <p
                                  class="mt-0.5 truncate text-[11.5px] text-ink-2b"
                                  :title="item.path ?? ''"
                                >
                                  {{ formatTime(item.lastUsed) }} ·
                                  {{ t('settings.linksCount', { count: item.count }) }}
                                </p>
                              </div>
                              <span
                                class="flex-none rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2b"
                              >
                                {{ linkKindLabel(item.kind) }}
                              </span>
                              <span
                                class="flex-none rounded-md px-1.5 py-0.5 text-[11px]"
                                :class="
                                  item.action === 'declined'
                                    ? 'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning-ink'
                                    : 'bg-accent-soft text-accent-ink'
                                "
                              >
                                {{ linkActionLabel(item.action) }}
                              </span>
                              <span
                                v-if="item.created"
                                class="flex-none rounded-md bg-[color-mix(in_srgb,var(--ok)_16%,transparent)] px-1.5 py-0.5 text-[11px] text-ok-ink"
                              >
                                {{ t('settings.linksCreatedBadge') }}
                              </span>
                              <button
                                class="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-ink-2b transition-colors hover:bg-panel-2 hover:text-danger-ink"
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
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
