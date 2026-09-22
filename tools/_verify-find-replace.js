'use strict'
// ─── 验收：编辑器内查找替换（菜单/Ctrl+F/Ctrl+H · 两个编辑面 · 正则 · 替换与全部替换）──
//
// 四件事一起验：
//   1. **入口**：Ctrl+F 只出查找（替换行收起，靠左侧折叠三角展开）；Ctrl+H 直接出替换；
//      再按一次关闭；Esc 关闭；
//   2. **命中**：WYSIWYG 面按文档位置选中最前/下一个/上一个（循环），
//      大小写开关真的改变命中数；正则开关让元字符生效、非法表达式显示「表达式无效」；
//   3. **替换**：只替换当前命中；「全部替换」一次改完并落进 store（两个编辑面各自验一次）；
//   4. **正则替换**：`$1` 按捕获组展开（源码面验一条端到端的）。
//
// 跑法：node tools/_verify-find-replace.js（先起隔离实例）

const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  pressKey,
  clickCenter,
  clickMode,
  waitRestored,
  openDocWith,
  fatal
} = require('./lib/harness')

const MD = ['Alpha alpha ALPHA alpha.', '', '第二段里也有 beta beta。'].join('\n')

/** 查找栏状态 + 当前命中（WYSIWYG 面用文档选区文本，源码面用 textarea 选区文本） */
const STATE = `(() => {
  const f = window.__L.store('find')
  const ed = window.__L.ed()
  let selText = null
  if (ed) {
    const s = ed.state.selection
    selText = ed.state.doc.textBetween(s.from, s.to, ' ')
  }
  const ta = document.querySelector('textarea.source-editor')
  const taSel = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : null
  return JSON.stringify({
    open: f.open,
    regex: f.regex,
    caseSensitive: f.caseSensitive,
    queryValid: f.queryValid,
    replaceExpanded: f.replaceExpanded,
    replaceRows: document.querySelectorAll('[data-find-replace-row]').length,
    disclosure: !!document.querySelector('[data-find-disclosure]'),
    countText: (document.querySelector('[data-find-count]') || {}).textContent?.trim?.() ?? null,
    query: f.query,
    count: f.count,
    index: f.index,
    surface: f.surface,
    bars: document.querySelectorAll('.find-bar').length,
    selText,
    taSel,
    taFocused: !!ta && document.activeElement === ta,
    content: window.__L.files().current?.content ?? ''
  })
})()`

async function ctrlF(app) {
  await pressKey(app.send, { key: 'f', code: 'KeyF', vk: 70, modifiers: 2 })
  await sleep(350)
}

/** Ctrl+H：打开查找栏并直接展开替换行 */
async function ctrlH(app) {
  await pressKey(app.send, { key: 'h', code: 'KeyH', vk: 72, modifiers: 2 })
  await sleep(400)
}

/** 点左侧折叠三角（展开/收起替换行） */
async function clickDisclosure(app) {
  await clickCenter(app.send, app.ev, '[data-find-disclosure]')
  await sleep(300)
}

/**
 * 等正文落进 store（渲染面的替换走 ProseMirror 事务 → markdown 序列化 250ms 防抖）。
 * 不轮询而是「睡一段固定时间」的话，慢机器上会读到**替换前**的正文 —— 实测的假失败来源。
 */
async function waitContent(app, want, timeoutMs = 4000) {
  const t0 = Date.now()
  let last = ''
  for (;;) {
    last = await app.ev(`window.__L.files().current?.content ?? ''`)
    if (String(last).includes(want) || Date.now() - t0 > timeoutMs) return last
    await sleep(150)
  }
}

