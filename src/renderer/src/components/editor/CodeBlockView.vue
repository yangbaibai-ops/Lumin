<script setup lang="ts">
// ─── 代码块 NodeView：CodeMirror 6 嵌入 + 语言切换 + Mermaid 渲染 ───────────
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap
} from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import { useSettingsStore } from '../../stores/settings'
import { escapeHtml } from '../../lib/utils/html'

const props = defineProps(nodeViewProps)
const settings = useSettingsStore()

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

const editorRef = ref<HTMLElement | null>(null)
const selectedLanguage = ref<string>(props.node.attrs.language || 'javascript')

let cmView: EditorView | null = null
let prevHasFocus: (() => boolean) | null = null
let cmExtensions: Extension[] = []
const languageCompartment = new Compartment()

// ── CodeMirror 主题（CSS 变量驱动，随应用明暗/羊皮纸主题自动适配）──
const cmTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0 14px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel)'
  },
  '.cm-activeLine': { backgroundColor: 'var(--block-hover)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ink-3)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-2)' },
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
    { tag: t.keyword, color: 'var(--accent)' },
    { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: 'var(--accent-ink)' },
    { tag: [t.function(t.variableName), t.labelName], color: 'var(--warning)' },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--warning)' },
    { tag: [t.definition(t.name), t.separator], color: 'var(--ink-2)' },
    { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: 'var(--warning)' },
    { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: 'var(--accent-2)' },
    { tag: [t.meta, t.comment], color: 'var(--ink-3)', fontStyle: 'italic' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, color: 'var(--accent-2)', textDecoration: 'underline' },
    { tag: t.heading, fontWeight: '700', color: 'var(--accent)' },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: 'var(--warning)' },
    { tag: [t.processingInstruction, t.string, t.inserted], color: 'var(--ok)' },
    { tag: t.invalid, color: 'var(--danger)' }
  ])
)

