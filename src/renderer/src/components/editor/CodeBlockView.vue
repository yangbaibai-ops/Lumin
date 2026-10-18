<script setup lang="ts">
// ─── 代码块 NodeView：CodeMirror 6 嵌入 + 语言切换 + Mermaid 渲染 ───────────
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  rectangularSelection,
  crosshairCursor
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  // 代码块内的 Mod-z / Mod-y 由本组件在**捕获阶段**先试这两个命令，
  // 本地历史耗尽后再交外层 PM 全局历史（见 onCmKeydownCapture 的口径注释）
  undo as cmUndo,
  redo as cmRedo
} from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, selectNextOccurrence } from '@codemirror/search'
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  StreamLanguage,
  type Language
} from '@codemirror/language'
import type { Parser } from '@lezer/common'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap
} from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import { TextSelection } from '@tiptap/pm/state'
import { useSettingsStore } from '../../stores/settings'
import { useEditorStore } from '../../stores/editor'
import { useFilesStore } from '../../stores/files'
import { escapeHtml } from '../../lib/utils/html'
import {
  registerCodeBlockHandle,
  unregisterCodeBlockHandle,
  type CodeBlockHandle
} from '../../lib/editor/codeBlockViews'
import {
  CODE_UNMOUNT_DELAY_MS,
  caretOffsetInBlock,
  msUntilScrollIdle,
  shouldMountCm,
  shouldWarmMeasureLines,
  staticFallbackMinHeight,
  watchCodeBlockMount,
  STATIC_HIGHLIGHT
} from '../../lib/editor/codeBlockMountPolicy'
import { registerStaticParser, staticHighlightHtml } from '../../lib/editor/staticHighlight'
// 共享的 mermaid 尺寸清洗 / 预览状态（既有契约，mermaidSplitEdit 单测按这一行钉住）
import { nextMermaidPreviewState, normalizeMermaidSvg } from '../../lib/export'
// 本轮新增的纯函数（空源码口径 + 滚动锚点补偿 + 三态位置判定），单独一行以保持上面的契约行不变
import {
  mermaidAnchorScrollDelta,
  mermaidBlockPosition,
  normalizeMermaidSource,
  type MermaidBlockPosition
} from '../../lib/export'
import type { MermaidConfig } from 'mermaid'
import {
  PLAIN_TEXT_LANGUAGE,
  detectLanguage,
  filterLanguagePresets,
  needsNoHighlightNotice,
  normalizeLanguageName,
  resolveLanguageKey
} from '../../lib/editor/codeBlockLanguage'
// 浮层定位的几何计算（纯函数，单测钉住"与代码块 rect 交集 = 0"）：
// 用户口径是本轮新增的「浮层在代码块**外面**、不压代码」，算法与断言都集中在那里。
import { placePicker, type PickerSide } from '../../lib/editor/codeBlockLangPicker'

const props = defineProps(nodeViewProps)
const settings = useSettingsStore()
const editorStore = useEditorStore()

/**
 * 语言支持：**显式映射表**（清单 §1.B / 自查报告 O3）。
 *
 * 原来用 `@codemirror/language-data` 的 `languages` 表找 `load()` —— 那张表覆盖 115 种语言，
 * 于是构建产物里留下 **116 个 `import()` 目标（合计约 1.6MB）**，而本组件的常用语言清单
 * 只有十几种（+ mermaid 走预览）。现在按清单显式列出来：`@codemirror/lang-*` 为主，
 * `bash` / `ruby` 走 `@codemirror/legacy-modes` + `StreamLanguage`，多出来的体积就不发了。
 *
 * ⚠️ 口径（2026 本轮更新）：**列表之外的任何语言名都合法**，只是没有内置高亮包 ——
 * 写进 `language` 属性、照常往返，代码区按纯文本显示，选择器里标注「未内置高亮」。
 * 预设清单 / 别名 / 自动识别都在 `lib/editor/codeBlockLanguage.ts`（纯函数，有单测）。
 */
type LanguageLoader = () => Promise<Extension>

const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  typescript: () =>
    import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  bash: () =>
    import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  ruby: () =>
    import('@codemirror/legacy-modes/mode/ruby').then((m) => StreamLanguage.define(m.ruby))
}

/**
 * 从语言扩展里取出 Lezer 解析器（静态态高亮要用，P2）。
 *
 * 两种形态都要认：`@codemirror/lang-*` 返回 `LanguageSupport`（解析器在 `.language` 上），
 * `StreamLanguage.define()` 返回的就是 `Language` 本身。取不到就返回 null（静态态按纯文本）。
 */
function parserOf(ext: Extension): Parser | null {
  const asSupport = ext as { language?: Language }
  const lang = asSupport.language ?? (ext as unknown as Language)
  return (lang as { parser?: Parser }).parser ?? null
}

const editorRef = ref<HTMLElement | null>(null)
/** 静态态 <pre>（Esc 把焦点还给代码区时用） */
const staticRef = ref<HTMLElement | null>(null)
/** mermaid 容器（语言浮层的锚点 / Esc 还焦点时用） */
const mermaidBlockRef = ref<HTMLElement | null>(null)

/**
 * ─── 语言状态：显式 / 自动识别 / 生效值（三者分开，别合并）────────────────────
 *
 * `explicitLanguage`：`code` 节点的 `language` 属性（用户设置过 / 文档里写的）。
 * `detectedLanguage`：**只在没有显式语言时**按内容启发式识别出来的语言。它**不写回节点** ——
 *   自动识别是"显示层"的判断，写回去就变成了"用户显式设置"，下次改内容也再也不会重新识别。
 * `selectedLanguage`：渲染实际用的那一个（显式优先；都没有 = 纯文本）。
 *
 * 于是"显式设置过的语言不得被自动识别覆盖"是**结构性**成立的：有显式值时
 * `scheduleDetect()` 直接返回，`detectLanguage()` 根本不会被调用。
 */
const explicitLanguage = ref(normalizeLanguageName(props.node.attrs.language))
const detectedLanguage = ref<string | null>(null)
const selectedLanguage = computed(
  () => explicitLanguage.value || detectedLanguage.value || PLAIN_TEXT_LANGUAGE
)

/** 用户显式清空语言后，本次会话内不再用自动识别把它"猜"回来（见 applyLanguageChoice） */
let detectSuppressed = false
/**
 * 内容变化 → 重新识别的防抖（350ms）。
 * 为什么必须防抖：CM 每敲一个字符都会写回节点，识别要扫 12 组特征；
 * 不防抖的话一个 100 字的块要跑 100 次（1500 块的文档里就是 15 万次）。
 */
const DETECT_DEBOUNCE_MS = 350
let detectTimer: ReturnType<typeof setTimeout> | null = null

// ─── 语言浮层（combobox）：聚焦才出现、绝对/固定定位、不占布局 ─────────────────
// 状态机：pickerOpen（浮层在不在 DOM 里，v-if）→ listOpen（下拉列表开没开）。
// 空闲态 DOM 里**没有**这个节点（不是 display:none 的占位），所以不可能出现
// "未聚焦还留一条语言栏"的观感，也不会为 1500 个块各留一份输入框。
const pickerOpen = ref(false)
const listOpen = ref(false)
const pickerQuery = ref('')
const activeIndex = ref(0)
/** 浮层位置：fixed + 视口坐标（见 positionPicker 的注释：为什么必须 fixed） */
const pickerStyle = ref<Record<string, string>>({})
const pickerRef = ref<HTMLElement | null>(null)
const pickerInputRef = ref<HTMLInputElement | null>(null)
/** 每块一个唯一 listbox id（aria-controls / aria-activedescendant 要成对） */
let pickerSeq = 0
const pickerListId = `cb-lang-list-${++pickerSeq}`
/** Esc 关闭后把焦点还给代码区时，别让紧接着的 focusin 又把浮层打开 */
let suppressReopen = false
/** 应用语言时 PM 事务可能把焦点拽回编辑器根节点：这一拍内别因为失焦把浮层收了 */
let keepOpenOnFocusLoss = false

/** 当前语言没有内置高亮包（选择器里标注「未内置高亮」） */
const languageUnsupported = computed(() => needsNoHighlightNotice(selectedLanguage.value))

interface PickerItem {
  /** 选中后写进 `language` 属性的**原样字符串**（空串 = 无语言） */
  value: string
  /** 展示文本（预设就是它自己；自定义是"使用 xxx"的插值） */
  label: string
  /** 这一项是否要标「未内置高亮」 */
  note: boolean
  /** 是不是"输入框里的自定义语言"这一行 */
  custom: boolean
}

/**
 * 下拉候选。
 *   * 空输入：全部预设；
 *   * 有输入：先给匹配的预设，再把"用户输入的原文"作为最后一项（未内置也允许选，见需求 ③）。
 * 自定义项只有在输入**不是**已知语言名时才出现（输入 `typescript` 不该再冒一行重复的）。
 */
const pickerItems = computed<PickerItem[]>(() => {
  const raw = pickerQuery.value.trim()
  const items: PickerItem[] = filterLanguagePresets(raw).map((preset) => ({
    value: preset,
    label: preset,
    note: needsNoHighlightNotice(preset),
    custom: false
  }))
  if (!raw) return items
  const known =
    items.some((item) => item.value.toLowerCase() === raw.toLowerCase()) ||
    resolveLanguageKey(raw) !== null ||
    raw.toLowerCase() === PLAIN_TEXT_LANGUAGE
  if (!known)
    items.push({ value: raw, label: raw, note: needsNoHighlightNotice(raw), custom: true })
  return items
})

function optionId(index: number): string {
  return `${pickerListId}-opt-${index}`
}

let cmView: EditorView | null = null
let onPmBlurCapture: ((e: FocusEvent) => void) | null = null
const languageCompartment = new Compartment()
// 行号开关（设置项 codeLineNumbers）：用 Compartment 让切换即时生效，
// 无需重建 CM 实例，也不打断光标/滚动位置
const lineNumberCompartment = new Compartment()

// ── 每编辑器视图共享的 hasFocus 守卫 ────────────────────────────────────────
// 目的：CM 获得焦点期间令 PM 的 hasFocus() 返回 false，使其跳过选区同步
// （DOMObserver 误读 CM 选区 → selectionToDOM 重写 DOM → 焦点被抢回 PM 根）。
// 实现要点：多个代码块会同时存在，各自 onMounted 里链式覆盖 hasFocus、
// onBeforeUnmount 再还原（LIFO 假设）在“先删靠前代码块”等非 LIFO 卸载顺序下
// 会把已被置空的旧 wrapper 装回 hasFocus，下次调用即抛
// “prevHasFocus is not a function”。改为：每个 PM 视图只装一个守卫，用
// 引用计数跟踪仍挂载的代码块实例；全部卸载后才恢复原始实现。
interface HasFocusGuard {
  original: () => boolean
  count: number
}
const hasFocusGuards = new WeakMap<object, HasFocusGuard>()

function acquireHasFocusGuard(pmView: object): void {
  let guard = hasFocusGuards.get(pmView)
  if (!guard) {
    const v = pmView as { hasFocus: () => boolean }
    guard = {
      original: v.hasFocus.bind(v),
      count: 0
    }
    v.hasFocus = () => {
      const ae = document.activeElement
      if (ae && ae.closest('.cm-editor')) return false
      return guard!.original()
    }
    hasFocusGuards.set(pmView, guard)
  }
  guard.count++
}

function releaseHasFocusGuard(pmView: object): void {
  const guard = hasFocusGuards.get(pmView)
  if (!guard) return
  guard.count--
  if (guard.count <= 0) {
    ;(pmView as { hasFocus: () => boolean }).hasFocus = guard.original
    hasFocusGuards.delete(pmView)
  }
}

// ── CodeMirror 主题（CSS 变量驱动，随应用明暗/羊皮纸主题自动适配）──
const cmTheme = EditorView.theme({
  /**
   * 用户口径：代码字号与行距"各增大一点点"（12.5→13.5px、1.65→1.85）。
   * ⚠️ 必须与 `overlays.css` 里 `.md-preview pre.cb-static` 的 font-size/line-height
   * **逐项相同**：两态字号或行高一旦不同，「静态 → 挂载」的高度契约就失效（滚动跳变复发）。
   */
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', fontSize: '13.5px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.85' },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '10px 0 14px'
    /**
     * ⚠️ **换行口径**（tag `codeblock-wrap-no-fold`，本条改写过一次口径）：
     *
     * 上一版（`codeblock-mount-no-jump`）把这里钉成 `white-space: pre`（不换行），换来的是
     * 「两态高度一致」。现在用户口径是**代码要自动换行、不许出现横向滚动条**，于是两态一起
     * 改成换行 —— 但**「两态高度一致」这条约束没变**：
     *   * 挂载态：`buildCmExtensions()` 里加了 `EditorView.lineWrapping`（CM 自己按宽度折行、
     *     折出来的每一行都算进高度表），`.cm-content` 的 `white-space: pre-wrap` 写在
     *     overlays.css（0,4,0，压过 prosemirror.css 的 0,3,0）；
     *   * 静态态：同一个 `pre-wrap` + 同一套字号/行高/内边距/左右留白/行号槽宽。
     *
     * 为什么 `white-space` 仍然不能写在这个 theme 里：`.cm-content` 会被 prosemirror.css 的
     *   `.ProseMirror [contenteditable="false"] [contenteditable="true"] { white-space: pre-wrap }`
     * （0,3,0）命中，而 `EditorView.theme()` 生成的 `.ͼX .cm-content` 只有 (0,2,0)，压不住它。
     * 真正的声明在 overlays.css 的
     * `.md-preview .code-block-wrapper .cm-editor-container .cm-content`（0,4,0），由
     * tests/codeBlockMountHeight.test.mjs 钉住（与静态态逐项比对，包括换行口径）。
     */
  },
  // 代码块内拖拽已全局禁用（lib/dragGuard.ts）：不再配置 `.cm-dropCursor`（放置指示线）。
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel)'
  },
  // 不注册 highlightActiveLine：点击代码块时任一行都不该被底色标出来
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ink-3)', border: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--elevate)', border: '1px solid var(--edge)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--ink)'
  }
})

const mdHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: 'var(--code-key)' },
    {
      tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName],
      color: 'var(--accent-ink)'
    },
    { tag: [t.function(t.variableName), t.labelName], color: 'var(--code-num)' },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--code-num)' },
    { tag: [t.definition(t.name), t.separator], color: 'var(--ink-2)' },
    {
      tag: [
        t.typeName,
        t.className,
        t.number,
        t.changed,
        t.annotation,
        t.modifier,
        t.self,
        t.namespace
      ],
      color: 'var(--code-num)'
    },
    {
      tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
      color: 'var(--code-key-2)'
    },
    { tag: [t.meta, t.comment], color: 'var(--code-com)', fontStyle: 'italic' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, color: 'var(--code-key-2)', textDecoration: 'underline' },
    { tag: t.heading, fontWeight: '700', color: 'var(--accent)' },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: 'var(--warning)' },
    { tag: [t.processingInstruction, t.string, t.inserted], color: 'var(--code-str)' },
    { tag: t.invalid, color: 'var(--code-invalid)' }
  ])
)

