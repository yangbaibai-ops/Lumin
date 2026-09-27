// ─── 首次引导（审计 §7「首次引导 / 示例文档：无」）────────────────────────────
//
// 这一轮补的就是这条缺口：侧栏文件区在"没有任何工作区"时是一片空白（用户口径，
// 刻意删掉了入口按钮与提示），于是**第一次打开软件的人没有任何可点的东西**。
// 现在它只在一个很窄的空态里长出一块引导块，判据是纯函数
// `shouldShowOnboarding`（`src/renderer/src/lib/onboarding.ts`）。
//
// 为什么判据必须被单测钉死：它同时要满足两件互相拉扯的事 ——
//   * 第一次打开软件（没有工作区 + 一份谁都还没动过的空白未命名缓冲）**看得见**；
//   * 用户一旦真的开始干活（打开文件夹 / 写出一个字 / 文档落到磁盘路径上）**立刻消失**。
// 判错了两种表现都很糟：永远不出现 = 缺口原地留着；该消失时不消失 = 侧栏里多出一块
// 一直杵在那儿的广告。
//
// 示例文档那一半**逐份读三份语言包**：它是整篇 Markdown（标题、代码、表格、公式），
// 要经过 vue-i18n 的消息编译，所以除了"非空"，还要钉住两件会在运行时才炸的事：
//   ① 块结构完整（能过 markdown 的解析路径）；
//   ② 不带会误触输入规则的裸标记（`[ ] `）与 vue-i18n 的保留字符（`{` `}` `@`）。
//
// 解析用真 `markdown-it`（编辑器同一套解析内核 `tiptap-markdown` 的底层）：这里不去
// 复刻编辑器那几十个扩展的 schema，只验"这份原文本身是结构完整的 Markdown"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import MarkdownIt from 'markdown-it'
import { SAMPLE_DOC_KEY, shouldShowOnboarding } from '../src/renderer/src/lib/onboarding.ts'

const LANGS = ['zh-CN', 'en-US', 'ru-RU']

/** 扁平化语言包：`a.b.c → 值` */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out[key] = v
  }
  return out
}

const packs = LANGS.map((lang) => ({
  lang,
  flat: flatten(
    JSON.parse(readFileSync(new URL(`../src/shared/i18n/${lang}.json`, import.meta.url), 'utf-8'))
  )
}))

const md = new MarkdownIt({ html: true, linkify: true, breaks: false })
const samples = packs.map(({ lang, flat }) => ({ lang, doc: flat[SAMPLE_DOC_KEY] }))
const parsed = samples.map(({ lang, doc }) => ({ lang, doc, tokens: md.parse(doc ?? '', {}) }))

// ─── 判据：什么时候显示 ────────────────────────────────────────────────────────

test('没有任何工作区、也没有文档 → 显示', () => {
  assert.equal(shouldShowOnboarding({ root: null, hasDoc: false }), true)
  // 空的 root（'' / undefined）与 null 同义：都表示"没打开文件夹"
  assert.equal(shouldShowOnboarding({ root: undefined, hasDoc: false }), true)
  assert.equal(shouldShowOnboarding({ root: '', hasDoc: false }), true)
})

test('空白未命名缓冲（= 第一次打开软件的样子）→ 显示', () => {
  // main.ts 启动时总会补一份占位缓冲；不认这一条，引导在真实启动路径上永远不出现
  assert.equal(shouldShowOnboarding({ root: null, hasDoc: true, path: null, content: '' }), true)
  assert.equal(
    shouldShowOnboarding({ root: null, hasDoc: true, path: null, content: '\n\n' }),
    true
  )
  assert.equal(
    shouldShowOnboarding({ root: null, hasDoc: true, path: null, content: '   \n\t' }),
    true
  )
})

test('有工作区 → 不显示（这正是"侧栏空着就是空着"那条口径保护的范围）', () => {
  assert.equal(shouldShowOnboarding({ root: 'D:\\ws', hasDoc: false }), false)
  assert.equal(
    shouldShowOnboarding({ root: 'D:\\ws', hasDoc: true, path: null, content: '' }),
    false,
    '有工作区时哪怕缓冲是空白的也不显示'
  )
  assert.equal(
    shouldShowOnboarding({ root: 'D:\\ws', hasDoc: true, path: 'D:\\ws\\a.md', content: '# a' }),
    false
  )
})

test('有文档（落了磁盘路径，或已经写进内容）→ 不显示', () => {
  assert.equal(
    shouldShowOnboarding({ root: null, hasDoc: true, path: 'D:\\a.md', content: '' }),
    false
  )
  assert.equal(
    shouldShowOnboarding({ root: null, hasDoc: true, path: null, content: '刚写下的一个字' }),
    false
  )
  // 未命名但有内容：内容才是判据（空白以外的任何字符都算"开始写了"）
  assert.equal(shouldShowOnboarding({ root: null, hasDoc: true, path: null, content: 'x' }), false)
})

test('缺省的可选字段按"没有文档"处理，不抛错', () => {
  assert.equal(shouldShowOnboarding({ root: null, hasDoc: true }), true)
  assert.equal(shouldShowOnboarding({ root: null, hasDoc: true, path: undefined }), true)
  assert.equal(shouldShowOnboarding({ root: null, hasDoc: true, content: undefined }), true)
})

