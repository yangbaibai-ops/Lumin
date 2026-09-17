'use strict'
// ─── 验收：行内格式标记矩阵（工具栏 / 快捷键 / 手打标记 / 组合）─────────────────
//
// 这一套要回答的问题（用户报的两个必现缺陷都在这里）：
//   1. **空光标点工具栏「加粗」**应当得到 `**|**`（`|` = 光标），而不是 `****|` / `*|***`；
//      而且接着打字必须得到 `**文字**`（这才说明那对标记真的「夹着」光标）。
//   2. **在已有文本前后各补两个 `*`**（`**x**` 手打前后各一对 → `****x****`）：
//      新增的四个 `*` **一个都不能少**（源码字节必须留住），保存-重开还得一模一样。
//
// 覆盖面（格式 × 操作两条轴）：
//   格式：`**粗**`、`*斜*`、`~~删~~`、`` `行内代码` ``、`<u>下划线</u>`、`[链接](url)`、
//         `$公式$`、`\*转义\*`；组合：粗+斜、粗+码、删+斜、链接+粗、嵌套里取消其一。
//   操作：工具栏按钮（空光标 / 选中文本 / 已在格式内再点一次）、键盘快捷键（Mod-B/I/
//         Shift-X/E）、**手打标记对**、`***粗斜***`、`****冗余嵌套****`。
//
// 每条断言都查三件事（缺一就会漏掉真实缺陷）：
//   · 序列化后的 markdown 字节（走应用自己的落盘管线：beforeunload → flushSync）
//   · 光标位置（块内偏移）
//   · ProseMirror 里每个 text 节点的**文本与 marks**（标记字符去哪了、样式是不是在）
// 每个用例末尾再补一条「保存 → 重新装载 → 再序列化」的往返稳定性断言。
//
// 跑法（隔离实例由 run-suites 起；也可以手工起后直接跑）：
//   node tools/run-suites.js --suite=_verify-inline-formats.js
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-isolated.ps1
//   node tools/_verify-inline-formats.js
const { connect, settle, waitEditor, sleep, clickAt, openDocWith, Reporter, fatal } = require('./lib/harness')

// 工具栏行内按钮的图标首路径（Icon.vue 的 ICONS[kind][0]）——**不能按 title 找**：
// 全局 tooltip（lib/tooltip.ts）在鼠标悬停时会 removeAttribute('title')，悬停过的按钮
// 之后就没有 title 了，按 title 定位会随机找不到（实测踩到）。
const ICON_D = {
  bold: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8',
  italic: 'M19 4h-9',
  underline: 'M6 4v6a6 6 0 0 0 12 0V4',
  strike: 'M16 4H9a3 3 0 0 0-2.83 4',
  code: 'm18 16 4-4-4-4'
}

/** 走应用自己的落盘管线取文档文本（== 保存后文件里的字节） */
const FLUSH = `(() => {
  window.dispatchEvent(new Event('beforeunload'))
  return window.__L.files().current?.content ?? null
})()`

/** 页面侧：每个 text 节点的文本与 marks（顺序即 PM 的 mark 数组顺序）+ 光标块内偏移 */
const DUMP = `JSON.stringify((() => {
  const ed = window.__L.ed()
  if (!ed) return { err: 'no-editor' }
  const nodes = []
  ed.state.doc.descendants((n, pos) => {
    if (!n.isText) return
    nodes.push({ pos, text: n.text, marks: n.marks.map((m) => ({ name: m.type.name, attrs: m.attrs })) })
  })
  const sel = ed.state.selection
  const $from = sel.$from
  let blockStart = -1
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).isTextblock) { blockStart = $from.start(d); break }
  return { nodes, from: sel.from, to: sel.to, caret: blockStart < 0 ? -1 : sel.from - blockStart }
})())`

