'use strict'
// ─── 验收：代码块的撤销（选中文字 → 代码块 → Ctrl+Z / Ctrl+Y）──────────────────
//
// 用户报障（本轮修复的对象）：「选中文字并点击代码块后，确实会出现代码块，
// 但此时我点击 Ctrl+Z 却不会把代码块撤销」。
//
// 根因（两条叠加，见 CodeBlockView.vue 的 `onCmHistoryKey` 注释）：
//   ① 新代码块挂上 CodeMirror 后，选区就在块里 ⇒ NodeView 把焦点交给 CM
//      （`mountCmForVirtualization` 的 `if (selectionInside) focusCmAtEnd()`）；
//   ② `codeBlock.ts` 的 `stopEvent` 把 `.cm-editor` 内的 keydown 整类交还 CM，
//      PM 的全局历史 keymap 收不到事件；而 CM 自己的 `history()` 是**新建的空历史**
//      ⇒ `Mod-z` 被 CM 的 `historyKeymap` 接走却无事可撤 ⇒ 按键被静默吃掉。
//
// 本套件断言的口径（与源码注释里的口径必须逐字一致）：
//   * 「选中文字 → 代码块」= **一个** PM 全局历史步：一次 Ctrl+Z 回到操作前（文字与格式
//     都回到原样，以**序列化 Markdown 文本**为准），Ctrl+Y 一次重做回代码块；
//   * 焦点在代码块内时，一次 Ctrl+Z 同样能撤掉这个操作（这是用户实际遇到的场景），
//     撤掉之后**焦点必须离开 `.cm-editor`**（否则紧接着的 Ctrl+Y 会打在 CM/body 上）；
//   * 块内打字的撤销粒度：`Ctrl+Z` 先撤**块内**的编辑（块还在、正文 Markdown 不变），
//     本地历史耗尽后的下一次 `Ctrl+Z` 才撤到「代码块刚被创建」那一步（块消失）；
//   * 正文里的普通输入**不被打包成一步**：间隔超过合并窗口（500ms）的两次输入分两步，
//     一次 Ctrl+Z 只撤掉后一段；
//   * 代码块内容被撤空（CM 文本变空）时文档必须**真的**跟着变空 —— 这条守的是
//     `schema.text('')` 抛 `RangeError: Empty text nodes are not allowed` 那个静默
//     数据不一致（CM 已空、文档还留着旧文本）。
//
// 跑法：
//   & node_modules\.bin\electron-vite.cmd build
//   node tools\run-suites.js --suite=_verify-undo-codeblock.js
//
// ⚠️ 两个约定：
//   1. 本文件里的 Markdown 围栏一律用 '\u0060' 拼（**不写反引号字符**）：反引号在
//      "套件源码 + 页面表达式"混排时极易截断模板字符串，本仓库约定套件里不出现它；
//   2. 读「序列化 Markdown」一律走 `stableMd()`（等它连续两次读到同一个值）：落盘出口是
//      **250ms 防抖**的，机器忙时固定 sleep 会读到上一代 —— 那是套件假红，不是产品缺陷。

const fs = require('fs')
const {
  connect,
  settle,
  waitEditor,
  showToolbar,
  sleep,
  requireFocus,
  pressKey,
  insertText,
  clickCenter,
  openDocWith,
  instanceLog,
  Reporter,
  fatal
} = require('./lib/harness')

const FENCE = '\u0060\u0060\u0060'
const PARAGRAPH = '这是一段被选中的文字。'
const MD = ['# 标题', '', PARAGRAPH, '', '结尾段落'].join('\n')
const MD_EMPTY_BLOCK = ['# 标题', '', FENCE, FENCE, '', '尾部'].join('\n')

