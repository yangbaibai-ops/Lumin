// ─── OpenAI 兼容客户端的**网络层**（只在主进程执行）────────────────────────────
//
// 只做三件事：
//   * `POST {base}/chat/completions`（`stream: true`），把 SSE 增量交给回调；
//   * `GET {base}/models`（"测试连接"）；
//   * 把 HTTP / 网络异常翻成 `AiRequestError`（错误码见 shared/ai.ts）。
//
// 刻意不引 openai SDK：fetch + ReadableStream 是 Electron 39（Node 22）自带的，
// 少一个依赖就少一份审计面。API Key 不进任何字符串拼接以外的持久层，也不写日志。
import {
  AiRequestError,
  SseParser,
  assertUsableBaseUrl,
  chatCompletionsUrl,
  mapHttpStatus,
  mapThrownError,
  modelsUrl,
  parseSseDelta,
  type AiChatMessage
} from '../../shared/ai.ts'

export interface StreamChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: AiChatMessage[]
  signal?: AbortSignal
  temperature?: number
  /** 测试注入用；默认全局 fetch */
  fetchImpl?: typeof fetch
}

export interface TestConnectionOptions {
  baseUrl: string
  apiKey: string
  /** 服务端不实现 /models 时用这个模型做一次极小 completion */
  model?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface TestConnectionResult {
  ok: boolean
  /** 失败时的错误码（ok=true 时不存在） */
  code?: ReturnType<typeof mapHttpStatus> | 'network' | 'bad-response' | 'timeout' | 'aborted'
  status?: number
  latencyMs?: number
}

/** 从错误响应里取一个**不含 Key** 的短原因（有的服务会返回 `{error:{message}}`）。 */
function safeErrorText(raw: string): string {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  // 只保留 ASCII 可打印，且截短：错误体是**数据**，可能夹带 HTML，不该原样进界面。
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, 180)
}

async function toRequestError(res: Response): Promise<AiRequestError> {
  const code = mapHttpStatus(res.status)
  let detail = ''
  try {
    detail = safeErrorText(await res.text())
  } catch {
    /* 读不到 body 也没关系：状态码已经足够映射 */
  }
  const err = new AiRequestError(code, res.status)
  if (detail) err.message = detail
  return err
}

/** 从一次性 JSON 响应里取文本（服务端忽略 stream:true 时的兜底）。 */
function textFromJson(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const rec = payload as Record<string, unknown>
  const choices = Array.isArray(rec.choices) ? rec.choices : []
  const first = choices[0] as Record<string, unknown> | undefined
  if (!first) return ''
  const message = (first.message ?? {}) as Record<string, unknown>
  const raw = message.content ?? first.text ?? ''
  return typeof raw === 'string' ? raw : ''
}

/**
 * 流式生成。返回完整文本（调用方通常不依赖返回值，但单测/取消路径需要）。
 * 抛出的异常一律是 `AiRequestError` 或 `AbortError`。
 */
export async function streamChatCompletion(
  opts: StreamChatOptions,
  onDelta: (delta: string) => void
): Promise<string> {
  const base = assertUsableBaseUrl(opts.baseUrl)
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = chatCompletionsUrl(base)
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${opts.apiKey}`
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: opts.temperature
      }),
      signal: opts.signal
    })
  } catch (err) {
    throw new AiRequestError(mapThrownError(err, { aborted: opts.signal?.aborted }))
  }
  if (!res.ok) throw await toRequestError(res)
  if (!res.body) throw new AiRequestError('bad-response')

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  // 少数代理/本地服务会无视 stream:true，直接回一份 JSON：解析后当成一段 delta。
  if (contentType.includes('application/json')) {
    try {
      const json = (await res.json()) as unknown
      const text = textFromJson(json)
      if (text) onDelta(text)
      return text
    } catch (err) {
      if (err instanceof AiRequestError) throw err
      throw new AiRequestError('bad-response')
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      for (const data of parser.push(chunk)) {
        const parsed = parseSseDelta(data)
        if (parsed.done) {
          try {
            await reader.cancel()
          } catch {
            /* 已经结束的流取消失败可忽略 */
          }
          return out
        }
        if (parsed.delta) {
          out += parsed.delta
          onDelta(parsed.delta)
        }
      }
    }
    const tail = decoder.decode()
    for (const data of [...parser.push(tail), ...parser.flush()]) {
      const parsed = parseSseDelta(data)
      if (parsed.done) return out
      if (parsed.delta) {
        out += parsed.delta
        onDelta(parsed.delta)
      }
    }
    return out
  } catch (err) {
    if (err instanceof AiRequestError) throw err
    throw new AiRequestError(mapThrownError(err, { aborted: opts.signal?.aborted }))
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 忽略 */
    }
  }
}

/** 「测试连接」：`GET /models`，只验证 Key/Base URL 是否可用。 */
export async function testAiConnection(opts: TestConnectionOptions): Promise<TestConnectionResult> {
  const startedAt = Date.now()
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = assertUsableBaseUrl(opts.baseUrl)
  try {
    const res = await fetchImpl(modelsUrl(base), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      signal: opts.signal
    })
    if (res.ok) return { ok: true, latencyMs: Date.now() - startedAt }
    // 有些兼容服务不实现 /models：再做一次极小 completion，避免"能用却报错"。
    if (res.status === 404 || res.status === 405) {
      const tiny = await fetchImpl(chatCompletionsUrl(base), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${opts.apiKey}`
        },
        body: JSON.stringify({
          model: opts.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }),
        signal: opts.signal
      })
      if (tiny.ok) return { ok: true, latencyMs: Date.now() - startedAt }
      return { ok: false, code: mapHttpStatus(tiny.status), status: tiny.status }
    }
    return { ok: false, code: mapHttpStatus(res.status), status: res.status }
  } catch (err) {
    return {
      ok: false,
      code: mapThrownError(err, { aborted: opts.signal?.aborted }) as TestConnectionResult['code']
    }
  }
}
