import { defineStore } from 'pinia'
import type { Editor } from '@tiptap/core'
import i18n from '../i18n'
import { useEditorStore } from './editor'
import { useUiStore } from './ui'
import { getMarkdown } from '../lib/editor/markdownStorage'
import { readSelectionMarkdown } from '../lib/aiSelection'
import {
  AI_ERROR_KEY,
  type AiErrorCode,
  type AiPanelKind,
  type AiStatus,
  type AiStreamEvent
} from '../../../shared/ai'

/**
 * AI 面板的会话状态（摘要 / 改写共用一套）。
 *
 * 三条不变量（与主进程的分工）：
 *   1. **不自动改文档**：流式只写 `output`，编辑器只在用户点「插入/替换」后动一次；
 *   2. **替换是单事务**：`intercept` 捕获的 from/to 在确认时用 `tr.insertText` 一次 dispatch，
 *      Ctrl+Z 一步还原；
 *   3. **Key 不在这里**：状态里只有 `hasKey/model/baseUrl`，没有任何 Key 字段。
 */
export type AiPanelPhase =
  'idle' | 'ready' | 'starting' | 'streaming' | 'done' | 'error' | 'aborted'

interface CapturedTarget {
  from: number
  to: number
  /** 捕获时的 doc 身份：确认时不一致就拒绝写入（文档在生成期间被改过） */
  doc: unknown
}

// 捕获的编辑器位置与 doc 不放进响应式 state（ProseMirror Node 不该被 Vue 代理）
let captured: CapturedTarget | null = null
let listenerInstalled = false

function requireEditor(): Editor | null {
  // Pinia 的 state 经过 UnwrapRef，Editor 的方法在类型上会被剥掉；运行时仍是同一个实例。
  const ed = useEditorStore().instance as unknown as Editor | null
  if (!ed || ed.isDestroyed) return null
  return ed
}

function toastError(code: AiErrorCode): void {
  useUiStore().toast(i18n.global.t(AI_ERROR_KEY[code]), 'error')
}

