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
const {
  connect,
  settle,
  waitEditor,
  sleep,
  clickAt,
  openDocWith,
  pressKey,
  bringToFront,
  Reporter,
  fatal
} = require('./lib/harness')
const { execFileSync } = require('child_process')

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
 *
 * 为什么带重试：`ed.isFocused` 依赖 `document.hasFocus()`，窗口还没被带到前台
 * （套件由 run-suites 起实例，首条用例紧跟在建的编辑器后面）时会偶发 NO-FOCUS ——
 * 实测同一构建下套件整体跑时约 1/5 的概率在**第一条**用例上炸，属环境抖动而非缺陷。
 * 重试只等焦点，不改断言语义。
 */
async function caretAt(offset, attempts = 8) {
  const expr = `(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    const $f = ed.state.selection.$from
    let start = -1
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).isTextblock) { start = $f.start(d); break }
    ed.commands.focus(start + ${offset})
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`
  for (let i = 0; i < attempts; i++) {
    // 用户**自己的** Lumin 窗口可能正占着前台（套件约定不碰它）⇒ 每次重试都重新提一次
    await bringToFront(app)
    const r = await app.ev(expr)
    if (r === 'ok') {
      await sleep(120)
      return
    }
    await sleep(250)
  }
  throw new Error('编辑器没拿到焦点（NO-FOCUS）——真实输入会打到 body 上')
}

/** 光标移到文档末尾并聚焦（同样带焦点重试，见 caretAt 的说明） */
async function caretEnd(attempts = 8) {
  const expr = `(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    ed.commands.focus('end')
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`
  for (let i = 0; i < attempts; i++) {
    // 用户**自己的** Lumin 窗口可能正占着前台（套件约定不碰它）⇒ 每次重试都重新提一次
    await bringToFront(app)
    const r = await app.ev(expr)
    if (r === 'ok') {
      await sleep(120)
      return
    }
    await sleep(250)
  }
  throw new Error('编辑器没拿到焦点（NO-FOCUS）')
}

/**
 * 聚焦编辑面并把光标放到**绝对位置**（`caretEnd` 的带参版本）。
 *
 * 与 caretAt（块内偏移）的分工：多段落夹具里 caretAt 以「当前选区所在块」为基准，
 * 前一条用例把光标留在第二段时会算到错误的段落上 —— 跨段定位一律用绝对位置。
 * 同样带焦点重试（真实按键要求 DOM 焦点在编辑面上）。
 */
async function caretAbs(pos, attempts = 8) {
  const expr = `(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    ed.commands.focus(${pos})
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`
  for (let i = 0; i < attempts; i++) {
    // 用户**自己的** Lumin 窗口可能正占着前台（套件约定不碰它）⇒ 每次重试都重新提一次
    await bringToFront(app)
    const r = await app.ev(expr)
    if (r === 'ok') {
      await sleep(120)
      return
    }
    await sleep(250)
  }
  throw new Error('编辑器没拿到焦点（NO-FOCUS）')
}

