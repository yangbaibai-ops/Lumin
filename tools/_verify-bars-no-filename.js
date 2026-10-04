// 验收：工具栏与底部状态栏不再显示文件名（文件名只在窗口标题/任务栏里）
//
// 跑法：可跑在用户实例上（会在临时目录建夹具并在结束时删掉），或跑在
// --user-data-dir 起的隔离实例上（见 §4.23 的用法）。
//
// 断言：① 两条栏里都不出现当前文件名；② 打开文档后工具栏按钮、字数/行数/字符数、
// 光标位置都还在；③ 窗口标题仍显示文件名；④ 两条栏里的 title 提示不再残留文件名；
// ⑤ §4.81/§4.82：状态栏**没有保存状态那一格**、没有顶部分隔线，
//    且与菜单栏 / 快捷工具栏 / 编辑区**同为纸色**（"一张纸到底"）；
// ⑥ §4.83：这一行重排为「左=文档（统计/目标/标签）｜右=视图与入口（行列/编码/行尾 + ⋯）」——
//    版本号、阅读时长不在这一行里，标签格只在有标签时出现，右上那个 ⋯ 里装着
//    主题 / 语言 / 加标签 / 设置 / 关于（低频入口的唯一出口）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
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
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails)
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200))
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

/** 用稳定锚点定位两条栏（工具栏：data-editor-toolbar；状态栏：data-status-bar）。
 *  ⚠️ §4.81 起状态栏**不再是 `h-7 + border-t` 那条带子**（用户口径：底色透明、去掉顶部分隔线），
 *  所以旧写的"按 class 嗅探"必然找不到它 —— 改成组件给的 data 锚点（与 data-save-cell 同一套做法）。 */
const PROBE = `(() => {
  const divs = [...document.querySelectorAll('div')]
  const cls = (d) => d.className?.toString?.() || ''
  const toolbar = document.querySelector('[data-editor-toolbar]')
  const status = document.querySelector('[data-status-bar]')
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
    // 三条栏的底色（§4.82：顶部菜单栏与快捷工具栏要和编辑区**同色**）：
    // 判据是"等于 --paper 的解析值"，而不是写死 #fff —— 深色 / 羊皮纸主题各自跟随纸色。
    // ⚠️ 这段在模板字符串里，注释中**不能出现反引号**（会提前结束模板串）。
    paints: (() => {
      const tok = (name) => {
        const p = document.createElement('span')
        p.style.color = 'var(' + name + ')'
        document.body.appendChild(p)
        const c = getComputedStyle(p).color
        p.remove()
        return c
      }
      const menu = document.querySelector('.topmenu-root')
      return {
        menu: menu ? getComputedStyle(menu).backgroundColor : null,
        toolbar: toolbar ? getComputedStyle(toolbar).backgroundColor : null,
        paperToken: tok('--paper'),
        appToken: tok('--app')
      }
    })(),
    statusBar: status
      ? {
          // 底色口径（§4.82）：整条与编辑区同色（纸）
          bg: getComputedStyle(status).backgroundColor,
          borderTop: getComputedStyle(status).borderTopWidth,
          saveCell: !!status.querySelector('[data-save-cell]'),
          // §4.81：整条里不该再出现任何"保存状态"字样（中英都查）
          saveText: /已保存|未保存|保存中|Saved|Unsaved|Saving/.test(status.innerText || ''),
          counts: /\\d+/.test(status.innerText || ''),
          // §4.83：标签格只在**有标签**时出现；右侧那个 ⋯ 是低频入口的唯一出口
          // （模板字符串里不能出现反引号，所以这里不写那个符号）
          tagCell: !!status.querySelector('[data-status-tags]'),
          moreButton: !!status.querySelector('[data-status-more]'),
          // 阅读时长 / 版本号都从这一行拿掉了（用户口径）
          readingTime: !!status.querySelector('[data-status-reading-time]'),
          bodyText: (status.innerText || '').replace(/\\s+/g, ' ').trim(),
          versionLike: /v\\d+\\.\\d+\\.\\d+/.test(status.innerText || '')
        }
      : null,
    staleTitles: [...document.querySelectorAll('[data-editor-toolbar], [data-status-bar]')].flatMap(
      (bar) => [...bar.querySelectorAll('[title]')].map((el) => el.getAttribute('title') || '')
    ).filter((t) => name && t.includes(name))
  })
})()`

