'use strict'
// ─── 验收：Wave 3（编辑器⇄store 显式意图 / 文件树键盘可达 / 原生菜单三语）────────
//
// 三段各回答一个问题：
//   A. **显式意图同步**：删掉「内容相等」+「600ms 静默窗」两条启发式之后，
//      a) 刚 flush 完立刻做显式替换（切编码）必须**照样生效**（旧启发式会吞掉它）；
//      b) 编辑器自己的回声**绝不能**重建文档（否则光标乱跳、快速输入丢字）；
//      c) 同一路径/同 key（未命名）换内容也要生效（:key 不重建的情况）。
//   B. **文件树键盘可达**：ARIA tree 结构（role/treeitem/aria-expanded/aria-selected/roving tabindex）
//      + 方向键/Home/End/Enter 的真实键盘行为。
//   C) **原生菜单三语**：主进程按持久化语言重建菜单（读实例 stdout 里的 [menu] 自检行）。
//
// 跑法（对着隔离实例）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-isolated.ps1
//   node tools/_verify-wave3.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, waitEditor, sleep, Reporter, fatal } = require('./lib/harness')

const WS = path.join(os.tmpdir(), 'lumin-wave3-ws')
const KEY = { ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Enter: 13 }

async function press(app, key) {
  await app.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code: key,
    windowsVirtualKeyCode: KEY[key]
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    windowsVirtualKeyCode: KEY[key]
  })
  await sleep(220)
}

