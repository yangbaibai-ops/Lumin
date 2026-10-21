// AI 最小可用能力的契约表（纯函数 + 本地 HTTP 假服务器，不连外网、不用真实 Key）。
//
// 覆盖：
//   ① 12000 字符上限（按段落回退，实际发送 <= 上限）；
//   ② prompt 组装（正文原样放在最后一条 user 消息里，假服务器才能量到真实字符数）；
//   ③ SSE 解析（分片在行中间、CRLF、[DONE]、finish_reason、{error}）；
//   ④ 错误映射（401/403/429/404/5xx/网络/超时/取消）；
//   ⑤ Key 加密存取（假 safeStorage）：落库无明文、读回可用、密文损坏当无 Key；
//   ⑥ 行级 diff（改写预览用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  AI_ERROR_KEY,
  AI_MAX_INPUT_CHARS,
  AI_TIMEOUT_MS,
  SseParser,
  buildAiMessages,
  mapHttpStatus,
  mapThrownError,
  parseSseDelta,
  truncateForModel
} from '../src/shared/ai.ts'
import { AI_KEY_KV, createAiKeyStore } from '../src/shared/aiKey.ts'
import { diffLines } from '../src/shared/aiDiff.ts'
import { streamChatCompletion, testAiConnection } from '../src/main/services/aiCore.ts'

test('上限与超时是常量：12000 字符 / 60 秒', () => {
  assert.equal(AI_MAX_INPUT_CHARS, 12000)
  assert.equal(AI_TIMEOUT_MS, 60000)
})

// ── ① 截断 ──────────────────────────────────────────────────────────────────
test('截断：20000 字符 → 实际发送 <= 12000，且标记 truncated', () => {
  const text = 'a'.repeat(20000)
  const out = truncateForModel(text)
  assert.equal(out.truncated, true)
  assert.equal(out.originalChars, 20000)
  assert.ok(out.sentChars <= AI_MAX_INPUT_CHARS, `发送了 ${out.sentChars}，超过上限`)
  assert.equal(out.sentChars, AI_MAX_INPUT_CHARS)
  assert.equal(out.text.length, out.sentChars)
})

test('截断：按段落回退，不会把半句话硬切在最末尾', () => {
  const block = '段落内容'.repeat(30) // 120 字符（含中文，按 JS 字符计）
  const text = Array.from({ length: 200 }, (_, i) => `${block}${i}`).join('\n\n')
  const out = truncateForModel(text)
  assert.equal(out.truncated, true)
  assert.ok(out.sentChars <= AI_MAX_INPUT_CHARS)
  assert.ok(out.sentChars > AI_MAX_INPUT_CHARS * 0.65, '回退不能丢掉太多内容')
  assert.ok(!out.text.endsWith('段'), '截断点应在段落边界（不是句子中间）')
})

test('截断：未超限时原样返回（含空白），不改一个字符', () => {
  const text = '  hello\n\nworld  \n'
  const out = truncateForModel(text)
  assert.equal(out.truncated, false)
  assert.equal(out.text, text)
  assert.equal(out.originalChars, text.length)
})

// ── ② prompt ────────────────────────────────────────────────────────────────
test('prompt：摘要最后一条是原样正文；改写把指令放进 system', () => {
  const text = '# 标题\n\n正文'
  const summary = buildAiMessages({ kind: 'summarize', text, language: 'zh-CN' })
  assert.equal(summary.length, 2)
  assert.equal(summary[0].role, 'system')
  assert.equal(summary[1].role, 'user')
  assert.equal(summary[1].content, text, '最后一条必须是正文本身（假服务器据此量字符数）')
  assert.match(summary[0].content, /summar/i)

  const rewrite = buildAiMessages({
    kind: 'rewrite',
    text,
    instruction: 'make it shorter',
    language: 'en-US'
  })
  assert.equal(rewrite[1].content, text)
  assert.match(rewrite[0].content, /make it shorter/)
  assert.match(rewrite[0].content, /Markdown/)
})

