'use strict'
// 验收：插入 / 编辑链接的弹窗（本轮交互改动）
//
// 用户口径：
//   * **有选区**时点「插入链接」→ 弹窗**只要链接**（锚文字 = 选中的文字，不再重复输入）；
//   * **无选区**时点「插入链接」→ 弹窗要**锚文字 + 链接**两个输入（锚文字留空则用链接本身）；
//   * 光标落在既有链接上（编辑既有链接）→ 预填已有地址与锚文字，并给「移除链接」。
//
// 判据（每条都在下面的 report.check 里）：
//   ① 有选区：弹窗里**只有链接输入**（断言锚文字输入**不存在**）→ 提交后文档里得到
//      `[选中的文字](url)`（**以序列化文本为准**）；
//   ② 无选区：锚文字与链接两个输入都在 → 都填 → 提交 → `[锚文字](url)`；
//   ③ Esc 取消：文档**一个字符都没变**（md 与文本逐字比较）；
//   ④ 焦点落点：有选区 → 链接输入；无选区 → 锚文字输入（再 Tab 一格到链接）；
//   ⑤ 编辑既有链接：地址与锚文字都预填正确；改地址后整条链接跟着变；「移除链接」回到纯文本。
//
// 另外三条守的是"本轮不许退化"的既有口径：
//   * 协议白名单仍是 `setLink` 那一套（`javascript:` 提交不进去，弹窗留错并保持打开）；
//   * 空地址提交 → 弹窗留错（不提交空链接）；
//   * 长 URL 粘进输入框不撑破卡片（不外溢）。
//
// ⚠️ 语义锚点全是 `data-link-*`（不是坐标/序号）：`data-link-dialog` / `data-link-field="anchor|url"`
//    / `data-link-confirm` / `data-link-cancel` / `data-link-remove` / `data-link-error`。
const {
  connect,
  settle,
  sleep,
  waitEditor,
  showToolbar,
  openDocWith,
  Reporter,
  fatal
} = require('./lib/harness')

/** 本轮弹窗的状态（没有 `data-link-dialog` 时返回 null = 旧形态或没弹） */
const DIALOG = `(() => {
  const card = document.querySelector('[data-link-dialog]')
  if (!card) return null
  const anchor = card.querySelector('[data-link-field="anchor"]')
  const url = card.querySelector('[data-link-field="url"]')
  const err = card.querySelector('[data-link-error]')
  const active = document.activeElement
  return JSON.stringify({
    hasAnchorField: !!anchor,
    hasUrlField: !!url,
    anchorValue: anchor ? anchor.value : null,
    urlValue: url ? url.value : null,
    anchorPlaceholder: anchor ? anchor.placeholder : null,
    urlPlaceholder: url ? url.placeholder : null,
    focus: active === anchor ? 'anchor' : active === url ? 'url' : active ? active.tagName : 'none',
    hasRemove: !!card.querySelector('[data-link-remove]'),
    hasCancel: !!card.querySelector('[data-link-cancel]'),
    hasConfirm: !!card.querySelector('[data-link-confirm]'),
    title: (card.querySelector('h3') || {}).textContent || '',
    error: err ? String(err.textContent).trim() : '',
    errorRole: err ? err.getAttribute('role') : null,
    urlAriaInvalid: url ? url.getAttribute('aria-invalid') : null,
    labelFor: [...card.querySelectorAll('label')].map((l) => l.getAttribute('for')).join('|'),
    ids: [...card.querySelectorAll('input')].map((i) => i.id).join('|'),
    inRoleDialog: !!card.closest('[role="dialog"]'),
    inputWidth: url ? Math.round(url.getBoundingClientRect().width) : null,
    cardWidth: Math.round(card.getBoundingClientRect().width),
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth
  })
})()`

/** 顶部提示条现状（改前是通用输入框：只有一个 `data-prompt-input`）—— 改前红的原始证据 */
const TOP_PROMPT = `(() => {
  const root = document.querySelector('[data-top-prompt]')
  if (!root) return JSON.stringify({ open: false })
  return JSON.stringify({
    open: true,
    isLinkDialog: !!root.querySelector('[data-link-dialog]'),
    inputs: [...root.querySelectorAll('input')].map((i) => ({
      field: i.getAttribute('data-link-field') || (i.hasAttribute('data-prompt-input') ? 'data-prompt-input' : '?'),
      value: i.value,
      placeholder: i.placeholder
    })),
    titles: [...root.querySelectorAll('h3')].map((h) => String(h.textContent).trim())
  })
})()`

