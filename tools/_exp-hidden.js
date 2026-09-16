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
  await send('Page.enable'); await send('Page.bringToFront')
  const setup = `
    (() => {
      const app = document.querySelector('#app')?.__vue_app__
      const prov = app?._context.provides
      const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
      const pinia = sym ? prov[sym] : null
      window.__vt = { pinia, ui: () => pinia._s.get('ui'), ed: () => pinia._s.get('editor')?.instance ?? null }
      return 'OK'
    })()`
  await ev(setup)
  await sleep(600)
  const body = `
    (async () => {
      const ed = window.__vt.ed()
      if (!ed) return 'no-ed'
      const parts = []
      for (let i = 1; i <= 30; i++) { parts.push('## 章节 ' + i); parts.push('第 ' + i + ' 段正文内容用于测试隐藏再显示后编辑器状态是否保留。') }
      parts.push(''); parts.push('\`\`\`js'); parts.push('const a = 1'); parts.push('\`\`\`')
      ed.commands.setContent(parts.join('\\n'))
      await new Promise((res) => setTimeout(res, 600))
      const sc = ed.view.dom.closest('.editor-scroll')
      ed.commands.setTextSelection(500)
      if (sc) sc.scrollTop = 300
      const before = { from: ed.state.selection.from, st: sc ? sc.scrollTop : -1, pmConnected: ed.view.dom.isConnected }
      const host = ed.view.dom.closest('.typora-container') || ed.view.dom.parentElement
      const target = host && host.parentElement ? host.parentElement : host
      target.__prev = target.style.display
      target.style.display = 'none'
      await new Promise((res) => setTimeout(res, 200))
      const whileHidden = { from: ed.state.selection.from, pmConnected: ed.view.dom.isConnected }
      target.style.display = target.__prev || ''
      await new Promise((res) => setTimeout(res, 400))
      const sc2 = ed.view.dom.closest('.editor-scroll')
      const c = document.querySelector('.cm-editor')
      const cr = c ? c.getBoundingClientRect() : null
      const after = { from: ed.state.selection.from, st: sc2 ? sc2.scrollTop : -1, pmConnected: ed.view.dom.isConnected,
        cmCount: document.querySelectorAll('.cm-editor').length,
        cmRect: cr ? { w: Math.round(cr.width), h: Math.round(cr.height) } : null }
      return JSON.stringify({ hostTag: target.tagName, before, whileHidden, after })
    })()`
  const r = await ev(body)
  console.log(r)
  ws.close(); process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