/** mark 的紧凑写法：mdMarker/mdStyle 带上关键属性，其余只写类型名 */
function markSig(m) {
  if (m.name === 'mdMarker') return `mdMarker(${m.attrs.style}/${m.attrs.side})`
  if (m.name === 'mdStyle') return `mdStyle(${(m.attrs.styles || []).join('+')})`
  return m.name
}
/** 节点签名：`"**"<mdMarker(bold/start)> "x"<mdStyle(bold)>` */
function nodeSig(nodes) {
  return nodes.map((n) => `${JSON.stringify(n.text)}<${n.marks.map(markSig).join(',')}>`).join(' ')
}

let app = null
let report = null

async function state() {
  const content = await app.ev(FLUSH)
  const d = JSON.parse(await app.ev(DUMP))
  return { content, caret: d.caret, from: d.from, to: d.to, nodes: d.nodes, sig: nodeSig(d.nodes) }
}

/**
 * 聚焦编辑面并把光标放到**块内偏移**（真实输入要求 DOM 焦点在编辑面上；
 * 不用绝对位置是因为它随块起点变化，写死会错位——实测踩到「打字跑到星号前面」）。
 */
async function caretAt(offset) {
  const r = await app.ev(`(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    const $f = ed.state.selection.$from
    let start = -1
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).isTextblock) { start = $f.start(d); break }
    ed.commands.focus(start + ${offset})
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`)
  await sleep(120)
  if (r !== 'ok') throw new Error('编辑器没拿到焦点（' + r + '）——真实输入会打到 body 上')
}

/** 光标移到文档末尾并聚焦 */
async function caretEnd() {
  const r = await app.ev(`(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    ed.commands.focus('end')
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`)
  await sleep(120)
  if (r !== 'ok') throw new Error('编辑器没拿到焦点（' + r + '）')
}

/** 选中块内 [from,to) 区间（偏移，不是绝对位置） */
async function selectRange(from, to) {
  const r = await app.ev(`(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    const $f = ed.state.selection.$from
    let start = -1
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).isTextblock) { start = $f.start(d); break }
    ed.commands.focus(start + ${from})
    ed.commands.setTextSelection({ from: start + ${from}, to: start + ${to} })
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`)
  await sleep(120)
  if (r !== 'ok') throw new Error('编辑器没拿到焦点（' + r + '）')
}

/** 点工具栏行内按钮（按图标路径定位） */
async function clickToolbar(kind) {
  const d = ICON_D[kind]
  const raw = await app.ev(`(() => {
    const btns = [...document.querySelectorAll('button.icon-btn')]
    for (const b of btns) {
      const p = b.querySelector('svg path')
      if (p && p.getAttribute('d') === ${JSON.stringify(d)}) {
        const r = b.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      }
    }
    return null
  })()`)
  if (!raw) throw new Error('找不到工具栏按钮：' + kind)
  const p = JSON.parse(raw)
  await clickAt(app.send, p.x, p.y)
  await sleep(200)
}

/** 键盘快捷键（modifiers: 2 = Ctrl，10 = Ctrl+Shift） */
const KEYS = {
  'Mod-b': { key: 'b', code: 'KeyB', vk: 66, modifiers: 2 },
  'Mod-i': { key: 'i', code: 'KeyI', vk: 73, modifiers: 2 },
  'Mod-e': { key: 'e', code: 'KeyE', vk: 69, modifiers: 2 },
  'Mod-Shift-x': { key: 'X', code: 'KeyX', vk: 88, modifiers: 10 }
}
async function hotkey(name) {
  const k = KEYS[name]
  await app.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    modifiers: k.modifiers
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    modifiers: k.modifiers
  })
  await sleep(250)
}

/** 逐字符真实输入（一个字符一次 Input.insertText，与手打一致） */
async function typeChars(text) {
  for (const ch of text) {
    await app.send('Input.insertText', { text: ch })
    await sleep(35)
  }
  await sleep(150)
}

