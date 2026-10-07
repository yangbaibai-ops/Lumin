// ─── 多光标验收（报告 §P2「功能缺口：多光标」）─────────────────────────────────
//
// 判据全部落在 **DOM 与文本**上（不看内部对象）：
//   A. 代码块里选中一个词后连按 Mod-d → 出现**多个**光标（`.cm-cursor` 是 drawSelection 画的）
//   B. 多光标状态下打字 → 同一段文本在**多个位置**同时出现（这才是用户真正要的效果）
//   C. Alt+点击第二个位置 → 也变成两个光标（鼠标路线）
//   D. 反向证据：**源码模式是 textarea**，同样按 Mod-d **不该**出现任何 CM 光标（边界如实钉住，
//      免得文档写成"全应用支持多光标"）
//
// ⚠️ 为什么必须验 DOM：多光标只在"状态层允许多选区 + 视图层画多光标"两件事都对时才成立，
// 只看 `state.selection.ranges` 会漏掉"状态对了但没画出来"（那时用户看到的光标还是一个）。
'use strict'
const {
  connect,
  settle,
  sleep,
  openDocWith,
  pressKey,
  insertText,
  requireFocus,
  Reporter,
  fatal
} = require('./lib/harness')

const MD = [
  '# 多光标',
  '',
  '```js',
  'const alpha = 1',
  'const beta = 2',
  'const gamma = 3',
  '```',
  ''
].join('\n')

/** 代码块里可见的 CM 光标个数（drawSelection 每个选区画一个 .cm-cursor） */
const CURSORS = `document.querySelectorAll('.code-block-shell .cm-cursor, .cm-editor .cm-cursor').length`

