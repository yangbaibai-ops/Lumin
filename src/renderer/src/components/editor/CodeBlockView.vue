<script setup lang="ts">
// ─── 代码块 NodeView：CodeMirror 6 嵌入 + 语言切换 + Mermaid 渲染 ───────────
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
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
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
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
  shouldMountCm,
  watchCodeBlockMount,
  STATIC_HIGHLIGHT
} from '../../lib/editor/codeBlockMountPolicy'
import { registerStaticParser, staticHighlightHtml } from '../../lib/editor/staticHighlight'

const props = defineProps(nodeViewProps)
const settings = useSettingsStore()
const editorStore = useEditorStore()

const LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'html',
  'css',
  'json',
  'sql',
  'bash',
  'java',
  'go',
  'rust',
  'cpp',
  'php',
  'ruby',
  'yaml',
  'mermaid'
]

/**
 * 语言支持：**显式映射表**（清单 §1.B / 自查报告 O3）。
 *
 * 原来用 `@codemirror/language-data` 的 `languages` 表找 `load()` —— 那张表覆盖 115 种语言，
 * 于是构建产物里留下 **116 个 `import()` 目标（合计约 1.6MB）**，而本组件的语言清单只有 15 种
 * （+ mermaid 走预览）。现在按清单显式列出来：14 种走 `@codemirror/lang-*`，
 * `bash` / `ruby` 走 `@codemirror/legacy-modes` + `StreamLanguage`，多出来的体积就不发了。
 *
 * ⚠️ 取舍（写清楚，免得后来人以为「任意语言高亮」还在）：**只高亮这 15 种**。
 * 其余语言的 ``` 块按纯文本渲染（与原行为一致：认不出来就 reconfigure 成空扩展）。
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
 * 文档里常见的别名 → 映射表的键（原 `language-data` 认得的那些）。
 * 清单只列了 `js/ts/py/sh/zsh/yml/c++/cc/rb`，这里把 markdown 生态里同样常见的几个一并收进来
 * （`jsx/tsx/mjs/cjs`、`htm`、`yml`、`rb`、`golang`、`cxx/hpp`、`shell`）。
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  htm: 'html',
  xhtml: 'html',
  xml: 'html',
  svg: 'html',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  golang: 'go',
  rb: 'ruby',
  mysql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  sqlite: 'sql'
}

/** 语言标识 → 映射表的键（大小写不敏感；认不出来返回 null = 按纯文本） */
function resolveLanguageKey(lang: string): string | null {
  const key = lang.trim().toLowerCase()
  if (!key) return null
  if (LANGUAGE_LOADERS[key]) return key
  return LANGUAGE_ALIASES[key] ?? null
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
const selectedLanguage = ref<string>(props.node.attrs.language || 'javascript')

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
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0 14px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel)'
  },
  // 不注册 highlightActiveLine：点击代码块时任一行都不该被底色标出来
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ink-3)', border: 'none' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent)',
    border: 'none'
  },
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
/** 离开视口附近后延迟多久才真卸（P3.2：来回滚一点不该反复挂/卸） */
const UNMOUNT_DELAY_MS = 500
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
 * 语言下拉框要不要渲染（P3）：挂载态要，mermaid 块也要（它没有 CM，切回代码语言全靠它）；
 * 只有「静态态的非 mermaid 块」不渲染 —— 那一项的 DOM/内存代价见模板里的注释。
 */
const showLangSelect = computed(() => cmMounted.value || selectedLanguage.value === 'mermaid')

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

/** 挂载：建 CM（复用既有创建函数）+ 应用语言（+ 选区在本块内时把光标交给 CM） */
async function mountCmForVirtualization(): Promise<void> {
  if (cmView || selectedLanguage.value === 'mermaid') return
  await nextTick()
  if (cmView || !blockEl()) return
  staticMinHeight.value = null
  initCm()
  wasMounted.value = true
  if (!handleRegistered) {
    registerCodeBlockHandle(handle)
    handleRegistered = true
  }
  void loadLanguage(selectedLanguage.value)
  // 选区已经在这个块里（例如键盘路径刚把光标交给本块）⇒ 把焦点/光标移交 CM
  if (selectionInside.value) focusCmAtEnd()
}