async function loadLanguage(lang: string): Promise<void> {
  if (lang === 'mermaid' || !cmView) return
  try {
    const key = resolveLanguageKey(lang)
    const loader = key ? LANGUAGE_LOADERS[key] : null
    if (!loader) {
      // 认不出来的语言：保持纯文本（与原「找不到描述符就清空扩展」一致）
      cmView.dispatch({ effects: languageCompartment.reconfigure([]) })
      return
    }
    const support = await loader()
    cmView.dispatch({ effects: languageCompartment.reconfigure(support) })
    /**
     * 登记解析器：静态态要**用同一套语法**上色（P2），但它不能建 CM 实例。
     * 只在这里登记 = 只有「本会话真的挂载过这个语言」的块才会在静态态被解析；
     * 屏幕外从没露过面的块保持纯文本 —— 绝不为了上色去 `import()` 语言包
     * （1500 块的文档里那就是几十次额外 chunk 加载）。见 lib/editor/staticHighlight.ts。
     */
    const parser = parserOf(support)
    if (key && parser) registerStaticParser(key, parser)
  } catch {
    /* 语言加载失败时保持纯文本 */
  }
}

/** 点击代码区时显式把焦点与 DOM 光标钉在 CM 上。
    浏览器对 contenteditable 区域的默认焦点处理会把焦点转移到 PM 根节点；
    且 PM 的 focus 处理器在 20ms 后会经 selectionToDOM 把 DOM 选区重置到
    PM 状态选区（光标被移出 CM）。CM 自身的 focus() 对空光标不会重设 DOM
    选区，因此需要再派发一次 select.pointer 选择事务强制同步光标；最后
    60ms 后重钉一次，保证点击/输入序列结束后焦点与光标最终必在 CM。 */
let pinTimer: ReturnType<typeof setTimeout> | null = null
function pinCmFocus(): void {
  if (!cmView) return
  cmView.focus()
  // 仅在光标已折叠时才强制把 DOM 光标恢复到 CM 状态选区（updateSelection 的
  // fromPointer 分支）；拖选产生的非空选区必须原样保留，否则鼠标抬起时会被
  // 折叠回锚点，代码块内多选（拖选）随之失效。
  const main = cmView.state.selection.main
  if (main.empty) {
    cmView.dispatch({
      userEvent: 'select.pointer',
      selection: { anchor: main.anchor },
      scrollIntoView: false
    })
  }
  if (pinTimer) clearTimeout(pinTimer)
  pinTimer = setTimeout(() => {
    if (cmView) {
      cmView.focus()
      const m2 = cmView.state.selection.main
      if (m2.empty) {
        cmView.dispatch({
          userEvent: 'select.pointer',
          selection: { anchor: m2.anchor },
          scrollIntoView: false
        })
      }
    }
    pinTimer = null
  }, 60)
}

/** 供 PM 层键盘拦截调用（代码块后段落行首 Backspace）：把焦点与光标
    移入本代码块 CM 的末尾。CM 不存在（mermaid 预览态 / 已销毁）返回 false。 */
function focusCmAtEnd(): boolean {
  if (!cmView) return false
  cmView.dispatch({
    selection: { anchor: cmView.state.doc.length },
    scrollIntoView: true
  })
  pinCmFocus()
  return true
}

/**
 * 挂载后把光标放到**用户点的那个位置**（PM 选区在本节点内的偏移），并且**不许滚动页面**。
 *
 * 为什么不能沿用 `focusCmAtEnd()`（tag `codeblock-mount-no-jump`，用户报障的第二条路径）：
 * 它把光标扔到块尾并带 `scrollIntoView: true`。点/激活一个 150 行的代码块 ⇒ CM 立刻要
 * 把"文档末尾"滚进视口，而它滚的是**所有可滚动祖先**（含 `.editor-scroll`）⇒ 整页被拽到
 * 块底：屏幕上就是"mermaid 不见了，直接跳到大代码块中间那段 `<RouterLink v-for=…>`"。
 * 实测那条路一次写 `scrollTop` 就能挪 700+px（见 tmp/cbj-click.json）。
 *
 * `scrollIntoView: false` 是**必要的**：光标落在用户刚点的位置，本来就在视口里，
 * 没有任何理由去滚动。块尾定位仍由 `focusCmAtEnd()` 负责（键盘拦截那条路要用）。
 */
function focusCmAtSelection(): void {
  if (!cmView) return
  const getPos = props.getPos as (() => number) | undefined
  const at = typeof getPos === 'function' ? getPos() : undefined
  const offset =
    typeof at === 'number'
      ? caretOffsetInBlock(at, props.editor.state.selection.from, cmView.state.doc.length)
      : 0
  cmView.dispatch({ selection: { anchor: offset }, scrollIntoView: false })
  pinCmFocus()
}

// ── 实例注册（PM 键盘拦截按节点位置查找本组件，见 codeBlockViews.ts）──
const handle: CodeBlockHandle = {
  getPos: () => {
    const pos = props.getPos as (() => number) | undefined
    return typeof pos === 'function' ? pos() : undefined
  },
  focusCmAtEnd,
  requestMeasure: () => cmView?.requestMeasure()
}

// ─── 代码块虚拟化（F 项 / O2）：三态 + 按需挂载 ───────────────────────────────
//
// 状态：`nearViewport`（共享 observer 给的相交结果）、`selectionInside`（选区/光标在不在这个块里）、
// `activated`（用户刚点过它）。三者任一成立就挂 CM —— 判定本身是纯函数（codeBlockMountPolicy）。
//
// ⚠️ 契约（施工图 §1/§2，改错就崩）：
//   * **卸载顺序不能反**：`syncToNode()`（把 CM 里最后几个字符落进文档）→ `teardownCm()` →
//     记高度 → 切静态态 → 注销句柄；少了第 1 步会丢字符，少了最后一步会让键盘路由命中
//     「没有 CM 的块」。
//   * **高度必须固定**：切静态态前记下当前高度当 `minHeight`，否则滚动会跳（风险 R3）。
//     记的是 **CM 自己（`.cm-editor`）的高度**，不是 NodeView 外壳的高度 —— 外壳那 2px
//     边框不属于代码区，记进去会让静态态每次都高出 2px（挂/卸一次抖 2px）。
//     两态真正的"不跳"靠的是**排版契约**（静态态与 CM 的 padding / 行高 / **换行口径**
//     逐项相同，见 overlays.css 的 `.md-preview pre.cb-static` 与下面 cmTheme 的 `.cm-content`），
//     `minHeight` 只是兜底：契约成立时它恒等于静态态的自然高度，等于没设。
//   * 静态态**不是**不可编辑：它只是「还没轮到挂 CM」，点一下（或选区落进来）就挂上。
const blockRef = ref<unknown>(null)
const nearViewport = ref(false)
const selectionInside = ref(false)
const activated = ref(false)
/** 静态态的高度下限（卸载时记下的挂载态高度）——防滚动跳动 */
const staticMinHeight = ref<number | null>(null)
/**
 * 这个块**曾经挂载过**没有（P2 静态高亮的开关）。
 * 置真点在挂载流程里（那时语言解析器才登记），此后卸载成静态态就沿用高亮片段；
 * 从没挂载过的块一直是纯文本（并在屏幕外）—— 见 staticHtml 的注释。
 */
const wasMounted = ref(false)
let stopMountWatch: (() => void) | null = null
let handleRegistered = false
/** 离开视口附近后延迟多久才真卸（P3.2：来回滚一点不该反复挂/卸）—— 常量在策略模块里，单测钉着 */
const UNMOUNT_DELAY_MS = CODE_UNMOUNT_DELAY_MS
let unmountDelayTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 拿到本块的 DOM 元素。
 * `ref` 挂在 `<node-view-wrapper>` 上：它可能是组件实例（取 `$el`）也可能是元素本身
 * （Tiptap 的包装组件在不同版本里两种形态都出现过），所以这里统一归一化。
 */
function blockEl(): Element | null {
  const v = blockRef.value
  if (!v) return null
  if (v instanceof Element) return v
  const el = (v as { $el?: unknown }).$el
  return el instanceof Element ? el : null
}

const cmMounted = computed(
  () =>
    selectedLanguage.value !== 'mermaid' &&
    shouldMountCm({
      near: nearViewport.value,
      selectionInside: selectionInside.value,
      activated: activated.value
    })
)

/**
 * 语言选择器**不再**是常驻 DOM：它由 `pickerOpen` 控制、聚焦时才挂出来
 * （见 openPicker/onBlockFocusIn）。所以这里不再有 showLangSelect 之类的可见性开关。
 */

/** 选区/光标是否落在本节点范围内（PM 的 selectionUpdate 里刷新；computed 读不到 PM state 变化） */
function refreshSelectionInside(): void {
  const pos = props.getPos as (() => number) | undefined
  const at = typeof pos === 'function' ? pos() : undefined
  if (typeof at !== 'number') {
    selectionInside.value = false
    return
  }
  const { from, to } = props.editor.state.selection
  selectionInside.value = from >= at && to <= at + props.node.nodeSize
}

/** 静态态的文本（与节点内容一致；行号 gutter 用行数生成） */
const staticLines = computed(() => (props.node.textContent || '').split('\n').length)
const staticGutter = computed(() =>
  Array.from({ length: staticLines.value }, (_, i) => String(i + 1)).join('\n')
)

/**
 * 静态态代码区的内容（P2）：带 token class 的 HTML（语言解析器已登记时），
 * 否则是纯转义文本 —— 两种都能直接 `v-html`：文本自己走 `escapeHtml`，
 * class 只来自 `staticHighlight.ts` 里的常量表（不含任何用户输入）。
 * 只在**静态态**才算（挂载态根本不渲染这个 `<pre>`）。
 */
const staticHtml = computed(() => {
  const text = props.node.textContent || ''
  if (!STATIC_HIGHLIGHT || cmMounted.value || selectedLanguage.value === 'mermaid') {
    return escapeHtml(text)
  }
  /**
   * 只给**挂载过**的块上色（`wasMounted`）：语言解析器是懒加载的，块挂载时才会登记；
   * 从没露过面的块保持纯文本 —— 它本来就在屏幕外，而且能省掉一次「全文档静态块重渲染」
   * （实测那一版把 1500 围栏的可用耗时从 2695ms 拖到 3451ms、RSS +155MB）。
   * 详见 lib/editor/staticHighlight.ts 的登记表注释。
   */
  if (!wasMounted.value) return escapeHtml(text)
  return staticHighlightHtml(text, resolveLanguageKey(selectedLanguage.value))
})

/**
 * 挂载期容器的 `min-height` = 切换前**静态 `<pre>` 的精确高度**（本轮从"只兜第一帧"改成"一直兜到内容真的变了"）。
 *
 * 为什么需要（两条，都是实测）：
 *  1. `cmMounted` 一翻真，模板立刻把 `<pre>` 换成**空的** `.cm-editor-container`，而 CM 实例要等
 *     `await nextTick()` 之后才建。万一浏览器在这两步之间出了一帧，块高就塌成 2px（只剩外壳
 *     上下边框）—— 下方内容"抽一下"。实测抓到过这一帧（`tmp/cb-jump-ticks.json` 有 wrapper h=2 的采样）。
 *  2. **换行之后新增的一条（tag `codeblock-wrap-no-fold`）**：CM 的 `HeightMap` 对**视口外**的行
 *     只能按字符数估高（`HeightOracle.heightForLine`），而浏览器在**折行**时按空格断行、长串再
 *     anywhere 断，实际视觉行数会多于估值。实测 150 行 vue 块：静态 `<pre>` 4025px（精确），
 *     CM 挂载后先算成 3922px，滚过整块时 3922 → 3963 → 4005 → 4025 一路长高 —— 一边滚一边把
 *     下方内容顶走（正是 `codeblock-mount-no-jump` 要消灭的那类跳变，只是这次源头从"两态排版
 *     不一致"换成了"CM 对折行的估值修正"）。
 *     静态态的高度是**浏览器排完整篇**量出来的，天然精确；把它当挂载期的 min-height 地板，
 *     CM 的估值再怎么变都改不动页面高度（CM 自己长高只是填满这块地板）。
 *
 * 地板什么时候撤（任何"精确高度已不成立"的时刻）：
 *   * 用户/外部**改了内容**（`docChanged` / setState）—— 行数变了，旧高度没有意义；
 *   * **换行宽度变了**（容器 ResizeObserver 的宽度变化、设置里切换行号改变行号槽宽）；
 *   * 卸载。
 * 撤掉之后块高回到 CM 自管（编辑时块随内容长/缩，行为与换行前一致）。
 */
const containerMinHeight = ref<number | null>(null)
/** 挂载期容器的宽度哨兵：宽度变了（窗口/分屏/行号槽变化）就把 min-height 地板撤掉 */
let cmWidthWatch: ResizeObserver | null = null
let cmLastWidth = 0

/** 撤掉 min-height 地板（内容/宽度真的变了，旧静态高度已不成立） */
function dropHeightFloor(): void {
  if (containerMinHeight.value === null) return
  containerMinHeight.value = null
}

// ─── 折行高度全量测量（tag `codeblock-wrap-no-fold`）──────────────────────────
// 为什么：开 `EditorView.lineWrapping` 后，CM 只对视口内的行拿到真实折行高度，视口外按字符数
// 估高；浏览器按空格 + overflow-wrap:anywhere 断行，实际视觉行比估值多 ⇒ 边滚边补高度。
// 实测 150 行块：静态 4025px / CM 先算 3922px，滚过整块一路长到 4025，途中一次滚轮
// -120 只走了 -99（高度修正被 Chromium 的 scroll anchoring 吃掉）。
// 修法：用 CM 内部的 `printing` 口径（关闭视口限制）一次性把全文行高量准。它只是
// 一次同步的 render+measure（同一任务内完成，不会画出一帧"全文展开"），之后 heightMap
// 全是实测值。`shouldWarmMeasureLines` 兜住超大块（退回 min-height 地板，页面高度仍稳定）。
interface CmMeasureInternals {
  measure?: () => void
  viewState?: { printing?: boolean }
}
/** 本实例是否已经量准（宽度变化 / setState 会复位） */
let warmedHeights = false
let warmLinesObserver: IntersectionObserver | null = null
let warmTimer: ReturnType<typeof setTimeout> | null = null

function warmMeasureWrappedLines(): void {
  if (!cmView || warmedHeights) return
  if (!shouldWarmMeasureLines(cmView.state.doc.lines)) return
  // `printing` 口径仍要求编辑器在窗口里（否则 measure 直接返回 0）：不在就等观察器
  const r = cmView.dom.getBoundingClientRect()
  const visible =
    r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth
  if (!visible) return
  const internals = cmView as unknown as CmMeasureInternals
  if (
    typeof internals.measure !== 'function' ||
    !internals.viewState ||
    typeof internals.viewState.printing !== 'boolean'
  ) {
    return // 内部口径不可用：保留 min-height 地板（页面高度照样稳定）
  }
  try {
    internals.viewState.printing = true
    internals.measure()
    warmedHeights = true
  } catch {
    /* 量不准就退回地板兜底，不影响编辑 */
  } finally {
    if (internals.viewState) internals.viewState.printing = false
    cmView?.requestMeasure()
  }
}

/** 立刻试一次；不可见/量不成时挂一个一次性 IntersectionObserver，等它进视口再量 */
function armWarmMeasure(): void {
  if (!cmView || warmedHeights) return
  if (!shouldWarmMeasureLines(cmView.state.doc.lines)) return
  warmMeasureWrappedLines()
  if (warmedHeights) return
  if (typeof IntersectionObserver !== 'function') return
  warmLinesObserver?.disconnect()
  warmLinesObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      warmMeasureWrappedLines()
      if (warmedHeights) {
        warmLinesObserver?.disconnect()
        warmLinesObserver = null
      }
    },
    { threshold: 0 }
  )
  warmLinesObserver.observe(cmView.dom)
}

/** 等 CM 自己这一拍 measure 完再全量量（resize / setState 之后用） */
function scheduleWarmMeasure(delay = 60): void {
  if (warmTimer) clearTimeout(warmTimer)
  warmTimer = setTimeout(() => {
    warmTimer = null
    armWarmMeasure()
  }, delay)
}

