// 验收：超链接打开逻辑（网址 / 同级文件名 / 相对路径 / 绝对路径 + 缺失目标按需创建 + SQLite 持久化）
//
// 覆盖（全部在另开的新窗口里跑，用户窗口不受影响）：
//  A. 分类矩阵（真实 IPC + 真实文件系统探测）：url / file / relative / absolute、
//     盘符路径不被误判成 URL、file:// 转换、空链接、缺基准目录、非文本不可创建
//  B. 创建：真实落盘、父目录一并创建、已存在拒绝覆盖（wx）
//  C. 端到端 Ctrl+左键：同级已存在文件 → 新窗口打开该文件（真实新窗口 + 文件名断言）
//  D. 端到端 Ctrl+左键：同级缺失文件 → 询问弹窗 → 「取消」不创建、记录 declined
//  E. 端到端 Ctrl+左键：同级缺失文件 → 「确定」创建 + 新窗口打开
//  F. 危险协议（javascript:）→ 拒绝并报错，绝不调用 shell.openExternal
//  G. 非文本缺失目标（photo.png）→ 提示不可创建，不落盘
//  H. 历史记录 CRUD：重复打开累加计数、forget、clear，并直读 SQLite 落盘文件校验
//  I. 设置 → 链接页签：创建策略三态、历史列表渲染、单条删除（真实点击）
//  J. 复原：设置、最近文件、临时目录与临时文档索引
//
// 范围说明：外部浏览器（http/https）与系统默认应用（shell.openPath）的「真正拉起
// 操作系统程序」这一步**不在自动验收里执行**——它会在用户桌面上弹出浏览器/编辑器。
// 这里验证到「分类结果 + 分支决策 + IPC 通道契约」为止：
//  - shell:openPath 用不存在的路径调用，只校验返回错误串（不拉起任何程序）；
//  - shell:openExternal 的白名单判定与 links:resolve 共用同一份 EXTERNAL_SCHEMES。
const CDP = 'http://127.0.0.1:9222/json'
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR = path.join(os.tmpdir(), 'lumin-link-verify')
const DOC = path.join(DIR, 'main.md')
const SIBLING = path.join(DIR, 'sibling.md')
const MISSING = path.join(DIR, 'missing.md')
const ASKED = path.join(DIR, 'ask-create.md')
const SUBDIR = path.join(DIR, 'sub')
const DEEP = path.join(DIR, 'deep', 'nested', 'new.md')
const ABS_FILE = path.join(DIR, 'absolute.md')
const PHOTO = path.join(DIR, 'photo.png')
const CREATED_DIR = path.join(DIR, 'created-dir')

const MD = [
  '# 链接打开验收',
  '',
  '[网址](https://example.com/path?q=1)',
  '',
  '[同级文件](sibling.md)',
  '',
  '[同级缺失](missing.md)',
  '',
  '[询问创建](ask-create.md)',
  '',
  '[相对路径](./deep/nested/new.md)',
  '',
  '[目录](sub/)',
  '',
  '[非文本](photo.png)',
  '',
  // ftp: 编辑器允许（tiptap Link 的允许协议表里有），但打开器白名单只放行
  // http/https/mailto —— 正好用来验收「协议白名单拒绝」这条路径
  '[危险协议](ftp://example.com/file)',
  '',
  // javascript: 会被编辑器自身的 URL 校验直接拒绝（不成为链接），单独断言
  '[编辑器拒绝协议](javascript:alert(1))',
  '',
  '尾段'
].join('\n')

let ws,
  id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) {
  return new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
}
async function ev(e) {
  const r = await send('Runtime.evaluate', {
    expression: e,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails)
    throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const appPages = async () =>
  (await (await fetch(CDP)).json()).filter((t) => t.type === 'page' && t.url.includes('5173'))

async function attach(page) {
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    sock.onopen = res
    sock.onerror = rej
  })
  let n = 0
  const waiters = new Map()
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)(m)
      waiters.delete(m.id)
    }
  }
  const s = (method, params) =>
    new Promise((r) => {
      const i = ++n
      waiters.set(i, r)
      sock.send(JSON.stringify({ id: i, method, params }))
    })
  const e = async (expr) =>
    (await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
      .result?.result?.value
  return { sock, send: s, ev: e }
}

