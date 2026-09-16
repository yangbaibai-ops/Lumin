// 验证目录：插入 toc 节点 → 渲染标题列表 → 点击跳转到对应标题 → markdown 往返为 [TOC]。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = (sym ? prov[sym] : null)
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(() => { location.hash = '#/editor'; window.__vt.files().setRoot('D:\\\\code_workspace\\\\Lumin-test-workspace'); return 'ok' })()`)
  await sleep(800)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(500)
  // 内容：多个标题 + 正文，末尾插入目录
  const md = `# 一级标题A\n\n正文段落。\n\n## 二级标题B\n\n更多内容。\n\n### 三级标题C\n\n结尾内容。`
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
  await sleep(400)

  // 光标移到文档末尾，插入目录
  await ev(`(() => { const ed = window.__vt.ed(); ed.chain().focus().setTextSelection(ed.state.doc.content.size).run(); return 'ok' })()`)
  await sleep(100)
  await ev(`(() => { window.__vt.ed().commands.insertTableOfContents(); return 'ok' })()`)
  await sleep(600)

  // 检查 .md-toc 渲染 + 链接数
  const tocState = await ev(`(() => { const toc = document.querySelector('.md-toc'); const links = toc ? [...toc.querySelectorAll('a')].map(a => a.textContent) : []; return JSON.stringify({ hasToc: !!toc, links }) })()`)
  console.log('toc render:', tocState)

  // 点击第二个条目（二级标题B）
  const clicked = await ev(`(() => { const a = document.querySelectorAll('.md-toc a')[1]; if (!a) return false; a.click(); return true })()`)
  await sleep(300)
  const selAfter = await ev(`(() => { const ed = window.__vt.ed(); const sel = ed.state.selection; return JSON.stringify({ from: sel.from, selText: ed.state.doc.textBetween(sel.from, Math.min(sel.from + 6, sel.to + 6)) }) })()`)
  console.log('click toc link:', clicked, 'selection:', selAfter)

  // markdown 往返
  const mdOut = await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`)
  console.log('markdown has [TOC]:', mdOut.includes('[TOC]'))

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
