// ─── AI 能力：纯数据与纯函数（主进程 / 渲染层 / 单测共用）─────────────────────
//
// 这一层**不碰网络、不碰 electron、不碰 i18n**：
//   * 字符上限与「按段落截断」的判据只有这一份（12000 字符）；
//   * prompt 组装只有这一份（渲染层不拼 prompt，避免两套口径）；
//   * SSE 解析 / 错误映射是纯函数，`tests/ai.test.mjs` 直接跑；
//   * 错误码到文案键的映射在这里，主进程只返回**码**，渲染层按当前语言翻译。
//
// 真正的网络请求只在 `src/main/services/aiCore.ts`（由主进程调用）。

/** 送给模型的**正文字符**上限（不含 prompt 里的固定指令）。 */
export const AI_MAX_INPUT_CHARS = 12000
/** 请求超时（毫秒）：整个流从发出到结束。 */
export const AI_TIMEOUT_MS = 60_000
/** 「测试连接」的超时（毫秒）：只需要一次握手。 */
export const AI_TEST_TIMEOUT_MS = 20_000
/** 请求里的 temperature：摘要/润色都要稳定，不要发散。 */
export const AI_TEMPERATURE = 0.3

export const AI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const AI_DEFAULT_MODEL = 'gpt-4o-mini'

/**
 * Base URL 预设。`label` 是品牌名（三种语言下都这么写，不进语言包）；
 * `baseUrl` 必须含 `/v1`（OpenAI 兼容接口的约定），自定义项由用户自己填。
 */
export interface AiProviderPreset {
  id: string
  /** 下拉项文案的 i18n 键（品牌名也走语言包：中文里叫「通义千问」，英文里叫 Qwen） */
  labelKey: string
  baseUrl: string
}

export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  { id: 'openai', labelKey: 'ai.providers.openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', labelKey: 'ai.providers.deepseek', baseUrl: 'https://api.deepseek.com/v1' },
  {
    id: 'qwen',
    labelKey: 'ai.providers.qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  { id: 'moonshot', labelKey: 'ai.providers.moonshot', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'ollama', labelKey: 'ai.providers.ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'custom', labelKey: 'ai.providers.custom', baseUrl: '' }
]

/** 归一化 Base URL：去空白与末尾斜杠；不合法（不是 http/https）返回 null。 */
export function normalizeBaseUrl(raw: unknown): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return value.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** 模型名：去空白；空串 = 未设置（调用方按默认值兜底）。 */
export function normalizeModel(raw: unknown): string {
  return String(raw ?? '').trim()
}

/** 一次请求的两种能力（最小可用：不做 Agent / 多步）。 */
export type AiRequestKind = 'summarize' | 'rewrite'
/** 面板的两种形态（摘要面板叫 summary；发给主进程时映射成 summarize） */
export type AiPanelKind = 'summary' | 'rewrite'

export interface AiStreamRequest {
  kind: AiRequestKind
  text: string
  /** 仅 rewrite 使用：用户的改写指令（默认「润色，保持 Markdown 结构」） */
  instruction?: string
}

export interface AiTruncateResult {
  /** 真正送给模型的正文（长度恒 <= AI_MAX_INPUT_CHARS） */
  text: string
  /** 原文是否被截断 */
  truncated: boolean
  /** 原文的字符数 */
  originalChars: number
  /** 实际发送的字符数 */
  sentChars: number
}

/**
 * 按**段落**截断（不会在句子/单词中间硬切，除非整段都超限）。
 *
 * 规则：
 *  1. 没超限 → 原样返回；
 *  2. 超限 → 先取前 `max` 字符，再从末尾往回找最近的一个段落边界（空行）；
 *     找不到就找换行；都没有就硬切到 `max`；
 *  3. 结果长度恒 <= max，且尽量落在段落边界上。
 */
export function truncateForModel(
  input: string,
  max: number = AI_MAX_INPUT_CHARS
): AiTruncateResult {
  const original = String(input ?? '')
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : AI_MAX_INPUT_CHARS
  if (original.length <= cap) {
    return {
      text: original,
      truncated: false,
      originalChars: original.length,
      sentChars: original.length
    }
  }
  let cut = original.slice(0, cap)
  // 只在「丢掉的不超过 35%」时按段落回退：否则剩下的内容太少，不如尽量多带一点。
  const floor = Math.floor(cap * 0.65)
  const para = cut.lastIndexOf('\n\n')
  if (para >= floor) {
    cut = cut.slice(0, para)
  } else {
    const line = cut.lastIndexOf('\n')
    if (line >= floor) cut = cut.slice(0, line)
  }
  // 截断点可能落在空白上：去掉尾部空白（但不改变"未超限原样返回"的分支）
  cut = cut.replace(/\s+$/, '')
  return {
    text: cut,
    truncated: true,
    originalChars: original.length,
    sentChars: cut.length
  }
}