// ── ③ SSE ──────────────────────────────────────────────────────────────────
test('SSE：分片落在行中间也能拼回完整 data 行', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: {"choices":[{"delta":{"content":"he'), [])
  assert.deepEqual(parser.push('llo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n'), [
    '{"choices":[{"delta":{"content":"hello"}}]}',
    '{"choices":[{"delta":{"content":" world"}}]}'
  ])
  const delta = parseSseDelta('{"choices":[{"delta":{"content":"世界"}}]}')
  assert.equal(delta.delta, '世界')
  assert.equal(delta.done, false)
  assert.equal(parseSseDelta('[DONE]').done, true)
  const finished = parseSseDelta('{"choices":[{"delta":{},"finish_reason":"stop"}]}')
  assert.equal(finished.finished, true)
  assert.equal(finished.delta, '')
})

test('SSE：CRLF、注释心跳、尾部无换行都能处理', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push(': keepalive\r\n\r\n'), [])
  assert.deepEqual(parser.push('data: {"choices":[{"delta":{"content":"x"}}]}\r\n'), [
    '{"choices":[{"delta":{"content":"x"}}]}'
  ])
  assert.deepEqual(parser.push('data: [DONE]'), [])
  assert.deepEqual(parser.flush(), ['[DONE]'])
})

test('SSE：非法 JSON 与 {error} 分别映射 bad-response / server-error', () => {
  assert.throws(() => parseSseDelta('not-json'), (e) => e.code === 'bad-response')
  assert.throws(
    () => parseSseDelta('{"error":{"message":"boom"}}'),
    (e) => e.code === 'server-error'
  )
})

// ── ④ 错误映射 ──────────────────────────────────────────────────────────────
test('错误映射：401/403/429/404/5xx/网络/超时/取消', () => {
  assert.equal(mapHttpStatus(401), 'unauthorized')
  assert.equal(mapHttpStatus(403), 'forbidden')
  assert.equal(mapHttpStatus(429), 'rate-limited')
  assert.equal(mapHttpStatus(404), 'not-found')
  assert.equal(mapHttpStatus(500), 'server-error')
  assert.equal(mapHttpStatus(418), 'http')
  assert.equal(mapThrownError(new TypeError('fetch failed')), 'network')
  assert.equal(mapThrownError(new Error('x'), { timedOut: true }), 'timeout')
  assert.equal(mapThrownError(new Error('x'), { aborted: true }), 'aborted')
  assert.equal(mapThrownError(Object.assign(new Error('x'), { name: 'AbortError' })), 'aborted')
  assert.equal(mapThrownError(new Error('x')), 'http')
  // 每个错误码都有三语键（键集合由 i18n 测试守住）
  for (const code of Object.keys(AI_ERROR_KEY)) {
    assert.match(AI_ERROR_KEY[code], /^ai\.error\./, `${code} 缺文案键`)
  }
})

// ── ⑤ Key 加密存取（假 safeStorage）─────────────────────────────────────────
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    // 不是真加密，只保证"密文 != 明文"且可逆（模拟 DPAPI 的行为边界）
    encryptString: (plain) => Buffer.from('enc:' + plain.split('').reverse().join(''), 'utf8'),
    decryptString: (buf) => {
      const text = buf.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad cipher')
      return text.slice(4).split('').reverse().join('')
    }
  }
}

function memoryKv() {
  const map = new Map()
  return {
    map,
    get: (key, fallback) => (map.has(key) ? JSON.parse(map.get(key)) : fallback),
    set: (key, value) => map.set(key, JSON.stringify(value)),
    delete: (key) => map.delete(key)
  }
}

test('Key：落库是 safeStorage 密文，明文不出现在 kv 里', () => {
  const kv = memoryKv()
  const store = createAiKeyStore(fakeSafeStorage(), kv)
  assert.deepEqual(store.status(), { hasKey: false, updatedAt: null, scheme: null })
  const saved = store.save('sk-test-secret')
  assert.equal(saved.ok, true)
  assert.equal(store.load(), 'sk-test-secret')
  const raw = kv.map.get(AI_KEY_KV)
  assert.ok(raw, 'kv 里应有记录')
  assert.ok(!raw.includes('sk-test-secret'), 'kv 里不得出现明文 Key')
  const record = JSON.parse(raw)
  assert.equal(record.alg, 'safeStorage')
  assert.equal(record.v, 1)
  assert.ok(typeof record.data === 'string' && record.data.length > 0)
  assert.deepEqual(store.status(), {
    hasKey: true,
    updatedAt: record.updatedAt,
    scheme: 'safeStorage'
  })
  store.clear()
  assert.equal(store.load(), null)
  assert.equal(kv.map.has(AI_KEY_KV), false)
})

