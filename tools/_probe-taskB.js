'use strict'
// 任务 B 的取证探针：转义反斜杠的拆分渲染（灰色可见）+ 三个主题下的颜色 + 字节不变。
const { connect, settle, waitEditor, sleep, openDocWith, fatal } = require('./lib/harness')

const FLUSH = `(() => {
  window.dispatchEvent(new Event('beforeunload'))
  return window.__L.files().current?.content ?? null
})()`

const PROBE = `JSON.stringify((() => {
  const ed = window.__L.ed()
  const paras = [...document.querySelectorAll('.ProseMirror p')]
  const bs = [...document.querySelectorAll('.md-escape-backslash')]
  const ch = [...document.querySelectorAll('.md-escape-char')]
  const first = paras[0] ?? null
  const bodyColor = first ? getComputedStyle(first).color : null
  const info = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return { text: el.textContent, color: cs.color, fontSize: cs.fontSize, display: cs.display,
             visibility: cs.visibility, opacity: cs.opacity, w: Math.round(r.width * 100) / 100,
             h: Math.round(r.height * 100) / 100, parent: el.parentElement?.className ?? null,
             html: el.outerHTML }
  }
  return {
    theme: document.documentElement.className,
    docText: ed ? ed.state.doc.textContent : null,
    paras: paras.map((p) => p.textContent),
    bodyColor,
    backslashCount: bs.length,
    charCount: ch.length,
    bs0: info(bs[0]),
    ch0: info(ch[0]),
    firstParaHTML: first ? first.innerHTML : null,
    // 段落内所有 span 的类（看拆分形态）
    spans: first ? [...first.querySelectorAll('span')].map((s) => s.className + '|' + JSON.stringify(s.textContent)) : null
  }
})())`

let app = null

async function dump(label) {
  const d = JSON.parse(await app.ev(PROBE))
  const content = await app.ev(FLUSH)
  console.log(`\n### ${label}`)
  console.log('  theme        : ' + d.theme)
  console.log('  docText      : ' + JSON.stringify(d.docText))
  console.log('  字节(flush)  : ' + JSON.stringify(content))
  console.log('  段落文本     : ' + JSON.stringify(d.paras))
  console.log('  正文颜色     : ' + d.bodyColor)
  console.log('  span 数      : backslash=' + d.backslashCount + ' char=' + d.charCount)
  console.log('  bs[0]        : ' + JSON.stringify(d.bs0))
  console.log('  ch[0]        : ' + JSON.stringify(d.ch0))
  console.log('  段落 HTML    : ' + d.firstParaHTML)
  console.log('  spans        : ' + JSON.stringify(d.spans))
  return { d, content }
}

async function openDoc(md) {
  await openDocWith(app, md)
  await sleep(500)
}

async function main() {
  app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')
  const before = JSON.parse(await app.ev(`JSON.stringify({ theme: window.__L.settings().theme, autoSave: window.__L.settings().autoSave })`))

  // 场景 1：装载「整行只有 `****`」被转义后的源码（任务 B 的目标场景），
  // 光标放在**第二段**（远离转义）——验证「不跟光标显隐走、始终可见」
  await openDoc('\\*\\*\\*\\*\n\n尾行\n')
  await app.ev(`(() => { const ed = window.__L.ed(); const pm = document.querySelector('.ProseMirror'); if (pm) pm.focus(); ed.commands.focus('end'); return 'ok' })()`)
  await sleep(200)
  await dump('[B1] 装载 \\*\\*\\*\\* + 光标在末段')

  // 场景 2：光标移进转义所在段落（仍在第一段里）
  await app.ev(`(() => { const ed = window.__L.ed(); ed.commands.focus(3); return 'ok' })()`)
  await sleep(200)
  await dump('[B2] 光标在转义段内')

  // 场景 3：逐字键入 `\*`（实时路径）
  await openDoc('\n')
  for (const ch of '\\*a') {
    await app.send('Input.insertText', { text: ch })
    await sleep(60)
  }
  await sleep(200)
  await dump('[B3] 逐字键入 \\*a')

  // 场景 4：三个主题下的颜色
  for (const theme of ['light', 'dark', 'sepia']) {
    await app.ev(`(() => { window.__L.settings().set('theme', ${JSON.stringify(theme)}); return 'ok' })()`)
    await sleep(250)
    await openDoc('\\*\\*\\*\\*\n')
    await app.ev(`(() => { const ed = window.__L.ed(); const pm = document.querySelector('.ProseMirror'); if (pm) pm.focus(); ed.commands.focus('end'); return 'ok' })()`)
    await sleep(200)
    await dump('[B4] theme=' + theme)
  }

  // 场景 5：转义段里继续打字 / 退格（装饰不能干扰 DOMObserver 回读）
  await app.ev(`(() => { window.__L.settings().set('theme', 'light'); return 'ok' })()`)
  await openDoc('\\*\\*\\*\\*\n')
  await app.ev(`(() => { const ed = window.__L.ed(); const pm = document.querySelector('.ProseMirror'); if (pm) pm.focus(); ed.commands.focus('end'); return 'ok' })()`)
  await sleep(150)
  await app.send('Input.insertText', { text: 'x' })
  await sleep(300)
  await dump('[B5] 转义段末尾打 x')
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await sleep(300)
  await dump('[B5] 退格一次')

  // 复原
  await app.ev(`(() => { window.__L.settings().set('theme', ${JSON.stringify(before.theme)}); window.__L.settings().set('autoSave', ${JSON.stringify(before.autoSave)}); return 'ok' })()`)
  app.close()
}

main()
  .then(() => process.exit(0))
  .catch(fatal)