function releaseWarmMeasure(): void {
  warmLinesObserver?.disconnect()
  warmLinesObserver = null
  if (warmTimer) clearTimeout(warmTimer)
  warmTimer = null
  warmedHeights = false
}

/** 挂载：建 CM（复用既有创建函数）+ 应用语言（+ 选区在本块内时把光标交给 CM） */
async function mountCmForVirtualization(): Promise<void> {
  if (cmView || selectedLanguage.value === 'mermaid') return
  /**
   * 先读下静态态**现在**的高度，塞给即将出现的容器当 min-height（见 containerMinHeight）。
   * 必须在 `await nextTick()` **之前**读：下一拍 `<pre>` 就已经被换成容器了。
   */
  const staticH = staticRef.value ? Math.round(staticRef.value.getBoundingClientRect().height) : 0
  containerMinHeight.value = staticH > 0 ? staticH : null
  await nextTick()
  if (cmView || !blockEl()) {
    containerMinHeight.value = null
    return
  }
  staticMinHeight.value = null
  initCm()
  // 挂载即把全文行高量准（折行后不再"边滚边补高度"，见 warmMeasureWrappedLines）
  armWarmMeasure()
  wasMounted.value = true
  if (!handleRegistered) {
    registerCodeBlockHandle(handle)
    handleRegistered = true
  }
  void loadLanguage(selectedLanguage.value)
  // 选区已经在这个块里（例如键盘路径刚把光标交给本块）⇒ 把焦点/光标移交 CM。
  // ⚠️ 必须是 `focusCmAtSelection()`（原位、不滚）；`focusCmAtEnd()` 会把整页拽到块底。
  if (selectionInside.value) focusCmAtSelection()
  // ⚠️ 这里**不再**在下一拍撤掉 min-height：它是换行后压住 CM 估值修正的地板（见上方注释）。
  // 撤地板的三个时机是 docChanged / 宽度变化 / 卸载。
}

/** 卸载：先落盘、再拆、记高度、注销句柄（顺序见上方注释） */
function unmountCmForVirtualization(): void {
  if (!cmView) return
  syncToNode()
  /**
   * 记 **CM 代码区**的高度（不是 NodeView 外壳的）：外壳带 2px 边框，记进去会让静态态
   * 每次挂/卸都高出 2px。`Math.ceil` 保证兜底值**不会低于**静态态的自然高度（宁可高
   * 0.75px，也不能矮 —— 矮了就是内容跳一下）。
   */
  const h = cmView.dom.getBoundingClientRect().height
  teardownCm()
  staticMinHeight.value = staticFallbackMinHeight(h)
  containerMinHeight.value = null
  if (handleRegistered) {
    unregisterCodeBlockHandle(handle)
    handleRegistered = false
  }
}

/**
 * 静态态被按下：满足「刚点过」这个挂载条件（P3 的「点开即挂」）。
 *
 * 刻意**不** `preventDefault` / 不 `.stop`：让事件继续冒泡给 ProseMirror，由它把光标放进
 * 这个代码块节点 —— 于是 `selectionInside` 也跟着变真，挂载流程会把焦点与光标交给 CM。
 * （挂载态那个容器的 `.stop` 是另一回事：那里要防的是 PM 把焦点从 CM 抢走。）
 */
function activateFromStatic(): void {
  activated.value = true
}

/**
 * ─── 两套撤销栈的分工（本轮修复的核心口径，改错必回归）────────────────────────
 *
 * 症状（用户实测）：选中一段文字 → 点工具栏「代码块」→ 块出来了，但按 `Ctrl+Z`
 * **什么都不发生**；把焦点点回正文再按 `Ctrl+Z` 才撤得掉。
 *
 * 成因是两条叠在一起：
 *   1. 新代码块挂上 CM 之后，`mountCmForVirtualization()` 会因为"选区就在这个块里"
 *      而把焦点交给 CM（`focusCmAtEnd()`）—— 于是用户的下一次按键落在 CM 上；
 *   2. `codeBlock.ts` 的 `stopEvent` 把 `.cm-editor` 内的 keydown **整类**交还给 CM，
 *      PM 的全局历史 keymap 根本收不到这个事件；而 CM 自己的 `history()` 是新建的
 *      （`EditorState.create({ doc: 节点文本 })`），**本地历史是空的** ⇒
 *      `Mod-z` 被 CM 的 `historyKeymap` 接走却无事可撤 ⇒ 按键被静默吃掉。
 *
 * 口径（**这就是本应用对"撤销"的定义**，改这一节之前先读一遍）：
 *   * **块内的文本**由 CM 自己的历史管：块里打字后 `Ctrl+Z` 撤的是**块内的编辑**
 *     （粒度 = CM 的 `newGroupDelay`，默认 500ms 内且相邻的输入并成一步）；
 *     这些写回 PM 的事务带 `addToHistory: false`（见 `syncToNode`）⇒
 *     **不会**在外层撤销栈里留下影子，两套历史互不交错；
 *   * **块的结构与块外的一切**由 PM 的全局历史管：创建/删除代码块、外面的正文与格式；
 *   * 焦点在块内时，`Mod-z` 先撤 CM 本地历史；**本地历史耗尽后继续撤外层 PM 历史** ——
 *     所以"刚选中文字创建出来的这个代码块"，在块内连按 `Ctrl+Z` 最终也能一次撤干净
 *     （先撤掉块内敲的字，再撤掉"创建代码块"这一步）。`Mod-y` / `Mod-Shift-z` 对称。
 *
 * 为什么必须在**捕获阶段**做：`@keydown.capture` 挂在 `.cm-editor-container` 上，
 * 比 CM 挂在 `.cm-content` 上的 keymap 更早拿到事件；`stopPropagation()` 之后
 * CM 的 `historyKeymap` 不再执行 —— 否则它会把 `Mod-z` 在本地历史为空时"吃掉"
 * 并返回 false，事件又不会冒泡给 PM，用户看到的就是"按了没反应"。
 */
function onCmHistoryKey(e: KeyboardEvent): boolean {
  if (!cmView || !(e.ctrlKey || e.metaKey) || e.altKey) return false
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (k !== 'z' && k !== 'y') return false
  // Ctrl+Y = 重做；Ctrl+Shift+Z = 重做（Windows 口径；macOS 的 Mod-Shift-z 同义）
  const wantRedo = k === 'y' || e.shiftKey
  // 先吃掉按键：无论最终谁执行，都不能让浏览器对 contenteditable 做原生 undo
  // （那会绕过 PM 状态直接改 DOM，是损坏文档的那类操作）。
  e.preventDefault()
  e.stopPropagation()
  // ① 块内自己的编辑（本地历史）优先
  if (wantRedo ? cmRedo(cmView) : cmUndo(cmView)) return true
  // ② 本地历史已耗尽 → 交外层 PM 全局历史
  delegateToPmHistory(wantRedo)
  return true
}

/**
 * 把一步撤销/重做委托给 ProseMirror 的全局历史（代码块内 `Mod-z` 的兜底）。
 *
 * 关键的一步是**焦点归还**：若这一步撤掉/重做掉的正是本代码块，NodeView 会随节点
 * 一起卸载、CM 被销毁，DOM 焦点随之落到 `body` —— 用户接着按 `Ctrl+Z`/`Ctrl+Y`
 * 就没有落点了（这正是"撤了一次之后就再也撤不动"的第二种成因）。所以：
 * 见下面的实现，只有在焦点真的已经无处可去时才交回 PM，块还在时**绝不抢焦点**。
 */
function delegateToPmHistory(wantRedo: boolean): void {
  const editor = props.editor
  if (editor.isDestroyed) return
  const did = wantRedo ? editor.commands.redo() : editor.commands.undo()
  if (!did) return
  // **宏任务**后再判断（不能用微任务）：Vue 的卸载可能排在 `nextTick` 之后再下一拍，
  // 那时才看得出来 CM 到底有没有随节点一起消失。判据直接看浏览器事实：
  // 焦点元素被移出文档时 `activeElement` 会同步落回 `body` ——
  //   * 块被撤掉 ⇒ CM 销毁、activeElement=body ⇒ 交回 PM，用户才能接着 Ctrl+Z / Ctrl+Y；
  //   * 块还在（撤的是别处的步）⇒ activeElement 仍是 `.cm-content` ⇒ **绝不抢焦点**。
  window.setTimeout(() => {
    if (editor.isDestroyed) return
    const ae = document.activeElement
    if (ae && ae !== document.body) return
    editor.commands.focus()
  }, 0)
}

/** 捕获阶段拦截 Enter：走 CM 状态事务，并用 setState 强制整文档重建。
    嵌套于 ProseMirror 的 CM 增量重绘（docView.update）在本环境不可靠：
    state 会更新但 DOM 不重绘；setState 重建 docView，保证换行真实落到
    DOM（代价是整块重建，对代码块尺寸而言可接受）。 */
function onCmKeydownCapture(e: KeyboardEvent): void {
  if (!cmView || e.isComposing) return
  // 撤销/重做：见 onCmHistoryKey 的口径注释（块内优先，再交外层全局历史）
  if (onCmHistoryKey(e)) return
  // 语言浮层开着时 Esc = 收起浮层（焦点本来就在代码区，不用再还）
  if (e.key === 'Escape' && pickerOpen.value) {
    e.preventDefault()
    e.stopPropagation()
    closePicker()
    return
  }
  // 空代码块按退格 = 删除整个代码块。CM 自身的退格在文档开头无内容可删、
  // 且 stopEvent 让 PM 收不到按键，导致空代码块“卡住”删不掉。
  if (e.key === 'Backspace' && cmView.state.doc.length === 0) {
    e.preventDefault()
    e.stopPropagation()
    removeEmptyCodeBlock()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    // 用视图自身 state 构建事务（同源实例），setState 整文档重建 +
    // requestMeasure 强制视口重绘：嵌套于 PM 的 CM 增量重绘不可靠，
    // 双保险保证换行真实落 DOM
    const { from, to } = cmView.state.selection.main
    const tr = cmView.state.update({
      changes: { from, to, insert: '\n' },
      selection: { anchor: from + 1 },
      userEvent: 'input',
      scrollIntoView: true
    })
    cmView.setState(tr.state)
    cmView.requestMeasure()
    pinCmFocus()
    syncToNode()
  }
}

/** 删除空代码块节点：文档仅剩它时替换为空段落（PM 不允许空文档），
    否则直接删节点并把光标放到就近可编辑位置。 */
function removeEmptyCodeBlock(): void {
  const getPos = props.getPos as () => number
  const pos = getPos()
  if (typeof pos !== 'number') return
  const editor = props.editor
  const { schema, doc } = editor.state
  const node = doc.nodeAt(pos)
  if (!node || node.type.name !== 'codeBlock') return

  editor.commands.command(({ tr }) => {
    const start = pos
    const end = pos + node.nodeSize
    const onlyNode = doc.childCount === 1 && doc.child(0) === node
    if (onlyNode) {
      tr.replaceWith(start, end, schema.nodes.paragraph.create())
      const p = Math.min(start + 1, tr.doc.content.size)
      tr.setSelection(TextSelection.near(tr.doc.resolve(p)))
    } else {
      tr.delete(start, end)
      const p = Math.min(start, tr.doc.content.size)
      tr.setSelection(TextSelection.near(tr.doc.resolve(p)))
    }
    return true
  })
  // 焦点交还 PM（组件即将随节点移除而卸载）
  editor.commands.focus()
}
/**
 * 与 CM 对齐时**节点里的文本**（这一面对"谁更新"的判据）。
 *
 * ─── 为什么不用账本的 `contentIsStale('codeblock')` 做方向判定（实测结论）──────
 * 先按审计建议试了"用 `contentIsStale('codeblock')` 决定要不要写回"，**当场把输入吃掉**：
 * 左侧 Tiptap 每 250ms 一次序列化落库，而作者牌是按"那次序列化时谁在写"给的 ——
 * 同一次连续输入里，前面的写入记成 `codeblock`、后面那次可能记成 `wysiwyg`，
 * 于是 `rev` 前进而 `applied.codeblock` 停在上一代。实测静止态就是
 * `rev=10 / applied={wysiwyg:10, codeblock:9}` ⇒ `contentIsStale('codeblock')` 恒为真 ⇒
 * 用户每敲一个字都被判成"我落后了"，于是重建 CM、丢掉这个字（回归套件 A 段立刻变红）。
 *
 * 所以方向判定改用**局部且精确**的信号：节点文本是不是我们上次对齐的那一份。
 * 我们自己的写回会同步更新它；只有"节点被我们之外的写入改过"才会不等 —— 那正是
 * 外部整篇替换（源码面编辑 / 载入历史 / 切编码 / 切文件）的形态。
 * 账本仍然记这一面（`markContentApplied('codeblock')`），但它的语义是**账目**，
 * 不是这一面的驱动信号（见 lib/contentSync.ts 顶部对 `codeblock` 的说明）。
 */
let alignedNodeText: string | null = null

function syncToNode(): void {
  if (!cmView) return
  const code = cmView.state.doc.toString()
  if (code === props.node.textContent) return
  const getPos = props.getPos as () => number
  const pos = getPos()
  if (typeof pos !== 'number') return
  const editor = props.editor
  // 节点被我们之外的写入改过 ⇒ 真源优先：重建 CM（哪怕它正拿着焦点），绝不把旧文本写回去。
  // 旧实现只靠"焦点还在就不覆盖 + 150ms 再等一轮"躲，于是外部替换后人在代码块里敲一下
  // 就把外部编辑顶掉了（审计 §3 P1）。
  if (alignedNodeText !== null && props.node.textContent !== alignedNodeText) {
    applyNodeText(true)
    return
  }
  // 挂个牌：这次正文变化的作者是这个代码块（手册 §4.59 的账本）。
  // 序列化是 250ms 防抖的，等它落到 files 时已经看不出谁写的了，所以写回节点
  // 之前先声明；EditorView 的 onEditorUpdate 会消费掉它并记进账本。
  // 效果：Tiptap 面板不会被回灌（它的文档本来就是最新的，回灌会把光标踢出代码块），
  // 而源码 textarea 照常跟着更新。
  editorStore.noteWrite('codeblock')
  // PM 事务在文档变更时会无条件 selectionToDOM（重写 DOM 选区），浏览器
  // 随之可能把焦点翻回 PM 根节点。事务后立即把焦点与光标归还 CM（同步、
  // 无可见闪烁），pinCmFocus 内置 60ms 延迟重钉兜底异步翻转。
  editor.commands.command(({ tr }) => {
    const node = tr.doc.nodeAt(pos)
    if (!node || node.type.name !== 'codeBlock') return false
    const from = pos + 1
    const to = pos + node.nodeSize - 1
    /**
     * ─── 这一笔写回**不进外层撤销栈**（`addToHistory: false`）─────────────────
     * CM 是代码块文本的真源，块内的编辑历史归它自己（见 `onCmHistoryKey` 的口径）。
     * 若把镜像写回也记进 PM 历史，两套历史就会互相插队 —— 实测表现：
     * 在块里打字 → `Ctrl+Z`（CM 撤掉字）→ 再 `Ctrl+Z`：外层撤到的是**这次写回**，
     * 于是刚撤掉的文本又被"撤"回来，用户永远走不到"创建代码块"那一步。
     * 标成不进历史之后，PM 历史里只剩结构步（创建/删除块、块外编辑），
     * CM 历史耗尽后委托给外层的那一步才**确定**是"创建代码块"。
     */
    tr.setMeta('addToHistory', false)
    /**
     * 空文本必须走 `delete`：`schema.text('')` 会抛
     * `RangeError: Empty text nodes are not allowed`（prosemirror-model 的 TextNode
     * 构造器禁止空文本节点）。原先无条件 `replaceWith(schema.text(code))`，
     * 于是"把代码块里的字全删掉 / 撤到空"这一刻会在 CM 的 updateListener 里抛异常，
     * 被 CM 吞成 `[renderer:error] update listener: RangeError…`：
     * CM 显示已空、**文档里却还留着旧文本**（实测 B3：`md` 仍是 `abc`），
     * 随后所有基于文档的断言/保存看到的都是错的 —— 静默的数据不一致，必须堵住。
     */
    if (code.length === 0) tr.delete(from, to)
    else tr.replaceWith(from, to, tr.doc.type.schema.text(code))
    return true
  })
  // 写回之后节点文本就是 CM 这一份 ⇒ 记录对齐基准（下次 syncToNode 靠它认"节点被外部改过"）
  alignedNodeText = code
  pinCmFocus()
}