async function loadLanguage(lang: string): Promise<void> {
  if (lang === 'mermaid' || !cmView) return
  try {
    const desc = languages.find((l) =>
      l.name.toLowerCase() === lang.toLowerCase() || l.alias.includes(lang.toLowerCase())
    )
    if (!desc) {
      cmView.dispatch({ effects: languageCompartment.reconfigure([]) })
      return
    }
    const support = await desc.load()
    cmView.dispatch({ effects: languageCompartment.reconfigure(support.language) })
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
  // 强制把 DOM 光标恢复到 CM 状态选区（updateSelection 的 fromPointer 分支）
  const main = cmView.state.selection.main
  cmView.dispatch({
    userEvent: 'select.pointer',
    selection: { anchor: main.anchor },
    scrollIntoView: false
  })
  if (pinTimer) clearTimeout(pinTimer)
  pinTimer = setTimeout(() => {
    if (cmView) {
      cmView.focus()
      const m2 = cmView.state.selection.main
      cmView.dispatch({
        userEvent: 'select.pointer',
        selection: { anchor: m2.anchor },
        scrollIntoView: false
      })
    }
    pinTimer = null
  }, 60)
}

/** 捕获阶段拦截 Enter：走 CM 状态事务，并用 setState 强制整文档重建。
    嵌套于 ProseMirror 的 CM 增量重绘（docView.update）在本环境不可靠：
    state 会更新但 DOM 不重绘；setState 重建 docView，保证换行真实落到
    DOM（代价是整块重建，对代码块尺寸而言可接受）。 */
function onCmKeydownCapture(e: KeyboardEvent): void {
  if (!cmView || e.isComposing) return
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
function syncToNode(): void {
  if (!cmView) return
  const code = cmView.state.doc.toString()
  if (code === props.node.textContent) return
  const getPos = props.getPos as () => number
  const pos = getPos()
  if (typeof pos !== 'number') return
  const editor = props.editor
  // PM 事务在文档变更时会无条件 selectionToDOM（重写 DOM 选区），浏览器
  // 随之可能把焦点翻回 PM 根节点。事务后立即把焦点与光标归还 CM（同步、
  // 无可见闪烁），pinCmFocus 内置 60ms 延迟重钉兜底异步翻转。
  editor.commands.command(({ tr }) => {
    const node = tr.doc.nodeAt(pos)
    if (!node || node.type.name !== 'codeBlock') return false
    tr.replaceWith(pos + 1, pos + node.nodeSize - 1, tr.doc.type.schema.text(code))
    return true
  })
  pinCmFocus()
}

watch(selectedLanguage, (lang) => {
  props.updateAttributes({ language: lang })
  void loadLanguage(lang)
})

// 外部内容变化（同一文件重新打开等场景，节点内容被外部替换）：
// CM 状态与节点脱钩时整体重置（setState 重建，语言高亮随后重挂）。
// 防抖 150ms：Vue watch 回调是异步排队的——快速连续输入时，每个回调
// 持有的 nv 是触发时刻的过期快照，而 cmView.state 已是最新值，直接
// 比较会误判为「外部变化」并把 CM 状态逐级回滚（快速回车全部丢失的
// 根因）。防抖后只在输入停顿后执行一次，此时快照与状态一致，自身同步
// 自然跳过；真正的外部变化（低频）仍能正确同步。
let extSyncTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => props.node.textContent,
  (nv) => {
    if (extSyncTimer) clearTimeout(extSyncTimer)
    extSyncTimer = setTimeout(() => {
      extSyncTimer = null
      if (!cmView || selectedLanguage.value === 'mermaid') return
      if (nv === cmView.state.doc.toString()) return
      cmView.setState(EditorState.create({ doc: nv, extensions: cmExtensions }))
      void loadLanguage(selectedLanguage.value)
      pinCmFocus()
    }, 150)
  }
)

onMounted(() => {
  if (selectedLanguage.value === 'mermaid') {
    void renderMermaid()
    return
  }
  const host = editorRef.value
  if (!host) return
  cmExtensions = [
    lineNumbers(),
    highlightActiveLine(),
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
  const state = EditorState.create({
    doc: props.node.textContent,
    extensions: cmExtensions
  })
  cmView = new EditorView({ state, parent: host })
  // CM 默认不给 contentDOM 设 tabindex，浏览器点击不会把焦点交给他；
  // 显式设置后点击代码区即可聚焦输入（配合模板上的事件阻断防 PM 抢焦点）
  cmView.contentDOM.tabIndex = 0

  // ── 焦点封堵 ──
  // PM 的 DOMObserver 监听 document 级 selectionchange：CM 内容区内的选区
  // 变化会被它误读为 PM 选区（CM 位于 PM DOM 树内），随后 PM 重写 DOM 选区，
  // 浏览器随之把焦点从 CM 抢回 PM 根节点，导致后续按键由 PM 处理而错乱。
  // 因此：CM 获得焦点期间令 PM 的 hasFocus() 返回 false，使其跳过选区同步。
  const pmView = props.editor.view
  prevHasFocus = pmView.hasFocus.bind(pmView)
  pmView.hasFocus = () => {
    const ae = document.activeElement
    if (ae && ae.closest('.cm-editor')) return false
    return prevHasFocus!()
  }
  void loadLanguage(selectedLanguage.value)
})

onBeforeUnmount(() => {
  // 恢复 PM 的 hasFocus 实现（多代码块时按 LIFO 还原）
  if (prevHasFocus) props.editor.view.hasFocus = prevHasFocus
  prevHasFocus = null
  if (pinTimer) clearTimeout(pinTimer)
  pinTimer = null
  if (extSyncTimer) clearTimeout(extSyncTimer)
  extSyncTimer = null
  cmView?.destroy()
  cmView = null
})

// ─── Mermaid 渲染 ───
const mermaidSvg = ref('')
const editingMermaid = ref(false)
const mermaidSource = ref('')
let mermaidRenderTimer: ReturnType<typeof setTimeout> | null = null

async function renderMermaid(): Promise<void> {
  try {
    const mod = await import('mermaid')
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: settings.effectiveTheme === 'dark' ? 'dark' : 'default',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    })
    const { svg } = await mod.default.render(`mmd-block-${Date.now()}`, props.node.textContent || '')
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
  editingMermaid.value = true
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
  <node-view-wrapper class="code-block-wrapper">
    <div class="code-block-header">
      <span class="code-block-lang-label">{{ selectedLanguage }}</span>
      <select v-model="selectedLanguage" class="code-block-select">
        <option v-for="lang in LANGUAGES" :key="lang" :value="lang">{{ lang }}</option>
      </select>
    </div>

    <!-- Mermaid 图表模式 -->
    <div v-if="selectedLanguage === 'mermaid'" class="mermaid-block">
      <div v-if="!editingMermaid" class="mermaid-render" title="点击编辑源码" @click="startMermaidEdit">
        <div v-html="mermaidSvg" />
      </div>
      <textarea
        v-else
        v-model="mermaidSource"
        class="mermaid-source-input"
        spellcheck="false"
        @blur="commitMermaid"
      />
    </div>

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
