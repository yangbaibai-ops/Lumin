// 回归：常驻布局下的核心编辑路径 + 模式切换位置保持
// 准备：untitled 文档 + 代码块内容；逐项验证并打印 PASS/FAIL
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function key(type, key, code, vk, text, modifiers) { await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, ...(text !== undefined ? { text } : {}), ...(modifiers ? { modifiers } : {}) }) }
async function clickMode(text) {
  const p = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('.mode-seg-btn')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!p) throw new Error('NO-BTN ' + text)
  const g = JSON.parse(p)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', clickCount: 1 })
  await sleep(350)
}
async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(700)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(500)
  await ev(`(async () => { const files = window.__vt.files(); if (!files.current) await files.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 25)); return window.__vt.ed() ? 'ed' : 'no-ed' })()`)
  await sleep(300)
  const md = ['# 标题', '正文段落用于测试，足够长以产生滚动。', '', '```js', 'const a = 1', '```', '', '## 小节', '更多正文。'].join('\n')
  await ev(`(() => { const f = window.__vt.files(); f.setContent(${JSON.stringify(md)}); const ed = window.__vt.ed(); if (ed) ed.commands.setContent(${JSON.stringify(md)}, { emitUpdate: false }); return 'ok' })()`)
  await sleep(900)

  const results = []
  function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')) }

  // 1) 代码块点击 + 输入 + Enter（重测坐标直到可聚焦，避免 pane settle 竞争）
  const cm = await ev(`(() => { const el = document.querySelector('.cm-content'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.max(12, r.height / 2), w: r.width, h: r.height } })()`)
  check('代码块CM可见', cm && cm.w > 50 && cm.h > 10, cm ? `w=${Math.round(cm.w)} h=${Math.round(cm.h)}` : 'no cm')
  if (cm) {
    let focused = false
    for (let attempt = 0; attempt < 5 && !focused; attempt++) {
      await ev(`(async () => { for (let i = 0; i < 50 && document.querySelector('.view-restoring'); i++) await new Promise((r) => setTimeout(r, 20)); return 'ok' })()`)
      const p = JSON.parse(await ev(`(() => { const el = document.querySelector('.cm-content'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + Math.min(40, r.width / 2), y: r.top + Math.max(12, r.height / 2) }) })()`))
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      await sleep(200)
      focused = await ev(`(() => { const el = document.querySelector('.cm-content'); return el ? document.activeElement === el || el.contains(document.activeElement) : false })()`)
    }
    check('点击后 CM 聚焦', focused === true, '')
    await send('Input.insertText', { text: 'hello' })
    await sleep(200)
    await key('keyDown', 'Enter', 'Enter', 13); await key('keyUp', 'Enter', 'Enter', 13)
    await sleep(200)
    await send('Input.insertText', { text: 'world' })
    await sleep(400)
    const code = await ev(`(() => { const ed = window.__vt.ed(); let c = ''; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c = n.textContent }); return c })()`)
    check('代码块输入+Enter', code.includes('hello') && code.includes('world'), JSON.stringify(code))
  }

  // 2) 模式切换位置保持：设光标到 50%，切换三个方向后再回来验证 pm 比例
  await ev(`(() => { const ed = window.__vt.ed(); ed.commands.setTextSelection(Math.floor(ed.state.doc.content.size * 0.5)); return 'ok' })()`)
  await sleep(150)
  await clickMode('分屏')
  await clickMode('源码')
  const taMid = await ev(`(() => { const ta = document.querySelector('textarea.source-editor'); const v = ta.value; const mx = ta.scrollHeight - ta.clientHeight; return JSON.stringify({ len: v.length, sel: ta.selectionStart, ratio: mx > 0 ? ta.scrollTop / mx : 0 }) })()`)
  await clickMode('实时渲染')
  const pm = await ev(`(() => { const ed = window.__vt.ed(); const s = ed.state.doc.content.size; return JSON.stringify({ from: ed.state.selection.from, size: s, ratio: s ? ed.state.selection.from / s : 0 }) })()`)
  const r1 = JSON.parse(pm)
  check('跨面往返位置保持(≈0.5)', r1.ratio > 0.4 && r1.ratio < 0.6, `from=${r1.from} size=${r1.size} ratio=${r1.ratio.toFixed(3)} taMid=${taMid}`)

  // 3) 源码模式输入 → 切回实时渲染内容同步
  await clickMode('源码')
  await ev(`(() => { const ta = document.querySelector('textarea.source-editor'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); const e = new Event('input', { bubbles: true }); Object.defineProperty(e, 'target', { value: ta }); ta.dispatchEvent(e); return 'ok' })()`)
  // 用真实输入（insertText 在 textarea 焦点下）
  await send('Input.insertText', { text: '\n## 源码新增' })
  await sleep(400)
  const mdSynced = await ev(`(() => { const f = window.__vt.files(); return f.current.content.includes('源码新增') })()`)
  check('源码输入写入 files', mdSynced === true, '')
  await clickMode('实时渲染')
  const hasHeading = await ev(`(() => { const ed = window.__vt.ed(); let ok = false; ed.state.doc.descendants((n) => { if (n.type.name === 'heading' && n.textContent.includes('源码新增')) ok = true }); return ok })()`)
  check('源码编辑→渲染同步', hasHeading === true, '')

  // 4) 工具栏富文本命令在源码模式失活（instance null）
  await clickMode('源码')
  const instanceInSource = await ev(`(() => window.__vt.ed() !== null)()`)
  check('源码模式 instance=null', instanceInSource === false, '')

  // 5) 大纲在源码模式清空
  await clickMode('实时渲染')
  const outlineWysiwyg = await ev(`(() => window.__vt.pinia._s.get('editor').outline.length)()`)
  check('渲染模式 outline 非空', outlineWysiwyg >= 2, `count=${outlineWysiwyg}`)
  await clickMode('源码')
  const outlineSource = await ev(`(() => window.__vt.pinia._s.get('editor').outline.length)()`)
  check('源码模式 outline 清空', outlineSource === 0, `count=${outlineSource}`)

  await clickMode('实时渲染')
  console.log(results.join('\n'))
  ws.close(); process.exit(results.some((r) => r.startsWith('FAIL')) ? 2 : 0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