async function main() {
  const report = new Reporter('验收：编辑器内查找替换')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const backupMode = await app.ev(`window.__L.ui().editorMode`)
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(350)
  // 快捷工具栏出厂默认收起（清单 §1.E 选项②），而本套件的源码面用例要按工具栏上的
  // 模式分段控件切面（`clickMode(app, 2)`）⇒ 显式打开，别依赖 profile 残留状态
  await app.ev(`(() => { window.__L.settings().set('toolbarVisible', true); return 'ok' })()`)
  await sleep(300)
  await openDocWith(app, MD, 'find-replace.md')
  await waitEditor(app.ev)
  await sleep(400)

  // 1) Ctrl+F 打开：只出查找（替换行收起 + 有折叠三角）
  await ctrlF(app)
  let s = JSON.parse(await app.ev(STATE))
  report.check(
    'F1 Ctrl+F 打开查找栏',
    s.open === true && s.bars === 1,
    JSON.stringify(s).slice(0, 160)
  )
  report.check(
    'F1b Ctrl+F 只出查找（替换行收起，左侧有折叠三角）',
    s.replaceExpanded === false && s.replaceRows === 0 && s.disclosure === true,
    `expanded=${s.replaceExpanded} rows=${s.replaceRows} disclosure=${s.disclosure}`
  )

  // 1c) 点折叠三角 → 替换行出现；再点 → 收起
  await clickDisclosure(app)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F1c 点折叠三角 → 下拉出替换行',
    s.replaceExpanded === true && s.replaceRows === 1,
    `expanded=${s.replaceExpanded} rows=${s.replaceRows}`
  )
  await clickDisclosure(app)
  s = JSON.parse(await app.ev(STATE))
  report.check('F1d 再点一次 → 收起替换行', s.replaceExpanded === false && s.replaceRows === 0)

  // 1e) Ctrl+H：直接展开替换（栏已开着时就地展开）
  await ctrlH(app)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F1e Ctrl+H → 直接出现替换行',
    s.open === true && s.replaceExpanded === true && s.replaceRows === 1,
    JSON.stringify(s).slice(0, 160)
  )
  // 关掉再按 Ctrl+H：从关闭状态打开也应该带替换行
  await pressKey(app.send, { key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(250)
  await ctrlH(app)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F1f 关闭后按 Ctrl+H → 打开且带替换行',
    s.open === true && s.replaceExpanded === true && s.replaceRows === 1,
    JSON.stringify(s).slice(0, 160)
  )
  await clickDisclosure(app) // 收起，后面的查找断言按「只有查找」继续

  // 2) 输入查询 → 命中 5 处（大小写不敏感），并选中最前一处
  await app.send('Input.insertText', { text: 'alpha' })
  await sleep(400)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F2 查询命中 4 处且自动选中第一个',
    s.count === 4 && s.index === 0 && s.selText === 'Alpha',
    `count=${s.count} index=${s.index} sel=${JSON.stringify(s.selText)}`
  )

  // 3) 下一个 / 上一个（含循环）
  await pressKey(app.send, { key: 'Enter', code: 'Enter', vk: 13 })
  await sleep(250)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F3 Enter → 下一个命中',
    s.index === 1 && s.selText === 'alpha',
    `index=${s.index} sel=${s.selText}`
  )
  await pressKey(app.send, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 8 }) // Shift+Enter
  await sleep(250)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F4 Shift+Enter → 上一个命中',
    s.index === 0 && s.selText === 'Alpha',
    `index=${s.index} sel=${s.selText}`
  )
  // 从第一个往上 → 绕回最后一个
  await pressKey(app.send, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 8 })
  await sleep(250)
  s = JSON.parse(await app.ev(STATE))
  report.check('F5 在第一个上「上一个」→ 绕回最后一个', s.index === 3, `index=${s.index}`)

  // 4) 大小写开关
  await clickCenter(app.send, app.ev, '.find-case')
  await sleep(350)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F6 「Aa」区分大小写 → 只剩 2 处（都是小写）',
    s.count === 2 && s.selText === 'alpha',
    `count=${s.count} sel=${JSON.stringify(s.selText)}`
  )
  await clickCenter(app.send, app.ev, '.find-case')
  await sleep(300)

  // 5) 替换当前命中（选中的是 Alpha → 换成 Omega）；替换行要先展开
  await clickDisclosure(app)
  s = JSON.parse(await app.ev(STATE))
  report.check('F6b 展开后替换行就位（`.*` 正则开关与 Aa 并列）', s.replaceRows === 1)
  // 正则开关：默认关；打开后 `A.pha` 这类元字符才生效
  const beforeRegex = s.count
  await clickCenter(app.send, app.ev, '[data-find-regex]')
  await sleep(350)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F6c `.*` 开关：同一查询在正则模式下命中数不变（`alpha` 字面量恰好也是合法正则）',
    s.regex === true && s.queryValid === true && s.count === beforeRegex,
    `regex=${s.regex} count=${s.count}（之前 ${beforeRegex}）`
  )
  // 非法表达式：语法错 → 表达式无效 + 零匹配（不炸、不静默退回字面量）
  await app.ev(`window.__L.store('find').setQuery('A(')`)
  await sleep(350)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F6d 非法正则 → 显示「表达式无效」且零匹配',
    s.queryValid === false && s.count === 0 && s.countText === '表达式无效',
    `valid=${s.queryValid} count=${s.count} text=${JSON.stringify(s.countText)}`
  )
  // 复位：关掉正则、恢复查询与大小写（F6 之后是「区分大小写」态，查 alpha 命中 2 处）。
  // 大小写开关在 F6 那段被点过两次（开→关），这里显式置回 true，不依赖前面点了几次。
  await clickCenter(app.send, app.ev, '[data-find-regex]')
  await sleep(250)
  await app.ev(`(() => {
    const f = window.__L.store('find')
    f.setQuery('alpha')
    if (!f.caseSensitive) f.toggleCase()
    f.select(0)
    return 'ok'
  })()`)
  await sleep(350)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F6e 关掉正则并复位查询 → 回到字面量语义（区分大小写下 2 处）',
    s.regex === false && s.caseSensitive === true && s.count === 2,
    `regex=${s.regex} case=${s.caseSensitive} count=${s.count}`
  )
  await app.ev(`window.__L.store('find').select(0)`)
  await sleep(150)

  await clickCenter(app.send, app.ev, '.find-row:last-of-type .find-input')
  await app.send('Input.insertText', { text: 'Omega' })
  await sleep(250)
  // 焦点归属在不同机器上会漂（insertText 偶尔插进查询框），所以用 store 兜一次底；
  // 真正要验的是**替换按钮**这条路，替换串从哪儿来不影响这条断言
  const replNow = await app.ev(`window.__L.store('find').replacement`)
  if (replNow !== 'Omega') {
    await app.ev(`window.__L.store('find').setReplacement('Omega')`)
    await sleep(250)
  }
  await clickCenter(app.send, app.ev, '.find-replace-btn')
  const contentAfterReplace = await waitContent(app, 'Omega')
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F7 「替换」只改当前命中（alpha → Omega，其它大小写写法不动）',
    contentAfterReplace.includes('Alpha Omega ALPHA alpha') &&
      !contentAfterReplace.includes('Alpha alpha'),
    JSON.stringify(contentAfterReplace).slice(0, 120)
  )

  // 6) 全部替换（剩下 3 处 alpha → Omega）
  await clickCenter(app.send, app.ev, '.find-replace-all-btn')
  const contentAfterAll = await waitContent(app, 'ALPHA Omega')
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F8 「全部替换」改完剩下的 3 处（含大小写不同的写法）',
    contentAfterAll.includes('Alpha Omega ALPHA Omega') && s.count === 0,
    `content=${JSON.stringify(contentAfterAll).slice(0, 120)} count=${s.count}`
  )

  // 7) Esc 关闭（store 立即关，DOM 要等 .pop 离场动画走完，所以轮询一下）
  await pressKey(app.send, { key: 'Escape', code: 'Escape', vk: 27 })
  let barsLeft = 1
  for (let i = 0; i < 12; i++) {
    await sleep(120)
    barsLeft = await app.ev(`document.querySelectorAll('.find-bar').length`)
    if (barsLeft === 0) break
  }
  s = JSON.parse(await app.ev(STATE))
  console.log('DBG-F9 ' + JSON.stringify({ open: s.open, barsLeft }))
  report.check(
    'F9 Esc 关闭查找栏（store 关闭 + 浮层离场）',
    s.open === false && barsLeft === 0,
    JSON.stringify(s).slice(0, 120)
  )

  // 8) 源码模式：在 textarea 里找 + 替换（走 store 文本，渲染面随之跟上）
  await openDocWith(app, MD, 'find-replace-source.md')
  await sleep(400)
  await clickMode(app, 2) // 源码
  await waitRestored(app.ev)
  // 源码面这里用 Ctrl+H：既验「它直接带出替换行」，也省掉一次展开
  await ctrlH(app)
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F10a 源码面 Ctrl+H 直接带出替换行',
    s.replaceRows === 1 && s.replaceExpanded === true,
    `rows=${s.replaceRows} expanded=${s.replaceExpanded}`
  )
  await clickCenter(app.send, app.ev, '[data-find-input]')
  await app.send('Input.insertText', { text: 'beta' })
  await sleep(400)
  s = JSON.parse(await app.ev(STATE))
  // 焦点归属在不同机器上不稳（点输入框 + insertText 偶尔落在旧查询后面），这里直接置查询串：
  // 本段要验的是「源码面的命中与选区」，输入框那条交互路径已经由 F2/F6 覆盖过。
  if (s.query !== 'beta') {
    await app.ev(`window.__L.store('find').setQuery('beta')`)
    await sleep(350)
    s = JSON.parse(await app.ev(STATE))
  }
  report.check(
    'F10 源码面：查询命中 2 处且 textarea 里选中第一个（不抢输入框焦点）',
    s.surface === 'source' && s.count === 2 && s.taSel === 'beta' && s.taFocused === false,
    `surface=${s.surface} count=${s.count} taSel=${s.taSel} focused=${s.taFocused}`
  )
  // 正则 + 捕获组端到端：`(be)(ta)` 抓两段，替换串 `$2$1` → "ta"+"be" = "tabe"
  // （注意 `$2$1` 是「第 2 组 + 第 1 组」，不是字符串 "ta" 再拼 "beta" —— 别把它写成 tabeta）
  await app.ev(`(() => {
    const f = window.__L.store('find')
    f.setQuery('(be)(ta)')
    if (!f.regex) f.toggleRegex()
    f.setReplacement('$2$1')
    return 'ok'
  })()`)
  await sleep(400)
  s = JSON.parse(await app.ev(STATE))
  const dbg11pre = await app.ev(`(() => {
    const f = window.__L.store('find')
    return JSON.stringify({
      count: f.count,
      matches: f.matches.map((m) => ({ from: m.from, to: m.to, whole: m.whole, g: m.groups })),
      texts: f.matches.map((m) => f.textFor(m))
    })
  })()`)
  console.log('DBG-F11pre ' + dbg11pre)
  report.check(
    'F10b 正则查询 (be)(ta) 命中 2 处，且两处的捕获组展开都是 $2+$1 = "tabe"',
    s.regex === true &&
      s.queryValid === true &&
      s.count === 2 &&
      /"texts":\["tabe","tabe"\]/.test(dbg11pre),
    `regex=${s.regex} valid=${s.queryValid} count=${s.count} | ${dbg11pre.slice(0, 160)}`
  )
  await clickCenter(app.send, app.ev, '.find-replace-all-btn')
  const contentRegex = await waitContent(app, 'tabe')
  s = JSON.parse(await app.ev(STATE))
  report.check(
    'F11 源码面「全部替换」+ 捕获组展开（两处 beta 都变成 $2$1 = "tabe"）',
    contentRegex.includes('tabe tabe') && !contentRegex.includes('beta beta'),
    JSON.stringify(contentRegex).slice(0, 140)
  )
  // 复位：关正则、换回字面量（同一份查询在两种模式下的语义差异要能看出来）。
  // 注意此刻正文已经是 "tabe tabe"（`beta` 被 $2$1 换掉了），所以下面查的是 `tabe`。
  const literal = await app
    .ev(
      `(async () => {
    const f = window.__L.store('find')
    const files = window.__L.files()
    if (f.regex) f.toggleRegex()
    f.setQuery('tabe')
    f.setReplacement('TABE')
    await new Promise((r) => setTimeout(r, 300))
    const count = f.count
    const n = f.replaceAll()
    await new Promise((r) => setTimeout(r, 600))
    return JSON.stringify({ regex: f.regex, count, n, content: files.current?.content })
  })()`
    )
    .then(JSON.parse)
  report.check(
    'F11b 关掉正则后仍按字面量替换（tabe → TABE）',
    literal.regex === false &&
      literal.count === 2 &&
      literal.n === 2 &&
      String(literal.content).includes('TABE TABE'),
    JSON.stringify(literal).slice(0, 160)
  )
  await pressKey(app.send, { key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(200)
  await clickMode(app, 0) // 回到渲染
  await waitRestored(app.ev)
  const rendered = await app.ev(`(() => {
    const ed = window.__L.ed()
    return ed ? ed.state.doc.textContent.includes('TABE TABE') : null
  })()`)
  report.check('F12 源码面的替换回灌到渲染面', rendered === true, String(rendered))

  await app.ev(
    `(() => { window.__L.ui().editorMode = ${JSON.stringify(backupMode)}; return 'ok' })()`
  )
  await sleep(200)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
