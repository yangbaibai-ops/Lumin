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
  pressKey,
  clickCenter,
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

  // ── D. 键语义与表格选择器（manual §3 曾把这些算在 verify-tiptap 的账上）────────
  // 删掉那个遗留资产之前，这几条必须先在矩阵里有归属：
  //   D1 任务项里按回车 → 新任务项（task-enter-semantics）
  //   D2 标题行首退格 → 降级成段落，且不吞上一行（heading-backspace-unheading）
  //   D3 `---` 之后按回车（hr-enter-rule / hr-text-kept 的实际口径）
  //   D4 工具栏表格选择器点 2×3 → 真插一张 2 行 3 列的表（table-grid-picker）
  const ENTER = { key: 'Enter', code: 'Enter', vk: 13 }
  const BACKSPACE = { key: 'Backspace', code: 'Backspace', vk: 8 }

  await openDocWith(app, '', 'input-rules.md')
  await waitEditor(ev)
  if (!(await focusEditor())) return skipAll()
  await typeChars('- [ ] 任务A')
  await pressKey(send, ENTER)
  await sleep(250)
  await typeChars('任务B')
  const taskEnter = JSON.parse(await ev(PROBE))
  report.note('D1 ' + JSON.stringify(taskEnter))
  report.check(
    'D1 任务项里回车 → 新任务项（仍是任务列表，两项都未勾选）',
    first(taskEnter).t === 'taskList' &&
      (first(taskEnter).items ?? []).length === 2 &&
      (first(taskEnter).items ?? []).every((c) => c === false) &&
      taskEnter.content.startsWith('- [ ] 任务A\n- [ ] 任务B'),
    JSON.stringify({ block: first(taskEnter), md: taskEnter.content })
  )

  // D2：上一段 + 标题，光标挪到标题行首按退格
  await openDocWith(app, '上一行\n\n# 标题\n', 'input-rules.md')
  await waitEditor(ev)
  /** 把光标放到标题块首（带焦点重试 —— 程序化 focus 要等一拍才算数） */
  const focusHeadingStart = async (attempts = 10) => {
    for (let i = 0; i < attempts; i++) {
      await bringToFront(app)
      const r = await ev(`(() => {
        const ed = window.__L.ed()
        const doc = ed.state.doc
        let pos = 0
        for (let j = 0; j < doc.childCount; j++) {
          if (doc.child(j).type.name === 'heading') break
          pos += doc.child(j).nodeSize
        }
        ed.commands.focus(pos + 1)
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
  if (await focusHeadingStart()) {
    await pressKey(send, BACKSPACE)
    await sleep(400)
    const unheading = JSON.parse(await ev(PROBE))
    report.note('D2 ' + JSON.stringify(unheading))
    report.check(
      'D2 标题行首退格 → 降级成段落，且上一行原样保留',
      unheading.blocks[1]?.t === 'paragraph' &&
        unheading.blocks[1]?.text === '标题' &&
        unheading.blocks[0]?.text === '上一行',
      JSON.stringify(unheading.blocks)
    )
  } else {
    report.skip('D2 标题行首退格', '编辑器拿不到焦点（窗口不是前台）')
  }

  // D3：`---` 之后回车（这条以前叫 hr-enter-rule；先量清实际口径再断言）
  await openDocWith(app, '', 'input-rules.md')
  await waitEditor(ev)
  if (!(await focusEditor())) return skipAll()
  await typeChars('---')
  await pressKey(send, ENTER)
  await sleep(400)
  const hrEnter = JSON.parse(await ev(PROBE))
  report.note('D3 ' + JSON.stringify(hrEnter))
  /**
   * 实测口径（与 verify-tiptap 里 `hr-not-immediate` / `hr-enter-rule` 两条同名断言一致）：
   * `---` **不立即**变分割线（`HorizontalRule.extend({ addInputRules: () => [] })` 把输入规则置空），
   * 但**按回车确认**后会被"源码权威重推"成 horizontalRule，落盘就是 `---`。
   * 这就是 Typora 的行为，也解释了为什么 A7 的"保持段落"只在**没有回车**时成立。
   */
  report.check(
    'D3 `---` 不立即转、**回车确认**后转分割线（延迟到 Enter，落盘 `---`）',
    first(hrEnter).t === 'horizontalRule' && hrEnter.content.startsWith('---'),
    JSON.stringify({ blocks: hrEnter.blocks, md: hrEnter.content })
  )

  /**
   * D4：工具栏表格按钮的**两条**入口（实测口径，与 verify-tiptap 的
   * `table-picker-visible` / `table-grid-picker-2x3` / `table-default-3x3` 对齐）：
   *   * **点一下**按钮 → 直接插一张 **3×3**（不是"打开选择器"！组件里 `onButtonClick` 就是 insertTable(3,3)）；
   *   * **悬停** ≥300ms → 尺寸选择器出现 → 点某个格子插 N×M。
   * ⚠️ 每次都要**先把鼠标挪开**：`mouseenter` 只在"从外面进来"时触发，鼠标本来就停在按钮上时
   * 再发一次 mouseMoved 不会开选择器（而且上一次交互可能把 popover 留在打开态）。
   */
  const pickerProbe = () =>
    ev(`(() => {
      const ed = window.__L.ed()
      const n = ed ? ed.state.doc.child(0) : null
      const rows = n && n.type.name === 'table' ? n.childCount : 0
      return JSON.stringify({
        type: n ? n.type.name : null,
        rows,
        cols: rows ? n.child(0).childCount : 0,
        popover: !!document.querySelector('.table-size-popover')
      })
    })()`)
  const parkMouse = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 400 })
    await sleep(350)
  }

  await openDocWith(app, '', 'input-rules.md')
  await waitEditor(ev)
  await ev(`(() => {
    const s = window.__L.settings()
    window.__toolbarBackup = { visible: s.toolbarVisible, items: JSON.stringify(s.toolbarItems) }
    if (!s.toolbarItems.includes('table')) s.set('toolbarItems', [...s.toolbarItems, 'table'])
    s.set('toolbarVisible', true)
    return 'ok'
  })()`)
  await sleep(600)
  // 表格按钮是**自带组件的工具条项**，只有 `data-toolbar-item`、没有 `data-toolbar-item-id`
  //（Toolbar.vue 只给自己渲染的那几项打 id）⇒ 用当前语言包里的 `editor.table` 文案定位，
  // 不写死中文（这个 profile 是 zh-CN，但套件不该假设语言）。
  const lang = await ev(`window.__L.settings().language`)
  const tableLabel = require(`../src/shared/i18n/${lang}.json`).editor.table
  const tableSelector = `[data-toolbar-item] button[aria-label="${tableLabel}"]`

  await parkMouse()
  await clickCenter(send, ev, tableSelector)
  await sleep(500)
  const clicked = JSON.parse(await pickerProbe())
  report.note('D4a ' + JSON.stringify({ lang, ...clicked }))
  report.check(
    'D4a 点表格按钮 → 直接插一张 3×3（默认尺寸）',
    clicked.type === 'table' && clicked.rows === 3 && clicked.cols === 3,
    JSON.stringify(clicked)
  )

  await parkMouse()
  await openDocWith(app, '', 'input-rules.md')
  await waitEditor(ev)
  const tableRect = JSON.parse(
    await ev(`(() => {
      const b = document.querySelector(${JSON.stringify(tableSelector)})
      if (!b) return 'null'
      const r = b.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`)
  )
  if (tableRect && tableRect !== null) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tableRect.x, y: tableRect.y })
    await sleep(600)
    const hovered = JSON.parse(await pickerProbe())
    report.note('D4b-hover ' + JSON.stringify(hovered))
    const picked = hovered.popover ? await clickCenter(send, ev, '[aria-label="2 × 3"]') : false
    await sleep(500)
    const grid = JSON.parse(await pickerProbe())
    report.note('D4b ' + JSON.stringify({ hoveredPopover: hovered.popover, picked, ...grid }))
    report.check(
      'D4b 悬停出选择器、点 2×3 → 真插一张 2 行 3 列的表',
      hovered.popover === true && picked === true && grid.rows === 2 && grid.cols === 3,
      JSON.stringify({ hovered: hovered.popover, picked, ...grid })
    )
  } else {
    report.skip('D4b 悬停出选择器', '工具条上没有表格按钮')
  }
  // 复原工具条设置（下一轮套件从干净状态开始）
  await ev(`(() => {
    const s = window.__L.settings()
    const b = window.__toolbarBackup
    if (b) {
      s.set('toolbarItems', JSON.parse(b.items))
      s.set('toolbarVisible', b.visible)
    }
    return 'ok'
  })()`)
  // 收尾把鼠标停到角落里：这条套件有意移动过指针（悬停出选择器），
  // 别把"指针正停在某个工具条按钮上"留给下一轮（那会让 hover 类断言莫名其妙地先亮一次）
  await parkMouse()

  /**
   * ── E. 任务列表规则敲在**非首项**上（回归：曾恒改首项）──────────────────────────
   *
   * 判据是**用户能看到的最终字节**：三项目无序列表里，光标放到第二项开头敲 `[x] `，
   * 期望第二项被勾上且标记被剥掉、第一项与第三项原样。
   * （纯逻辑那侧由 `tests/inputRules.test.mjs` 覆盖；这一条证明真实编辑器的
   *  `beforeinput` → inputRules → 事务这条链上的行为一致。）
   */
  await openDocWith(app, '- 第一条\n- 第二条\n- 第三条\n', 'input-rules.md')
  await waitEditor(ev)
  if (await focusEditor()) {
    const placed = await ev(`(() => {
      const ed = window.__L.ed()
      let target = null
      ed.state.doc.descendants((n, pos) => {
        if (n.isText && n.text === '第二条') target = pos
        return true
      })
      if (target === null) return 'no-item'
      ed.chain().focus().setTextSelection(target).run()
      return 'ok'
    })()`)
    if (placed !== 'ok') {
      report.skip('E 非首项任务列表', '定位第二项失败：' + placed)
    } else {
      await sleep(250)
      await typeChars('[x] ')
      const after = String(await ev(`window.__L.files().current.content`))
      const lines = after.split('\n').filter((l) => l.trim())
      report.note('E ' + JSON.stringify(lines))
      report.check(
        'E 非首项敲 `[x] `：勾的是那一项（回归）',
        // 整个列表转成任务列表 ⇒ 三项都写成 `- [ ]` / `- [x]` 形式
        lines[0] === '- [ ] 第一条' && lines[1] === '- [x] 第二条' && lines[2] === '- [ ] 第三条',
        JSON.stringify(lines)
      )
    }
  } else {
    report.skip('E 非首项任务列表', '编辑器拿不到焦点（窗口不是前台）')
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