/** 卸载：先落盘、再拆、记高度、注销句柄（顺序见上方注释） */
function unmountCmForVirtualization(): void {
  if (!cmView) return
  syncToNode()
  const el = blockEl()
  const h = el ? Math.round(el.getBoundingClientRect().height) : 0
  teardownCm()
  staticMinHeight.value = h > 0 ? h : null
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

/** 捕获阶段拦截 Enter：走 CM 状态事务，并用 setState 强制整文档重建。
    嵌套于 ProseMirror 的 CM 增量重绘（docView.update）在本环境不可靠：
    state 会更新但 DOM 不重绘；setState 重建 docView，保证换行真实落到
    DOM（代价是整块重建，对代码块尺寸而言可接受）。 */
function onCmKeydownCapture(e: KeyboardEvent): void {
  if (!cmView || e.isComposing) return
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
    tr.replaceWith(pos + 1, pos + node.nodeSize - 1, tr.doc.type.schema.text(code))
    return true
  })
  // 写回之后节点文本就是 CM 这一份 ⇒ 记录对齐基准（下次 syncToNode 靠它认"节点被外部改过"）
  alignedNodeText = code
  pinCmFocus()
}

watch(selectedLanguage, async (lang) => {
  props.updateAttributes({ language: lang })
  if (lang === 'mermaid') {
    // 切到 mermaid：CM 宿主节点即将被 v-else 卸载，先彻底拆掉（含焦点封堵、
    // 观察器恢复），并退出源码态——否则再切回 mermaid 会看到残留的 textarea
    editingMermaid.value = false
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
})

// 设置里切换「代码块行号」即时生效（折叠槽仍在，只去掉行号）
watch(
  () => settings.codeLineNumbers,
  (on) => {
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
  cmView.setState(EditorState.create({ doc: fresh, extensions: buildCmExtensions() }))
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
  () => scheduleApplyNodeText()
)

/* 扩展列表按需构建：行号开关属于 Compartment，但重建 state（外部内容同步）时
   必须按「当前设置」重新组装，否则会退回挂载时刻的取值 */
function buildCmExtensions(): Extension[] {
  return [
    lineNumberCompartment.of(settings.codeLineNumbers ? lineNumbers() : []),
    drawSelection(),
    history(),
    foldGutter(),
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
      // 剔除 Enter 系与 Tab 绑定：其内部 dispatch（state→DOM 重绘）在
      // 嵌套于 ProseMirror 的场景中断裂（state 更新但 DOM 不重绘），
      // 且 preventDefault 会吞掉浏览器原生插入；Enter 由容器的捕获
      // 处理器接管（setState 重建路径），其余键不受影响
      ...defaultKeymap.filter(
        (b) => b.key !== 'Enter' && b.key !== 'Mod-Enter' && b.key !== 'Shift-Enter'
      ),
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) syncToNode()
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

onMounted(() => {
  // 视口观察（代码块虚拟化）：两个分支都要观察 —— 它决定的是「这个块该不该挂 CM」。
  // 观察根用默认视口（祖先裁剪由 IntersectionObserver 自己处理，分屏下也准）。
  const el = blockEl()
  if (el) {
    stopMountWatch = watchCodeBlockMount(el, (near) => {
      if (near) {
        // 回到视口附近：马上挂（并撤销可能正在倒计时的卸载）
        if (unmountDelayTimer) {
          clearTimeout(unmountDelayTimer)
          unmountDelayTimer = null
        }
        nearViewport.value = true
        return
      }
      // 离开视口附近：**延迟 500ms 再卸**（P3.2）——来回滚一点就挂/卸会白花两次 CM 构造
      if (unmountDelayTimer) clearTimeout(unmountDelayTimer)
      unmountDelayTimer = setTimeout(() => {
        unmountDelayTimer = null
        nearViewport.value = false
      }, UNMOUNT_DELAY_MS)
    })
  } else {
    // 理论上不会发生（模板根节点必然挂出来）；真发生就当作「在视口内」，不能把块卡成静态
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

// 挂载态变化 → 建/拆 CM。两个方向都要走各自的流程（卸载顺序见 mountCmForVirtualization 上方注释）
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
  props.editor.off('selectionUpdate', refreshSelectionInside)
  stopMountWatch?.()
  stopMountWatch = null
  if (unmountDelayTimer) clearTimeout(unmountDelayTimer)
  unmountDelayTimer = null
  teardownCm()
  teardownMermaidObserver()
  if (pinTimer) clearTimeout(pinTimer)
  pinTimer = null
  if (extSyncTimer) clearTimeout(extSyncTimer)
  extSyncTimer = null
})

// ─── Mermaid 渲染 ───
const mermaidSvg = ref('')
const editingMermaid = ref(false)
const mermaidSource = ref('')
const mermaidInputRef = ref<HTMLTextAreaElement | null>(null)
const mermaidRenderRef = ref<HTMLElement | null>(null)
/** 进入源码态时沿用的图表高度（px）：让两种形态的块高一致 */
const mermaidEditHeight = ref<number | null>(null)
let mermaidRenderTimer: ReturnType<typeof setTimeout> | null = null

/**
 * ─── 视口门（清单 §2.G / O1）────────────────────────────────────────────────
 * mermaid 家族是构建产物里最重的一坨：`mermaid.core` 1.23MB + `cynefin` 1.30MB +
 * `cytoscape` 0.96MB ≈ **3.5MB**（懒加载）。只要文档里有一个 ```mermaid 块，
 * 原来的 onMounted 就会 `import('mermaid')` —— 哪怕它远在屏幕外、用户只是翻过去。
 * 现在：**进入视口附近 200px 才真正 import + 渲染**；在此之前块内展示源码占位
 * （既有高度、可点击回到源码编辑，与原错误兜底是同一套标记）。
 *
 * 为什么 rootMargin 取 200px：块从「未渲染」变成「图表」会有高度变化，
 * 提前 200px 放行 ⇒ 变化发生在**屏幕外**，正常滚动不会看到跳动。
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
    // 上下各提前 200px 放行（左右不限）
    { rootMargin: '200px 0px 200px 0px' }
  )
  mermaidObserver.observe(el)
}

async function renderMermaid(): Promise<void> {
  // 视口门未开就不 import —— 观察器放行时会自己回来调一次
  if (!mermaidNearViewport.value) return
  try {
    const mod = await import('mermaid')
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: settings.resolveTheme() === 'dark' ? 'dark' : 'default',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    })
    const { svg } = await mod.default.render(
      `mmd-block-${Date.now()}`,
      props.node.textContent || ''
    )
    mermaidSvg.value = svg
  } catch {
    mermaidSvg.value = `<pre><code>${escapeHtml(props.node.textContent || '')}</code></pre>`
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
  mermaidSource.value = props.node.textContent
  // 先量图表高度，让源码态沿用同一高度：一是切换形态时不再有布局跳动，
  // 二是避免「折叠时块变矮/变高」把鼠标下的其它图表挪走——那样紧随其后的
  // mouseup 会落到别的元素上，浏览器只在两者的共同祖先上补一个 click，
  // 于是「点另一个图表」这一次点击被吞掉，看起来像没反应。
  mermaidEditHeight.value = mermaidRenderRef.value
    ? Math.round(mermaidRenderRef.value.getBoundingClientRect().height)
    : null
  editingMermaid.value = true
  // 进入源码态后必须把焦点交给 textarea：点击时 textarea 尚不存在（v-else 刚切换），
  // 浏览器不会给它焦点，PM 的 click 处理器又会把焦点交给 PM 根节点——于是
  // 「点击块外」不会产生任何 blur，commitMermaid 永不执行，块卡在源码态，
  // 表现为「要再点进去一次、再失焦一次才回到图表」。
  void nextTick(() => {
    const el = mermaidInputRef.value
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

function commitMermaid(): void {
  editingMermaid.value = false
  const source = mermaidSource.value
  if (source === props.node.textContent) return
  const getPos = props.getPos as () => number
  const pos = getPos()
  if (typeof pos !== 'number') return
  props.editor.commands.command(({ tr }) => {
    const node = tr.doc.nodeAt(pos)
    if (!node) return false
    tr.replaceWith(pos + 1, pos + node.nodeSize - 1, tr.doc.type.schema.text(source))
    return true
  })
  void renderMermaid()
}
</script>

<template>
  <node-view-wrapper ref="blockRef" class="code-block-wrapper">
    <div class="code-block-header" data-cb-header>
      <span class="code-block-lang-label">{{ selectedLanguage }}</span>
      <!-- P3 内存第一刀：**静态态不渲染那个 16 项的 `<select>`**。
           实测 1500 块的文档里，光是这一项就是 24,000 个元素 + 24,000 个文本节点，外加
           Chromium 给每个 `<option>` 建的内部 shadow DOM（`Performance.getMetrics` 的 Nodes
           里约 14 万）—— 是这台"内存账"上最大的一笔。屏幕上看得到的块**永远**是挂载态
           （观察器有 600px 提前量），所以静态态的 select 谁也看不到。
           换成同几何的 span 占位（同一套 class / box 模型、只是去掉箭头与光标）⇒ 块高与
           挂载态一致，滚动不跳。mermaid 块没有 CM，必须一直留着 select（否则没法切回代码）。 -->
      <select v-if="showLangSelect" v-model="selectedLanguage" class="code-block-select">
        <option v-for="lang in LANGUAGES" :key="lang" :value="lang">{{ lang }}</option>
      </select>
      <span v-else class="code-block-select code-block-select-static" aria-hidden="true">{{
        selectedLanguage
      }}</span>
    </div>

    <!-- Mermaid 图表模式 -->
    <div v-if="selectedLanguage === 'mermaid'" class="mermaid-block">
      <!-- 预览本体是 <button>，不是 <div @click>：它是"打开源码编辑"这个动作
           （审计 §8 P2「纯鼠标交互」）。样式在 overlays.css 里把按钮默认外观全部抹掉，
           键盘用户 Tab 得到它、Enter/Space 就能进源码编辑。 -->
      <button
        v-if="!editingMermaid"
        ref="mermaidRenderRef"
        type="button"
        class="mermaid-render"
        :data-mermaid-gated="mermaidNearViewport ? null : 'pending'"
        :title="$t('editor.editSource')"
        :aria-label="$t('editor.editSource')"
        @click="startMermaidEdit"
      >
        <!-- 视口门未放行（还没轮到它进视口）时展示源码占位：块有高度、可点击进源码编辑，
             不会是一个空洞；放行后 SVG 一到位就替换掉它 -->
        <pre
          v-if="!mermaidSvg"
          class="mermaid-placeholder"
        ><code>{{ props.node.textContent }}</code></pre>
        <!-- eslint-disable-next-line vue/no-v-html -- mermaidSvg 是 mermaid.render() 在 securityLevel:'strict' 下生成的 SVG（见本文件 mermaid 初始化），不是文档原文 -->
        <div v-else v-html="mermaidSvg" />
      </button>
      <textarea
        v-else
        ref="mermaidInputRef"
        v-model="mermaidSource"
        class="mermaid-source-input"
        :style="mermaidEditHeight ? { minHeight: mermaidEditHeight + 'px' } : null"
        spellcheck="false"
        @blur="commitMermaid"
      />
    </div>

    <!-- 代码块虚拟化的**静态态**（F 项 / O2）：没有轮到挂 CM 的块只渲染等宽文本 + 行号，
         不建 CodeMirror 实例。点一下就激活（下一拍挂 CM 并把光标交给它）。
         `minHeight` 是卸载时记下的挂载态高度 —— 没有它，滚动进/出边距会跳（风险 R3）。 -->
    <pre
      v-else-if="!cmMounted"
      class="cb-static"
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
      @keydown.capture="onCmKeydownCapture"
      @mousedown.stop="pinCmFocus"
      @mouseup.stop="pinCmFocus"
      @click.stop="pinCmFocus"
      @pointerdown.stop
      @pointerup.stop
      @dblclick.stop
    />
  </node-view-wrapper>
</template>
