// 验收：本地图片经 `lumin-file://` 加载 + 该协议的两道安全闸 + 本轮抽成方法的 UI 处理器
//
// 三块内容（都在同一个隔离实例里跑）：
//  ① **功能**：Markdown 里的相对图片（`![](img/pic.png)`）以前按「页面目录」解析、渲染不出来；
//     现在按「文档目录」解析成 lumin-file:// 绝对 URL，并且真的加载成功。
//  ② **安全**：协议只送媒体扩展名、且只送「工作区 / 已打开文档目录之内」的文件；
//     越界的（`notes.txt`、工作区外的 `secret.png`）必须 404。
//  ③ **回归**：本轮把模板里的内联多语句抽成了方法（prettier 会吃掉内联语句的分号，
//     Vue 模板编译器随即报错）。这里逐个点一遍，确认四个处理器仍然工作。
//
// 跑法：独立 userData 实例（不碰用户数据）：
//   $env:LUMIN_DEBUG_PORT='9222'
//   npx electron . --user-data-dir=$env:TEMP\lumin-media-ud
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1×1 透明 PNG（最小的合法 PNG，用来验证「真的能解码」）
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2wAAAABJRU5ErkJggg==',
  'base64'
)

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
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 260))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
  const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
  if (!pinia) return 'no-pinia'
  window.__M = {
    files: () => pinia._s.get('files'),
    ui: () => pinia._s.get('ui'),
    settings: () => pinia._s.get('settings'),
    app
  }
  return 'ok'
})()`

async function attach(page) {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await c.ev(SETUP).catch(() => 'err')) === 'ok') break
  }
  await c.ev(SETUP)
  return c
}

/** 用真实鼠标点击选择器命中的元素（可选：按文案过滤） */
async function click(w, selector, textFilter) {
  const pos = await w.ev(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = ${textFilter ? `els.find((e) => (e.textContent || '').includes(${JSON.stringify(textFilter)}))` : 'els[0]'}
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return JSON.stringify({ hidden: true })
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!pos) throw new Error('找不到元素: ' + selector + (textFilter ? ' / ' + textFilter : ''))
  const info = JSON.parse(pos)
  if (info.hidden) throw new Error('元素不可见: ' + selector)
  for (const [type, extra] of [
    ['mouseMoved', { button: 'none' }],
    ['mousePressed', { button: 'left', clickCount: 1 }],
    ['mouseReleased', { button: 'left', clickCount: 1 }]
  ]) {
    await w.send('Input.dispatchMouseEvent', { type, x: info.x, y: info.y, ...extra })
    await sleep(40)
  }
}

;(async () => {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // 夹具：工作区 + 图片 + 引用图片的文档；工作区**之外**再来一张图片（用来验证越界被拒）
  const WS = path.join(os.tmpdir(), 'lumin-media-ws')
  const OUT = path.join(os.tmpdir(), 'lumin-media-outside')
  for (const d of [path.join(WS, 'img'), OUT]) {
    fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d, { recursive: true })
  }
  fs.writeFileSync(path.join(WS, 'img', 'pic.png'), PNG_1PX)
  fs.writeFileSync(path.join(OUT, 'secret.png'), PNG_1PX)
  fs.writeFileSync(path.join(WS, 'notes.txt'), 'not media')
  const DOC = path.join(WS, 'doc.md')
  fs.writeFileSync(DOC, '# 图片\n\n![一张图](img/pic.png)\n', 'utf-8')

  const pages = (await get('/json/list')).filter(
    (t) => t.type === 'page' && /index\.html|5173/.test(t.url)
  )
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const w = await attach(pages[0])

  try {
    // ── ① 相对图片：按文档目录解析成 lumin-file:// 并真的加载成功 ──
    await w.ev(
      `(async () => { const f = window.__M.files(); await f.setRoot(${JSON.stringify(WS)}); await f.openPath(${JSON.stringify(DOC)}); return 'ok' })()`
    )
    await sleep(1500)
    const info = JSON.parse(
      await w.ev(`(async () => {
        const img = document.querySelector('.md-preview img[src]')
        if (!img) return JSON.stringify({ found: false })
        const loaded = await new Promise((res) => {
          if (img.complete && img.naturalWidth > 0) return res(true)
          const t = setTimeout(() => res(false), 3000)
          img.addEventListener('load', () => { clearTimeout(t); res(true) }, { once: true })
          img.addEventListener('error', () => { clearTimeout(t); res(false) }, { once: true })
        })
        return JSON.stringify({ found: true, src: img.getAttribute('src'), loaded, naturalWidth: img.naturalWidth })
      })()`)
    )
    console.log('IMG ' + JSON.stringify(info))
    c(
      '相对图片解析为 lumin-file://',
      info.found === true && String(info.src).startsWith('lumin-file://'),
      JSON.stringify(info)
    )
    c(
      '图片真的加载成功（协议送得出字节）',
      info.loaded === true && info.naturalWidth > 0,
      JSON.stringify(info)
    )
    // 回归：基准目录必须是**当前**文档的目录（这里曾因「先设 current 再算 currentDir」的
    // 顺序问题，第一帧渲染用的是上一个文档的目录）
    c(
      '图片基准目录 = 当前文档目录',
      String(info.src).includes(encodeURIComponent(WS.replace(/\\/g, '/').split('/').pop())),
      JSON.stringify({ src: info.src, WS })
    )

    // ── ② 安全闸：媒体白名单 + 位置白名单 ──
    // 用 <img> 探针而不是 fetch：渲染层 CSP 的 connect-src 是 'self'，fetch 到 lumin-file 会被
    // CSP 拦掉（那正是我们想要的收紧）；而 img-src 显式放行 lumin-file:，因此能否加载
    // 恰好反映了协议的真实行为（200 → loaded；404 → error）。
    const probeImage = (url) =>
      w.ev(`(async () => await new Promise((res) => {
        const img = new Image()
        const timer = setTimeout(() => res('timeout'), 3000)
        img.onload = () => { clearTimeout(timer); res('loaded') }
        img.onerror = () => { clearTimeout(timer); res('error') }
        img.src = ${JSON.stringify(url)}
      }))()`)
    const toUrl = (p) =>
      'lumin-file:///' +
      p
        .replace(/\\/g, '/')
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/')
    const okInside = await probeImage(toUrl(path.join(WS, 'img', 'pic.png')))
    const txtInside = await probeImage(toUrl(path.join(WS, 'notes.txt')))
    const outsideMedia = await probeImage(toUrl(path.join(OUT, 'secret.png')))
    console.log('PROBE ' + JSON.stringify({ okInside, txtInside, outsideMedia }))
    c('工作区内的图片：放行', okInside === 'loaded', String(okInside))
    c('工作区内的非媒体文件：拒绝（扩展名闸）', txtInside === 'error', String(txtInside))
    c('工作区外的图片：拒绝（位置闸）', outsideMedia === 'error', String(outsideMedia))

    // ── ③ 回归：本轮抽成方法的四个 UI 处理器 ──
    // 侧栏折叠：底部那一行（设置/关于/收起）本轮已删掉，鼠标入口换成顶部菜单
    // 「视图 → 显示侧边栏」（键盘 Ctrl+Shift+B 同源）。这里点真实菜单项，
    // 断言的行为不变：折起来之后 `ui.sidebarVisible` 变 false（并且会落库）。
    const $t = (k) => w.ev(`window.__M.app.config.globalProperties.$t(${JSON.stringify(k)})`)
    await click(w, '.topmenu-root > button', await $t('menu.view'))
    await sleep(300)
    await click(w, '.topmenu-drop button', await $t('menu.toggleSidebar'))
    await sleep(400)
    const collapsed = await w.ev(`window.__M.ui().sidebarVisible`)
    c('侧栏开关仍生效（视图菜单 → 显示侧边栏）', collapsed === false, String(collapsed))

    // 重新展开，方便后续步骤
    await w.ev(`(window.__M.ui().sidebarVisible = true, 'ok')`)
    await sleep(300)

    // 状态栏的「保存方式」弹层已整体删除（§4.81：保存状态那一格连同弹层一起去掉），
    // 于是原来那条「状态栏『打开设置…』仍生效」的断言**无处可点** —— 这里改成钉住删除本身，
    // 免得以后又长回一格。设置的其余入口仍在（菜单「帮助 → 设置」/ Ctrl+, / 工具栏齿轮）。
    const saveCellGone = await w.ev(`(() => {
      const bar = document.querySelector('[data-status-bar]')
      return JSON.stringify({
        saveCell: !!document.querySelector('[data-save-cell]'),
        barText: bar ? (bar.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : null
      })
    })()`)
    const saveCellState = (() => {
      try {
        return JSON.parse(saveCellGone)
      } catch {
        return { saveCell: null, barText: null }
      }
    })()
    c(
      '状态栏已无「保存状态」那一格（§4.81）',
      saveCellState.saveCell === false,
      String(saveCellGone)
    )
    await w.ev(`(window.__M.ui().closeSettings(), 'ok')`)
    await sleep(300)

    // 状态栏 `⋯` 菜单里的主题选择（pickTheme）：§4.83 起主题切换从那一行搬进了 `⋯`，
    // 判据不变 —— 点一项就真的换主题（并顺手复位成 auto）。
    const themePick = await w.ev(`(async () => {
      const s = window.__M.settings()
      const before = s.theme
      const more = document.querySelector('[data-status-more]')
      if (!more) return 'no-more-button'
      more.click()
      await new Promise((r) => setTimeout(r, 350))
      const target = before === 'sepia' ? 'dark' : 'sepia'
      const item = document.querySelector('[data-more-theme="' + target + '"]')
      if (!item) return 'no-theme-item'
      item.click()
      await new Promise((r) => setTimeout(r, 350))
      const after = s.theme
      s.setTheme('auto')
      return JSON.stringify({ before, target, after })
    })()`)
    let themeOk = false
    let themeInfo = String(themePick)
    try {
      const parsed = JSON.parse(themePick)
      themeOk = parsed.after === parsed.target && parsed.target !== parsed.before
      themeInfo = JSON.stringify(parsed)
    } catch {
      /* 非 JSON = 前面返回的状态串，直接当失败信息 */
    }
    c('主题选择仍生效（pickTheme）', themeOk, themeInfo)
    await sleep(300)

    // 分屏分隔条双击复位（resetSplitRatio）
    await w.ev(
      `(async () => { const ui = window.__M.ui(); ui.editorMode = 'split'; window.__M.settings().set('splitRatio', 0.8); return 'ok' })()`
    )
    await sleep(600)
    await w.ev(`(async () => { window.__M.settings().set('splitRatio', 0.8); return 'ok' })()`)
    await sleep(200)
    const divider = await w.ev(`(() => {
      const d = document.querySelector('.split-divider')
      if (!d) return null
      const r = d.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`)
    if (divider) {
      const { x, y } = JSON.parse(divider)
      for (const clickCount of [1, 2]) {
        for (const [type, extra] of [
          ['mousePressed', { button: 'left', clickCount }],
          ['mouseReleased', { button: 'left', clickCount }]
        ]) {
          await w.send('Input.dispatchMouseEvent', { type, x, y, ...extra })
          await sleep(30)
        }
      }
      await sleep(500)
      const ratio = await w.ev(`window.__M.settings().splitRatio`)
      c(
        '分屏分隔条双击复位（resetSplitRatio）',
        Math.abs(Number(ratio) - 0.5) < 0.01,
        String(ratio)
      )
    } else {
      console.log('SKIP: 未找到 .split-divider（界面结构变化时请同步本断言）')
    }
  } finally {
    await w
      .ev(
        `(async () => { const f = window.__M.files(); f.close(); await f.setRoot(null); return 'ok' })()`
      )
      .catch(() => {})
    await sleep(400)
    fs.rmSync(WS, { recursive: true, force: true })
    fs.rmSync(OUT, { recursive: true, force: true })
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
