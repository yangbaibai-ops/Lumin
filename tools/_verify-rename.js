// 验收：文件树就地重命名（右键文件行 → 重命名 → 输入框就地编辑 → 回车生效）
//
// 断言（都按 DOM + 真实文件系统结果判定，不靠截图）：
//  A. 文件行右键弹出上下文菜单，含「重命名 / 删除」（文件夹行内还有新建项）
//  B. 点「重命名」→ 行内出现 .tree-rename-input，且**预填当前文件名、自动聚焦、扩展名不被选中**
//  B2.输入框**没有边框**（用户口径：改名时不要有围着文件名的框），
//     且改名的行有 .is-renaming 浅面底色 + 输入框底色与行底色确实不同（无边框也要看得出来在编辑）
//  C. 改主干名 + 回车 → 磁盘上真的改了名（旧文件消失、新文件出现）
//  D. 树上的行文字同步更新
//  E. Esc 取消时磁盘不变
//  F. **新建文件**：内容区切到新文件（files.current 与树上的 data-tree-current 都是它），
//     并且改名输入框**最后**拿到焦点（顺序反了会「刚新建就自动按默认名提交」）
//
// 为什么不用键盘注入 F2 之类：主进程窗口不一定是 OS 前台，按键会被丢掉（本项目踩过这个坑），
// 所以走真实指针 + 真实菜单点击这条路。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
}

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails)
      throw new Error(
        'EXC ' +
          JSON.stringify(
            r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text
          ).slice(0, 240)
      )
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

/**
 * 上下文菜单：ContextMenu.vue 的浮层。定位锚点走 **role 语义**（子菜单固定 aria-label="submenu"），
 * 不认 Tailwind 的 z-index 类名 —— 层级收进 `--z-*` 令牌那次，`z-[160]` 变成了
 * `z-[var(--z-critical)]`，这条套件就静默红了（0 断言，看着像环境问题）。
 * 契约：`role="menu"` / `role="menuitem"`；`_verify-toolbar-settings.js` 早就是同一口径。
 */
const MENU = `document.querySelector('[role="menu"]:not([aria-label="submenu"])')`

