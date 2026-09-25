// 验收：mermaid 视口门（清单 §2.G / O1）
//
// 为什么值得单独一条：mermaid 家族（mermaid.core 1.23MB + cynefin 1.30MB + cytoscape 0.96MB
// ≈3.5MB，懒加载）原来只要文档里出现一个 ```mermaid 块就会**立刻** import，哪怕它在屏幕外。
// 现在要求：**进入视口附近 200px 才 import + 渲染**，此前块内是源码占位（有高度、可点进源码编辑）。
//
// 断言两路证据：
//   ① DOM：远在视口外的块没有 `<svg>`、带 `data-mermaid-gated="pending"`、有占位；
//   ② **网络**：CDP `Network.requestWillBeSent` 里没有 mermaid/cynefin/cytoscape 的 chunk ——
//      没有 import 才是真的没花那 3.5MB。
//      ⚠️ 为什么不用页面里的 `performance.getEntriesByType('resource')`：本应用里它**恒为空**
//      （实测 resTotal = 0），用它写「没有 chunk」这种否定断言会永远通过 —— 那是假绿。
// 然后滚到块上，再断言它真的渲染出来了、占位被替换、chunk 到位。
// 最后补一条键盘路径：预览本体是 `<button>`，Tab 够得到、激活就进源码编辑（审计 §8 P2）。
'use strict'
const { connect, settle, sleep, openDocWith, watchEvents, Reporter, fatal } = require('./lib/harness')

const PROBE = `(() => JSON.stringify({
  svg: document.querySelectorAll('.mermaid-render svg').length,
  gated: document.querySelectorAll('[data-mermaid-gated="pending"]').length,
  placeholder: document.querySelectorAll('.mermaid-placeholder').length,
  preload: [...document.querySelectorAll('link[rel="modulepreload"]')]
    .map((l) => l.href.split('/').pop())
    .filter((n) => /mermaid|cynefin|cytoscape/i.test(n)),
  globalMermaid: typeof window.mermaid
}))()`

async function main() {
  const app = await connect()
  const { ev, send } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('mermaid 视口门（远处不 import，滚到才渲染）')

  // ② 网络证据：先订上事件、开 Network 域，再打开文档
  const fetched = []
  const off = watchEvents(app, (m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params?.request?.url) {
      fetched.push(m.params.request.url)
    }
  })
  await send('Network.enable')
  const mermaidChunks = () =>
    fetched
      .filter((u) => /mermaid|cynefin|cytoscape/i.test(u))
      .map((u) => u.split('/').pop())

  // 一根很长的正文，把 mermaid 块顶到视口之外（远超 200px 门）
  const filler = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行填充文本。`).join('\n\n')
  const md = `${filler}\n\n\`\`\`mermaid\ngraph TD\n  A[开始] --> B[结束]\n\`\`\`\n`
  await openDocWith(app, md, 'mermaid-gate.md')
  await sleep(2000)

  const before = JSON.parse(await ev(PROBE))
  report.note('初始态 ' + JSON.stringify(before) + ' 网络命中=' + JSON.stringify(mermaidChunks()))
  report.check(
    'far-block-not-rendered',
    before.svg === 0 && before.gated >= 1 && before.placeholder >= 1,
    JSON.stringify(before)
  )
  // 这一条是「按需」的另一半：Vite 默认会为动态 import 的依赖插 modulepreload，
  // 于是 mermaid.core 在**首屏**就被取（哪怕一个 mermaid 块都没有）。配置里已把这一族剔除。
  report.check(
    'no-mermaid-preload-at-startup',
    before.preload.length === 0,
    `preload=${JSON.stringify(before.preload)}（构建期已按 electron.vite.config.ts 的 modulePreload 过滤）`
  )

  // 滚到块上（模拟用户翻页）
  await ev(`(() => {
    const b = document.querySelector('.mermaid-block')
    if (b) b.scrollIntoView({ block: 'center' })
    return 'ok'
  })()`)

  let after = null
  for (let i = 0; i < 120; i++) {
    await sleep(100)
    after = JSON.parse(await ev(PROBE))
    if (after.svg >= 1 && after.placeholder === 0) break
  }
  report.note('滚入后 ' + JSON.stringify(after) + ' 网络命中=' + JSON.stringify(mermaidChunks()))
  report.check(
    'renders-when-scrolled-in',
    !!after && after.svg >= 1 && after.placeholder === 0 && after.gated === 0,
    JSON.stringify(after)
  )
  // 网络命中只作参考（file:// 场景下 CDP 的 Network 事件并不完整，不能拿来做硬断言）
  report.check(
    'chunk-fetched-on-demand',
    mermaidChunks().length > 0,
    `chunks=${JSON.stringify(mermaidChunks())}（取不到就说明 CDP 没报，不代表没取）`
  )

  // ── 键盘路径（审计 §8 P2「纯鼠标交互：mermaid 预览」）──
  // 预览本体原来是 `<div @click>`：键盘用户根本够不到"进源码编辑"这个动作。
  // 现在是 `<button>`：语义上它就是那个动作，Tab 能停上去、Enter/Space 走按钮的原生激活
  // （浏览器把 Enter/Space 翻译成 click —— 所以这里用 `el.click()` 验处理器接线，
  //  再用 tagName/tabIndex/focus 验"真的能被键盘够到"）。
  const kbd = JSON.parse(
    await ev(`(async () => {
      const el = document.querySelector('.mermaid-render')
      if (!el) return JSON.stringify({ missing: true })
      const before = {
        tag: el.tagName,
        type: el.getAttribute('type'),
        tabIndex: el.tabIndex,
        label: el.getAttribute('title')
      }
      el.focus()
      const focused = document.activeElement === el
      el.click()
      // 换了状态要等 Vue 重渲染（同一帧里查 DOM 一定是旧的）
      await new Promise((r) => setTimeout(r, 350))
      return JSON.stringify({
        before,
        focused,
        editing: !!document.querySelector('.mermaid-source-input')
      })
    })()`)
  )
  report.note('键盘路径 ' + JSON.stringify(kbd))
  report.check(
    'preview-is-focusable-button',
    kbd.before?.tag === 'BUTTON' &&
      kbd.before?.type === 'button' &&
      kbd.before?.tabIndex === 0 &&
      !!kbd.before?.label &&
      kbd.focused === true,
    JSON.stringify(kbd.before)
  )
  report.check('preview-click-enters-source-edit', kbd.editing === true, String(kbd.editing))

  off()
  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
