import { defineStore } from 'pinia'
import type { Editor } from '@tiptap/core'
import i18n from '../i18n'
import { useEditorStore } from './editor'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'
import { getMarkdown } from '../lib/editor/markdownStorage'
import { readSelectionMarkdown } from '../lib/aiSelection'
import { insertMarkdownAtCursor } from '../lib/aiInsert'
import {
  composeChatTurn,
  reduceChatPhase,
  trimChatMessages,
  chatHistory,
  type AiChatEvent,
  type AiChatPhase,
  type ChatTurnResult
} from '../../../shared/aiChat'
import {
  AI_ERROR_KEY,
  type AiChatTurn,
  type AiErrorCode,
  type AiMenuKind,
  type AiPanelKind,
  type AiStatus,
  type AiStreamEvent
} from '../../../shared/ai'
import {
  aiMenuPreset,
  buildAiMenuPrompt,
  pickAiMenuSource,
  type AiMenuSource
} from '../../../shared/aiMenu'

/**
 * AI 面板的会话状态（摘要 / 改写 / 右侧对话共用一套 store）。
 *
 * 三条不变量（与主进程的分工）：
 *   1. **不自动改文档**：流式只写消息内容，编辑器只在用户点「插入/替换」后动一次；
 *   2. **插入是单事务**：`insertMarkdownAtCursor` 只 dispatch 一个事务，Ctrl+Z 一步还原；
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

/** 右侧对话面板里的一条消息（只活在内存里；不落库）。 */
export interface ChatUiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'streaming' | 'done' | 'error' | 'stopped'
  errorCode?: AiErrorCode
  errorStatus?: number | null
  /** 用户消息保存的重试快照（含组装后的正文与会话历史） */
  request?: { text: string; history: AiChatTurn[] }
  /** 本轮上下文统计（截断提示用） */
  stats?: ChatTurnResult
}

// 捕获的编辑器位置与 doc 不放进响应式 state（ProseMirror Node 不该被 Vue 代理）
let captured: CapturedTarget | null = null
let listenerInstalled = false

/**
 * 右键「AI」子菜单这一轮的替换目标（普通变量，理由同上：doc 不能被 Vue 代理）。
 * `chatReplaceAvailable` 只是给 UI 看的布尔；真正的 from/to/doc 在这里。
 */
let menuReplaceTarget: CapturedTarget | null = null

function requireEditor(): Editor | null {
  // Pinia 的 state 经过 UnwrapRef，Editor 的方法在类型上会被剥掉；运行时仍是同一个实例。
  const ed = useEditorStore().instance as unknown as Editor | null
  if (!ed || ed.isDestroyed) return null
  return ed
}

/**
 * 右键 AI 的取文（编辑器 → 纯数据的适配层；判定规则在 `shared/aiMenu.pickAiMenuSource`）：
 * - 选区：沿用 `readSelectionMarkdown`（保留 Markdown 结构），位置就是选区；
 * - 段落：`$from.parent` 的正文 + 该块的内容区间（替换时只替换这一段）；
 * - 全文：`getMarkdown(ed)`；全文不提供替换目标（避免一键换掉整篇）。
 */
function readAiMenuSource(ed: Editor): AiMenuSource {
  const selection = readSelectionMarkdown(ed)
  const { $from } = ed.state.selection
  return pickAiMenuSource({
    selectionText: selection?.text ?? '',
    selectionRange: selection ? { from: selection.from, to: selection.to } : null,
    paragraphText: $from.parent.textContent,
    paragraphRange: { from: $from.start(), to: $from.end() },
    documentText: getMarkdown(ed)
  })
}

function toastError(code: AiErrorCode): void {
  useUiStore().toast(i18n.global.t(AI_ERROR_KEY[code]), 'error')
}

