// 验收：代码块语言高亮矩阵（清单 §1.B / 自查报告 O3）
//
// 为什么要有这条：本轮把 `@codemirror/language-data`（115 种语言、116 个 import 目标、约 1.6MB）
// 换成**显式 15 项映射表**，省下约 1MB 构建体积 —— 代价是「任意语言高亮」变成「这 15 种」。
// 于是必须逐个证明：这 15 种（含常见别名）**真的还在高亮**，而清单外的语言**如实退化成纯文本**
// （而不是「静默什么都不加载」——那才是真回归）。
//
// 判据取 DOM：CodeMirror 高亮时会把 token 包进 `<span class="ͼ…">`（HighlightStyle 生成的类名），
// 纯文本行则只有 `<div class="cm-line">文字</div>`。两边都要验：正例必须有 span，反例必须没有。
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

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('代码块语言高亮（15 种 + 别名 / 清单外退化为纯文本）')

  await openDocWith(app, md, 'cb-languages.md')
  await sleep(1200)

  const expect = CASES.length + UNKNOWN.length
  // 语言 chunk 是**按需 import** 的：轮询到「块数齐了 且 每个正例都出现高亮 span」为止
  let probe = null
  for (let i = 0; i < 100; i++) {
    probe = JSON.parse(await ev(PROBE))
    const positives = probe.items.slice(0, CASES.length)
    if (probe.count >= expect && positives.every((it) => it.spans > 0)) break
    await sleep(150)
  }
  report.note('实测 ' + JSON.stringify(probe))

  report.check(
    'all-code-blocks-mounted',
    !!probe && probe.count === expect,
    `blocks=${probe && probe.count} 期望 ${expect}（${CASES.length} 个正例 + ${UNKNOWN.length} 个反例）`
  )

  const missing = []
  CASES.forEach(([lang], i) => {
    const it = probe.items[i]
    if (!it || it.spans === 0) missing.push(`${lang}(spans=${it ? it.spans : 'n/a'})`)
  })
  report.check(
    'all-15-languages-plus-aliases-highlight',
    missing.length === 0,
    missing.length ? `没有高亮的：${missing.join(', ')}` : `${CASES.length} 个围栏全部出现高亮 span`
  )

  const noise = []
  UNKNOWN.forEach(([lang], k) => {
    const it = probe.items[CASES.length + k]
    if (!it) noise.push(`${lang}(缺块)`)
    else if (it.spans > 0) noise.push(`${lang}(spans=${it.spans})`)
  })
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
