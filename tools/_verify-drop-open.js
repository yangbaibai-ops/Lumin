'use strict'
// ─── 验收：把系统里的**文件 / 文件夹**拖进窗口 → 打开（第五轮恢复 + 第六轮细化落点）─────
//
// 用户原话（第五轮）：「现在为什么将文件或者文件夹拖入应用内不会打开此文件或者文件夹了，请恢复这个功能。」
// 用户原话（第六轮）：「拖动文件夹到应用上打开时，如果**当前打开的就是要打开的文件夹，则不打开新的窗口**；
//                     如果**当前打开的文件夹和想要打开的文件夹不一致时，则打开新的窗口**打开文件夹。」
//
// 判据用 **CDP `Input.dispatchDragEvent`**（`DragData.files` = 真实磁盘路径）——这是 OS 级拖放
// 模拟，不是页面里自己 `new DragEvent`：事件真的从浏览器那一侧进 DOM，
// `dataTransfer.files` 里是**真的 File**，`webUtils.getPathForFile` 能拿到真实路径。
// 本套件第一条断言（`harness-*`）就是在证明这件事成立，免得整份验收建在"合成的拖放根本没带文件"上。
//
// 落点语义（只有一份实现：renderer/src/lib/droppedPath.ts）：
//   * 文件 → 与「打开文件 / Ctrl+O」同一条规则（无工作区在本窗口打开并把侧栏切到它所在文件夹）；
//   * 目录 → 三个分支（第六轮口径）：
//       ① 本窗口没有工作区（空窗口）⇒ 就用这个窗口成为它的工作区（**不**新开窗口）；
//       ② 与当前工作区**是同一个** ⇒ 明确 no-op（不新开窗口、不动工作区）+ 一条 info 提示；
//       ③ 与当前工作区**不同** ⇒ 新窗口以它为工作区（既有规则 `app.openFolderInNewWindow`）。
//     "同一个"的判据在主进程（`pathGuard.sameResolvedPath` + `fs.realpath`），
//     大小写 / 正反斜杠 / 尾分隔符 / `.` `..` / 符号链接 / 8.3 短名都算同一个。
//   * 其它扩展名 → 明确提示「不支持的文件类型」（不许静默）。
// 回归的成因见 `_verify-no-text-drag.js` 与 droppedPath.ts 的注释（`@drop.prevent` + defaultPrevented 恒真）。
//
// 跑法：node tools/_verify-drop-open.js（先起隔离实例，见 tools/start-isolated.ps1）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, attach, sleep, appPages, Reporter, fatal } = require('./lib/harness')

const ROOT = path.join(__dirname, '..')

/** 页面侧的拖放观察器：每次 drop 记下"到底带进来几个文件、路径是什么"（探针，不参与产品逻辑） */
const WATCH = `(() => {
  if (window.__dropWatch) return 'already'
  window.__dropWatch = []
  window.addEventListener('drop', (e) => {
    const dt = e.dataTransfer
    const files = dt ? Array.from(dt.files || []) : []
    let p = null
    try { p = files.length ? window.luminAPI.file.getPathForFile(files[0]) : null } catch (err) { p = 'THROW' }
    window.__dropWatch.push({ count: files.length, path: p, name: files.length ? files[0].name : null })
  }, true)
  return 'ok'
})()`

/** 通知中心里当前可见的通知标题（语义锚点 `data-ntf-item`，不写死文案） */
const NTF = `JSON.stringify([...document.querySelectorAll('[data-ntf-item]')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()))`

const STATE = `JSON.stringify({
  path: window.__L.files().current ? window.__L.files().current.path : null,
  content: window.__L.files().current ? window.__L.files().current.content : null,
  root: window.__L.files().root,
  dirty: window.__L.files().dirty,
  doc: window.__L.ed() ? window.__L.ed().state.doc.textContent : null,
  title: document.title,
  md: window.__L.ed() ? window.__L.ed().storage.markdown.getMarkdown() : null,
  anchor: !!document.querySelector('[data-drop-window]'),
  anchorHasSidebar: (() => {
    const a = document.querySelector('[data-drop-window]')
    const s = document.querySelector('[data-sidebar-files]')
    return !!(a && s && a.contains(s))
  })()
})`

