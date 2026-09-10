// 验收：设置里的「代码块行号」开关
// 覆盖：默认显示行号 → 在设置面板里真实点击开关 → 行号消失 → 再点回 → 行号恢复
//       → 持久化写入 → 关闭后再触发一次外部内容同步（state 重建）仍不显示行号
// 全程在新建的未命名缓冲区里进行，结束后关闭缓冲区并恢复设置与打开的文件。
const CDP = 'http://127.0.0.1:9222/json'
const LABEL = '代码块行号'
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(30)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const MD = ['# 行号验收', '', '```js', 'const a = 1', 'const b = 2', 'const c = 3', '```', '', '尾段'].join('\n')

/** 读当前行号槽状态（CM 会在行号槽里放一个隐藏的占位元素用于预留宽度，需排除） */
const GUTTER = `(() => {
  const nums = document.querySelector('.cm-lineNumbers')
  const els = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement'))
  const visible = els.filter((e) => {
    const cs = getComputedStyle(e)
    return cs.visibility !== 'hidden' && e.getBoundingClientRect().height > 0
  })
  return JSON.stringify({
    hasNumberGutter: !!nums,
    numbers: visible.map((e) => e.textContent.trim()).filter(Boolean),
    spacers: els.length - visible.length,
    foldGutter: !!document.querySelector('.cm-foldGutter')
  })
})()`

async function switchRect() {
  return await ev(`(() => {
    const sec = Array.from(document.querySelectorAll('.settings-panel section')).find((s) => s.textContent.includes(${JSON.stringify(LABEL)}))
    if (!sec) return null
    const btn = sec.querySelector('button.switch')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), on: btn.classList.contains('on'), label: sec.querySelector('p')?.textContent ?? '' })
  })()`)
}

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym]
    window.__vt = { ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(400)

  const openedBefore = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty, lineNumbers: window.__vt.settings().codeLineNumbers }) })()`))
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (openedBefore.dirty) {
    console.log('SKIP: 当前文档有未保存修改，跳过侵入式测试')
    ws.close()
    return
  }
  console.log('BEFORE ' + JSON.stringify(openedBefore))

  // 准备：未命名缓冲区 + 一个代码块
  await ev(`(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  await ev(`(() => { window.__vt.files().setContent(${JSON.stringify(MD)}); window.__vt.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false }); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !document.querySelector('.cm-lineNumbers'); i++) await new Promise((r) => setTimeout(r, 25)); return 'cm' })()`)
  await sleep(500)

  const initial = JSON.parse(await ev(GUTTER))
  console.log('INITIAL ' + JSON.stringify(initial))
  c('numbers-default-on', initial.hasNumberGutter === true && initial.numbers.join(',') === '1,2,3', JSON.stringify(initial.numbers))
  c('setting-default-true', openedBefore.lineNumbers === true, 'codeLineNumbers=' + openedBefore.lineNumbers)

  // 打开设置 → 编辑器页 → 找到开关
  await ev(`(() => { const ui = window.__vt.ui(); ui.settingsOpen = true; ui.settingsSection = 'editor'; return 'ok' })()`)
  await sleep(600)
  let rect = await switchRect()
  console.log('SWITCH ' + rect)
  c('switch-present', !!rect, rect ? JSON.parse(rect).label : 'not found')
  if (!rect) { ws.close(); return }
  const r = JSON.parse(rect)
  c('switch-reflects-true', r.on === true, 'on=' + r.on)

  // 关（真实点击）
  await clickAt(r.x, r.y)
  await sleep(700)
  const off = JSON.parse(await ev(GUTTER))
  const settingOff = await ev(`window.__vt.settings().codeLineNumbers`)
  console.log('AFTER-OFF ' + JSON.stringify(off) + ' setting=' + settingOff)
  c('setting-off', settingOff === false)
  c('numbers-hidden', off.hasNumberGutter === false && off.numbers.length === 0, JSON.stringify(off))
  c('fold-gutter-kept', off.foldGutter === true)
  const rect2 = JSON.parse(await switchRect())
  c('switch-reflects-false', rect2.on === false, 'on=' + rect2.on)

  // 关闭设置面板后仍保持关闭状态，并触发一次外部内容同步（state 重建路径）
  await ev(`(() => { window.__vt.ui().settingsOpen = false; return 'ok' })()`)
  await sleep(500)
  const md2 = MD.replace('const c = 3', 'const c = 4')
  await ev(`(() => { window.__vt.files().setContent(${JSON.stringify(md2)}); window.__vt.ed().commands.setContent(${JSON.stringify(md2)}, { emitUpdate: false }); return 'ok' })()`)
  await sleep(900)
  const afterSync = JSON.parse(await ev(GUTTER))
  console.log('AFTER-EXTERNAL-SYNC ' + JSON.stringify(afterSync))
  c('off-survives-state-rebuild', afterSync.hasNumberGutter === false, JSON.stringify(afterSync))

  // 持久化
  await sleep(600)
  const persisted = await ev(`(async () => { const s = await window.luminAPI.settings.getAll(); return s.codeLineNumbers })()`)
  c('persisted-off', persisted === false, 'persisted=' + persisted)

  // 再开（真实点击）
  await ev(`(() => { const ui = window.__vt.ui(); ui.settingsOpen = true; ui.settingsSection = 'editor'; return 'ok' })()`)
  await sleep(600)
  const rect3 = JSON.parse(await switchRect())
  await clickAt(rect3.x, rect3.y)
  await sleep(800)
  const on = JSON.parse(await ev(GUTTER))
  const settingOn = await ev(`window.__vt.settings().codeLineNumbers`)
  console.log('AFTER-ON ' + JSON.stringify(on) + ' setting=' + settingOn)
  c('setting-back-on', settingOn === true)
  c('numbers-restored', on.hasNumberGutter === true && on.numbers.join(',') === '1,2,3', JSON.stringify(on.numbers))

  // 复原：关闭设置面板、关闭缓冲区、清草稿、恢复设置与打开的文件
  await ev(`(async () => {
    const ui = window.__vt.ui(), f = window.__vt.files(), s = window.__vt.settings()
    ui.settingsOpen = false
    await f.close()
    ${openedBefore.path ? `await f.openPath(${JSON.stringify(openedBefore.path)})` : ''}
    await window.luminAPI.drafts.remove('untitled')
    s.set('codeLineNumbers', ${openedBefore.lineNumbers})
    await window.luminAPI.settings.update({ codeLineNumbers: ${openedBefore.lineNumbers} })
    return 'ok'
  })()`)
  await sleep(900)
  const restored = JSON.parse(await ev(`(async () => { const s = await window.luminAPI.settings.getAll(); const f = window.__vt.files(); return JSON.stringify({ persisted: s.codeLineNumbers, path: f.current?.path ?? null, dirty: !!f.dirty, settingsOpen: window.__vt.ui().settingsOpen }) })()`))
  c('state-restored', restored.persisted === openedBefore.lineNumbers && restored.path === openedBefore.path && restored.settingsOpen === false, JSON.stringify(restored))

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