/** 选中块内 [from,to) 区间（偏移，不是绝对位置）；同样带焦点重试 */
async function selectRange(from, to, attempts = 8) {
  const expr = `(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    const $f = ed.state.selection.$from
    let start = -1
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).isTextblock) { start = $f.start(d); break }
    ed.commands.focus(start + ${from})
    ed.commands.setTextSelection({ from: start + ${from}, to: start + ${to} })
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`
  for (let i = 0; i < attempts; i++) {
    // 用户**自己的** Lumin 窗口可能正占着前台（套件约定不碰它）⇒ 每次重试都重新提一次
    await bringToFront(app)
    const r = await app.ev(expr)
    if (r === 'ok') {
      await sleep(120)
      return
    }
    await sleep(250)
  }
  throw new Error('编辑器没拿到焦点（NO-FOCUS）')
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
  // 快捷工具栏出厂默认**收起**（清单 §1.E 选项②），而本套件整套都在点工具栏按钮 ⇒ 显式打开
  await app.ev(`(() => { window.__L.settings().set('toolbarVisible', true); return 'ok' })()`)
  await sleep(300)

  // ═══ A. 工具栏按钮：空光标（缺陷 1）═══════════════════════════════════════
  // 期望：`**|**`（标记字符成对留着、光标在正中间），接着打字 → `**文字**`
  const emptyCases = [
    {
      kind: 'bold',
      marker: '**',
      literal: '****',
      escaped: '\\*\\*\\*\\*',
      caret: 2,
      typed: '**ab**',
      litStyle: 'bold'
    },
    {
      kind: 'italic',
      marker: '*',
      literal: '**',
      escaped: '\\*\\*',
      caret: 1,
      typed: '*ab*',
      litStyle: 'bold'
    },
    {
      kind: 'strike',
      marker: '~~',
      literal: '~~~~',
      escaped: '\\~\\~\\~\\~',
      caret: 2,
      typed: '~~ab~~',
      litStyle: 'strike'
    },
    {
      kind: 'code',
      marker: '`',
      literal: '``',
      escaped: '\\`\\`',
      caret: 1,
      typed: '`ab`',
      litStyle: 'bold'
    }
  ]
  for (const c of emptyCases) {
    await openDoc('\n')
    await caretAt(0)
    await clickToolbar(c.kind)
    // 空构造在 CommonMark 里不成立（`****` 之间没有内容）→ 两个标记都降级为字面量，
    // 但**四个字符必须原样留着**、光标必须落在正中间（这才是「能接着打字」的前提）。
    // 落盘时整行标记逐字符转义（否则 `****`/`~~~~` 会被当成块级构造，见下条口径）。
    await checkState(`工具栏 空光标 ${c.kind}`, {
      content: c.escaped + '\n',
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

  // 口径（已定，见 shared/documentText.escapeMarkerOnlyLines）：整行只由标记字符组成时
  // **逐字符转义** —— 不转义的话 `****` 是 CommonMark 的分割线、`~~~~` 是代码围栏开头，
  // 保存重开就变成 `---` / 空代码块（**字符被静默改写**，正是本次要消灭的那类问题）。
  // 转义后重开仍是字面四个字符，且跨编辑器一致。
  const ROW_SHAPE = `JSON.stringify((() => {
    const ed = window.__L.ed()
    const names = []
    ed.state.doc.forEach((n) => names.push(n.type.name))
    return { names, text: ed.state.doc.textContent }
  })())`
  for (const c of [
    { kind: 'bold', literal: '****', escaped: '\\*\\*\\*\\*' },
    { kind: 'strike', literal: '~~~~', escaped: '\\~\\~\\~\\~' }
  ]) {
    await openDoc(c.escaped + '\n')
    const shape = JSON.parse(await app.ev(ROW_SHAPE))
    report.check(
      `整行标记 ${c.kind} · 重开不是分割线/代码块`,
      shape.names.length === 1 && shape.names[0] === 'paragraph',
      JSON.stringify(shape.names)
    )
    // 四个标记字符**一个不少**：它们以 mdEscape（逐字写回）活在同一段落里
    // （模型文本带上转义用的反斜杠是这套「转义靠 mark 承载」模型的既有形态）
    const marks = shape.text.match(/[*~`]/g) ?? []
    report.check(
      `整行标记 ${c.kind} · 重开后四个字符都在（字面文本，非块级构造）`,
      marks.length === 4 && shape.text === c.escaped,
      `实际 ${JSON.stringify(shape.text)} 期望 ${JSON.stringify(c.escaped)}`
    )
    const again = await app.ev(FLUSH)
    report.check(
      `整行标记 ${c.kind} · 再序列化字节稳定`,
      again === c.escaped + '\n',
      `实际 ${JSON.stringify(again)} 期望 ${JSON.stringify(c.escaped + '\n')}`
    )
  }

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
  // 空光标 + Ctrl+B（缺陷 1 的快捷键版本）：与工具栏按钮同一条命令路径。
  // 整行标记落盘逐字符转义，所以这份文档重开也是稳定的（往返断言照做）
  await openDoc('\n')
  await caretAt(0)
  await hotkey('Mod-b')
  await checkState('快捷键 Mod-b 空光标', { content: '\\*\\*\\*\\*\n', caret: 2 })

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
    sig: '"a "<> "`"<mdMarker(code/start)> "b"<mdStyle(code),mdCodeLiteral> "`"<mdMarker(code/end)> " c"<>'
  })

  // ═══ E. 下划线：**已移除**（第二十五轮按钮去留审计）════════════════════════
  // 它唯一的落盘形态是裸 HTML `<u>`，重开即被 htmlPassthrough 转成字面文本
  // （屏幕上显示 `<u>abc</u>`），与 `**` 嵌套还会丢掉下划线 —— 属于「能写进文件、读不回来」
  // 的数据损坏类缺陷。因此：工具栏入口删除、`StarterKit.configure({ underline: false })` 显式关闭。
  // 本段改为**回归断言**：入口与 mark 都不在，且文件里不会长出 `<u>`。
  await openDoc('abc\n')
  await selectRange(0, 3)
  const uEntry = JSON.parse(await app.ev(`JSON.stringify((() => {
    const btns = [...document.querySelectorAll('[data-toolbar-item], .icon-btn')]
    const has = btns.some((b) => b.getAttribute('title') === '下划线' || b.getAttribute('data-toolbar-item') === 'underline')
    const ed = window.__L.ed()
    let cmdOk = false
    try { cmdOk = !!ed?.commands?.toggleUnderline } catch { cmdOk = false }
    return { has, cmdOk, marks: ed ? Object.keys(ed.schema.marks) : [] }
  })())`))
  report.check(
    'E 下划线的工具栏入口与 mark 都已移除（不再有「写进去读不回来」的按钮）',
    uEntry.has === false && uEntry.cmdOk === false && !uEntry.marks.includes('underline'),
    JSON.stringify(uEntry)
  )
  const uDoc = await state()
  report.check(
    'E 该文档里没有 `<u>` 这类不可往返的字节',
    !String(uDoc.content).includes('<u>'),
    JSON.stringify(uDoc.content)
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
    sig: '"$a * b$"<mdMath> " 与 "<> "**"<mdMarker(bold/start)> "粗"<mdStyle(bold)> "**"<mdMarker(bold/end)>'
  })

  // ═══ G. 样式正文里的字面标记字符（任务 A：**不许产生转义**）════════════════════
  // 现场：实时渲染区逐字输入 `**2****2**`，落盘变成 `**2\*\*\*\*2**`（多出四个反斜杠）。
  // 取证结论（四条路径全跑过，见 docs/typora-wysiwyg-manual.md §4.70）：
  //   * 逐字键入 / 一次性 insertContent / 从磁盘装载 —— **三条路径全都**出现转义，
  //     所以不是「输入中间态把标记锁成字面文本」；
  //   * 不是转义的那条（先打 `**2**` 再整段插入 `**2**`）之所以干净，是因为它的模型
  //     恰好是「两个相邻 strong」，与 CommonMark 解析无关。
  // 真根因：`**2****2**` 在 CommonMark 里是**一个** `<strong>` 包住字面文本 `2****2`
  // （markdown-it commonmark preset 与 marked 三方实测一致；四颗星是**字面字符**，
  // 渲染出来就看得见 —— GitHub 同款），而「字面量化」只覆盖了无样式正文，样式正文里的
  // 裸标记字符被漏掉 → markdown 写出器（prosemirror-markdown 的 `esc()`）给它们补反斜杠。
  // 修法：字面量化下沉到纯逻辑核心（`literalizeStrayAtoms`），样式正文里的裸标记字符
  // 切成 verbatim 原子（MdEscape 的 `escape:false`）→ 逐字节写回。
  await openDoc('\n')
  await caretAt(0)
  await typeChars('**2****2**')
  await checkState('手打 `**2****2**`（逐字输入）· 不许出现反斜杠', {
    content: '**2****2**\n',
    caret: 10,
    sig:
      '"**"<mdMarker(bold/start)> "2"<mdStyle(bold)> "****"<mdStyle(bold),mdEscape> ' +
      '"2"<mdStyle(bold)> "**"<mdMarker(bold/end)>'
  })
  // CommonMark 语义：`**2****2**` = 一个 strong 包住「2 + 四个字面星 + 2」
  // （**不是**两个相邻 strong —— 这点与报障时的判断不同，见手册 §4.70 的口径修正）
  const cmShape = JSON.parse(
    await app.ev(`JSON.stringify((() => {
      const p = document.querySelector('.ProseMirror p')
      const strongs = [...p.querySelectorAll('strong')]
      return {
        strongs: strongs.length,
        strongText: strongs.map((s) => s.textContent).join('|'),
        paraText: p.textContent,
        literalMarkers: p.querySelectorAll('.md-marker[data-side="literal"]').length
      }
    })())`)
  )
  report.check(
    '手打 `**2****2**` · 实时渲染 = CommonMark 语义（一个 strong，星号在 strong 里可见）',
    cmShape.strongs === 1 &&
      cmShape.strongText === '2****2' &&
      cmShape.paraText === '**2****2**' &&
      cmShape.literalMarkers === 0,
    JSON.stringify(cmShape)
  )
  // 一次性 insertContent（同一条写入路径，但没有逐字中间态）
  await openDoc('\n')
  await caretAt(0)
  await app.ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.insertContent(${JSON.stringify('**2****2**')})
    return 'ok'
  })()`)
  await sleep(250)
  await checkState('`**2****2**` · 一次性 insertContent 逐字节', {
    content: '**2****2**\n',
    roundTrip: false
  })
  // 装载路径（源码从磁盘进来）：`getMarkdown`（落盘出口）必须与输入逐字节一致
  await openDoc('**2****2**\n')
  await checkState('`**2****2**` · 装载源码逐字节', { content: '**2****2**\n' })
  // 同类：样式正文里的单个裸星（`**a * b**`）与成对裸星（`*a**b*`）都不许被转义
  await openDoc('**a * b**\n')
  await checkState('`**a * b**` · 样式正文里的裸星不被转义', { content: '**a * b**\n' })
  await openDoc('*a**b* 与 **c****d**\n')
  await checkState('`*a**b*` / `**c****d**` · 同行两处都不被转义', {
    content: '*a**b* 与 **c****d**\n'
  })
  // 相邻/嵌套不回退（上一轮修过的三个缺陷 + 常见组合）
  for (const md of ['***x***', '**a**b**c**', '**a`b`c**', '~~x~~', '_x_', '****x****', '**2***']) {
    await openDoc(md + '\n')
    const got = await app.ev(FLUSH)
    report.check(
      `相邻/嵌套不回退 ${JSON.stringify(md)}`,
      got === (md === '_x_' ? '*x*' : md) + '\n',
      `实际 ${JSON.stringify(got)} 期望 ${JSON.stringify(md + '\n')}（_x_ 归一到 *x*）`
    )
  }

  // ═══ H. 转义反斜杠的渲染与显隐（与 `**` 同一机制：按光标显隐 + 连续段整体显隐）══
  // 现场：「真正无法配对、必须字面化」的场景（整行只有 `****`）落盘写成 `\*\*\*\*`，
  // 重开后这些反斜杠**不该一直挂在屏幕上**，而要像加粗的 `**` 那样按光标显隐：
  // 光标不在转义段上就折叠（零占位）、落在被转义字符上（或选中它）就显示出来、仍是暗色。
  // 修法：模型/字节一个都不动，只在**装饰层**把 `\X` 拆成
  // `<span class="md-escape-backslash">\</span><span class="md-escape-char">X</span>`
  // （`data-md-escape` 仍由 MdEscape 的 renderHTML 承载，解析语义不变），
  // 反斜杠 span 的显隐**复用 `.md-marker` 那一套**：折叠 = `font-size: 0`（零占位，
  // 不用 display:none——那会破坏光标导航与命中），显示 = 装饰给它加 `.md-reveal-inline`
  // （同一元素上的复合类）+ 暗色。判据也与 mdMarker 构造逐字一致：
  // `from <= run.end && to >= run.start`（左右边界均含，贴着段两端也算「在里面」）。
  // 连续段整体性：反斜杠之间只隔着各自的被转义字符时算**一段**（`\*\*\*\*` = 1 段 4 个，
  // 4 个同显同隐）；中间隔着别的字符（`\* \*` 的空格）就是两段，各显各的。
  const ESCAPE_PROBE = `JSON.stringify((() => {
    const bs = [...document.querySelectorAll('.md-escape-backslash')]
    const chars = [...document.querySelectorAll('.md-escape-char')]
    const para = document.querySelector('.ProseMirror p')
    const style = (el) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { color: cs.color, fontSize: cs.fontSize, display: cs.display,
               visibility: cs.visibility, opacity: cs.opacity, w: r.width, h: r.height }
    }
    // 「可见」与 .md-marker 的既有断言**同一口径**：fontSize 不为 0 + display 不是 none
    // + visibility 可见 + 有实际宽度（隐藏态断的就是 rect 宽度 === 0）
    const visible = (el) => {
      const s = style(el)
      return !!s && s.fontSize !== '0px' && s.display !== 'none' &&
             s.visibility === 'visible' && s.w > 0 && s.h > 0
    }
    return {
      theme: document.documentElement.className,
      backslashes: bs.length,
      chars: chars.length,
      bsText: bs.map((e) => e.textContent).join(''),
      bsStyle: style(bs[0]),
      charStyle: style(chars[0]),
      // 逐个反斜杠 span：文本 + 是否带显隐类 + 是否可见 + 颜色/字号/占位
      spans: bs.map((e) => {
        const s = style(e)
        return { text: e.textContent, revealed: e.classList.contains('md-reveal-inline'),
                 visible: visible(e), color: s.color, fontSize: s.fontSize,
                 display: s.display, visibility: s.visibility, w: s.w, h: s.h }
      }),
      revealedCount: bs.filter((e) => e.classList.contains('md-reveal-inline')).length,
      visibleCount: bs.filter(visible).length,
      hiddenZeroWidth: bs.every((e) => e.getBoundingClientRect().width === 0),
      bodyColor: para ? getComputedStyle(para).color : null,
      paraText: para ? para.textContent : null,
      paraHTML: para ? para.innerHTML : null,
      wrappers: document.querySelectorAll('.md-escape[data-md-escape]').length,
      docText: window.__L.ed().state.doc.textContent
    }
  })())`
  /** 单个 span 是否「折叠」：零字号零宽，但仍在布局里（display 不是 none、visibility 可见）
      —— 与 .md-marker 隐藏态同一口径（font-size: 0） */
  function spanHidden(s) {
    return (
      !s.revealed &&
      s.fontSize === '0px' &&
      s.display !== 'none' &&
      s.visibility === 'visible' &&
      s.w === 0
    )
  }
  /** 单个 span 是否「显示且暗色」：字号恢复、实际占位、颜色与正文不同 */
  function spanShownDim(s, bodyColor) {
    return (
      s.revealed &&
      s.fontSize !== '0px' &&
      s.display !== 'none' &&
      s.visibility === 'visible' &&
      s.w > 0 &&
      s.h > 0 &&
      s.color !== bodyColor
    )
  }
  /** 全部反斜杠都折叠（光标不在该转义段上） */
  function escapeAllHidden(p) {
    return (
      p.backslashes > 0 &&
      p.revealedCount === 0 &&
      p.visibleCount === 0 &&
      p.spans.every(spanHidden)
    )
  }
  /** n 个反斜杠**同时**显示且都是暗色（连续段整体性） */
  function escapeAllShownDim(p, n) {
    return (
      p.backslashes === n &&
      p.spans.length === n &&
      p.revealedCount === n &&
      p.visibleCount === n &&
      p.spans.every((s) => spanShownDim(s, p.bodyColor))
    )
  }
  /** span 的紧凑诊断串：`显示/暗` 或 `折叠` */
  function spanSig(p) {
    return p.spans
      .map((s) =>
        spanShownDim(s, p.bodyColor) ? '显' : spanHidden(s) ? '隐' : `?(${s.fontSize}/${s.w})`
      )
      .join('')
  }

  const themeBackup = await app.ev(`window.__L.settings().theme`)
  // H1：装载被转义后的源码；光标先放在**另一段**（远离转义）⇒ 反斜杠必须**折叠不可见**
  await openDoc('\\*\\*\\*\\*\n\n尾行\n')
  await caretEnd()
  await sleep(200)
  const esc1 = JSON.parse(await app.ev(ESCAPE_PROBE))
  const bytes1 = await app.ev(FLUSH)
  report.check(
    '转义反斜杠 · 拆成两个 span（`\\X`：反斜杠 span + 字面字符 span）',
    esc1.backslashes === 4 && esc1.chars === 4 && esc1.bsText === '\\\\\\\\' && esc1.wrappers === 1,
    `backslash=${esc1.backslashes} char=${esc1.chars} bsText=${JSON.stringify(esc1.bsText)} ` +
      `data-md-escape 包裹=${esc1.wrappers} | ${esc1.paraHTML}`
  )
  report.check(
    '转义反斜杠 · 光标在别的段 ⇒ **折叠不可见**（font-size:0 零字号，与 .md-marker 同口径）',
    escapeAllHidden(esc1),
    `revealed=${esc1.revealedCount} visible=${esc1.visibleCount} spans=${spanSig(esc1)} ` +
      `fontSize=${JSON.stringify(esc1.spans.map((s) => s.fontSize))}`
  )
  report.check(
    '转义反斜杠 · 折叠态零占位且仍可命中（4 个都是 rect 宽 0 / display≠none / visibility:visible）',
    esc1.backslashes === 4 &&
      esc1.hiddenZeroWidth &&
      esc1.spans.every((s) => s.display !== 'none' && s.visibility === 'visible'),
    `widths=${JSON.stringify(esc1.spans.map((s) => s.w))} ` +
      `display=${JSON.stringify(esc1.spans.map((s) => s.display))}`
  )
  report.check(
    '转义反斜杠 · textContent 不变（`\\*\\*\\*\\*尾行`）且落盘字节不变',
    esc1.docText === '\\*\\*\\*\\*尾行' && bytes1 === '\\*\\*\\*\\*\n\n尾行\n',
    `docText=${JSON.stringify(esc1.docText)} 字节=${JSON.stringify(bytes1)}`
  )

  // H2：光标落在该转义段内（第一处 / 最后一处 / 选中整段）⇒ 该段 **4 个反斜杠同时可见**且暗色。
  // 绝对位置：段落内容从 1 起，`\*\*\*\*` = [1,9)；被转义的字符在 2/4/6/8。
  // 用 caretAbs（绝对位置）而不是 caretAt（块内偏移）：上一条用例已把光标移到**第二段**，
  // 块内偏移会以第二段为基准算到错误的段落上。
  for (const c of [
    { label: '落在第一处被转义字符上（`\\*|*\\*\\*`）', pos: 2 },
    { label: '落在最后一处被转义字符上（`\\*\\*\\*|*`）', pos: 8 }
  ]) {
    await caretAbs(c.pos)
    await sleep(200)
    const p = JSON.parse(await app.ev(ESCAPE_PROBE))
    report.check(
      `转义反斜杠 · 光标${c.label} ⇒ 4 个**同时**可见且暗色`,
      escapeAllShownDim(p, 4),
      `revealed=${p.revealedCount} visible=${p.visibleCount} spans=${spanSig(p)} ` +
        `反斜杠色=${JSON.stringify(p.spans.map((s) => s.color))} 正文色=${p.bodyColor}`
    )
  }
  // 选中整段（绝对 [1,9) ⇒ 块内 [0,8)）
  await caretAbs(2)
  await selectRange(0, 8)
  await sleep(200)
  const escSel = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 选中整个转义段 ⇒ 4 个**同时**可见且暗色',
    escapeAllShownDim(escSel, 4),
    `revealed=${escSel.revealedCount} visible=${escSel.visibleCount} spans=${spanSig(escSel)}`
  )
  report.check(
    '转义反斜杠 · 字面字符（`.md-escape-char`）始终是正文色（不随反斜杠显隐改变）',
    escSel.charStyle?.color === escSel.bodyColor,
    `字面字符=${escSel.charStyle?.color} 正文=${escSel.bodyColor}`
  )
  // 光标移出转义段（回第二段）⇒ 重新折叠（显隐双向，不留半显）
  await caretEnd()
  await sleep(200)
  const escOut = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 光标移出后重新折叠（显隐是双向的，不是一次性展开）',
    escapeAllHidden(escOut),
    `revealed=${escOut.revealedCount} spans=${spanSig(escOut)}`
  )

  // H3：连续段整体性（本次要求的核心）——
  // `\*\*\*\*`（4 个转义两两相接）= **1 段**：光标在段内**任一**位置，4 个反斜杠同显；
  // `\* \*`（中间有空格）= **2 段**：只显示光标所在的那一段。
  await openDoc('\\*\\*\\*\\*\n')
  let fourTogether = true
  const fourDiag = []
  for (const caret of [1, 3, 5, 7, 2, 4, 6]) {
    await caretAt(caret)
    await sleep(160)
    const p = JSON.parse(await app.ev(ESCAPE_PROBE))
    fourDiag.push(`${caret}:${spanSig(p)}`)
    if (!escapeAllShownDim(p, 4)) fourTogether = false
  }
  report.check(
    '转义反斜杠 · 连续段整体性：`\\*\\*\\*\\*` 光标在任一位置 ⇒ 4 个反斜杠**同时**可见',
    fourTogether,
    fourDiag.join(' ')
  )
  // 边界口径（与 `.md-marker` 逐字一致）：光标**紧贴**段的两端也算「在该构造内」⇒ 显示。
  // 理由：`**x**` 的同一判据（from <= run.end && to >= run.start）在贴着标记两端时也展开标记；
  // 用户在段首/段尾接着编辑时不该出现「刚打完就看不见了」。
  let edgeTogether = true
  const edgeDiag = []
  for (const caret of [0, 8]) {
    await caretAt(caret)
    await sleep(160)
    const p = JSON.parse(await app.ev(ESCAPE_PROBE))
    edgeDiag.push(`${caret}:${spanSig(p)}`)
    if (!escapeAllShownDim(p, 4)) edgeTogether = false
  }
  report.check(
    '转义反斜杠 · 边界口径同 mdMarker：光标紧贴段两端（`|\\*…` / `…*|`）也显示',
    edgeTogether,
    edgeDiag.join(' ')
  )
  // 两段：`\* \*`（段 1 = 偏移 [0,2)、段 2 = [3,5)），光标在第 1 段 ⇒ 只显第 1 个
  await openDoc('\\* \\*\n')
  await caretAt(1)
  await sleep(160)
  const two1 = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 两段 `\\* \\*`：光标在第 1 段 ⇒ 只显第 1 个（段为单位，不整行连坐）',
    two1.spans.length === 2 &&
      spanShownDim(two1.spans[0], two1.bodyColor) &&
      spanHidden(two1.spans[1]),
    `spans=${spanSig(two1)} fontSize=${JSON.stringify(two1.spans.map((s) => s.fontSize))}`
  )
  // 光标在第 2 段 ⇒ 只显第 2 个
  await caretAt(4)
  await sleep(160)
  const two2 = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 两段 `\\* \\*`：光标在第 2 段 ⇒ 只显第 2 个',
    two2.spans.length === 2 &&
      spanHidden(two2.spans[0]) &&
      spanShownDim(two2.spans[1], two2.bodyColor),
    `spans=${spanSig(two2)}`
  )
  // 光标落在两段之间的空格上（块内偏移 2 = 第 1 段的右边界）：按「边界均含」只显第 1 段
  await caretAt(2)
  await sleep(160)
  const twoMid = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 两段之间（光标在空格上）：按 mdMarker 的「边界均含」只显第 1 段',
    twoMid.spans.length === 2 &&
      spanShownDim(twoMid.spans[0], twoMid.bodyColor) &&
      spanHidden(twoMid.spans[1]),
    `spans=${spanSig(twoMid)}`
  )

  // H4：键盘移动光标跨越转义段边界 ⇒ 显隐正确切换（用套件既有的真实按键路径 pressKey）
  // `前\*\*\*\*后`：转义段 = 绝对 [2,10)，前后都是普通文字（`后` 在 10）。
  await openDoc('前\\*\\*\\*\\*后\n')
  await caretAbs(10) // 段末（最后一处被转义字符之后、`后` 之前）⇒ 显示
  await sleep(200)
  const kb1 = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 键盘：光标停在段末 ⇒ 4 个显示',
    escapeAllShownDim(kb1, 4),
    `spans=${spanSig(kb1)}`
  )
  await pressKey(app.send, { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
  await sleep(200)
  const kb2 = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 键盘：→ 跨出转义段 ⇒ 4 个折叠',
    escapeAllHidden(kb2),
    `spans=${spanSig(kb2)}`
  )
  await pressKey(app.send, { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 })
  await sleep(200)
  const kb3 = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 键盘：← 跨回段末 ⇒ 4 个重新显示',
    escapeAllShownDim(kb3, 4),
    `spans=${spanSig(kb3)}`
  )

  // H5：三套主题都要能读（light / dark / sepia 的 --ink-3 各不相同）：
  // 光标在别段 ⇒ 折叠；光标落在转义段内 ⇒ 4 个同时可见且暗色（与正文色可区分）
  for (const theme of ['light', 'dark', 'sepia']) {
    await app.ev(
      `(() => { window.__L.settings().set('theme', ${JSON.stringify(theme)}); return 'ok' })()`
    )
    await sleep(250)
    await openDoc('\\*\\*\\*\\*\n\n尾行\n')
    await caretEnd()
    await sleep(200)
    const off = JSON.parse(await app.ev(ESCAPE_PROBE))
    report.check(
      `转义反斜杠 · 主题 ${theme}：光标在别段 ⇒ 折叠（font-size:0）`,
      escapeAllHidden(off) && off.bsStyle?.fontSize === '0px',
      `theme=${off.theme} spans=${spanSig(off)} fontSize=${off.bsStyle?.fontSize}`
    )
    await caretAbs(2)
    await sleep(200)
    const on = JSON.parse(await app.ev(ESCAPE_PROBE))
    report.check(
      `转义反斜杠 · 主题 ${theme}：光标落在段内 ⇒ 4 个可见 + 暗色（与正文色不同）`,
      escapeAllShownDim(on, 4) && on.spans.every((s) => s.color !== on.charStyle?.color),
      `theme=${on.theme} 反斜杠=${on.bsStyle?.color} 字面字符=${on.charStyle?.color} 正文=${on.bodyColor}`
    )
  }
  await app.ev(
    `(() => { window.__L.settings().set('theme', ${JSON.stringify(themeBackup)}); return 'ok' })()`
  )
  await sleep(200)
  // H6：实时键入的转义（`\*`）也要拆 + 按同一判据显隐 —— 走的是同一条 mark
  await openDoc('\n')
  await caretAt(0)
  await typeChars('\\*')
  await checkState('手打 `\\*` 实时路径', {
    content: '\\*\n',
    caret: 2,
    sig: `${JSON.stringify('\\*')}<mdEscape>`,
    roundTrip: false
  })
  const escTyped = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 实时键入的 `\\*` 同样拆两个 span',
    escTyped.backslashes === 1 && escTyped.chars === 1 && escTyped.bsText === '\\',
    JSON.stringify({ bs: escTyped.backslashes, ch: escTyped.chars, text: escTyped.bsText })
  )
  report.check(
    '转义反斜杠 · 实时键入后光标紧贴段末 ⇒ 显示（与 mdMarker 打着字就展开一致）',
    escapeAllShownDim(escTyped, 1),
    `caret=2 spans=${spanSig(escTyped)}`
  )
  // 接着打 `b`：光标随打字移出转义段（`\*b`，段 = [1,3)）⇒ 折叠，字节仍然只有这一处 `\`
  await typeChars('b')
  const escTypedOut = JSON.parse(await app.ev(ESCAPE_PROBE))
  const bytesTypedOut = await app.ev(FLUSH)
  report.check(
    '转义反斜杠 · 实时键入后光标移出段末（`\\*b`）⇒ 折叠，且落盘字节不变',
    escapeAllHidden(escTypedOut) && escTypedOut.docText === '\\*b' && bytesTypedOut === '\\*b\n',
    `docText=${JSON.stringify(escTypedOut.docText)} spans=${spanSig(escTypedOut)} ` +
      `字节=${JSON.stringify(bytesTypedOut)}`
  )

  // H7：**非标点的 `\X` 不参与光标显隐**（Windows 路径 `C:\a\b`）——
  // 取证（隔离实例实测）：`C:\Users\x` 在装载路径上同样是 **MdEscape 文本节点**
  // （`patchEscapeRule` 的分支 ③ 把不可转义字符也原样保留、逐字写回），但它不是
  // CommonMark 语义上的转义；若一起折叠，屏幕上会少字符（`C:Usersx`）。
  // 所以装饰永远给它 `.md-reveal-inline`（= 常显暗色），判据是被转义字符属不属于
  // 既有常量 ASCII_PUNCT（CommonMark 的可转义集合）。
  await openDoc('Windows 路径 C:\\a\\b 结束\n')
  await caretEnd()
  await sleep(200)
  const pthOff = JSON.parse(await app.ev(ESCAPE_PROBE))
  const pthBytes = await app.ev(FLUSH)
  report.check(
    '转义反斜杠 · 非标点 `\\X`（路径 `C:\\a\\b`）光标在别处也**常显**（不进按光标显隐那一档）',
    pthOff.backslashes === 2 && pthOff.spans.every((s) => spanShownDim(s, pthOff.bodyColor)),
    `spans=${spanSig(pthOff)} fontSize=${JSON.stringify(pthOff.spans.map((s) => s.fontSize))}`
  )
  report.check(
    '转义反斜杠 · 路径的 `textContent` 与落盘字节不变（`C:\\a\\b`）',
    pthOff.docText === 'Windows 路径 C:\\a\\b 结束' && pthBytes === 'Windows 路径 C:\\a\\b 结束\n',
    `docText=${JSON.stringify(pthOff.docText)} 字节=${JSON.stringify(pthBytes)}`
  )
  await caretAbs(17) // 光标落进路径中间（`C:\a\|b`）——非标点反斜杠照样常显，不因光标在段内而变
  await sleep(200)
  const pthOn = JSON.parse(await app.ev(ESCAPE_PROBE))
  report.check(
    '转义反斜杠 · 路径光标落在段内/段外都常显（显隐与光标无关）',
    pthOn.backslashes === 2 && pthOn.spans.every((s) => spanShownDim(s, pthOn.bodyColor)),
    `spans=${spanSig(pthOn)}`
  )

  // ═══ I. 真实剪贴板粘贴（任务 A 的「粘贴」路径）════════════════════════════════  // 本轮新查出的**字符丢失**（上一轮遗留）：真实 Ctrl+V 粘贴 `**2****2**` 会落成
  // `**2**2**`（少两个星号）。根因不在解析，而在 **tiptap 的 mark 粘贴规则**：
  //   * 真实粘贴走 `clipboardTextParser`（markdown 解析）→ 得到「一个 legacy bold
  //     文本节点 `2****2`」；
  //   * 紧接着 tiptap 的 bold 粘贴规则（`markPasteRule` 的 appendTransaction，
  //     只在 `uiEvent === 'paste'` 时触发）把这批定界符又当语法**消费掉**。
  // 取证：同一 slice 手工插入时，只有加上 `paste`/`uiEvent` 两个 meta 才会丢字符
  // （不带 meta → `**2****2**`；带 meta → `**2**2**`），逐插件复刻 PM 的
  // appendTransaction 循环看到是那些 keyless 的粘贴规则插件改了内容。
  // 修法：四个「安静版」mark（Bold/Italic/Strike/Code）连 `addPasteRules` 一起关掉
  // （与 2026-09-16 关掉它们的输入规则同一理由：本模型的样式由标记文本派生，
  // 任何「把 `**` 吃掉换成 mark」的自动化都会删掉用户的字符）。
  // 用**真的系统剪贴板** + Ctrl+V（合成 ClipboardEvent 走不通：实测它会被当纯文本
  // 直插，与真实粘贴语义不同）。剪贴板会被临时改写 → 前后保存/复原。
  const readClipboard = () => {
    try {
      return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], {
        encoding: 'utf-8'
      })
    } catch {
      return null
    }
  }
  const writeClipboard = (text) =>
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`],
      { stdio: 'ignore' }
    )
  let clipboardSaved = undefined
  try {
    clipboardSaved = readClipboard()
  } catch {
    clipboardSaved = undefined
  }
  // ⚠️ 清单 §1.C.3：这套夹具依赖**真实系统剪贴板**。批量跑时（机器更忙、或别的进程在动剪贴板）
  // 一次 `Set-Clipboard` 可能没真正生效，随后的 Ctrl+V 就粘出**上一次的内容**，表现成
  // 「粘贴后少字符」的假回归（实测批量 179/182、单独 182/182）。所以先写一个哨兵值并读回校验，
  // 确认读写通路可用；每次写完也读回校验，不一致就**如实 SKIP**，不把它算成编辑器丢字符。
  const CLIP_SENTINEL = `lumin-clip-${Date.now()}`
  let clipUsable = false
  if (clipboardSaved !== null) {
    try {
      writeClipboard(CLIP_SENTINEL)
      clipUsable = (readClipboard() ?? '').trim() === CLIP_SENTINEL
    } catch {
      clipUsable = false
    }
  }
  if (clipboardSaved === null || !clipUsable) {
    report.skip(
      '真实剪贴板粘贴（字节保真）',
      clipboardSaved === null
        ? 'Set-Clipboard/Get-Clipboard 不可用（非 Windows 或权限受限）——请手工复跑'
        : `剪贴板读回校验失败（写 ${CLIP_SENTINEL} 后读到的不是它）—— 环境问题，不当成编辑器缺陷`
    )
  } else {
    for (const md of ['**2****2**', '**a * b**', '**加粗**']) {
      await openDoc('\n')
      await caretAt(0)
      writeClipboard(md)
      const back = (() => {
        try {
          return readClipboard()
        } catch {
          return null
        }
      })()
      if ((back ?? '').trim() !== md) {
        report.skip(
          `真实粘贴 ${md}`,
          `剪贴板没写进去（读回=${JSON.stringify((back ?? '').slice(0, 40))}）—— 环境问题`
        )
        continue
      }
      await sleep(250)
      await pressKey(app.send, { key: 'v', code: 'KeyV', vk: 86, modifiers: 2 })
      await sleep(400)
      // 逐字节 + 「保存→重开→再序列化」往返（节点 marks 另有 G 组断言覆盖）
      await checkState(`真实粘贴 ${md}`, { content: md + '\n' })
    }
    try {
      writeClipboard(clipboardSaved)
    } catch {
      /* 复原失败不影响结论 */
    }
  }

  // ═══ J. 用户报障夹具：CJK 标点旁的 `**…**` 必须成对（本轮，永久断言）═══════════
  // 原话现场：`……押在了**「保存路径」与「Markdown 保真」**这两件……` 整段渲染成**字面星号**
  // （加粗没了、加粗区间整体错位）。根因**不在**本仓库的「字面量化」，而在
  // **markdown-it 的 flanking 判定**：`「`/`」`/`：` 这类全角标点算「标点」，
  // 于是「后面跟标点、前面既不是空白也不是标点」的 `**` 不算 left-flanking ⇒ 不能开，
  // 与之配对的 `」**` 也不能合（stock markdown-it 默认 preset 实测就是这个结果）。
  // 修法：在 markdown-it 那一层定 CJK 口径（`cjkEmphasis.ts` + `inlineMarkerCore.scanDelimsCjk`），
  // 让「加载/刷新」与「实时重推」共用同一条规则。
  //
  // 断言口径（每条都查三件事，缺一就会漏掉真实缺陷）：
  //   · strong 的**个数与每个的 textContent**（与 markdown-it 解析同一段的结果一致）；
  //   · `getMarkdown()`（落盘字节）与输入**逐字节一致**；
  //   · **不许出现字面量化的标记**（`.md-marker[data-side="literal"]` = 0）与
  //     被字面量化的 `**`（`.md-escape` 里包着 `**` 的 = 0）。
  const FIXTURE =
    '**一句话**：这是一个**工程素养明显高于平均水平**的桌面应用 —— 安全基线正确、踩坑记录齐全、验收文化扎实、冷启动实测不到 1 秒；' +
    '但它把最重的风险押在了**「保存路径」与「Markdown 保真」**这两件写作工具的信：' +
    '**写盘不是原子操作、没有本地历史、没有任何往返保真验收**。' +
    '工程侧最拖后腿的是 **`npm run lint` 目前是坏的（912 errors）**、**没有 CI / 没有单元测试**、以及**验收脚本没有统一入口**。'
  // 8 个 `<strong>` 元素 = 7 个逻辑加粗（`` `npm run lint` `` 那段是「粗+码」的样式集合，
  // 按本模型「一个样式集合只出一个元素」的既有呈现拆成 2 个：代码 wbr 段 + 其余正文）
  const FIXTURE_STRONGS = [
    '一句话',
    '工程素养明显高于平均水平',
    '「保存路径」与「Markdown 保真」',
    '写盘不是原子操作、没有本地历史、没有任何往返保真验收',
    'npm run lint',
    ' 目前是坏的（912 errors）',
    '没有 CI / 没有单元测试',
    '验收脚本没有统一入口'
  ]
  /** 夹具体检：实时渲染结构 + 落盘字节 + 对照基准（markdown-it 自己解析同一段） */
  const FIXTURE_PROBE = `JSON.stringify((() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    const html = ed.storage.markdown.parser.parse(${JSON.stringify(FIXTURE)})
    const textOnly = html.replace(/<[^>]*>/g, '')
    const strongs = pm ? [...pm.querySelectorAll('strong')] : []
    return {
      strongs: strongs.map((s) => s.textContent),
      literalMarkers: pm ? pm.querySelectorAll('.md-marker[data-side="literal"]').length : -1,
      escapedStars: pm
        ? [...pm.querySelectorAll('.md-escape[data-md-escape]')].filter((e) => (e.textContent || '').includes('**')).length
        : -1,
      docText: ed.state.doc.textContent,
      baselineStrongs: (html.match(/<strong>/g) || []).length,
      baselineLiteralStars: (textOnly.match(/\\*\\*/g) || []).length
    }
  })())`
  /** 一条路径的夹具断言（三条写入路径都过同一套） */
  async function checkFixture(label) {
    const p = JSON.parse(await app.ev(FIXTURE_PROBE))
    const bytes = await app.ev(FLUSH)
    report.check(
      `夹具 ${label} · strong 个数与每个内容`,
      JSON.stringify(p.strongs) === JSON.stringify(FIXTURE_STRONGS),
      `实际 ${JSON.stringify(p.strongs)}`
    )
    report.check(
      `夹具 ${label} · 没有字面量化的标记/` + '`**`',
      p.literalMarkers === 0 && p.escapedStars === 0,
      `literal=${p.literalMarkers} mdEscape(**)=${p.escapedStars}`
    )
    report.check(
      `夹具 ${label} · docText 与输入逐字节一致`,
      p.docText === FIXTURE,
      `实际 ${JSON.stringify(p.docText).slice(0, 120)}…`
    )
    report.check(
      `夹具 ${label} · getMarkdown 与输入逐字节一致`,
      bytes === FIXTURE + '\n',
      `实际 ${JSON.stringify(bytes).slice(0, 120)}…`
    )
    report.check(
      `夹具 ${label} · 对照基准（markdown-it 解析同一段：7 个 strong、0 处字面 ` + '`**`' + `）`,
      p.baselineStrongs === 7 && p.baselineLiteralStars === 0,
      `baseline strong=${p.baselineStrongs} 字面星号=${p.baselineLiteralStars}`
    )
  }

  // 三条写入路径：① 一次性装载（markdown-it）② 逐字键入 ③ 真实 Ctrl+V 粘贴
  await openDoc(FIXTURE + '\n')
  await checkFixture('① 装载')
  await openDoc('\n')
  await caretAt(0)
  await typeChars(FIXTURE)
  await checkFixture('② 逐字键入')
  if (clipboardSaved !== undefined && clipboardSaved !== null) {
    await openDoc('\n')
    await caretAt(0)
    writeClipboard(FIXTURE)
    await sleep(250)
    await pressKey(app.send, { key: 'v', code: 'KeyV', vk: 86, modifiers: 2 })
    await sleep(500)
    await checkFixture('③ 真实 Ctrl+V')
    try {
      writeClipboard(clipboardSaved)
    } catch {
      /* 复原失败不影响结论 */
    }
  } else {
    report.skip('夹具 ③ 真实 Ctrl+V', 'Set-Clipboard 不可用（非 Windows 或权限受限）')
  }

  // 最小复现：`押在了**「…」**这两件` —— **单独一行**与**放在长段落里**必须得到同一个结论
  // （修之前两者不一致：单独一行被正则当成合法配对 → 加粗；放进整段则被 markdown-it 判成
  //  字面星号 → 整段错位。这条断言钉的就是「同源文本在任何上下文里渲染一致」。）
  for (const md of [
    '押在了**「保存路径」与「Markdown 保真」**这两件',
    '**「保存路径」与「Markdown 保真」**',
    '**（重点）**这是重点',
    '工程侧 **`npm run lint` 坏了（912 errors）**、以及'
  ]) {
    await openDoc(md + '\n')
    const one = JSON.parse(
      await app.ev(`JSON.stringify((() => {
        const pm = document.querySelector('.ProseMirror')
        return {
          strongs: pm ? [...pm.querySelectorAll('strong')].map((s) => s.textContent) : [],
          literal: pm ? pm.querySelectorAll('.md-marker[data-side="literal"]').length : -1
        }
      })())`)
    )
    const bytes = await app.ev(FLUSH)
    report.check(
      `CJK 标点旁成对 ${JSON.stringify(md)}`,
      one.strongs.length >= 1 && one.literal === 0 && bytes === md + '\n',
      `strong=${JSON.stringify(one.strongs)} literal=${one.literal} 字节=${JSON.stringify(bytes)}`
    )
  }

  // ═══ K. 打字每键成本（本轮：不许随文档长度恶化）═══════════════════════════════
  // 现场（用户报障「写入内容变的非常卡」）：每键成本随**文档长度**线性增长 ——
  // appendTransaction 每次事务都会把**全篇**需要归一化的块重算一遍（每个带样式的块
  // 都要走一遍 markdown-it 重推 + 原子归一化）。取证：50 段 ≈3000 字的文档里打字，
  // 每键触发 **51 次** markdown-it 解析（`MarkdownParser.parse`），修复后是 **2 次**。
  // 修法：按块缓存「已归一的块节点」（PM 节点不可变 + 结构共享 ⇒ 没被编辑的块引用不变），
  // 只重算被这次编辑改到的块（见 typoraInlineMarks.appendTransaction 的 normalizeClean）；
  // 装饰同理按块缓存清单（decoCache）。
  //
  // 阈值依据（本机实测，见下方 note 打印的实际值）：
  //   * p95 ≤ 25ms / max ≤ 60ms：实测 p95 0.9~4.6ms、max 1.4~8.2ms ⇒ 留 5~25 倍余量，
  //     既能挡住「退化回每键几十毫秒」的回归，又不会被负载抖动误伤；
  //   * 「文档长度不显著恶化」用 p95 比值 ≤ 2：实测 500 字 vs 3000 字 ≈ 1.0~1.3 倍。
  const PERF_KEYS = 100
  const perfExpr = (n) => `(async () => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    ed.commands.focus('end')
    const parser = ed.storage && ed.storage.markdown && ed.storage.markdown.parser
    const P = (window.__perfProbe = window.__perfProbe || { n: 0 })
    if (parser && !parser.__probeWrapped) {
      const origParse = parser.parse.bind(parser)
      parser.parse = (c, o) => {
        P.n++
        return origParse(c, o)
      }
      parser.__probeWrapped = true
    }
    const before = P.n
    const times = []
    for (let i = 0; i < ${n}; i++) {
      const t0 = performance.now()
      ed.commands.insertContent('甲')
      times.push(performance.now() - t0)
      if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0))
    }
    return JSON.stringify({ times, parseCalls: P.n - before })
  })()`
  const perfOf = (times) => {
    const s = [...times].sort((a, b) => a - b)
    const q = (p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]
    return {
      avg: times.reduce((a, b) => a + b, 0) / times.length,
      p50: q(0.5),
      p95: q(0.95),
      max: Math.max(...times)
    }
  }
  /** 一段 ≈chars 字、内部含标记（`**重点**`/`*斜体*`/`` `代码` ``）的长段落 */
  const perfParagraph = (chars) => {
    const unit = '这是一段用于压测的中文正文**重点**，含标点、顿号、以及*斜体*与`代码`。'
    let s = ''
    while (s.length < chars) s += unit
    return s.slice(0, chars)
  }
  /** N 段、每段都带加粗（模拟「一篇有很多加粗的长文档」） */
  const perfBlocks = (blocks, per) =>
    Array.from(
      { length: blocks },
      (_, i) => `第${i}段：这一段有**加粗**与普通文字，长度约${'x'.repeat(Math.max(0, per - 30))}。`
    ).join('\n\n')

  async function measureTyping(md) {
    await openDoc(md)
    await app.ev(perfExpr(10)) // 预热（首键含块装载后的第一次归一化，不该计入统计）
    await sleep(200)
    const r = JSON.parse(await app.ev(perfExpr(PERF_KEYS)))
    return { ...perfOf(r.times), parseCalls: r.parseCalls }
  }
  const fmt = (m) =>
    `avg=${m.avg.toFixed(2)} p50=${m.p50.toFixed(2)} p95=${m.p95.toFixed(2)} max=${m.max.toFixed(2)}`

  const perfEmpty = await measureTyping('\n')
  const perf500 = await measureTyping(perfParagraph(500) + '\n')
  const perf3000 = await measureTyping(perfParagraph(3000) + '\n')
  const perfDoc500 = await measureTyping(perfBlocks(8, 60) + '\n')
  const perfDoc3000 = await measureTyping(perfBlocks(50, 60) + '\n')
  report.note(
    `性能实测（每键 ms）: 空段落 ${fmt(perfEmpty)}；单段 500 字 ${fmt(perf500)}；单段 3000 字 ${fmt(perf3000)}`
  )
  report.note(
    `性能实测（文档长度维度）: 500 字多段 ${fmt(perfDoc500)}；3000 字多段 ${fmt(perfDoc3000)}；` +
      `每键 markdown-it 解析次数 = ${perfDoc3000.parseCalls / PERF_KEYS}（修复前实测 ≈51）`
  )
  report.check(
    `打字性能 · 空段落对照 p95 ≤ 25ms / max ≤ 60ms`,
    perfEmpty.p95 <= 25 && perfEmpty.max <= 60,
    fmt(perfEmpty)
  )
  report.check(
    `打字性能 · 长段落 3000 字 p95 ≤ 25ms / max ≤ 60ms`,
    perf3000.p95 <= 25 && perf3000.max <= 60,
    fmt(perf3000)
  )
  report.check(
    `打字性能 · 3000 字长文档 p95 ≤ 25ms / max ≤ 60ms`,
    perfDoc3000.p95 <= 25 && perfDoc3000.max <= 60,
    fmt(perfDoc3000)
  )
  report.check(
    '打字性能 · 每键成本不随文档长度恶化（500 字 vs 3000 字多段 p95 比值 ≤ 2）',
    perfDoc3000.p95 <= Math.max(0.5, perfDoc500.p95 * 2),
    `500 字 p95=${perfDoc500.p95.toFixed(2)} → 3000 字 p95=${perfDoc3000.p95.toFixed(2)}`
  )
  report.check(
    '打字性能 · 每键 markdown-it 解析次数与文档长度无关（≤ 4 次/键）',
    perfDoc3000.parseCalls <= PERF_KEYS * 4,
    `${perfDoc3000.parseCalls} 次 / ${PERF_KEYS} 键（修复前 50 段文档实测 5100+ 次）`
  )

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
