// 验收：打开「窗口外的文件」的落点规则（Ctrl+O / 打开文件 / 拖文件进窗口共用同一实现）
//
// 规则（见 renderer/src/lib/openFile.ts）：
//   ① 该文件已在本窗口打开        → 什么都不做（不重复打开、不新建窗口）
//   ② 本窗口没有打开任何文件夹    → 在本窗口打开 + 把侧栏切到文件所在文件夹
//   ③ 本窗口已打开文件夹          → 新窗口打开；新窗口侧栏对准该文件的文件夹
//      （文件本来就在继承来的工作区里时保持原工作区，不做无谓的缩小）
//
// 做法：在页面里 `await import('/src/lib/openFile.ts')` 拿到**真实模块**（dev server 现成
// 提供），直接驱动同一条实现；另外静态核对四处调用点都改成委托给它。
// 跑法：独立 userData 实例（见 §4.23），不碰用户正在用的窗口与数据。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ROOT = path.resolve(__dirname, '..')

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => res(JSON.parse(d)))
    }).on('error', rej)
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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym]
  window.__R = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), app }
  return 'ok'
})()`

/** 当前窗口状态快照 */
const SNAP = `JSON.stringify({
  doc: window.__R.files().current?.path ?? null,
  root: window.__R.files().root,
  treeRows: document.querySelectorAll('aside [data-tree-row]').length,
  hub: !!document.querySelector('aside .empty-hub')
})`

const pages = async () => (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
const attach = async (page) => {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await c.ev(SETUP)) === 'ok' && (await c.ev(`window.__R.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await c.ev(SETUP)
  c.id = page.id
  return c
}
const snap = async (w) => JSON.parse(await w.ev(SNAP))

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // ── 静态核对：四处调用点都委托给同一个实现 ──────────────────────────────
  const callSites = [
    ['composables/useAppActions.ts', 'Ctrl+O / 原生菜单「打开文件」'],
    ['components/FileTree.vue', '侧栏空态「打开文件」按钮'],
    ['components/TopMenuBar.vue', '文件菜单「打开…」'],
    ['views/EditorView.vue', '拖文件进窗口']
  ]
  for (const [rel, desc] of callSites) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', rel), 'utf8')
    c(`call-site-delegates:${path.basename(rel)}`, /openExternalFile\(/.test(src), desc)
  }

  // ── 夹具：两个文件夹 ────────────────────────────────────────────────────
  const F1 = path.join(os.tmpdir(), 'lumin-route-f1')
  const F2 = path.join(os.tmpdir(), 'lumin-route-f2')
  for (const [dir, files] of [
    [F1, { 'a.md': '# a\n\nalpha\n', 'b.md': '# b\n\nbeta\n' }],
    [F2, { 'c.md': '# c\n\ngamma\n' }]
  ]) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), body, 'utf-8')
  }
  const A = path.join(F1, 'a.md')
  const B = path.join(F1, 'b.md')
  const Cp = path.join(F2, 'c.md')

  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const seen = new Set(all.map((p) => p.id))
  const w1 = await attach(all[0])
  const extra = []

  const callOpen = (w, p) =>
    w.ev(`(async () => { const m = await import('/src/lib/openFile.ts'); return String(await m.openExternalFile(${JSON.stringify(p)})) })()`)

  try {
    // 先回到「没有工作区、没有文档」的已知状态
    await w1.ev(`(async () => { window.__R.files().close(); await window.__R.files().setRoot(null); return 'ok' })()`)
    await sleep(700)

    // ── 纯函数：路径比较（大小写/分隔符/前缀边界） ──
    const helpers = JSON.parse(
      await w1.ev(`(async () => {
        const m = await import('/src/lib/openFile.ts')
        return JSON.stringify({
          sameCase: m.samePath('C:\\\\Docs\\\\A.md', 'c:/docs/a.md'),
          sameDiff: m.samePath('C:\\\\Docs\\\\A.md', 'C:\\\\Docs\\\\B.md'),
          sameNull: m.samePath(null, 'C:\\\\Docs\\\\A.md'),
          insideDeep: m.isInside('C:\\\\Docs', 'C:\\\\Docs\\\\sub\\\\x.md'),
          insideSelf: m.isInside('C:\\\\Docs', 'C:\\\\Docs'),
          insideBoundary: m.isInside('C:\\\\Docs', 'C:\\\\Docs2\\\\x.md'),
          insideOutside: m.isInside('C:\\\\Docs', 'D:\\\\Other\\\\x.md'),
          insideNull: m.isInside(null, 'C:\\\\x.md')
        })
      })()`)
    )
    console.log('HELPERS ' + JSON.stringify(helpers))
    c('samePath-normalizes', helpers.sameCase === true && helpers.sameDiff === false && helpers.sameNull === false, JSON.stringify(helpers))
    c('isInside-prefix-boundary', helpers.insideDeep === true && helpers.insideSelf === true && helpers.insideBoundary === false && helpers.insideOutside === false && helpers.insideNull === false, JSON.stringify(helpers))

    // ── ② 没有工作区 → 本窗口打开 + 侧栏切到文件所在文件夹 ──
    const before2 = await snap(w1)
    const r2 = await callOpen(w1, A)
    await sleep(1200)
    const after2 = await snap(w1)
    console.log('CASE2 ' + JSON.stringify({ r2, before: before2, after: after2 }))
    c('no-workspace-opens-here', r2 === 'opened-here', r2)
    c('no-workspace-doc-opened', after2.doc === A, JSON.stringify(after2))
    c('no-workspace-sidebar-switched', after2.root === F1, JSON.stringify(after2.root))
    c('no-workspace-file-visible-in-tree', after2.treeRows > 0, 'rows=' + after2.treeRows)

    // ── ① 再次打开同一个文件 → 不重复打开、不新建窗口 ──
    const winCountBefore = (await pages()).length
    const r1 = await callOpen(w1, A)
    await sleep(1200)
    const after1 = await snap(w1)
    const winCountAfter = (await pages()).length
    console.log('CASE1 ' + JSON.stringify({ r1, winCountBefore, winCountAfter, after: after1 }))
    c('same-file-no-reopen', r1 === 'already-open', r1)
    c('same-file-no-new-window', winCountAfter === winCountBefore, `${winCountBefore} -> ${winCountAfter}`)
    c('same-file-doc-unchanged', after1.doc === A && after1.root === F1, JSON.stringify(after1))

    // ── ③ 已有工作区 + 文件在工作区外 → 新窗口 + 新窗口侧栏切到该文件的文件夹 ──
    const r3 = await callOpen(w1, Cp)
    let w3 = null
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const fresh = (await pages()).find((p) => !seen.has(p.id))
      if (fresh) {
        w3 = await attach(fresh)
        break
      }
    }
    if (!w3) throw new Error('新窗口没有出现（case 3）')
    seen.add(w3.id)
    extra.push(w3)
    await sleep(1200)
    const s3 = await snap(w3)
    const orig3 = await snap(w1)
    console.log('CASE3 ' + JSON.stringify({ r3, newWindow: s3, original: orig3 }))
    c('with-workspace-opens-in-new-window', r3 === 'opened-in-new-window', r3)
    c('new-window-has-doc', s3.doc === Cp, JSON.stringify(s3))
    c('new-window-sidebar-is-file-folder', s3.root === F2, JSON.stringify(s3.root))
    c('new-window-file-visible-in-tree', s3.treeRows > 0, 'rows=' + s3.treeRows)
    c('original-window-untouched', orig3.doc === A && orig3.root === F1, JSON.stringify(orig3))

    // ── ③b 已有工作区 + 文件就在工作区里 → 新窗口保持原工作区（不缩小范围） ──
    const r4 = await callOpen(w1, B)
    let w4 = null
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const fresh = (await pages()).find((p) => !seen.has(p.id))
      if (fresh) {
        w4 = await attach(fresh)
        break
      }
    }
    if (!w4) throw new Error('新窗口没有出现（case 3b）')
    seen.add(w4.id)
    extra.push(w4)
    await sleep(1200)
    const s4 = await snap(w4)
    console.log('CASE3b ' + JSON.stringify({ r4, newWindow: s4 }))
    c('inside-workspace-opens-in-new-window', r4 === 'opened-in-new-window', r4)
    c('inside-workspace-keeps-workspace', s4.doc === B && s4.root === F1, JSON.stringify(s4))
    // ── ④ 既有路径「在新窗口打开」（最近文档 / 右键在新窗口打开走的 openInNewWindow）
    //      也遵循同一可见性保证：文件在工作区外 → 新窗口侧栏切到它的文件夹；
    //      文件本来就在工作区里 → 新窗口保持该工作区。
    const openInNew = async (p) => {
      const before = new Set((await pages()).map((x) => x.id))
      await w1.ev(`(window.luminAPI.app.openInNewWindow(${JSON.stringify(p)}), 'ok')`)
      for (let i = 0; i < 80; i++) {
        await sleep(300)
        const fresh = (await pages()).find((x) => !before.has(x.id))
        if (fresh) {
          const c2 = await attach(fresh)
          extra.push(c2)
          await sleep(1200)
          return await snap(c2)
        }
      }
      return null
    }
    const outsideWin = await openInNew(Cp)
    console.log('OPEN-IN-NEW-WINDOW(outside) ' + JSON.stringify(outsideWin))
    c('open-in-new-window-outside-switches-sidebar', outsideWin?.doc === Cp && outsideWin?.root === F2, JSON.stringify(outsideWin))
    const insideWin = await openInNew(B)
    console.log('OPEN-IN-NEW-WINDOW(inside) ' + JSON.stringify(insideWin))
    c('open-in-new-window-inside-keeps-workspace', insideWin?.doc === B && insideWin?.root === F1, JSON.stringify(insideWin))
  } finally {
    for (const w of extra) if (w.ws.readyState === 1) await w.send('Page.close').catch(() => {})
    await sleep(700)
    await w1.ev(`(async () => { window.__R.files().close(); return 'ok' })()`).catch(() => {})
    fs.rmSync(F1, { recursive: true, force: true })
    fs.rmSync(F2, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w1.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