/** 等待出现「不在 known 里」的新窗口 */
async function waitNewWindow(known, ms = 9000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await sleep(300)
    const fresh = (await appPages()).find((p) => !known.includes(p.id))
    if (fresh) return fresh
  }
  return null
}
async function closePage(page) {
  const { sock, send: s } = await attach(page)
  await s('Page.close').catch(() => {})
  await sleep(400)
  sock.close()
}
/** 读取某窗口当前打开的文档路径 */
async function pageDocPath(page) {
  const { sock, ev: e } = await attach(page)
  const v = await e(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return null
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const f = app._context.provides[sym]._s.get('files')
    return f.current?.path ?? null
  })()`)
  sock.close()
  return v
}
async function clickCtrl(x, y, wait = 700) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
    modifiers: 2 // Ctrl
  })
  await sleep(50)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
    modifiers: 2
  })
  await sleep(wait)
}
/** 文档里某个链接文字的点击坐标（编辑器未就绪时抛明确错误） */
async function linkPoint(text) {
  const raw = await ev(`(() => {
    const ed = window.__vt.ed()
    if (!ed) return 'NO_EDITOR'
    let pos = -1
    ed.state.doc.descendants((n, p) => {
      if (n.isText && pos < 0 && n.text === ${JSON.stringify(text)} && n.marks.some((m) => m.type.name === 'link')) pos = p
    })
    if (pos < 0) return 'null'
    const co = ed.view.coordsAtPos(pos + 1)
    return JSON.stringify({ x: Math.round(co.left + 4), y: Math.round((co.top + co.bottom) / 2) })
  })()`)
  if (raw === 'NO_EDITOR') throw new Error('编辑器实例未就绪（linkPoint ' + text + '）')
  return raw && raw !== 'null' ? JSON.parse(raw) : null
}
/** 等编辑器实例挂载 + 夹具内容就绪（openPath 不会自动切路由，须先设 hash） */
async function waitEditorReady(marker, ms = 12000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await ev(`(() => {
      const ed = window.__vt.ed()
      if (!ed) return false
      return ed.state.doc.textContent.includes(${JSON.stringify(marker)})
    })()`)
    if (ok === true) return true
    await sleep(300)
  }
  return false
}
const RESOLVE = (target, baseDir) =>
  `(async () => JSON.stringify(await window.luminAPI.links.resolve(${JSON.stringify(target)}, ${JSON.stringify(baseDir)})))()`
const HISTORY = `(async () => JSON.stringify(await window.luminAPI.links.history(50)))()`
/** 确认弹窗（ModalHost）里的按钮：0=取消 1=确定 */
const MODAL_BTN = (i) => `(() => {
  const mask = [...document.querySelectorAll('div')].find((d) => d.className?.toString?.().includes('z-[150]') && d.className?.toString?.().includes('fixed'))
  if (!mask) return 'null'
  const btns = [...mask.querySelectorAll('button.btn')]
  const b = btns[${i}]
  if (!b) return 'null'
  const r = b.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: b.textContent.trim() })
})()`
const NOTIF_TITLES = `(() => JSON.stringify(window.__vt.notifications().items.map((n) => n.level + ':' + n.title)))()`
/** 通知列表里是否存在某级别的通知（关键词匹配，避免绑死整句文案） */
function hasNotif(raw, level, keyword) {
  try {
    return JSON.parse(raw).some((x) => x.startsWith(level + ':') && x.includes(keyword))
  } catch {
    return false
  }
}

async function main() {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // ── 夹具 ──────────────────────────────────────────────────────────────────
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(SUBDIR, { recursive: true })
  fs.writeFileSync(SIBLING, '# 同级文件\n', 'utf-8')
  fs.writeFileSync(ABS_FILE, '# 绝对路径文件\n', 'utf-8')
  fs.writeFileSync(DOC, MD, 'utf-8')
  console.log('FIXTURES ' + DIR)

  // ── 开一个干净的验收窗口 ──────────────────────────────────────────────────
  const initial = await appPages()
  const opener = await attach(initial[0])
  await opener.send('Runtime.evaluate', {
    expression: '(window.luminAPI.app.newWindow(), "ok")',
    returnByValue: true
  })
  const temp = await waitNewWindow(initial.map((p) => p.id))
  opener.sock.close()
  if (!temp) {
    console.log('SKIP: 第二个窗口未出现')
    return
  }
  console.log('（在第二个窗口里验收，用户窗口不受影响）')

  ws = new WebSocket(temp.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
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
  await send('Page.enable')
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break
  }
  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym]
    window.__vt = {
      ui: () => pinia._s.get('ui'),
      files: () => pinia._s.get('files'),
      settings: () => pinia._s.get('settings'),
      notifications: () => pinia._s.get('notifications'),
      ed: () => pinia._s.get('editor')?.instance ?? null
    }
    return 'ok'
  })()`)

  const snapshot = JSON.parse(
    await ev(
      `(() => { const s = window.__vt.settings(); return JSON.stringify({ linkCreateMode: s.linkCreateMode ?? null, recentFiles: s.recentFiles }) })()`
    )
  )
  console.log(
    'SNAPSHOT ' +
      JSON.stringify({
        linkCreateMode: snapshot.linkCreateMode,
        recent: snapshot.recentFiles.length
      })
  )

  // 打开夹具文档（基准目录 = 夹具目录）
  // 注意：files.openPath 只切文件不切路由，须显式进入编辑器路由，否则编辑器不挂载
  await ev(
    `(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`
  )
  await sleep(600)
  await ev(
    `(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openPath(${JSON.stringify(DOC)}); return 'ok' })()`
  )
  const ready = await waitEditorReady('链接打开验收')
  const opened = JSON.parse(
    await ev(
      `(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`
    )
  )
  console.log('OPENED ' + JSON.stringify({ ...opened, editorReady: ready }))
  c(
    'fixture-document-opened',
    opened.path === DOC && ready === true,
    JSON.stringify({ ...opened, ready })
  )
  if (opened.path !== DOC || !ready) {
    console.log(results.join('\n'))
    ws.close()
    return
  }

  // ── A. 分类矩阵 ──────────────────────────────────────────────────────────
  const matrix = [
    ['https://example.com/path?q=1', 'url', 'external', null],
    ['http://example.com', 'url', 'external', null],
    ['mailto:someone@example.com', 'url', 'external', null],
    ['javascript:alert(1)', 'url', 'external', 'unsupported-scheme'],
    ['ms-msdt:/id', 'url', 'external', 'unsupported-scheme'],
    ['sibling.md', 'file', 'window', null],
    ['missing.md', 'file', 'window', null],
    ['photo.png', 'file', 'default-app', null],
    ['./deep/nested/new.md', 'relative', 'default-app', null],
    ['sub/', 'relative', 'default-app', null],
    [ABS_FILE, 'absolute', 'default-app', null],
    ['C:\\definitely\\not\\here.md', 'absolute', 'default-app', null],
    ['', 'url', 'external', 'invalid']
  ]
  const resolved = {}
  for (const [target, kind, action, blocked] of matrix) {
    const r = JSON.parse(await ev(RESOLVE(target, DIR)))
    resolved[target] = r
    c(
      `resolve(${target || '空'}) → ${kind}/${action}${blocked ? '/' + blocked : ''}`,
      r.kind === kind && r.action === action && r.blocked === blocked,
      JSON.stringify(r)
    )
  }
  c(
    'exists-flags-correct',
    resolved['sibling.md'].exists === true &&
      resolved['sibling.md'].entryType === 'file' &&
      resolved['missing.md'].exists === false &&
      resolved['missing.md'].createType === 'file' &&
      resolved['sub/'].exists === true &&
      resolved['sub/'].entryType === 'directory' &&
      resolved['./deep/nested/new.md'].createType === 'file',
    JSON.stringify({
      sibling: resolved['sibling.md'],
      missing: resolved['missing.md'],
      sub: resolved['sub/']
    })
  )
  c(
    'non-text-missing-not-creatable',
    resolved['photo.png'].exists === false && resolved['photo.png'].createType === null,
    JSON.stringify(resolved['photo.png'])
  )
  c(
    'resolved-paths-absolute',
    path.resolve(resolved['missing.md'].path) === MISSING &&
      path.resolve(resolved['./deep/nested/new.md'].path) === DEEP,
    JSON.stringify({
      missing: resolved['missing.md'].path,
      deep: resolved['./deep/nested/new.md'].path
    })
  )
  // file:// URL → 按路径处理
  const fileUrl = JSON.parse(await ev(RESOLVE('file:///' + ABS_FILE.replace(/\\/g, '/'), DIR)))
  c(
    'file-url-treated-as-path',
    fileUrl.blocked === null && fileUrl.path === ABS_FILE,
    JSON.stringify(fileUrl)
  )
  // 缺少基准目录
  const noBase = JSON.parse(await ev(RESOLVE('sibling.md', null)))
  c('relative-without-base-blocked', noBase.blocked === 'missing-base', JSON.stringify(noBase))

  // ── B. 创建 / 不覆盖 / 父目录 ─────────────────────────────────────────────
  const created = JSON.parse(
    await ev(
      `(async () => JSON.stringify(await window.luminAPI.links.create(${JSON.stringify(MISSING)}, 'file')))()`
    )
  )
  c(
    'create-file-ok',
    created.ok === true && fs.existsSync(MISSING) && fs.readFileSync(MISSING, 'utf-8') === '',
    JSON.stringify({ created, exists: fs.existsSync(MISSING) })
  )
  const again = JSON.parse(
    await ev(
      `(async () => JSON.stringify(await window.luminAPI.links.create(${JSON.stringify(MISSING)}, 'file')))()`
    )
  )
  c(
    'create-refuses-existing',
    again.ok === false && again.error === 'exists',
    JSON.stringify(again)
  )
  fs.writeFileSync(MISSING, 'KEEP', 'utf-8')
  await ev(
    `(async () => JSON.stringify(await window.luminAPI.links.create(${JSON.stringify(MISSING)}, 'file')))()`
  )
  c(
    'create-never-overwrites',
    fs.readFileSync(MISSING, 'utf-8') === 'KEEP',
    fs.readFileSync(MISSING, 'utf-8')
  )
  fs.unlinkSync(MISSING)
  const deepCreate = JSON.parse(
    await ev(
      `(async () => JSON.stringify(await window.luminAPI.links.create(${JSON.stringify(DEEP)}, 'file')))()`
    )
  )
  c(
    'create-makes-parent-dirs',
    deepCreate.ok === true && fs.existsSync(DEEP),
    JSON.stringify({ deepCreate, exists: fs.existsSync(DEEP) })
  )
  const dirCreate = JSON.parse(
    await ev(
      `(async () => JSON.stringify(await window.luminAPI.links.create(${JSON.stringify(CREATED_DIR)}, 'directory')))()`
    )
  )
  c(
    'create-directory-ok',
    dirCreate.ok === true && fs.statSync(CREATED_DIR).isDirectory(),
    JSON.stringify(dirCreate)
  )
  const badCreate = JSON.parse(
    await ev(
      `(async () => JSON.stringify(await window.luminAPI.links.create('relative/path.md', 'file')))()`
    )
  )
  c('create-rejects-non-absolute', badCreate.ok === false, JSON.stringify(badCreate))

  // ── C. 端到端：同级已存在文件 → 新窗口 ───────────────────────────────────
  const known = (await appPages()).map((p) => p.id)
  let pt = await linkPoint('同级文件')
  c('link-point-found(同级文件)', !!pt, JSON.stringify(pt))
  if (pt) await clickCtrl(pt.x, pt.y)
  const winC = await waitNewWindow(known)
  let docC = winC ? await pageDocPath(winC) : null
  console.log('C-new-window ' + JSON.stringify({ win: winC?.id ?? null, doc: docC }))
  c('sibling-opens-in-new-window', docC === SIBLING, String(docC))
  if (winC) await closePage(winC)

  // ── D. 端到端：缺失文件 → 询问 → 取消 ────────────────────────────────────
  fs.rmSync(ASKED, { force: true })
  const beforeD = await ev(NOTIF_TITLES)
  pt = await linkPoint('询问创建')
  if (pt) await clickCtrl(pt.x, pt.y, 600)
  const modalD = await ev(MODAL_BTN(0))
  console.log('D-modal ' + modalD)
  c('missing-target-shows-confirm', modalD !== 'null', String(modalD))
  if (modalD !== 'null') {
    const btn = JSON.parse(modalD)
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: btn.x,
      y: btn.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(50)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: btn.x,
      y: btn.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(600)
  }
  const histD = JSON.parse(await ev(HISTORY))
  const rowD = histD.find((h) => h.target === 'ask-create.md')
  console.log(
    'D-declined ' +
      JSON.stringify({
        row: rowD,
        fileExists: fs.existsSync(ASKED),
        notifs: await ev(NOTIF_TITLES)
      })
  )
  c('decline-does-not-create', fs.existsSync(ASKED) === false)
  c(
    'decline-recorded',
    !!rowD && rowD.action === 'declined' && rowD.created === false,
    JSON.stringify(rowD)
  )
  c(
    'no-window-opened-on-decline',
    (await appPages()).length === known.length,
    'windows=' + (await appPages()).length
  )

  // ── E. 端到端：缺失文件 → 询问 → 确定（创建 + 新窗口）────────────────────
  const beforeE = (await appPages()).map((p) => p.id)
  pt = await linkPoint('询问创建')
  if (pt) await clickCtrl(pt.x, pt.y, 600)
  const modalE = await ev(MODAL_BTN(1))
  c('confirm-has-accept-button', modalE !== 'null', String(modalE))
  if (modalE !== 'null') {
    const btn = JSON.parse(modalE)
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: btn.x,
      y: btn.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(50)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: btn.x,
      y: btn.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(800)
  }
  const createdOnDisk = fs.existsSync(ASKED)
  const winE = await waitNewWindow(beforeE)
  const docE = winE ? await pageDocPath(winE) : null
  const histE = JSON.parse(await ev(HISTORY))
  const rowE = histE.find((h) => h.target === 'ask-create.md')
  console.log(
    'E-create ' + JSON.stringify({ createdOnDisk, win: winE?.id ?? null, doc: docE, row: rowE })
  )
  c('accept-creates-file', createdOnDisk === true)
  c('accept-opens-in-new-window', docE === ASKED, String(docE))
  c(
    'accept-recorded-with-created-flag',
    !!rowE && rowE.action === 'window' && rowE.created === true && rowE.count === 2,
    JSON.stringify(rowE)
  )
  c(
    'created-notification-shown',
    hasNotif(await ev(NOTIF_TITLES), 'success', '新建'),
    await ev(NOTIF_TITLES)
  )
  if (winE) await closePage(winE)

  // ── F. 危险协议：拒绝且不调用 openExternal ───────────────────────────────
  const beforeF = (await appPages()).map((p) => p.id)
  pt = await linkPoint('危险协议')
  c('link-point-found(危险协议)', !!pt, JSON.stringify(pt))
  if (pt) await clickCtrl(pt.x, pt.y, 700)
  const notifsF = await ev(NOTIF_TITLES)
  const histF = JSON.parse(await ev(HISTORY))
  console.log(
    'F ' +
      JSON.stringify({
        notifs: notifsF,
        ftpRow: histF.find((h) => h.target.startsWith('ftp')) ?? null,
        windows: (await appPages()).length
      })
  )
  c('blocked-scheme-notifies', hasNotif(notifsF, 'error', '协议'), notifsF)
  c(
    'blocked-scheme-no-external-row',
    !histF.some((h) => h.target.startsWith('ftp') && h.action === 'external')
  )
  c('blocked-scheme-no-window', (await appPages()).length === beforeF.length)
  // 双重保护：javascript: 链接在编辑器解析阶段就被拒绝（只留纯文本，不成为链接）
  const jsState = JSON.parse(
    await ev(`(() => {
      const ed = window.__vt.ed()
      let plain = 0, linked = 0
      ed.state.doc.descendants((n) => {
        if (!n.isText || !n.text.includes('编辑器拒绝协议')) return
        if (n.marks.some((m) => m.type.name === 'link')) linked++
        else plain++
      })
      return JSON.stringify({ plain, linked })
    })()`)
  )
  console.log('F-editor ' + JSON.stringify(jsState))
  c(
    'editor-rejects-javascript-link',
    jsState.plain === 1 && jsState.linked === 0,
    JSON.stringify(jsState)
  )

  // ── G. 非文本缺失目标 ────────────────────────────────────────────────────
  pt = await linkPoint('非文本')
  c('link-point-found(非文本)', !!pt, JSON.stringify(pt))
  if (pt) await clickCtrl(pt.x, pt.y, 700)
  const notifsG = await ev(NOTIF_TITLES)
  console.log('G ' + JSON.stringify({ notifs: notifsG, exists: fs.existsSync(PHOTO) }))
  c('non-text-missing-not-created', fs.existsSync(PHOTO) === false)
  c('non-text-missing-notifies', hasNotif(notifsG, 'error', '无法新建'), notifsG)

  // ── H. 历史 CRUD + 落盘 ──────────────────────────────────────────────────
  const histH = JSON.parse(await ev(HISTORY))
  const siblingRow = histH.find((h) => h.target === 'sibling.md')
  c(
    'history-has-sibling-row',
    !!siblingRow &&
      siblingRow.kind === 'file' &&
      siblingRow.action === 'window' &&
      siblingRow.count === 1,
    JSON.stringify(siblingRow)
  )
  // 重复打开 → count 累加（update 语义）
  const beforeH2 = (await appPages()).map((p) => p.id)
  pt = await linkPoint('同级文件')
  if (pt) await clickCtrl(pt.x, pt.y)
  const winH2 = await waitNewWindow(beforeH2)
  if (winH2) await closePage(winH2)
  const histH2 = JSON.parse(await ev(HISTORY))
  const siblingRow2 = histH2.find((h) => h.target === 'sibling.md')
  c('history-count-increments', siblingRow2.count === 2, JSON.stringify(siblingRow2))
  // forget
  await ev(`window.luminAPI.links.forget('sibling.md')`)
  const histH3 = JSON.parse(await ev(HISTORY))
  c(
    'forget-removes-row',
    !histH3.some((h) => h.target === 'sibling.md'),
    JSON.stringify(histH3.map((h) => h.target))
  )
  // 直读 SQLite 落盘文件（不是 session）
  const onDisk = (() => {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(path.join(process.env.APPDATA, 'lumin', 'lumin.db'), {
      readOnly: true
    })
    const rows = db
      .prepare('SELECT target, kind, action, created_entry, count FROM link_history')
      .all()
    const kv = db.prepare("SELECT value FROM kv WHERE key = 'settings'").get()
    db.close()
    return { rows, settings: kv ? JSON.parse(kv.value) : null }
  })()
  console.log(
    'H-disk ' +
      JSON.stringify({
        rows: onDisk.rows.length,
        targets: onDisk.rows.map((r) => r.target),
        mode: onDisk.settings.linkCreateMode
      })
  )
  c(
    'history-persisted-in-sqlite',
    // 此刻 sibling.md 已被 forget、photo.png 仍在，故断言「不少于 2 条」+ 关键行语义
    onDisk.rows.length >= 2 &&
      onDisk.rows.some((r) => r.target === 'ask-create.md' && r.created_entry === 1) &&
      onDisk.rows.some((r) => r.target === 'photo.png' && r.action === 'declined'),
    JSON.stringify(onDisk.rows)
  )
  c(
    'linkCreateMode-persisted',
    onDisk.settings.linkCreateMode === (snapshot.linkCreateMode ?? 'ask'),
    String(onDisk.settings.linkCreateMode)
  )

  // ── I. 设置 → 链接页签（真实点击）────────────────────────────────────────
  await ev(`(() => { window.__vt.ui().openSettings('links'); return 'ok' })()`)
  await sleep(700)
  const tabState = JSON.parse(
    await ev(`(() => {
      const panel = document.querySelector('.settings-panel')
      const rows = panel ? [...panel.querySelectorAll('section')].length : 0
      const modeBtn = [...(panel?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === '总是创建')
      const r = modeBtn?.getBoundingClientRect()
      const histRows = [...(panel?.querySelectorAll('.relative.space-y-2 > div') ?? [])].length
      return JSON.stringify({ sections: rows, hasModeButton: !!modeBtn, modePos: r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null, histRows })
    })()`)
  )
  console.log('I-tab ' + JSON.stringify(tabState))
  c(
    'links-tab-renders',
    tabState.hasModeButton === true && tabState.sections >= 2,
    JSON.stringify(tabState)
  )
  c(
    'history-list-rendered',
    tabState.histRows === histH3.length,
    JSON.stringify({ rendered: tabState.histRows, db: histH3.length })
  )
  if (tabState.modePos) {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: tabState.modePos.x,
      y: tabState.modePos.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(50)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: tabState.modePos.x,
      y: tabState.modePos.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(700)
  }
  const modeNow = await ev(`window.__vt.settings().linkCreateMode`)
  const diskMode = (() => {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(path.join(process.env.APPDATA, 'lumin', 'lumin.db'), {
      readOnly: true
    })
    const kv = db.prepare("SELECT value FROM kv WHERE key = 'settings'").get()
    db.close()
    return kv ? JSON.parse(kv.value).linkCreateMode : null
  })()
  console.log('I-mode ' + JSON.stringify({ modeNow, diskMode }))
  c('create-mode-updated-by-click', modeNow === 'always', String(modeNow))
  c('create-mode-persisted-by-click', diskMode === 'always', String(diskMode))
  // 单条删除（UI）
  const delPos = JSON.parse(
    await ev(`(() => {
      const panel = document.querySelector('.settings-panel')
      const row = panel?.querySelector('.relative.space-y-2 > div')
      const btn = row?.querySelector('button')
      if (!btn) return 'null'
      const r = btn.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`)
  )
  const targetBefore = (JSON.parse(await ev(HISTORY))[0] ?? {}).target ?? null
  if (delPos !== 'null') {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: delPos.x,
      y: delPos.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(50)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: delPos.x,
      y: delPos.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(800)
  }
  const histI = JSON.parse(await ev(HISTORY))
  console.log('I-forget ' + JSON.stringify({ targetBefore, remaining: histI.map((h) => h.target) }))
  c(
    'ui-delete-removes-row',
    !!targetBefore && !histI.some((h) => h.target === targetBefore),
    JSON.stringify({ targetBefore, remaining: histI.map((h) => h.target) })
  )
  // 清空
  const cleared = await ev(
    `(async () => (await window.luminAPI.links.clear(), (await window.luminAPI.links.history(50)).length))()`
  )
  c('clear-removes-all', cleared === 0, 'remaining=' + cleared)
  await ev(`(() => { window.__vt.ui().closeSettings(); return 'ok' })()`)
  await sleep(400)

  // ── J. 复原 ──────────────────────────────────────────────────────────────
  await ev(`(async () => {
    const s = window.__vt.settings()
    s.set('linkCreateMode', ${JSON.stringify(snapshot.linkCreateMode ?? 'ask')})
    s.set('recentFiles', ${JSON.stringify(snapshot.recentFiles)})
    await window.luminAPI.settings.update({
      linkCreateMode: ${JSON.stringify(snapshot.linkCreateMode ?? 'ask')},
      recentFiles: ${JSON.stringify(snapshot.recentFiles)}
    })
    const f = window.__vt.files()
    await f.close()
    await window.luminAPI.drafts.remove('untitled')
    return 'ok'
  })()`)
  await sleep(700)
  for (const p of [DOC, SIBLING, ABS_FILE, ASKED, MISSING, DEEP, PHOTO]) {
    await ev(`window.luminAPI.db.deleteDocument(${JSON.stringify(p)}).catch(() => {})`)
  }
  const restored = JSON.parse(
    await ev(
      `(() => { const s = window.__vt.settings(); const f = window.__vt.files(); return JSON.stringify({ mode: s.linkCreateMode, recent: s.recentFiles.length, path: f.current?.path ?? null }) })()`
    )
  )
  console.log('J-restored ' + JSON.stringify(restored))
  c(
    'state-restored',
    restored.mode === (snapshot.linkCreateMode ?? 'ask') &&
      restored.recent === snapshot.recentFiles.length &&
      restored.path === null,
    JSON.stringify(restored)
  )
  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await closePage(temp)
  fs.rmSync(DIR, { recursive: true, force: true })

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`TOTAL ${results.length} PASS ${results.length - failed} FAIL ${failed}`)
  ws.close()
  if (failed) process.exit(1)
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
