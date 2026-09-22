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

  // 反向证据：删掉 language-data 之后**不该**再有那 116 个语言 chunk —— 用选择框里的项数间接守住
  // （选项仍是 16 项：15 种语言 + mermaid；清单外语言只能靠手写围栏标记，界面不提供）
  const options = JSON.parse(
    await ev(`(() => JSON.stringify({
      langs: [...document.querySelectorAll('.code-block-select')[0].querySelectorAll('option')].map((o) => o.value)
    }))()`)
  )
  report.check(
    'language-picker-still-lists-16',
    options.langs.length === 16 && options.langs.includes('mermaid') && options.langs.includes('ruby'),
    JSON.stringify(options.langs)
  )

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
