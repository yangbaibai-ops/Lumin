// ─── AI 服务（主进程唯一入口）────────────────────────────────────────────────
//
// 边界（硬性约束）：
//   * **Key 只在主进程**：用 Electron `safeStorage` 加密后写 db 的 kv（键 `aiApiKey`）；
//     渲染层只能拿到 `{ hasKey, model, baseUrl }`；
//   * **网络只在主进程**：fetch/SSE 在 `aiCore.ts`，这里把 delta 通过 IPC 事件推给窗口；
//   * **不写日志**：本文件没有 console，也没有把 Key 放进任何错误消息；
//   * 请求有 60s 超时 + `AbortController` 取消（用户点「取消」走 `abort`）。
import { safeStorage, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { db } from './database'
import { readSettings } from './appSettings'
import { createAiKeyStore, type AiKeyStore } from '../../shared/aiKey'
import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_MODEL,
  AI_TEMPERATURE,
  AI_TEST_TIMEOUT_MS,
  AI_TIMEOUT_MS,
  buildAiMessages,
  normalizeBaseUrl,
  normalizeModel,
  truncateForModel,
  type AiErrorCode,
  type AiKeySaveOutcome,
  type AiStatus,
  type AiStreamEvent,
  type AiStreamRequest,
  type AiStreamStart,
  type AiTestResult
} from '../../shared/ai'
import { streamChatCompletion, testAiConnection } from './aiCore'

const keyStore: AiKeyStore = createAiKeyStore(
  {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (buf) => safeStorage.decryptString(buf)
  },
  {
    get: (key, fallback) => db.kvGet(key, fallback),
    set: (key, value) => db.kvSet(key, value),
    delete: (key) => db.kvDelete(key)
  }
)

interface ActiveRequest {
  controller: AbortController
  senderId: number
  timedOut: boolean
  abortedByUser: boolean
}

const active = new Map<string, ActiveRequest>()

function statusNow(): AiStatus {
  const settings = readSettings()
  return {
    hasKey: keyStore.status().hasKey,
    model: normalizeModel(settings.aiModel) || AI_DEFAULT_MODEL,
    // 原样回给界面（用户正在编辑的地址）；空/非法时给默认值，界面不会看到 undefined
    baseUrl: String(settings.aiBaseUrl ?? '').trim() || AI_DEFAULT_BASE_URL
  }
}

export function getAiStatus(): AiStatus {
  return statusNow()
}

/** 保存/清除 Key：空串 = 删除。返回值不含明文。 */
export function setAiKey(raw: string): AiKeySaveOutcome {
  if (!String(raw ?? '').trim()) {
    keyStore.clear()
    return { ok: true, status: statusNow() }
  }
  const result = keyStore.save(raw)
  if (!result.ok) return result
  return { ok: true, status: statusNow() }
}

function safeSend(sender: WebContents, event: AiStreamEvent): void {
  try {
    if (!sender.isDestroyed()) sender.send('ai:event', event)
  } catch {
    /* 窗口在流式中途关闭：停止推送即可 */
  }
}

/** 「测试连接」：/models（服务端不实现时回退一次极小 completion）。 */
export async function testAi(): Promise<AiTestResult> {
  const settings = readSettings()
  const apiKey = keyStore.load()
  if (!apiKey) return { ok: false, code: 'missing-key' }
  const baseUrl = normalizeBaseUrl(settings.aiBaseUrl) ?? AI_DEFAULT_BASE_URL
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, AI_TEST_TIMEOUT_MS)
  try {
    const result = await testAiConnection({
      baseUrl,
      apiKey,
      model: normalizeModel(settings.aiModel) || AI_DEFAULT_MODEL,
      signal: controller.signal
    })
    if (result.ok) return { ok: true, latencyMs: result.latencyMs ?? 0 }
    return {
      ok: false,
      code: timedOut ? 'timeout' : ((result.code ?? 'http') as AiErrorCode),
      status: result.status
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 开一个流。返回得很快（请求 ID + 截断统计），真正的 delta 走 `ai:event`。
 *
 * 为什么不在 invoke 里 await 整条流：渲染层要边收边显示，而 invoke 只能回一次。
 */
export function startAiStream(req: AiStreamRequest, sender: WebContents): AiStreamStart {
  const settings = readSettings()
  const apiKey = keyStore.load()
  if (!apiKey) return { ok: false, code: 'missing-key' }
  const baseUrl = normalizeBaseUrl(settings.aiBaseUrl)
  if (!baseUrl) return { ok: false, code: 'invalid-base-url' }
  const model = normalizeModel(settings.aiModel) || AI_DEFAULT_MODEL
  const kind = req?.kind === 'rewrite' ? 'rewrite' : 'summarize'
  const truncated = truncateForModel(String(req?.text ?? ''))
  if (!truncated.text.trim()) return { ok: false, code: 'no-selection' }

  // 同一窗口只保留一条在飞的请求：新请求开始时把旧的取消（面板本身也只允许一条）
  for (const [id, item] of active) {
    if (item.senderId === sender.id) {
      item.abortedByUser = true
      item.controller.abort()
      active.delete(id)
    }
  }

  const requestId = randomUUID()
  const controller = new AbortController()
  const entry: ActiveRequest = {
    controller,
    senderId: sender.id,
    timedOut: false,
    abortedByUser: false
  }
  active.set(requestId, entry)
  const messages = buildAiMessages({
    kind,
    text: truncated.text,
    instruction: req?.instruction,
    language: settings.language
  })

  // 让出这一轮 IPC：先让 invoke 把 requestId 交回渲染层，再开始推 delta
  // （否则首个 delta 可能早于渲染层登记 requestId 到达，被当成"陌生事件"丢掉）。
  setImmediate(() => {
    const timer = setTimeout(() => {
      entry.timedOut = true
      controller.abort()
    }, AI_TIMEOUT_MS)
    const send = (event: AiStreamEvent): void => safeSend(sender, event)
    void (async () => {
      try {
        await streamChatCompletion(
          {
            baseUrl,
            apiKey,
            model,
            messages,
            signal: controller.signal,
            temperature: AI_TEMPERATURE
          },
          (delta) => send({ requestId, type: 'delta', delta })
        )
        if (entry.abortedByUser) return
        send({ requestId, type: 'done', chars: truncated.sentChars })
      } catch (err) {
        if (entry.abortedByUser) {
          send({ requestId, type: 'aborted' })
          return
        }
        const code: AiErrorCode = entry.timedOut
          ? 'timeout'
          : err instanceof Error && err.name === 'AbortError'
            ? 'aborted'
            : ((err as { code?: AiErrorCode })?.code ?? 'http')
        send({ requestId, type: 'error', code })
      } finally {
        clearTimeout(timer)
        if (active.get(requestId) === entry) active.delete(requestId)
      }
    })()
  })

  return {
    ok: true,
    requestId,
    sentChars: truncated.sentChars,
    originalChars: truncated.originalChars,
    truncated: truncated.truncated
  }
}

/** 取消：只允许发起请求的那个窗口取消（别的窗口拿不到它的 requestId 也取消不了）。 */
export function abortAiStream(requestId: string, sender: WebContents): boolean {
  const entry = active.get(requestId)
  if (!entry || entry.senderId !== sender.id) return false
  entry.abortedByUser = true
  entry.controller.abort()
  active.delete(requestId)
  return true
}

/** 测试用：当前在飞请求数（不含 Key/正文） */
export function activeAiRequests(): number {
  return active.size
}