/**
 * 文档文本的比较口径：**去掉末尾换行**再比。
 *
 * 为什么（不是放水）：`openDocWith()` 是直接给 `files.current` 赋夹具原文的，
 * 而落盘的序列化出口（`markdownStorage.getMarkdown`）会补一个且仅补一个末尾换行
 * （`withFinalNewline`）。所以"刚打开夹具"读到的文本没有末尾换行，"编辑器写过一次之后"
 * 读到的有 —— 那是**夹具与序列化出口的差异**，与"代码块有没有被撤销"无关。
 * 判据仍然是"整篇文本逐字节相等"，只是把这一处已知差异归一化掉。
 */
const norm = (s) => String(s == null ? '' : s).replace(/\n+$/, '')

/** 序列化 Markdown（文档文本）——判据一律以它为准，不看 DOM */
const DOC_MD = `(() => {
  const f = window.__L.files()
  return f.current ? f.current.content : null
})()`

/** 顶层块类型清单（判断代码块在不在） */
const BLOCKS = `(() => {
  const ed = window.__L.ed()
  const out = []
  ed.state.doc.descendants((n) => { if (n.isBlock) out.push(n.type.name) })
  return out.join(',')
})()`

/** 代码块节点里的文本 */
const CODE_TEXT = `(() => {
  const ed = window.__L.ed()
  let c = null
  ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c = n.textContent })
  return c
})()`

/** 焦点落在哪：inCm=代码块里 / inPm=正文里 */
const FOCUS = `(() => {
  const ae = document.activeElement
  return JSON.stringify({
    inCm: !!(ae && ae.closest && ae.closest('.cm-editor')),
    inPm: !!(ae && ae.closest && ae.closest('.ProseMirror')),
    docFocus: document.hasFocus()
  })
})()`

/** CM 里的文本（代码块内的 CodeMirror 视图） */
const CM_TEXT = `(() => {
  const el = document.querySelector('.cm-content')
  return el ? el.textContent : null
})()`

/** 选中正文里那段夹具文字（真实用户动作是拖选；这里用等价的 PM 选区） */
const SELECT_PARAGRAPH = `(() => {
  const ed = window.__L.ed()
  let range = null
  ed.state.doc.descendants((n, pos) => {
    if (range) return false
    if (n.type.name === 'paragraph' && n.textContent.indexOf('被选中') >= 0) {
      range = { from: pos + 1, to: pos + 1 + n.content.size }
    }
    return true
  })
  if (!range) return 'null'
  ed.commands.setTextSelection(range)
  ed.commands.focus()
  return JSON.stringify(range)
})()`

/**
 * 读「实例主进程日志」在本轮操作里**新增**的那一段。
 *
 * 渲染层 `console.error` 会被转发成主进程的 `[renderer:error] …` 行（这是 GUI 子系统里
 * 唯一可读的出口）。CM 会把 updateListener 抛的异常吞成一行日志 —— 也就是
 * `RangeError: Empty text nodes are not allowed` 那条**页面里捕捉不到**的错误，
 * 所以这条断言只能从日志读。
 */