const TREE = `JSON.stringify({
  rootRow: (() => { const r = document.querySelector('[data-tree-root-row]'); return r ? r.getAttribute('data-tree-path') : null })(),
  rows: [...document.querySelectorAll('[data-tree-path]')].map((r) => r.getAttribute('data-tree-path'))
})`

/** 同一个文件的两种写法（8.3 短路径 vs 长路径）都算相等 */
function sameFile(a, b) {
  const norm = (p) => {
    try {
      return fs.realpathSync.native(p).toLowerCase()
    } catch {
      return String(p ?? '').toLowerCase()
    }
  }
  return !!a && !!b && norm(a) === norm(b)
}

async function main() {
  const report = new Reporter('验收：拖入文件 / 文件夹 → 打开（窗口级落点）')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { ev, send } = app
  const state = () => ev(STATE).then(JSON.parse)
  const ntf = () => ev(NTF).then(JSON.parse)
  const watch = () => ev('JSON.stringify(window.__dropWatch || [])').then(JSON.parse)

  /** 轮询等一个页面侧条件成立（拖放是异步的：IPC → 读盘 → 重建编辑器） */
  const until = async (expr, ms = 6000) => {
    const end = Date.now() + ms
    for (;;) {
      if (await ev(expr)) return true
      if (Date.now() > end) return false
      await sleep(150)
    }
  }
  /** 某个元素内部的一点（坐标每次现量，不写死像素） */
  const pointIn = async (selector, place) => {
    const raw = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return 'null'
      return JSON.stringify({
        x: Math.round(r.left + r.width / 2),
        y: Math.round(${place})
      })
    })()`)
    return raw === 'null' ? null : JSON.parse(raw)
  }
  /** 用 CDP 派发一次"从系统拖入这些路径"的完整序列 */
  const dropFiles = async (pt, files) => {
    const data = { items: [], files, dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data, modifiers: 0 })
      await sleep(180)
    }
  }

  // 夹具：%TEMP% 下一套自足的文件/文件夹（套件不赌上一条套件留下的状态）
  const base = path.join(os.tmpdir(), 'lumin-drop-suite')
  fs.rmSync(base, { recursive: true, force: true })
  const srcDir = path.join(base, 'src')
  const pkgDir = path.join(base, 'pkg')
  const pkg2Dir = path.join(base, 'pkg2')
  const wsDir = path.join(base, 'ws')
  fs.mkdirSync(path.join(wsDir, 'notes'), { recursive: true })
  fs.mkdirSync(srcDir, { recursive: true })
  fs.mkdirSync(path.join(pkgDir, 'sub'), { recursive: true })
  fs.mkdirSync(pkg2Dir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'inside.md'), '# 文件夹里的文件\n', 'utf8')
  fs.writeFileSync(path.join(pkgDir, 'sub', 'deep.md'), '# 更深一层\n', 'utf8')
  fs.writeFileSync(path.join(pkg2Dir, 'other.md'), '# 另一个文件夹\n', 'utf8')
  const mdA = path.join(srcDir, 'dropped-a.md')
  const mdB = path.join(srcDir, 'dropped-b.md')
  const notMd = path.join(srcDir, 'notes.xyz')
  const pngSrc = path.join(srcDir, 'picture.png')
  fs.writeFileSync(mdA, '# DROPPED-A\n\n从系统拖进来的第一篇。\n', 'utf8')
  fs.writeFileSync(mdB, '# DROPPED-B\n\n拖到侧栏里的那一篇。\n', 'utf8')
  fs.writeFileSync(notMd, 'not markdown\n', 'utf8')
  // 1×1 的合法 PNG（与 _verify-image-insert.js 用的同一份最小图）
  fs.writeFileSync(
    pngSrc,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  )
  const wsDoc = path.join(wsDir, 'notes', 'pic-doc.md')
  fs.writeFileSync(wsDoc, '# 图片落点\n\n正文一段。\n', 'utf8')

  await ev(WATCH)
  const before = await state()
  report.check(
    'fixture-起点干净（无工作区 + 窗口级拖放锚点就是应用根节点，侧栏在它里面）',
    before.root === null && before.anchor === true && before.anchorHasSidebar === true,
    JSON.stringify({ root: before.root, anchor: before.anchor, hasSidebar: before.anchorHasSidebar })
  )

  const editorPt = (await pointIn('.ProseMirror', 'r.top + 40')) || (await pointIn('[data-editor-kernel]', 'r.top + 40'))
  report.check('fixture-编辑区拿得到落点坐标', !!editorPt, JSON.stringify(editorPt))

  // ── 1. 拖一个 .md 进编辑区 → 在本窗口打开（无工作区时按「打开文件」的规则）──
  if (editorPt) {
    await dropFiles(editorPt, [mdA])
    await until(`window.__L.files().current && window.__L.files().current.path && window.__L.files().current.path.length > 0 && window.__L.files().current.content.indexOf('DROPPED-A') >= 0`, 8000)
  }
  const afterA = await state()
  const w1 = await watch()
  report.check(
    'harness-CDP 拖放真的带进来了一个**有真实路径**的 File（不是空 FileList）',
    w1.length > 0 && w1[0].count === 1 && typeof w1[0].path === 'string' && w1[0].path.length > 3 && /dropped-a\.md$/i.test(w1[0].path),
    JSON.stringify(w1)
  )
  report.check(
    '拖入 .md → 真的打开了它（正文/标题/当前文档路径三处都变）',
    sameFile(afterA.path, mdA) &&
      afterA.content === fs.readFileSync(mdA, 'utf8') &&
      afterA.doc.indexOf('DROPPED-A') >= 0 &&
      afterA.title.indexOf('dropped-a.md') >= 0,
    JSON.stringify({ path: afterA.path, doc: afterA.doc, title: afterA.title })
  )
  report.check(
    '无工作区时的落点规则：本窗口打开 + 侧栏切到该文件所在文件夹',
    sameFile(afterA.root, srcDir),
    JSON.stringify({ root: afterA.root, want: srcDir })
  )

  // ── 2. 拖一个非 Markdown 文件 → 必须给一句明确拒绝，且不许换掉当前文档 ──
  await ev(`(async () => { await window.__L.notifications().closeAll(); return 'ok' })()`)
  await sleep(300)
  if (editorPt) await dropFiles(editorPt, [notMd])
  await sleep(1200)
  const ntfXYZ = await ntf()
  const afterXYZ = await state()
  const lang = await ev('window.__L.settings().language')
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'i18n', `${lang}.json`), 'utf-8'))
  report.check(
    '拖入 .xyz → 明确提示「不支持的文件类型」（文案取自该语言的包，不写死中文）',
    ntfXYZ.some((t) => t.indexOf(pack.toast.unsupportedFile) >= 0),
    JSON.stringify({ lang, want: pack.toast.unsupportedFile, got: ntfXYZ })
  )
  report.check(
    '不支持的拖入**不会**换掉当前文档',
    sameFile(afterXYZ.path, mdA) && afterXYZ.doc.indexOf('DROPPED-A') >= 0,
    JSON.stringify({ path: afterXYZ.path, doc: afterXYZ.doc })
  )

  // ── 3. 拖一个**文件夹**进**空窗口**（无工作区）→ 就用这个窗口成为它的工作区 ──
  //    口径（第六轮）：空窗口没有东西可失去（没有工作区树要换、正文缓冲区不会被碰），
  //    再为它开一个窗口等于留下一个必须手动关掉的空壳；而且同一条链上的**文件**规则
  //    （lib/openFile.ts 第③条）就是"本窗口没有文件夹 → 就在本窗口打开"。
  await ev(`(async () => { await window.__L.files().setRoot(null); return 'ok' })()`)
  await sleep(600)
  await ev(`(async () => { await window.__L.notifications().closeAll(); return 'ok' })()`)
  if (editorPt) await dropFiles(editorPt, [pkgDir])
  await until(`!!window.__L.files().root && window.__L.files().root.toLowerCase().indexOf('lumin-drop-suite') >= 0`, 8000)
  const afterPkg = await state()
  const tree = await ev(TREE).then(JSON.parse)
  const pagesAfterEmpty = (await appPages()).length
  report.check(
    '空窗口拖入文件夹 ⇒ 这个窗口成为它的工作区（root = 被拖的目录）',
    sameFile(afterPkg.root, pkgDir),
    JSON.stringify({ root: afterPkg.root, want: pkgDir })
  )
  report.check(
    '空窗口拖入文件夹 ⇒ **不**新开窗口（窗口数仍是 1）',
    pagesAfterEmpty === 1,
    'pages=' + pagesAfterEmpty
  )
  report.check(
    '侧栏真的切到那个文件夹：树的顶层行 = 它，且子项里能看见里面的文件',
    sameFile(tree.rootRow, pkgDir) && tree.rows.some((r) => /inside\.md$/i.test(r || '')),
    JSON.stringify(tree)
  )

  // ── 4. **同一个文件夹**再拖一次 → 明确 no-op：不新开窗口、不动工作区，但要**说出来** ──
  //    为什么不能静默：上一轮用户报的就是"拖进来没反应"，静默会让人以为功能又坏了。
  //    文案从**该语言的包**里取（不写死中文）；改前那份包里还没有这个 key ——
  //    这里给一个"缺 key"的替身，好让改前那一跑是一条**干净的 FAIL**，而不是脚本崩掉。
  const alreadyTpl =
    pack.toast.workspaceAlreadyOpen ?? '(missing i18n key: toast.workspaceAlreadyOpen)'
  const expectAlready = (name) => alreadyTpl.replace('{name}', name)
  const rootBeforeSame = (await state()).root
  /**
   * "有没有动过工作区"要有一个**可观测**的判据（否则"根不变"在改前也成立：改前是把同一个
   * 路径 `setRoot` 了一遍，值当然还是它）。`files.setRoot` 会 `expanded.clear()` ——
   * 所以先把子文件夹展开，再看它有没有被清掉：清掉 = 真的又设了一次工作区。
   */
  const subRow = tree.rows.find((r) => /\\sub$/.test(r || '')) || null
  if (subRow) {
    await ev(`(async () => { window.__L.files().toggleDir(${JSON.stringify(subRow)}); return 'ok' })()`)
    await sleep(500)
  }
  const expandedBefore = JSON.parse(
    await ev('JSON.stringify(Array.from(window.__L.files().expanded))')
  )
  await ev(`(async () => { await window.__L.notifications().closeAll(); return 'ok' })()`)
  if (editorPt) await dropFiles(editorPt, [pkgDir])
  await sleep(1600)
  const afterSame = await state()
  const ntfSame = await ntf()
  const pagesSame = (await appPages()).length
  const expandedAfter = JSON.parse(
    await ev('JSON.stringify(Array.from(window.__L.files().expanded))')
  )
  report.check(
    '同一个文件夹再拖一次 ⇒ 窗口数不变、工作区根不变（明确 no-op）',
    pagesSame === 1 && afterSame.root === rootBeforeSame,
    JSON.stringify({ pages: pagesSame, root: afterSame.root, before: rootBeforeSame })
  )
  report.check(
    '同一个文件夹再拖一次 ⇒ 工作区**没有被重新设置**（展开态没被 clear；改前会整棵树塌回根）',
    !!subRow && expandedBefore.includes(subRow) && expandedAfter.includes(subRow),
    JSON.stringify({ subRow, before: expandedBefore, after: expandedAfter })
  )
  report.check(
    '同一个文件夹再拖一次 ⇒ **有**一条"已经是当前工作区"的提示（不许静默）',
    ntfSame.some((t) => t.indexOf(expectAlready('pkg')) >= 0),
    JSON.stringify({ lang, want: expectAlready('pkg'), got: ntfSame })
  )

  // ── 4b. 稳健性 E2E：把工作区根写成**等价但不同字面**的写法，再拖真实路径的那个文件夹 ──
  //     比较是主进程做的（pathGuard.sameResolvedPath + realpath），这里验的是"真的走通了那条路"。
  //     四种写法（大小写 / 末尾 `\` / 正斜杠 / `..`）的穷举在 tests/pathGuard.test.mjs（纯函数单测），
  //     另加两条**只有 realpath 那一段能判出来**的（8.3 短名 ⇄ 长名、junction ⇄ 真实目录）。
  const longPkg = (() => {
    try {
      return fs.realpathSync.native(pkgDir)
    } catch {
      return pkgDir
    }
  })()
  // junction：`mklink /J` 不需要管理员权限（符号链接才要），实测 EXIT=0
  const linkDir = path.join(base, 'pkg-link')
  const junctionOk =
    require('child_process').spawnSync('cmd', ['/c', 'mklink', '/J', linkDir, pkgDir], {
      stdio: 'ignore'
    }).status === 0
  const variants = [
    { why: '大写 + 末尾反斜杠', value: pkgDir.toUpperCase() + '\\' },
    { why: '正斜杠 + `sub/..`', value: pkgDir.replace(/\\/g, '/') + '/sub/..' }
  ]
  if (longPkg.toLowerCase() !== pkgDir.toLowerCase()) {
    variants.push({ why: '长名（8.3 短名要靠 realpath 才认得出来）', value: longPkg })
  }
  if (junctionOk) variants.push({ why: 'junction（指向同一个目录）', value: linkDir })
  for (const v of variants) {
    await ev(
      `(async () => { await window.__L.files().setRoot(${JSON.stringify(v.value)}); return 'ok' })()`
    )
    await sleep(700)
    await ev(`(async () => { await window.__L.notifications().closeAll(); return 'ok' })()`)
    const beforeVariant = (await state()).root
    if (editorPt) await dropFiles(editorPt, [pkgDir])
    await sleep(1500)
    const afterVariant = await state()
    const ntfVariant = await ntf()
    const pagesVariant = (await appPages()).length
    report.check(
      `稳健性-工作区根写成「${v.why}」时，拖同一个文件夹仍判"相同"（不新开窗口 + 根不变 + 有提示）`,
      pagesVariant === 1 &&
        afterVariant.root === beforeVariant &&
        ntfVariant.some((t) => t.indexOf(expectAlready('pkg')) >= 0),
      JSON.stringify({
        variant: v.value,
        pages: pagesVariant,
        root: afterVariant.root,
        ntf: ntfVariant
      })
    )
  }

  // ── 5. 拖一个**不同**的文件夹 → 走既有的"应用外请求打开目录 → 新窗口以它为工作区" ──
  const rootBeforeNew = (await state()).root
  const pagesBeforeNew = await appPages()
  if (editorPt) await dropFiles(editorPt, [pkg2Dir])
  const endNew = Date.now() + 12000
  let pagesAfterNew = await appPages()
  while (pagesAfterNew.length <= pagesBeforeNew.length && Date.now() < endNew) {
    await sleep(250)
    pagesAfterNew = await appPages()
  }
  report.check(
    '拖入**不同**的文件夹 ⇒ 新开一个窗口（窗口数 +1）',
    pagesAfterNew.length === pagesBeforeNew.length + 1,
    `before=${pagesBeforeNew.length} after=${pagesAfterNew.length}`
  )
  const known = new Set(pagesBeforeNew.map((p) => p.webSocketDebuggerUrl))
  const newPage = pagesAfterNew.find((p) => !known.has(p.webSocketDebuggerUrl))
  let newWindowRoot = null
  if (newPage) {
    const child = await attach(newPage)
    if (await settle(child.ev)) {
      newWindowRoot = await child.ev('window.__L.files().root')
    }
    child.close()
  }
  report.check(
    '新窗口的工作区根 = 被拖的那个目录',
    sameFile(newWindowRoot, pkg2Dir),
    JSON.stringify({ root: newWindowRoot, want: pkg2Dir, url: newPage && newPage.url })
  )
  report.check(
    '开新窗口**不动当前窗口**的工作区（老窗口还是原来那个文件夹）',
    (await state()).root === rootBeforeNew,
    JSON.stringify({ root: (await state()).root, before: rootBeforeNew })
  )

  // ── 6. 拖到**侧栏**（左半边，不在编辑区的子树里）也要打开：用户口径是"拖入应用内" ──
  await ev(`(async () => { await window.__L.files().setRoot(null); return 'ok' })()`)
  await sleep(600)
  const sidePt = await pointIn('[data-sidebar-files]', 'r.bottom - 24')
  report.check('fixture-侧栏空白处拿得到落点坐标', !!sidePt, JSON.stringify(sidePt))
  if (sidePt) {
    await dropFiles(sidePt, [mdB])
    await until(`window.__L.files().current && window.__L.files().current.content.indexOf('DROPPED-B') >= 0`, 8000)
  }
  const afterSide = await state()
  report.check(
    '拖到侧栏 → 同样打开（回归前只有编辑区那一小块认这个手势）',
    sameFile(afterSide.path, mdB) && afterSide.doc.indexOf('DROPPED-B') >= 0,
    JSON.stringify({ path: afterSide.path, doc: afterSide.doc, root: afterSide.root })
  )

  // ── 7. 往编辑器里拖**图片**：附件照样生成，且**不许**再弹「不支持的文件类型」──
  //    （d014773 想修的就是这个双弹；它用错了"内层已认领"的信号，把整条打开链一起关掉了。）
  await ev(
    `(async () => { await window.__L.files().setRoot(${JSON.stringify(wsDir)}); return 'ok' })()`
  )
  await sleep(700)
  await ev(`(async () => { return await window.__L.files().openPath(${JSON.stringify(wsDoc)}) })()`)
  await until(`window.__L.files().current && window.__L.files().current.content && window.__L.files().current.content.indexOf('图片落点') >= 0`, 6000)
  await ev(`(async () => { await window.__L.notifications().closeAll(); return 'ok' })()`)
  await sleep(300)
  // ⚠️ 落点必须落在 `.ProseMirror` **里面**（段落上）：图片拖入是内核插件在
  //    `.ProseMirror` 上的 drop 监听里处理的 —— 点在编辑器的内边距上，事件根本不进内核。
  const imgPt =
    (await pointIn('.ProseMirror p', 'r.top + Math.min(8, r.height / 2)')) || editorPt
  if (imgPt) await dropFiles(imgPt, [pngSrc])
  await until(`window.__L.ed() && window.__L.ed().storage.markdown.getMarkdown().indexOf('assets/') >= 0`, 8000)
  await sleep(600)
  const afterImg = await state()
  const ntfImg = await ntf()
  const assetsDir = path.join(wsDir, 'assets')
  const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []
  report.check(
    '拖入图片 → 附件真的落进 <工作区>/assets/ 并插进正文（这条路径不许被本轮改动弄坏）',
    /!\[[^\]]*\]\([^)]*assets\/[^)]*\)/.test(afterImg.md || '') && assets.length >= 1,
    JSON.stringify({ pt: imgPt, md: (afterImg.md || '').slice(0, 120), assets, ntf: ntfImg })
  )
  report.check(
    '拖入图片**不再**同时弹「不支持的文件类型」（内层认领的信号改成了 stopPropagation）',
    !ntfImg.some((t) => t.indexOf(pack.toast.unsupportedFile) >= 0),
    JSON.stringify(ntfImg)
  )
  report.check(
    '拖入图片没有被当成"打开这个文件"（当前文档仍是那篇 md）',
    sameFile(afterImg.path, wsDoc),
    JSON.stringify({ path: afterImg.path, want: wsDoc })
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
