'use strict'
// ─── 验收：打开基础**文本文档**（第七轮：`.txt` 等纯文本族）────────────────────────
//
// 用户原话：「本项目不光可以打开 .md 文档，还能打开基础的 .txt 等文本文档。」
//
// 本轮做的事（判据就按这几条来）：
//   ① **唯一真相源**：可打开的扩展名清单收在 `src/shared/textFiles.ts`，文件树扫描 / 全文索引 /
//      链接判定 / 「打开文件」对话框 filters / 拖入白名单 / 重命名与导出标题**全部**由它派生
//      （清单字面量只许出现在那一个文件里 —— 由 tests/textFiles.test.mjs 静态守）。
//   ② 新增纯文本族：`text` / `log` / `ini` / `cfg`（`txt` 本来就在）。
//   ③ 打开语义沿用既有规则：无工作区→本窗口打开并把侧栏切到它所在目录；有工作区→新窗口。
//      **文件树里必须看得见**（能拖进来打开、树里却看不见 = 没做完）。
//   ④ 纯文本族默认以**源码模式**打开：渲染面会按 Markdown 重新解释它（实测：有序列表被重编号、
//      裸 URL 变成 `<url>`、`__init__` 被插进 `**`、两行散文被并成一行），一旦保存就改写了用户文件。
//      `.md` 家族一个字没动（仍然是渲染面）。
//
// 判据用 **CDP `Input.dispatchDragEvent`**（`DragData.files` = 真实磁盘路径，OS 级拖放模拟）。
// 跑法：node tools/_verify-text-open.js（先起隔离实例，见 tools/start-isolated.ps1）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, sleep, waitEditor, Reporter, fatal } = require('./lib/harness')

const ROOT = path.join(__dirname, '..')

/** 页面状态快照（拖入/打开之后断言它） */
const STATE = `JSON.stringify({
  path: window.__L.files().current ? window.__L.files().current.path : null,
  name: window.__L.files().current ? window.__L.files().current.name : null,
  content: window.__L.files().current ? window.__L.files().current.content : null,
  encoding: window.__L.files().current ? window.__L.files().current.encoding : null,
  hadReplacement: window.__L.files().current ? !!window.__L.files().current.hadReplacement : null,
  root: window.__L.files().root,
  mode: window.__L.ui().editorMode,
  title: document.title,
  doc: window.__L.ed() ? window.__L.ed().state.doc.textContent : null,
  source: (() => { const t = document.querySelector('[data-source-editor]'); return t ? t.value : null })(),
  sourceVisible: (() => { const t = document.querySelector('[data-source-editor]'); return !!t && t.offsetParent !== null })()
})`

/** 文件树里可见的条目路径（语义锚点 `data-tree-path`） */
const TREE = `JSON.stringify([...document.querySelectorAll('[data-tree-path]')].map((r) => r.getAttribute('data-tree-path')))`

/** 通知中心里的通知文本（`data-ntf-item`） */
const NTF = `JSON.stringify([...document.querySelectorAll('[data-ntf-item]')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()))`