function logTail(from) {
  const p = instanceLog()
  if (!p || !fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf-8').slice(from)
}

function logSize() {
  const p = instanceLog()
  if (!p || !fs.existsSync(p)) return -1
  return fs.statSync(p).size
}

async function main() {
  const report = new Reporter('验收：代码块撤销（选中文字 → 代码块 → Ctrl+Z / Ctrl+Y）')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  await app.ev(
    `(async () => { if (!window.__L.files().current) await window.__L.files().openUntitled(); return 'ok' })()`
  )
  await waitEditor(app.ev)
  const toolbar = await showToolbar(app)
  report.check('P0 快捷工具栏可用（真实 UI 路径的前提）', toolbar === true, 'toolbar=' + toolbar)
  // 真实按键/指针的前提：窗口在 OS 前台。拿不到就如实 SKIP（见 harness 的 preconditionSkip）
  await requireFocus(app, '代码块撤销：真实按键与指针')

  /** 等序列化 Markdown 落定（防抖 250ms + 账本记账）：连续两次读到同一个值才返回 */
  async function stableMd(minMs = 350, maxMs = 6000) {
    const t0 = Date.now()
    let last = null
    let same = 0
    for (;;) {
      await sleep(180)
      const cur = await app.ev(DOC_MD)
      if (cur === last) {
        same += 1
        if (same >= 2 && Date.now() - t0 >= minMs) return cur
      } else {
        same = 0
        last = cur
      }
      if (Date.now() - t0 > maxMs) return cur
    }
  }

  /** 等文档文本里出现 needle（真实输入被"窗口不在前台"吃掉时如实返回 false） */
  async function waitMdHas(needle, ms = 2500) {
    const end = Date.now() + ms
    for (;;) {
      const md = await app.ev(DOC_MD)
      if (String(md).indexOf(needle) >= 0) return md
      if (Date.now() > end) return md
      await sleep(150)
    }
  }

  /** 每个场景前都换一份新文档：编辑器按 :key 重建 ⇒ 撤销栈是干净的 */
  async function freshDoc(md, name) {
    await openDocWith(app, md, name)
    await sleep(300)
    return stableMd()
  }

  // 工具栏「代码块」按钮：按当前语言包里的 editor.codeBlock 文案定位（不写死中文）
  const lang = await app.ev(`window.__L.settings().language`)
  const label = require('../src/shared/i18n/' + lang + '.json').editor.codeBlock
  const btn = '[data-toolbar-item] button[aria-label="' + label + '"]'
  report.check(
    'P1 工具栏「代码块」按钮存在（用 data-toolbar-item + 语言包文案定位）',
    (await app.ev(`!!document.querySelector(${JSON.stringify(btn)})`)) === true,
    'lang=' + lang + ' selector=' + btn
  )

  // ── ① 选中文字 → 工具栏「代码块」→ 出现代码块 ───────────────────────────────
  const mdBefore = await freshDoc(MD, 'undo-cb-a.md')
  const sel = await app.ev(SELECT_PARAGRAPH)
  await sleep(200)
  await clickCenter(app.send, app.ev, btn)
  const mdCreated = await stableMd()
  const blocksCreated = await app.ev(BLOCKS)
  const codeCreated = await app.ev(CODE_TEXT)
  report.check(
    '① 选中文字 → 点工具栏「代码块」→ 文档里出现代码块（文字进了块里）',
    sel !== 'null' &&
      norm(mdCreated) !== norm(mdBefore) &&
      String(mdCreated).indexOf(FENCE) >= 0 &&
      String(blocksCreated).indexOf('codeBlock') >= 0 &&
      codeCreated === PARAGRAPH,
    JSON.stringify({ sel, blocks: blocksCreated, code: codeCreated, md: mdCreated })
  )

  // ── ② Ctrl+Z 一次 → 代码块消失、原文原样回来（序列化 Markdown 逐字节相等）────
  // 场景要点：这一步按下去时**焦点就在代码块里**（挂载流程会把焦点交给 CM），
  // 也就是用户报障的那个场景。断言里同时记下焦点状态，红的时候能一眼看出是哪种红。
  const focusAfterCreate = JSON.parse(await app.ev(FOCUS))
  await pressKey(app.send, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 })
  const mdUndone = await stableMd()
  const blocksUndone = await app.ev(BLOCKS)
  const focusAfterUndo = JSON.parse(await app.ev(FOCUS))
  report.check(
    '② 焦点在代码块内时一次 Ctrl+Z 就把代码块撤掉（块消失、原文原样回来）',
    focusAfterCreate.inCm === true &&
      String(blocksUndone).indexOf('codeBlock') < 0 &&
      norm(mdUndone) === norm(mdBefore),
    JSON.stringify({
      focusAfterCreate,
      focusAfterUndo,
      blocks: blocksUndone,
      undone: mdUndone,
      expected: mdBefore
    })
  )
  report.check(
    '②b 撤掉代码块后焦点离开代码块（不再落在 .cm-editor 里），Ctrl+Y 才有落点',
    focusAfterUndo.inCm === false && focusAfterUndo.docFocus === true,
    JSON.stringify(focusAfterUndo)
  )

  // ── ③ Ctrl+Y 重做 → 又变回代码块 ─────────────────────────────────────────
  await pressKey(app.send, { key: 'y', code: 'KeyY', vk: 89, modifiers: 2 })
  const mdRedone = await stableMd()
  const blocksRedone = await app.ev(BLOCKS)
  report.check(
    '③ Ctrl+Y 重做 → 代码块回来（序列化 Markdown 与创建后逐字节相等）',
    norm(mdRedone) === norm(mdCreated) && String(blocksRedone).indexOf('codeBlock') >= 0,
    JSON.stringify({ blocks: blocksRedone, redone: mdRedone, expected: mdCreated })
  )

  // ── ④ Ctrl+Shift+Z 也是重做（撤销后同一场景的第二条重做键）───────────────
  await pressKey(app.send, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 })
  const afterUndo4 = await stableMd()
  await pressKey(app.send, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 | 8 })
  const mdRedoneShift = await stableMd()
  report.check(
    '④ Ctrl+Shift+Z 同样是重做（撤销后回到代码块）',
    norm(afterUndo4) === norm(mdBefore) && norm(mdRedoneShift) === norm(mdCreated),
    JSON.stringify({ undone: afterUndo4, redone: mdRedoneShift, expected: mdCreated })
  )

  // ── ⑤ 块内打字后的撤销粒度：先撤块内编辑，再撤「创建代码块」那一步 ──────────
  const mdBefore5 = await freshDoc(MD, 'undo-cb-e.md')
  await app.ev(SELECT_PARAGRAPH)
  await sleep(200)
  await clickCenter(app.send, app.ev, btn)
  const mdCreated5 = await stableMd()
  const typedOk = (await app.ev(FOCUS)).indexOf('"inCm":true') >= 0
  const cmBefore5 = await app.ev(CM_TEXT)
  await insertText(app.send, 'XYZ')
  const mdTypedTry = await waitMdHas('XYZ')
  const mdTyped = await stableMd()
  const cmTyped = await app.ev(CM_TEXT)
  if (String(mdTypedTry).indexOf('XYZ') < 0) {
    report.skip('⑤ 代码块里打字写进文档', '输入没有落地（窗口/CPU 抢占），本段余下断言跳过')
  } else {
    report.check(
      '⑤ 代码块里打字写进文档（块内 CodeMirror 的编辑照常落盘）',
      typedOk === true &&
        String(cmTyped) !== String(cmBefore5) &&
        String(cmTyped).indexOf('XYZ') >= 0 &&
        String(mdTyped).indexOf('XYZ') >= 0,
      JSON.stringify({ typedOk, cmBefore: cmBefore5, cm: cmTyped, md: mdTyped })
    )
  }
  await pressKey(app.send, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 })
  const mdAfterLocalUndo = await stableMd()
  const blocksAfterLocalUndo = await app.ev(BLOCKS)
  report.check(
    '⑤b 块内 Ctrl+Z 先撤**块内**的编辑：块还在、正文 Markdown 回到刚创建时的样子',
    String(blocksAfterLocalUndo).indexOf('codeBlock') >= 0 &&
      norm(mdAfterLocalUndo) === norm(mdCreated5),
    JSON.stringify({ blocks: blocksAfterLocalUndo, md: mdAfterLocalUndo, expected: mdCreated5 })
  )
  await pressKey(app.send, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 })
  const mdAfterStepUndo = await stableMd()
  report.check(
    '⑤c 块内历史耗尽后继续撤外层：下一 Ctrl+Z 撤到「代码块刚被创建」那一步（块消失、原文回来）',
    norm(mdAfterStepUndo) === norm(mdBefore5),
    JSON.stringify({ md: mdAfterStepUndo, expected: mdBefore5 })
  )

  // ── ⑥ 正文里普通输入的撤销粒度不被打包：间隔 > 合并窗口的两次输入分两步 ─────
  const mdBefore6 = await freshDoc(MD, 'undo-cb-f.md')
  await app.ev(`(() => {
    const ed = window.__L.ed()
    let pos = null
    ed.state.doc.descendants((n, p) => {
      if (pos === null && n.type.name === 'paragraph' && n.textContent.indexOf('被选中') >= 0) pos = p + 1 + n.content.size
      return true
    })
    ed.commands.setTextSelection(pos)
    ed.commands.focus()
    return 'ok'
  })()`)
  await sleep(150)
  await insertText(app.send, 'AAA')
  const mdA = await waitMdHas('AAA')
  await stableMd()
  await sleep(700) // > prosemirror-history 的 newGroupDelay(500ms)：两段输入必须分成两步
  await insertText(app.send, 'BBB')
  const mdTwoTyped = await waitMdHas('BBB')
  await stableMd()
  if (String(mdA).indexOf('AAA') < 0 || String(mdTwoTyped).indexOf('BBB') < 0) {
    report.skip('⑥ 正文普通输入的撤销粒度', '输入没有落地（窗口/CPU 抢占）')
  } else {
    await pressKey(app.send, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 })
    const mdOneUndone = await stableMd()
    report.check(
      '⑥ 正文普通输入不被打包成一步：一次 Ctrl+Z 只撤掉后一段（前一段保留）',
      String(mdTwoTyped).indexOf('AAABBB') >= 0 &&
        String(mdOneUndone).indexOf('AAA') >= 0 &&
        String(mdOneUndone).indexOf('BBB') < 0 &&
        norm(mdOneUndone) !== norm(mdBefore6) &&
        norm(mdOneUndone) !== norm(mdTwoTyped),
      JSON.stringify({ typed: mdTwoTyped, undone: mdOneUndone })
    )
  }

  // ── ⑦ 代码块内容被撤空：文档必须真的变空（守 RangeError 那条静默不一致）──────
  const logFrom = logSize()
  await freshDoc(MD_EMPTY_BLOCK, 'undo-cb-g.md')
  await clickCenter(app.send, app.ev, 'pre.cb-static').catch(() => {})
  await sleep(200)
  await clickCenter(app.send, app.ev, '.cm-content')
  await sleep(300)
  const inCm7 = (await app.ev(FOCUS)).indexOf('"inCm":true') >= 0
  await insertText(app.send, 'abc')
  const mdTyped7 = await waitMdHas('abc')
  await stableMd()
  await pressKey(app.send, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 })
  await sleep(300)
  const cmAfter7 = await app.ev(CM_TEXT)
  const mdAfter7 = await stableMd()
  const tail = logTail(logFrom)
  report.check(
    '⑦ 空代码块里打字后 Ctrl+Z：CM 与文档一起变空（不静默不一致）',
    inCm7 === true &&
      String(mdTyped7).indexOf('abc') >= 0 &&
      String(cmAfter7) === '' &&
      norm(mdAfter7) !== norm(mdTyped7) &&
      String(mdAfter7).indexOf('abc') < 0,
    JSON.stringify({ inCm: inCm7, typed: mdTyped7, cm: cmAfter7, undone: mdAfter7 })
  )
  // 主进程日志只有隔离实例才写得出来（`start-isolated.ps1` 的 -RedirectStandardOutput，
  // 路径经 LUMIN_INSTANCE_LOG 传给套件）。手工起实例时读不到 ⇒ 如实 SKIP，不判红。
  if (tail === null) {
    report.skip(
      '⑦b 渲染层没有抛 RangeError: Empty text nodes are not allowed',
      '读不到实例日志（LUMIN_INSTANCE_LOG 未设置；请用 run-suites 或 start-isolated.ps1 起实例）'
    )
  } else {
    report.check(
      '⑦b 渲染层没有抛 RangeError: Empty text nodes are not allowed（CM 会把它吞成日志）',
      tail.indexOf('Empty text nodes are not allowed') < 0,
      JSON.stringify(tail.slice(-200))
    )
  }

  // 收尾：把焦点还给正文，别把光标留在岛里（后续套件复用同一实例时更干净）
  await app.ev(`(() => { const ed = window.__L.ed(); if (ed) ed.commands.focus(); return 'ok' })()`)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