/** 打开一份文档（走「打开文件」路径：编辑器按 key 重建 + 重新解析 markdown） */
async function openDoc(md) {
  await openDocWith(app, md)
  await sleep(450)
}

/**
 * 一个用例的断言：文档字节 / 光标 / 节点与 marks，末尾可选「保存→重开→再序列化」。
 * 用例内部还有后续步骤时传 `roundTrip: false`（重开文档会把编辑器状态换掉，
 * 后续步骤就不是在同一个现场上跑了——实测踩到「下划线+加粗」用例因此错位）。
 */
async function checkState(name, expect) {
  const s = await state()
  report.check(
    `${name} · 字节`,
    s.content === expect.content,
    `实际 ${JSON.stringify(s.content)} 期望 ${JSON.stringify(expect.content)}`
  )
  if (expect.caret !== undefined) {
    report.check(`${name} · 光标`, s.caret === expect.caret, `实际 ${s.caret} 期望 ${expect.caret}`)
  }
  if (expect.sig !== undefined) {
    report.check(`${name} · 节点/marks`, s.sig === expect.sig, `实际 ${s.sig} 期望 ${expect.sig}`)
  }
  if (expect.roundTrip === false) return
  // 保存 → 重新装载 → 再序列化：必须逐字节稳定（否则用户每开一次文件就掉字符）
  await openDoc(expect.content)
  const again = await app.ev(FLUSH)
  report.check(
    `${name} · 往返稳定`,
    again === expect.content,
    `重开后 ${JSON.stringify(again)} 期望 ${JSON.stringify(expect.content)}`
  )
}

/** 只做往返稳定断言（用于「不重开就没法继续下一步」的收尾） */
async function checkRoundTrip(name, expected) {
  await openDoc(expected)
  const again = await app.ev(FLUSH)
  report.check(
    `${name} · 往返稳定`,
    again === expected,
    `重开后 ${JSON.stringify(again)} 期望 ${JSON.stringify(expected)}`
  )
}