const same = (a, b) => {
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
  const report = new Reporter('验收：文本文档（.txt/.log/.ini/.cfg…）能打开、树里看得见、保存不改后缀')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { ev, send } = app
  const state = () => ev(STATE).then(JSON.parse)
  const ntf = () => ev(NTF).then(JSON.parse)
  const until = async (expr, ms = 8000) => {
    const end = Date.now() + ms
    for (;;) {
      if (await ev(expr)) return true
      if (Date.now() > end) return false
      await sleep(150)
    }
  }
  const pointIn = async (selector, place) => {
    const raw = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return 'null'
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(${place}) })
    })()`)
    return raw === 'null' ? null : JSON.parse(raw)
  }
  const dropFiles = async (pt, files) => {
    const data = { items: [], files, dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data, modifiers: 0 })
      await sleep(180)
    }
  }
  /** 页面侧：在源码 textarea 上"打字"（改值 + 派发真实 input 事件，走的是应用自己的 onSourceInput） */
  const typeInSource = (next) => `(() => {
    const t = document.querySelector('[data-source-editor]')
    if (!t) return 'no-textarea'
    t.value = ${JSON.stringify(next)}
    t.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`

  // ── 夹具：一个既有 .md 又有各种纯文本的工作区；另有一份 GBK 编码的 .txt ──
  const base = path.join(os.tmpdir(), 'lumin-text-suite')
  fs.rmSync(base, { recursive: true, force: true })
  const ws = path.join(base, 'ws')
  fs.mkdirSync(ws, { recursive: true })
  const mdPath = path.join(ws, 'note.md')
  const txtPath = path.join(ws, 'plain.txt')
  const logPath = path.join(ws, 'run.log')
  const iniPath = path.join(ws, 'app.ini')
  const cfgPath = path.join(ws, 'tweak.cfg')
  const textPath = path.join(ws, 'readme.text')
  const gbkPath = path.join(ws, 'gbk.txt')
  const MD_BODY = '# MD-TITLE\n\n正文一段。\n'
  const TXT_BODY = 'PLAIN-TXT-LINE\nsecond line\n'
  fs.writeFileSync(mdPath, MD_BODY, 'utf8')
  fs.writeFileSync(txtPath, TXT_BODY, 'utf8')
  fs.writeFileSync(logPath, 'LOG-LINE-1\nLOG-LINE-2\n', 'utf8')
  fs.writeFileSync(iniPath, '[section]\nkey=value\n', 'utf8')
  fs.writeFileSync(cfgPath, 'CFG=1\n', 'utf8')
  fs.writeFileSync(textPath, 'TEXT-EXT-LINE\n', 'utf8')
  // GBK 字节：`GBK-` + 「测试」（测=B2 E2，试=CA D4）+ 换行。故意**不是** UTF-8，
  // 走的是主进程那条编码判定链（与扩展名无关）。
  fs.writeFileSync(gbkPath, Buffer.from([0x47, 0x42, 0x4b, 0x2d, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]))

  const lang = await ev('window.__L.settings().language')
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'i18n', `${lang}.json`), 'utf-8'))
  /**
   * 提示文案从**该语言的包**里取（不写死中文）。改前那份包里还没有这个 key ——
   * 给一个"缺 key"的替身，好让改前那一跑是**干净的 FAIL**，而不是脚本崩掉。
   */
  const plainTpl =
    pack.toast.plainTextSourceMode ?? '(missing i18n key: toast.plainTextSourceMode)'
  const plainName = 'plain.txt'
  const expectPlainToast = plainTpl.replace('{name}', plainName)
  /** `{name}` 之后那一段（判断"是不是这一类提示"用，与语言无关） */
  const plainTail = plainTpl.split('{name}')[1] ?? plainTpl
  const editorPt =
    (await pointIn('.ProseMirror', 'r.top + 40')) ||
    (await pointIn('[data-editor-kernel]', 'r.top + 40'))
  report.check('fixture-拿得到编辑区落点坐标', !!editorPt, JSON.stringify(editorPt))

  // ── 1. 拖入一个 .txt（此刻**没有工作区**）→ 本窗口打开 + 侧栏切到它所在目录 ──
  await ev(`(async () => { await window.__L.notifications().closeAll(); return 'ok' })()`)
  if (editorPt) await dropFiles(editorPt, [txtPath])
  await until(`window.__L.files().current && window.__L.files().current.name === 'plain.txt'`)
  const t1 = await state()
  report.check(
    '拖入 .txt → 真的打开了（当前文档名 / 正文 / 窗口标题三处都对）',
    t1.name === 'plain.txt' && t1.content === TXT_BODY && t1.title.indexOf('plain.txt') >= 0,
    JSON.stringify({ name: t1.name, content: t1.content, title: t1.title })
  )
  report.check(
    '无工作区时的落点规则没变：本窗口打开 + 侧栏切到该文件所在目录',
    same(t1.path, txtPath) && same(t1.root, ws),
    JSON.stringify({ path: t1.path, root: t1.root, wantRoot: ws })
  )
  report.check(
    '纯文本族默认用**源码模式**打开（渲染面会按 Markdown 曲解它：重编号 / autolink / 插入 `**`）',
    t1.mode === 'source' && t1.source === TXT_BODY,
    JSON.stringify({ mode: t1.mode, source: t1.source })
  )
  report.check(
    '源码面内容与磁盘**逐字相同**（这是"纯文本不该被改写"的护栏：源码面逐字进出）',
    t1.source === fs.readFileSync(txtPath, 'utf8'),
    JSON.stringify({ source: t1.source, disk: fs.readFileSync(txtPath, 'utf8') })
  )
  const ntfTxt = await ntf()
  report.check(
    '纯文本打开时给一条说明（文案取自该语言的包，不写死中文）',
    ntfTxt.some((t) => t.indexOf(expectPlainToast) >= 0),
    JSON.stringify({ want: expectPlainToast, got: ntfTxt })
  )

  // ── 2. 文件树：把工作区设成这批夹具，**六种文本类型都要看得见**（含新加的四类）──
  await ev(`(async () => { await window.__L.files().setRoot(${JSON.stringify(ws)}); return 'ok' })()`)
  await sleep(1200)
  const rows = await ev(TREE).then(JSON.parse)
  const has = (p) => rows.some((r) => same(r, p))
  report.check(
    '文件树里看得见 .md 与 .txt（本来就支持）',
    has(mdPath) && has(txtPath),
    JSON.stringify(rows)
  )
  report.check(
    '文件树里看得见本轮新增的四种纯文本（.log/.ini/.cfg/.text）',
    has(logPath) && has(iniPath) && has(cfgPath) && has(textPath),
    JSON.stringify(rows)
  )
  report.check(
    '不该进的没进来：工作区里没有 .json/.html/源码类夹具，但这份清单本身由单测守（见 tests/textFiles.test.mjs）',
    rows.every((r) => /\.(md|markdown|mdown|mkd|txt|text|log|ini|cfg)$/i.test(r) || !path.extname(r)),
    JSON.stringify(rows)
  )

  // ── 3. 每种新类型都能真的打开（逐一点开，不靠拖）──
  const openCases = [
    { p: logPath, name: 'run.log', body: 'LOG-LINE-1\nLOG-LINE-2\n' },
    { p: iniPath, name: 'app.ini', body: '[section]\nkey=value\n' },
    { p: cfgPath, name: 'tweak.cfg', body: 'CFG=1\n' },
    { p: textPath, name: 'readme.text', body: 'TEXT-EXT-LINE\n' }
  ]
  const opened = []
  for (const c of openCases) {
    await ev(`(async () => { return await window.__L.files().openPath(${JSON.stringify(c.p)}) })()`)
    await sleep(700)
    const s = await state()
    opened.push({ name: c.name, ok: s.name === c.name && s.content === c.body, mode: s.mode })
  }
  report.check(
    '新增的四种类型都能打开且内容一字不差（.log/.ini/.cfg/.text）',
    opened.every((o) => o.ok),
    JSON.stringify(opened)
  )
  report.check(
    '它们也都走源码模式（同一条纯文本口径）',
    opened.every((o) => o.mode === 'source'),
    JSON.stringify(opened)
  )

  // ── 4. `.md` 一个字都没变：仍然是渲染面（不许被纯文本规则误伤）──
  //    "有没有新增纯文本提示"用**数量**比（而不是"列表里有没有"）：列表里可能还挂着更早的
  //    那几条（通知是持久化的，closeAll 之后仍有残留），拿绝对有无做判据会假红。
  //    文案从该语言的包里取，只比较 `{name}` 之后那一段 —— 不写死中文。
  const countPlainToast = async () =>
    (await ntf()).filter((t) => t.indexOf(plainTail) >= 0).length
  const plainBeforeMd = await countPlainToast()
  await ev(`(async () => { window.__L.ui().editorMode = 'wysiwyg'; await window.__L.files().openPath(${JSON.stringify(mdPath)}); return 'ok' })()`)
  await until(`window.__L.files().current && window.__L.files().current.name === 'note.md'`)
  await waitEditor(ev)
  await sleep(900)
  const mdState = await state()
  report.check(
    '.md 仍然用渲染面打开（正文按 Markdown 解释：标题成了 h1、文档里没有 `#`）',
    mdState.mode === 'wysiwyg' &&
      mdState.doc.indexOf('MD-TITLE') >= 0 &&
      mdState.doc.indexOf('#') < 0 &&
      (await ev(`!!document.querySelector('.ProseMirror h1')`)) === true,
    JSON.stringify({ mode: mdState.mode, doc: mdState.doc, h1: await ev(`!!document.querySelector('.ProseMirror h1')`) })
  )
  report.check(
    '.md 打开时**不新增**纯文本那条提示（规则只作用于纯文本族）',
    (await countPlainToast()) === plainBeforeMd,
    JSON.stringify({ before: plainBeforeMd, after: await countPlainToast(), list: await ntf() })
  )

  // ── 5. 保存后扩展名不变：改一个字符 → 保存 → 磁盘上仍是 .txt，且没多出 .md ──
  await ev(`(async () => { await window.__L.files().openPath(${JSON.stringify(txtPath)}); return 'ok' })()`)
  await until(`window.__L.files().current && window.__L.files().current.name === 'plain.txt'`)
  await sleep(700)
  const edited = `${TXT_BODY}APPENDED-LINE\n`
  const typed = await ev(typeInSource(edited))
  await sleep(500)
  const beforeSave = await state()
  await ev(`(async () => { return await window.__L.files().save() })()`)
  await sleep(900)
  const afterSave = await state()
  const diskTxt = fs.readFileSync(txtPath, 'utf8')
  const siblings = fs.readdirSync(ws)
  report.check(
    '源码面输入的改动真的进了 store（不是我们直接写盘）',
    typed === 'ok' && beforeSave.content === edited,
    JSON.stringify({ typed, content: beforeSave.content })
  )
  report.check(
    '保存后**扩展名不变**：磁盘上还是 plain.txt，内容就是刚敲进去的那份',
    same(afterSave.path, txtPath) && diskTxt === edited,
    JSON.stringify({ path: afterSave.path, disk: diskTxt, want: edited })
  )
  report.check(
    '没有多出 .md / .txt.md 之类的第二份文件（另存为保留原后缀，见 tests/textFiles.test.mjs 的 saveDefaultName）',
    siblings.filter((n) => /^plain\./i.test(n)).join(',') === 'plain.txt',
    JSON.stringify(siblings)
  )
  fs.writeFileSync(txtPath, TXT_BODY, 'utf8') // 还原夹具，后面的断言不受影响

  // ── 6. 非 UTF-8（GBK）的 .txt 也能打开并识别编码 ──
  await ev(`(async () => { return await window.__L.files().openPath(${JSON.stringify(gbkPath)}) })()`)
  await until(`window.__L.files().current && window.__L.files().current.name === 'gbk.txt'`)
  await sleep(700)
  const gbk = await state()
  report.check(
    'GBK 编码的 .txt → 编码判定链认出它（gbk/gb18030 家族），正文正确、没有替换字符',
    ['gbk', 'gb18030'].includes(String(gbk.encoding)) &&
      gbk.content === 'GBK-测试\n' &&
      gbk.hadReplacement === false,
    JSON.stringify({ encoding: gbk.encoding, content: gbk.content, hadReplacement: gbk.hadReplacement })
  )
  report.check(
    'GBK 的 .txt 同样走源码模式（纯文本族口径与编码无关）',
    gbk.mode === 'source',
    JSON.stringify({ mode: gbk.mode })
  )

  // ── 7. 静态接线：对话框过滤器 / 另存为后缀都派生自唯一真相源 ──
  //    （原生对话框在 CDP 里点不动 —— 这条只能静态 + 单测钉住，如实说明）
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.ts'), 'utf-8')
  const filesSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'stores', 'files.ts'),
    'utf-8'
  )
  report.check(
    '接线-「打开文件」对话框的 filters 由真相源派生（不是硬编码数组）',
    /openFileDialogFilters\(/.test(ipcSrc) && !/extensions: \['md'/.test(ipcSrc),
    'src/main/ipc.ts'
  )
  report.check(
    '接线-拖入路径模块已删除（拖拽禁用后无调用方），另存为后缀仍走真相源',
    !fs.existsSync(path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'droppedPath.ts')) &&
      /saveDefaultName\(/.test(filesSrc),
    'droppedPath.ts（应不存在）/ files.ts'
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