/** 某个 CM 实例的文本（把所有 cm-line 拼起来；用来数"同一段文字出现了几次"） */
const CM_TEXT = `(() => {
  const ed = document.querySelector('.cm-editor')
  if (!ed) return ''
  const view = ed.cmView?.view ?? null
  if (view?.state) return view.state.doc.toString()
  return [...ed.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\\n')
})()`

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const { ev, send } = app
  const report = new Reporter('multicursor')
  const c = (name, cond, detail) => report.check(name, cond, detail)

  /**
   * 前置守卫（仓库规矩：注入真实按键的套件必须先确认窗口拿得到焦点，
   * 否则合成按键会打到空气里 —— 那种红是环境问题，不该伪装成功能回归）。
   *
   * ⚠️ 这里**不能**写 `if (!(await requireFocus(...)))`：`requireFocus` 成功时返回的是
   * `undefined`，`!undefined === true` ⇒ 这段守卫**恒真**，套件永远走 SKIP 分支、
   * 一条断言都不产出（运行器记 NOASSERT）。它拿不到焦点时是自己抛
   * `preconditionSkip`（由 `fatal` 结算成 SKIP 并打印标准前缀），所以这里直接 await。
   */
  await requireFocus(app, '多光标按键段')

  // 打开一个带代码块的文档（不用用户窗口：openDocWith 会新建未命名缓冲区）
  await openDocWith(app, MD, 'lumin-multicursor.md')
  await sleep(500)

  /**
   * ⚠️ 代码块 CM 是**虚拟化**的（F 项）：只有滚进视口附近的那几块才挂 `.cm-editor`，
   * 所以必须先把它滚进视野再等它挂上 —— 直接 `querySelector('.cm-editor')` 会量到"没挂载"，
   * 那是假失败（`_verify-cb-virtualization.js` 的文件头也写了这条）。
   */
  await ev(`(() => {
    const b = document.querySelector('.code-block-wrapper')
    b?.scrollIntoView({ block: 'center' })
    return 'ok'
  })()`)
  let mounted = false
  for (let i = 0; i < 40 && !mounted; i += 1) {
    await sleep(100)
    mounted = (await ev(`!!document.querySelector('.code-block-wrapper .cm-editor')`)) === true
  }
  await sleep(300)
  c('codeblock-cm-mounted', mounted === true, '代码块滚进视野后应挂上 CodeMirror（本套件的前提）')
  if (!mounted) {
    app.close()
    return report.finish()
  }

  // 点进代码块第一行，把光标放进去
  await ev(`(() => {
    const line = document.querySelector('.cm-content .cm-line')
    line?.click?.()
    return 'ok'
  })()`)
  await sleep(300)

  // ── A/B：Mod-d 连按两次 = 选中当前词 + 加选下一处 → 两个光标；再打字 → 两处同时改 ──
  await ev(`(() => {
    // 先把光标放到第一行的 'alpha' 里（点在第 8 个字符附近不可靠，用 DOM 选区定位更稳）
    const view = document.querySelector('.cm-editor')?.cmView?.view
    if (view) {
      const pos = view.state.doc.toString().indexOf('alpha') + 2
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
    }
    return 'ok'
  })()`)
  await sleep(200)
  await pressKey(send, { key: 'd', code: 'KeyD', vk: 68, modifiers: 2 }) // Ctrl+D
  await sleep(250)
  await pressKey(send, { key: 'd', code: 'KeyD', vk: 68, modifiers: 2 })
  await sleep(350)

  const cursors = await ev(CURSORS)
  c(
    'ctrl-d-adds-second-cursor',
    Number(cursors) >= 2,
    `可见光标数=${cursors}（低于 2 说明多选区没生效）`
  )

  const before = String(await ev(CM_TEXT))
  await insertText(send, 'X')
  await sleep(500)
  const after = String(await ev(CM_TEXT))
  const addedAtOnce = (after.match(/X/g) ?? []).length
  c(
    'typing-lands-in-both-places',
    addedAtOnce >= 2,
    `打一个字符后出现 ${addedAtOnce} 处（before=${JSON.stringify(before.slice(0, 40))}）`
  )

  /**
   * ── C：鼠标路线**本轮未做成**，如实记为 SKIP（不假装通过）──────────────────
   * Alt+单击加光标在 CM6 里由内部 facet `clickAddsSelectionRange` 决定，而
   * `@codemirror/view` 6.43 **没有导出**它（实测 `typeof v.clickAddsSelectionRange === 'undefined'`），
   * 所以"Alt+单击加光标"这条路当前拿不到公共 API；Alt+**拖拽**的列选择已通过
   * `rectangularSelection()` + `crosshairCursor()` 打开，但列选择画的是矩形高亮、
   * 不是多个 `.cm-cursor`，本套件不方便用 DOM 判据钉住它。
   * 结论：多光标目前**只保证键盘路线（Mod-d）**；鼠标路线待 CM 暴露相应 API 或改用
   * `EditorView.domEventHandlers` 自行实现后再补断言。
   */
  report.skip(
    'alt-click-adds-cursor',
    'CM 6.43 未导出 clickAddsSelectionRange（Alt+单击加光标拿不到公共 API）；列选择走 Alt+拖拽、判据不同'
  )

  // ── D：边界（如实钉住）：源码模式是 textarea，Mod-d 不该产生 CM 光标 ──
  // 切换入口按 DOM 找（工具栏按钮 / 顶部菜单里的「源码」），找不到就如实 SKIP
  const switched = await ev(`(async () => {
    const btn = document.querySelector('[data-toolbar-id="source"], [title*="源码"], [aria-label*="源码"]')
    if (!btn) return 'no-entry'
    btn.click()
    return 'clicked'
  })()`)
  await sleep(900)
  const inSource = await ev(
    `!!document.querySelector('textarea') && !document.querySelector('.code-block-wrapper .cm-editor')`
  )
  if (!inSource) {
    report.skip(
      'source-mode-has-no-codemirror-cursor',
      `没能确认进入源码模式（切换=${switched}）—— 不假装通过；边界本身写在 CodeBlockView 的扩展注释与台账里`
    )
  } else {
    await pressKey(send, { key: 'd', code: 'KeyD', vk: 68, modifiers: 2 })
    await sleep(300)
    const cmCursorsInSource = await ev(CURSORS)
    report.check(
      'source-mode-has-no-codemirror-cursor',
      cmCursorsInSource === 0,
      `源码模式（textarea）里 CM 光标数=${cmCursorsInSource} —— 期望 0（多光标只在代码块里支持）`
    )
  }

  app.close()
  process.exit(report.finish())
}

main().catch(fatal)