/**
 * 生效语言变了 → 换渲染形态 / 换高亮包。
 *
 * ⚠️ 这里**不再** `updateAttributes({ language })`：自动识别出来的语言只影响显示，
 * 不写回文档（写回去 = 污染 markdown 围栏，还会把"自动识别"冻结成"用户显式设置"，
 * 之后改内容也不会再识别）。显式设置只发生在 applyLanguageChoice()。
 */
watch(selectedLanguage, async (lang) => {
  // 换语言会整块换 DOM：排队中的图/未收完的高度动画都属于旧形态，先清掉
  resetPendingMermaidSwap()
  if (lang === 'mermaid') {
    // 切到 mermaid：CM 宿主节点即将被 v-else 卸载，先彻底拆掉（含焦点封堵、
    // 观察器恢复），并退出源码态——否则再切回 mermaid 会看到残留的 textarea
    editingMermaid.value = false
    mermaidPreviewSeq++
    if (mermaidPreviewTimer) {
      clearTimeout(mermaidPreviewTimer)
      mermaidPreviewTimer = null
    }
    teardownCm()
    // 容器是刚挂出来的：先挂视口门（门已开时它是空操作，紧接着的 render 才是要的）
    void nextTick(() => {
      armMermaidObserver()
      void renderMermaid()
    })
    return
  }
  // 从 mermaid 切到其它语言：等 v-else 的 CM 容器挂载后按需创建视图
  // （是否真建由挂载策略决定：远处/未激活的块保持静态态，见 codeBlockMountPolicy）
  await nextTick()
  if (cmMounted.value) void mountCmForVirtualization()
  // 已经在挂载态（例如自动识别从 js 改判成 ts）：只换语言扩展，不重建 CM
  if (cmView) void loadLanguage(lang)
})

/**
 * 节点 `language` 属性被外部改掉（源码面编辑 / 载入历史 / 撤销重做）时同步进来。
 * 非空 = 显式设置：清掉自动识别的结果并解除"用户清空后不再识别"的抑制。
 */
watch(
  () => props.node.attrs.language,
  (raw) => {
    const next = normalizeLanguageName(raw)
    if (next === explicitLanguage.value) return
    explicitLanguage.value = next
    if (next) {
      detectedLanguage.value = null
      detectSuppressed = false
    }
  }
)

// 设置里切换「代码块行号」即时生效（折叠功能已按用户口径整条移除：
// 没有 foldGutter / foldKeymap / 折叠占位符，只剩行号这一个 gutter）
watch(
  () => settings.codeLineNumbers,
  (on) => {
    // 行号槽宽变了 ⇒ 折行宽度变了 ⇒ 挂载期的静态高度地板失效（见 containerMinHeight）
    dropHeightFloor()
    cmView?.dispatch({
      effects: lineNumberCompartment.reconfigure(on ? lineNumbers() : [])
    })
  }
)

// 外部内容变化（源码面编辑、同一文件重新打开等）：CM 的文本源是**节点文本**，
// 节点文本变了就整体重置（setState 重建，语言高亮随后重挂）。
//
// 收敛后的规则（手册 §4.59），只有三条，都是结构性的、不看时间窗：
//   1. **触发时重新读节点文本**，不用 Vue watch 队列里那份可能已过期的快照
//      （旧写法拿的是触发瞬间的 `nv`，而 150ms 内 CM 已经又往前跑了几行 →
//      用旧文本重建 CM，快速输入被逐级回滚，正是「快速回车丢字」的根因之一）；
//   2. 文本已经一致就不动（自己写回去的那一次天然落在这里）；
//   3. **CM 拿着光标时绝不覆盖**，改成再等一轮 —— 外部同步绝不能打断正在输入的人。
let extSyncTimer: ReturnType<typeof setTimeout> | null = null

/** 节点当前的文本：**现读 PM 文档**（`props.node` 是渲染时传下来的，可能落后一拍） */
function currentNodeText(): string {
  const getPos = props.getPos as (() => number) | undefined
  const pos = typeof getPos === 'function' ? getPos() : undefined
  if (typeof pos === 'number') {
    const node = props.editor.state.doc.nodeAt(pos)
    if (node && node.type.name === 'codeBlock') return node.textContent
  }
  return props.node.textContent
}

function applyNodeText(force = false): void {
  if (!cmView || selectedLanguage.value === 'mermaid') return
  const fresh = currentNodeText()
  if (fresh === cmView.state.doc.toString()) {
    // 已经一致：也算"这一面渲染到了当前世代"
    alignedNodeText = fresh
    useFilesStore().markContentApplied('codeblock')
    return
  }
  if (cmView.hasFocus && !force) {
    // 焦点还在代码块里：说明这份节点文本是**落后的那一边**，等失焦后再对齐
    scheduleApplyNodeText()
    return
  }
  // setState 不会触发 updateListener（CM 的 setState 不派发 update），所以这里显式撤地板：
  // 外部整篇替换后，"挂载时那份静态高度"已经不对应当前内容了。
  dropHeightFloor()
  cmView.setState(EditorState.create({ doc: fresh, extensions: buildCmExtensions() }))
  // setState 会重建 ViewState + 清空高度表：等它自己量完再全量量一次
  warmedHeights = false
  scheduleWarmMeasure()
  // 重建之后这一面与真源同代（`force` 那条路是"真源优先，哪怕用户正在这里打字"）
  alignedNodeText = fresh
  useFilesStore().markContentApplied('codeblock')
  void loadLanguage(selectedLanguage.value)
}

function scheduleApplyNodeText(): void {
  if (extSyncTimer) clearTimeout(extSyncTimer)
  extSyncTimer = setTimeout(() => {
    extSyncTimer = null
    applyNodeText()
  }, 150)
}

watch(
  () => props.node.textContent,
  () => {
    scheduleApplyNodeText()
    // 需求 ④：内容变化且**没有显式语言**时重新识别（防抖，不是每键一次）。
    // 有显式语言 / 用户刚清空 ⇒ scheduleDetect 直接返回，绝不覆盖用户的选择。
    scheduleDetect()
  }
)

// ─── 自动识别语言（只在没有显式语言时跑；结果只影响显示，不写回文档）──────────
function scheduleDetect(): void {
  if (explicitLanguage.value || detectSuppressed) return
  if (detectTimer) clearTimeout(detectTimer)
  detectTimer = setTimeout(() => {
    detectTimer = null
    runDetect()
  }, DETECT_DEBOUNCE_MS)
}

/** 立刻识别一次（视口放行时用：块第一次露面前就把语言判好，不闪一帧纯文本） */
function runDetect(): void {
  if (explicitLanguage.value || detectSuppressed) return
  const next = detectLanguage(currentNodeText())
  if (next === detectedLanguage.value) return
  detectedLanguage.value = next
}

/* 扩展列表按需构建：行号开关属于 Compartment，但重建 state（外部内容同步）时
   必须按「当前设置」重新组装，否则会退回挂载时刻的取值 */
function buildCmExtensions(): Extension[] {
  return [
    lineNumberCompartment.of(settings.codeLineNumbers ? lineNumbers() : []),
    /**
     * ─── 自动换行（tag `codeblock-wrap-no-fold`）──────────────────────────────
     * 用户口径：显示代码时**不要出现横向滚动条，一行放不下就折行**（mermaid 除外）。
     *
     * `EditorView.lineWrapping` 做两件事，两件都必须：
     *   * 给 `.cm-content` 挂上 `cm-lineWrapping`（`white-space: break-spaces` 兜底 +
     *     `overflow-wrap: anywhere` + `flex-shrink: 1`）—— 其中 `flex-shrink:1` 是内容区
     *     能收窄到 scroller 宽度的前提，否则它按 min-content 撑宽、继续出横向滚动；
     *   * 让 `HeightOracle.lineWrapping` 为真：CM 折行后**按折出来的视觉行**量高度。
     *     这条是「两态等高」的关键 —— 只是 CSS 折行而不开这个扩展时，CM 会把没量到的行
     *     按"一行"估高，边滚边补，块高在滚动中一路长高（`codeblock-mount-no-jump` 修的就是它）。
     * `white-space` 本身仍写在 overlays.css（0,4,0 压 prosemirror.css 的 0,3,0），见 cmTheme 注释。
     */
    EditorView.lineWrapping,
    /**
     * ─── 拼写检查排除：代码块（CM 内容区）──────────────────────────────────────
     * 正文根节点现在是 `spellcheck="true"`（见 TyporaEditor），而 CM 的 contentDOM
     * 是嵌套在 PM 可编辑区里的**独立 contenteditable**。不显式关掉的话，代码里的
     * 变量名/关键字会被 Chromium 逐词标红。用 contentAttributes 把属性写到
     * `.cm-content` 上（验收会读这个 DOM 属性），而不是靠 CSS 或事后补属性。
     */
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off' }),
    drawSelection(),
    /**
     * ─── 多光标（报告 §P2「功能缺口：多光标」）──────────────────────────────
     * 没有多光标时，代码块里改十行同样的属性只能一行行来；这是"写作工具里的代码块"
     * 最常见的实际动作（改 front matter 键名、批量缩进、改 Markdown 表格列）。
     * 三条缺一不可：
     *   * `EditorState.allowMultipleSelections` —— 状态层允许**多个选区**（关着时
     *     后加的选区会把前一个换掉，Alt+点等于白点）；
     *   * `rectangularSelection()` + `crosshairCursor()` —— Alt 拖拽的**列选择**（对齐的
     *     多行同时改），光标形状给出"现在是列选择"的提示；
     *   * `selectNextOccurrence`（Mod-d）—— 键盘路线：选中一个词再按 Mod-d 逐个加选下一个。
     * ⚠️ 本仓只有**代码块**这一处是 CodeMirror：源码模式是 `<textarea>`（浏览器不提供
     * 多光标），所见即所得是 ProseMirror（未做）。这个边界写进了 docs/manual 与验收套件，
     * 别把它当成"全应用支持多光标"。
     */
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    history(),
    indentOnInput(),
    bracketMatching(),
    autocompletion(),
    closeBrackets(),
    highlightSelectionMatches(),
    mdHighlight,
    cmTheme,
    languageCompartment.of([]),
    keymap.of([
      ...closeBracketsKeymap,
      // 选中一个词后按 Mod-d 逐个加选（多光标的键盘入口）
      { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
      // 剔除 Enter 系与 Tab 绑定：其内部 dispatch（state→DOM 重绘）在
      // 嵌套于 ProseMirror 的场景中断裂（state 更新但 DOM 不重绘），
      // 且 preventDefault 会吞掉浏览器原生插入；Enter 由容器的捕获
      // 处理器接管（setState 重建路径），其余键不受影响
      ...defaultKeymap.filter(
        (b) => b.key !== 'Enter' && b.key !== 'Mod-Enter' && b.key !== 'Shift-Enter'
      ),
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        // 内容真的变了：挂载时记下的静态精确高度已不成立，撤掉 min-height 地板，
        // 块高交还 CM 自管（编辑时该长就长、该缩就缩）。
        dropHeightFloor()
        syncToNode()
      }
    })
  ]
}

// ── CM 视图的创建 / 拆除 ────────────────────────────────────────────────────
// 语言可在 mermaid 与其它语言之间来回切换，而模板用 v-if/v-else 在「图表容器」
// 与「CM 容器」之间换的是不同的 DOM 节点：切到 mermaid 时 CM 的宿主节点被卸载，
// 切回来时又是一个全新的空节点。因此 CM 视图必须能按需创建（initCm）与彻底拆除
// （teardownCm）——原先只在 onMounted 里建一次且 mermaid 分支提前 return，
// 结果从 mermaid 切到其它语言时只剩一块空白代码区。
let guardAcquired = false
let cmWrapper: HTMLElement | null = null

