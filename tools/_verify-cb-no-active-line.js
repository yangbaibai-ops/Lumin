// 验收：点击代码块时不再有「当前行底色」
// 覆盖：点击后该行无 cm-activeLine、底色透明、光标仍在、代码块仍可编辑（输入 + 撤销）
// 全程在新建的未命名缓冲区里进行，结束后关闭缓冲区，不动用户的文档/文件。
const CDP = 'http://127.0.0.1:9222/json'
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
async function key(type, k, code, vk, mods) { await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mods || 0 }) }

const MD = ['# 代码块验收', '', '```js', 'const a = 1', 'const b = 2', '```', '', '结尾段落'].join('\n')

async function main() {
  const t = await (await fetch(CDP)).json(); const page = t.find((x) => x.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  // 窗口在后台时页面无焦点，合成点击不会聚焦 CodeMirror；显式开启焦点模拟
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym]
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(400)

  const openedBefore = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (openedBefore.dirty) {
    console.log('SKIP: 当前文档有未保存修改，跳过（不做侵入式测试）')
    ws.close()
    return
  }

  // 新建未命名缓冲区并写入带代码块的 markdown
  await ev(`(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  await ev(`(() => { window.__vt.files().setContent(${JSON.stringify(MD)}); window.__vt.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false }); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !document.querySelector('.cm-content .cm-line'); i++) await new Promise((r) => setTimeout(r, 25)); return 'cm' })()`)
  await sleep(600)
  c('cm-mounted', (await ev(`document.querySelectorAll('.cm-editor').length`)) >= 1, 'editors=' + (await ev(`document.querySelectorAll('.cm-editor').length`)))

  // 点击代码块第一行的中间
  const pt = JSON.parse(await ev(`(() => {
    const line = document.querySelector('.cm-content .cm-line')
    const r = line.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + r.height / 2), text: line.textContent })
  })()`))
  console.log('click at ' + JSON.stringify(pt))
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(500)

  const after = JSON.parse(await ev(`(() => {
    const ed = document.querySelector('.cm-editor')
    const lines = Array.from(document.querySelectorAll('.cm-content .cm-line'))
    return JSON.stringify({
      focused: ed.classList.contains('cm-focused'),
      activeLineEls: document.querySelectorAll('.cm-content .cm-activeLine').length,
      activeLineGutterEls: document.querySelectorAll('.cm-activeLineGutter').length,
      backgrounds: lines.map((l) => getComputedStyle(l).backgroundColor),
      caret: document.querySelectorAll('.cm-cursor').length,
      cmText: Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('|'),
      blockHoverToken: getComputedStyle(document.documentElement).getPropertyValue('--block-hover').trim(),
      selBackground: (() => { const s = document.querySelector('.cm-selectionBackground'); return s ? getComputedStyle(s).backgroundColor : null })()
    })
  })()`))
  console.log('AFTER-CLICK ' + JSON.stringify(after))
  c('cm-focused', after.focused === true)
  c('no-active-line-class', after.activeLineEls === 0, 'count=' + after.activeLineEls)
  c('no-active-line-gutter', after.activeLineGutterEls === 0, 'count=' + after.activeLineGutterEls)
  c('all-lines-transparent', after.backgrounds.every((b) => b === 'rgba(0, 0, 0, 0)' || b === 'transparent'), after.backgrounds.join(' / '))
  c('caret-present', after.caret >= 1, 'carets=' + after.caret)
  c('token-untouched', after.blockHoverToken.length > 0, after.blockHoverToken)

  // 仍可编辑：插入 x → CM 与 ProseMirror 两侧都应更新；撤销 → 复原
  const before = after.cmText
  const pmBefore = await ev(`(() => { const ed = window.__vt.ed(); let t = ''; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') t += n.textContent }); return t })()`)
  await send('Input.insertText', { text: 'x' })
  await sleep(500)
  const typed = await ev(`Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('|')`)
  const pmTyped = await ev(`(() => { const ed = window.__vt.ed(); let t = ''; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') t += n.textContent }); return t })()`)
  c('typing-works', typed !== before && typed.includes('x'), JSON.stringify(typed))
  c('syncs-to-prosemirror', pmTyped !== pmBefore && pmTyped.includes('x'), JSON.stringify(pmTyped))
  await key('keyDown', 'z', 'KeyZ', 90, 2) // Ctrl+Z
  await key('keyUp', 'z', 'KeyZ', 90, 2)
  await sleep(600)
  const undone = await ev(`Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('|')`)
  const pmUndone = await ev(`(() => { const ed = window.__vt.ed(); let t = ''; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') t += n.textContent }); return t })()`)
  c('undo-restores-cm', undone === before, JSON.stringify(undone))
  c('undo-restores-pm', pmUndone === pmBefore, JSON.stringify(pmUndone))

  // 复原：关闭未命名缓冲区，清掉它可能写下的草稿，并恢复测试前打开的文件
  await ev(`(async () => {
    const f = window.__vt.files()
    await f.close()
    ${openedBefore.path ? `await f.openPath(${JSON.stringify(openedBefore.path)})` : ''}
    await window.luminAPI.drafts.remove('untitled')
    return 'ok'
  })()`)
  await sleep(500)
  const back2 = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  c('state-restored', back2.path === openedBefore.path && back2.dirty === false, JSON.stringify(back2))
  await send('Emulation.setFocusEmulationEnabled', { enabled: false })

  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