function uid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
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
    baseUrl: '',

    // ── 右侧栏「AI 对话」──────────────────────────────────────────────────────
    /** 面板状态机（idle / starting / streaming / error），转换规则在 shared/aiChat.ts */
    chatPhase: 'idle' as AiChatPhase,
    chatErrorCode: null as AiErrorCode | null,
    chatErrorStatus: null as number | null,
    chatRequestId: null as string | null,
    /** 当前正在追加 delta 的助手消息 id */
    chatActiveId: null as string | null,
    /** 用户在 `ai:stream` 返回 requestId 之前就点了停止（拿到 id 后补一次 abort） */
    chatStopRequested: false,
    /** 当前会话（最多 100 条；纯内存，不落库） */
    chatMessages: [] as ChatUiMessage[],
    chatInput: '',
    /** 上下文开关：默认只附选区、不附全文（首次打开时按设置初始化一次） */
    chatIncludeDocument: false,
    chatIncludeSelection: true,
    chatContextInitialized: false,
    chatDocChars: 0,
    chatSelectionChars: 0,
    /** 最近一次发送的上下文统计（面板显示截断提示） */
    chatLastStats: null as ChatTurnResult | null,
    /**
     * 右键 AI 子菜单发起的那一轮：结果可以「替换选区 / 替换段落」（单事务、可撤销）。
     * 值为 true 时，最后一条回答的气泡上会出现替换按钮。
     */
    chatReplaceAvailable: false,
    chatReplaceKind: null as AiMenuKind | null
  }),
  getters: {
    chatBusy(state): boolean {
      return state.chatPhase === 'starting' || state.chatPhase === 'streaming'
    },
    lastChatAssistant(state): ChatUiMessage | null {
      for (let i = state.chatMessages.length - 1; i >= 0; i--) {
        if (state.chatMessages[i].role === 'assistant') return state.chatMessages[i]
      }
      return null
    },
    lastChatUserIndex(state): number {
      for (let i = state.chatMessages.length - 1; i >= 0; i--) {
        if (state.chatMessages[i].role === 'user') return i
      }
      return -1
    },
    canChatRetry(state): boolean {
      const busy = state.chatPhase === 'starting' || state.chatPhase === 'streaming'
      return !busy && state.chatMessages.some((m) => m.role === 'user')
    }
  },
  actions: {
    /** 订阅主进程的流式事件（只装一次；事件里没有 Key） */
    ensureListener(): void {
      if (listenerInstalled) return
      listenerInstalled = true
      window.luminAPI.ai.onEvent((event: AiStreamEvent) => {
        // ① 摘要 / 改写弹层
        if (this.open && this.requestId && event.requestId === this.requestId) {
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
          return
        }
        // ② 右侧对话面板（与弹层各自持有 requestId；主进程同一窗口只允许一条在飞）
        if (this.chatRequestId && event.requestId === this.chatRequestId) {
          this.applyChatEvent(event)
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
    },

    // ── 右侧栏「AI 对话」──────────────────────────────────────────────────────

    /**
     * 打开右侧栏的 AI 标签页（菜单 / 命令面板 / 工具栏共用）。
     * 右侧栏沿用「大纲放在编辑区右侧」的那一栏：没打开三栏时先打开它。
     */
    openChat(): void {
      this.ensureListener()
      const settings = useSettingsStore()
      const ui = useUiStore()
      if (!settings.outlineOnRight) settings.set('outlineOnRight', true)
      if (!settings.outlineRightExpanded) settings.set('outlineRightExpanded', true)
      ui.rightTab = 'ai'
      if (!this.chatContextInitialized) {
        this.chatIncludeDocument = settings.aiContextDefault === 'document'
        this.chatIncludeSelection = settings.aiContextDefault !== 'document'
        this.chatContextInitialized = true
      }
      void this.refreshStatus()
      this.refreshChatCounts()
    },

    /**
     * 右键「AI」子菜单的统一入口（优化 / 续写 / 美化 / 理解 / 总结）。
     *
     * 取文口径（用户口径）：**选区 → 当前段落 → 全文**，取到哪一级就用哪一级；
     * 然后把固定指令 + 正文拼成这一轮的问题，**打开右侧栏并自动发送**。
     * 结果只落在对话气泡里；文档改动要等用户点「插入到文档 / 替换选区」。
     *
     * 未配置 Key：照样打开右侧栏（显示既有的引导卡「去设置」），再发一条错误通知 ——
     * 用户不用猜"为什么点了没反应"。
     */
    async askFromMenu(kind: AiMenuKind): Promise<boolean> {
      const preset = aiMenuPreset(kind)
      if (!preset) return false
      this.ensureListener()
      const ed = requireEditor()
      if (!ed) {
        useUiStore().toast(i18n.global.t(AI_ERROR_KEY['no-editor']), 'error')
        return false
      }
      const status = await this.refreshStatus()
      this.openChat()
      if (!status?.hasKey) {
        // 引导卡由 AiChatPanel 按 hasKey 渲染，按钮直达设置页（复用既有逻辑）
        useUiStore().toast(i18n.global.t(AI_ERROR_KEY['missing-key']), 'error')
        return false
      }
      const source = readAiMenuSource(ed)
      if (!source.text.trim()) {
        useUiStore().toast(i18n.global.t(AI_ERROR_KEY['no-selection']), 'error')
        return false
      }
      const prompt = buildAiMenuPrompt(kind, source.text, (key) => i18n.global.t(key))
      if (!prompt) return false
      this.chatInput = prompt
      // 正文已经拼进问题里了：不要再把选区/全文作为上下文附一遍（否则同一段发两次）
      this.chatIncludeDocument = false
      this.chatIncludeSelection = false
      // 续写是"接着写"：替换目标落在来源末尾；其余动作替换来源本身。
      // 来源是全文时不给替换目标（避免一键把整篇文档换掉）。
      const target =
        source.kind === 'document'
          ? null
          : {
              from: kind === 'continue' ? source.to : source.from,
              to: kind === 'continue' ? source.to : source.to,
              doc: ed.state.doc
            }
      menuReplaceTarget = target
      this.chatReplaceAvailable = !!target
      this.chatReplaceKind = kind
      await this.chatSend(true)
      return true
    },

    /**
     * 右键 AI 的结果 → 替换来源区间（**一个事务**，Ctrl+Z 一步还原）。
     * 与改写弹层的 replaceSelection 同一口径；文档在生成期间被改过就拒绝写入。
     */
    replaceChatAnswer(id: string): void {
      const ed = requireEditor()
      const msg = this.chatMessages.find((m) => m.id === id)
      if (!ed || !msg || !msg.content.trim() || !menuReplaceTarget) {
        useUiStore().toast(i18n.global.t(AI_ERROR_KEY['no-selection']), 'error')
        return
      }
      if (ed.state.doc !== menuReplaceTarget.doc) {
        useUiStore().toast(i18n.global.t(AI_ERROR_KEY['document-changed']), 'error')
        return
      }
      const { from, to } = menuReplaceTarget
      const size = ed.state.doc.content.size
      if (from < 0 || to < from || to > size) {
        useUiStore().toast(i18n.global.t(AI_ERROR_KEY['document-changed']), 'error')
        return
      }
      const text = this.chatReplaceKind === 'continue' ? `\n\n${msg.content.trim()}` : msg.content
      const tr = ed.state.tr.insertText(text, from, to)
      ed.view.dispatch(tr)
      ed.commands.focus()
      menuReplaceTarget = null
      this.chatReplaceAvailable = false
      this.chatReplaceKind = null
      useUiStore().toast(i18n.global.t('ai.chat.replaced'), 'success')
    },

    /** 面板可见时刷新 Key 状态与上下文计数（切回 AI 页、设置关闭后调用） */
    async refreshChat(): Promise<void> {
      this.ensureListener()
      if (!this.chatContextInitialized) {
        const settings = useSettingsStore()
        this.chatIncludeDocument = settings.aiContextDefault === 'document'
        this.chatIncludeSelection = settings.aiContextDefault !== 'document'
        this.chatContextInitialized = true
      }
      await this.refreshStatus()
      this.refreshChatCounts()
    },

    /** 读当前文档/选区的字符数（getMarkdown 有 doc 身份缓存，重复调用不重排） */
    refreshChatCounts(): void {
      const ed = requireEditor()
      if (!ed) {
        this.chatDocChars = 0
        this.chatSelectionChars = 0
        return
      }
      this.chatDocChars = getMarkdown(ed).length
      this.chatSelectionChars = readSelectionMarkdown(ed)?.text.length ?? 0
    },

    setChatIncludeDocument(value: boolean): void {
      this.chatIncludeDocument = value
      this.refreshChatCounts()
    },

    setChatIncludeSelection(value: boolean): void {
      this.chatIncludeSelection = value
      this.refreshChatCounts()
    },

    /** 状态机推进（唯一入口；事件非法时保持原状态） */
    chatTransition(
      event: AiChatEvent,
      payload: { code?: AiErrorCode; status?: number } = {}
    ): void {
      const next = reduceChatPhase(
        { phase: this.chatPhase, errorCode: this.chatErrorCode, errorStatus: this.chatErrorStatus },
        event,
        payload
      )
      this.chatPhase = next.phase
      this.chatErrorCode = next.errorCode
      this.chatErrorStatus = next.errorStatus
    },

    /** 主进程流事件 → store（只处理属于当前对话请求的那些） */
    applyChatEvent(event: AiStreamEvent): void {
      const msg = this.chatMessages.find((m) => m.id === this.chatActiveId) ?? null
      if (event.type === 'delta') {
        if (msg) msg.content += event.delta
        this.chatTransition('delta')
        return
      }
      if (event.type === 'done') {
        if (msg) msg.status = 'done'
        this.chatTransition('done')
        this.chatRequestId = null
        this.chatActiveId = null
        return
      }
      if (event.type === 'aborted') {
        if (msg) msg.status = 'stopped'
        this.chatTransition('abort')
        this.chatRequestId = null
        this.chatActiveId = null
        return
      }
      if (msg) {
        msg.status = 'error'
        msg.errorCode = event.code
        msg.errorStatus = event.status ?? null
      }
      this.chatTransition('error', { code: event.code, status: event.status })
      this.chatRequestId = null
      this.chatActiveId = null
      if (event.code === 'missing-key' || event.code === 'key-unavailable') {
        useUiStore().openSettings('ai')
      }
    },

    /**
     * 发送一条消息。
     *
     * 上下文组装优先级见 `composeChatTurn`：问题永远完整，文档/选区按剩余预算截断。
     * 请求发出前先落地两条消息（用户 + 空的助手），delta 到达时只追加助手那一条。
     */
    async chatSend(preserveReplaceTarget = false): Promise<void> {
      if (this.chatBusy) return
      // 手动发起的对话不带替换目标：否则"替换选区"会落到上一轮右键的来源上，
      // 用户点的是这条回答、改的却是另一段文字。
      if (!preserveReplaceTarget) {
        menuReplaceTarget = null
        this.chatReplaceAvailable = false
        this.chatReplaceKind = null
      }
      const question = this.chatInput.trim()
      if (!question) return
      const status = await this.refreshStatus()
      if (!status?.hasKey) {
        this.chatTransition('send')
        this.chatTransition('error', { code: 'missing-key' })
        return
      }
      const ed = requireEditor()
      if (!ed) {
        this.chatTransition('send')
        this.chatTransition('error', { code: 'no-editor' })
        return
      }
      const documentText = this.chatIncludeDocument ? getMarkdown(ed) : ''
      const selectionText = this.chatIncludeSelection ? (readSelectionMarkdown(ed)?.text ?? '') : ''
      const turn = composeChatTurn({
        question,
        document: documentText,
        selection: selectionText
      })
      if (!turn.text) return
      const history = chatHistory(this.chatMessages)
      const userMessage: ChatUiMessage = {
        id: uid(),
        role: 'user',
        content: question,
        status: 'done',
        request: { text: turn.text, history },
        stats: turn
      }
      const assistantMessage: ChatUiMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        status: 'streaming'
      }
      this.chatMessages = trimChatMessages([...this.chatMessages, userMessage, assistantMessage])
      this.chatInput = ''
      this.chatLastStats = turn
      this.refreshChatCounts()
      this.chatActiveId = assistantMessage.id
      this.chatStopRequested = false
      this.chatTransition('send')
      await this.startChatRequest({ text: turn.text, history }, assistantMessage.id, turn)
    },

    /** 真正发 IPC + 落地 requestId（send / retry 共用） */
    async startChatRequest(
      request: { text: string; history: AiChatTurn[] },
      assistantId: string,
      turn?: ChatTurnResult
    ): Promise<void> {
      this.chatRequestId = null
      const result = await window.luminAPI.ai.stream({
        kind: 'chat',
        text: request.text,
        history: request.history
      })
      const assistant = this.chatMessages.find((m) => m.id === assistantId)
      if (!result.ok) {
        this.chatStopRequested = false
        if (assistant) {
          assistant.status = 'error'
          assistant.errorCode = result.code
        }
        this.chatTransition('error', { code: result.code })
        this.chatActiveId = null
        if (result.code === 'missing-key' || result.code === 'key-unavailable') {
          useUiStore().openSettings('ai')
        }
        return
      }
      // 用户在 IPC 返回 requestId 之前就点了停止：补一次 abort（否则界面停了、服务端还在跑）
      if (this.chatStopRequested) {
        this.chatStopRequested = false
        try {
          await window.luminAPI.ai.abort(result.requestId)
        } catch {
          /* 已经结束 */
        }
        if (assistant) assistant.status = 'stopped'
        this.chatActiveId = null
        this.chatTransition('abort')
        return
      }
      // 主进程拿到的是**已经按上下文预算截断过**的正文，所以它的 originalChars/truncated
      // 只反映"第二道闸"；对话面板的统计必须以渲染层这一轮的组装结果为准（取并集）。
      const merged = turn
        ? {
            ...turn,
            sentChars:
              result.sentChars > 0 ? Math.min(turn.sentChars, result.sentChars) : turn.sentChars,
            originalChars: Math.max(turn.originalChars, result.originalChars),
            truncated: turn.truncated || result.truncated
          }
        : undefined
      if (assistant) assistant.stats = merged
      if (merged) this.chatLastStats = merged
      this.chatRequestId = result.requestId
      this.chatTransition('delta')
    },

    /** 停止生成：立刻释放 UI（服务端由主进程 abort 断开，假服务器能看到 client closed） */
    async chatStop(): Promise<void> {
      const id = this.chatRequestId
      this.chatStopRequested = true
      this.chatRequestId = null
      this.chatActiveId = null
      const msg = this.lastChatAssistant
      if (msg && msg.status === 'streaming') {
        msg.status = 'stopped'
      }
      this.chatTransition('abort')
      if (id) {
        try {
          await window.luminAPI.ai.abort(id)
        } catch {
          /* 请求可能已经结束 */
        }
      }
    },

    /**
     * 重试上一条：保留那条用户消息，删掉它之后的所有消息（失败的助手回答），
     * 用**当时保存的请求快照**重放（上下文不会因为现在换了选区而漂移）。
     */
    async chatRetry(): Promise<void> {
      if (this.chatBusy) return
      const index = this.lastChatUserIndex
      if (index < 0) return
      const userMessage = this.chatMessages[index]
      // ⚠️ 快照在响应式 state 里会变成 Proxy，直接传 IPC 会报
      // "An object could not be cloned."。重试前必须摊平成普通对象。
      const request = userMessage.request
        ? {
            text: String(userMessage.request.text),
            history: userMessage.request.history.map((h) => ({ role: h.role, content: h.content }))
          }
        : {
            text: userMessage.content,
            history: chatHistory(this.chatMessages.slice(0, index))
          }
      this.chatMessages = trimChatMessages(this.chatMessages.slice(0, index + 1))
      const assistantMessage: ChatUiMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        status: 'streaming'
      }
      this.chatMessages = trimChatMessages([...this.chatMessages, assistantMessage])
      this.chatActiveId = assistantMessage.id
      this.chatStopRequested = false
      this.chatTransition('retry')
      await this.startChatRequest(request, assistantMessage.id, userMessage.stats)
    },

    /** 新对话：清空消息与输入，**保留上下文开关**（用户口径） */
    newChat(): void {
      if (this.chatBusy) void this.chatStop()
      this.chatMessages = []
      this.chatInput = ''
      this.chatLastStats = null
      menuReplaceTarget = null
      this.chatReplaceAvailable = false
      this.chatReplaceKind = null
      this.chatActiveId = null
      this.chatRequestId = null
      this.chatStopRequested = false
      this.chatTransition('new')
      this.chatErrorCode = null
      this.chatErrorStatus = null
    },

    async copyChatMessage(id: string): Promise<void> {
      const msg = this.chatMessages.find((m) => m.id === id)
      if (!msg || !msg.content) return
      try {
        await navigator.clipboard.writeText(msg.content)
        useUiStore().toast(i18n.global.t('ai.chat.copied'), 'success')
      } catch {
        useUiStore().toast(i18n.global.t('ai.copyFailed'), 'error')
      }
    },

    /** 把某条回答以 Markdown 插入到光标处（单事务；一次 Ctrl+Z 可撤销） */
    insertChatMessage(id: string): void {
      const ed = requireEditor()
      const msg = this.chatMessages.find((m) => m.id === id)
      if (!ed || !msg || !msg.content.trim()) {
        useUiStore().toast(i18n.global.t('ai.chat.insertFailed'), 'error')
        return
      }
      const ok = insertMarkdownAtCursor(ed, msg.content)
      if (ok) useUiStore().toast(i18n.global.t('ai.chat.inserted'), 'success')
      else useUiStore().toast(i18n.global.t('ai.chat.insertFailed'), 'error')
    }
  }
})
