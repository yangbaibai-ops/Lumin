'use strict'
// 取三主题的界面截图（人工核对用）：整窗口一张 + 侧栏/工具栏一张。
const path = require('path')
const os = require('os')
const fs = require('fs')
const { connect, settle, waitEditor, sleep, openDocWith } = require('./lib/harness')

const MD = [
  '# 标题一：中性灰副色',
  '',
  '普通正文里夹着 **加粗**、*斜体*、`行内代码` 与 [一个链接](https://example.com)。',
  '',
  '选中这段文字看选区颜色：默认就是系统高亮色，不再是紫色。',
  '',
  '> 引用块：色条是灰的。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '```js',
  'const answer = 42 // 关键字/字符串/数字',
  'function greet(name) { return `hi ${name}` }',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |'
].join('\n')

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('app not ready')
    return 1
  }
  const { ev, send } = app
  await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; window.__L.ui().sidebarVisible = true; window.__L.ui().sidebarTab = 'files'; return 'ok' })()`)
  await sleep(500)
  await openDocWith(app, MD, 'theme-shot.md')
  await waitEditor(ev)
  await sleep(1200)

  for (const th of ['light', 'dark', 'sepia']) {
    await ev(`(async () => { await window.__L.settings().setTheme(${JSON.stringify(th)}); return 'ok' })()`)
    await sleep(900)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const out = path.join(os.tmpdir(), `lumin-theme-${th}.png`)
    if (shot.result?.data) {
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
      console.log('saved ' + out)
    }
  }
  // 选中一段正文，单独看一眼选区色（浅色 + 深色）
  for (const th of ['light', 'dark']) {
    await ev(`(async () => { await window.__L.settings().setTheme(${JSON.stringify(th)}); return 'ok' })()`)
    await sleep(700)
    // 用**真实拖拽**选中（程序化选区在失焦时不会被浏览器画出来）
    const geo = JSON.parse(await ev(`(() => {
      const v = window.__L.ed().view
      const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.textContent.startsWith('选中这段文字'))
      if (!p) return JSON.stringify({ err: 'no-p' })
      const r = p.getBoundingClientRect()
      return JSON.stringify({ x1: Math.round(r.left + 4), x2: Math.round(r.left + 150), y: Math.round(r.top + r.height / 2) })
    })()`))
    console.log(`${th} geo ${JSON.stringify(geo)}`)
    let info = null
    // 合成拖拽偶尔会塌成一个光标（这台机器的已知现象）：重试到真的选中为止
    for (let attempt = 0; attempt < 3; attempt++) {
      await ev(`(() => { window.__L.ed().chain().setTextSelection(1).run(); return 'ok' })()`)
      await sleep(250)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x1, y: geo.y, button: 'none', buttons: 0 })
      await sleep(120)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x1, y: geo.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(120)
      for (let i = 1; i <= 6; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(geo.x1 + ((geo.x2 - geo.x1) * i) / 6),
          y: geo.y,
          button: 'left',
          buttons: 1
        })
        await sleep(45)
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x2, y: geo.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(500)
      info = JSON.parse(await ev(`JSON.stringify({
        focused: document.hasFocus(),
        domSel: String(window.getSelection()),
        collapsed: window.getSelection().isCollapsed,
        pmFrom: window.__L.ed().state.selection.from,
        pmTo: window.__L.ed().state.selection.to
      })`))
      if (info.pmTo > info.pmFrom) break
      console.log(`${th} 第 ${attempt + 1} 次拖拽没选中，重试`)
      await sleep(300)
    }
    console.log(`${th} 选区 ${JSON.stringify(info)}`)
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 300, y: geo.y - 60, width: 900, height: 160, scale: 2 }
    })
    const out = path.join(os.tmpdir(), `lumin-selection-${th}.png`)
    if (shot.result?.data) {
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
      console.log('saved ' + out)
    }
  }
  app.close()
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error('ERROR ' + (e && e.stack ? e.stack : e))
    process.exit(1)
  })
