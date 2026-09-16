// 验收：右键菜单「粘贴」对 markdown 源码的处理（在第二个窗口跑，不动用户文档）
// A. 剪贴板只有纯文本且是 markdown 链接 → 应成链（此前会留下 `[a](` + 单独链化的网址）
// B. 剪贴板只有纯文本且是块级 markdown → 应成块（标题等），而不是一坨纯文本
// C. 剪贴板带 HTML → 直接用 HTML 通道成链
const CDP = 'http://127.0.0.1:9222/json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description || ''))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}
const STATE = `(() => {
  const ed = window.__vt.ed()
  const parts = []
  ed.state.doc.descendants((n) => {
    if (n.isText) {
      const l = n.marks.find((m) => m.type.name === 'link')
      parts.push(n.text + (l ? '⟦link:' + l.attrs.href + '⟧' : ''))
    } else if (n.type.name === 'heading') parts.push('<h' + n.attrs.level + '>')
  })
  return JSON.stringify(parts.join('|'))
})()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  const mainPage = targets.find((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  const main = connect(mainPage.webSocketDebuggerUrl)
  await main.ready
  await main.send('Page.enable')
  await main.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
  let pageB = null
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    const list = await (await fetch(CDP)).json()
    const pages = list.filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
    if (pages.length >= 2) { pageB = pages.find((p) => p.id !== mainPage.id); break }
  }
  if (!pageB) { console.log('SKIP: 第二个窗口未出现'); main.ws.close(); return }
  const b = connect(pageB.webSocketDebuggerUrl)
  await b.ready
  await b.send('Page.enable')
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 80; i++) { await sleep(300); if ((await b.ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break }
  await b.ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = app._context.provides[sym]
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, menu: () => pinia._s.get('editorMenu') }
    return 'ok'
  })()`)
  await b.ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(500)
  await b.ev(`(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`)
  await b.ev(`(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  const resetDoc = async () => {
    await b.ev(`(() => { const ed = window.__vt.ed(); ed.commands.setContent('<p></p>', { emitUpdate: false }); ed.commands.focus('end'); return 'ok' })()`)
    await sleep(350)
  }
  /** 走菜单的「粘贴」动作（等价于右键 → 顶部粘贴按钮） */
  const menuPaste = async () => {
    await b.ev(`(window.__vt.menu().openAt(500, 300), 'ok')`)
    await sleep(500)
    const clicked = await b.ev(`(() => {
      const panel = document.querySelector('.ecm-panel')
      if (!panel) return 'no-menu'
      const btn = Array.from(panel.querySelectorAll('.ecm-tool')).find((x) => x.textContent.trim() === '粘贴')
      if (!btn) return 'no-btn'
      btn.click()
      return 'ok'
    })()`)
    await sleep(900)
    return clicked
  }

  // A. markdown 链接（纯文本剪贴板）
  await b.ev(`navigator.clipboard.writeText('[a](https://www.douyin.com/?recommend=1)')`)
  await resetDoc()
  const aClick = await menuPaste()
  const a = JSON.parse(await b.ev(STATE))
  console.log('A click=' + aClick + ' → ' + a)
  c('menu-paste-markdown-link', a.includes('⟦link:https://www.douyin.com/?recommend=1⟧') && a.startsWith('a⟦link'), String(a))

  // B. 块级 markdown（标题）
  await b.ev(`navigator.clipboard.writeText('# 粘贴进来的标题')`)
  await resetDoc()
  await menuPaste()
  const bOut = JSON.parse(await b.ev(STATE))
  console.log('B → ' + bOut)
  c('menu-paste-block-markdown', bOut.includes('<h1>') && bOut.includes('粘贴进来的标题'), String(bOut))

  // C. 富文本剪贴板（HTML）→ 走 HTML 通道
  await b.ev(`(async () => {
    const item = new ClipboardItem({
      'text/html': new Blob(['<a href="https://html.example.com">HTML 链接</a>'], { type: 'text/html' }),
      'text/plain': new Blob(['HTML 链接'], { type: 'text/plain' })
    })
    await navigator.clipboard.write([item])
    return 'ok'
  })().catch((e) => 'DENIED:' + e.name)`)
  await resetDoc()
  await menuPaste()
  const cOut = JSON.parse(await b.ev(STATE))
  console.log('C → ' + cOut)
  c('menu-paste-html', cOut.includes('⟦link:https://html.example.com'), String(cOut))

  await b.ev(`(async () => { const f = window.__vt.files(); await f.close(); await window.luminAPI.drafts.remove('untitled-' + (window.luminAPI.app.sessionSlot ?? 0)); return 'ok' })()`)
  console.log(results.join('\n'))
  await b.send('Page.close').catch(() => {})
  await sleep(400)
  main.ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
