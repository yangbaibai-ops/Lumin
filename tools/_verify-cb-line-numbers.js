// 验收：设置里的「代码块行号」开关
// 覆盖：默认显示行号 → 在设置面板里真实点击开关 → 行号消失 → 再点回 → 行号恢复
//       → 持久化写入 → 关闭后再触发一次外部内容同步（state 重建）仍不显示行号
// 全程在新建的未命名缓冲区里进行，结束后关闭缓冲区并恢复设置与打开的文件。
const CDP = 'http://127.0.0.1:9222/json'
const LABEL = '代码块行号'
let ws,
  id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) {
  return new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
}
async function ev(e) {
  const r = await send('Runtime.evaluate', {
    expression: e,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails)
    throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await sleep(30)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}
const MD = [
  '# 行号验收',
  '',
  '```js',
  'const a = 1',
  'const b = 2',
  'const c = 3',
  '```',
  '',
  '尾段'
].join('\n')

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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = app._context.provides[sym]
    window.__vt = { ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(
    `(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`
  )
  await sleep(400)

  const openedBefore = JSON.parse(
    await ev(
      `(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty, lineNumbers: window.__vt.settings().codeLineNumbers }) })()`
    )
  )
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (openedBefore.dirty) {
    console.log('SKIP: 当前文档有未保存修改，跳过侵入式测试')
    ws.close()
    return
  }
  console.log('BEFORE ' + JSON.stringify(openedBefore))

  // 准备：未命名缓冲区 + 一个代码块
  await ev(
    `(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`
  )
  await ev(
    `(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`
  )
  await ev(
    `(() => { window.__vt.files().setContent(${JSON.stringify(MD)}); window.__vt.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false }); return 'ok' })()`
  )
  await ev(
    `(async () => { for (let i = 0; i < 200 && !document.querySelector('.cm-lineNumbers'); i++) await new Promise((r) => setTimeout(r, 25)); return 'cm' })()`
  )
  await sleep(500)

  const initial = JSON.parse(await ev(GUTTER))
  console.log('INITIAL ' + JSON.stringify(initial))
  // 不预设默认为开：用户可能已在工具栏/设置里关掉，断言只要求「行号槽状态与设置一致」
  c(
    'numbers-match-setting',
    initial.hasNumberGutter === openedBefore.lineNumbers &&
      (openedBefore.lineNumbers
        ? initial.numbers.join(',') === '1,2,3'
        : initial.numbers.length === 0),
    JSON.stringify({ setting: openedBefore.lineNumbers, numbers: initial.numbers })
  )
  c(
    'setting-readable',
    typeof openedBefore.lineNumbers === 'boolean',
    'codeLineNumbers=' + openedBefore.lineNumbers
  )

  // 打开设置 → 编辑器页 → 找到开关
  await ev(
    `(() => { const ui = window.__vt.ui(); ui.settingsOpen = true; ui.settingsSection = 'editor'; return 'ok' })()`
  )
  await sleep(600)
  let rect = await switchRect()
  console.log('SWITCH ' + rect)
  c('switch-present', !!rect, rect ? JSON.parse(rect).label : 'not found')
  if (!rect) {
    ws.close()
    return
  }
  const r = JSON.parse(rect)
  c('switch-reflects-setting', r.on === openedBefore.lineNumbers, 'on=' + r.on)

  // 反向切换（真实点击）
  const flipped = !openedBefore.lineNumbers
  await clickAt(r.x, r.y)
  await sleep(700)
  const off = JSON.parse(await ev(GUTTER))
  const settingOff = await ev(`window.__vt.settings().codeLineNumbers`)
  console.log('AFTER-FLIP ' + JSON.stringify(off) + ' setting=' + settingOff)
  c('setting-flipped', settingOff === flipped, 'setting=' + settingOff + ' expect=' + flipped)
  c(
    'numbers-follow-setting',
    off.hasNumberGutter === flipped &&
      (flipped ? off.numbers.join(',') === '1,2,3' : off.numbers.length === 0),
    JSON.stringify(off)
  )
  c('fold-gutter-kept', off.foldGutter === true)
  const rect2 = JSON.parse(await switchRect())
  c('switch-reflects-flipped', rect2.on === flipped, 'on=' + rect2.on)

  // 关闭设置面板后仍保持该状态，并触发一次外部内容同步（state 重建路径）
  await ev(`(() => { window.__vt.ui().settingsOpen = false; return 'ok' })()`)
  await sleep(500)
  const md2 = MD.replace('const c = 3', 'const c = 4')
  await ev(
    `(() => { window.__vt.files().setContent(${JSON.stringify(md2)}); window.__vt.ed().commands.setContent(${JSON.stringify(md2)}, { emitUpdate: false }); return 'ok' })()`
  )
  await sleep(900)
  const afterSync = JSON.parse(await ev(GUTTER))
  console.log('AFTER-EXTERNAL-SYNC ' + JSON.stringify(afterSync))
  c('state-survives-rebuild', afterSync.hasNumberGutter === flipped, JSON.stringify(afterSync))

  // 持久化
  await sleep(600)
  const persisted = await ev(
    `(async () => { const s = await window.luminAPI.settings.getAll(); return s.codeLineNumbers })()`
  )
  c('persisted-flipped', persisted === flipped, 'persisted=' + persisted + ' expect=' + flipped)

  // 切回初始值（真实点击）
  await ev(
    `(() => { const ui = window.__vt.ui(); ui.settingsOpen = true; ui.settingsSection = 'editor'; return 'ok' })()`
  )
  await sleep(600)
  const rect3 = JSON.parse(await switchRect())
  await clickAt(rect3.x, rect3.y)
  await sleep(800)
  const on = JSON.parse(await ev(GUTTER))
  const settingOn = await ev(`window.__vt.settings().codeLineNumbers`)
  console.log('AFTER-RESTORE ' + JSON.stringify(on) + ' setting=' + settingOn)
  c('setting-back-to-initial', settingOn === openedBefore.lineNumbers)
  c(
    'numbers-back-to-initial',
    on.hasNumberGutter === openedBefore.lineNumbers &&
      (openedBefore.lineNumbers ? on.numbers.join(',') === '1,2,3' : on.numbers.length === 0),
    JSON.stringify(on.numbers)
  )

  // 复原：关闭设置面板、关闭缓冲区、清草稿、恢复设置与打开的文件
  await ev(`(async () => {
    const ui = window.__vt.ui(), f = window.__vt.files(), s = window.__vt.settings()
    ui.settingsOpen = false
    await f.close()
    ${openedBefore.path ? `await f.openPath(${JSON.stringify(openedBefore.path)})` : ''}
    await window.luminAPI.drafts.remove('untitled-' + (window.luminAPI.app.sessionSlot ?? 0))
    s.set('codeLineNumbers', ${openedBefore.lineNumbers})
    await window.luminAPI.settings.update({ codeLineNumbers: ${openedBefore.lineNumbers} })
    return 'ok'
  })()`)
  await sleep(900)
  const restored = JSON.parse(
    await ev(
      `(async () => { const s = await window.luminAPI.settings.getAll(); const f = window.__vt.files(); return JSON.stringify({ persisted: s.codeLineNumbers, path: f.current?.path ?? null, dirty: !!f.dirty, settingsOpen: window.__vt.ui().settingsOpen }) })()`
    )
  )
  c(
    'state-restored',
    restored.persisted === openedBefore.lineNumbers &&
      restored.path === openedBefore.path &&
      restored.settingsOpen === false,
    JSON.stringify(restored)
  )

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  // 汇总行 + 退出码：run-suites.js 判定以**退出码**为准，此前这里只打印结果、永远退 0，
  // 断言红了整轮矩阵照绿（也不进 0/0 的计数）—— 与 _verify-blockquote-style.js 同款修法。
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  ws.close()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