/** 创建 CM 视图并挂好焦点封堵 / 观察器暂停（已有视图时直接返回） */
function initCm(): void {
  const host = editorRef.value
  if (!host || cmView) return
  const state = EditorState.create({
    doc: props.node.textContent,
    extensions: buildCmExtensions()
  })
  cmView = new EditorView({ state, parent: host })
  // 建视图时用的就是当前节点文本 ⇒ 记下对齐基准，并让账本也记这一面（账目，不是驱动信号）
  alignedNodeText = props.node.textContent
  useFilesStore().markContentApplied('codeblock')
  // CM 默认不给 contentDOM 设 tabindex，浏览器点击不会把焦点交给他；
  // 显式设置后点击代码区即可聚焦输入（配合模板上的事件阻断防 PM 抢焦点）
  cmView.contentDOM.tabIndex = 0

  // ── 换行宽度哨兵（tag `codeblock-wrap-no-fold`）──
  // min-height 地板记的是"某个宽度下"静态 <pre> 的精确高度；窗口/分屏一改宽，折行点就变了，
  // 旧高度不再成立。宽度一变就撤掉地板，交给 CM 自管（行号开关改变行号槽宽不走这里，
  // 由 settings 的 watcher 撤）。
  if (typeof ResizeObserver === 'function' && host) {
    cmLastWidth = host.getBoundingClientRect().width
    cmWidthWatch = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (!(w > 0)) return
      if (Math.abs(w - cmLastWidth) < 0.5) return
      cmLastWidth = w
      dropHeightFloor()
      // 宽度变了：折行点全变，旧的实测高度作废，等 CM 这拍量完再全量量一次
      warmedHeights = false
      armWarmMeasure()
    })
    cmWidthWatch.observe(host)
  }

  // ── 焦点封堵 ──
  // PM 的 DOMObserver 监听 document 级 selectionchange：CM 内容区内的选区
  // 变化会被它误读为 PM 选区（CM 位于 PM DOM 树内），随后 PM 重写 DOM 选区，
  // 浏览器随之把焦点从 CM 抢回 PM 根节点，导致后续按键由 PM 处理而错乱。
  // 因此：CM 获得焦点期间令 PM 的 hasFocus() 返回 false，使其跳过选区同步。
  // domObserver 是 prosemirror-view 的内部字段（@internal，未在公开类型中声明），
  // 此处显式拓宽类型以在 CM 聚焦期间暂停/恢复观察器
  const pmView = props.editor.view as typeof props.editor.view & {
    domObserver: { stop: () => void; start: () => void }
  }
  // 共享守卫：挂载期间令 PM hasFocus 返回 false（引用计数，多代码块安全）
  acquireHasFocusGuard(pmView)
  guardAcquired = true

  // ── 观察器暂停 ──
  // hasFocus=false 只能拦下 document 级 selectionchange 的误读；但 CM 在
  // 拖拽多选时其选区绘制会改动自身 DOM（selection 高亮 span），这些「变异」
  // 仍会被 PM 的 DOMObserver 当作文档变更读入并回写选区，把焦点抢回标题。
  // 因此 CM 聚焦期间直接暂停 PM 观察器，失焦（焦点确实离开 .cm-editor）后恢复。
  const pmDomObserver = pmView.domObserver
  const stopPmObserve = (): void => pmDomObserver.stop()
  const startPmObserve = (): void => {
    const ae = document.activeElement
    if (!(ae && ae.closest('.cm-editor'))) pmDomObserver.start()
  }
  cmView.contentDOM.addEventListener('focus', stopPmObserve)
  cmView.contentDOM.addEventListener('blur', startPmObserve)

  // ── blur 拦截（根治「焦点被抢回标题」）──
  // 焦点从 PM 根节点移入嵌套的 CM 内容区时，PM 根节点自身触发 blur（blur
  // 不冒泡，但 PM 的 handlers.blur / Tiptap FocusEvents 直接挂在根节点上）。
  // 若放行：handlers.blur 会把 view.focused 置 false 并 obs.stop/start；随后
  // CM 拖拽多选期间焦点短暂回到 PM 根节点，handlers.focus 里 view.focused
  // 为 false 的 20ms selectionToDOM 会把 DOM 选区重置回 PM 状态选区（即
  // 标题），表现为「光标被抢回标题」。捕获阶段拦截：relatedTarget 落在
  // .cm-editor 内就 stopImmediatePropagation，令 PM 认为焦点从未离开。
  // 注意：只拦截 PM 根节点自身的那一次 blur（e.target === pmView.dom）。监听挂在
  // PM 根节点的捕获阶段，PM 内任意后代的 blur 都会先经过这里；若不加该判断，
  // 节点视图内其它可聚焦元素（如 mermaid 源码 textarea）失焦到 CM 时代码块时，
  // 其 blur 会被一并吞掉，@blur="commitMermaid" 不执行，块就卡在源码态。
  onPmBlurCapture = (e) => {
    if (e.target !== pmView.dom) return
    const rt = e.relatedTarget as HTMLElement | null
    if (rt && typeof rt.closest === 'function' && rt.closest('.cm-editor')) {
      e.stopImmediatePropagation()
    }
  }
  pmView.dom.addEventListener('blur', onPmBlurCapture, true)

  // ── 隔离 CM 可编辑区（治本）──
  // 代码块节点有文本内容，VueNodeViewRenderer 因此为其建了一个 detached
  // contentDOM，PM 便不会给 NodeView 根节点加 contenteditable=false（见
  // prosemirror-view `!contentDOM && dom.contentEditable="false"`）。于是 CM 的
  // contenteditable 直接嵌套在 PM 的可编辑区内。嵌套 contenteditable 会让浏览器
  // 在拖选时把焦点在 PM 根节点与 CM 内容区之间来回弹跳——正是抢焦点的根源。
  // 显式把 NodeView 根节点标为不可编辑，把 CM 隔离成独立编辑岛。
  const wrapper = host.parentElement
  if (wrapper) {
    cmWrapper = wrapper
    wrapper.contentEditable = 'false'
  }
}

/** 拆掉 CM 视图与它挂上的所有监听（切到 mermaid、组件卸载时调用） */
function teardownCm(): void {
  if (!cmView && !guardAcquired) return
  // 释放共享 hasFocus 守卫（引用计数归零才恢复 PM 原始实现）
  if (guardAcquired) {
    releaseHasFocusGuard(props.editor.view)
    guardAcquired = false
  }
  // 移除 blur 拦截器
  if (onPmBlurCapture && props.editor.view.dom) {
    props.editor.view.dom.removeEventListener('blur', onPmBlurCapture, true)
  }
  onPmBlurCapture = null
  cmView?.destroy()
  cmView = null
  cmWidthWatch?.disconnect()
  cmWidthWatch = null
  cmLastWidth = 0
  releaseWarmMeasure()
  // 地板随视图一起消失（卸载路径会把 CM 高度记成静态态的 minHeight）：
  // 组件卸载时清掉，切 mermaid 时也清掉（图表态没有代码区）
  containerMinHeight.value = null
  // 还原隔离用的 contentEditable：图表态下没有 CM，不需要独立编辑岛
  if (cmWrapper) {
    cmWrapper.contentEditable = 'inherit'
    cmWrapper = null
  }
  // 销毁时若 CM 仍处于聚焦态，观察器处于暂停态：确认没有别的 CM 仍持有焦点后恢复
  const v = props.editor.view as typeof props.editor.view & {
    domObserver: { stop: () => void; start: () => void }
  }
  const ae = document.activeElement
  if (v && v.domObserver && !(ae && ae.closest && ae.closest('.cm-editor'))) v.domObserver.start()
}

// ─── 语言浮层：定位 / 开关 / 键盘 / 应用 ─────────────────────────────────────
/**
 * 本次打开浮层贴在哪一边（`above` / `below`）。null = 刚打开、还没选边。
 *
 * 为什么要"记住"而不是每次重新算：列表展开会让浮层长高，如果每拍都重挑一边，
 * 用户一按 ↓ / 一开始打字浮层就会在块上方和下方之间跳。粘住之后只有一种情况会翻边：
 * 这一侧已经被滚到几乎没有空间（见 placePicker 的注释）。
 */
const pickerSide = ref<PickerSide | null>(null)

/**
 * 用视口坐标摆浮层（CSS `position: fixed`）。
 *
 * 为什么不 `position: absolute` 挂在代码块里：`.code-block-wrapper` 必须是
 * `overflow: hidden`（tests/layoutNoOverflow 守着它 —— 否则内部滚动条会画到圆角外），
 * absolute 子元素会被它裁掉：**新代码块只有一行高**，下拉列表会被整块裁没。
 * `fixed` 是"绝对定位"里唯一既能脱离文档流、又不被祖先 overflow 裁剪、还能按视口夹住的形态
 * （本仓从 `.editor-scroll` 到 `.md-preview` 没有 transform/filter，fixed 的包含块就是视口）。
 *
 * 用户口径（本轮）：浮层要**在代码块外面**，不遮挡任何一行代码。所以这里不再拿
 * "代码区右上角"当锚点，而是拿**代码块外壳的 rect** 去问 placePicker：
 *   * 默认贴块**上方**、右对齐、留 6px 缝；
 *   * 上方空间不够（块靠近视口顶部）→ 自动贴到块**下方**，仍然留 6px 缝；
 *   * 高度上限 = 这一侧到视口边缘的空间 ⇒ 候选列表再长也只会在浮层内部滚，
 *     不会越过块的边缘（"任何时刻都不压代码"）。
 * 几何全部在 `lib/editor/codeBlockLangPicker.ts`（纯函数），单测用真实尺寸的矩形
 * 证明"浮层 rect × 代码块 rect 交集面积 = 0"；这里只负责把结果写成 style。
 */
function positionPicker(): void {
  const block = blockEl()
  const panel = pickerRef.value
  if (!block || !panel) return
  const r = block.getBoundingClientRect()
  const placement = placePicker({
    block: {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    panelWidth: panel.offsetWidth,
    panelHeight: panel.offsetHeight,
    side: pickerSide.value
  })
  pickerSide.value = placement.side
  pickerStyle.value = {
    left: `${placement.left}px`,
    top: `${placement.top}px`,
    maxWidth: `${placement.maxWidth}px`,
    // 永远写 max-height（不是"只在放不下时写"）：否则列表展开/收起会让它一会儿有、
    // 一会儿没有，量到的自然高度在两次调用之间反复变，反而抖。
    maxHeight: `${placement.maxHeight}px`
  }
}

// 滚动 / 缩放时（rAF 合并）重新贴角：浮层是 fixed，不跟内容走，必须自己追。
let repositionRaf = 0
function scheduleReposition(): void {
  if (!pickerOpen.value || repositionRaf) return
  repositionRaf = window.requestAnimationFrame(() => {
    repositionRaf = 0
    positionPicker()
  })
}

function onWindowResize(): void {
  scheduleReposition()
}

function attachPickerListeners(): void {
  window.addEventListener('resize', onWindowResize, { passive: true })
  // 捕获阶段：编辑器自己的滚动容器（.editor-scroll）滚动不冒泡到 document
  document.addEventListener('scroll', scheduleReposition, true)
}

function detachPickerListeners(): void {
  window.removeEventListener('resize', onWindowResize)
  document.removeEventListener('scroll', scheduleReposition, true)
  if (repositionRaf) {
    window.cancelAnimationFrame(repositionRaf)
    repositionRaf = 0
  }
}

function openPicker(): void {
  if (pickerOpen.value) return
  pickerOpen.value = true
  listOpen.value = false
  // 每次打开重新挑边（默认上方；块靠近视口顶部时 placePicker 会翻到下方）
  pickerSide.value = null
  // 输入框里预填当前语言（自动识别出来的也填，用户能看到"它认成了什么"；
  // 无语言时留空，placeholder 负责提示可输入）。
  pickerQuery.value = selectedLanguage.value === PLAIN_TEXT_LANGUAGE ? '' : selectedLanguage.value
  activeIndex.value = 0
  attachPickerListeners()
  void nextTick(positionPicker)
}

function closePicker(): void {
  if (!pickerOpen.value) return
  pickerOpen.value = false
  listOpen.value = false
  pickerQuery.value = ''
  pickerSide.value = null
  pickerStyle.value = {}
  detachPickerListeners()
}

/** 焦点落进本块（CM / mermaid 预览按钮 / 静态区）→ 浮层出现 */
function onBlockFocusIn(): void {
  // Esc 把焦点还给代码区时不要立刻又弹出来（见 focusCodeArea）
  if (suppressReopen) {
    suppressReopen = false
    return
  }
  openPicker()
}

/**
 * 指针按在块内（语言浮层之外）→ 也把浮层打开。
 *
 * 为什么需要它：Esc 关闭浮层后焦点**仍留在代码区**，再点同一处不会触发 focusin；
 * 没有这条，"关掉之后想再选语言"只能先点别处再点回来。openPicker 是幂等的。
 */
function onBlockPointerDown(e: Event): void {
  const target = e.target as Element | null
  if (target && typeof target.closest === 'function' && target.closest('[data-cb-lang-picker]')) {
    return
  }
  openPicker()
}

/** 焦点离开本块 → 收起。relatedTarget 还在块内（例如从 CM Tab 到输入框）就不收 */
function onBlockFocusOut(e: Event): void {
  if (keepOpenOnFocusLoss) return
  const next = (e as FocusEvent).relatedTarget as Node | null
  const el = blockEl()
  if (next && el && el.contains(next)) return
  closePicker()
}

/** Esc 关闭后把焦点还给代码区（CM 优先；mermaid 给预览按钮；静态态给 <pre>） */
function focusCodeArea(): void {
  suppressReopen = true
  if (cmView) {
    pinCmFocus()
  } else if (selectedLanguage.value === 'mermaid') {
    // 编辑态焦点归源码框，显示态归预览按钮
    const target = mermaidInputRef.value ?? mermaidRenderRef.value
    target?.focus()
  } else {
    staticRef.value?.focus()
  }
  // 兜底：万一焦点没落进块里（元素不可聚焦），别让抑制旗留到下一次真正的聚焦
  window.setTimeout(() => {
    suppressReopen = false
  }, 0)
}

function openList(): void {
  listOpen.value = true
  const current = pickerQuery.value.trim().toLowerCase()
  const at = pickerItems.value.findIndex((item) => item.value.toLowerCase() === current)
  activeIndex.value = at >= 0 ? at : 0
  void nextTick(() => {
    positionPicker()
    scrollActiveIntoView()
  })
}

function scrollActiveIntoView(): void {
  const el = document.getElementById(optionId(activeIndex.value))
  el?.scrollIntoView({ block: 'nearest' })
}

function onPickerInput(e: Event): void {
  const next = (e.target as HTMLInputElement).value
  pickerQuery.value = next
  /**
   * 用户把输入框**删空** = 明确要"无语言"（裸围栏 / 纯文本）。
   *
   * 这是"×"清空按钮被取消后唯一的清空路径（用户口径：取消一键删除，但"输入为空 =
   * 无语言"这条语义要保留）。立即落库而不是等 Enter：
   *   * 删空这个动作本身就是完整的、不需要再确认；
   *   * 若等到 Enter，空输入下 `pickerItems` 是完整预设列表，Enter 会选中第一项
   *     （`text` = 显式语言）而不是"无语言"，语义就变味了。
   * 自动识别过的块也一样：这里同时把 `detectSuppressed` 置真，本次会话不再被猜回来。
   */
  if (next.trim() === '') {
    applyLanguageChoice('')
    listOpen.value = false
    return
  }
  listOpen.value = true
  activeIndex.value = 0
  void nextTick(positionPicker)
}

/** 点进输入框时全选：想换语言直接打字覆盖，不用先删掉旧名字 */
function onPickerInputFocus(e: Event): void {
  ;(e.target as HTMLInputElement).select()
}

/**
 * 应用一个语言名（`''` = 清空成"无语言"）。
 *
 * 这里才写 `language` 属性：**原样**保存用户输入的名字（含别名与未内置语言），
 * 序列化侧 `codeBlock.ts` 逐字写回围栏 ⇒ `getMarkdown()` 能读回 ```zig / ```ts。
 * 未内置的名字只是没有高亮包（loadLanguage 会 reconfigure 成空扩展 = 纯文本），不报错。
 */
function applyLanguageChoice(raw: string): void {
  const name = normalizeLanguageName(raw)
  const changed = name !== explicitLanguage.value || detectedLanguage.value !== null
  /**
   * 焦点是否还在输入框里：**必须在 `updateAttributes` 之前读**。
   *
   * `updateAttributes` 是一次 PM 事务，事务里的 `selectionToDOM` 可能同步把 DOM 焦点
   * 挪回编辑器根节点（实测：在输入框里删空 → 立即写回 `language: ''` 时，焦点被拽走，
   * 随后那一次 focusout 在 keepOpenOnFocusLoss 复位之后才到，浮层就"自己消失了"）。
   * 先记下、事务后（nextTick）再 focus 回来，浮层与输入焦点都稳定。
   */
  const refocusInput = document.activeElement === pickerInputRef.value
  detectedLanguage.value = null
  explicitLanguage.value = name
  // 清空 = 用户明确要"无语言"：本次会话内不再让自动识别把它猜回来。
  // （重新打开文档时，空围栏按定义仍会被自动识别 —— 那正是需求 ④ 的行为。）
  detectSuppressed = name === ''
  keepOpenOnFocusLoss = true
  if (changed) props.updateAttributes({ language: name })
  pickerQuery.value = name === PLAIN_TEXT_LANGUAGE ? '' : name
  listOpen.value = false
  void nextTick(() => {
    keepOpenOnFocusLoss = false
    positionPicker()
    if (refocusInput) pickerInputRef.value?.focus()
  })
}

/**
 * 浮层键盘（combobox 口径）：
 *   * ↑/↓ 打开列表并移动选中项；Enter/Space 打开列表或应用当前项；
 *   * Esc 关闭并把焦点还给代码区（需求点名）；
 *   * Tab 不拦截 —— 浏览器把焦点移走，`onBlockFocusOut` 负责收起。
 * 输入过滤走 `onPickerInput`（每敲一下就把列表切到"过滤结果"）。
 */
function onPickerKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closePicker()
    focusCodeArea()
    return
  }
  if (e.key === 'Tab') return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    if (!listOpen.value) {
      openList()
      return
    }
    const n = pickerItems.value.length
    if (!n) return
    const delta = e.key === 'ArrowDown' ? 1 : -1
    activeIndex.value = (activeIndex.value + delta + n) % n
    scrollActiveIntoView()
    return
  }
  if (e.key === 'Home' || e.key === 'End') {
    if (!listOpen.value || !pickerItems.value.length) return
    e.preventDefault()
    e.stopPropagation()
    activeIndex.value = e.key === 'Home' ? 0 : pickerItems.value.length - 1
    scrollActiveIntoView()
    return
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    e.stopPropagation()
    if (!listOpen.value) {
      openList()
      return
    }
    const item = pickerItems.value[activeIndex.value]
    if (item) applyLanguageChoice(item.value)
    else if (pickerQuery.value.trim()) applyLanguageChoice(pickerQuery.value)
  }
}

