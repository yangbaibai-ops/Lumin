// ─── AI 对话：纯数据与纯函数（渲染层 / 主进程 / 单测共用）────────────────────────
//
// 这一层**不碰 Vue、不碰 electron、不碰 i18n**：
//   * 会话最多保留多少条（100）只有这一份；
//   * 「本轮送给模型的正文」怎么拼、按什么优先级截断只有这一份 —— 当前问题永远完整，
//     文档/选区按剩余预算截断（不会出现"文档太长把问题挤没了"）；
//   * 面板状态机（idle → starting → streaming → error）是一条纯函数，
//     store 只负责把事件喂给它，单测直接把转换表钉死。
//
// 真正的网络请求仍在 `src/main/services/aiCore.ts`；这里没有任何 IO。
import { AI_MAX_INPUT_CHARS, truncateForModel, type AiChatTurn, type AiErrorCode } from './ai.ts'

/** 内存里最多保留的消息条数（用户要求 100；超出丢最旧的）。 */
export const AI_CHAT_MAX_MESSAGES = 100

export type AiChatRole = 'user' | 'assistant'

// ─── 本轮正文组装 ─────────────────────────────────────────────────────────────
//
// 输入 = 用户问题 + 可选的当前文档 / 选区。输出是一段**自包含**的 Markdown：
//
//   <document>
//   …
//   </document>
//
//   <selection>
//   …
//   </selection>
//
//   问题
//
// 主进程再按它自己的 `AI_MAX_INPUT_CHARS` 做最后一道截断（双保险）；这里的预算
// 保证「问题」永远不会被文档挤掉，并把"哪些部分被截了"如实回给界面。

const DOC_OPEN = '<document>\n'
const DOC_CLOSE = '\n</document>'
const SEL_OPEN = '<selection>\n'
const SEL_CLOSE = '\n</selection>'

export interface ChatTurnInput {
  /** 用户这一轮的问题（已 trim；空串时返回空正文） */
  question: string
  /** 勾选「附带当前文档」时的全文 Markdown */
  document?: string
  /** 勾选「附带选区」时的选区 Markdown */
  selection?: string
  /** 正文上限；默认与主进程同一个常量（12000） */
  maxChars?: number
}

export interface ChatTurnResult {
  /** 真正送给模型的正文（长度恒 <= maxChars） */
  text: string
  /** 完整拼接（不截断）时的字符数 */
  originalChars: number
  /** 实际发送的字符数 */
  sentChars: number
  /** 是否有任何部分被截断 */
  truncated: boolean
  /** 原始文档 / 选区的字符数（界面上的计数） */
  documentChars: number
  selectionChars: number
  /** 文档 / 选区实际被送出的字符数（0 = 没带） */
  documentSentChars: number
  selectionSentChars: number
  /** 文档 / 选区是否被截断（界面可分别提示） */
  documentTruncated: boolean
  selectionTruncated: boolean
}

function capOf(max: number | undefined): number {
  return Number.isFinite(max) && (max as number) > 0
    ? Math.floor(max as number)
    : AI_MAX_INPUT_CHARS
}

/**
 * 按「问题优先」的顺序组装本轮正文。
 *
 * 预算算法（全部是字符数）：
 *   1. 问题最多占满整个上限；问题自己就超限时只截问题；
 *   2. 剩余预算先给文档、再给选区；每块预留 `<document>` / `<selection>` 包装的开销；
 *   3. 上下文块内部用 `truncateForModel` 按段落回退（不会半句硬切）；
 *   4. 任一块可用的预算 <= 0 时整块丢弃（并标记 truncated）。
 */
