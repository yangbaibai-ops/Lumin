// tools/_repro-paste.js — 粘贴复现：样式渲染 / 可编辑性 / 标题标记符 / 源码响应式
const CDP = 'http://127.0.0.1:9222/json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TEST_DIR = 'D:/code_workspace/Lumin-test-workspace'
const TEST_PATH = TEST_DIR + '/tipverify.md'
const TEST_MD = ['# 原有标题', '', '原有段落。', ''].join('\n')

const PASTE_MD = [
  '# 粘贴大标题',
  '',
  '粘贴的**加粗**段落与`行内代码`。',
  '',
  '- 列表项甲',
  '- 列表项乙',
  ''
].join('\n')

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('NO_PAGE_TARGET')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (label, expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) {
      console.log(`[${label}] EXCEPTION: ` + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
      return undefined
    }
    const v = r.result?.result?.value
    console.log(`[${label}] => ` + (v === undefined ? String(v) : v))
    return v
  }
  const ensureBridge = () => ev('bridge', `(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = sym ? prov[sym] : null
    if (!pinia) return 'NO_PINIA'
    window.__vt = { pinia, files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)

  await send('Page.enable')
  await send('Page.bringToFront')
  await ensureBridge()
  await ev('route', `(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(1000)
  await ensureBridge()
  await ev('setRoot', `window.luminAPI.workspace.setRoot(${JSON.stringify(TEST_DIR)}).then(() => 'ok')`)
  await ev('writeFile', `window.luminAPI.file.write(${JSON.stringify(TEST_PATH)}, ${JSON.stringify(TEST_MD)}).then(() => 'ok')`)
  await ev('openPath', `(async () => { await window.__vt.files().openPath(${JSON.stringify(TEST_PATH)}); return 'ok' })()`)
  await sleep(1200)
  await ensureBridge()

  // 光标放到文档末尾（点击最后一个段落）
  const endPt = await ev('endPt', `(() => {
    const pm = document.querySelector('.ProseMirror')
    const paras = pm.querySelectorAll('p')
    const last = paras[paras.length - 1]
    const b = last.getBoundingClientRect()
    return JSON.stringify({ x: b.left + Math.min(120, b.width), y: b.top + b.height / 2 })
  })()`)
  const pt = JSON.parse(endPt)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  }
  await sleep(300)

  // 合成粘贴事件（base64 载荷 + TextDecoder 保证 UTF-8）
  const b64 = Buffer.from(PASTE_MD, 'utf8').toString('base64')
  await ev('paste', `(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))
    const text = new TextDecoder('utf-8').decode(bytes)
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    const pm = document.querySelector('.ProseMirror')
    pm.dispatchEvent(e)
    return 'dispatched len=' + text.length
  })()`)
  await sleep(800)

  // 1) PM 文档结构 + DOM 渲染
  await ev('structure', `(() => {
    const ed = window.__vt.ed()
    if (!ed) return 'NO_EDITOR'
    const types = []
    ed.view.state.doc.descendants((n) => { if (n.isBlock) types.push(n.type.name) })
    const dom = [...document.querySelectorAll('.ProseMirror > *')].map((el) => el.tagName + '.' + el.className.split(' ')[0])
    const md = window.__vt.files().current ? window.__vt.files().current.content : ''
    return JSON.stringify({ types, dom, hasPastedHeading: md.includes('粘贴大标题'), mdTail: md.split('\\n').slice(-8).join(' | ') })
  })()`)

  // 2) 点击粘贴的大标题 → 标记符
  const h1pt = await ev('h1Pt', `(() => {
    const h1 = [...document.querySelectorAll('.ProseMirror h1')].find((h) => h.textContent.indexOf('粘贴大标') > -1)
    if (!h1) return 'NO_H1'
    const b = h1.getBoundingClientRect()
    return JSON.stringify({ x: b.left + 60, y: b.top + b.height / 2 })
  })()`)
  if (h1pt !== 'NO_H1') {
    const hp = JSON.parse(h1pt)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: hp.x, y: hp.y, button: 'left', clickCount: 1 })
    }
    await sleep(400)
    await ev('h1Marker', `(() => {
      const h1 = [...document.querySelectorAll('.ProseMirror h1')].find((h) => h.textContent.indexOf('粘贴大标') > -1)
      return JSON.stringify({ cls: h1 ? h1.className : 'gone', reveal: !!(h1 && h1.classList.contains('md-reveal')), text: h1 ? h1.textContent : '' })
    })()`)

    // 3) 标题内输入
    await send('Input.insertText', { text: '测' })
    await sleep(400)
    await ev('h1Type', `(() => {
      const ed = window.__vt.ed()
      let docText = ''
      ed.view.state.doc.descendants((n) => { if (n.type.name === 'heading' && n.textContent.indexOf('粘贴大标') > -1) docText = n.textContent })
      const domH1 = [...document.querySelectorAll('.ProseMirror h1')].find((h) => h.textContent.indexOf('粘贴大标') > -1)
      const types = []
      ed.view.state.doc.descendants((n) => { if (n.isBlock) types.push(n.type.name) })
      return JSON.stringify({ docText, domText: domH1 ? domH1.textContent : '', types, md: window.__vt.files().current.content })
    })()`)
  }

  // 4) 点击粘贴的段落 → 输入
  const pPt = await ev('pPt', `(() => {
    const p = [...document.querySelectorAll('.ProseMirror p')].find((el) => el.textContent.indexOf('粘贴的') > -1)
    if (!p) return 'NO_P'
    const b = p.getBoundingClientRect()
    return JSON.stringify({ x: b.left + 40, y: b.top + b.height / 2 })
  })()`)
  if (pPt !== 'NO_P') {
    const pp = JSON.parse(pPt)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: pp.x, y: pp.y, button: 'left', clickCount: 1 })
    }
    await sleep(300)
    await send('Input.insertText', { text: '✓可编辑' })
    await sleep(500)
    await ev('pType', `(() => {
      const ed = window.__vt.ed()
      let text = ''
      ed.view.state.doc.descendants((n) => { if (n.type.name === 'paragraph' && n.textContent.indexOf('粘贴的') > -1) text = n.textContent })
      const domP = [...document.querySelectorAll('.ProseMirror p')].find((el) => el.textContent.indexOf('粘贴的') > -1)
      return JSON.stringify({ docText: text, domText: domP ? domP.textContent : '', mdHas: window.__vt.files().current.content.includes('可编辑') })
    })()`)
  }

  // 5) 源码响应式
  await ev('srcRx', `(() => {
    const md = window.__vt.files().current ? window.__vt.files().current.content : ''
    return JSON.stringify({ hasPasted: md.includes('粘贴大标'), hasList: md.includes('列表项甲'), dirty: window.__vt.files().dirty })
  })()`)

  // 6) 基础输入基线：点击原有段落 → 输入（排除全局性输入损坏）
  const origPt = await ev('origPt', `(() => {
    const p = [...document.querySelectorAll('.ProseMirror p')].find((el) => el.textContent.indexOf('原有段落') > -1)
    if (!p) return 'NO_P'
    const b = p.getBoundingClientRect()
    return JSON.stringify({ x: b.left + 40, y: b.top + b.height / 2 })
  })()`)
  if (origPt !== 'NO_P') {
    const op = JSON.parse(origPt)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: op.x, y: op.y, button: 'left', clickCount: 1 })
    }
    await sleep(300)
    await send('Input.insertText', { text: '基' })
    await sleep(400)
    await ev('origType', `(() => {
      const ed = window.__vt.ed()
      let text = ''
      ed.view.state.doc.descendants((n) => { if (n.type.name === 'paragraph' && n.textContent.indexOf('原有段落') > -1) text = n.textContent })
      return JSON.stringify({ docText: text })
    })()`)
  }

  // 7) HTML 粘贴场景（外部来源富文本）
  const HTML_PASTE = '<h1>HTML大标题</h1><p>HTML<b>加粗</b>段落。</p>'
  const b64h = Buffer.from(HTML_PASTE, 'utf8').toString('base64')
  await ev('pasteHtml', `(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64h)}), (c) => c.charCodeAt(0))
    const html = new TextDecoder('utf-8').decode(bytes)
    const dt = new DataTransfer()
    dt.setData('text/html', html)
    dt.setData('text/plain', html.replace(/<[^>]+>/g, ''))
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    document.querySelector('.ProseMirror').dispatchEvent(e)
    return 'dispatched'
  })()`)
  await sleep(800)
  await ev('htmlPasteStruct', `(() => {
    const ed = window.__vt.ed()
    let found = ''
    ed.view.state.doc.descendants((n) => { if (n.textContent.indexOf('HTML大标题') > -1) found += n.type.name + ':' + JSON.stringify(n.textContent) + ';' })
    return JSON.stringify({ found })
  })()`)

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL:', e.message); process.exit(1) })
