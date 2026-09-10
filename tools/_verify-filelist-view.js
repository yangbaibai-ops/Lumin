// 验收：侧边栏「列表视图」的排版 —— 分割线（容器上边框 + 每行下边框）、
// 去后缀文件名 + 后缀标签的字体样式、行高与连续性。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files') }
    return 'OK'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(700)
  await ev(`(async () => { const ui = window.__vt.ui(); window.__vt._sidebarWasVisible = ui.sidebarVisible; ui.sidebarVisible = true; ui.sidebarFilesView = 'list'; return 'ok' })()`)
  // 等工作区根目录恢复 + 扫描完成（应用刚启动时 root 是异步恢复的）
  await ev(`(async () => {
    const f = window.__vt.files()
    for (let i = 0; i < 100 && !(f.root && f.docs.length); i++) {
      if (f.root && !f.docs.length && !f.docsLoading) await f.loadDocs()
      await new Promise((r) => setTimeout(r, 200))
    }
    return 'ready'
  })()`)
  await sleep(600)
  console.log('STATE ' + (await ev(`(() => {
    const f = window.__vt.files()
    const u = window.__vt.ui()
    return JSON.stringify({ hash: location.hash, root: f.root, docs: f.docs.length, loading: f.docsLoading, view: u.sidebarFilesView, sidebarOpen: u.sidebarOpen, aside: !!document.querySelector('aside'), btns96: document.querySelectorAll('button[style*="min-height: 96px"]').length, btnsAny: document.querySelectorAll('button[style*="min-height"]').length, asideCls: document.querySelector('aside')?.className ?? null })
  })()`)))

  const info = JSON.parse(await ev(`(() => {
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
    const m = window.__vt.files().docs
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
  })()`))
  console.log(JSON.stringify(info, null, 2))

  const c = (n, cond, extra) => console.log((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  c('view=list', info.view === 'list')
  c('rows>=2', info.rows >= 2, 'rows=' + info.rows)
  c('separator-1px', info.group?.borderTop === '1px' && info.row?.borderBottom === '1px' && info.lastBorderBottom === '1px', `${info.group?.borderTop}/${info.row?.borderBottom}/${info.lastBorderBottom}`)
  c('rows-contiguous', info.adjGap === 0, 'gap=' + info.adjGap)
  c('row-height>=96', info.row?.box?.h >= 96, 'h=' + info.row?.box?.h)
  c('name-size-12.5', info.name?.size === '12.5px', info.name?.size)
  c('name-weight-500', info.name?.weight === '500', info.name?.weight)
  c('name-tracking', info.name?.ls === '-0.125px', info.name?.ls)
  c('ext-shown', !!info.ext?.text, JSON.stringify(info.ext))
  c('ext-smaller', info.ext && info.name && parseFloat(info.ext.size) < parseFloat(info.name.size), `${info.ext?.size} < ${info.name?.size}`)
  c('ext-starts-with-dot', !!info.ext?.text && info.ext.text.startsWith('.'), info.ext?.text)
  c('icon-13px', info.iconBox?.h === 13 || info.iconBox?.w === 13, JSON.stringify(info.iconBox))
  const allExt = info.samples.every((s) => !s.file.includes('.') || (s.ext || '').toLowerCase() === '.' + s.file.split('.').pop().toLowerCase())
  c('ext-matches-filename', allExt, JSON.stringify(info.samples))
  // 复原探针改动，避免影响用户会话
  await ev(`(() => { const ui = window.__vt.ui(); ui.sidebarVisible = window.__vt._sidebarWasVisible; return 'ok' })()`)
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