export interface AiChatMessage {
  role: 'system' | 'user'
  content: string
}

// ─── IPC 负载（主进程 ⇄ 渲染层；**任何一条都不含 Key**）──────────────────────

/** `ai:status` 的返回值：只有这三个字段，没有明文/密文 Key。 */
export interface AiStatus {
  hasKey: boolean
  model: string
  baseUrl: string
}

export type AiKeySaveOutcome =
  { ok: true; status: AiStatus } | { ok: false; code: 'empty-key' | 'key-unavailable' }

export type AiStreamStart =
  | {
      ok: true
      requestId: string
      /** 实际送给模型的**正文字符数**（<= AI_MAX_INPUT_CHARS） */
      sentChars: number
      originalChars: number
      /** 是否发生截断（UI 要显示「已截断」） */
      truncated: boolean
    }
  | { ok: false; code: AiErrorCode }

export type AiStreamEvent =
  | { requestId: string; type: 'delta'; delta: string }
  | { requestId: string; type: 'done'; chars: number }
  | { requestId: string; type: 'aborted' }
  | { requestId: string; type: 'error'; code: AiErrorCode; status?: number }

export type AiTestResult =
  { ok: true; latencyMs: number } | { ok: false; code: AiErrorCode; status?: number }

const SUMMARY_SYSTEM = [
  'You are a careful document summarizer.',
  "Summarize the user's Markdown document.",
  'Write a concise summary in the same language as the document.',
  'Use Markdown bullet points when helpful.',
  'Output only the summary, with no preamble and no closing remarks.'
].join(' ')

const REWRITE_SYSTEM = [
  'You are a precise Markdown editor.',
  "Rewrite the user's Markdown text according to the instruction.",
  'Preserve the Markdown structure unless the instruction explicitly asks to change it.',
  'Keep the original language. Return only the rewritten text, with no preamble.'
].join(' ')

/**
 * `AiChatMessage[]` 的末尾一条**恒为**用户的正文（原样、已截断）。
 * 这样单测与假服务器都能量到"实际发送的正文长度"，不必在 prompt 里找标记。
 */
export function buildAiMessages(req: {
  kind: AiRequestKind
  text: string
  instruction?: string
  language?: string
}): AiChatMessage[] {
  const langHint =
    req.language && req.language.trim()
      ? ` The interface language is ${req.language.trim()}; keep the document's own language.`
      : ''
  if (req.kind === 'summarize') {
    return [
      { role: 'system', content: SUMMARY_SYSTEM + langHint },
      { role: 'user', content: req.text }
    ]
  }
  const instruction =
    String(req.instruction ?? '').trim() || 'Polish the text and keep the Markdown structure.'
  return [
    { role: 'system', content: `${REWRITE_SYSTEM} Instruction: ${instruction}${langHint}` },
    { role: 'user', content: req.text }
  ]
}

/** 端点拼接：Base URL 已归一化，这里只补路径。 */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl) ?? AI_DEFAULT_BASE_URL}/chat/completions`
}

export function modelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl) ?? AI_DEFAULT_BASE_URL}/models`
}

// ─── SSE 解析 ────────────────────────────────────────────────────────────────

/**
 * `text/event-stream` 的**行级**解析器（OpenAI 兼容接口只需处理 `data:` 行）。
 *
 * 关键点：网络分片不保证按行到达 —— 一次 `reader.read()` 可能只拿到半行。
 * 所以内部留一个 buffer，`push()` 只返回**完整行**；流结束时再 `flush()` 一次。
 */
export class SseParser {
  private buffer = ''

  push(chunk: string): string[] {
    if (!chunk) return []
    this.buffer += chunk
    const out: string[] = []
    let at = this.buffer.indexOf('\n')
    while (at >= 0) {
      let line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.acceptLine(line, out)
      at = this.buffer.indexOf('\n')
    }
    return out
  }

  /** 流结束：把没有换行结尾的最后一行也交出去 */
  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
    if (!rest) return []
    const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest
    const out: string[] = []
    this.acceptLine(line, out)
    return out
  }

  private acceptLine(line: string, out: string[]): void {
    // 空行 = 事件分隔；注释行（`:` 开头，常被用作心跳）忽略
    if (!line || line.startsWith(':')) return
    if (!line.startsWith('data:')) return
    // `data:` 与值之间可能有一个空格，也可能没有
    const value = line.slice(5)
    out.push(value.startsWith(' ') ? value.slice(1) : value)
  }
}

