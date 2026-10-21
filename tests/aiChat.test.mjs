// ─── AI 对话：消息组装 / 截断 / 面板状态机 / 插入事务 / Markdown 渲染模型 ────────
//
// 纯函数 + 假 editor，不连 Electron、不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AI_MAX_INPUT_CHARS, buildAiMessages, sanitizeChatHistory } from '../src/shared/ai.ts'
import {
  AI_CHAT_MAX_MESSAGES,
  chatHistory,
  composeChatTurn,
  initialChatPhase,
  reduceChatPhase,
  trimChatMessages
} from '../src/shared/aiChat.ts'
import { insertMarkdownAtCursor } from '../src/renderer/src/lib/aiInsert.ts'
import { parseAiInline, parseAiMarkdown } from '../src/renderer/src/lib/aiMarkdown.ts'

// ── ① 消息组装 / 截断 ────────────────────────────────────────────────────────
test('上限：会话最多 100 条（用户口径），常量唯一', () => {
  assert.equal(AI_CHAT_MAX_MESSAGES, 100)
})

test('组装：没有上下文时正文就是问题本身（逐字）', () => {
  const out = composeChatTurn({ question: '  总结一下  ' })
  assert.equal(out.text, '总结一下')
  assert.equal(out.sentChars, out.text.length)
  assert.equal(out.truncated, false)
  assert.equal(out.documentChars, 0)
  assert.equal(out.selectionChars, 0)
})

test('组装：勾选文档 / 选区时正文带包装块，且都在问题之前', () => {
  const out = composeChatTurn({
    question: '它们有什么不同？',
    document: '# 文档\n\nDOC-MARKER',
    selection: 'SEL-MARKER'
  })
  assert.ok(out.text.includes('<document>\n# 文档\n\nDOC-MARKER\n</document>'))
  assert.ok(out.text.includes('<selection>\nSEL-MARKER\n</selection>'))
  assert.ok(out.text.endsWith('它们有什么不同？'), '最后一条必须是用户问题')
  assert.equal(out.documentChars, '# 文档\n\nDOC-MARKER'.length)
  assert.equal(out.selectionChars, 'SEL-MARKER'.length)
  assert.equal(out.truncated, false)
})

test('截断：文档 20000 字符 → 总正文 <= 12000，问题完整保留在末尾', () => {
  const doc = 'A'.repeat(20000)
  const question = '请总结这篇文档'
  const out = composeChatTurn({ question, document: doc })
  assert.equal(out.truncated, true)
  assert.ok(out.sentChars <= AI_MAX_INPUT_CHARS, `发送了 ${out.sentChars}`)
  assert.equal(out.sentChars, out.text.length)
  assert.ok(out.documentTruncated)
  assert.ok(out.documentSentChars < doc.length)
  assert.ok(out.text.endsWith(question), '文档再长也不能把问题挤掉')
  assert.equal(out.originalChars, doc.length + 2 + question.length)
})

test('截断：问题本身超限时只截问题（上下文整块放弃）', () => {
  const question = 'Q'.repeat(AI_MAX_INPUT_CHARS + 500)
  const out = composeChatTurn({ question, document: 'DOC-MARKER' })
  assert.equal(out.truncated, true)
  assert.ok(out.sentChars <= AI_MAX_INPUT_CHARS)
  assert.ok(!out.text.includes('DOC-MARKER'))
  assert.ok(out.documentTruncated)
})

test('截断：未超限时逐字原样（含空白段落），不额外改写', () => {
  const doc = '# T\n\n' + 'x'.repeat(100)
  const selection = '  sel  '
  const question = 'q'
  const out = composeChatTurn({ question, document: doc, selection })
  assert.equal(out.truncated, false)
  assert.ok(out.text.includes(doc))
  assert.ok(out.text.includes(selection))
})

test('历史：trimChatMessages 只保留最近 100 条，且不改原数组', () => {
  const all = Array.from({ length: 130 }, (_, i) => i)
  const kept = trimChatMessages(all)
  assert.equal(kept.length, 100)
  assert.equal(kept[0], 30)
  assert.equal(kept[99], 129)
  assert.equal(all.length, 130)
})

test('历史：chatHistory 丢掉空内容，保留被停止的半截回答', () => {
  const history = chatHistory([
    { role: 'user', content: '问题一' },
    { role: 'assistant', content: '半截回答' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: '' }
  ])
  assert.deepEqual(history, [
    { role: 'user', content: '问题一' },
    { role: 'assistant', content: '半截回答' }
  ])
})

test('历史清洗：非法角色 / 空串被丢弃，超过条数与字符预算时从最旧的丢', () => {
  const raw = [
    { role: 'system', content: '不该进来' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
    null
  ]
  const out = sanitizeChatHistory(raw, 2, 1000)
  assert.deepEqual(
    out.map((m) => m.content),
    ['second', 'third']
  )
  const chars = sanitizeChatHistory(
    [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) }
    ],
    20,
    250
  )
  assert.deepEqual(
    chars.map((m) => m.content[0]),
    ['b', 'c']
  )
})

test('prompt：chat 分支 = system + 历史 + 当前问题（最后一条是原样正文）', () => {
  const messages = buildAiMessages({
    kind: 'chat',
    text: '当前问题',
    history: [
      { role: 'user', content: '上一问' },
      { role: 'assistant', content: '上一答' }
    ],
    language: 'zh-CN'
  })
  assert.equal(messages[0].role, 'system')
  assert.deepEqual(messages.slice(1), [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
    { role: 'user', content: '当前问题' }
  ])
})