/**
 * 滚动活动门：把「视口判定」的结果**延后到滚停**再落地（tag `codeblock-mount-no-jump`）。
 *
 * 为什么在**视口判定**这一层等，而不是在 watcher 里等 CM 创建：
 * 模板是拿 `cmMounted` 决定渲染 `<pre>` 还是 `.cm-editor-container` 的。若只延后"建 CM"
 * 而不延后判定，浏览器会先看到一只**空的** `.cm-editor-container`（实测 220ms 里块高 2px，
 * 只剩外壳边框），反而制造出新的塌陷。所以在源头等：滚动期间 `nearViewport` 不动，
 * 模板就完全不动，逐 tick 的高度与 DOM 都不变。
 *
 * 用户已经表态的动作（点进块 / 光标落进块）**不走这道门** —— 它们改的是 `activated` /
 * `selectionInside`，见下面 watcher 上方注释。
 */
let nearTimer: ReturnType<typeof setTimeout> | null = null

function scheduleNear(next: boolean): void {
  if (nearTimer) {
    clearTimeout(nearTimer)
    nearTimer = null
  }
  const apply = (): void => {
    nearTimer = null
    nearViewport.value = next
  }
  const wait = msUntilScrollIdle(performance.now())
  if (wait <= 0) {
    apply()
    return
  }
  nearTimer = setTimeout(apply, wait + 16)
}

onMounted(() => {
  // 视口观察（代码块虚拟化）：两个分支都要观察 —— 它决定的是「这个块该不该挂 CM」。
  // 观察根用默认视口（祖先裁剪由 IntersectionObserver 自己处理，分屏下也准）。
  const el = blockEl()
  if (el) {
    // 语言浮层：焦点进/出本块（CM / mermaid 预览按钮 / 静态区）时开关。
    // 用原生监听而不是模板上的 @focusin：NodeViewWrapper 的 render 只透传它自己那几项 attr，
    // 事件能不能落到根节点取决于 Tiptap 版本；原生监听不依赖那层实现。
    el.addEventListener('focusin', onBlockFocusIn)
    el.addEventListener('focusout', onBlockFocusOut)
    el.addEventListener('pointerdown', onBlockPointerDown, true)
    stopMountWatch = watchCodeBlockMount(el, (near) => {
      if (near) {
        // 回到视口附近：马上挂（并撤销可能正在倒计时的卸载）
        if (unmountDelayTimer) {
          clearTimeout(unmountDelayTimer)
          unmountDelayTimer = null
        }
        // 块第一次露面之前先把语言判好（识别只影响显示，不写回文档）：
        // 这样 mermaid 块不会先闪一帧源码、ts 块不会先闪一帧纯文本。
        runDetect()
        scheduleNear(true)
        return
      }
      // 离开视口附近：**延迟 500ms 再卸**（P3.2）——来回滚一点就挂/卸会白花两次 CM 构造
      if (unmountDelayTimer) clearTimeout(unmountDelayTimer)
      unmountDelayTimer = setTimeout(() => {
        unmountDelayTimer = null
        scheduleNear(false)
      }, UNMOUNT_DELAY_MS)
    })
  } else {
    // 理论上不会发生（模板根节点必然挂出来）；真发生就当作「在视口内」，不能把块卡成静态
    runDetect()
    nearViewport.value = true
  }
  props.editor.on('selectionUpdate', refreshSelectionInside)
  refreshSelectionInside()

  if (selectedLanguage.value === 'mermaid') {
    // 视口门：容器挂出来之后才知道要不要渲染（见 armMermaidObserver 的注释）
    void nextTick(() => armMermaidObserver())
    return
  }
  // 不再无条件建 CM：能不能建由挂载策略决定（见 codeBlockMountPolicy 的注释）
  if (cmMounted.value) void mountCmForVirtualization()
})

/**
 * 挂载态变化 → 建/拆 CM。两个方向都要走各自的流程（卸载顺序见 mountCmForVirtualization
 * 上方注释）。
 *
 * 这里**同步**执行，不再自己等：滚动中不切换的闸门在**视口判定**那一层
 * （`scheduleNear`，见上）—— 判定不动，`cmMounted` 就不会翻，模板也就完全不动。
 * 而"用户点进块 / 光标落进块"直接把 `activated` / `selectionInside` 置真，走的是同一个
 * watcher，天然免排队（不能让人点了代码块还要等滚停）。
 */
watch(cmMounted, (on) => {
  if (on) void mountCmForVirtualization()
  else unmountCmForVirtualization()
})

onBeforeUnmount(() => {
  // onBeforeUnmount 也要走「注销句柄」这条路：虚拟化之后句柄只在挂载期存在
  if (handleRegistered) {
    unregisterCodeBlockHandle(handle)
    handleRegistered = false
  }
  const el = blockEl()
  if (el) {
    el.removeEventListener('focusin', onBlockFocusIn)
    el.removeEventListener('focusout', onBlockFocusOut)
    el.removeEventListener('pointerdown', onBlockPointerDown, true)
  }
  closePicker()
  if (detectTimer) clearTimeout(detectTimer)
  detectTimer = null
  props.editor.off('selectionUpdate', refreshSelectionInside)
  stopMountWatch?.()
  stopMountWatch = null
  if (unmountDelayTimer) clearTimeout(unmountDelayTimer)
  unmountDelayTimer = null
  if (nearTimer) {
    clearTimeout(nearTimer)
    nearTimer = null
  }
  teardownCm()
  teardownMermaidObserver()
  resetPendingMermaidSwap()
  if (pinTimer) clearTimeout(pinTimer)
  pinTimer = null
  if (extSyncTimer) clearTimeout(extSyncTimer)
  extSyncTimer = null
  if (mermaidPreviewTimer) clearTimeout(mermaidPreviewTimer)
  mermaidPreviewTimer = null
})

// ─── Mermaid 渲染 ───
const mermaidSvg = ref('')
const editingMermaid = ref(false)
const mermaidSource = ref('')
/** 编辑态下半段的实时预览图（**只缩不放**口径与显示态完全一致，见 normalizeMermaidSvg） */
const mermaidEditSvg = ref('')
/** 最近一次实时预览渲染失败（上一张成功的图仍在 mermaidEditSvg 里） */
const mermaidPreviewError = ref(false)
const mermaidInputRef = ref<HTMLTextAreaElement | null>(null)
const mermaidRenderRef = ref<HTMLElement | null>(null)
let mermaidRenderTimer: ReturnType<typeof setTimeout> | null = null
let mermaidPreviewTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 编辑态实时预览的防抖（ms）。
 *
 * 为什么是这个区间：mermaid.render 是一次完整布局 + 文本测量，逐键调用会把连续输入拖卡；
 * 300ms 又是「打字停下就能看到结果」的感知阈值内（验收口径 ≤400ms 更新）。
 * 显示态那 400ms 是节点内容变化（提交/外部改动）的防抖，两件事别合并。
 */
const MERMAID_PREVIEW_DEBOUNCE_MS = 300
/** 预览渲染序号：异步渲染回来时只采用**最新一次**的结果（防止乱序覆盖） */
let mermaidPreviewSeq = 0

/**
 * 源码框最小高度（px）：与 overlays.css 的 `.mermaid-source-input { min-height }` 同一数值。
 * 自动增高以它为下限（只有一行的源码不会缩成一条缝）。
 */
const MERMAID_SOURCE_MIN_HEIGHT_PX = 130
/**
 * 超过这个行数进入编辑态时，把插入符放在**开头**。
 *
 * 源码框现在按内容完整展开（不内部滚动）：200 行 ≈ 4000px，若沿用原来的"插入符放末尾"，
 * 浏览器为了露出插入符会把整页滚到块底，表现为"点一下图，页面就跑到别处"。
 * 短源码（常见 3–10 行）仍沿用原文末尾，不改变大多数人的肌肉记忆。
 */
const MERMAID_LONG_SOURCE_LINES = 24

/**
 * IME 组字状态（compositionstart → compositionend）。
 * 组字期间的任何"重渲染/提交/抢焦点"都会把候选词打断（中文用户直接打不出字）。
 */
const mermaidComposing = ref(false)
/** 组字期间发生了 blur：推迟到 compositionend 再提交，绝不把半截拼音写进文档 */
let mermaidBlurWhileComposing = false

/**
 * 这些事件在源码框里**必须由 textarea 自己处理**，一个字都不许冒泡到 PM 根节点。
 *
 * 真因（实测，Electron 39 / Chromium）：NodeView 里的 textarea 在 PM 的 DOM 树内，
 * 键盘事件会冒泡到 `view.dom` 上 PM 的 keydown 处理器 —— 它**不检查 event.target**：
 *   * ArrowUp/ArrowDown ⇒ `selectVertically → endOfTextblock → view.focus()`，
 *     焦点被抢回 ProseMirror，textarea 随即 blur ⇒ `commitMermaid()` 把编辑态关掉
 *     （表现就是"源码框刚出来按一下方向键就没了，根本没法编辑"）；
 *   * Enter ⇒ PM 的 splitBlock 作用在**文档**上（pmlen 60→61，块被拆开）；
 *   * Backspace ⇒ PM 的 joinBackward/deleteSelection 作用在文档上（pmlen 60→58）；
 *   * Ctrl+A / Ctrl+Z 会被 PM 的 selectAll / undo 拿走，textarea 自己收不到。
 * 这些键不在 `.cm-editor` 里，所以 codeBlock.ts 的 stopEvent（只认 `.cm-editor`）兜不住。
 * 在 textarea 上逐个 stopPropagation 是唯一不碰 NodeView 配置的修法；浏览器默认行为
 * （插入字符、换行、退格、方向键、原生 undo、粘贴）不受影响。
 */
const MERMAID_SOURCE_LOCAL_EVENTS = [
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'paste',
  'cut',
  'copy',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'dragstart',
  'dragend',
  'dragover',
  'drop'
] as const

function isolateMermaidSource(el: HTMLTextAreaElement): void {
  const stop = (e: Event): void => e.stopPropagation()
  for (const type of MERMAID_SOURCE_LOCAL_EVENTS) el.addEventListener(type, stop)
}

/**
 * 源码框随内容自动增高：高度 = max(最小高度, scrollHeight)，**不允许内部竖直滚动条**。
 *
 * 写法说明：先把 height 置回 auto 再读 scrollHeight —— 只判断
 * `scrollHeight > clientHeight` 只能单向变高，删行/粘贴成更短的内容后不会缩回
 * （显式 height 让 scrollHeight 至少等于 clientHeight）。两次读写在同一帧内完成，
 * 中间不会绘制，所以看不到闪烁。保留 scrollTop 是为了防止个别情况下浏览器在改高度时
 * 顺手把 textarea 的内部滚动位置挪走（哪怕 1px 的内部滚动都算"有滚动条"）。
 */
function autosizeMermaidSource(): void {
  const el = mermaidInputRef.value
  if (!el) return
  const keepTop = el.scrollTop
  el.style.height = 'auto'
  /**
   * `scrollHeight` 是 padding box 的内容高；但源码框底部有 1px 分隔线（overlays.css 的
   * `.mermaid-edit > .mermaid-source-input { border-bottom }`），`height` 算的是 border-box
   * ⇒ 直接写 scrollHeight 会少 1px，clientHeight 恒比 scrollHeight 小 1（验收要求相等）。
   * 把边框厚度补回 height 里即可（视觉上分隔线仍在，内容一行不少）。
   */
  const border = el.offsetHeight - el.clientHeight
  el.style.height = `${Math.max(MERMAID_SOURCE_MIN_HEIGHT_PX, el.scrollHeight + border)}px`
  el.scrollTop = keepTop
}

/**
 * 滚动锚点：mermaid 块高度突变时用来保住"用户正在看的那一屏"。
 *
 * 为什么不在 CSS 里交给浏览器：这套替换是**滚动中异步发生**的（视口门放行 → 动态 import →
 * mermaid.render 同步占主线程 → v-html 换图），实测 Chromium 的 scroll anchoring 没有补偿
 * （838px 的占位换成 45px 的图，scrollTop 只跟着滚轮走、下方内容整体上移 793px）。
 */
interface MermaidScrollAnchor {
  scrollEl: HTMLElement
  block: HTMLElement
  scrollTop: number
  top: number
  height: number
  viewTop: number
  viewBottom: number
}

function captureMermaidScrollAnchor(): MermaidScrollAnchor | null {
  const block = blockEl() as HTMLElement | null
  const scrollEl = block?.closest('.editor-scroll') as HTMLElement | null
  if (!block || !scrollEl) return null
  const r = block.getBoundingClientRect()
  const view = scrollEl.getBoundingClientRect()
  return {
    scrollEl,
    block,
    scrollTop: scrollEl.scrollTop,
    top: r.top,
    height: r.height,
    viewTop: view.top,
    viewBottom: view.bottom
  }
}

function restoreMermaidScrollAnchor(anchor: MermaidScrollAnchor): void {
  // 节点被替换/卸载时 rect 全是 0，不要拿它去改 scrollTop
  if (!anchor.block.isConnected) return
  const r = anchor.block.getBoundingClientRect()
  const position = mermaidBlockPosition(r.top, r.bottom, anchor.viewTop, anchor.viewBottom)
  const delta = mermaidAnchorScrollDelta(position, r.height - anchor.height, r.top - anchor.top)
  if (!delta) return
  anchor.scrollEl.scrollTop = Math.max(0, anchor.scrollTop + delta)
}

/** 现在这个块相对滚动容器的位置（块不在 DOM 里 ⇒ null） */
function mermaidBlockPositionNow(): MermaidBlockPosition | null {
  const block = blockEl() as HTMLElement | null
  if (!block || !block.isConnected) return null
  const scrollEl = block.closest('.editor-scroll') as HTMLElement | null
  if (!scrollEl) return null
  const r = block.getBoundingClientRect()
  const view = scrollEl.getBoundingClientRect()
  return mermaidBlockPosition(r.top, r.bottom, view.top, view.bottom)
}

/**
 * ─── 换图排队：**块部分可见时不换**（第二轮报障的真因）─────────────────────────
 *
 * 实测（F 场景，块 838px、视口 840px、换图时块底在视口里 590px）：
 *   scrollTop 6848→5935（Δ-913，滚轮只有 -120）、块高 838→45、块顶 -216→697、
 *   块上方段落 rect.top -295→618。旧代码用换图**之后**的 rect 判位置：块缩成 45px 后
 *   整体落到视口上方 ⇒ 走 `above` 补偿 -793 ⇒ 把块顶连同视口内容一起往上挪 793px。
 *   视觉上就是「在图下方往上滚，突然跳到 mermaid 上方很远」。
 *
 * 现在：`visible`（哪怕只露一条边）→ 先把新 SVG 排队，**块高保持不变**；
 *   * 继续滚动、块完全离开视口后立即换图（above/below 的补偿在屏幕外，见 restore）；
 *   * 滚动停下来（260ms 空闲）→ 平滑收拢高度（不动 scrollTop，见 applyMermaidSvgAnimated）；
 *   * 用户主动点进编辑/提交（force）→ 立即换，不等（见 renderMermaid(force)）。
 * 这样「换图导致的高度突变」永远不会发生在块可见、用户还在滚动的这一拍里。
 */
