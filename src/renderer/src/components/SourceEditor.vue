<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { basicSetup } from 'codemirror'
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { undo, redo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import {
  wrapInline,
  toggleLinePrefix,
  toggleHeading,
  blockAction,
  type FormatResult
} from '../lib/format'

const files = useFilesStore()
const ui = useUiStore()
const hostEl = ref<HTMLElement | null>(null)

let view: EditorView | null = null
let suppress = false

// ── 主题（全部使用 CSS 变量，随应用主题自动适配）──
const cmTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--ink)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-editor': {
    maxWidth: 'var(--editor-maxw, 900px)',
    margin: '0 auto'
  },
  '.cm-scroller': {
    fontFamily: 'var(--editor-font)',
    lineHeight: 'var(--editor-lh)',
    fontSize: 'var(--editor-size)'
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '28px 12px 160px'
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px'
  },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
    {
      backgroundColor: 'var(--sel)'
    },
  '.cm-activeLine': { backgroundColor: 'var(--block-hover)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ink-3)',
    border: 'none'
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '46px',
    padding: '0 12px 0 8px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--ink-2)',
    fontWeight: '600'
  },
  '.cm-panels': {
    backgroundColor: 'var(--elevate)',
    color: 'var(--ink)',
    borderColor: 'var(--edge)'
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--edge)'
  },
  '.cm-textfield': {
    backgroundColor: 'var(--panel)',
    color: 'var(--ink)',
    border: '1px solid var(--edge-strong)',
    borderRadius: '6px',
    outline: 'none'
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--panel-2)',
    color: 'var(--ink-2)',
    border: '1px solid var(--edge)',
    borderRadius: '6px'
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--warning) 32%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--warning) 55%, transparent)'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--warning) 55%, transparent)'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--elevate)',
    border: '1px solid var(--edge)',
    color: 'var(--ink)',
    borderRadius: '8px'
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--ink)'
  }
})

// ── 语法高亮（纯源码着色：不改变字号/字重/字形，绝不渲染 Markdown 样式）──
const mdHighlight = syntaxHighlighting(
  HighlightStyle.define([
    // 标题：正文同色同字号，仅 # 标记符本身轻微着色（由 markupHeading 决定，这里保持中性）
    { tag: t.heading1, color: 'var(--ink)' },
    { tag: t.heading2, color: 'var(--ink)' },
    { tag: t.heading3, color: 'var(--ink)' },
    { tag: t.heading4, color: 'var(--ink)' },
    { tag: t.heading5, color: 'var(--ink)' },
    { tag: t.heading6, color: 'var(--ink)' },
    // 行内样式：与正文完全一致，只保留语法字符的微弱着色
    { tag: t.strong, color: 'var(--ink)' },
    { tag: t.emphasis, color: 'var(--ink)' },
    { tag: t.strikethrough, color: 'var(--ink)' },
    { tag: t.link, color: 'var(--accent)' },
    { tag: t.url, color: 'var(--accent)' },
    { tag: t.monospace, color: 'var(--ink)' },
    { tag: t.processingInstruction, color: 'var(--ink)' },
    { tag: t.quote, color: 'var(--ink)' },
    { tag: t.meta, color: 'var(--ink-3)' },
    { tag: t.atom, color: 'var(--warning)' },
    { tag: t.bool, color: 'var(--warning)' },
    { tag: t.number, color: 'var(--warning)' },
    { tag: t.string, color: 'var(--ok)' },
    { tag: t.keyword, color: 'var(--accent)' },
    { tag: t.comment, color: 'var(--ink-3)' },
    { tag: t.name, color: 'var(--accent-2)' },
    { tag: t.invalid, color: 'var(--danger)' }
  ])
)

let raf = 0

function createView(): void {
  if (!hostEl.value) return
  const content = files.current?.content ?? ''
  view = new EditorView({
    parent: hostEl.value,
    state: EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        basicSetup,
        markdown({ base: markdownLanguage }),
        EditorView.lineWrapping,
        cmTheme,
        mdHighlight,
        cmPlaceholder('在此开始写作…（输入 # 创建标题）'),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void files.save()
              return true
            }
          }
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppress) {
            cancelAnimationFrame(raf)
            raf = requestAnimationFrame(() => {
              files.setContent(view?.state.doc.toString() ?? '')
            })
          }
          if (update.selectionSet || update.docChanged) {
            const state = view!.state
            const head = state.selection.main.head
            const line = state.doc.lineAt(head)
            ui.cursor = { line: line.number, col: head - line.from + 1 }
            if (ui.typewriterMode && update.selectionSet) {
              cancelAnimationFrame(raf)
              raf = requestAnimationFrame(() => {
                if (!view) return
                view.dispatch({
                  effects: EditorView.scrollIntoView(view.state.selection.main, { y: 'center' })
                })
              })
            }
          }
        })
      ]
    })
  })
}

// ── 外部内容变化（草稿恢复 / 模式切换）──
watch(
  () => files.current?.content,
  (c) => {
    if (!view || c == null) return
    if (c !== view.state.doc.toString()) {
      suppress = true
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: c },
        selection: { anchor: Math.min(view.state.selection.main.head, c.length) }
      })
      suppress = false
    }
  }
)

// ── 工具栏格式命令 ──
function applyFullDoc(res: FormatResult): void {
  if (!view) return
  suppress = true
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: res.text },
    selection: { anchor: res.start, head: res.end }
  })
  suppress = false
  view.focus()
}

watch(
  () => ui.formatCmd,
  (cmd) => {
    if (!cmd || !view) return
    const { state } = view
    const doc = state.doc.toString()
    const sel = { start: state.selection.main.from, end: state.selection.main.to }
    switch (cmd.action) {
      case 'undo':
        undo(view)
        return
      case 'redo':
        redo(view)
        return
      case 'bold':
      case 'italic':
      case 'strike':
      case 'inlineCode':
      case 'math':
        applyFullDoc(wrapInline(doc, sel, cmd.action))
        return
      case 'ul':
      case 'ol':
      case 'task':
      case 'quote':
        applyFullDoc(toggleLinePrefix(doc, sel, cmd.action))
        return
      case 'heading':
        applyFullDoc(toggleHeading(doc, sel, 2))
        return
      case 'codeBlock':
      case 'table':
      case 'hr':
      case 'link':
      case 'image': {
        const insert = sel.start === sel.end
        const res = blockAction(insert ? doc : doc.slice(sel.start, sel.end), { start: 0, end: insert ? 0 : sel.end - sel.start }, cmd.action)
        if (insert) {
          applyFullDoc({
            text: doc.slice(0, sel.start) + res.text + doc.slice(sel.end),
            start: res.start,
            end: res.end
          })
        } else {
          applyFullDoc({
            text: doc.slice(0, sel.start) + res.text + doc.slice(sel.end),
            start: sel.start + res.start,
            end: sel.start + res.end
          })
        }
        return
      }
    }
  }
)

// ── 搜索 ──
watch(
  () => ui.findTick,
  () => {
    if (view) openSearchPanel(view)
  }
)

onMounted(createView)
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="hostEl" class="cm-host h-full overflow-hidden" />
</template>
