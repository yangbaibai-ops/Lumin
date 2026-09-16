// 验证 [TOC] 反向解析：含 [TOC] 的 markdown 重新加载后还原为目录节点。
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
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = (sym ? prov[sym] : null)
    window.__vt = { pinia, ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)

  const md = `# 甲\n\n正文。\n\n[TOC]\n\n## 乙\n\n更多。`
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
  await sleep(600)
  const r = await ev(`(() => { const ed = window.__vt.ed(); let hasNode = false; ed.state.doc.descendants((n) => { if (n.type.name === 'tableOfContents') hasNode = true }); const toc = document.querySelector('.md-toc'); const links = toc ? [...toc.querySelectorAll('a')].map(a => a.textContent) : []; return JSON.stringify({ hasNode, links }) })()`)
  console.log('[TOC] reload -> node:', r)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