test('Key：safeStorage 不可用时拒绝保存（绝不退化成明文）', () => {
  const kv = memoryKv()
  const store = createAiKeyStore(fakeSafeStorage(false), kv)
  assert.deepEqual(store.save('sk-test'), { ok: false, code: 'key-unavailable' })
  assert.equal(kv.map.has(AI_KEY_KV), false)
  // 已有密文但存储不可用：读回来当"没有 Key"
  assert.equal(store.load(), null)
})

test('Key：密文损坏/空 Key 都不会崩，也不会回显', () => {
  const kv = memoryKv()
  const store = createAiKeyStore(fakeSafeStorage(), kv)
  assert.deepEqual(store.save('   '), { ok: false, code: 'empty-key' })
  kv.set(AI_KEY_KV, { v: 1, alg: 'safeStorage', data: 'bm90LWEtdmFsaWQ=', updatedAt: 1 })
  assert.equal(store.load(), null)
  assert.equal(store.status().hasKey, true, '记录存在即 hasKey（但解不开时 load 为 null）')
})

// ── ⑥ diff ─────────────────────────────────────────────────────────────────
test('diff：相同行保留、改动行分到 del/add', () => {
  const rows = diffLines('a\nb\nc', 'a\nB\nc')
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.text}`),
    ['same:a', 'del:b', 'add:B', 'same:c']
  )
})

// ── 本地假服务器：流式 / 取消 / 状态码 / 测试连接 ────────────────────────────
function startFakeServer() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '')
      requests.push({ url: req.url, body, auth })
      if (req.url === '/v1/models') {
        if (auth.includes('sk-401')) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end('{"error":{"message":"bad key"}}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"data":[{"id":"gpt-4o-mini"}]}')
        return
      }
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end('{}')
        return
      }
      if (auth.includes('sk-401')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"bad key"}}')
        return
      }
      if (auth.includes('sk-429')) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"rate limited"}}')
        return
      }
      if (auth.includes('sk-500')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"boom"}}')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const chunks = ['Hello', ' ', 'world']
      let i = 0
      const tick = () => {
        if (i >= chunks.length) {
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`
        )
        i += 1
        setTimeout(tick, 5)
      }
      tick()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

test('端到端（假服务器）：SSE 三段增量拼成完整文本，正文 <= 12000', async () => {
  const fake = await startFakeServer()
  try {
    const text = 'x'.repeat(20000)
    const truncated = truncateForModel(text)
    const deltas = []
    const messages = buildAiMessages({ kind: 'summarize', text: truncated.text })
    const out = await streamChatCompletion(
      {
        baseUrl: fake.baseUrl,
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        messages
      },
      (d) => deltas.push(d)
    )
    assert.equal(out, 'Hello world')
    assert.deepEqual(deltas, ['Hello', ' ', 'world'])
    const body = JSON.parse(fake.requests.at(-1).body)
    assert.equal(body.stream, true)
    assert.equal(body.messages.at(-1).content.length, AI_MAX_INPUT_CHARS)
    assert.ok(body.messages.at(-1).content.length <= 12000)
    assert.equal(fake.requests.at(-1).auth, 'Bearer sk-test')
  } finally {
    await fake.close()
  }
})

test('端到端（假服务器）：401/429/500 映射成对应错误码', async () => {
  const fake = await startFakeServer()
  try {
    for (const [key, code] of [
      ['sk-401', 'unauthorized'],
      ['sk-429', 'rate-limited'],
      ['sk-500', 'server-error']
    ]) {
      await assert.rejects(
        streamChatCompletion(
          {
            baseUrl: fake.baseUrl,
            apiKey: key,
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }]
          },
          () => {}
        ),
        (e) => e.code === code
      )
    }
  } finally {
    await fake.close()
  }
})

test('端到端（假服务器）：AbortSignal 取消后抛 aborted', async () => {
  const fake = await startFakeServer()
  try {
    const controller = new AbortController()
    const promise = streamChatCompletion(
      {
        baseUrl: fake.baseUrl,
        apiKey: 'sk-test',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      },
      () => controller.abort()
    )
    await assert.rejects(promise, (e) => e.code === 'aborted')
  } finally {
    await fake.close()
  }
})

test('测试连接：/models 200 成功；401 映射 unauthorized', async () => {
  const fake = await startFakeServer()
  try {
    const ok = await testAiConnection({
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test'
    })
    assert.equal(ok.ok, true)
    assert.ok((ok.latencyMs ?? -1) >= 0)
    const bad = await testAiConnection({
      baseUrl: fake.baseUrl,
      apiKey: 'sk-401'
    })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'unauthorized')
  } finally {
    await fake.close()
  }
})
