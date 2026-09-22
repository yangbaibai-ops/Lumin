'use strict'
// 验收：远程图片的隐私闸门（自查报告 H2）
//
// 判据（都要真的在页面里量出来）：
//   1. 默认策略 click：浏览时**不存在** `img[src^="https://"]`（没有 src 属性就不发请求），
//      取而代之的是 `.img-guard[data-src=…]` 占位；
//   2. 点击占位 → 就地换成真 `<img>`，且该 URL 之后的渲染不再被挡；
//   3. `editor.getHTML()`（导出/复制走这条路）**始终**给真实 src —— 否则导出的文档里图片全丢；
//   4. 策略改成 always 后，重新渲染直接出真图。
//
// 跑法：node tools/run-suites.js --suite=_verify-remote-image.js
const { connect, settle, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')

const REMOTE = 'https://example.com/pixel.png'
const MD = `# 远程图片\n\n正文一张图：![远程](${REMOTE})\n`

/** 页面里的几何/状态快照 */
const PROBE = `JSON.stringify((() => {
  const imgs = [...document.querySelectorAll('.md-preview img')].map((i) => i.getAttribute('src'))
  const guards = [...document.querySelectorAll('.md-preview .img-guard')].map((g) => g.getAttribute('data-src'))
  const ed = window.__L.ed()
  return {
    imgSrcs: imgs,
    guards,
    remoteImgs: imgs.filter((s) => /^https?:\\/\\//.test(s || '')),
    html: ed ? ed.getHTML() : '',
    policy: window.__L.settings().remoteImages
  }
})())`

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const report = new Reporter('远程图片隐私闸门')
  const { ev } = app

  await ev(`(async () => { await window.__L.settings().set('remoteImages', 'click'); return 'ok' })()`)
  await openDocWith(app, MD, 'remote.md')
  await sleep(1200)

  const a = JSON.parse(await ev(PROBE))
  report.check('默认不加载远程图（DOM 里没有 http(s) 的 img）', a.remoteImgs.length === 0, JSON.stringify(a.imgSrcs))
  report.check('渲染成占位并带上 data-src', a.guards.includes(REMOTE), JSON.stringify(a.guards))
  report.check('导出/复制用的 getHTML() 仍是真实 src', a.html.includes(REMOTE), a.html.slice(0, 80))

  // ── 点击占位 → 就地把占位换成真图 ──
  const box = JSON.parse(
    await ev(
      `JSON.stringify((() => { const g = document.querySelector('.md-preview .img-guard'); if (!g) return null; const r = g.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })())`
    )
  )
  report.check('占位可点（量到了矩形）', !!box, JSON.stringify(box))
  if (box) {
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
    await sleep(60)
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(40)
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(400)
  }
  const b = JSON.parse(await ev(PROBE))
  report.check('点击后出现真 img[src=该 URL]', b.remoteImgs.includes(REMOTE), JSON.stringify(b.imgSrcs))
  report.check('点击后占位消失', !b.guards.includes(REMOTE), JSON.stringify(b.guards))

  // ── 策略 always：重新渲染直接出真图 ──
  await ev(`(async () => { await window.__L.settings().set('remoteImages', 'always'); return 'ok' })()`)
  await sleep(300)
  await ev(`(() => { const ed = window.__L.ed(); const md = ed.storage.markdown.getMarkdown(); ed.commands.setContent('<p>x</p>'); ed.commands.setContent(md); return 'ok' })()`)
  await sleep(1200)
  const c = JSON.parse(await ev(PROBE))
  report.check('always 策略：渲染即出真图', c.policy === 'always' && c.remoteImgs.includes(REMOTE), JSON.stringify({ policy: c.policy, imgs: c.imgSrcs }))

  // 复原默认值，别把隔离实例的状态留给下一个套件
  await ev(`(async () => { await window.__L.settings().set('remoteImages', 'click'); return 'ok' })()`)

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
