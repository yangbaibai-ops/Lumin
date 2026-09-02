<script setup lang="ts">
// ─── 代码块 NodeView：CodeMirror 6 嵌入 + 语言切换 + Mermaid 渲染 ───────────
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
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

/** 把 CodeMirror 内容同步回 ProseMirror AST 节点 */
function syncToNode(): void {
  if (!cmView) return
  const code = cmView.state.doc.toString()
  if (code === props.node.textContent) return
  const getPos = props.getPos as () => number
  const pos = getPos()
  if (typeof pos !== 'number') return
  props.editor.commands.command(({ tr }) => {
    const node = tr.doc.nodeAt(pos)
    if (!node || node.type.name !== 'codeBlock') return false
    tr.replaceWith(pos + 1, pos + node.nodeSize - 1, tr.doc.type.schema.text(code))
    return true
  })
}

watch(selectedLanguage, (lang) => {
  props.updateAttributes({ language: lang })
  void loadLanguage(lang)
})

onMounted(() => {
  if (selectedLanguage.value === 'mermaid') {
    void renderMermaid()
    return
  }
  const host = editorRef.value
  if (!host) return
  const state = EditorState.create({
    doc: props.node.textContent,
    extensions: [
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
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) syncToNode()
      })
    ]
  })
  cmView = new EditorView({ state, parent: host })
  // CM 默认不给 contentDOM 设 tabindex，浏览器点击不会把焦点交给他；
  // 显式设置后点击代码区即可聚焦输入（配合模板上的 @mousedown.stop 防 PM 抢焦点）
  cmView.contentDOM.tabIndex = 0
  void loadLanguage(selectedLanguage.value)
})

onBeforeUnmount(() => {
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

    <!-- CodeMirror 代码编辑；.stop 阻断 mousedown 冒泡，避免 PM 抢占焦点 -->
    <div v-else ref="editorRef" class="cm-editor-container" @mousedown.stop @pointerdown.stop />
  </node-view-wrapper>
</template>