// ─── 示例文档：三份都真的有内容，且过解析路径 ──────────────────────────────────

test('键名是 onboarding.sampleDoc（组件引用的就是这个常量）', () => {
  assert.equal(SAMPLE_DOC_KEY, 'onboarding.sampleDoc')
})

test('三份语言包里都有示例文档，且都是非空的整篇 Markdown', () => {
  for (const { lang, doc } of samples) {
    assert.equal(typeof doc, 'string', `${lang} 缺 ${SAMPLE_DOC_KEY}`)
    assert.ok(doc.trim().length > 200, `${lang} 的示例太短（${doc.length} 字符），不像一篇演示`)
    assert.ok(doc.includes('\n'), `${lang} 的示例是单行，换行被吃掉了？`)
    assert.ok(/^# /m.test(doc), `${lang} 的示例缺一级标题`)
    assert.ok(/^## /m.test(doc), `${lang} 的示例缺二级标题`)
  }
})

test('示例经过 markdown 解析路径后，块结构完整（不报错、内容不丢）', () => {
  for (const { lang, tokens } of parsed) {
    const types = tokens.map((t) => t.type)
    assert.ok(types.includes('heading_open'), `${lang} 没解析出标题`)
    assert.ok(types.includes('fence'), `${lang} 没解析出代码块`)
    assert.ok(types.includes('blockquote_open'), `${lang} 没解析出引用`)
    assert.ok(types.includes('bullet_list_open'), `${lang} 没解析出列表`)
    assert.ok(types.includes('table_open'), `${lang} 没解析出表格（表格语法没被认出来）`)
    assert.ok(types.length > 40, `${lang} 只解析出 ${types.length} 个 token，示例太薄`)

    // 内容守恒的粗口径：文字型 token（含代码块每一行）拼起来不得比原文短掉一大截
    // —— markdown-it 的静默丢行（嵌套上限之类）会在这里露出来
    const text = tokens
      .filter((t) => t.type === 'inline' || t.type === 'fence')
      .map((t) => t.content)
      .join('\n')
    assert.ok(text.trim().length > 200, `${lang} 解析后的正文只剩 ${text.length} 字符`)
    const headings = tokens.filter((t) => t.type === 'heading_open').length
    assert.ok(headings >= 6, `${lang} 只有 ${headings} 个标题，示例的语法覆盖不够`)
  }
})

test('示例里没有会误触输入规则的裸标记（`[ ] ` 必须带列表标记）', () => {
  for (const { lang, doc } of samples) {
    const bare = doc
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      // `[ ] ` 是任务列表输入规则的触发串：孤零零出现会被编辑器当成"把这一段变成任务列表"
      .filter(({ line }) => /\[[ xX]\]\s/.test(line))
      // 带列表标记（`- [ ]` / `* [x]` / `1. [ ]`）是合法写法，任务列表本来就该这么写
      .filter(({ line }) => !/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line))
    assert.deepEqual(
      bare.map((b) => `${lang}:${b.no} ${b.line}`),
      [],
      `${lang} 的示例里有裸任务标记（会误触输入规则）`
    )
    // 反过来：示例**应当**演示任务列表（带标记的那种），否则漏了最常见的一类写法
    assert.ok(/^\s*[-*+]\s+\[[ xX]\]/m.test(doc), `${lang} 的示例没有演示任务列表（\`- [ ]\`）`)
  }
})

test('示例里没有 vue-i18n 的保留字符（`{` `}` `@`），也没有裸 `|`', () => {
  for (const { lang, doc } of samples) {
    const reserved = [...doc.matchAll(/[{}@]/g)].map((m) => m[0])
    assert.deepEqual(
      reserved,
      [],
      `${lang} 的示例里有 vue-i18n 的保留字符：它要经过消息编译，` +
        '`{…}` 会被当插值、`@` 会被当链接语法，整条消息可能编译失败或变成原始 key'
    )
    const badPipes = doc
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => line.includes('|') && !/^\s*\|.*\|\s*$/.test(line))
    assert.deepEqual(
      badPipes.map((b) => `${lang}:${b.no}`),
      [],
      `${lang} 的示例里有裸 \`|\`（表格行必须以 \`|\` 开头结尾，否则 vue-i18n 会按复数分隔符处理）`
    )
  }
})

test('示例是一份"编辑器里的样例"：开头就是免责声明，另有一句按钮旁的说明文案', () => {
  for (const { lang, doc } of samples) {
    // 顶部第一段就是说明（引用块），别让用户以为磁盘上凭空多了个文件
    assert.ok(doc.startsWith('> '), `${lang} 的示例没有以说明性的引用块开头`)
  }
  // 三个按钮之外那一句"不会写进磁盘"的提示：三份都要有、非空
  for (const { lang, flat } of packs) {
    const note = flat['onboarding.sampleNote']
    assert.equal(typeof note, 'string', `${lang} 缺 onboarding.sampleNote`)
    assert.ok(note.trim().length > 10, `${lang} 的 sampleNote 太短`)
  }
})
