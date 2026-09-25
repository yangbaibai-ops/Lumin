'use strict'
// ─── 验收：Markdown **输入规则**（敲 `# ` 变标题这一类快捷输入）────────────────────
//
// 为什么单独补这一条（审计 §10 P0「tools/verify-tiptap.js 不属任何矩阵，且换机不可跑」）：
// 那个 1488 行的遗留资产里，"敲 `# `/`- `/`1. `/`> `/围栏"这类**块级快捷输入**是唯一的
// 自动化资产，而它既跑不到矩阵里（文件名不带 `_`、要手工起 dev server），换台机器也跑不起来。
// 默认矩阵里的 `_verify-inline-formats` 守的是「手打标记字符的行内保真」（`**粗**` 那类），
// 块级输入规则与 `lib/editor/inputRules.ts` 的两条自研规则（任务列表、Markdown 链接）没人守。
//
// 这条套件把这块补上，之后 `tools/verify-tiptap.js` 才能真正删掉 —— 覆盖不能靠"反正在 git 历史里"。
// 断言口径：**结构 + 字节**两路。结构读 ProseMirror 文档（节点类型/层级/勾选态），
// 字节读 store 里的 markdown（输入规则必须同时产出可序列化的文档，否则用户存盘就丢格式）。
const {
  connect,
  settle,
  sleep,
  bringToFront,
  insertText,
  openDocWith,
  waitEditor,
  Reporter,
  fatal
} = require('./lib/harness')

/** 文档结构与字节：`blocks` 只看前 4 个顶层节点（够用了，且不会被长文档拖慢） */
const PROBE = `(() => {
  const f = window.__L.files()
  const ed = window.__L.ed()
  const doc = ed ? ed.state.doc : null
  const nodes = doc ? doc.content.content.slice(0, 4) : []
  const blocks = nodes.map((n) => ({
    t: n.type.name,
    level: n.attrs.level ?? null,
    text: n.textContent,
    // 任务列表：勾选态挂在 **taskItem** 上，不在 taskList 上（这里按项列出来）
    items: n.type.name === 'taskList' ? n.content.content.map((c) => c.attrs.checked) : null
  }))
  return JSON.stringify({ content: f.current?.content ?? '', blocks })
})()`