;(async () => {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

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
    await w.ev(
      `(async () => { window.__B.files().close(); await window.__B.files().setRoot(null); return 'ok' })()`
    )
    await sleep(800)
    const noDoc = JSON.parse(await w.ev(PROBE))
    console.log('NO-DOC ' + JSON.stringify(noDoc))
    c('toolbar-found', noDoc.toolbarFound === true, String(noDoc.toolbarFound))
    c('statusbar-found', noDoc.statusFound === true, String(noDoc.statusFound))
    c(
      'no-doc-statusbar-keeps-placeholder',
      /Lumin/.test(noDoc.status?.text || ''),
      JSON.stringify(noDoc.status?.text)
    )

    // ② 打开一个文件名很显眼的文档
    await w.ev(
      `(async () => { window.__B.files().setRoot(${JSON.stringify(WS)}); await window.__B.files().openPath(${JSON.stringify(DOC)}); return 'ok' })()`
    )
    await sleep(1200)
    const withDoc = JSON.parse(await w.ev(PROBE))
    console.log('WITH-DOC ' + JSON.stringify(withDoc))
    c('doc-open', withDoc.name === 'visible-name-check.md', JSON.stringify(withDoc.name))
    c(
      'toolbar-has-no-filename',
      withDoc.toolbar?.hasName === false,
      JSON.stringify(withDoc.toolbar?.text)
    )
    c(
      'statusbar-has-no-filename',
      withDoc.status?.hasName === false,
      JSON.stringify(withDoc.status?.text)
    )
    c(
      'window-title-still-shows-filename',
      withDoc.windowTitle === 'visible-name-check.md - Lumin',
      JSON.stringify(withDoc.windowTitle)
    )
    c(
      'toolbar-still-has-buttons',
      (withDoc.toolbar?.buttons || 0) >= 8,
      'buttons=' + withDoc.toolbar?.buttons
    )
    // ── §4.82：顶部菜单栏与快捷工具栏的底色 = **纸**（与编辑区同色）──
    c(
      'menu-bar-follows-paper',
      !!withDoc.paints?.menu && withDoc.paints.menu === withDoc.paints.paperToken,
      JSON.stringify({ menu: withDoc.paints?.menu, paper: withDoc.paints?.paperToken })
    )
    c(
      'editor-toolbar-follows-paper',
      !!withDoc.paints?.toolbar && withDoc.paints.toolbar === withDoc.paints.paperToken,
      JSON.stringify({ toolbar: withDoc.paints?.toolbar, paper: withDoc.paints?.paperToken })
    )
    c(
      'bars-differ-from-chrome-in-this-theme',
      withDoc.paints?.paperToken !== withDoc.paints?.appToken,
      `paper=${withDoc.paints?.paperToken} app=${withDoc.paints?.appToken}（两者相同的话上面两条就没验到东西）`
    )
    // ── §4.81：状态栏不再有「保存状态」那一格（不论自动还是手动都不显示）+ 整条透明 ──
    c(
      'statusbar-has-no-save-state',
      withDoc.statusBar?.saveCell === false && withDoc.statusBar?.saveText === false,
      JSON.stringify({
        saveCell: withDoc.statusBar?.saveCell,
        hasSaveText: withDoc.statusBar?.saveText
      })
    )
    c(
      'statusbar-follows-paper',
      !!withDoc.statusBar?.bg && withDoc.statusBar.bg === withDoc.paints?.paperToken,
      `底栏=${withDoc.statusBar?.bg} / --paper=${withDoc.paints?.paperToken}（"一张纸到底"：底栏与编辑区同色）`
    )
    c(
      'statusbar-has-no-top-border',
      withDoc.statusBar?.borderTop === '0px',
      `border-top = ${withDoc.statusBar?.borderTop}（这一行是信息，不该再被画成一条带子）`
    )
    // 启动遮罩（骨架屏）**已整体移除**（用户口径：取消打开应用时的进场动画 + 去掉骨架图）：
    // 初始化期间看到的就是正常界面，DOM 里不该再有骨架块或那层不透明遮罩。
    const mask = JSON.parse(
      await w.ev(`(() => JSON.stringify({
      skeleton: document.querySelectorAll('.skeleton').length,
      cover: [...document.querySelectorAll('div')].filter((d) => (d.className || '').toString().includes('fixed inset-0')).length
    }))()`)
    )
    c('boot-mask-removed', mask.skeleton === 0 && mask.cover === 0, JSON.stringify(mask))
    c(
      'statusbar-keeps-counts',
      withDoc.statusBar?.counts === true,
      JSON.stringify(withDoc.status?.text)
    )
    c(
      'no-filename-in-bar-tooltips',
      withDoc.staleTitles.length === 0,
      JSON.stringify(withDoc.staleTitles)
    )

    // ── §4.83：这一行只留"会变化的状态"，其余收进右侧 `⋯` ──────────────────────
    c(
      'statusbar-has-more-entry',
      withDoc.statusBar?.moreButton === true,
      JSON.stringify({ moreButton: withDoc.statusBar?.moreButton })
    )
    c(
      'statusbar-has-no-reading-time',
      withDoc.statusBar?.readingTime === false &&
        !/(分钟|小时|min read|мин чтения)/.test(withDoc.statusBar?.bodyText || ''),
      JSON.stringify(withDoc.statusBar?.bodyText)
    )
    c(
      'statusbar-has-no-version',
      withDoc.statusBar?.versionLike === false,
      `整条文字 = ${JSON.stringify(withDoc.statusBar?.bodyText)}（版本号只在「关于」里）`
    )
    c(
      'statusbar-hides-tag-cell-when-no-tags',
      withDoc.statusBar?.tagCell === false,
      '这一篇没有标签 ⇒ 标签格不该出现（有标签才显示，见 §4.83）'
    )
    // `⋯` 菜单 = 低频入口的唯一出口：主题 / 语言 / 加标签 / 设置 / 关于 都要在里面
    const moreMenu = JSON.parse(
      await w.ev(`(async () => {
        const btn = document.querySelector('[data-status-more]')
        if (!btn) return JSON.stringify({ err: 'no-more-button' })
        btn.click()
        await new Promise((r) => setTimeout(r, 350))
        const box = document.querySelector('[data-status-more-menu]')
        if (!box) return JSON.stringify({ err: 'no-menu' })
        const q = (s) => box.querySelectorAll(s).length
        return JSON.stringify({
          themes: q('[data-more-theme]'),
          languages: q('[data-more-language]'),
          editTags: !!box.querySelector('[data-more-edit-tags]'),
          settings: !!box.querySelector('[data-more-settings]'),
          about: !!box.querySelector('[data-more-about]'),
          text: (box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
        })
      })()`)
    )
    c(
      'more-menu-holds-low-frequency-entries',
      moreMenu.themes === 4 &&
        moreMenu.languages === 3 &&
        moreMenu.editTags === true &&
        moreMenu.settings === true &&
        moreMenu.about === true,
      JSON.stringify(moreMenu)
    )
    await w.ev(
      `(document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), 'ok')`
    )
    await sleep(250)

    // ── 目标字数仍在这一行的左半边（审计清单「目标字数 / 阅读时长」只剩前半截）──
    await w.ev(`(() => { window.__B.settings().set('wordGoal', 100); return 'ok' })()`)
    await sleep(400)
    const goalOn = JSON.parse(
      await w.ev(`(() => {
        const el = document.querySelector('[data-status-word-goal]')
        return JSON.stringify({
          found: !!el,
          text: el ? el.textContent.trim() : null,
          title: el ? el.getAttribute('title') : null,
          reached: el ? el.getAttribute('data-word-goal-reached') : null
        })
      })()`)
    )
    console.log('WORD-GOAL ' + JSON.stringify(goalOn))
    c('word-goal-cell-appears-when-set', goalOn.found === true, JSON.stringify(goalOn))
    c(
      'word-goal-cell-shows-current-over-goal',
      !!goalOn.text && goalOn.text.includes('100') && /\d/.test(goalOn.text),
      JSON.stringify(goalOn.text)
    )
    // 达成态：把目标压到 1 个字 → 当前文档非空，必然达成（属性由 store 的 goal 计算驱动）
    await w.ev(`(() => { window.__B.settings().set('wordGoal', 1); return 'ok' })()`)
    await sleep(400)
    const goalReached = JSON.parse(
      await w.ev(`(() => {
        const el = document.querySelector('[data-status-word-goal]')
        return JSON.stringify({ reached: el ? el.getAttribute('data-word-goal-reached') : null })
      })()`)
    )
    c('word-goal-marks-reached-state', goalReached.reached === '1', JSON.stringify(goalReached))
    // 复位：目标 0 = 不设目标 → 那一格必须消失（不能留一个 0/0 的噪声格）
    await w.ev(`(() => { window.__B.settings().set('wordGoal', 0); return 'ok' })()`)
    await sleep(400)
    const goalOff = JSON.parse(
      await w.ev(`JSON.stringify({ found: !!document.querySelector('[data-status-word-goal]') })`)
    )
    c('word-goal-cell-hidden-when-zero', goalOff.found === false, JSON.stringify(goalOff))
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