export interface AiSseDelta {
  /** 本段增量文本（可能为空串：有些服务会发只带 role/finish_reason 的块） */
  delta: string
  /** 服务端明确给出结束标记（`finish_reason` 非空） */
  finished: boolean
  /** `[DONE]` 哨兵 */
  done: boolean
}

/**
 * 从一行 `data:` 负载里取增量。兼容三种主流形状：
 *   * `choices[0].delta.content`（OpenAI/DeepSeek/通义/Moonshot）；
 *   * `choices[0].message.content`（某些代理把流退化成一次性响应）；
 *   * `choices[0].text`（旧 completion 风格）。
 * `{ error: … }` 视为服务端错误（由调用方映射）。
 */
export function parseSseDelta(payload: string): AiSseDelta {
  const raw = String(payload ?? '').trim()
  if (!raw) return { delta: '', finished: false, done: false }
  if (raw === '[DONE]') return { delta: '', finished: true, done: true }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new AiRequestError('bad-response')
  }
  if (!obj || typeof obj !== 'object') return { delta: '', finished: false, done: false }
  const rec = obj as Record<string, unknown>
  if (rec.error) throw new AiRequestError('server-error')
  const choices = Array.isArray(rec.choices) ? rec.choices : []
  const first = choices[0] as Record<string, unknown> | undefined
  if (!first) return { delta: '', finished: false, done: false }
  const deltaObj = (first.delta ?? {}) as Record<string, unknown>
  const messageObj = (first.message ?? {}) as Record<string, unknown>
  const rawDelta = deltaObj.content ?? messageObj.content ?? first.text ?? ''
  return {
    delta: typeof rawDelta === 'string' ? rawDelta : '',
    finished: first.finish_reason != null && first.finish_reason !== '',
    done: false
  }
}

// ─── 错误映射 ────────────────────────────────────────────────────────────────

export type AiErrorCode =
  | 'missing-key'
  | 'empty-key'
  | 'key-unavailable'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'not-found'
  | 'server-error'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'bad-response'
  | 'no-editor'
  | 'no-selection'
  | 'document-changed'
  | 'invalid-base-url'

/** 错误码 → i18n 键（**唯一映射**；渲染层只查这张表，不自己拼 `ai.error.${code}`）。 */
export const AI_ERROR_KEY: Record<AiErrorCode, string> = {
  'missing-key': 'ai.error.missingKey',
  'empty-key': 'ai.error.emptyKey',
  'key-unavailable': 'ai.error.keyUnavailable',
  unauthorized: 'ai.error.unauthorized',
  forbidden: 'ai.error.forbidden',
  'rate-limited': 'ai.error.rateLimited',
  'not-found': 'ai.error.notFound',
  'server-error': 'ai.error.serverError',
  network: 'ai.error.network',
  timeout: 'ai.error.timeout',
  aborted: 'ai.error.aborted',
  http: 'ai.error.http',
  'bad-response': 'ai.error.badResponse',
  'no-editor': 'ai.error.noEditor',
  'no-selection': 'ai.error.noSelection',
  'document-changed': 'ai.error.documentChanged',
  'invalid-base-url': 'ai.error.invalidBaseUrl'
}

/** HTTP 状态码 → 错误码（401/403/429/5xx 分别给人话，其余归 http）。 */
export function mapHttpStatus(status: number): AiErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate-limited'
  if (status === 404) return 'not-found'
  if (status >= 500) return 'server-error'
  return 'http'
}

/** 带错误码的异常（网络层与 SSE 层共用；主进程据此回给渲染层）。 */
export class AiRequestError extends Error {
  readonly code: AiErrorCode
  readonly status?: number

  constructor(code: AiErrorCode, status?: number) {
    super(code)
    this.name = 'AiRequestError'
    this.code = code
    this.status = status
  }
}

/**
 * 把 fetch / 读流抛出的任意异常映射成错误码。
 * `timedOut` 与 `aborted` 由调用方给（AbortController 本身不区分两者）。
 */
export function mapThrownError(
  err: unknown,
  opts: { aborted?: boolean; timedOut?: boolean } = {}
): AiErrorCode {
  if (opts.timedOut) return 'timeout'
  if (opts.aborted) return 'aborted'
  if (err instanceof AiRequestError) return err.code
  if (err instanceof Error && err.name === 'AbortError') return 'aborted'
  if (err instanceof TypeError) return 'network'
  return 'http'
}

/** `/models` 或 `/chat/completions` 的 URL 合法性（避免把任意协议交给 fetch）。 */
export function assertUsableBaseUrl(raw: string): string {
  const base = normalizeBaseUrl(raw)
  if (!base) throw new AiRequestError('invalid-base-url')
  return base
}