/** 主进程 stdout 日志（隔离实例按 user-data-dir 叶子名分文件，见 start-isolated.ps1） */
function instanceLog() {
  const tmp = os.tmpdir()
  const files = fs
    .readdirSync(tmp)
    .filter((f) => /^lumin-instance-.*-out\.log$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(tmp, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return files.length ? path.join(tmp, files[0].f) : null
}

async function main() {
  const report = new Reporter('Wave 3：意图同步 / 文件树键盘 / 原生菜单三语')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }

  const opened = await app.ev('window.__L.files().current?.path ?? null')
  const backup = JSON.parse(
    await app.ev(`JSON.stringify({
      recentFiles: window.__L.settings().recentFiles,
      autoSave: window.__L.settings().autoSave,
      language: window.__L.settings().language
    })`)
  )
  report.note(`跑在${opened ? '当前窗口（文档=' + opened + '）' : '未命名缓冲区窗口'}`)
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)

  // 夹具：一个工作区（两个目录 + 三个文件）
  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(path.join(WS, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(WS, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(WS, 'alpha.md'), '# alpha\n\n正文 A。\n')
  fs.writeFileSync(path.join(WS, 'docs', 'beta.md'), '# beta\n\n正文 B。\n')
  fs.writeFileSync(path.join(WS, 'docs', 'gamma.md'), '# gamma\n\n正文 C。\n')

  // ── A. 显式意图同步 ──────────────────────────────────────────────────────
  await app.ev(`(async () => { await window.__L.files().openPath(${JSON.stringify(path.join(WS, 'alpha.md'))}); return 'ok' })()`)
  await sleep(900)
  await waitEditor(app.ev)
  report.note('A 段：编辑器⇄store 显式意图')

  // A0：打开文件后编辑器内容应与文档一致（外部替换世代生效）
  const a0 = JSON.parse(
    await app.ev(`(() => {
      const ed = window.__L.ed()
      const f = window.__L.files()
      return JSON.stringify({
        doc: ed ? ed.state.doc.textContent : null,
        store: (f.current?.content ?? '').split('#').join('').split('\\n').join('').trim(),
        rev: f.contentRev,
        author: f.contentAuthor,
        stale: f.contentIsStale('wysiwyg')
      })
    })()`)
  )
  report.check(
    'A0 打开文件后编辑器与文档一致',
    !!a0.doc && a0.doc.includes('alpha') && a0.stale === false,
    JSON.stringify(a0)
  )

  // A1：刚 flush 完立刻做显式替换（切编码）——旧「600ms 静默窗」会吞掉它
  //
  // 两点测试侧处理（都不是产品行为）：
  //   * 把文档标记为干净：`reopenWithEncoding` 对脏文档会弹确认框，套件里没人点它 → 会一直挂着；
  //   * 兜底把 `ui.confirm` 换成自动同意，避免后面任何一处确认框把整轮验收挂死。
  const a1 = JSON.parse(
    await app.ev(`(async () => {
      const ed = window.__L.ed()
      const f = window.__L.files()
      window.__L.ui().confirm = async () => true
      ed.commands.insertContentAt(1, 'X')
      window.dispatchEvent(new Event('beforeunload'))
      f.current.savedContent = f.current.content // 标记干净：本节测同步，不测确认框
      const beforeRev = f.contentRev
      const ok = await f.reopenWithEncoding('utf-8')
      await new Promise((r) => setTimeout(r, 300))
      return JSON.stringify({
        ok,
        revBumped: f.contentRev > beforeRev,
        author: f.contentAuthor,
        stale: f.contentIsStale('wysiwyg'),
        editorText: ed.state.doc.textContent.slice(0, 24),
        storeHead: (f.current?.content ?? '').slice(0, 24)
      })
    })()`)
  )
  report.check(
    'A1 flush 后立刻显式替换仍然生效（不再被静默窗吞掉）',
    a1.ok === true && a1.revBumped === true && !a1.editorText.includes('X') && a1.stale === false,
    JSON.stringify(a1)
  )
  report.check('A1b 整篇替换的作者记为 external', a1.author === 'external', JSON.stringify(a1))

  // A2：自身回声不得重建文档（内容与选区都不动）
  const a2 = JSON.parse(
    await app.ev(`(async () => {
      const ed = window.__L.ed()
      ed.commands.setTextSelection(Math.min(4, ed.state.doc.content.size))
      const selBefore = ed.state.selection.from
      const sizeBefore = ed.state.doc.content.size
      const textBefore = ed.state.doc.textContent
      // 一次真实输入 → 触发 onUpdate → 250ms 后 flush → store 回流
      ed.commands.insertContentAt(ed.state.selection.from, 'Z')
      const textAfterEdit = ed.state.doc.textContent
      await new Promise((r) => setTimeout(r, 400))
      window.dispatchEvent(new Event('beforeunload'))
      await new Promise((r) => setTimeout(r, 300))
      return JSON.stringify({
        sizeBefore,
        sizeAfter: ed.state.doc.content.size,
        selBefore,
        selAfter: ed.state.selection.from,
        textAfterEdit,
        textAfterEcho: ed.state.doc.textContent,
        storeHasZ: (window.__L.files().current?.content ?? '').includes('Z')
      })
    })()`)
  )
  report.check(
    'A2 自身回声不重建文档（内容与选区保持）',
    a2.textAfterEdit === a2.textAfterEcho && a2.selAfter === a2.selBefore + 1,
    JSON.stringify(a2)
  )
  report.check('A2b 输入确实已落进 store（回声链路通）', a2.storeHasZ === true, JSON.stringify(a2))

  // A3：未命名文档（:key 恒为 untitled）换内容也要生效
  const a3 = JSON.parse(
    await app.ev(`(async () => {
      const f = window.__L.files()
      f.setContent('# 未命名一\\n')
      window.dispatchEvent(new Event('beforeunload'))
      await new Promise((r) => setTimeout(r, 200))
      await f.openUntitled()
      await new Promise((r) => setTimeout(r, 400))
      const ed = window.__L.ed()
      return JSON.stringify({
        store: f.current?.content ?? '',
        editor: ed ? ed.state.doc.textContent : null
      })
    })()`)
  )
  report.check(
    'A3 openUntitled 后编辑器清空（同 key 也靠意图同步）',
    a3.editor === '' || a3.editor === null,
    JSON.stringify(a3)
  )

  // A4：源码 textarea 输入 → 账本作者 = source；Tiptap 落后并在节流后自己对齐
  const a4 = JSON.parse(
    await app.ev(`(async () => {
      const ui = window.__L.ui()
      const f = window.__L.files()
      ui.editorMode = 'split'
      await new Promise((r) => setTimeout(r, 350))
      const ta = document.querySelector('textarea.source-editor')
      if (!ta) return JSON.stringify({ err: 'no-textarea' })
      const before = f.contentRev
      ta.value = (f.current?.content ?? '') + '\\n源码面追加一行\\n'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const atInput = { rev: f.contentRev, author: f.contentAuthor, stale: f.contentIsStale('wysiwyg') }
      await new Promise((r) => setTimeout(r, 600))
      const ed = window.__L.ed()
      return JSON.stringify({
        err: null,
        bumped: f.contentRev > before,
        atInput,
        staleAfter: f.contentIsStale('wysiwyg'),
        editorHas: (ed ? ed.state.doc.textContent : '').includes('源码面追加一行'),
        storeHas: (f.current?.content ?? '').includes('源码面追加一行')
      })
    })()`)
  )
  report.check(
    'A4 源码面输入：作者=source 且 Tiptap 随后自行对齐',
    a4.err === null &&
      a4.bumped === true &&
      a4.atInput.author === 'source' &&
      a4.atInput.stale === true &&
      a4.staleAfter === false &&
      a4.editorHas === true &&
      a4.storeHas === true,
    JSON.stringify(a4)
  )

  // A5：代码块里的 CodeMirror 输入 → 作者 = codeblock，宿主 Tiptap 不掉队（不被回灌）
  await app.ev(`(async () => {
    const f = window.__L.files()
    window.__L.ui().editorMode = 'wysiwyg'
    await f.openPath(${JSON.stringify(path.join(WS, 'alpha.md'))})
    return 'ok'
  })()`)
  await sleep(700)
  await waitEditor(app.ev)
  await app.ev(`(() => {
    const ed = window.__L.ed()
    const end = ed.state.doc.content.size
    ed.chain().focus().insertContentAt(end, { type: 'codeBlock', attrs: { language: 'javascript' }, content: [{ type: 'text', text: 'const a = 1' }] }).run()
    return 'ok'
  })()`)
  await sleep(500)
  const cmBox = JSON.parse(
    await app.ev(`(() => {
      const el = document.querySelector('.cm-content')
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 12) })
    })()`)
  )
  if (!cmBox || cmBox === 'null') {
    report.skip('A5 代码块 CodeMirror 作者标记', '页面里没有 .cm-content（代码块未渲染）')
  } else {
    await app.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: cmBox.x,
      y: cmBox.y,
      button: 'left',
      clickCount: 1
    })
    await app.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: cmBox.x,
      y: cmBox.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(250)
    await app.send('Input.insertText', { text: ' /*cm*/' })
    await sleep(900)
    const a5 = JSON.parse(
      await app.ev(`(() => {
        const f = window.__L.files()
        const ed = window.__L.ed()
        return JSON.stringify({
          author: f.contentAuthor,
          stale: f.contentIsStale('wysiwyg'),
          cmHas: (document.querySelector('.cm-content')?.textContent ?? '').includes('/*cm*/'),
          storeHas: (f.current?.content ?? '').includes('/*cm*/'),
          editorHas: (ed ? ed.state.doc.textContent : '').includes('/*cm*/')
        })
      })()`)
    )
    report.check(
      'A5 代码块输入：作者=codeblock，宿主与真源都在最新世代',
      a5.cmHas === true &&
        a5.storeHas === true &&
        a5.editorHas === true &&
        a5.author === 'codeblock' &&
        a5.stale === false,
      JSON.stringify(a5)
    )
  }

  // A6：外部替换把两个命令式编辑面都标记为落后（文本恰好相等也要重渲染）
  const a6 = JSON.parse(
    await app.ev(`(async () => {
      const f = window.__L.files()
      const same = f.current.content
      f.setContent(same, 'external')
      const rightAfter = { staleW: f.contentIsStale('wysiwyg'), staleC: f.contentIsStale('codeblock') }
      await new Promise((r) => setTimeout(r, 600))
      return JSON.stringify({ rightAfter, after: f.contentIsStale('wysiwyg'), author: f.contentAuthor })
    })()`)
  )
  report.check(
    'A6 整篇替换（文本相同）也判定落后 → 重渲染后收敛',
    a6.rightAfter.staleW === true && a6.rightAfter.staleC === true && a6.after === false,
    JSON.stringify(a6)
  )

  // ── B. 文件树键盘可达 ────────────────────────────────────────────────────
  await app.ev(`(async () => { await window.__L.files().setRoot(${JSON.stringify(WS)}); return 'ok' })()`)
  await sleep(900)
  const struct = JSON.parse(
    await app.ev(`(() => {
      const tree = document.querySelector('[role="tree"]')
      if (!tree) return 'null'
      const rows = [...tree.querySelectorAll('[data-tree-row]')]
      return JSON.stringify({
        treeRole: tree.getAttribute('role'),
        rows: rows.length,
        itemRoles: rows.every((r) => r.getAttribute('role') === 'treeitem'),
        levels: rows.map((r) => r.getAttribute('aria-level')),
        dirHasExpanded: [...tree.querySelectorAll('[data-tree-type="directory"]')].every((r) =>
          r.hasAttribute('aria-expanded')
        ),
        tabbable: rows.filter((r) => r.getAttribute('tabindex') === '0').length,
        first: rows[0]?.dataset.treePath
      })
    })()`)
  )
  report.note('B 段：文件树键盘可达')
  report.check('B1 role=tree / treeitem 结构', struct !== 'null' && struct.treeRole === 'tree' && struct.itemRoles === true, JSON.stringify(struct))
  report.check('B2 目录行带 aria-expanded', struct?.dirHasExpanded === true, JSON.stringify(struct))
  report.check('B3 roving tabindex：整棵树只有一个可 Tab 的行', struct?.tabbable === 1, JSON.stringify(struct))

  // 聚焦树并逐键驱动
  const focusTree = await app.ev(`(() => {
    const row = document.querySelector('[data-tree-row]')
    if (!row) return 'no-row'
    row.focus()
    return JSON.stringify({ focused: document.activeElement?.dataset?.treePath ?? null })
  })()`)
  const f0 = JSON.parse(focusTree)
  await press(app, 'ArrowDown')
  const f1 = await app.ev(`document.activeElement?.dataset?.treePath ?? null`)
  await press(app, 'ArrowUp')
  const f2 = await app.ev(`document.activeElement?.dataset?.treePath ?? null`)
  await press(app, 'End')
  const fEnd = await app.ev(`document.activeElement?.dataset?.treePath ?? null`)
  await press(app, 'Home')
  const fHome = await app.ev(`document.activeElement?.dataset?.treePath ?? null`)
  report.check('B4 ↓ 移动到下一行', f1 && f1 !== f0.focused, JSON.stringify({ from: f0.focused, to: f1 }))
  report.check('B5 ↑ 回到上一行', f2 === f0.focused, JSON.stringify({ want: f0.focused, got: f2 }))
  report.check('B6 End/Home 到首尾', !!fEnd && fHome === f0.focused, JSON.stringify({ end: fEnd, home: fHome }))

  // → 展开目录 → 再 → 进第一个子项 → ← 回父项（用**有子项**的 docs；assets 是空目录，另测）
  const focusDir = async (name) =>
    app.ev(`(() => {
      const row = [...document.querySelectorAll('[data-tree-row]')].find(
        (r) => (r.dataset.treePath || '').endsWith(${JSON.stringify(name)}) && r.dataset.treeType === 'directory'
      )
      if (!row) return 'no-row'
      row.focus()
      return row.dataset.treePath
    })()`)
  const dirPath = await focusDir('docs')
  await press(app, 'ArrowRight')
  await sleep(600)
  const expanded = await app.ev(
    `(() => { const r = [...document.querySelectorAll('[data-tree-row]')].find((x) => x.dataset.treePath === ${JSON.stringify(dirPath)}); return r ? r.getAttribute('aria-expanded') : null })()`
  )
  await press(app, 'ArrowRight')
  await sleep(500)
  const childFocus = await app.ev(`document.activeElement?.dataset?.treePath ?? null`)
  await press(app, 'ArrowLeft')
  await sleep(400)
  const parentFocus = await app.ev(`document.activeElement?.dataset?.treePath ?? null`)
  await press(app, 'ArrowLeft')
  await sleep(500)
  const collapsed = await app.ev(
    `(() => { const r = [...document.querySelectorAll('[data-tree-row]')].find((x) => x.dataset.treePath === ${JSON.stringify(dirPath)}); return r ? r.getAttribute('aria-expanded') : null })()`
  )
  report.check('B7 → 展开目录', expanded === 'true', `aria-expanded=${expanded} dir=${dirPath}`)
  report.check(
    'B8 → 再按进入第一个子项',
    !!childFocus && childFocus !== dirPath && String(childFocus).startsWith(String(dirPath)),
    JSON.stringify({ dir: dirPath, child: childFocus })
  )
  report.check('B9 ← 回到父项', parentFocus === dirPath, JSON.stringify({ want: dirPath, got: parentFocus }))
  report.check('B9b ← 再按收起目录', collapsed === 'false', `aria-expanded=${collapsed}`)

  // 空目录：→ 展开后没有子项，再按 → 必须**安静地留在原地**（不能报错、不能跳到别的行）
  const emptyDir = await focusDir('assets')
  await press(app, 'ArrowRight')
  await sleep(500)
  await press(app, 'ArrowRight')
  await sleep(400)
  const emptyFocus = await app.ev(`document.activeElement?.dataset?.treePath ?? null`)
  report.check(
    'B9c 空目录：再按 → 留在原地（不崩、不乱跳）',
    emptyFocus === emptyDir,
    JSON.stringify({ dir: emptyDir, focus: emptyFocus })
  )

  // Enter 打开文件：先把 docs 展开（子项才会渲染），焦点移到 beta.md 那一行
  const enterRes = await app.ev(`(async () => {
    const rows = [...document.querySelectorAll('[data-tree-row]')]
    const dir = rows.find((r) => (r.dataset.treePath || '').endsWith('docs') && r.dataset.treeType === 'directory')
    if (!dir) return 'no-dir'
    dir.focus()
    dir.click()
    await new Promise((r) => setTimeout(r, 900))
    const target = [...document.querySelectorAll('[data-tree-row]')].find((r) =>
      (r.dataset.treePath || '').endsWith('beta.md')
    )
    if (!target) return 'no-target'
    target.focus()
    return JSON.stringify({ path: target.dataset.treePath })
  })()`)
  await press(app, 'Enter')
  await sleep(900)
  const afterEnter = await app.ev(`window.__L.files().current?.path ?? null`)
  report.check(
    'B10 Enter 打开焦点行对应的文件',
    enterRes !== 'no-target' && String(afterEnter).endsWith('beta.md'),
    JSON.stringify({ target: enterRes, opened: afterEnter })
  )

  // ── C. 原生菜单三语 ─────────────────────────────────────────────────────
  report.note('C 段：原生菜单三语')
  const logPath = instanceLog()
  await app.ev(`(() => { window.__L.settings().set('language', 'en-US'); return 'ok' })()`)
  await sleep(900)
  const afterLang = await app.ev(`window.__L.settings().language`)
  let menuRebuilt = null
  if (logPath) {
    const log = fs.readFileSync(logPath, 'utf-8')
    menuRebuilt = /\[menu\][^\n]*en-US/.test(log)
  }
  report.check('C1 语言切到 en-US 并持久化', afterLang === 'en-US', String(afterLang))
  if (logPath) {
    report.check('C2 主进程按新语言重建了原生菜单（实例日志）', menuRebuilt === true, logPath)
  } else {
    report.skip('C2 主进程按新语言重建了原生菜单（实例日志）', '没找到隔离实例的 stdout 日志')
  }
  await app.ev(`(() => { window.__L.settings().set('language', ${JSON.stringify(backup.language)}); return 'ok' })()`)
  await sleep(600)

  // ── 复原 ────────────────────────────────────────────────────────────────
  await app.ev(`(() => {
    window.__L.settings().set('autoSave', ${JSON.stringify(backup.autoSave)})
    window.__L.settings().set('recentFiles', ${JSON.stringify(backup.recentFiles ?? [])})
    return 'ok'
  })()`)
  await app.ev(`(async () => { await window.__L.files().close(); return 'ok' })()`)
  await app.ev(`(async () => { await window.__L.files().setRoot(null); return 'ok' })()`)
  for (const p of [path.join(WS, 'alpha.md'), path.join(WS, 'docs', 'beta.md'), path.join(WS, 'docs', 'gamma.md')]) {
    await app.ev(
      `(async () => { try { await window.luminAPI.db.deleteDocument(${JSON.stringify(p)}) } catch {} return 'ok' })()`
    )
  }
  fs.rmSync(WS, { recursive: true, force: true })
  report.note('已还原 autoSave / recentFiles / language / 工作区，清理临时文件')
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
