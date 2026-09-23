// 验收：工具栏与底部状态栏不再显示文件名（文件名只在窗口标题/任务栏里）
//
// 跑法：可跑在用户实例上（会在临时目录建夹具并在结束时删掉），或跑在
// --user-data-dir 起的隔离实例上（见 §4.23 的用法）。
//
// 断言：① 两条栏里都不出现当前文件名；② 打开文档后工具栏按钮、状态栏的
// 「已保存」态、字数/行数/字符数、光标位置、主题/语言入口都还在；
// ③ 窗口标题仍显示文件名；④ 两条栏里的 title 提示不再残留文件名。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => res(JSON.parse(d)))
    }).on('error', rej)
  })
}

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
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
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = app._context.provides[sym]
  window.__B = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
  return 'ok'
})()`

/** 用与既有套件一致的方式定位两条栏（root class 带 h-11/h-7 + border-b/t） */
const PROBE = `(() => {
  const divs = [...document.querySelectorAll('div')]
  const cls = (d) => d.className?.toString?.() || ''
  const toolbar = divs.find((d) => cls(d).includes('h-11 shrink-0') && cls(d).includes('border-b'))
  const status = divs.find((d) => cls(d).includes('h-7 shrink-0') && cls(d).includes('border-t'))
  const name = window.__B.files().current?.name ?? null
  const inBar = (bar) => {
    if (!bar) return null
    const txt = bar.innerText || ''
    return {
      hasName: !!name && txt.includes(name),
      text: txt.replace(/\\s+/g, ' ').trim().slice(0, 160),
      buttons: bar.querySelectorAll('button').length
    }
  }
  return JSON.stringify({
    name,
    windowTitle: document.title,
    toolbarFound: !!toolbar,
    statusFound: !!status,
    toolbar: inBar(toolbar),
    status: inBar(status),
    statusKeeps: status
      ? (() => {
          const saveBtn = [...status.querySelectorAll('button')].find((b) =>
            /已保存|未保存|保存中|Saved|Unsaved|Saving/.test(b.textContent || '')
          )
          const saveSpan = saveBtn ? saveBtn.querySelector('span') : null
          return {
            saveLabel: /已保存|未保存|Saved|Unsaved/.test(status.innerText || ''),
            counts: /\\d+/.test(status.innerText || ''),
            hasSwitchers: !!status.querySelector('button[title]'),
            // 本轮新增：那格只说「状态」不说「保存方式」，且不带圆点、不用强调色
            saveText: saveBtn ? (saveBtn.textContent || '').trim() : null,
            saveDot: saveBtn ? !!saveBtn.querySelector('.rounded-full') : null,
            saveColor: saveSpan ? getComputedStyle(saveSpan).color : null,
            // 参照色取状态栏自身的默认字色（--ink-3）：保存状态文字应当与它**完全一致**，
            // 而不是 --ok / --warning 那两档强调色
            statColor: getComputedStyle(status).color
          }
        })()
      : null,
    staleTitles: divs
      .filter((d) => cls(d).includes('h-11 shrink-0') || cls(d).includes('h-7 shrink-0'))
      .flatMap((bar) => [...bar.querySelectorAll('[title]')].map((el) => el.getAttribute('title') || ''))
      .filter((t) => name && t.includes(name))
  })
})()`

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const WS = path.join(os.tmpdir(), 'lumin-bars-ws')
  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  const DOC = path.join(WS, 'visible-name-check.md')
  fs.writeFileSync(DOC, '# title\n\nsome text here\n', 'utf-8')

  const pages = (await get('/json/list')).filter((t) => t.type === 'page')
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  await w.ev(SETUP)
  // 快捷工具栏出厂默认收起（清单 §1.E 选项②），本套件要断言「工具栏里不出现文件名」⇒ 显式打开
  await w.ev(`(() => { window.__B.settings().set('toolbarVisible', true); return 'ok' })()`)
  await sleep(300)

  try {
    // ① 没有文档时
    await w.ev(`(async () => { window.__B.files().close(); await window.__B.files().setRoot(null); return 'ok' })()`)
    await sleep(800)
    const noDoc = JSON.parse(await w.ev(PROBE))
    console.log('NO-DOC ' + JSON.stringify(noDoc))
    c('toolbar-found', noDoc.toolbarFound === true, String(noDoc.toolbarFound))
    c('statusbar-found', noDoc.statusFound === true, String(noDoc.statusFound))
    c('no-doc-statusbar-keeps-placeholder', /Lumin/.test(noDoc.status?.text || ''), JSON.stringify(noDoc.status?.text))

    // ② 打开一个文件名很显眼的文档
    await w.ev(
      `(async () => { window.__B.files().setRoot(${JSON.stringify(WS)}); await window.__B.files().openPath(${JSON.stringify(DOC)}); return 'ok' })()`
    )
    await sleep(1200)
    const withDoc = JSON.parse(await w.ev(PROBE))
    console.log('WITH-DOC ' + JSON.stringify(withDoc))
    c('doc-open', withDoc.name === 'visible-name-check.md', JSON.stringify(withDoc.name))
    c('toolbar-has-no-filename', withDoc.toolbar?.hasName === false, JSON.stringify(withDoc.toolbar?.text))
    c('statusbar-has-no-filename', withDoc.status?.hasName === false, JSON.stringify(withDoc.status?.text))
    c('window-title-still-shows-filename', withDoc.windowTitle === 'visible-name-check.md - Lumin', JSON.stringify(withDoc.windowTitle))
    c('toolbar-still-has-buttons', (withDoc.toolbar?.buttons || 0) >= 8, 'buttons=' + withDoc.toolbar?.buttons)
    c('statusbar-keeps-save-state', withDoc.statusKeeps?.saveLabel === true, JSON.stringify(withDoc.statusKeeps))
  // 本轮：那格**只说状态、不说保存方式**（手动模式下不再一直写着「手动保存」）
  c(
    'statusbar-save-cell-shows-state-not-mode',
    !!withDoc.statusKeeps?.saveText &&
      /已保存|未保存|保存中|Saved|Unsaved|Saving/.test(withDoc.statusKeeps.saveText) &&
      !/手动保存|Manual/.test(withDoc.statusKeeps.saveText),
    JSON.stringify(withDoc.statusKeeps?.saveText)
  )
  c('statusbar-save-cell-has-no-dot', withDoc.statusKeeps?.saveDot === false, JSON.stringify(withDoc.statusKeeps?.saveDot))
  c(
    'statusbar-save-cell-is-same-gray',
    !!withDoc.statusKeeps?.saveColor &&
      withDoc.statusKeeps.saveColor === withDoc.statusKeeps.statColor,
    JSON.stringify({ save: withDoc.statusKeeps?.saveColor, stat: withDoc.statusKeeps?.statColor })
  )
  // 启动遮罩（骨架屏）**不再有过场动画**（用户口径：取消打开应用时的遮罩过场动画）：
  // 切到 booting 时它立刻出现且不带任何 `*-enter-active`；切回就绪时**立刻**从 DOM 消失 ——
  // 有 fade 时它会多留 ~200ms，这条就是用来钉住「没有那 200ms」的。
  const mask = JSON.parse(
    await w.ev(`(async () => {
      const ui = window.__B.ui()
      const pick = () => [...document.querySelectorAll('div')].find((d) => (d.className || '').toString().includes('fixed inset-0'))
      ui.booting = true
      await new Promise((r) => setTimeout(r, 80))
      const el = pick()
      const enterClass = el ? [...el.classList].filter((c) => c.includes('enter')) : []
      const dur = el ? getComputedStyle(el).transitionDuration : null
      ui.booting = false
      await new Promise((r) => setTimeout(r, 60))
      return JSON.stringify({
        appeared: !!el,
        enterClass,
        transitionDuration: dur,
        goneAfter60ms: !pick()
      })
    })()`)
  )
  c(
    'boot-mask-has-no-transition',
    mask.appeared === true && mask.enterClass.length === 0 && mask.goneAfter60ms === true,
    JSON.stringify(mask)
  )
    c('statusbar-keeps-counts', withDoc.statusKeeps?.counts === true, JSON.stringify(withDoc.status?.text))
    c('statusbar-keeps-theme-and-language', withDoc.statusKeeps?.hasSwitchers === true, JSON.stringify(withDoc.statusKeeps))
    c('no-filename-in-bar-tooltips', withDoc.staleTitles.length === 0, JSON.stringify(withDoc.staleTitles))
  } finally {
    await w.ev(`(async () => { window.__B.files().close(); return 'ok' })()`).catch(() => {})
    fs.rmSync(WS, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
