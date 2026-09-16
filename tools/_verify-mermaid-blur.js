// 复现/验收：mermaid 代码块「点进源码态 → 点击块外应回到图表态」
// 断言链：图表态 → 点击图表 (1) 进入源码态且 textarea 真获得焦点
//        (2) 点击块外 → 回到图表态；(3) 改源码后点击块外 → 内容提交 + 回到图表态
const CDP = 'http://127.0.0.1:9222/json'
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
async function clickPoint(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
/** 取某选择器的中心点 */
async function centerOf(selector) {
  const s = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`)
  return s ? JSON.parse(s) : null
}
/** mermaid 块外的可点区域（代码块之后的段落；没有则用编辑区右下角） */
async function outsidePoint() {
  const s = await ev(`(() => {
    const wrap = document.querySelector('.code-block-wrapper')
    const next = wrap?.nextElementSibling
    if (next) { const r = next.getBoundingClientRect(); if (r.width > 40 && r.height > 8) return JSON.stringify({ x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }) }
    const prose = document.querySelector('.ProseMirror').getBoundingClientRect()
    return JSON.stringify({ x: Math.round(prose.right - 60), y: Math.round(prose.bottom - 60) })
  })()`)
  return JSON.parse(s)
}
const STATE = `(() => {
  const ta = document.querySelector('.mermaid-source-input')
  const render = document.querySelector('.mermaid-render')
  return JSON.stringify({
    hasTextarea: !!ta,
    hasRender: !!render,
    hasSvg: !!document.querySelector('.mermaid-render svg'),
    activeEl: document.activeElement ? document.activeElement.className || document.activeElement.tagName : null,
    textareaFocused: !!(ta && document.activeElement === ta)
  })
})()`
/** 当前代码块节点的文本（不限语言） */
const NODE_TEXT = `(() => { const ed = window.__vt.ed(); let t = null; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock' && t === null) t = n.textContent }); return t })()`

const MD = ['# mermaid 验收', '', '```mermaid', 'graph TD', '  A[开始] --> B[结束]', '```', '', '块外段落'].join('\n')

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = app._context.provides[sym]
    window.__vt = { ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(400)

  const openedBefore = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (openedBefore.dirty) { console.log('SKIP: 当前文档有未保存修改'); ws.close(); return }

  await ev(`(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  await ev(`(() => { window.__vt.files().setContent(${JSON.stringify(MD)}); window.__vt.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false }); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 300 && !document.querySelector('.mermaid-render svg'); i++) await new Promise((r) => setTimeout(r, 25)); return 'svg' })()`)
  await sleep(500)

  const initial = JSON.parse(await ev(STATE))
  console.log('INITIAL        ' + JSON.stringify(initial))
  c('starts-as-diagram', initial.hasRender === true && initial.hasSvg === true && initial.hasTextarea === false, JSON.stringify(initial))

  // (1) 点击图表 → 应进入源码态，且 textarea 获得焦点
  const rp = await centerOf('.mermaid-render')
  await clickPoint(rp.x, rp.y)
  await sleep(500)
  const editing = JSON.parse(await ev(STATE))
  console.log('AFTER-CLICK-IN ' + JSON.stringify(editing))
  c('click-enters-source', editing.hasTextarea === true && editing.hasRender === false, JSON.stringify(editing))
  c('textarea-autofocused', editing.textareaFocused === true, 'activeEl=' + editing.activeEl)

  // (2) 点击块外 → 应回到图表态
  const op = await outsidePoint()
  await clickPoint(op.x, op.y)
  await sleep(700)
  const afterOut = JSON.parse(await ev(STATE))
  console.log('AFTER-CLICK-OUT ' + JSON.stringify(afterOut) + '  outside=' + JSON.stringify(op))
  c('blur-returns-to-diagram', afterOut.hasRender === true && afterOut.hasTextarea === false, JSON.stringify(afterOut))

  // (3) 再次进入、改源码、点块外 → 内容提交且回到图表态
  const rp2 = await centerOf('.mermaid-render')
  await clickPoint(rp2.x, rp2.y)
  await sleep(500)
  const editing2 = JSON.parse(await ev(STATE))
  c('re-enter-source', editing2.hasTextarea === true && editing2.textareaFocused === true, JSON.stringify(editing2))
  const before = await ev(NODE_TEXT)
  await send('Input.insertText', { text: '\n  B --> C[新增]' })
  await sleep(300)
  const op2 = await outsidePoint()
  await clickPoint(op2.x, op2.y)
  await sleep(800)
  const afterEdit = JSON.parse(await ev(STATE))
  const nodeText = await ev(NODE_TEXT)
  console.log('AFTER-EDIT     ' + JSON.stringify(afterEdit) + ' node=' + JSON.stringify(nodeText))
  c('edit-committed', nodeText !== before && nodeText.includes('新增'), JSON.stringify(nodeText))
  c('edit-blur-to-diagram', afterEdit.hasRender === true && afterEdit.hasTextarea === false, JSON.stringify(afterEdit))

  // (4) 语言切换：mermaid → 其它语言（CM 应按需创建且可编辑）→ 回 mermaid → 再切过去
  const setLang = async (lang) => {
    await ev(`(() => { const s = document.querySelector('.code-block-select'); s.value = ${JSON.stringify(lang)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok' })()`)
    await sleep(900)
  }
  const SWITCH = `(() => {
    const ed = window.__vt.ed()
    return JSON.stringify({
      lang: document.querySelector('.code-block-lang-label')?.textContent ?? null,
      cm: !!document.querySelector('.cm-editor'),
      cmLines: document.querySelectorAll('.cm-content .cm-line').length,
      render: !!document.querySelector('.mermaid-render'),
      textarea: !!document.querySelector('.mermaid-source-input'),
      guardInstalled: ed.view.hasFocus.name === ''
    })
  })()`

  const guardBefore = JSON.parse(await ev(SWITCH))
  c('guard-clean-before', guardBefore.guardInstalled === false, JSON.stringify(guardBefore))

  await setLang('javascript')
  const asJs = JSON.parse(await ev(SWITCH))
  console.log('AS-JS          ' + JSON.stringify(asJs))
  c('switch-away-creates-cm', asJs.lang === 'javascript' && asJs.cm === true && asJs.textarea === false, JSON.stringify(asJs))
  c('guard-installed-with-cm', asJs.guardInstalled === true, JSON.stringify(asJs))

  // CM 可编辑：点进 CM 输入字符 → 应同步进 ProseMirror 节点
  const cp = await centerOf('.cm-content')
  await clickPoint(cp.x + 20, cp.y)
  await sleep(300)
  const jsBefore = await ev(NODE_TEXT)
  await send('Input.insertText', { text: 'Z' })
  await sleep(500)
  const jsAfter = await ev(NODE_TEXT)
  console.log('JS-EDIT        before=' + JSON.stringify(jsBefore) + ' after=' + JSON.stringify(jsAfter))
  c('cm-editable-after-switch', jsAfter !== jsBefore && jsAfter.includes('Z'), JSON.stringify(jsAfter))

  // 回车走「setState 重建」路径（buildCmExtensions 在重建里被复用）：内容加一行且焦点不被 PM 抢走
  const linesBefore = await ev(`document.querySelectorAll('.cm-content .cm-line').length`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(600)
  const linesAfter = await ev(`document.querySelectorAll('.cm-content .cm-line').length`)
  const focusInCm = await ev(`(() => { const ae = document.activeElement; return !!(ae && ae.closest && ae.closest('.cm-editor')) })()`)
  const afterEnter = await ev(NODE_TEXT)
  console.log('JS-ENTER       lines=' + linesBefore + '->' + linesAfter + ' focusInCm=' + focusInCm + ' node=' + JSON.stringify(afterEnter))
  c('enter-rebuilds-state', linesAfter === linesBefore + 1, `${linesBefore} -> ${linesAfter}`)
  c('focus-stays-in-cm', focusInCm === true && (afterEnter || '').includes('\n'), 'focusInCm=' + focusInCm)

  await setLang('mermaid')
  await ev(`(async () => { for (let i = 0; i < 300 && !document.querySelector('.mermaid-render svg'); i++) await new Promise((r) => setTimeout(r, 25)); return 'svg' })()`)
  await sleep(300)
  const backMmd = JSON.parse(await ev(SWITCH))
  console.log('BACK-MERMAID   ' + JSON.stringify(backMmd))
  c('switch-back-shows-diagram', backMmd.render === true && backMmd.cm === false && backMmd.textarea === false, JSON.stringify(backMmd))
  c('guard-released-after-teardown', backMmd.guardInstalled === false, JSON.stringify(backMmd))

  // 第二次切过去：CM 必须能重新创建（宿主节点是新的空节点）
  await setLang('javascript')
  const again = JSON.parse(await ev(SWITCH))
  console.log('AS-JS-AGAIN    ' + JSON.stringify(again))
  c('cm-recreated-second-time', again.cm === true && again.cmLines >= 1, JSON.stringify(again))
  await setLang('mermaid')
  await ev(`(async () => { for (let i = 0; i < 300 && !document.querySelector('.mermaid-render svg'); i++) await new Promise((r) => setTimeout(r, 25)); return 'svg' })()`)
  const finalState = JSON.parse(await ev(SWITCH))
  c('final-diagram-state', finalState.render === true && finalState.cm === false, JSON.stringify(finalState))

  // (5) 多轮切换后，源码态 textarea 仍可正常输入（验证 wrapper 的 contentEditable 已还原、
  //     textarea 没有被隔离成不可编辑）
  const rp5 = await centerOf('.mermaid-render')
  await clickPoint(rp5.x, rp5.y)
  await sleep(500)
  const editing5 = JSON.parse(await ev(STATE))
  c('source-editable-after-switches', editing5.hasTextarea === true && editing5.textareaFocused === true, JSON.stringify(editing5))
  const nodeBefore5 = await ev(NODE_TEXT)
  await send('Input.insertText', { text: '\n  %% 注释' })
  await sleep(300)
  const typed5 = await ev(`document.querySelector('.mermaid-source-input').value`)
  c('textarea-accepts-input', (typed5 || '').includes('%% 注释'), JSON.stringify(typed5))
  const op5 = await outsidePoint()
  await clickPoint(op5.x, op5.y)
  await sleep(900)
  const after5 = JSON.parse(await ev(STATE))
  const nodeAfter5 = await ev(NODE_TEXT)
  c('typed-source-committed', nodeAfter5 !== nodeBefore5 && (nodeAfter5 || '').includes('%% 注释'), JSON.stringify(nodeAfter5))
  c('back-to-diagram-after-typing', after5.hasRender === true && after5.hasTextarea === false, JSON.stringify(after5))

  // 复原
  await ev(`(async () => {
    const f = window.__vt.files()
    await f.close()
    ${openedBefore.path ? `await f.openPath(${JSON.stringify(openedBefore.path)})` : ''}
    await window.luminAPI.drafts.remove('untitled-' + (window.luminAPI.app.sessionSlot ?? 0))
    return 'ok'
  })()`)
  await sleep(500)
  const restored = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  c('state-restored', restored.path === openedBefore.path, JSON.stringify(restored))

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