export function composeChatTurn(input: ChatTurnInput): ChatTurnResult {
  const cap = capOf(input.maxChars)
  const question = String(input.question ?? '').trim()
  const document = String(input.document ?? '')
  const selection = String(input.selection ?? '')
  const empty: ChatTurnResult = {
    text: '',
    originalChars: question.length,
    sentChars: 0,
    truncated: false,
    documentChars: document.length,
    selectionChars: selection.length,
    documentSentChars: 0,
    selectionSentChars: 0,
    documentTruncated: false,
    selectionTruncated: false
  }
  if (!question) return empty

  const fullText = [document, selection, question].filter((x) => x.length > 0).join('\n\n')
  const originalChars = fullText.length

  // 问题自己就超限：只留问题（按段落回退），上下文全部放弃。
  if (question.length > cap) {
    const cut = truncateForModel(question, cap)
    return {
      ...empty,
      text: cut.text,
      sentChars: cut.text.length,
      truncated: true,
      documentTruncated: document.length > 0,
      selectionTruncated: selection.length > 0
    }
  }

  // 预留两块之间的两个空行（文档块 + 选区块 + 问题）。
  let remaining = cap - question.length - 4
  let text = question
  let documentSentChars = 0
  let selectionSentChars = 0
  let documentTruncated = false
  let selectionTruncated = false

  if (document.length > 0) {
    const overhead = DOC_OPEN.length + DOC_CLOSE.length
    const room = remaining - overhead
    if (room > 0) {
      const cut = truncateForModel(document, room)
      documentSentChars = cut.text.length
      documentTruncated = cut.truncated
      if (documentSentChars > 0) {
        text = `${DOC_OPEN}${cut.text}${DOC_CLOSE}\n\n${text}`
        remaining -= documentSentChars + overhead + 2
      }
    } else {
      documentTruncated = true
    }
  }

  if (selection.length > 0) {
    const overhead = SEL_OPEN.length + SEL_CLOSE.length
    const room = remaining - overhead - 2
    if (room > 0) {
      const cut = truncateForModel(selection, room)
      selectionSentChars = cut.text.length
      selectionTruncated = cut.truncated
      if (selectionSentChars > 0) {
        text = `${SEL_OPEN}${cut.text}${SEL_CLOSE}\n\n${text}`
      }
    } else {
      selectionTruncated = true
    }
  }

  // 兜底：极端情况下（多字节/包装开销估算偏差）仍要保证不超过上限。
  if (text.length > cap) {
    const cut = truncateForModel(text, cap)
    text = cut.text
  }

  return {
    text,
    originalChars,
    sentChars: text.length,
    truncated: text.length < originalChars,
    documentChars: document.length,
    selectionChars: selection.length,
    documentSentChars,
    selectionSentChars,
    documentTruncated,
    selectionTruncated
  }
}

/**
 * 取对话历史（供主进程组装 messages）。
 *
 * 只保留有内容的 user/assistant 消息；错误占位（没有正文）不进历史，
 * 被停止的**半截回答**保留（它对下一轮仍有意义）。
 */
export function chatHistory(
  messages: readonly { role: AiChatRole; content: string }[]
): AiChatTurn[] {
  const out: AiChatTurn[] = []
  for (const m of messages) {
    const content = String(m.content ?? '').trim()
    if (!content) continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    out.push({ role: m.role, content })
  }
  return out
}

/** 只保留最近 max 条（默认 100）；不改原数组。 */
export function trimChatMessages<T>(messages: readonly T[], max = AI_CHAT_MAX_MESSAGES): T[] {
  const limit = Math.max(1, Math.floor(max))
  return messages.length <= limit ? [...messages] : messages.slice(messages.length - limit)
}

// ─── 面板状态机 ──────────────────────────────────────────────────────────────
//
// 事件来自两处：用户动作（send / stop / retry / new）与主进程流事件
// （delta / done / error）。转换表写死在这里，非法事件一律**保持原状态**
// （例如重复点发送不会把 streaming 打回 starting）。
export type AiChatPhase = 'idle' | 'starting' | 'streaming' | 'error'
export type AiChatEvent = 'send' | 'delta' | 'done' | 'abort' | 'error' | 'retry' | 'new'

export interface AiChatPhaseState {
  phase: AiChatPhase
  errorCode: AiErrorCode | null
  errorStatus: number | null
}

export function initialChatPhase(): AiChatPhaseState {
  return { phase: 'idle', errorCode: null, errorStatus: null }
}

export function reduceChatPhase(
  state: AiChatPhaseState,
  event: AiChatEvent,
  payload: { code?: AiErrorCode; status?: number } = {}
): AiChatPhaseState {
  const { phase } = state
  switch (event) {
    case 'new':
      return initialChatPhase()
    case 'send':
    case 'retry':
      // 只有空闲或出错时能开始新的一轮；正在生成时重复点击不应改变状态。
      return phase === 'idle' || phase === 'error'
        ? { phase: 'starting', errorCode: null, errorStatus: null }
        : state
    case 'delta':
      return phase === 'starting' || phase === 'streaming'
        ? { phase: 'streaming', errorCode: null, errorStatus: null }
        : state
    case 'done':
    case 'abort':
      return phase === 'starting' || phase === 'streaming' ? initialChatPhase() : state
    case 'error':
      return phase === 'starting' || phase === 'streaming'
        ? {
            phase: 'error',
            errorCode: payload.code ?? 'http',
            errorStatus: typeof payload.status === 'number' ? payload.status : null
          }
        : state
    default:
      return state
  }
}
