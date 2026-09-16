// 验收：另存为之后，同一窗口的侧栏「对准」保存到的那份文件
//
// 规则（见 stores/files.ts 的 syncWorkspaceToPath / revealPath）：
//   - 保存到当前工作区**之外**（或本窗口没有工作区）→ 侧栏工作区切到该文件的文件夹；
//   - 保存在当前工作区**之内** → 不缩小范围，逐级展开把文件露出来。
//
// 说明：原生「另存为」对话框无法在自动化里作答，所以这里
//   ① 运行时验证 syncWorkspaceToPath/revealPath 两条分支在真实文件系统上的行为；
//   ② 运行时跑一遍「改路径 → save() → syncWorkspaceToPath」的等价序列（写真实文件）；
//   ③ 静态核对 saveAs() 在保存成功后确实调用了它。
//
// 跑法：独立 userData 实例（tools/start-isolated.ps1），不碰用户数据。
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
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = app._context.provides[sym]
  window.__S = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), app }
  return 'ok'
})()`

/** 侧栏可见性快照：工作区根、已展开目录、树里出现的文件名/目录名 */
const SNAP = `JSON.stringify({
  root: window.__S.files().root,
  doc: window.__S.files().current?.path ?? null,
  expanded: [...window.__S.files().expanded],
  treeText: [...document.querySelectorAll('aside [data-tree-row]')].map((el) => el.textContent.trim()),
  globalRoot: null
})`

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // ── 静态核对：saveAs 在保存成功后调用 syncWorkspaceToPath ──
  const filesSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'stores', 'files.ts'), 'utf8')
  const saveAsBlock = filesSrc.slice(filesSrc.indexOf('async saveAs'), filesSrc.indexOf('async flushAll'))
  c('saveAs-calls-sync-after-save', /const ok = await this\.save\(\)[\s\S]*if \(ok\) await this\.syncWorkspaceToPath\(path\)/.test(saveAsBlock), saveAsBlock.replace(/\s+/g, ' ').slice(0, 200))

  // ── 夹具：WS1（工作区）、WS1\sub（工作区内子目录）、WS2（工作区外目标） ──
  const WS1 = path.join(os.tmpdir(), 'lumin-saveas-ws1')
  const WS2 = path.join(os.tmpdir(), 'lumin-saveas-ws2')
  for (const d of [WS1, WS2, path.join(WS1, 'sub'), path.join(WS1, 'x', 'y')]) {
    fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d, { recursive: true })
  }
  fs.writeFileSync(path.join(WS1, 'a.md'), '# a\n\nin ws1\n', 'utf-8')
  const SUB_DOC = path.join(WS1, 'sub', 'b.md')
  const OUT_DOC = path.join(WS2, 'c.md')

  const pages = await (async () => (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url)))()
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await w.ev(SETUP)) === 'ok' && (await w.ev(`window.__S.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await w.ev(SETUP)
  const snap = async () => JSON.parse(await w.ev(SNAP))

  try {
    // ── 纯函数：ancestorDirs / parentDir / isInside 边界 ──
    const utils = JSON.parse(
      await w.ev(`(async () => {
        const m = await import('/src/lib/pathUtils.ts')
        const root = ${JSON.stringify(WS1)}
        return JSON.stringify({
          directChild: m.ancestorDirs(root, root + '\\\\a.md'),
          nested: m.ancestorDirs(root, root + '\\\\x\\\\y\\\\deep.md'),
          outside: m.ancestorDirs(root, ${JSON.stringify(WS2)} + '\\\\c.md'),
          rootOfDrive: m.parentDir('C:\\\\x'),
          bareName: m.parentDir('a.md'),
          insideBoundary: m.isInside('C:\\\\Docs', 'C:\\\\Docs2\\\\x.md'),
          insideSelf: m.isInside(root, root)
        })
      })()`)
    )
    console.log('UTILS ' + JSON.stringify(utils))
    c('ancestorDirs-direct-child', JSON.stringify(utils.directChild) === JSON.stringify([WS1]), JSON.stringify(utils.directChild))
    c('ancestorDirs-nested', JSON.stringify(utils.nested) === JSON.stringify([WS1, path.join(WS1, 'x'), path.join(WS1, 'x', 'y')]), JSON.stringify(utils.nested))
    c('ancestorDirs-outside-empty', Array.isArray(utils.outside) && utils.outside.length === 0, JSON.stringify(utils.outside))
    c('parentDir-edge-cases', utils.rootOfDrive === 'C:\\' && utils.bareName === '', JSON.stringify({ rootOfDrive: utils.rootOfDrive, bareName: utils.bareName }))
    c('isInside-boundary', utils.insideBoundary === false && utils.insideSelf === true, JSON.stringify(utils))

    // ── 准备：本窗口以 WS1 为工作区并打开 a.md ──
    await w.ev(`(async () => { const f = window.__S.files(); await f.setRoot(${JSON.stringify(WS1)}); await f.openPath(${JSON.stringify(path.join(WS1, 'a.md'))}); return 'ok' })()`)
    await sleep(1000)
    const before = await snap()
    c('prepared-workspace', before.root === WS1, JSON.stringify({ root: before.root }))

    // ── ① 保存到工作区之内（WS1\sub\b.md）→ root 不变 + 逐级展开露出文件 ──
    // 等价序列：改路径（saveAs 里就是这么做的）→ save() 写真实文件 → syncWorkspaceToPath
    await w.ev(`(async () => {
      const f = window.__S.files()
      f.current.path = ${JSON.stringify(SUB_DOC)}
      f.current.name = 'b.md'
      const ok = await f.save()
      const mode = await f.syncWorkspaceToPath(${JSON.stringify(SUB_DOC)})
      return 'ok:' + ok + ':' + mode
    })()`)
    await sleep(900)
    const inside = await snap()
    console.log('INSIDE ' + JSON.stringify(inside))
    c('inside-save-wrote-file', fs.existsSync(SUB_DOC), SUB_DOC)
    c('inside-keeps-workspace-root', inside.root === WS1, JSON.stringify(inside.root))
    c('inside-expands-to-file', inside.expanded.some((d) => d.toLowerCase() === path.join(WS1, 'sub').toLowerCase()), JSON.stringify(inside.expanded))
    c('inside-file-visible-in-tree', inside.treeText.includes('sub') && inside.treeText.includes('b.md'), JSON.stringify(inside.treeText))

    // ── ② 保存到工作区之外（WS2\c.md）→ 工作区切到 WS2 ──
    const modeOut = await w.ev(`(async () => {
      const f = window.__S.files()
      f.current.path = ${JSON.stringify(OUT_DOC)}
      f.current.name = 'c.md'
      const ok = await f.save()
      const mode = await f.syncWorkspaceToPath(${JSON.stringify(OUT_DOC)})
      return ok + ':' + mode
    })()`)
    await sleep(1100)
    const outside = await snap()
    const globalRoot = await w.ev(`window.luminAPI.workspace.getRoot()`)
    console.log('OUTSIDE ' + JSON.stringify({ modeOut, outside, globalRoot }))
    c('outside-save-wrote-file', fs.existsSync(OUT_DOC), OUT_DOC)
    c('outside-re-roots-workspace', outside.root === WS2, JSON.stringify(outside.root))
    c('outside-root-persisted', globalRoot === WS2, JSON.stringify(globalRoot))
    c('outside-file-visible-in-tree', outside.treeText.includes('c.md'), JSON.stringify(outside.treeText))

    // ── ③ 深层路径：逐级展开 ──
    const DEEP = path.join(WS2, 'd1', 'd2', 'deep.md')
    fs.mkdirSync(path.dirname(DEEP), { recursive: true })
    await w.ev(`(async () => {
      const f = window.__S.files()
      f.current.path = ${JSON.stringify(DEEP)}
      f.current.name = 'deep.md'
      await f.save()
      await f.syncWorkspaceToPath(${JSON.stringify(DEEP)})
      return 'ok'
    })()`)
    await sleep(1400)
    const deep = await snap()
    console.log('DEEP ' + JSON.stringify(deep))
    c('deep-expands-every-ancestor', ['d1', 'd2'].every((d) => deep.expanded.some((x) => x.toLowerCase().endsWith('\\' + d))) && deep.treeText.includes('deep.md'), JSON.stringify({ expanded: deep.expanded, tree: deep.treeText }))

    // ── ④ 没有工作区时保存 → 也要切到该文件夹 ──
    await w.ev(`(async () => { const f = window.__S.files(); await f.setRoot(null); return 'ok' })()`)
    await sleep(700)
    const modeNoRoot = await w.ev(`(async () => String(await window.__S.files().syncWorkspaceToPath(${JSON.stringify(OUT_DOC)})))()`)
    await sleep(1000)
    const noRoot = await snap()
    c('no-workspace-then-save-re-roots', modeNoRoot === 're-rooted' && noRoot.root === WS2, JSON.stringify({ modeNoRoot, root: noRoot.root }))
  } finally {
    await w.ev(`(async () => { const f = window.__S.files(); f.close(); await f.setRoot(null); return 'ok' })()`).catch(() => {})
    await sleep(400)
    for (const d of [WS1, WS2]) fs.rmSync(d, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