;(async () => {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const pages = (await get('/json/list')).filter((t) => t.type === 'page')
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口')
    return process.exit(2)
  }
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  await w.send('Page.bringToFront')

  const SETUP = `(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'no-app'
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = app._context.provides[sym]
    window.__R = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui') }
    return 'ok'
  })()`
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (
      (await w.ev(SETUP)) === 'ok' &&
      (await w.ev(`window.__R.ui().booting ? 'booting' : 'ready'`)) === 'ready'
    )
      break
  }
  await w.ev(SETUP)

  // 夹具工作区：一个可重命名的文件 + 一个文件夹（顺带验文件夹菜单）
  const dir = path.join(os.tmpdir(), 'lumin-rename-ws')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  const oldPath = path.join(dir, 'alpha.md')
  const newPath = path.join(dir, 'renamed-check.md')
  fs.writeFileSync(oldPath, '# alpha\n', 'utf-8')
  fs.rmSync(newPath, { force: true })

  try {
    await w.ev(
      `(async () => { await window.__R.files().openUntitled(); await window.__R.files().setRoot(${JSON.stringify(dir)}); return 'ok' })()`
    )
    await w.ev(
      `(() => { window.__R.ui().sidebarVisible = true; window.__R.ui().sidebarTab = 'files'; window.__R.ui().sidebarFilesView = 'tree'; return 'ok' })()`
    )
    await sleep(1200)

    /** 在指定行上打开右键菜单，返回菜单项文字 */
    const openMenu = async (type) =>
      JSON.parse(
        await w.ev(`(async () => {
          const row = [...document.querySelectorAll('[data-tree-row]')].find((r) => r.getAttribute('data-tree-type') === '${type}')
          if (!row) return JSON.stringify({ err: 'no-row' })
          const b = row.getBoundingClientRect()
          row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(b.left + 40), clientY: Math.round(b.top + 8) }))
          await new Promise((r) => setTimeout(r, 400))
          const menu = ${MENU}
          return JSON.stringify({ opened: !!menu, items: menu ? [...menu.querySelectorAll('button')].map((x) => x.textContent.trim()) : [] })
        })()`)
      )

    // ── A. 菜单 ──
    const fileMenu = await openMenu('file')
    console.log('FILE-MENU ' + JSON.stringify(fileMenu))
    c(
      'file-row-menu-has-rename',
      fileMenu.opened === true && fileMenu.items.includes('重命名'),
      JSON.stringify(fileMenu)
    )
    c('file-row-menu-has-delete', fileMenu.items.includes('删除'), JSON.stringify(fileMenu.items))
    c(
      'file-row-menu-has-new-window',
      fileMenu.items.includes('在新窗口打开'),
      JSON.stringify(fileMenu.items)
    )
    const dirMenu = await openMenu('directory')
    console.log('DIR-MENU ' + JSON.stringify(dirMenu))
    c(
      'dir-row-menu-offers-create',
      dirMenu.items.includes('新建文件') && dirMenu.items.includes('新建文件夹'),
      JSON.stringify(dirMenu.items)
    )

    // ── B. 点重命名 → 行内输入框 ──
    await openMenu('file')
    const before = JSON.parse(
      await w.ev(`(async () => {
        const menu = ${MENU}
        const rename = [...menu.querySelectorAll('button')].find((b) => /重命名/.test(b.textContent))
        if (!rename) return JSON.stringify({ err: 'no-rename' })
        rename.click()
        await new Promise((r) => setTimeout(r, 400))
        const input = document.querySelector('.tree-rename-input')
        return JSON.stringify({
          appeared: !!input,
          value: input ? input.value : null,
          focused: input ? document.activeElement === input : false,
          // 只选中主干（不含 .md）：selectionStart..End 应等于主干长度
          selStart: input ? input.selectionStart : null,
          selEnd: input ? input.selectionEnd : null
        })
      })()`)
    )
    console.log('RENAME-INPUT ' + JSON.stringify(before))
    c('rename-input-appears', before.appeared === true, JSON.stringify(before))
    c('rename-input-prefilled', before.value === 'alpha.md', String(before.value))
    c('rename-input-focused', before.focused === true, String(before.focused))
    c(
      'rename-selects-stem-only',
      before.selStart === 0 && before.selEnd === 5,
      JSON.stringify({ s: before.selStart, e: before.selEnd })
    )

    // ── B2. 输入框无边框（用户口径），但「正在改名」仍看得出来 ──
    // 量 computedStyle 而不是读 CSS 文件：断言的是**最终渲染结果**，
    // 谁（scoped 样式 / Tailwind / 主题变量）写的都不影响判定。
    const box = JSON.parse(
      await w.ev(`(() => {
        const input = document.querySelector('.tree-rename-input')
        if (!input) return JSON.stringify({ err: 'no-input' })
        const row = input.closest('[data-tree-row]')
        const ci = getComputedStyle(input)
        const cr = row ? getComputedStyle(row) : null
        return JSON.stringify({
          borderTop: ci.borderTopWidth,
          borderRight: ci.borderRightWidth,
          borderBottom: ci.borderBottomWidth,
          borderLeft: ci.borderLeftWidth,
          borderStyle: ci.borderTopStyle,
          inputBg: ci.backgroundColor,
          rowIsRenaming: row ? row.className.includes('is-renaming') : false,
          rowBg: cr ? cr.backgroundColor : null
        })
      })()`)
    )
    console.log('RENAME-BOX ' + JSON.stringify(box))
    const noBorder =
      ['borderTop', 'borderRight', 'borderBottom', 'borderLeft'].every((k) => box[k] === '0px') ||
      box.borderStyle === 'none'
    c(
      'rename-input-has-no-border',
      noBorder,
      JSON.stringify({
        t: box.borderTop,
        r: box.borderRight,
        b: box.borderBottom,
        l: box.borderLeft,
        style: box.borderStyle
      })
    )
    c(
      'rename-row-still-shows-editing-state',
      box.rowIsRenaming === true && box.rowBg !== box.inputBg,
      `is-renaming=${box.rowIsRenaming} / 行底=${box.rowBg} / 输入框底=${box.inputBg}（两者必须不同，否则无边框的字段看不见）`
    )

    // ── C/D. 改主干名 + 回车 → 磁盘与树都变 ──
    // 注意：用真实文本输入（Input.insertText），它会**替换已选中的主干**、保留 .md ——
    // 这正是应用的设计（startRename 只选主干）。直接用 setter 写整串会把扩展名一起换掉。
    await w.send('Input.insertText', { text: 'renamed-check' })
    await sleep(250)
    const renamed = JSON.parse(
      await w.ev(`(async () => {
        const input = document.querySelector('.tree-rename-input')
        if (!input) return JSON.stringify({ err: 'no-input' })
        const draft = input.value
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await new Promise((r) => setTimeout(r, 1200))
        return JSON.stringify({
          draft,
          inputGone: !document.querySelector('.tree-rename-input'),
          names: [...document.querySelectorAll('[data-tree-row]')].map((r) => r.textContent.trim())
        })
      })()`)
    )
    console.log('RENAMED ' + JSON.stringify(renamed))
    console.log(
      'FS ' +
        JSON.stringify({ oldExists: fs.existsSync(oldPath), newExists: fs.existsSync(newPath) })
    )
    c(
      'rename-applied-on-disk',
      !fs.existsSync(oldPath) && fs.existsSync(newPath),
      JSON.stringify({ old: fs.existsSync(oldPath), new: fs.existsSync(newPath) })
    )
    c(
      'rename-updated-tree',
      (renamed.names ?? []).some((n) => n.includes('renamed-check')),
      JSON.stringify(renamed.names)
    )
    c('rename-input-closed', renamed.inputGone === true, String(renamed.inputGone))
    c('rename-kept-extension', renamed.draft === 'renamed-check.md', String(renamed.draft))

    // ── E. Esc 取消：磁盘不变 ──
    const escPath = path.join(dir, 'renamed-check.md')
    await w.ev(`(async () => {
      const row = [...document.querySelectorAll('[data-tree-row]')].find((r) => r.textContent.includes('renamed-check'))
      const b = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(b.left + 40), clientY: Math.round(b.top + 8) }))
      await new Promise((r) => setTimeout(r, 350))
      const menu = ${MENU}
      const rename = [...menu.querySelectorAll('button')].find((x) => /重命名/.test(x.textContent))
      rename.click()
      await new Promise((r) => setTimeout(r, 350))
      return 'ok'
    })()`)
    await w.send('Input.insertText', { text: 'should-not-exist' })
    await sleep(250)
    const cancelled = JSON.parse(
      await w.ev(`(async () => {
        const input = document.querySelector('.tree-rename-input')
        if (!input) return JSON.stringify({ err: 'no-input' })
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await new Promise((r) => setTimeout(r, 800))
        return JSON.stringify({ inputGone: !document.querySelector('.tree-rename-input') })
      })()`)
    )
    console.log(
      'CANCELLED ' +
        JSON.stringify({
          ...cancelled,
          keepsOld: fs.existsSync(escPath),
          madeNew: fs.existsSync(path.join(dir, 'should-not-exist.md'))
        })
    )
    c(
      'escape-cancels-without-renaming',
      cancelled.inputGone === true &&
        fs.existsSync(escPath) &&
        !fs.existsSync(path.join(dir, 'should-not-exist.md')),
      JSON.stringify(cancelled)
    )

    // ── F. 新建文件：脏了就**先问**（且问了才建） ─────────────────────────
    // 新建会把内容区从当前文档换走，所以与「打开文件」同一口径：脏了先确认。
    // 直接改 content 而不走 setContent：那条路会排自动保存，夹具不该顺手写盘。
    const dirtySet = await w.ev(`(() => {
      const f = window.__R.files()
      if (!f.current) return 'no-current'
      f.current.content = 'DIRTY-FIXTURE'
      window.__F = f.newFileAt(${JSON.stringify(dir)})
      return f.dirty === true ? 'dirty' : 'not-dirty'
    })()`)
    await sleep(700)
    const ask = JSON.parse(
      await w.ev(`(() => {
        const ui = window.__R.ui()
        return JSON.stringify({
          dialog: ui.confirmState ? ui.confirmState.title : null,
          names: ${JSON.stringify(fs.readdirSync(dir))}
        })
      })()`)
    )
    console.log('NEWFILE-DIRTY ' + JSON.stringify({ dirtySet, ask }))
    c(
      'new-file-asks-before-discarding-dirty-doc',
      dirtySet === 'dirty' && typeof ask.dialog === 'string',
      `dirty=${dirtySet} / 对话框标题=${ask.dialog}`
    )
    await w.ev(`(() => { window.__R.ui().resolveConfirm(false); return 'ok' })()`)
    await sleep(900)
    const aborted = JSON.parse(
      await w.ev(`(async () => {
        const p = await window.__F
        const f = window.__R.files()
        return JSON.stringify({ returned: p, names: ${JSON.stringify(fs.readdirSync(dir))}, stillDirty: f.dirty })
      })()`)
    )
    console.log('NEWFILE-ABORT ' + JSON.stringify(aborted))
    c(
      'new-file-cancel-creates-nothing',
      aborted.returned === null &&
        !aborted.names.some((n) => n.startsWith('未命名')) &&
        aborted.stillDirty === true,
      JSON.stringify(aborted)
    )

    // ── F2. 干净时新建：内容区切到新文件 + 改名输入框最后拿焦点 ─────────────
    await w.ev(`(() => { const f = window.__R.files(); f.current.content = f.current.savedContent; return 'ok' })()`)
    await sleep(200)
    const created = JSON.parse(
      await w.ev(`(async () => {
        const f = window.__R.files()
        const p = await f.newFileAt(${JSON.stringify(dir)})
        await new Promise((r) => setTimeout(r, 1500))
        const cur = f.current
        const curRow = document.querySelector('[data-tree-row][data-tree-current="true"]')
        const input = document.querySelector('.tree-rename-input')
        return JSON.stringify({
          path: p,
          currentPath: cur ? cur.path : null,
          currentContent: cur ? cur.content : null,
          treeCurrent: curRow ? curRow.getAttribute('data-tree-path') : null,
          inputAppeared: !!input,
          inputValue: input ? input.value : null,
          inputFocused: input ? document.activeElement === input : false,
          editorReady: !!window.__R.files()
        })
      })()`)
    )
    console.log(
      'NEWFILE ' +
        JSON.stringify({ ...created, onDisk: created.path ? fs.existsSync(created.path) : false })
    )
    c(
      'new-file-switches-content-area',
      !!created.path && created.currentPath === created.path && created.currentContent === '',
      `newFileAt → ${created.path} / current.path=${created.currentPath} / 内容长度=${created.currentContent === null ? 'null' : created.currentContent.length}`
    )
    c(
      'new-file-is-marked-current-in-tree',
      created.treeCurrent === created.path,
      `data-tree-current=${created.treeCurrent}`
    )
    c(
      'new-file-enters-inline-rename',
      created.inputAppeared === true && created.inputValue === '未命名.md',
      JSON.stringify({ appeared: created.inputAppeared, value: created.inputValue })
    )
    // 顺序断言：`openPath` 会让编辑器重建并抢焦点，改名输入框必须**最后**拿焦点。
    // 反过来的表现就是这条 false（输入框刚聚焦就被抢走 → blur 立刻按默认名提交）。
    c(
      'new-file-rename-input-holds-focus',
      created.inputFocused === true,
      `activeElement 是改名输入框=${created.inputFocused}`
    )
  } finally {
    await w.ev(`(async () => { await window.__R.files().close(); return 'ok' })()`).catch(() => {})
    await sleep(200)
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w.ws.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