const mermaidSwapPending = ref(false)
let pendingMermaidSvg: string | null = null
let pendingSwapScrollEl: HTMLElement | null = null
let pendingSwapIdleTimer: ReturnType<typeof setTimeout> | null = null
let mermaidAnimTimer: ReturnType<typeof setTimeout> | null = null
/** 滚动停下多久后允许收拢（也是"用户在看这块图"的判据） */
const MERMAID_SWAP_IDLE_MS = 260
/** 可见时收拢块高的过渡时长：不是瞬时跳变，下方内容跟着匀速上移 */
const MERMAID_SWAP_ANIM_MS = 360

/** 立刻换图：换前记录锚点，DOM 更新后按 above/visible/below 补偿（编辑/提交路径走这条） */
async function applyMermaidSvg(svg: string): Promise<void> {
  clearMermaidHeightAnimation()
  const anchor = captureMermaidScrollAnchor()
  mermaidSvg.value = svg
  await nextTick()
  if (anchor) restoreMermaidScrollAnchor(anchor)
}

/** 清掉收拢动画留下的内联高度（任何一次新换图/进编辑/卸载之前都必须清） */
function clearMermaidHeightAnimation(): void {
  if (mermaidAnimTimer) {
    clearTimeout(mermaidAnimTimer)
    mermaidAnimTimer = null
  }
  const el = mermaidBlockRef.value
  if (!el) return
  el.style.transition = ''
  el.style.height = ''
  el.style.overflow = ''
}

/**
 * 可见时收拢：**不写 scrollTop**，把块高从旧值过渡到新值。
 * 这样滚轮节奏不被改写（逐 tick 只有滚轮量），也没有单帧 793px 的跳变。
 */
async function applyMermaidSvgAnimated(svg: string): Promise<void> {
  const el = mermaidBlockRef.value
  if (!el) {
    await applyMermaidSvg(svg)
    return
  }
  clearMermaidHeightAnimation()
  const h0 = el.getBoundingClientRect().height
  mermaidSvg.value = svg
  await nextTick()
  if (!el.isConnected) return
  const h1 = el.getBoundingClientRect().height
  // 高度本来就稳定（图片尺寸与占位一致）⇒ 什么都不用做
  if (!Number.isFinite(h0) || Math.abs(h1 - h0) < 12) return
  // 系统设置「减少动态效果」时直接落位，不再播过渡
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  el.style.transition = 'none'
  el.style.overflow = 'hidden'
  el.style.height = `${h0}px`
  // 强制一次布局，让 h0 成为过渡起点（同一帧内完成，不会先画一帧旧高度）
  void el.offsetHeight
  el.style.transition = `height ${MERMAID_SWAP_ANIM_MS}ms cubic-bezier(0.2, 0.7, 0.3, 1)`
  el.style.height = `${h1}px`
  mermaidAnimTimer = setTimeout(() => {
    mermaidAnimTimer = null
    if (!el.isConnected) return
    el.style.transition = ''
    el.style.height = ''
    el.style.overflow = ''
  }, MERMAID_SWAP_ANIM_MS + 40)
}

function detachPendingSwapWatcher(): void {
  if (pendingSwapScrollEl) {
    pendingSwapScrollEl.removeEventListener('scroll', onPendingSwapScroll)
    pendingSwapScrollEl = null
  }
  if (pendingSwapIdleTimer) {
    clearTimeout(pendingSwapIdleTimer)
    pendingSwapIdleTimer = null
  }
}

function armPendingSwapWatcher(): void {
  const block = blockEl() as HTMLElement | null
  const scrollEl = block?.closest('.editor-scroll') as HTMLElement | null
  if (!scrollEl) return
  if (pendingSwapScrollEl !== scrollEl) {
    detachPendingSwapWatcher()
    pendingSwapScrollEl = scrollEl
    scrollEl.addEventListener('scroll', onPendingSwapScroll, { passive: true })
  }
  if (pendingSwapIdleTimer) clearTimeout(pendingSwapIdleTimer)
  pendingSwapIdleTimer = setTimeout(() => {
    pendingSwapIdleTimer = null
    flushPendingMermaidSwap(true)
  }, MERMAID_SWAP_IDLE_MS)
}

/** 滚动中：块完全离开视口 ⇒ 立即换（补偿在屏幕外）；还在视口里 ⇒ 重置空闲计时 */
function onPendingSwapScroll(): void {
  if (!pendingMermaidSvg) return
  if (mermaidBlockPositionNow() !== 'visible') {
    flushPendingMermaidSwap(false)
    return
  }
  if (pendingSwapIdleTimer) clearTimeout(pendingSwapIdleTimer)
  pendingSwapIdleTimer = setTimeout(() => {
    pendingSwapIdleTimer = null
    flushPendingMermaidSwap(true)
  }, MERMAID_SWAP_IDLE_MS)
}

/** 丢弃排队/动画（卸载、切语言、换块时用） */
function resetPendingMermaidSwap(): void {
  pendingMermaidSvg = null
  mermaidSwapPending.value = false
  detachPendingSwapWatcher()
  clearMermaidHeightAnimation()
}

function flushPendingMermaidSwap(animated: boolean): void {
  const svg = pendingMermaidSvg
  pendingMermaidSvg = null
  mermaidSwapPending.value = false
  detachPendingSwapWatcher()
  if (svg === null) return
  if (animated) void applyMermaidSvgAnimated(svg)
  else void applyMermaidSvg(svg)
}

/**
 * 所有显示态换图的唯一入口（空源码/渲染成功/渲染失败三条分支都走这里）。
 * `force` 只给用户主动动作（提交编辑）用 —— 那时块就在眼前，排队会让用户以为图没变。
 */
function queueMermaidSvg(svg: string, force = false): void {
  const position = mermaidBlockPositionNow()
  if (force || editingMermaid.value || position !== 'visible') {
    pendingMermaidSvg = null
    mermaidSwapPending.value = false
    detachPendingSwapWatcher()
    void applyMermaidSvg(svg)
    return
  }
  pendingMermaidSvg = svg
  mermaidSwapPending.value = true
  armPendingSwapWatcher()
}

/**
 * ─── 视口门（清单 §2.G / O1）────────────────────────────────────────────────
 * mermaid 家族是构建产物里最重的一坨：`mermaid.core` 1.23MB + `cynefin` 1.30MB +
 * `cytoscape` 0.96MB ≈ **3.5MB**（懒加载）。只要文档里有一个 ```mermaid 块，
 * 原来的 onMounted 就会 `import('mermaid')` —— 哪怕它远在屏幕外、用户只是翻过去。
 * 现在：**进入视口附近 600px 才真正 import + 渲染**；在此之前块内展示源码占位
 * （既有高度、可点击回到源码编辑，与原错误兜底是同一套标记）。
 *
 * 为什么 rootMargin 取 600px（与代码块虚拟化同一档，见 codeBlockMountPolicy）：
 * 首次 `import('mermaid')` + render 要几百 ms，200px 的提前量在正常滚轮速度下不够 ——
 * 实测放行后块已经滚进视口 590px 才换图，高度 838→45 的突变就发生在**用户眼前**。
 * 提到 600px 后，多数情况下换图在屏幕外完成；真没赶上（慢盘/快速滚动）时由
 * `queueMermaidSvg` 排队到块离开视口（见上方「换图排队」注释），绝不在可见时突变。
 * 导出不受影响：那条路走 `renderMermaidInHtml(html)`，与编辑器视图解耦。
 */
const mermaidNearViewport = ref(false)
let mermaidObserver: IntersectionObserver | null = null

/** 放行视口门：只放行一次，随后按需渲染（幂等） */
function openMermaidGate(): void {
  if (mermaidNearViewport.value) return
  mermaidNearViewport.value = true
  teardownMermaidObserver()
  void renderMermaid()
}

function teardownMermaidObserver(): void {
  mermaidObserver?.disconnect()
  mermaidObserver = null
}

/** 在图表容器上挂观察器（容器还没挂出来时由调用方稍后重试） */
function armMermaidObserver(): void {
  if (mermaidNearViewport.value || mermaidObserver) return
  const el = mermaidRenderRef.value
  if (!el || typeof IntersectionObserver === 'undefined') {
    // 没有观察器（老环境 / 容器未挂载）：直接放行，宁可不省这 3.5MB，也不能不渲染
    openMermaidGate()
    return
  }
  mermaidObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) openMermaidGate()
    },
    // 上下各提前 600px 放行（左右不限）：给首次 import/render 留出滚动时间
    { rootMargin: '600px 0px 600px 0px' }
  )
  mermaidObserver.observe(el)
}

/** mermaid 的初始化参数：显示态与编辑态预览必须完全一致（否则同一份代码两种观感） */
function mermaidConfig(): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: settings.resolveTheme() === 'dark' ? 'dark' : 'default',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
  }
}

/**
 * mermaid 渲染失败时会在 body 里留下临时节点（id 为传入的 id / `d+id`）。
 * 不清理的话每错一次就多一坨隐藏 DOM，导出与截图也会被它污染。
 */
function removeMermaidTempNode(id: string): void {
  document.getElementById(id)?.remove()
  document.getElementById(`d${id}`)?.remove()
}

async function renderMermaid(force = false): Promise<void> {
  // 视口门未开就不 import —— 观察器放行时会自己回来调一次
  if (!mermaidNearViewport.value) return
  // 空 / 只有空白：不交给 mermaid.render（它对空源码必抛错，会留一堆临时 DOM），
  // 直接回占位态（模板对空内容显示"空 mermaid 代码块"提示）。
  if (normalizeMermaidSource(props.node.textContent || '') === '') {
    queueMermaidSvg('', force)
    return
  }
  try {
    const mod = await import('mermaid')
    mod.default.initialize(mermaidConfig())
    const { svg } = await mod.default.render(
      `mmd-block-${Date.now()}`,
      props.node.textContent || ''
    )
    /**
     * 图表尺寸（用户报障：竖向图被放大到一屏一个框）。
     *
     * 口径是**只缩不放**，实现只有一处：`normalizeMermaidSvg()`（lib/export.ts）。
     * 它把 viewBox 的自然宽高写回 `<svg width height>` 并摘掉内联 style；缩放交给
     * overlays.css 里 `max-width:100%`：
     *   * 宽扁图（自然宽 > 容器）⇒ 等比缩到容器宽，不会被裁；
     *   * 竖图（自然宽 < 容器）⇒ 保持自然尺寸，不再 width:100% 拉满一屏。
     * 导出侧 `renderMermaidInHtml` 调的是同一个函数，两边不可能漂。
     */
    // 占位（几十行源码）↔ 图 的高度往往差好几百 px：块可见时排队（高度先不变），
    // 离开视口/滚动停下后再换；块在屏幕外时直接换并由 restoreMermaidScrollAnchor 补偿。
    queueMermaidSvg(normalizeMermaidSvg(svg), force)
  } catch {
    queueMermaidSvg(`<pre><code>${escapeHtml(props.node.textContent || '')}</code></pre>`, force)
  }
}

/**
 * 编辑态实时预览：只渲染 textarea 里的 `mermaidSource`。
 *
 * 失败语义（用户口径）：**保留上一张成功的图** + 在预览上方加一行弱化提示，
 * 绝不把整块替换成错误文本 —— 否则「改坏一个括号」就会让整张图消失，没法边改边看。
 */
async function renderMermaidPreview(): Promise<void> {
  if (!editingMermaid.value) return
  const seq = ++mermaidPreviewSeq
  const source = mermaidSource.value
  const id = `mmd-edit-${Date.now()}-${seq}`
  try {
    const mod = await import('mermaid')
    mod.default.initialize(mermaidConfig())
    const { svg } = await mod.default.render(id, source)
    // 异步回来的旧结果直接丢弃（用户可能已经退出编辑 / 又敲了新内容）
    if (seq !== mermaidPreviewSeq || !editingMermaid.value) return
    const next = nextMermaidPreviewState(
      { svg: mermaidEditSvg.value, error: mermaidPreviewError.value },
      normalizeMermaidSvg(svg)
    )
    // 预览图变高/变矮会改变块高：块在视口上方时补 scrollTop，正在读的内容不被推走
    const anchor = captureMermaidScrollAnchor()
    mermaidEditSvg.value = next.svg
    mermaidPreviewError.value = next.error
    await nextTick()
    if (anchor) restoreMermaidScrollAnchor(anchor)
  } catch {
    removeMermaidTempNode(id)
    if (seq !== mermaidPreviewSeq || !editingMermaid.value) return
    const next = nextMermaidPreviewState(
      { svg: mermaidEditSvg.value, error: mermaidPreviewError.value },
      null
    )
    mermaidEditSvg.value = next.svg
    mermaidPreviewError.value = next.error
  }
}

/**
 * 输入：先贴合高度（源码框随内容增长，无内部滚动条），再排预览。
 * IME 组字期间**不排**预览：mermaid.render 是同步重活，会把候选词/组字打断；
 * compositionend 会补排一次，所以停手后仍然按时看到图。
 */
function onMermaidSourceInput(): void {
  autosizeMermaidSource()
  if (mermaidComposing.value) return
  if (mermaidPreviewTimer) clearTimeout(mermaidPreviewTimer)
  mermaidPreviewTimer = setTimeout(() => {
    mermaidPreviewTimer = null
    void renderMermaidPreview()
  }, MERMAID_PREVIEW_DEBOUNCE_MS)
}

/** 组字开始：进入守卫态，并取消可能已排队的预览（不能在图里插半截拼音） */
function onMermaidCompositionStart(): void {
  mermaidComposing.value = true
  if (mermaidPreviewTimer) {
    clearTimeout(mermaidPreviewTimer)
    mermaidPreviewTimer = null
  }
}

/**
 * 组字结束：退出守卫态、补一次高度贴合与预览。
 * 若组字期间焦点已经离开（blur 被推迟，见 commitMermaid），这里补提交 —— 提交必须
 * 发生在 compositionend 之后，否则写进文档的是半截拼音而不是上屏的汉字。
 */
function onMermaidCompositionEnd(): void {
  mermaidComposing.value = false
  autosizeMermaidSource()
  if (mermaidBlurWhileComposing || document.activeElement !== mermaidInputRef.value) {
    mermaidBlurWhileComposing = false
    commitMermaid()
    return
  }
  onMermaidSourceInput()
}

/**
 * 编辑态键盘：`Esc` / `Ctrl(Cmd)+Enter` = **提交并退出**（与点块外同一语义）。
 * 都要 stopPropagation：否则 Esc 会被 PM / 语言浮层当成"关闭"，Ctrl+Enter 会被
 * 当成块外快捷键。
 */
function onMermaidSourceKeydown(e: KeyboardEvent): void {
  // IME 组字中的 Esc 只负责"取消候选/结束组字"（浏览器默认行为），
  // 绝不能顺手提交并退出编辑 —— 中文用户按 Esc 收候选词是常态。
  // Ctrl+Enter 在组字中同样不能提交（会把半截拼音写进文档）。
  if (e.isComposing || mermaidComposing.value) return
  if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
    e.preventDefault()
    e.stopPropagation()
    commitMermaid()
  }
}

watch(
  () => props.node.textContent,
  () => {
    if (selectedLanguage.value !== 'mermaid') return
    clearTimeout(mermaidRenderTimer as never)
    mermaidRenderTimer = setTimeout(() => void renderMermaid(), 400)
  }
)

