// 验收：超链接两处修复
// A. 手打 markdown 语法 [文字](网址)：敲下右括号即成形（input rule），不再是纯文本
// B. 工具栏插入链接 → 点击进入源码态 → 手动编辑（含把展开区切开的无标记插入）
//    → 光标移开后应收敛回链接，而不是把 `[](url)` 明文留在渲染界面
// C. 破坏语法（删掉右括号）时保持纯文本（不误判、不吞字符）
// D. 空标签 [](url)：不能抛 RangeError（PM 禁止空文本节点），保持字面文本
const CDP = 'http://127.0.0.1:9222/json'
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value }
async function typeText(text) {
  for (const ch of text) {
    await send('Input.insertText', { text: ch })
    await sleep(45)
  }
  await sleep(250)
}
async function clickPoint(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(350)
}
async function key(k, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  await sleep(300)
}
const MD = JSON.stringify(['# 链接验收', '', '结尾段落'].join('\n'))
/** 文档里第一条链接的信息 + 是否残留字面 markdown */
const LINKS = `(() => {
  const ed = window.__vt.ed()
  const links = []
  ed.state.doc.descendants((n) => {
    if (!n.isText) return
    const l = n.marks.find((m) => m.type.name === 'link')
    if (l) links.push({ text: n.text, href: l.attrs.href })
  })
  const text = ed.state.doc.textContent
  // 渲染界面里残留的「字面 markdown 链接」形态（未成链的 [..](..)）
  const literal = (text.match(/\\[[^\\]]*\\]\\(/g) || []).length
  return JSON.stringify({ links, literal, text })
})()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  let page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  if (!page) { console.log('NO-APP-PAGE'); return }
  // NEW_WINDOW=1：在当前 app 里另开一个窗口跑验收，完全不碰用户窗口里的文档
  // （本项目的验收会临时切到未命名缓冲区，对正在编辑的用户文档是有侵入的）
  let tempWindow = null
  if (process.env.NEW_WINDOW === '1') {
    const opener = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { opener.onopen = res; opener.onerror = rej })
    let oid = 0
    const opending = new Map()
    opener.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && opending.has(m.id)) { opending.get(m.id)(m); opending.delete(m.id) } }
    const osend = (method, params) => new Promise((res) => { const i = ++oid; opending.set(i, res); opener.send(JSON.stringify({ id: i, method, params })) })
    await osend('Runtime.evaluate', { expression: '(window.luminAPI.app.newWindow(), "ok")', returnByValue: true })
    const mainId = page.id
    for (let i = 0; i < 60; i++) {
      await sleep(400)
      const list = await (await fetch(CDP)).json()
      const pages = list.filter((t) => t.type === 'page' && t.url.includes('5173'))
      if (pages.length >= 2) { page = pages.find((p) => p.id !== mainId) ?? page; tempWindow = page; break }
    }
    opener.close()
    if (!tempWindow) { console.log('SKIP: 第二个窗口未出现'); return }
    console.log('（在第二个窗口里验收，用户窗口不受影响）')
  }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 80; i++) { await sleep(300); if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break }

  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym] ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map) ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(500)

  const before = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (before.dirty) { console.log('SKIP: 当前文档有未保存修改'); ws.close(); return }

  await ev(`(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  await ev(`(() => { window.__vt.files().setContent(${MD}); window.__vt.ed().commands.setContent(${MD}, { emitUpdate: false }); return 'ok' })()`)
  await sleep(800)

  // ── A. 手打 [文字](网址) ────────────────────────────────────────────────
  await ev(`(() => { const ed = window.__vt.ed(); ed.commands.focus('end'); return 'ok' })()`)
  await sleep(300)
  await typeText('[Lumin](https://lumin.app)')
  const a = JSON.parse(await ev(LINKS))
  console.log('A ' + JSON.stringify(a))
  c('typed-markdown-becomes-link', a.links.length === 1 && a.links[0].text === 'Lumin' && a.links[0].href === 'https://lumin.app', JSON.stringify(a.links))
  c('no-literal-brackets-left', a.literal === 0 && !a.text.includes(']('), JSON.stringify({ text: a.text, literal: a.literal }))
  // 紧跟其后继续输入不应落进链接
  await typeText('尾巴')
  const a2 = JSON.parse(await ev(LINKS))
  const luminLink = a2.links.find((l) => l.href === 'https://lumin.app')
  c('typing-after-link-not-inside', !!luminLink && luminLink.text === 'Lumin' && a2.text.endsWith('尾巴'), JSON.stringify({ links: a2.links, text: a2.text }))

  // ── B. 工具栏插入 → 展开 → 手动编辑（含切开 run 的插入）→ 收敛 ─────────
  await ev(`(() => {
    const ed = window.__vt.ed()
    ed.state.doc.descendants((n, p) => { if (n.isText && n.text.includes('结尾段落')) ed.commands.setTextSelection({ from: p + 1, to: p + 1 + 4 }) })
    return 'ok'
  })()`)
  await sleep(200)
  await ev(`(() => { window.__vt.ed().chain().focus().setLink({ href: 'https://old.example.com' }).run(); return 'ok' })()`)
  await sleep(500)
  const b0 = JSON.parse(await ev(LINKS))
  console.log('B0 ' + JSON.stringify(b0.links))

  // 点击链接 → 展开为 [文字](网址) 源码态
  const linkPt = JSON.parse(await ev(`(() => {
    const ed = window.__vt.ed()
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (n.isText && n.marks.some((m) => m.type.name === 'link') && pos < 0) pos = p })
    const co = ed.view.coordsAtPos(pos + 2)
    return JSON.stringify({ x: Math.round(co.left + 6), y: Math.round((co.top + co.bottom) / 2) })
  })()`))
  await clickPoint(linkPt.x, linkPt.y)
  const b1 = JSON.parse(await ev(`(() => { const ed = window.__vt.ed(); const t = ed.state.doc.textContent; return JSON.stringify({ text: t, expanded: t.includes('](') }) })()`))
  console.log('B1 ' + JSON.stringify(b1))
  c('click-expands-to-source', b1.expanded === true, JSON.stringify(b1))

  // 模拟「手动编辑把展开区切开」：在网址中间插入一段不带任何标记的文本
  // （定位方式：找到含 old. 的文本节点的绝对位置，在其 URL 里插入）
  const editPos = JSON.parse(await ev(`(() => {
    const ed = window.__vt.ed()
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (n.isText && n.text.includes('old.') && pos < 0) pos = p + n.text.indexOf('old.') + 3 })
    return JSON.stringify({ pos })
  })()`))
  await ev(`(() => {
    const ed = window.__vt.ed()
    const tr = ed.state.tr
    // 用 replaceWith 插入「不带任何 mark 的文本节点」：等价于往网址里粘贴纯文本，
    // 新文本不带 linkSource → 把一个展开区切成两段（正是 bug 的成因场景）
    tr.replaceWith(${editPos.pos}, ${editPos.pos}, ed.state.schema.text('-edit-'))
    ed.view.dispatch(tr)
    return 'ok'
  })()`)
  await sleep(400)
  const b2 = JSON.parse(await ev(`(() => { const ed = window.__vt.ed(); return JSON.stringify({ text: ed.state.doc.textContent }) })()`))
  console.log('B2 ' + JSON.stringify(b2))
  // 关键证据：插入的文本不带 linkSource 标记、且展开区已被切成 ≥2 段 run
  // —— 这正是此前「折叠失败、把 [](url) 明文留在渲染界面」的成因场景
  const split = JSON.parse(await ev(`(() => {
    const ed = window.__vt.ed()
    let editedUnmarked = false
    ed.state.doc.descendants((n) => { if (n.isText && n.text.includes('-edit-') && !n.marks.some((m) => m.type.name === 'linkSource')) editedUnmarked = true })
    const runs = []
    ed.state.doc.descendants((n, pos) => {
      if (!n.isTextblock) return
      let cur = null
      n.content.forEach((c, off) => {
        const has = c.isText && c.marks.some((m) => m.type.name === 'linkSource')
        const abs = pos + 1 + off
        if (has) {
          if (cur && cur.to === abs) cur.to = abs + c.nodeSize
          else { cur = { from: abs, to: abs + c.nodeSize }; runs.push(cur) }
        } else cur = null
      })
    })
    return JSON.stringify({ editedUnmarked, runCount: runs.length })
  })()`))
  console.log('B2-split ' + JSON.stringify(split))
  c('manual-edit-split-the-run', split.editedUnmarked === true && split.runCount >= 2, JSON.stringify(split))
  // 光标移出展开区 → 自动折叠
  await ev(`(() => { const ed = window.__vt.ed(); ed.commands.focus('end'); return 'ok' })()`)
  await sleep(700)
  const b3 = JSON.parse(await ev(LINKS))
  console.log('B3 ' + JSON.stringify(b3))
  const editedLink = b3.links.find((l) => l.href.includes('-edit-'))
  c('edited-link-collapses-back', !!editedLink, JSON.stringify(b3.links))
  c('no-literal-markdown-after-edit', !b3.text.includes('](') && b3.literal === 0, JSON.stringify({ text: b3.text, literal: b3.literal }))

  let md = ''
  for (let i = 0; i < 20; i++) {
    md = await ev(`window.__vt.files().current.content`)
    if (String(md).includes('-edit-')) break
    await sleep(300)
  }
  console.log('MD ' + JSON.stringify(String(md).split('\n').filter((l) => l.trim()).join(' / ')))
  c('markdown-roundtrip-has-link', /\]\(https:\/\/[^)]*-edit-[^)]*\)/.test(String(md)), JSON.stringify(String(md).split('\n').find((l) => l.includes('old')) || ''))

  // ── C. 破坏语法（删掉右括号）→ 保持纯文本 ───────────────────────────────
  const linkPt2 = JSON.parse(await ev(`(() => {
    const ed = window.__vt.ed()
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (n.isText && n.marks.some((m) => m.type.name === 'link') && pos < 0) pos = p })
    if (pos < 0) return JSON.stringify({ x: -1, y: -1 })
    const co = ed.view.coordsAtPos(pos + 2)
    return JSON.stringify({ x: Math.round(co.left + 6), y: Math.round((co.top + co.bottom) / 2) })
  })()`))
  await clickPoint(linkPt2.x, linkPt2.y)
  await sleep(300)
  // 展开态下删掉结尾的右括号
  await ev(`(() => {
    const ed = window.__vt.ed()
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (n.isText && n.text.includes(')') && pos < 0) pos = p + n.text.lastIndexOf(')') })
    if (pos >= 0) { const tr = ed.state.tr.delete(pos, pos + 1); ed.view.dispatch(tr) }
    return 'ok'
  })()`)
  await sleep(300)
  await ev(`(() => { window.__vt.ed().commands.focus('end'); return 'ok' })()`)
  await sleep(600)
  const cState = JSON.parse(await ev(LINKS))
  console.log('C ' + JSON.stringify(cState))
  c('broken-syntax-stays-literal', cState.literal >= 1 && !cState.links.some((l) => l.href.includes('-edit-')), JSON.stringify({ literal: cState.literal, tail: cState.text.slice(-48) }))

  // ── D. 空标签 [](url)：PM 禁止空文本节点，input rule 必须安全放弃（曾抛 RangeError）
  await ev(`(() => {
    window.__errs = []
    window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || '')))
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason?.message ?? e.reason)))
    window.__vt.ed().commands.focus('end')
    return 'ok'
  })()`)
  await sleep(300)
  await typeText('[](https://emptylabel.example.com)')
  await sleep(500)
  const dState = JSON.parse(await ev(LINKS))
  const pageErrs = JSON.parse(await ev(`JSON.stringify(window.__errs)`))
  console.log('D ' + JSON.stringify({ tail: dState.text.slice(-40), literal: dState.literal, pageErrs }))
  c('empty-label-no-crash', pageErrs.length === 0, JSON.stringify(pageErrs))
  c('empty-label-stays-literal', dState.text.endsWith('[](https://emptylabel.example.com)'), JSON.stringify(dState.text.slice(-40)))

  // 复原
  await ev(`(async () => {
    const f = window.__vt.files()
    await f.close()
    ${before.path ? `await f.openPath(${JSON.stringify(before.path)})` : ''}
    await window.luminAPI.drafts.remove('untitled')
    return 'ok'
  })()`)
  await sleep(500)
  const restored = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  c('state-restored', restored.path === before.path, JSON.stringify(restored))

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  if (tempWindow) { await send('Page.close').catch(() => {}); await sleep(400) }
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
