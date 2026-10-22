// 验收：代码块语言高亮矩阵（清单 §1.B / 自查报告 O3）
//
// 为什么要有这条：本轮把 `@codemirror/language-data`（115 种语言、116 个 import 目标、约 1.6MB）
// 换成**显式 15 项映射表**，省下约 1MB 构建体积 —— 代价是「任意语言高亮」变成「这 15 种」。
// 于是必须逐个证明：这 15 种（含常见别名）**真的还在高亮**，而清单外的语言**如实退化成纯文本**
// （而不是「静默什么都不加载」——那才是真回归）。
//
// 判据取 DOM：CodeMirror 高亮时会把 token 包进 `<span class="ͼ…">`（HighlightStyle 生成的类名），
// 纯文本行则只有 `<div class="cm-line">文字</div>`。两边都要验：正例必须有 span，反例必须没有。
//
// ⚠️ F 项（代码块 CM 虚拟化）之后**只有视口附近的块才挂 CM**：所以本套件对每个围栏
// **逐个滚进视野**再量（否则量到的是一堆静态态，得到「没有高亮」的假失败 —— 实测踩过）。
'use strict'
const { connect, settle, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')

/** [围栏里写的语言标记, 说明] */
const CASES = [
  ['javascript', 'const a = 1'],
  ['js', 'const a = 1'],
  ['typescript', 'const a: number = 1'],
  ['ts', 'const a: number = 1'],
  ['python', 'def f():\n    return 1'],
  ['py', 'def f():\n    return 1'],
  ['html', '<div class="x">hi</div>'],
  ['css', '.a { color: red; }'],
  ['json', '{"a": 1}'],
  ['sql', 'SELECT a FROM t;'],
  ['java', 'class A { int x = 1; }'],
  ['go', 'func main() { }'],
  ['rust', 'fn main() { }'],
  ['cpp', 'int main() { return 0; }'],
  ['c++', 'int main() { return 0; }'],
  ['php', '<?php echo 1;'],
  ['ruby', 'def f\n  1\nend'],
  ['rb', 'def f\n  1\nend'],
  ['bash', 'echo hi'],
  ['sh', 'echo hi'],
  ['yaml', 'a: 1'],
  ['yml', 'a: 1']
]
/** 清单外的语言：必须退化成纯文本（不能因为删了 language-data 就崩或静默停摆） */
const UNKNOWN = [['text', 'just some words here'], ['makefile', 'all:\n\techo hi']]

const md =
  CASES.map(([lang, code]) => `\`\`\`${lang}\n${code}\n\`\`\``).join('\n\n') +
  '\n\n' +
  UNKNOWN.map(([lang, code]) => `\`\`\`${lang}\n${code}\n\`\`\``).join('\n\n') +
  '\n'

/** 每个代码块的高亮状态（按文档顺序） */
const PROBE = `(() => {
  const eds = [...document.querySelectorAll('.cm-editor')]
  return JSON.stringify({
    count: eds.length,
    items: eds.map((e) => {
      const c = e.querySelector('.cm-content')
      const html = c ? c.innerHTML : ''
      return { spans: (html.match(/<span/g) || []).length, text: c ? c.textContent.slice(0, 24) : null }
    })
  })
})()`

/** 单个代码块（按文档顺序的第 idx 个，1-based）的高亮状态 */
const ONE = (idx) => `(() => {
  const b = [...document.querySelectorAll('.code-block-wrapper')][${idx - 1}]
  if (!b) return JSON.stringify({ missing: true })
  const c = b.querySelector('.cm-content')
  const html = c ? c.innerHTML : ''
  return JSON.stringify({
    mounted: !!b.querySelector('.cm-editor'),
    staticState: !!b.querySelector('.cb-static'),
    spans: (html.match(/<span/g) || []).length,
    text: (c ? c.textContent : (b.querySelector('.cb-static-code')?.textContent ?? '')).slice(0, 24)
  })
})()`

/** 把第 idx 个块滚进视野（虚拟化之后只有视口附近的块才挂 CM） */
const SCROLL = (idx) => `(() => {
  const b = [...document.querySelectorAll('.code-block-wrapper')][${idx - 1}]
  if (!b) return 'missing'
  b.scrollIntoView({ block: 'center' })
  return 'ok'
})()`

/**
 * 等第 idx 个块挂上 CM（`wantSpans` 时还要等语言 chunk 到位、出现高亮 span）。
 * 语言是按需 `import()` 的：只等「挂上」会读到一个还没配好语言的空文档（实测踩过 yaml 假失败）。
 */
async function waitMounted(ev, idx, wantSpans) {
  let last = null
  for (let i = 0; i < 40; i++) {
    last = JSON.parse(await ev(ONE(idx)))
    if (last.mounted && (!wantSpans || last.spans > 0)) return last
    await sleep(100)
  }
  return last
}

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('代码块语言高亮（15 种 + 别名 / 清单外退化为纯文本）')

  await openDocWith(app, md, 'cb-languages.md')
  await sleep(1200)

  const expect = CASES.length + UNKNOWN.length
  const blocks = await ev(`document.querySelectorAll('.code-block-wrapper').length`)
  report.note(`文档里共 ${blocks} 个代码块（期望 ${expect}）`)
  report.check(
    'doc-has-all-fixtures',
    blocks === expect,
    `blocks=${blocks} 期望 ${expect}（${CASES.length} 个正例 + ${UNKNOWN.length} 个反例）`
  )

  // 逐个滚进视野再量高亮：虚拟化之后「没滚到」的块是静态态（无 CM、也无语法高亮）
  const missing = []
  const notMounted = []
  for (let i = 1; i <= CASES.length; i++) {
    const [lang] = CASES[i - 1]
    await ev(SCROLL(i))
    const st = await waitMounted(ev, i, true)
    if (!st.mounted) notMounted.push(lang)
    else if (!st.spans) missing.push(`${lang}(spans=0)`)
  }
  report.check(
    'every-case-mounts-when-scrolled-in',
    notMounted.length === 0,
    notMounted.length ? `滚入后仍未挂载：${notMounted.join(', ')}` : `${CASES.length} 个围栏滚入后都挂上了 CM`
  )
  report.check(
    'all-15-languages-plus-aliases-highlight',
    missing.length === 0,
    missing.length ? `没有高亮的：${missing.join(', ')}` : `${CASES.length} 个围栏全部出现高亮 span`
  )

  // 清单外的语言：滚进去也**不该**有高亮 span（如实退化成纯文本，而不是静默不加载）
  const noise = []
  for (let k = 0; k < UNKNOWN.length; k++) {
    const [lang] = UNKNOWN[k]
    const idx = CASES.length + k + 1
    await ev(SCROLL(idx))
    const st = await waitMounted(ev, idx)
    if (!st.mounted) noise.push(`${lang}(未挂载)`)
    else if (st.spans > 0) noise.push(`${lang}(spans=${st.spans})`)
  }
  report.check(
    'unknown-languages-fall-back-to-plain-text',
    noise.length === 0,
    noise.length ? `不该高亮的：${noise.join(', ')}` : `${UNKNOWN.map((u) => u[0]).join(' / ')} 均为纯文本`
  )

  // 反向证据：删掉 language-data 之后**不该**再有那 116 个语言 chunk —— 用语言浮层的项数间接守住。
  // 当前实现（`ee44502` 起）：语言选择器**不在块内布局里**、也不是常驻 `<select>`，而是聚焦时
  // 挂到代码块**外面**的浮层（`[data-cb-lang-picker]`，fixed 定位、v-if）。所以这里先点开浮层、
  // 再按 ArrowDown 展开候选列表，读 `[data-cb-lang-option]` 的值。
  // 预设清单见 `lib/editor/codeBlockLanguage.ts` 的 LANGUAGE_PRESETS：18 项
  // （text/js/ts/vue/python/bash/json/css/html/markdown/sql/go/rust/java/c/cpp/yaml/mermaid）。
  // ⚠️ 必须点**语言为 text 的块**：其余块会把自动识别出的语言（如 javascript）预填进搜索框，
  //    候选会被过滤成空（`javascript` 不是 18 个预设之一）；text 块打开时输入框为空 = 全部预设。
  const textBlockIndex = CASES.length + 1 // UNKNOWN 里第一个就是 text（1-based）
  const opened = JSON.parse(
    await ev(`(async () => {
      const b = document.querySelectorAll('.code-block-wrapper')[${textBlockIndex - 1}]
      if (!b) return JSON.stringify({ err: 'no-block' })
      b.scrollIntoView({ block: 'center' })
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 300))
      // ⚠️ 必须取**这个块自己的**浮层：打开文档时首块可能已因焦点自动打开一个，
      //    全局 querySelector 会拿到它（预填 javascript ⇒ 候选被过滤成空）。
      const picker = b.querySelector('[data-cb-lang-picker]')
      if (!picker) return JSON.stringify({ err: 'no-picker' })
      const input = picker.querySelector('[data-cb-lang-input]')
      if (!input) return JSON.stringify({ err: 'no-input' })
      const owner = [...document.querySelectorAll('.code-block-wrapper')].indexOf(b)
      input.focus()
      input.select()
      return JSON.stringify({ mounted: true, owner, inputValue: input.value })
    })()`)
  )
  // 用输入事件逐个验证 18 个预设都能在浮层里被检索到。
  // （合成 KeyboardEvent/真实 CDP 按键在本环境里会被 PM 抢走焦点；`input` 事件是
  //   Vue `@input` 的直接入口，与用户打字走同一条 `onPickerInput` 路径。）
  const picker = JSON.parse(
    await ev(`(async () => {
      const b = document.querySelectorAll('.code-block-wrapper')[${textBlockIndex - 1}]
      const picker = b ? b.querySelector('[data-cb-lang-picker]') : null
      if (!picker) return JSON.stringify({ err: 'picker-closed' })
      const input = picker.querySelector('[data-cb-lang-input]')
      if (!input) return JSON.stringify({ err: 'no-input' })
      const presets = ['text','js','ts','vue','python','bash','json','css','html','markdown','sql','go','rust','java','c','cpp','yaml','mermaid']
      const seen = []
      for (const p of presets) {
        input.value = p
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 30))
        const opts = [...picker.querySelectorAll('[data-cb-lang-option]')].map((o) => o.getAttribute('data-cb-lang-option'))
        if (opts.includes(p)) seen.push(p)
      }
      const pr = picker.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      const overlap = Math.max(0, Math.min(pr.right, br.right) - Math.max(pr.left, br.left)) *
        Math.max(0, Math.min(pr.bottom, br.bottom) - Math.max(pr.top, br.top))
      return JSON.stringify({
        position: getComputedStyle(picker).position,
        overlap: Math.round(overlap),
        inputValue: input.value,
        optionCount: picker.querySelectorAll('[data-cb-lang-option]').length,
        seen
      })
    })()`)
  )
  report.note('语言浮层 ' + JSON.stringify({ ...opened, ...picker, seen: picker.seen && picker.seen.length }))
  report.check(
    'language-picker-floats-outside-block',
    opened.mounted === true && picker.position === 'fixed' && picker.overlap === 0,
    JSON.stringify({ position: picker.position, overlap: picker.overlap })
  )
  report.check(
    'language-picker-lists-18-presets',
    Array.isArray(picker.seen) &&
      picker.seen.length === 18 &&
      picker.seen.includes('mermaid') &&
      picker.seen.includes('rust') &&
      picker.seen.includes('cpp'),
    JSON.stringify({ seen: picker.seen, missing: 18 - (picker.seen ? picker.seen.length : 0) })
  )

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