/**
 * 「弹窗还开着吗」的**判定源**：store 里那几份对话框状态（不是 DOM 节点）。
 *
 * 为什么不用 `document.querySelector('[data-top-prompt]')` 判"关没关"：那一层带着
 * `<Transition>` 的离场动画，元素要等 `transitionend` 才从 DOM 摘掉，而**窗口不在前台时
 * 浏览器不产生帧**（本项目 `harness.framesAlive` 就是为这件事准备的）—— 于是"动画还没走完"
 * 会被读成"弹窗没关"，是环境噪声不是产品行为。状态清了 = 弹窗收到关闭指令（动画随后走完）。
 * DOM 与卡片位移仍然打出来做旁证（`dom` / `cardTransform`）。
 */
const TOP_STATE = `(() => {
  const ui = window.__L.ui()
  const root = document.querySelector('[data-top-prompt]')
  const card = root ? root.querySelector('.lm-prompt__card') : null
  return JSON.stringify({
    link: !!ui.linkState,
    prompt: !!ui.promptState,
    confirm: !!ui.confirmState,
    triple: !!ui.tripleState,
    dom: !!root,
    cardTransform: card ? getComputedStyle(card).transform : null
  })
})()`

/** 文档侧事实：链接 mark 列表 + 纯文本 + 光标处遗留的 storedMarks（改前无选区插入会留下它） */
const DOC = `(() => {
  const ed = window.__L.ed()
  if (!ed) return JSON.stringify({ err: 'NO-EDITOR' })
  const links = []
  ed.state.doc.descendants((n) => {
    if (!n.isText) return
    const m = n.marks.find((x) => x.type.name === 'link')
    if (m) links.push({ text: n.text, href: m.attrs.href })
  })
  return JSON.stringify({
    links,
    text: ed.state.doc.textContent,
    stored: (ed.state.storedMarks || []).map((m) => m.type.name).join(',')
  })
})()`

/** 编辑器序列化出来的 Markdown（"以序列化文本为准"取的就是它） */
const MD = `(() => {
  const ed = window.__L.ed()
  if (!ed) return null
  try {
    return String(ed.storage.markdown.getMarkdown())
  } catch (e) {
    return 'ERR ' + e.message
  }
})()`

/** 轮询等一个返回真值的表达式（超时返回 null，不抛） */
async function waitFor(app, expr, ms = 2500) {
  const end = Date.now() + ms
  for (;;) {
    let v = null
    try {
      v = await app.ev(expr)
    } catch {
      v = null
    }
    if (v) return v
    if (Date.now() > end) return null
    await sleep(80)
  }
}

const fieldSel = (field) => '[data-link-field="' + field + '"]'

/** 走真实入口：工具栏的「链接」按钮 */
async function clickToolbarLink(app) {
  return app.ev(`(() => {
    const b = document.querySelector('[data-toolbar-item-id="link"]')
    if (!b) return 'NO-BUTTON'
    b.click()
    return 'ok'
  })()`)
}

/** 另一个入口：编辑器右键菜单里的 insert.link（同一个动作目录） */
async function runMenuLink(app) {
  return app.ev(`(() => {
    const menu = window.__L.store('editorMenu')
    if (!menu) return 'NO-STORE'
    for (const s of menu.buildSections()) {
      for (const it of s.items || []) {
        if (it.id === 'insert.link') {
          void it.run()
          return 'ok'
        }
      }
    }
    return 'NO-ACTION'
  })()`)
}

/** 设置输入框的值（走一遍 input 事件，v-model 才吃） */
async function setField(app, field, value) {
  return app.ev(
    `(() => {
      const el = document.querySelector(${JSON.stringify(fieldSel(field))})
      if (!el) return 'NO-FIELD'
      el.value = ${JSON.stringify(value)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`
  )
}

async function pressKeyIn(app, field, key) {
  return app.ev(
    `(() => {
      const el = document.querySelector(${JSON.stringify(fieldSel(field))})
      if (!el) return 'NO-FIELD'
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))
      return 'ok'
    })()`
  )
}