export const useAiStore = defineStore('ai', {
  state: () => ({
    open: false,
    kind: 'summary' as AiPanelKind,
    phase: 'idle' as AiPanelPhase,
    /** 流式/最终的模型输出（预览用；未落进文档） */
    output: '',
    errorCode: null as AiErrorCode | null,
    requestId: null as string | null,
    sourceKind: 'document' as 'document' | 'selection',
    /** 送给模型的原文（已截断后的长度由 sentChars 表示） */
    sourceText: '',
    instruction: '',
    originalChars: 0,
    sentChars: 0,
    truncated: false,
    hasKey: false,
    model: '',
    baseUrl: ''
  }),
  actions: {
    /** 订阅主进程的流式事件（只装一次；事件里没有 Key） */
    ensureListener(): void {
      if (listenerInstalled) return
      listenerInstalled = true
      window.luminAPI.ai.onEvent((event: AiStreamEvent) => {
        if (!this.open || !this.requestId || event.requestId !== this.requestId) return
        if (event.type === 'delta') {
          this.output += event.delta
          this.phase = 'streaming'
          return
        }
        this.requestId = null
        if (event.type === 'done') {
          this.phase = 'done'
          return
        }
        if (event.type === 'aborted') {
          this.phase = 'aborted'
          return
        }
        this.phase = 'error'
        this.errorCode = event.code
        if (event.code === 'missing-key' || event.code === 'key-unavailable') {
          useUiStore().openSettings('ai')
        }
      })
    },

    async refreshStatus(): Promise<AiStatus | null> {
      try {
        const status = await window.luminAPI.ai.status()
        this.hasKey = status.hasKey
        this.model = status.model
        this.baseUrl = status.baseUrl
        return status
      } catch {
        return null
      }
    },

    resetFor(kind: AiPanelKind): void {
      this.kind = kind
      this.phase = 'idle'
      this.output = ''
      this.errorCode = null
      this.requestId = null
      this.originalChars = 0
      this.sentChars = 0
      this.truncated = false
      captured = null
    },

    async openSummary(): Promise<void> {
      this.ensureListener()
      const ed = requireEditor()
      if (!ed) {
        this.open = true
        this.resetFor('summary')
        this.phase = 'error'
        this.errorCode = 'no-editor'
        return
      }
      const status = await this.refreshStatus()
      if (!status?.hasKey) {
        useUiStore().openSettings('ai')
        toastError('missing-key')
        return
      }
      this.open = true
      this.resetFor('summary')
      const selection = readSelectionMarkdown(ed)
      if (selection) {
        this.sourceKind = 'selection'
        this.sourceText = selection.text
        captured = { from: selection.from, to: selection.to, doc: ed.state.doc }
      } else {
        this.sourceKind = 'document'
        this.sourceText = getMarkdown(ed)
        const { from, to } = ed.state.selection
        captured = { from, to, doc: ed.state.doc }
      }
      await this.startStream('summary', this.sourceText)
    },

    async openRewrite(): Promise<void> {
      this.ensureListener()
      const ed = requireEditor()
      if (!ed) {
        this.open = true
        this.resetFor('rewrite')
        this.phase = 'error'
        this.errorCode = 'no-editor'
        return
      }
      const selection = readSelectionMarkdown(ed)
      if (!selection || !selection.text.trim()) {
        toastError('no-selection')
        return
      }
      const status = await this.refreshStatus()
      if (!status?.hasKey) {
        useUiStore().openSettings('ai')
        toastError('missing-key')
        return
      }
      this.open = true
      this.resetFor('rewrite')
      this.sourceKind = 'selection'
      this.sourceText = selection.text
      // 生成前也让头部显示选区字符数（生成后由主进程返回的截断统计覆盖）
      this.originalChars = selection.text.length
      this.sentChars = selection.text.length
      this.instruction = i18n.global.t('ai.defaultInstruction')
      captured = { from: selection.from, to: selection.to, doc: ed.state.doc }
      this.phase = 'ready'
    },

    async startStream(kind: AiPanelKind, text: string): Promise<void> {
      this.kind = kind
      this.phase = 'starting'
      this.output = ''
      this.errorCode = null
      this.requestId = null
      const result = await window.luminAPI.ai.stream({
        kind: kind === 'summary' ? 'summarize' : 'rewrite',
        text,
        instruction: kind === 'rewrite' ? this.instruction : undefined
      })
      if (!result.ok) {
        this.phase = 'error'
        this.errorCode = result.code
        if (result.code === 'missing-key' || result.code === 'key-unavailable') {
          useUiStore().openSettings('ai')
        }
        return
      }
      this.requestId = result.requestId
      this.originalChars = result.originalChars
      this.sentChars = result.sentChars
      this.truncated = result.truncated
      this.phase = 'streaming'
    },

    /** 改写面板的「生成」按钮：用当前输入框里的指令 */
    async generateRewrite(): Promise<void> {
      if (!this.instruction.trim()) return
      await this.startStream('rewrite', this.sourceText)
    },

    async retry(): Promise<void> {
      await this.startStream(this.kind, this.sourceText)
    },

    async cancel(): Promise<void> {
      const id = this.requestId
      this.requestId = null
      this.phase = 'aborted'
      if (id) {
        try {
          await window.luminAPI.ai.abort(id)
        } catch {
          /* 请求可能已经结束：状态已经是"已取消"，不需要再提示 */
        }
      }
    },

    close(): void {
      if (this.requestId) void this.cancel()
      this.open = false
      this.phase = 'idle'
      this.output = ''
      this.errorCode = null
      this.requestId = null
      captured = null
    },

    /**
     * 摘要 → 插入到当前光标处（单事务；不替换任何选中内容）。
     * 只在用户点按钮时调用。
     */
    insertSummaryAtCursor(): void {
      const ed = requireEditor()
      if (!ed || !this.output.trim()) return
      const pos = ed.state.selection.from
      const tr = ed.state.tr.insertText(this.output, pos)
      ed.view.dispatch(tr)
      ed.commands.focus()
      this.close()
    },

    /**
     * 改写 → 替换选区：**一个事务**（`tr.insertText(text, from, to)`）。
     * Ctrl+Z 一步还原（ProseMirror 的 history 按 transaction 记账）。
     */
    replaceSelection(): void {
      const ed = requireEditor()
      if (!ed || !captured || !this.output.trim()) return
      if (ed.state.doc !== captured.doc) {
        this.phase = 'error'
        this.errorCode = 'document-changed'
        return
      }
      const { from, to } = captured
      const size = ed.state.doc.content.size
      if (from < 0 || to < from || to > size) {
        this.phase = 'error'
        this.errorCode = 'document-changed'
        return
      }
      const tr = ed.state.tr.insertText(this.output, from, to)
      ed.view.dispatch(tr)
      ed.commands.focus()
      this.close()
    },

    /** 改写 → 插入到选区下方（同样是单事务；不删除原文） */
    insertBelow(): void {
      const ed = requireEditor()
      if (!ed || !captured || !this.output.trim()) return
      if (ed.state.doc !== captured.doc) {
        this.phase = 'error'
        this.errorCode = 'document-changed'
        return
      }
      const pos = captured.to
      const tr = ed.state.tr.insertText(`\n\n${this.output}`, pos)
      ed.view.dispatch(tr)
      ed.commands.focus()
      this.close()
    },

    async copyOutput(): Promise<void> {
      if (!this.output) return
      try {
        await navigator.clipboard.writeText(this.output)
        useUiStore().toast(i18n.global.t('ai.copied'), 'success')
      } catch {
        useUiStore().toast(i18n.global.t('ai.copyFailed'), 'error')
      }
    }
  }
})