// ── ② 面板状态机 ─────────────────────────────────────────────────────────────
test('状态机：idle → starting → streaming → idle / error；非法事件保持原状态', () => {
  const idle = initialChatPhase()
  assert.deepEqual(idle, { phase: 'idle', errorCode: null, errorStatus: null })

  const starting = reduceChatPhase(idle, 'send')
  assert.equal(starting.phase, 'starting')

  const streaming = reduceChatPhase(starting, 'delta')
  assert.equal(streaming.phase, 'streaming')

  assert.equal(reduceChatPhase(streaming, 'delta').phase, 'streaming')
  assert.equal(reduceChatPhase(streaming, 'done').phase, 'idle')
  assert.equal(reduceChatPhase(streaming, 'abort').phase, 'idle')

  const errored = reduceChatPhase(streaming, 'error', { code: 'rate-limited', status: 429 })
  assert.deepEqual(errored, { phase: 'error', errorCode: 'rate-limited', errorStatus: 429 })

  // 生成中重复点发送 / 收 delta 不会把状态打回 starting
  assert.equal(reduceChatPhase(streaming, 'send').phase, 'streaming')
  // 出错后可以重试
  assert.equal(reduceChatPhase(errored, 'retry').phase, 'starting')
  // 新对话清零
  assert.deepEqual(reduceChatPhase(errored, 'new'), idle)
  // idle 下收到 delta 不改变
  assert.deepEqual(reduceChatPhase(idle, 'delta'), idle)
})

// ── ③ 插入事务 ───────────────────────────────────────────────────────────────
function fakeEditor({ parser = null, parserThrows = false } = {}) {
  const calls = { paste: [], dispatch: 0, insertText: [], focus: 0 }
  const editor = {
    storage: {
      markdown: {
        parser: parser
          ? {
              parse(text) {
                if (parserThrows) throw new Error('bad markdown')
                return `<p>${text}</p>`
              }
            }
          : undefined
      }
    },
    state: {
      selection: { from: 7 },
      tr: {
        insertText(text, from) {
          calls.insertText.push({ text, from })
          return { kind: 'tr' }
        }
      }
    },
    view: {
      pasteHTML(html) {
        calls.paste.push(html)
      },
      dispatch() {
        calls.dispatch += 1
      }
    },
    commands: {
      focus() {
        calls.focus += 1
        return true
      }
    }
  }
  return { editor, calls }
}

test('插入事务：有 Markdown parser 时走 pasteHTML（单事务），绕开被 Markdown 扩展截走的 insertContent', () => {
  const { editor, calls } = fakeEditor({ parser: true })
  const ok = insertMarkdownAtCursor(editor, '## 标题\n\n- 一\n- 二')
  assert.equal(ok, true)
  assert.equal(calls.paste.length, 1, '必须只提交一次插入，否则一次 Ctrl+Z 撤不干净')
  assert.equal(calls.dispatch, 0, '不应再额外 dispatch 第二个事务')
  assert.ok(calls.paste[0].includes('## 标题'))
})

test('插入事务：parser 缺失或抛错时退回 tr.insertText，且只 dispatch 一次', () => {
  for (const opts of [{ parser: false }, { parser: true, parserThrows: true }]) {
    const { editor, calls } = fakeEditor(opts)
    const ok = insertMarkdownAtCursor(editor, '**答案**')
    assert.equal(ok, true)
    assert.equal(calls.dispatch, 1)
    assert.equal(calls.paste.length, 0)
    assert.deepEqual(calls.insertText, [{ text: '**答案**', from: 7 }])
  }
})

test('插入事务：空文本不动文档（不产生空撤销步）', () => {
  const { editor, calls } = fakeEditor({ parser: true })
  assert.equal(insertMarkdownAtCursor(editor, '   '), false)
  assert.equal(calls.paste.length, 0)
  assert.equal(calls.dispatch, 0)
})

// ── ④ Markdown 渲染模型 ────────────────────────────────────────────────────
test('Markdown：段落 / 标题 / 列表 / 代码块（未闭合围栏也算代码）', () => {
  const blocks = parseAiMarkdown(
    ['## 标题', '', '一段话', '', '- 一', '- 二', '', '```js', 'const a = 1', '```'].join('\n')
  )
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'paragraph', 'list', 'code']
  )
  const list = blocks.find((b) => b.type === 'list')
  assert.deepEqual(list.items, ['一', '二'])
  const code = blocks.find((b) => b.type === 'code')
  assert.equal(code.lang, 'js')
  assert.equal(code.code, 'const a = 1')

  // 流式时围栏还没闭合：剩余内容都当代码块，不闪解析错误
  const open = parseAiMarkdown('说明\n\n```ts\nconst b = 2')
  assert.equal(open.at(-1).type, 'code')
  assert.equal(open.at(-1).code, 'const b = 2')
})

test('Markdown：行内 code / strong / em / del；未闭合标记按普通文本', () => {
  const tokens = parseAiInline('前 `code` **粗** *斜* ~~删~~ 后 $x^2$')
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'del', 'text']
  )
  assert.equal(tokens.find((t) => t.kind === 'code').text, 'code')
  const text = tokens.map((t) => t.text).join('')
  assert.ok(text.includes('$x^2$'), '公式至少按纯文本原样显示')
  assert.deepEqual(parseAiInline('**没闭合'), [{ kind: 'text', text: '**没闭合' }])
})