/** 在 document 上敲键（弹窗的 Esc / Tab 都挂在 document 上） */
async function pressKeyDoc(app, key) {
  return app.ev(
    `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))
      return 'ok'
    })()`
  )
}

async function clickBtn(app, attr) {
  return app.ev(`(() => {
    const b = document.querySelector('[${attr}]')
    if (!b) return 'NO-BUTTON'
    b.click()
    return 'ok'
  })()`)
}

/** 选中整段文字（text 节点的绝对起点 + 长度） */
async function selectText(app, needle) {
  return app.ev(`(() => {
    const ed = window.__L.ed()
    if (!ed) return 'NO-EDITOR'
    let pos = -1
    ed.state.doc.descendants((n, p) => {
      if (n.isText && n.text === ${JSON.stringify(needle)} && pos < 0) pos = p
    })
    if (pos < 0) return 'NO-TEXT'
    ed.commands.setTextSelection({ from: pos, to: pos + ${needle.length} })
    return 'ok'
  })()`)
}

/** 把光标放到某段文字里（offset 相对这段文字起点；默认段落末尾） */
async function caretIn(app, needle, offset) {
  const at = typeof offset === 'number' ? offset : needle.length
  return app.ev(`(() => {
    const ed = window.__L.ed()
    if (!ed) return 'NO-EDITOR'
    let pos = -1
    ed.state.doc.descendants((n, p) => {
      if (n.isText && n.text.includes(${JSON.stringify(needle)}) && pos < 0) {
        pos = p + n.text.indexOf(${JSON.stringify(needle)})
      }
    })
    if (pos < 0) return 'NO-TEXT'
    ed.commands.setTextSelection(pos + ${at})
    return 'ok'
  })()`)
}

async function dialogState(app) {
  const raw = await waitFor(app, DIALOG)
  return raw ? JSON.parse(String(raw)) : null
}

/** 对话框状态（见 TOP_STATE 的说明：判"关没关"以状态为准） */
async function topState(app) {
  return JSON.parse(String(await app.ev(TOP_STATE)))
}

/** 关掉可能还开着的提示（Esc 与可见的「取消」同义） */
async function closeAnyDialog(app) {
  const st = await topState(app)
  if (st.link || st.prompt || st.confirm || st.triple) {
    await pressKeyDoc(app, 'Escape')
    await sleep(250)
  }
  return topState(app)
}

async function md(app) {
  return String((await app.ev(MD)) ?? '')
}