function startMermaidEdit(): void {
  // 点得动它 = 这块已经在视口里：先放行视口门。否则编辑态把预览按钮卸载后，观察器
  // 还盯着那个**已脱离文档**的旧节点，永远等不到相交回调 —— 退出编辑态会一直停在源码占位。
  openMermaidGate()
  /**
   * 排队中的新图是当前最真实的一版：先落成显示态再进编辑。
   * 否则「图已渲染好但因为在视口里被排队」时点进编辑、未改动退出，显示态会退回旧占位。
   * 这一拍马上会切到编辑形态，所以这里的高度变化是用户主动点击的一部分，不需要补偿。
   */
  if (pendingMermaidSvg) {
    mermaidSvg.value = pendingMermaidSvg
    pendingMermaidSvg = null
    mermaidSwapPending.value = false
    detachPendingSwapWatcher()
    clearMermaidHeightAnimation()
  }
  mermaidSource.value = props.node.textContent
  // 预览从显示态那张图起步（成功渲染过就是同一条 SVG），进入编辑态不会先闪一个空位。
  // 显示态是错误兜底（<pre>）时它为空，下面会立刻渲染一次。
  mermaidEditSvg.value = /^\s*<svg/i.test(mermaidSvg.value) ? mermaidSvg.value : ''
  mermaidPreviewError.value = false
  mermaidPreviewSeq++
  editingMermaid.value = true
  /**
   * 进入编辑态后必须把焦点交给 textarea：点击时 textarea 尚不存在（v-if 刚切换），
   * 浏览器不会给它焦点，PM 的 click 处理器又会把焦点交给 PM 根节点 —— 于是
   * 「点击块外」不会产生任何 blur，commitMermaid 永不执行，块卡在编辑态，
   * 表现为「要再点进去一次、再失焦一次才回到图表」。
   */
  void nextTick(() => {
    const el = mermaidInputRef.value
    if (!el) return
    /**
     * 事件隔离必须在 focus 之前装好：焦点一落进来，键盘事件就已经开始冒泡到 PM。
     * 见 MERMAID_SOURCE_LOCAL_EVENTS 的注释（ArrowUp/Enter/Backspace 会作用到文档上）。
     */
    isolateMermaidSource(el)
    // 先按内容把高度贴合好，再 focus：否则 focus 时还是旧的 130px，浏览器会对插入符
    // 做一次"最小滚动"，长源码看起来就是一顿跳。
    autosizeMermaidSource()
    // preventScroll：源码框就在用户点的地方，别让焦点把整页再滚一次
    el.focus({ preventScroll: true })
    /**
     * 插入符：短源码沿用原文末尾（大多数人的习惯）；长源码放开头 —— 200 行源码框高约
     * 4000px，放末尾会把整页滚到块底（见 MERMAID_LONG_SOURCE_LINES）。
     */
    const lines = (el.value.match(/\n/g)?.length ?? 0) + 1
    const caret = lines > MERMAID_LONG_SOURCE_LINES ? 0 : el.value.length
    el.setSelectionRange(caret, caret)
  })
  // 没有可沿用的图（首次渲染失败 / 还没轮到视口门）：立刻按当前源码渲染一张，
  // 保证「代码在上、预览在下」一进来就是两段都在（防抖只用于后续输入）。
  if (!mermaidEditSvg.value) void renderMermaidPreview()
}

/**
 * 提交并退出编辑态（点块外 / Esc / Ctrl+Enter 三条路都走这里）。
 *
 * * **未改动 ⇒ 一个事务都不发**：只切回显示形态（`getMarkdown()` 与撤销栈都不受影响）；
 * * 有改动 ⇒ 写回 `code` 节点的文本（与原来一致），再按新内容重渲染显示态。
 * `editingMermaid` 守卫防止「Esc 提交后 textarea 卸载又触发一次 blur」造成重复事务。
 */
function commitMermaid(): void {
  if (!editingMermaid.value) return
  /**
   * IME 组字中：**不提交**，只记下"该提交了"。Chromium 在失焦时会先 compositionend
   * 再 blur，但顺序并非所有输入法都一致；直接提交会写进半截拼音（例如把 `ni` 而不是
   * `你` 写进文档）。onMermaidCompositionEnd 会在组字结束后补这一次提交。
   */
  if (mermaidComposing.value) {
    mermaidBlurWhileComposing = true
    return
  }
  editingMermaid.value = false
  mermaidPreviewSeq++
  if (mermaidPreviewTimer) {
    clearTimeout(mermaidPreviewTimer)
    mermaidPreviewTimer = null
  }
  mermaidPreviewError.value = false
  /**
   * 只有空白 ⇒ 按空源码提交（清空块内容）：既不留 `\n  ` 这种尾随空格差异，
   * 也不把一个必错的 mermaid 源码交给渲染器。非空源码逐字保留（缩进是排版的一部分）。
   */
  const source = normalizeMermaidSource(mermaidSource.value)
  if (source === props.node.textContent) return
  const getPos = props.getPos as () => number
  const pos = getPos()
  if (typeof pos !== 'number') return
  props.editor.commands.command(({ tr }) => {
    const node = tr.doc.nodeAt(pos)
    if (!node) return false
    // 空内容不能 `schema.text('')`（prosemirror 的 text node 不接受空字符串），走 delete
    if (source === '') {
      tr.delete(pos + 1, pos + node.nodeSize - 1)
      return true
    }
    tr.replaceWith(pos + 1, pos + node.nodeSize - 1, tr.doc.type.schema.text(source))
    return true
  })
  // 用户主动提交：不排队（块就在眼前，等离开视口会让编辑结果"消失"）
  void renderMermaid(true)
}
</script>

<template>
  <!-- 代码块外壳。**没有顶栏**（用户口径：那一行连同语言徽标一起取消）：
       未聚焦时这里只有代码正文，块高 = 代码区高。语言选择器是聚焦才挂出来的浮层，
       见模板末尾的 .cb-lang-picker（fixed 定位、不在文档流里、不改变块高）。 -->
  <node-view-wrapper
    ref="blockRef"
    class="code-block-wrapper"
    :data-cb-language="selectedLanguage"
    :data-cb-language-explicit="explicitLanguage || null"
  >
    <!-- Mermaid 图表模式 -->
    <div v-if="selectedLanguage === 'mermaid'" ref="mermaidBlockRef" class="mermaid-block">
      <!-- ─── 编辑态：同一块内**代码在上、实时预览在下**（用户口径：不要再二选一）───
           两段同时可见、块高随内容自然增长；预览不是按钮（它只负责显示），
           提交靠「点块外 / Esc / Ctrl(Cmd)+Enter」三条路，全部走 commitMermaid()。 -->
      <div v-if="editingMermaid" class="mermaid-edit" data-mermaid-edit>
        <!-- 上段：源码编辑框（多行、可 Tab、插入符即焦点提示） -->
        <textarea
          ref="mermaidInputRef"
          v-model="mermaidSource"
          class="mermaid-source-input"
          data-mermaid-source
          spellcheck="false"
          :aria-label="$t('editor.mermaidSource')"
          @input="onMermaidSourceInput"
          @keydown="onMermaidSourceKeydown"
          @compositionstart="onMermaidCompositionStart"
          @compositionend="onMermaidCompositionEnd"
          @blur="commitMermaid"
        />
        <!-- 渲染失败时只加这一行弱化提示；图仍是上一张成功的那张（不换成错误文本） -->
        <p
          v-if="mermaidPreviewError"
          class="mermaid-preview-error"
          role="status"
          data-mermaid-error
        >
          {{ $t('editor.mermaidPreviewError') }}
        </p>
        <!-- 下段：实时预览。mousedown.prevent 让点/滚预览区不夺走 textarea 的焦点，
             于是"看预览"不会被当成"点块外"而误提交。 -->
        <div class="mermaid-preview" data-mermaid-preview @mousedown.prevent>
          <!-- eslint-disable-next-line vue/no-v-html -- mermaidEditSvg 是 mermaid.render() 在 securityLevel:'strict' 下生成的 SVG（见 mermaidConfig），不是文档原文 -->
          <div v-if="mermaidEditSvg" class="mermaid-svg-host" v-html="mermaidEditSvg" />
          <pre v-else class="mermaid-placeholder"><code>{{
            mermaidSource || $t('editor.mermaidEmpty')
          }}</code></pre>
        </div>
      </div>
      <!-- 显示态：预览本体是 <button>，不是 <div @click>：它是"打开源码编辑"这个动作
           （审计 §8 P2「纯鼠标交互」）。样式在 overlays.css 里把按钮默认外观全部抹掉，
           键盘用户 Tab 得到它、Enter/Space 就能进源码编辑。 -->
      <button
        v-else
        ref="mermaidRenderRef"
        type="button"
        class="mermaid-render"
        :data-mermaid-gated="mermaidNearViewport ? null : 'pending'"
        :data-mermaid-pending="mermaidSwapPending ? '1' : null"
        :title="$t('editor.editSource')"
        :aria-label="$t('editor.editSource')"
        @click="startMermaidEdit"
      >
        <!-- 视口门未放行（还没轮到它进视口）时展示源码占位：块有高度、可点击进源码编辑，
             不会是一个空洞；放行后 SVG 一到位就替换掉它 -->
        <pre
          v-if="!mermaidSvg"
          class="mermaid-placeholder"
        ><code>{{ props.node.textContent || $t('editor.mermaidEmpty') }}</code></pre>
        <!-- 宿主 div 不写宽度（overlays.css 的 .mermaid-svg-host）：它是 flex 项，
             宽度 = SVG 的自然宽（只缩不放），居中由 .mermaid-render 的 justify-content 负责。 -->
        <!-- eslint-disable-next-line vue/no-v-html -- mermaidSvg 是 mermaid.render() 在 securityLevel:'strict' 下生成的 SVG（见本文件 mermaid 初始化），不是文档原文 -->
        <div v-else class="mermaid-svg-host" v-html="mermaidSvg" />
      </button>
    </div>

    <!-- 代码块虚拟化的**静态态**（F 项 / O2）：没有轮到挂 CM 的块只渲染等宽文本 + 行号，
         不建 CodeMirror 实例。点一下就激活（下一拍挂 CM 并把光标交给它）。
         `minHeight` 是卸载时记下的挂载态高度 —— 没有它，滚动进/出边距会跳（风险 R3）。
         `tabindex="-1"`：Esc 关闭语言浮层时要把焦点还回代码区（不可 Tab 到，不改变观感）。 -->
    <pre
      v-else-if="!cmMounted"
      ref="staticRef"
      class="cb-static"
      tabindex="-1"
      :style="staticMinHeight ? { minHeight: staticMinHeight + 'px' } : null"
      :data-cb-static="'1'"
      @mousedown.stop="activateFromStatic"
    ><span
        v-if="settings.codeLineNumbers"
        class="cb-static-gutter"
        aria-hidden="true"
      >{{ staticGutter }}</span><!-- eslint-disable-next-line vue/no-v-html -- staticHtml 只可能是「escapeHtml 过的文本 + 我们自己的 lm-tok-* span 壳」（见 lib/editor/staticHighlight.ts 的安全说明），不含任何未转义的用户输入 -->
      <code class="cb-static-code" v-html="staticHtml" /></pre>

    <!-- CodeMirror 代码编辑。
         .stop 阻断事件冒泡到 PM（PM 的 click 处理器会无条件 view.focus()
         并把 DOM 选区重置到 PM 状态选区，把光标从代码块抢走）；
         冒泡阶段的 mousedown/mouseup/click 显式把焦点钉在 CM 上——
         浏览器对 contenteditable 的默认焦点处理并不可靠（会把焦点移到
         PM 根节点），click 阶段最后执行，最终焦点必在 CM。 -->
    <div
      v-else
      ref="editorRef"
      class="cm-editor-container"
      :style="containerMinHeight ? { minHeight: containerMinHeight + 'px' } : null"
      @keydown.capture="onCmKeydownCapture"
      @mousedown.stop="pinCmFocus"
      @mouseup.stop="pinCmFocus"
      @click.stop="pinCmFocus"
      @pointerdown.stop
      @pointerup.stop
      @dblclick.stop
    />

    <!-- ─── 语言浮层（聚焦才出现；`.cb-lang-picker` 是 fixed 定位，不占布局）──────────
         位置口径（本轮用户需求）：**在代码块外面**，默认贴块上方、右对齐、留 6px 缝；
         顶部空间不够时贴到块下方。坐标由 positionPicker → placePicker 按「块外壳 rect」
         算，任何时刻都不与块 rect 相交（单测/验收都按交集面积 = 0 判）。
         为什么放在代码区**之后**：Tab 顺序按 DOM 走。浮层在 CM 之后，用户从代码区按 Tab
         正好落到这个输入框；若放在前面，Tab 会跨过它直接跑到块外。
         v-if（不是 v-show）：未聚焦时 DOM 里**没有**这个节点 —— 验收要求"没有可见的语言条"，
         同时也避免 1500 个块各留一份输入框。
         mousedown/pointerdown/click/keydown 全部 .stop：浮层虽然长在 NodeView 里，
         但它不是正文，不能让 PM 把焦点/选区抢回编辑器根节点。
         **没有"×"清空按钮**（用户口径：取消一键删除）：清空语言 = 手动把输入框里的
         内容删空（输入为空 = 无语言，见 applyLanguageChoice 的空串语义）。 -->
    <div
      v-if="pickerOpen"
      ref="pickerRef"
      class="cb-lang-picker"
      :style="pickerStyle"
      :data-cb-picker-side="pickerSide ?? 'auto'"
      data-cb-lang-picker
      @mousedown.stop
      @pointerdown.stop
      @click.stop
      @dblclick.stop
      @keydown.stop
    >
      <div class="cb-lang-row">
        <input
          ref="pickerInputRef"
          class="cb-lang-input"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          data-cb-lang-input
          :value="pickerQuery"
          :placeholder="$t('editor.codeLanguagePlaceholder')"
          :aria-label="$t('editor.codeLanguage')"
          :aria-expanded="listOpen ? 'true' : 'false'"
          :aria-controls="pickerListId"
          :aria-autocomplete="'list'"
          :aria-activedescendant="
            listOpen && pickerItems.length ? optionId(activeIndex) : undefined
          "
          @input="onPickerInput"
          @keydown="onPickerKeydown"
          @focus="onPickerInputFocus"
        />
      </div>
      <!-- 当前语言没有内置高亮包时，浮层里明确标注（弱化的提示文字，不是报错） -->
      <p v-if="languageUnsupported" class="cb-lang-note" data-cb-lang-note>
        {{ $t('editor.codeLanguageUnsupported') }}
      </p>
      <ul
        v-if="listOpen"
        :id="pickerListId"
        class="cb-lang-list"
        role="listbox"
        :aria-label="$t('editor.codeLanguage')"
        data-cb-lang-list
      >
        <li
          v-for="(item, i) in pickerItems"
          :id="optionId(i)"
          :key="item.value + (item.custom ? ':custom' : '')"
          class="cb-lang-option"
          role="option"
          :aria-selected="i === activeIndex ? 'true' : 'false'"
          :data-cb-lang-option="item.value"
          :data-cb-lang-custom="item.custom ? '1' : null"
          @mousedown.prevent
          @click="applyLanguageChoice(item.value)"
          @mouseenter="activeIndex = i"
        >
          <span class="cb-lang-option-name">{{
            item.custom ? $t('editor.codeLanguageUse', { name: item.label }) : item.label
          }}</span>
          <span v-if="item.note" class="cb-lang-option-note">{{
            $t('editor.codeLanguageUnsupported')
          }}</span>
        </li>
      </ul>
    </div>
  </node-view-wrapper>
</template>