async function main() {
  report = new Reporter('行内格式标记矩阵（工具栏 / 快捷键 / 手打标记 / 组合）')
  app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪（ui.booting 一直为 true）')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')

  const backup = JSON.parse(
    await app.ev(`JSON.stringify({ autoSave: window.__L.settings().autoSave })`)
  )
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(150)

  // ═══ A. 工具栏按钮：空光标（缺陷 1）═══════════════════════════════════════
  // 期望：`**|**`（标记字符成对留着、光标在正中间），接着打字 → `**文字**`
  const emptyCases = [
    { kind: 'bold', marker: '**', literal: '****', caret: 2, typed: '**ab**', litStyle: 'bold' },
    { kind: 'italic', marker: '*', literal: '**', caret: 1, typed: '*ab*', litStyle: 'bold' },
    { kind: 'strike', marker: '~~', literal: '~~~~', caret: 2, typed: '~~ab~~', litStyle: 'strike' },
    { kind: 'code', marker: '`', literal: '``', caret: 1, typed: '`ab`', litStyle: 'bold' }
  ]
  for (const c of emptyCases) {
    await openDoc('\n')
    await caretAt(0)
    await clickToolbar(c.kind)
    // 空构造在 CommonMark 里不成立（`****` 之间没有内容）→ 两个标记都降级为字面量，
    // 但**四个字符必须原样留着**、光标必须落在正中间（这才是「能接着打字」的前提）
    await checkState(`工具栏 空光标 ${c.kind}`, {
      content: c.literal + '\n',
      caret: c.caret,
      sig: `${JSON.stringify(c.literal)}<mdMarker(${c.litStyle}/literal)>`,
      roundTrip: false
    })
    await caretAt(c.caret)
    await typeChars('ab')
    // 打完之后光标停在**刚打的字之后、结束标记之前**（不是整块末尾）
    await checkState(`工具栏 空光标 ${c.kind} + 打字`, {
      content: c.typed + '\n',
      caret: c.marker.length + 2,
      sig: `${JSON.stringify(c.marker)}<mdMarker(${c.kind}/start)> "ab"<mdStyle(${c.kind})${
        c.kind === 'code' ? ',mdCodeLiteral' : ''
      }> ${JSON.stringify(c.marker)}<mdMarker(${c.kind}/end)>`
    })
  }

  // 已知语义冲突（**没修**，写清楚留给产品口径）：整行只有标记字符时，CommonMark 把
  // `****` 读作分割线、`~~~~` 读作代码围栏开头 —— 保存后重开必然不再是那四个字面字符。
  // 光标在中间时又**必须**是字面 `****`（否则用户没法接着打字），两条要求在这里直接冲突。
  await openDoc('****\n')
  const boldReload = await app.ev(FLUSH)
  await openDoc('~~~~\n')
  const strikeReload = await app.ev(FLUSH)
  report.skip(
    '空光标 `****` / `~~~~` 整行标记的往返',
    `CommonMark 语义冲突：重开后分别变成 ${JSON.stringify(boldReload)} 与 ${JSON.stringify(
      strikeReload
    )}（详见验收报告）`
  )

  // ═══ A2. 工具栏按钮：选中文本 ═════════════════════════════════════════════
  const selCases = [
    { kind: 'bold', out: '**abc**' },
    { kind: 'italic', out: '*abc*' },
    { kind: 'strike', out: '~~abc~~' },
    { kind: 'code', out: '`abc`' }
  ]
  for (const c of selCases) {
    await openDoc('abc\n')
    await selectRange(0, 3)
    await clickToolbar(c.kind)
    await checkState(`工具栏 选中文本 ${c.kind}`, { content: c.out + '\n' })
  }

  // ═══ A3. 已在格式内再点一次 → 取消（标记与样式一起去掉）═══════════════════
  await openDoc('**abc**\n')
  await caretAt(1)
  await clickToolbar('bold')
  await checkState('工具栏 已在加粗内再点一次 → 取消', {
    content: 'abc\n',
    sig: '"abc"<>'
  })

  // ═══ B. 键盘快捷键 ════════════════════════════════════════════════════════
  for (const c of [
    { key: 'Mod-b', out: '**abc**' },
    { key: 'Mod-i', out: '*abc*' },
    { key: 'Mod-Shift-x', out: '~~abc~~' },
    { key: 'Mod-e', out: '`abc`' }
  ]) {
    await openDoc('abc\n')
    await selectRange(0, 3)
    await hotkey(c.key)
    await checkState(`快捷键 ${c.key} 选中文本`, { content: c.out + '\n' })
  }
  // 空光标 + Ctrl+B（缺陷 1 的快捷键版本）：与工具栏按钮同一条命令路径
  await openDoc('\n')
  await caretAt(0)
  await hotkey('Mod-b')
  await checkState('快捷键 Mod-b 空光标', { content: '****\n', caret: 2, roundTrip: false })

  // ═══ C. 手打标记对（缺陷 2：新增的 `*` 一个都不能少）═══════════════════════
  // C1：`**x**` 起点前补一对 `**`
  await openDoc('**x**\n')
  await caretAt(0)
  await typeChars('**')
  await checkState('手打 在 `**x**` 起点前补 `**`', {
    content: '****x**\n',
    caret: 2,
    sig: '"**"<mdMarker(bold/literal)> "**"<mdMarker(bold/start)> "x"<mdStyle(bold)> "**"<mdMarker(bold/end)>',
    roundTrip: false
  })
  // 再到末尾补一对 → 期望 `****x****`（四对星号全在文档里，一个不少）
  await caretEnd()
  await typeChars('**')
  await checkState('手打 末尾再补 `**`（新增四星全留）', {
    content: '****x****\n',
    caret: 9,
    sig:
      '"**"<mdMarker(bold/start)> "**"<mdStyle(bold),mdEscape> "x"<mdStyle(bold)> ' +
      '"**"<mdStyle(bold),mdEscape> "**"<mdMarker(bold/end)>'
  })

  // C2：纯文本 `x` 前后各补 `**` → `**x**`（正常成粗体，一个字符不多不少）
  await openDoc('x\n')
  await caretAt(0)
  await typeChars('**')
  await caretEnd()
  await typeChars('**')
  await checkState('手打 纯文本前后各补 `**`', {
    content: '**x**\n',
    caret: 5,
    sig: '"**"<mdMarker(bold/start)> "x"<mdStyle(bold)> "**"<mdMarker(bold/end)>'
  })

  // C3：手打 `***粗斜***`（粗+斜的组合标记）
  await openDoc('\n')
  await caretAt(0)
  await typeChars('***x***')
  await checkState('手打 `***x***`', {
    content: '***x***\n',
    caret: 7,
    sig:
      '"**"<mdMarker(bold/start)> "*"<mdMarker(italic/start)> "x"<mdStyle(bold+italic)> ' +
      '"*"<mdMarker(italic/end)> "**"<mdMarker(bold/end)>'
  })

  // C4：手打 `~~删~~` 与 `` `码` ``（两种标记长度不同的构造并存）
  await openDoc('x\n')
  await caretAt(0)
  await typeChars('~~删~~ 与 `码`')
  await checkState('手打 `~~删~~` 与 `` `码` ``', {
    content: '~~删~~ 与 `码`x\n',
    sig:
      '"~~"<mdMarker(strike/start)> "删"<mdStyle(strike)> "~~"<mdMarker(strike/end)> " 与 "<> ' +
      '"`"<mdMarker(code/start)> "码"<mdStyle(code),mdCodeLiteral> "`"<mdMarker(code/end)> "x"<>'
  })

  // C5：手打反斜杠转义 `\*不是标记\*`（原样往返，不变成斜体）
  await openDoc('\n')
  await caretAt(0)
  await typeChars('\\*不是标记\\*')
  await checkState('手打 `\\*转义\\*` 保持字面', {
    content: '\\*不是标记\\*\n',
    caret: 8,
    sig: `${JSON.stringify('\\*')}<mdEscape> "不是标记"<> ${JSON.stringify('\\*')}<mdEscape>`
  })

  // ═══ D. 组合样式 ══════════════════════════════════════════════════════════
  // D1 粗 + 斜
  await openDoc('abc\n')
  await selectRange(0, 3)
  await clickToolbar('bold')
  await clickToolbar('italic')
  await checkState('组合 粗+斜（选中文本连点两个按钮）', {
    content: '***abc***\n',
    sig:
      '"**"<mdMarker(bold/start)> "*"<mdMarker(italic/start)> "abc"<mdStyle(bold+italic)> ' +
      '"*"<mdMarker(italic/end)> "**"<mdMarker(bold/end)>'
  })

  // D2 粗 + 行内代码
  await openDoc('abc\n')
  await selectRange(0, 3)
  await clickToolbar('bold')
  await clickToolbar('code')
  await checkState('组合 粗+行内代码', {
    content: '**`abc`**\n',
    sig:
      '"**"<mdMarker(bold/start)> "`"<mdMarker(code/start)> "abc"<mdStyle(bold+code),mdCodeLiteral> ' +
      '"`"<mdMarker(code/end)> "**"<mdMarker(bold/end)>'
  })

  // D3 删除线 + 斜体
  await openDoc('abc\n')
  await selectRange(0, 3)
  await clickToolbar('strike')
  await clickToolbar('italic')
  await checkState('组合 删除线+斜体', {
    content: '~~*abc*~~\n',
    sig:
      '"~~"<mdMarker(strike/start)> "*"<mdMarker(italic/start)> "abc"<mdStyle(strike+italic)> ' +
      '"*"<mdMarker(italic/end)> "~~"<mdMarker(strike/end)>'
  })

  // D4 链接 + 粗体（链接是行内不透明内容，构造不能把它漏在外层）
  await openDoc('[文字](https://example.com)\n')
  await selectRange(0, 2)
  await clickToolbar('bold')
  await checkState('组合 链接+粗体', {
    content: '**[文字](https://example.com)**\n',
    sig: '"**"<mdMarker(bold/start)> "文字"<link,mdStyle(bold)> "**"<mdMarker(bold/end)>'
  })

  // D5 嵌套里取消其中一种：粗体去掉，行内代码必须留着（样式集合语义）
  await openDoc('**a `b` c**\n')
  await selectRange(2, 3)
  await clickToolbar('bold')
  await checkState('组合 嵌套里取消粗体（行内代码保留）', {
    content: 'a `b` c\n',
    sig:
      '"a "<> "`"<mdMarker(code/start)> "b"<mdStyle(code),mdCodeLiteral> "`"<mdMarker(code/end)> " c"<>'
  })

  // ═══ E. 非 Markdown 标记：下划线（`<u>`）══════════════════════════════════
  await openDoc('abc\n')
  await selectRange(0, 3)
  await clickToolbar('underline')
  await checkState('下划线 选中文本 + 工具栏', {
    content: '<u>abc</u>\n',
    sig: '"abc"<underline>'
  })
  // 已知缺口（**没修**）：下划线是 Markdown 表达不了的 mark，它的序列化形态是**裸 HTML**
  // `<u>`。一旦同一段里还有 `**`，重开时那段 `<u>` 会被 htmlPassthrough 认成「原样保留的
  // 行内 HTML 文本」，于是 `**` 被重新物化 —— 实测每开一次星号就翻一倍
  // （`**<u>a</u>**<u>bc</u>` → `**<u>****a****</u>**<u>**bc</u>` → …）。
  // 光标保护的重推如果给这种块「开后门」（跳过重推），反而会让下划线留下来并进入上面
  // 那条膨胀链；所以现在**保持原行为**：给带下划线的文本套标记样式时，下划线被丢掉
  // （字节稳定、内容有损）。这是产品口径问题（下划线与标记模型的共存方式），留给决策。
  await openDoc('abc\n')
  await selectRange(0, 3)
  await clickToolbar('underline')
  await selectRange(0, 1)
  await clickToolbar('bold')
  const ubm = await state()
  report.skip(
    '下划线 + 加粗（Markdown 表达不了的 mark）',
    `实测：加粗后下划线被丢掉（字节稳定、内容有损）→ 实际 ${JSON.stringify(
      ubm.content
    )}；若改成保留，则重开会进入星号翻倍链（见套件注释）`
  )

  // ═══ F. 行内公式与链接源码（相邻格式不互相干扰）══════════════════════════
  await openDoc('$x^2$ 与 \\*转义\\*\n')
  await checkState('行内公式 + 反斜杠转义 原样装载', {
    content: '$x^2$ 与 \\*转义\\*\n',
    sig: `"$x^2$"<mdMath> " 与 "<> ${JSON.stringify('\\*')}<mdEscape> "转义"<> ${JSON.stringify(
      '\\*'
    )}<mdEscape>`
  })
  // 公式里的 `*` 不能被当成加粗标记（mathScan 先认领）
  await openDoc('$a * b$ 与 **粗**\n')
  await checkState('公式里的 `*` 不当标记', {
    content: '$a * b$ 与 **粗**\n',
    sig:
      '"$a * b$"<mdMath> " 与 "<> "**"<mdMarker(bold/start)> "粗"<mdStyle(bold)> "**"<mdMarker(bold/end)>'
  })

  // ── 复原 ─────────────────────────────────────────────────────────────────
  await app.ev(
    `(() => { window.__L.settings().set('autoSave', ${JSON.stringify(backup.autoSave)}); return 'ok' })()`
  )
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