async function doc(app) {
  return JSON.parse(String(await app.ev(DOC)))
}

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const report = new Reporter('链接弹窗：有选区只要链接 / 无选区要锚文字+链接 / 编辑既有链接')
  const { ev } = app

  if (!(await waitEditor(ev))) {
    report.check('editor-ready', false, '拿不到编辑器实例')
    return report.finish()
  }
  const toolbar = await showToolbar(app)
  report.note('工具栏可见 = ' + toolbar)

  // ── ① 有选区：弹窗里只有「链接」一栏，锚文字 = 选中的文字 ──────────────────
  await openDocWith(app, '# 链接弹窗\n\n选中这段文字\n\n第二段的文字\n', 'lumin-link-dialog.md')
  await sleep(600)
  await waitEditor(ev)
  report.check(
    'link-entry-toolbar-button-present',
    (await ev(`!!document.querySelector('[data-toolbar-item-id="link"]')`)) === true,
    'data-toolbar-item-id="link"'
  )
  report.check('select-text-ok', (await selectText(app, '选中这段文字')) === 'ok', '选区 = 选中这段文字')

  await clickToolbarLink(app)
  const selDialog = await dialogState(app)
  report.note('有选区 · 弹窗现状 = ' + JSON.stringify(selDialog))
  report.note('有选区 · 顶部提示条原始形态 = ' + String(await ev(TOP_PROMPT)))
  report.check(
    '①selection-dialog-has-only-url-field',
    !!selDialog && selDialog.hasUrlField === true && selDialog.hasAnchorField === false,
    JSON.stringify(selDialog && { url: selDialog.hasUrlField, anchor: selDialog.hasAnchorField })
  )
  report.check(
    '④selection-focus-lands-on-url',
    !!selDialog && selDialog.focus === 'url',
    'focus = ' + (selDialog && selDialog.focus)
  )
  report.check(
    'selection-dialog-a11y-anchors',
    !!selDialog &&
      selDialog.inRoleDialog === true &&
      selDialog.hasConfirm === true &&
      selDialog.hasCancel === true &&
      /lm-link-url/.test(selDialog.ids) &&
      /lm-link-url/.test(selDialog.labelFor),
    JSON.stringify(selDialog && { role: selDialog.inRoleDialog, ids: selDialog.ids, labelFor: selDialog.labelFor })
  )
  await setField(app, 'url', 'https://a.example.com')
  await pressKeyIn(app, 'url', 'Enter')
  await sleep(500)
  const afterSel = await md(app)
  const selDoc = await doc(app)
  report.note('①提交后 md = ' + JSON.stringify(afterSel.split('\n').filter((l) => l.trim()).join(' / ')))
  report.note('①提交后 links/stored = ' + JSON.stringify({ links: selDoc.links, stored: selDoc.stored }))
  report.check(
    '①selection-submit-yields-markdown-link',
    afterSel.includes('[选中这段文字](https://a.example.com)'),
    JSON.stringify(afterSel.split('\n').find((l) => l.includes('选中')) || afterSel.slice(0, 120))
  )
  const afterSelTop = await topState(app)
  report.note('①提交后弹窗状态 = ' + JSON.stringify(afterSelTop))
  report.check(
    'selection-submit-closes-dialog',
    afterSelTop.link === false,
    JSON.stringify({ linkState: afterSelTop.link, domNode: afterSelTop.dom, cardTransform: afterSelTop.cardTransform })
  )

  // ── ② 无选区：锚文字 + 链接两个输入 ───────────────────────────────────────
  await caretIn(app, '第二段的文字')
  await sleep(200)
  await clickToolbarLink(app)
  const noSelDialog = await dialogState(app)
  report.note('无选区 · 弹窗现状 = ' + JSON.stringify(noSelDialog))
  report.note('无选区 · 顶部提示条原始形态 = ' + String(await ev(TOP_PROMPT)))
  report.check(
    '②no-selection-dialog-has-both-fields',
    !!noSelDialog && noSelDialog.hasAnchorField === true && noSelDialog.hasUrlField === true,
    JSON.stringify(noSelDialog && { anchor: noSelDialog.hasAnchorField, url: noSelDialog.hasUrlField })
  )
  report.check(
    '④no-selection-focus-lands-on-anchor',
    !!noSelDialog && noSelDialog.focus === 'anchor',
    'focus = ' + (noSelDialog && noSelDialog.focus)
  )
  await pressKeyDoc(app, 'Tab')
  await sleep(150)
  const afterTab = await dialogState(app)
  report.check(
    '④tab-moves-anchor-to-url',
    !!afterTab && afterTab.focus === 'url',
    'Tab 后 focus = ' + (afterTab && afterTab.focus)
  )
  report.check(
    'placeholders-are-localized',
    !!noSelDialog &&
      String(noSelDialog.anchorPlaceholder || '').length > 0 &&
      String(noSelDialog.urlPlaceholder || '').length > 0,
    JSON.stringify({
      anchor: noSelDialog && noSelDialog.anchorPlaceholder,
      url: noSelDialog && noSelDialog.urlPlaceholder
    })
  )
  await setField(app, 'anchor', '官网')
  await setField(app, 'url', 'https://b.example.com')
  await pressKeyIn(app, 'url', 'Enter')
  await sleep(500)
  const afterNoSel = await md(app)
  report.note('②提交后 md = ' + JSON.stringify(afterNoSel.split('\n').filter((l) => l.trim()).join(' / ')))
  report.check(
    '②no-selection-submit-inserts-anchor-text',
    afterNoSel.includes('[官网](https://b.example.com)'),
    JSON.stringify(afterNoSel.split('\n').find((l) => l.includes('官网')) || afterNoSel.slice(0, 120))
  )

  // ── ③ Esc：文档一个字符都不变 ────────────────────────────────────────────
  const beforeEsc = await md(app)
  const beforeEscDoc = await doc(app)
  await selectText(app, '选中这段文字')
  await clickToolbarLink(app)
  const escDialog = await dialogState(app)
  report.check('③escape-dialog-opened', !!escDialog, JSON.stringify(escDialog && escDialog.title))
  await pressKeyDoc(app, 'Escape')
  await sleep(400)
  const afterEsc = await md(app)
  const afterEscDoc = await doc(app)
  report.check(
    '③escape-leaves-document-untouched',
    afterEsc === beforeEsc && afterEscDoc.text === beforeEscDoc.text,
    JSON.stringify({ before: beforeEsc, after: afterEsc })
  )
  const afterEscTop = await topState(app)
  report.note('③Esc 后弹窗状态 = ' + JSON.stringify(afterEscTop))
  report.check(
    '③escape-closes-dialog',
    afterEscTop.link === false,
    JSON.stringify({ linkState: afterEscTop.link, domNode: afterEscTop.dom, cardTransform: afterEscTop.cardTransform })
  )

  // ── ⑤ 编辑既有链接：预填 + 改地址 + 移除 ──────────────────────────────────
  await openDocWith(app, '# 编辑链接\n\n[旧文字](https://old.example.com)\n', 'lumin-link-edit.md')
  await sleep(700)
  await waitEditor(ev)
  const editDocBefore = await doc(app)
  report.check(
    'edit-fixture-has-link',
    editDocBefore.links.length === 1 && editDocBefore.links[0].href === 'https://old.example.com',
    JSON.stringify(editDocBefore.links)
  )
  report.check('edit-caret-in-link-ok', (await caretIn(app, '旧文字', 2)) === 'ok', '光标落在链接文字里')
  await clickToolbarLink(app)
  const editDialog = await dialogState(app)
  report.note('编辑既有链接 · 弹窗现状 = ' + JSON.stringify(editDialog))
  report.check(
    '⑤edit-dialog-prefills-url-and-anchor',
    !!editDialog &&
      editDialog.urlValue === 'https://old.example.com' &&
      editDialog.anchorValue === '旧文字' &&
      editDialog.hasAnchorField === true,
    JSON.stringify(editDialog && { url: editDialog.urlValue, anchor: editDialog.anchorValue })
  )
  report.check('⑤edit-dialog-offers-remove', !!editDialog && editDialog.hasRemove === true, String(!!editDialog && editDialog.hasRemove))
  await setField(app, 'url', 'https://new.example.com')
  await pressKeyIn(app, 'url', 'Enter')
  await sleep(500)
  const afterEdit = await md(app)
  report.note('⑤改地址后 md = ' + JSON.stringify(afterEdit.split('\n').filter((l) => l.trim()).join(' / ')))
  report.check(
    '⑤edit-submit-keeps-anchor-and-swaps-url',
    afterEdit.includes('[旧文字](https://new.example.com)') && !afterEdit.includes('old.example.com'),
    JSON.stringify(afterEdit.split('\n').find((l) => l.includes('旧文字')) || afterEdit.slice(0, 120))
  )
  // 移除链接：整条回到纯文本（锚文字留下、链接消失）
  await clickToolbarLink(app)
  const removeDialog = await dialogState(app)
  report.check(
    '⑤remove-opens-with-prefilled-url',
    !!removeDialog && removeDialog.urlValue === 'https://new.example.com',
    JSON.stringify(removeDialog && removeDialog.urlValue)
  )
  await clickBtn(app, 'data-link-remove')
  await sleep(500)
  const afterRemove = await md(app)
  const removeDoc = await doc(app)
  report.note('⑤移除链接后 md = ' + JSON.stringify(afterRemove.split('\n').filter((l) => l.trim()).join(' / ')))
  report.check(
    '⑤remove-turns-link-back-into-plain-text',
    afterRemove.includes('旧文字') && !afterRemove.includes('](') && removeDoc.links.length === 0,
    JSON.stringify({ md: afterRemove, links: removeDoc.links })
  )

  // ── ⑥ 锚文字留空 → 以链接地址作锚文字（本轮选定的默认语义）────────────────
  await caretIn(app, '旧文字', 3)
  await clickToolbarLink(app)
  await dialogState(app)
  await setField(app, 'anchor', '')
  await setField(app, 'url', 'https://c.example.com')
  await pressKeyIn(app, 'anchor', 'Enter')
  await sleep(500)
  const afterFallback = await md(app)
  const fallbackDoc = await doc(app)
  // 留空的锚文字 = 链接地址本身。落盘时**序列化器自己**把"文字 == 地址"的链接写成
  // autolink 形态 `<https://c.example.com>`（同样是合法且等价的 Markdown，解析回来仍是链接）
  // —— 所以这里两种形态都收，真正要守的是"锚文字 = 地址、且它确实是条链接"。
  const asAutolink = afterFallback.includes('<https://c.example.com>')
  const asBracket = afterFallback.includes('[https://c.example.com](https://c.example.com)')
  report.note('⑥留空锚文字后 md = ' + JSON.stringify(afterFallback.split('\n').filter((l) => l.trim()).join(' / ')))
  report.check(
    '⑥empty-anchor-falls-back-to-the-url',
    (asAutolink || asBracket) &&
      fallbackDoc.links.length === 1 &&
      fallbackDoc.links[0].text === 'https://c.example.com' &&
      fallbackDoc.links[0].href === 'https://c.example.com',
    JSON.stringify({ autolink: asAutolink, bracket: asBracket, links: fallbackDoc.links })
  )

  // ── ⑦ 校验与不溢出：空地址留错、javascript: 被既有协议白名单拦下、长 URL 不撑破卡片 ──
  await caretIn(app, '第二段的文字')
  await clickToolbarLink(app)
  await dialogState(app)
  await setField(app, 'url', '')
  await pressKeyIn(app, 'url', 'Enter')
  await sleep(250)
  const emptyUrl = await dialogState(app)
  report.check(
    '⑦empty-url-keeps-dialog-open-with-error',
    !!emptyUrl && emptyUrl.error.length > 0 && emptyUrl.urlAriaInvalid === 'true' && emptyUrl.errorRole === 'alert',
    JSON.stringify(emptyUrl && { error: emptyUrl.error, aria: emptyUrl.urlAriaInvalid, role: emptyUrl.errorRole })
  )
  const longUrl = 'https://long.example.com/' + 'a'.repeat(560)
  await setField(app, 'url', longUrl)
  await sleep(200)
  const longState = await dialogState(app)
  report.check(
    '⑦long-url-does-not-overflow-the-card',
    !!longState &&
      longState.inputWidth <= longState.cardWidth &&
      longState.docOverflowX === false &&
      longState.urlValue === longUrl,
    JSON.stringify(longState && { input: longState.inputWidth, card: longState.cardWidth, overflowX: longState.docOverflowX })
  )
  const beforeInvalid = await md(app)
  await setField(app, 'url', 'javascript:alert(1)')
  await pressKeyIn(app, 'url', 'Enter')
  await sleep(300)
  const invalidState = await dialogState(app)
  const afterInvalid = await md(app)
  report.note('⑦非法协议后弹窗 = ' + JSON.stringify(invalidState && { error: invalidState.error, open: true }))
  report.check(
    '⑦unsupported-protocol-rejected-with-error',
    !!invalidState && invalidState.error.length > 0 && afterInvalid === beforeInvalid,
    JSON.stringify({ error: invalidState && invalidState.error, same: afterInvalid === beforeInvalid })
  )
  await closeAnyDialog(app)

  // ── ⑧ 右键菜单入口（insert.link）走的是同一个弹窗 ────────────────────────
  await caretIn(app, '第二段的文字')
  await sleep(150)
  const menuEntry = await runMenuLink(app)
  const menuDialog = await dialogState(app)
  report.note('⑧菜单入口 = ' + menuEntry + ' / 弹窗 = ' + JSON.stringify(menuDialog && { title: menuDialog.title, anchor: menuDialog.hasAnchorField, url: menuDialog.hasUrlField }))
  report.check(
    '⑧context-menu-entry-opens-the-same-dialog',
    menuEntry === 'ok' && !!menuDialog && menuDialog.hasAnchorField === true && menuDialog.hasUrlField === true,
    JSON.stringify({ entry: menuEntry, dialog: menuDialog && menuDialog.title })
  )
  await closeAnyDialog(app)
  const finalTop = await topState(app)
  report.note('收尾 · 弹窗状态 = ' + JSON.stringify(finalTop))
  report.check(
    'cleanup-no-dialog-left',
    finalTop.link === false && finalTop.prompt === false && finalTop.confirm === false && finalTop.triple === false,
    JSON.stringify(finalTop)
  )

  app.close()
  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