async function main() {
  const app = await connect()
  const { ev, send } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('Markdown 输入规则（块级快捷输入 + 自研的任务列表/链接规则）')

  /** 编辑器拿焦点（用户自己的 Lumin 可能占着前台 ⇒ 每次重试都重新提前台） */
  async function focusEditor(attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      await bringToFront(app)
      const r = await ev(`(() => {
        const ed = window.__L.ed()
        if (!ed) return 'NO-EDITOR'
        ed.commands.focus('end')
        return ed.isFocused ? 'ok' : 'NO-FOCUS'
      })()`)
      if (r === 'ok') {
        await sleep(120)
        return true
      }
      await sleep(250)
    }
    return false
  }

  /** 逐字符真实输入（一个字符一次 Input.insertText，与手打一致 —— 输入规则靠 beforeinput 触发） */
  async function typeChars(text) {
    for (const ch of text) {
      await insertText(send, ch)
      await sleep(30)
    }
    await sleep(400)
  }

  /** 开一份干净文档 → 输入 → 读结构 + 字节 */
  async function typeInto(text, { focus = true } = {}) {
    await openDocWith(app, '', 'input-rules.md')
    await waitEditor(ev)
    if (focus && !(await focusEditor())) return null
    await typeChars(text)
    return JSON.parse(await ev(PROBE))
  }

  const first = (r) => (r && r.blocks[0]) || {}
  const skipAll = () => {
    report.skip('输入规则', '编辑器拿不到焦点（窗口不是前台）')
    app.close()
    return report.finish()
  }

  // ── A. StarterKit 自带的块级规则 ────────────────────────────────────────────
  const h1 = await typeInto('# 一级')
  if (!h1) return skipAll()
  report.note('A1 ' + JSON.stringify(h1))
  report.check(
    'A1 `# ` → h1（结构 + 字节）',
    first(h1).t === 'heading' && first(h1).level === 1 && h1.content.startsWith('# 一级'),
    JSON.stringify({ block: first(h1), md: h1.content })
  )

  const h3 = await typeInto('### 三级')
  if (!h3) return skipAll()
  report.check(
    'A2 `### ` → h3',
    first(h3).t === 'heading' && first(h3).level === 3,
    JSON.stringify(first(h3))
  )

  const ul = await typeInto('- 条目')
  if (!ul) return skipAll()
  report.check(
    'A3 `- ` → 无序列表',
    first(ul).t === 'bulletList' && first(ul).text === '条目' && ul.content.startsWith('- 条目'),
    JSON.stringify({ block: first(ul), md: ul.content })
  )

  const ol = await typeInto('1. 条目')
  if (!ol) return skipAll()
  report.check(
    'A4 `1. ` → 有序列表',
    first(ol).t === 'orderedList' && ol.content.startsWith('1. 条目'),
    JSON.stringify({ block: first(ol), md: ol.content })
  )

  const quote = await typeInto('> 引用')
  if (!quote) return skipAll()
  report.check(
    'A5 `> ` → 引用块',
    first(quote).t === 'blockquote' && quote.content.startsWith('> 引用'),
    JSON.stringify({ block: first(quote), md: quote.content })
  )

  const fence = await typeInto('``` ')
  if (!fence) return skipAll()
  report.check(
    'A6 ` ``` ` + 空格 → 代码块（规则是 /^```([a-z]+)?[\\s\\n]$/，光三个反引号不算）',
    first(fence).t === 'codeBlock',
    JSON.stringify(first(fence))
  )

  /**
   * A7 是**反向断言**，而且很重要：`---` 在这里**故意不**变成分割线 ——
   * `extensions.ts` 里 `HorizontalRule.extend({ addInputRules: () => [] })` 把这条规则置空了。
   * 于是必须同时确认"落盘会把整行标记字符转义"，否则用户敲的 `---` 存成 `---` 后，
   * 下次打开会被 markdown-it 解析成分割线（正文结构被静默改写）。
   */
  const hr = await typeInto('---')
  if (!hr) return skipAll()
  report.note('A7 ' + JSON.stringify(hr))
  report.check(
    'A7 `---` 不转分割线（该输入规则被有意置空），且落盘转义为字面文本',
    // 只需转义**第一个** `-`：CommonMark 的主题分隔线要求整行都是 `-`/`_`/`*`，
    // 首字符一带反斜杠这行就不再是分隔线了（实测落盘就是 `\---`）
    first(hr).t === 'paragraph' && hr.content.startsWith('\\---'),
    JSON.stringify({ block: first(hr).t, md: hr.content })
  )
  // 真正要防的是"重开被静默改写"：把刚落的字节重新装载，必须还是同一段字面文本。
  // ⚠️ 模型里的**文本会带着转义反斜杠**（`\---`），这是设计如此：反斜杠由装饰层
  // （`escapeDecorations`，见 _verify-inline-formats）拆成 `.md-escape-backslash` 隐藏，
  // 模型与字节都不动 —— 所以这里断言的是"字节稳定 + 仍是段落"，不是"文本里没有反斜杠"。
  await openDocWith(app, hr.content, 'input-rules.md')
  await waitEditor(ev)
  const hrBack = JSON.parse(await ev(PROBE))
  report.check(
    'A8 `---` 落盘后重开字节稳定、仍是段落（不会被解析成分割线）',
    first(hrBack).t === 'paragraph' && hrBack.content === hr.content,
    JSON.stringify({ block: first(hrBack).t, text: first(hrBack).text, md: hrBack.content })
  )

  // ── B. 本仓库自研的两条规则（lib/editor/inputRules.ts）──────────────────────
  // 任务列表：只在**无序**列表项开头认 `[ ]` / `[x] `
  await openDocWith(app, '', 'input-rules.md')
  await waitEditor(ev)
  if (!(await focusEditor())) return skipAll()
  await typeChars('- [ ] 待办')
  const task = JSON.parse(await ev(PROBE))
  report.note('B1 ' + JSON.stringify(task))
  report.check(
    'B1 无序列表里 `[ ] ` → 任务列表（未勾选）',
    first(task).t === 'taskList' &&
      first(task).items?.[0] === false &&
      first(task).text === '待办' &&
      task.content.startsWith('- [ ] 待办'),
    JSON.stringify({ block: first(task), md: task.content })
  )

  await openDocWith(app, '', 'input-rules.md')
  await waitEditor(ev)
  if (!(await focusEditor())) return skipAll()
  await typeChars('- [x] 已办')
  const task2 = JSON.parse(await ev(PROBE))
  report.check(
    'B2 `[x] ` → 任务列表（已勾选）',
    first(task2).t === 'taskList' &&
      first(task2).items?.[0] === true &&
      task2.content.startsWith('- [x] 已办'),
    JSON.stringify({ block: first(task2), md: task2.content })
  )

  // Markdown 链接：敲下 `)` 成形；**继续输入不能再被吞进链接里**
  //（代码里为此清 storedMarks —— 否则紧接着打的字会变成链接文字）
  await openDocWith(app, '', 'input-rules.md')
  await waitEditor(ev)
  if (!(await focusEditor())) return skipAll()
  await typeChars('[官网](https://example.com)')
  const link = JSON.parse(await ev(PROBE))
  report.note('B3 ' + JSON.stringify(link))
  report.check(
    'B3 手打 `[文字](url)` → 链接（字节仍是 markdown 链接）',
    link.content.includes('[官网](https://example.com)'),
    JSON.stringify(link.content)
  )
  await typeChars('尾')
  const linkTail = JSON.parse(await ev(PROBE))
  report.check(
    'B4 成形后继续输入不再被吞进链接（storedMarks 已清）',
    // 两个条件缺一不可：链接本身必须成形（否则"没被吞"是废话），并且新字符在链接**之外**
    linkTail.content.includes('[官网](https://example.com)') && /\)尾\s*$/.test(linkTail.content),
    JSON.stringify(linkTail.content)
  )

  // ── C. 不该误触发的几种（规则锚在块首 / 需要特定字符）──────────────────────
  const noHash = await typeInto('#标签')
  if (!noHash) return skipAll()
  report.check(
    'C1 `#标签`（# 后没有空格）不转标题',
    first(noHash).t === 'paragraph' && first(noHash).text === '#标签',
    JSON.stringify(first(noHash))
  )

  const noDecimal = await typeInto('1.5 倍')
  if (!noDecimal) return skipAll()
  report.check(
    'C2 `1.5 倍` 不转有序列表',
    first(noDecimal).t === 'paragraph' && first(noDecimal).text === '1.5 倍',
    JSON.stringify(first(noDecimal))
  )

  const midHash = await typeInto('正文 # 不是标题')
  if (!midHash) return skipAll()
  report.check(
    'C3 段落中间的 `# ` 不转标题（规则锚在块首）',
    first(midHash).t === 'paragraph' && first(midHash).text === '正文 # 不是标题',
    JSON.stringify(first(midHash))
  )

  // 空 label 的 `[](url)` 保持字面（PM 不允许空文本节点，规则里明确 return null）
  const emptyLabel = await typeInto('[](https://example.com)')
  if (!emptyLabel) return skipAll()
  report.note('C4 ' + JSON.stringify(emptyLabel))
  // 文字保持字面**并且**落盘被转义：`[](...)` 是链接语法，不转义的话重开文件会变成链接，
  // 而用户此刻明明只是打了一段普通文字（这条口径与 documentText 的"整行标记字符转义"同源）
  report.check(
    'C4 空 label `[](url)` 保持字面文本（转义落盘、不成链、不报错）',
    first(emptyLabel).t === 'paragraph' &&
      first(emptyLabel).text === '[](https://example.com)' &&
      emptyLabel.content.startsWith('\\[\\](https://example.com)'),
    JSON.stringify({ block: first(emptyLabel), md: emptyLabel.content })
  )

  // 有序列表里 `[ ] ` 不转任务列表（代码只认 bulletList）
  await openDocWith(app, '', 'input-rules.md')
  await waitEditor(ev)
  if (!(await focusEditor())) return skipAll()
  await typeChars('2. [ ] 有序')
  const orderedTask = JSON.parse(await ev(PROBE))
  report.check(
    'C5 有序列表里 `[ ] ` 不转任务列表（只认无序列表）',
    first(orderedTask).t === 'orderedList',
    JSON.stringify(first(orderedTask))
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
