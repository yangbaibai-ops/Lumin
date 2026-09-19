// 验收：侧边栏「列表视图」的排版 —— 分割线（容器上边框 + 每行下边框）、
// 去后缀文件名 + 后缀标签的字体样式、行高与连续性。
const fs = require('fs')
const os = require('os')
const path = require('path')
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) {
  return new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails)
    throw new Error(
      'EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    )
  return r.result?.result?.value
}

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  ws = new WebSocket(page.webSocketDebuggerUrl)
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
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = (sym ? prov[sym] : null)
    // ⚠️ 文档列表在**拆分后的 workspaceDocs store** 里（files store 只有文件树 + 当前文档）。
    // 老写法读 files().docs / files().docsLoading / files().loadDocs()，重构后就全是
    // undefined —— 套件在 f.docs.length 上直接抛 TypeError（实测）。
    // （注释里不能出现反引号：这里整段是模板字符串。）
    window.__vt = {
      pinia,
      ui: () => pinia._s.get('ui'),
      files: () => pinia._s.get('files'),
      // 列表视图的数据在 workspaceDocs（从 files store 拆出来的派生缓存）。
      // Pinia 的 store 是「被用过才注册」的：套件会先挂出列表视图再取它。
      docsStore: () => pinia._s.get('workspaceDocs')
    }
    return 'OK'
  })()`)
  await ev(
    `(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`
  )
  await sleep(700)
  await ev(
    `(async () => { const ui = window.__vt.ui(); window.__vt._sidebarWasVisible = ui.sidebarVisible; ui.sidebarVisible = true; ui.sidebarFilesView = 'list'; return 'ok' })()`
  )
  // 隔离实例常常**没有工作区**（会话恢复进去是空白未命名缓冲区），那样列表视图一篇文章都没有、
  // FileList 也不会挂载（workspaceDocs 因此从未注册）—— 旧写法会直接在 f.docs 上抛 TypeError。
  // 这里自备一个夹具工作区（跑完删掉），让套件在任何实例上都能真验排版。
  const FIXTURE = path.join(os.tmpdir(), 'lumin-filelist-fixture')
  fs.rmSync(FIXTURE, { recursive: true, force: true })
  fs.mkdirSync(path.join(FIXTURE, '子目录'), { recursive: true })
  fs.writeFileSync(path.join(FIXTURE, '第一篇.md'), '# 第一篇\n\n正文一\n', 'utf-8')
  fs.writeFileSync(path.join(FIXTURE, '第二篇.md'), '# 第二篇\n\n正文二\n', 'utf-8')
  fs.writeFileSync(path.join(FIXTURE, '子目录', '第三篇.markdown'), '# 第三篇\n\n正文三\n', 'utf-8')
  await ev(
    `(async () => { await window.__vt.files().setRoot(${JSON.stringify(FIXTURE)}); return 'ok' })()`
  )
  await sleep(900)
  await ev(`(async () => {
    for (let i = 0; i < 100; i++) {
      const f = window.__vt.files()
      const d = window.__vt.docsStore()
      if (d && f.root && d.docs.length) break
      if (d && f.root && !d.loading) await d.load()
      await new Promise((r) => setTimeout(r, 200))
    }
    return 'ready'
  })()`)
  await sleep(600)
  console.log(
    'STATE ' +
      (await ev(`(() => {
    const f = window.__vt.files()
    const d = window.__vt.docsStore()
    const u = window.__vt.ui()
    return JSON.stringify({ hash: location.hash, root: f.root, docs: d.docs.length, loading: d.loading, view: u.sidebarFilesView, sidebarOpen: u.sidebarOpen, aside: !!document.querySelector('aside'), btns96: document.querySelectorAll('button[style*="min-height: 96px"]').length, btnsAny: document.querySelectorAll('button[style*="min-height"]').length, asideCls: document.querySelector('aside')?.className ?? null })
  })()`))
  )

  const info = JSON.parse(
    await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('button[style*="min-height: 96px"]'))
    if (!rows.length) return JSON.stringify({ rows: 0 })
    const cs = (el, p) => getComputedStyle(el)[p]
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1) } }
    const grp = rows[0].parentElement
    const first = rows[0], second = rows[1] || null, last = rows[rows.length - 1]
    // 标题行：icon + 文件名 + 后缀标签
    const titleLine = first.querySelector('span.mt-1\\\\.5')
    const kids = titleLine ? Array.from(titleLine.children) : []
    const nameEl = kids[1] || null
    const extEl = kids[2] || null
    const m = window.__vt.docsStore().docs
    return JSON.stringify({
      rows: rows.length,
      view: window.__vt.ui().sidebarFilesView,
      group: { borderTop: cs(grp, 'borderTopWidth'), color: cs(grp, 'borderTopColor') },
      row: { borderBottom: cs(first, 'borderBottomWidth'), radius: cs(first, 'borderTopLeftRadius'), box: box(first) },
      adjGap: second ? +(box(second).top - box(first).bottom).toFixed(2) : null,
      lastBorderBottom: cs(last, 'borderBottomWidth'),
      name: nameEl ? { text: nameEl.textContent.trim(), size: cs(nameEl, 'fontSize'), weight: cs(nameEl, 'fontWeight'), ls: cs(nameEl, 'letterSpacing'), color: cs(nameEl, 'color') } : null,
      ext: extEl ? { text: extEl.textContent.trim(), size: cs(extEl, 'fontSize'), color: cs(extEl, 'color') } : null,
      iconBox: kids[0] ? box(kids[0]) : null,
      samples: m.slice(0, 4).map((d) => {
        const el = rows.find((r) => (r.getAttribute('title') || '').startsWith(d.relPath ? d.relPath + '/' + d.name : d.name))
        const tl = el ? el.querySelector('span.mt-1\\\\.5') : null
        const k = tl ? Array.from(tl.children) : []
        return { file: d.name, name: k[1]?.textContent.trim() ?? null, ext: k[2]?.textContent.trim() ?? null }
      })
    })
  })()`)
  )
  console.log(JSON.stringify(info, null, 2))

  // 结论行必须按各套件统一格式打（`--- N/M PASS`）：tools/run-suites.js 靠它汇总矩阵，
  // 缺了它就会被记成 0/0 —— 套件明明全绿，矩阵里却是 FAIL（实测踩到）。
  let total = 0
  let failed = 0
  const c = (n, cond, extra) => {
    total += 1
    if (!cond) failed += 1
    console.log((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  }
  c('view=list', info.view === 'list')
  c('rows>=2', info.rows >= 2, 'rows=' + info.rows)
  c(
    'separator-1px',
    info.group?.borderTop === '1px' &&
      info.row?.borderBottom === '1px' &&
      info.lastBorderBottom === '1px',
    `${info.group?.borderTop}/${info.row?.borderBottom}/${info.lastBorderBottom}`
  )
  c('rows-contiguous', info.adjGap === 0, 'gap=' + info.adjGap)
  c('row-height>=96', info.row?.box?.h >= 96, 'h=' + info.row?.box?.h)
  c('name-size-12.5', info.name?.size === '12.5px', info.name?.size)
  c('name-weight-500', info.name?.weight === '500', info.name?.weight)
  c('name-tracking', info.name?.ls === '-0.125px', info.name?.ls)
  c('ext-shown', !!info.ext?.text, JSON.stringify(info.ext))
  c(
    'ext-smaller',
    info.ext && info.name && parseFloat(info.ext.size) < parseFloat(info.name.size),
    `${info.ext?.size} < ${info.name?.size}`
  )
  c('ext-starts-with-dot', !!info.ext?.text && info.ext.text.startsWith('.'), info.ext?.text)
  c('icon-13px', info.iconBox?.h === 13 || info.iconBox?.w === 13, JSON.stringify(info.iconBox))
  const allExt = info.samples.every(
    (s) =>
      !s.file.includes('.') ||
      (s.ext || '').toLowerCase() === '.' + s.file.split('.').pop().toLowerCase()
  )
  c('ext-matches-filename', allExt, JSON.stringify(info.samples))
  console.log(`--- ${total - failed}/${total} PASS`)
  // 复原探针改动，避免影响用户会话；夹具工作区也一并收掉
  await ev(
    `(() => { const ui = window.__vt.ui(); ui.sidebarVisible = window.__vt._sidebarWasVisible; return 'ok' })()`
  )
  await ev(`(async () => { await window.__vt.files().setRoot(null); return 'ok' })()`).catch(
    () => {}
  )
  fs.rmSync(FIXTURE, { recursive: true, force: true })
  ws.close()
  if (failed) process.exit(1)
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
