// tools/verify-tiptap.js — Tiptap 内核验收矩阵
// 用法：node tools/verify-tiptap.js （需要 npm run dev + LUMIN_DEBUG_PORT=9222）
// 建议由 tools/run-verify.ps1 包裹执行：先置前台窗口再跑本脚本。
// 输出每项 PASS/FAIL，最后打印汇总；任何一项失败 → exit 1
const CDP = 'http://127.0.0.1:9222/json'
const TEST_DIR = 'D:/code_workspace/Lumin-test-workspace'
const TEST_PATH = TEST_DIR + '/tipverify.md'
const USER_WS = 'C:/Users/yangbaibai/Desktop/新建文件夹'

const TEST_MD = [
  '# 验收标题',
  '',
  '正文段落 **加粗** 与 *斜体* 与 `行内代码`。',
  '',
  '## 列表示例',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '> 引用段落',
  '',
  '```js',
  "console.log('hello')",
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A-->B',
  '```',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '- [x] 已完成任务',
  '- [ ] 待办任务',
  ''
].join('\n')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const logErrors = []
let ws = null
let msgId = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((res) => {
    const i = ++msgId
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
}

async function ev(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails) {
    const desc =
      r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text
    throw new Error('页面求值异常: ' + desc)
  }
  return r.result?.result?.value
}

async function typeText(text) {
  await send('Input.insertText', { text })
}

async function keyPress(key, code, vk, text = undefined) {
  const down = { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }
  if (text !== undefined) down.text = text
  await send('Input.dispatchKeyEvent', down)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
}

async function clickEl(selector, offsetX = 0) {
  const rect = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: b.left + b.width / 2 + ${offsetX}, y: b.top + b.height / 2 }
  })()`)
  if (!rect || !rect.x) throw new Error('元素不存在: ' + selector)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1
    })
  }
  return true
}

function record(phase, out) {
  if (!Array.isArray(out)) {
    results.push({ phase, name: 'evaluate-result', pass: false, detail: String(out) })
    console.log('FAIL [' + phase + '] evaluate-result — ' + String(out))
    return
  }
  for (const item of out) {
    const pass = !!item.p
    results.push({ phase, name: item.n, pass, detail: item.d ?? '' })
    console.log(`${pass ? 'PASS' : 'FAIL'} [${phase}] ${item.n}${item.d ? ' — ' + item.d : ''}`)
  }
}

async function phase(name, fn) {
  try {
    await fn()
  } catch (e) {
    results.push({ phase: name, name: 'exception', pass: false, detail: e.message })
    console.log(`FAIL [${name}] exception — ${e.message}`)
  }
}

// 页面可能在启动阶段被 vite 客户端全量刷新一次，桥接对象会被清掉；
// 每个阶段开始前确保 window.__vt 存在
async function ensureBridge() {
  return ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    if (!pinia || !(pinia._s instanceof Map)) return 'NO_PINIA'
    window.__vt = {
      pinia,
      files: () => pinia._s.get('files'),
      ui: () => pinia._s.get('ui'),
      settings: () => pinia._s.get('settings'),
      ed: () => pinia._s.get('editor')?.instance ?? null
    }
    return 'OK'
  })()`)
}

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('NO_PAGE_TARGET')
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
    } else if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      logErrors.push(m.params.entry.text)
    }
  }
  await send('Log.enable')
  await send('Page.enable')
  await send('Page.bringToFront')

  // ── 0. 前台可见性（需 tools/run-verify.ps1 先置前台）──
  let visible = false
  for (let i = 0; i < 12; i++) {
    if ((await ev('document.visibilityState')) === 'visible') {
      visible = true
      break
    }
    await sleep(300)
  }
  if (!visible) {
    console.log('FAIL [setup] window-visible — 窗口不可见，请用 tools/run-verify.ps1 启动')
    process.exit(2)
  }
  console.log('PASS [setup] window-visible')
  results.push({ phase: 'setup', name: 'window-visible', pass: true })

  // ── 1. 页面内桥接 ──
  const boot = await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    if (!pinia || !(pinia._s instanceof Map)) return 'NO_PINIA'
    window.__vt = {
      pinia,
      files: () => pinia._s.get('files'),
      ui: () => pinia._s.get('ui'),
      settings: () => pinia._s.get('settings'),
      ed: () => pinia._s.get('editor')?.instance ?? null
    }
    return 'OK'
  })()`)
  const bootOk = boot === 'OK'
  results.push({ phase: 'setup', name: 'pinia-bridge', pass: bootOk, detail: boot })
  console.log(`${bootOk ? 'PASS' : 'FAIL'} [setup] pinia-bridge — ${boot}`)
  if (!bootOk) process.exit(2)

  // 切到测试工作区并写入验收文件
  await ev(`window.luminAPI.workspace.setRoot(${JSON.stringify(TEST_DIR)}).then(() => 'ok')`)
  await ev(
    `window.luminAPI.file.write(${JSON.stringify(TEST_PATH)}, ${JSON.stringify(TEST_MD)}).then(() => 'ok')`
  )

  // 确保处于编辑器路由（应用可能启动在欢迎页）
  await ev(`(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(1200)

  // ═══ A. 打开文件 → WYSIWYG 渲染 ═══
  await phase('A', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    const out = await ev(`(async () => {
      const out = []
      const files = window.__vt.files()
      await files.openPath(${JSON.stringify(TEST_PATH)})
      await new Promise((r) => setTimeout(r, 1000))
      const pm = document.querySelector('.ProseMirror')
      const ed = window.__vt.ed()
      const h1 = pm?.querySelector('h1')
      const h2 = pm?.querySelector('h2')
      const strong = pm?.querySelector('strong')
      const em = pm?.querySelector('em')
      const icode = pm?.querySelector('p code')
      const bq = pm?.querySelector('blockquote')
      const uls = pm ? [...pm.querySelectorAll('ul')] : []
      const ols = pm ? [...pm.querySelectorAll('ol')] : []
      const boxes = pm ? [...pm.querySelectorAll('input[type="checkbox"]')] : []
      const table = pm?.querySelector('table')
      const cm = document.querySelector('.cm-content')
      let mmd = false
      for (let i = 0; i < 30; i++) {
        if (document.querySelector('.mermaid-render svg')) { mmd = true; break }
        await new Promise((r) => setTimeout(r, 100))
      }
      const text = pm?.innerText ?? ''
      const raw = ['**', '\`\`\`', '| ---', '- [', '> '].filter((m) => text.includes(m))
      const es = window.__vt.pinia._s.get('editor')
      const curPath = (files.current?.path ?? '').replace(/\\\\/g, '/').toLowerCase()
      out.push({ n: 'open-path', p: curPath === ${JSON.stringify(TEST_PATH)}.toLowerCase(), d: files.current?.path ?? '' })
      out.push({ n: 'content-equal', p: files.current?.content === ${JSON.stringify(TEST_MD)} })
      out.push({ n: 'editor-bound', p: !!ed })
      out.push({ n: 'h1-rendered', p: h1?.textContent === '验收标题', d: h1?.textContent ?? '' })
      out.push({ n: 'h2-rendered', p: h2?.textContent === '列表示例' })
      out.push({ n: 'strong-rendered', p: strong?.textContent === '加粗' })
      out.push({ n: 'em-rendered', p: em?.textContent === '斜体' })
      out.push({ n: 'inline-code-rendered', p: icode?.textContent === '行内代码' })
      out.push({ n: 'blockquote-rendered', p: bq?.textContent.includes('引用段落') })
      out.push({ n: 'bullets-2', p: uls.some((u) => u.querySelectorAll('li').length === 2), d: 'uls=' + uls.length })
      out.push({ n: 'ordered-2', p: ols.some((o) => o.querySelectorAll('li').length === 2), d: 'ols=' + ols.length })
      out.push({ n: 'tasks-checkbox', p: boxes.length === 2 && boxes[0]?.checked === true && boxes[1]?.checked === false, d: 'boxes=' + boxes.length })
      out.push({ n: 'table-cells', p: table?.querySelectorAll('td').length === 2 && table?.querySelectorAll('th').length === 2 })
      out.push({ n: 'codemirror-mounted', p: cm?.textContent.includes("console.log('hello')"), d: cm?.textContent.slice(0, 24) ?? '' })
      out.push({ n: 'mermaid-svg', p: mmd })
      out.push({ n: 'no-raw-markdown', p: raw.length === 0, d: raw.join(',') })
      out.push({ n: 'outline-populated', p: es?.outline?.length >= 2, d: es?.outline?.map((o) => o.text).join('|') ?? '' })
      out.push({ n: 'outline-pos-valid', p: es?.outline?.every((o) => typeof o.pos === 'number' && o.pos > 0) })
      return out
    })()`)
    record('A', out)
  })

  // ═══ B. InputRules + 标记符（新建空白文档）═══
  await phase('B', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    const focusOk = await ev(`(() => { const ed = window.__vt.ed(); ed?.commands.focus('start'); return document.hasFocus() })()`)
    if (!focusOk) throw new Error('窗口未获得焦点')
    await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
    await sleep(800)
    await ev(`(() => { const ed = window.__vt.ed(); ed?.commands.focus('start'); return 'ok' })()`)
    await typeText('#')
    await typeText(' ')
    await sleep(250)
    record('B', await ev(`(() => {
      const h = document.querySelector('.ProseMirror h1')
      let cont = 'none'
      if (h) cont = getComputedStyle(h, '::before').content
      return [{ n: 'heading-input-rule', p: !!h && h.classList.contains('md-reveal') && cont.includes('#'), d: 'content=' + cont }]
    })()`))
    await typeText('大标题')
    await sleep(200)
    record('B', await ev(`(() => {
      const h = document.querySelector('.ProseMirror h1')
      return [{ n: 'heading-text', p: h?.textContent === '大标题' && h?.classList.contains('md-reveal') === true }]
    })()`))
    await keyPress('Enter', 'Enter', 13, '\r')
    await sleep(250)
    record('B', await ev(`(() => {
      const h = document.querySelector('.ProseMirror h1')
      const sel = window.__vt.ed()?.state.selection
      const inP = !!sel && sel.$from.parent.type.name === 'paragraph'
      return [{ n: 'heading-marker-hide-on-exit', p: !!h && !h.classList.contains('md-reveal') && inP }]
    })()`))
    // 加粗 + 行内标记（光标就在刚输入的文字之后，用相对位置选取，避免坐标歧义）
    await typeText('加粗')
    await sleep(200)
    record('B', await ev(`(() => {
      const ed = window.__vt.ed()
      if (!ed) return [{ n: 'bold-apply', p: false, d: 'no-editor' }]
      const caret = ed.state.selection.from
      ed.chain().focus().setTextSelection({ from: caret - 2, to: caret }).toggleBold().run()
      return [{ n: 'bold-apply', p: true }]
    })()`))
    await sleep(300)
    record('B', await ev(`(() => {
      const s = document.querySelector('.ProseMirror strong')
      // 类名由 markers 插件直接挂在样式元素上（见 lib/editor/markers.ts）
      const markerMatch = s?.classList.contains('md-reveal-inline') ? getComputedStyle(s, '::before').content : 'none'
      return [{
        n: 'bold-marker-reveal',
        p: !!s && s.textContent === '加粗' && markerMatch.includes('*'),
        d: 'cls=' + (s?.className ?? '') + ' content=' + markerMatch
      }]
    })()`))
    await keyPress('ArrowRight', 'ArrowRight', 39)
    await sleep(250)
    record('B', await ev(`(() => {
      const s = document.querySelector('.ProseMirror strong')
      return [{ n: 'bold-marker-hide-on-exit', p: !!s && !s.classList.contains('md-reveal-inline') }]
    })()`))
    // 任务列表：- [ ] 语法
    await keyPress('Enter', 'Enter', 13, '\r')
    await sleep(200)
    await typeText('-')
    await typeText(' ')
    await sleep(250)
    record('B', await ev(`(() => {
      const li = document.querySelector('.ProseMirror ul li')
      return [{ n: 'bullet-input-rule', p: !!li && li.classList.contains('md-reveal'), d: li ? li.textContent : '' }]
    })()`))
    await typeText('[')
    await typeText(' ')
    await typeText(']')
    await typeText(' ')
    await sleep(300)
    record('B', await ev(`(() => {
      const li = document.querySelector('.ProseMirror li[data-checked]')
      const box = document.querySelector('.ProseMirror input[type="checkbox"]')
      return [{
        n: 'task-input-rule',
        p: !!li && !!box && box.checked === false,
        d: 'li=' + (li?.dataset.checked ?? '') + ' box=' + !!box
      }]
    })()`))
    await typeText('任务A')
    await keyPress('Enter', 'Enter', 13, '\r')
    await sleep(250)
    await typeText('任务B')
    await keyPress('Enter', 'Enter', 13, '\r')
    await sleep(200)
    await keyPress('Enter', 'Enter', 13, '\r')
    await sleep(300)
    record('B', await ev(`(() => {
      const ed = window.__vt.ed()
      if (!ed) return [{ n: 'task-enter-semantics', p: false, d: 'no-editor' }]
      const md = ed.storage.markdown.getMarkdown()
      const boxes = [...document.querySelectorAll('.ProseMirror input[type="checkbox"]')]
      const paras = [...document.querySelectorAll('.ProseMirror p')]
      const okMd = md.includes('# 大标题') && md.includes('**加粗**') && md.includes('- [ ] 任务A') && md.includes('- [ ] 任务B')
      return [
        { n: 'task-enter-semantics', p: boxes.length === 2 && paras.length >= 2, d: 'boxes=' + boxes.length + ' paras=' + paras.length },
        { n: 'roundtrip-markdown', p: okMd, d: JSON.stringify(md) }
      ]
    })()`))
  })

  // ═══ C. 代码块 CodeMirror 编辑 + 持久化 ═══
  await phase('C', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(TEST_PATH)}); return 'ok' })()`)
    await sleep(1000)
    // 真实鼠标点击进入 CodeMirror（程序化 focus 不会驱动 CM 的输入管道；
    // 避开左侧行号 gutter——点击 gutter 会被 PM 当作节点选择拦截）
    let cmFocused = false
    for (let attempt = 0; attempt < 3 && !cmFocused; attempt++) {
      await clickEl('.cm-content', 40)
      await sleep(300)
      cmFocused = await ev(
        `(() => {
          const a = document.activeElement
          return !!a && (a.classList.contains('cm-content') || !!a.closest('.cm-content') || !!document.querySelector('.cm-editor.cm-focused'))
        })()`
      )
    }
    if (!cmFocused) throw new Error('CodeMirror 未获得焦点')
    await typeText('// 校验 ')
    await sleep(400)
    record('C', await ev(`(() => {
      const cm = document.querySelector('.cm-content')
      return [{ n: 'codemirror-edit', p: !!cm?.textContent.includes('// 校验'), d: cm?.textContent.slice(0, 30) ?? '' }]
    })()`))
    await ev(`(() => { const a = document.activeElement; a?.blur(); return 'ok' })()`)
    await sleep(700)
    record('C', await ev(`(async () => {
      const out = []
      const files = window.__vt.files()
      out.push({ n: 'cm-sync-to-md', p: files.current?.content.includes('// 校验') })
      const ed = window.__vt.ed()
      const md = ed?.storage.markdown.getMarkdown() ?? ''
      out.push({ n: 'cm-fence-kept', p: md.includes('\`\`\`js') && md.includes('// 校验') })
      const saved = await files.save()
      out.push({ n: 'file-save', p: saved === true })
      const rows = await window.luminAPI.db.search('验收标题')
      out.push({ n: 'sqlite-search', p: Array.isArray(rows) && rows.length >= 1, d: 'rows=' + rows?.length })
      const doc = await window.luminAPI.db.getDocument(${JSON.stringify(TEST_PATH)})
      out.push({ n: 'sqlite-content-match', p: !!doc && doc.content === files.current.content, d: doc ? 'len=' + doc.content.length : 'null' })
      return out
    })()`))
    // 重新打开验证持久化渲染
    await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(TEST_PATH)}); return 'ok' })()`)
    await sleep(1000)
    record('C', await ev(`(() => {
      const h1 = document.querySelector('.ProseMirror h1')
      const cm = document.querySelector('.cm-content')
      return [{ n: 'reopen-persists-render', p: h1?.textContent === '验收标题' && cm?.textContent.includes('// 校验') }]
    })()`))
  })

  // ═══ D. 表格编辑 / 气泡菜单 / HTML / 主题 / 全局搜索 ═══
  await phase('D', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    const tablePos = await ev(`(() => {
      const ed = window.__vt.ed()
      let pos = -1
      ed.state.doc.descendants((n, p) => { if (pos < 0 && n.isText && n.text === '1') pos = p + 1 })
      if (pos >= 0) ed.chain().focus().setTextSelection(pos + 1).run()
      return pos >= 0
    })()`)
    if (!tablePos) throw new Error('表格单元格未定位')
    await typeText('9')
    await sleep(250)
    record('D', await ev(`(() => {
      const td = [...document.querySelectorAll('.ProseMirror td')].find((t) => t.textContent === '19')
      return [{ n: 'table-cell-edit', p: !!td }]
    })()`))
    const selOk = await ev(`(() => {
      const ed = window.__vt.ed()
      // 逐位置扫描 textBetween，找到目标文本的绝对起始位置
      const target = '正文段落'
      let from = -1
      for (let pos = 0; pos <= ed.state.doc.content.size && from < 0; pos++) {
        if (ed.state.doc.textBetween(pos, pos + target.length) === target) from = pos
      }
      if (from < 0) return false
      // 真实用户只能选中可见文字：先滚动到选区再显示气泡
      ed.chain().focus().setTextSelection({ from, to: from + 4 }).scrollIntoView().run()
      return true
    })()`)
    if (!selOk) throw new Error('气泡菜单选区未定位')
    await sleep(300)
    record('D', await ev(`(() => {
      const menu = document.querySelector('.bubble-menu')
      return [{ n: 'bubble-menu-visible', p: !!menu && menu.querySelectorAll('.bubble-btn').length >= 6, d: 'btns=' + (menu?.querySelectorAll('.bubble-btn').length ?? 0) }]
    })()`))
    await clickEl('.bubble-btn[title="加粗"]')
    await sleep(350)
    record('D', await ev(`(() => {
      const ed = window.__vt.ed()
      const md = ed?.storage.markdown.getMarkdown() ?? ''
      const menu = document.querySelector('.bubble-menu')
      return [
        { n: 'bubble-bold-applied', p: md.includes('**正文段落**'), d: md.slice(0, 60) },
        { n: 'bubble-stays-open', p: !!menu }
      ]
    })()`))
    record('D', await ev(`(() => {
      const ed = window.__vt.ed()
      const html = ed?.getHTML() ?? ''
      return [{ n: 'export-html-ready', p: html.includes('<h1') && html.includes('<table') && html.includes('<pre><code'), d: 'len=' + html.length }]
    })()`))
    const theme = await ev(`(async () => {
      const s = window.__vt.settings()
      const orig = s.theme
      s.set('theme', 'dark')
      await new Promise((r) => setTimeout(r, 200))
      const okDark = document.documentElement.classList.contains('theme-dark')
      s.set('theme', orig === 'dark' ? 'light' : orig)
      return { okDark, orig }
    })()`)
    record('D', [{ n: 'theme-switch', p: !!theme?.okDark, d: 'orig=' + theme?.orig }])
    await ev(`(() => { window.__vt.ui().openGlobalSearch(); return 'ok' })()`)
    await sleep(300)
    record('D', await ev(`(async () => {
      const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder ?? '').includes('搜索'))
      const rows = await window.luminAPI.db.search('验收标题')
      window.__vt.ui().closeGlobalSearch()
      return [{ n: 'global-search-modal', p: !!input, d: 'db-rows=' + rows?.length }]
    })()`))
  })

  // ═══ E. 分割线回车确认 / 标题行首退格 / 设置 SQLite 持久化 ═══
  await phase('E', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
    await sleep(800)
    await ev(`(() => { const ed = window.__vt.ed(); ed?.commands.focus('start'); return 'ok' })()`)

    // 1) '---' 输入后不即时转换（可输入 "---你好" 这类文本）
    await typeText('---')
    await sleep(300)
    record('E', await ev(`(() => {
      const pm = document.querySelector('.ProseMirror')
      const p = pm?.querySelector('p')
      return [{ n: 'hr-not-immediate', p: !pm?.querySelector('hr') && p?.textContent === '---', d: p?.textContent ?? '' }]
    })()`))

    // 2) Enter 后转换为分割线 + 新段落
    await keyPress('Enter', 'Enter', 13, '\r')
    await sleep(300)
    record('E', await ev(`(() => {
      const ed = window.__vt.ed()
      const hr = document.querySelector('.ProseMirror hr')
      const sel = ed?.state.selection
      return [{
        n: 'hr-enter-rule',
        p: !!hr && !!sel && sel.$from.parent.type.name === 'paragraph' && sel.$from.parent.textContent === '',
        d: 'parent=' + (sel?.$from.parent.type.name ?? '')
      }]
    })()`))

    // 3) '---你好' 正常成段，Enter 不触发转换
    await typeText('---你好')
    await keyPress('Enter', 'Enter', 13, '\r')
    await sleep(300)
    record('E', await ev(`(() => {
      const md = window.__vt.ed()?.storage.markdown.getMarkdown() ?? ''
      const hrs = document.querySelectorAll('.ProseMirror hr').length
      return [{
        n: 'hr-text-kept',
        p: hrs === 1 && md.includes('---你好'),
        d: 'hrs=' + hrs + ' md=' + JSON.stringify(md.slice(0, 30))
      }]
    })()`))

    // 4) 标题行首退格：取消标题格式（降级为段落），不并入上一行
    await typeText('#')
    await typeText(' ')
    await sleep(200)
    await typeText('二级标题')
    await sleep(300)
    const headPos = await ev(`(() => {
      const ed = window.__vt.ed()
      const target = '二级标题'
      let from = -1
      for (let pos = 0; pos <= ed.state.doc.content.size && from < 0; pos++) {
        if (ed.state.doc.textBetween(pos, pos + target.length) === target) from = pos
      }
      if (from < 0) return false
      // 光标置于标题第一个字前
      ed.chain().focus().setTextSelection(from).run()
      return true
    })()`)
    if (!headPos) throw new Error('标题位置未定位')
    await keyPress('Backspace', 'Backspace', 8)
    await sleep(300)
    record('E', await ev(`(() => {
      const ed = window.__vt.ed()
      const md = ed?.storage.markdown.getMarkdown() ?? ''
      const sel = ed?.state.selection
      return [{
        n: 'heading-backspace-unheading',
        p:
          sel?.$from.parent.type.name === 'paragraph' &&
          md.includes('二级标题') &&
          !md.includes('# 二级标题') &&
          md.includes('---你好'),
        d: 'parent=' + (sel?.$from.parent.type.name ?? '') + ' md=' + JSON.stringify(md.slice(0, 50))
      }]
    })()`))

    // 5) 设置经 IPC 写入 SQLite 后回读一致（持久化，非会话态）
    const dbTheme = await ev(`(async () => {
      const orig = (await window.luminAPI.settings.getAll()).theme
      await window.luminAPI.settings.update({ theme: 'dark' })
      const back = await window.luminAPI.settings.getAll()
      const ok = back.theme === 'dark'
      await window.luminAPI.settings.update({ theme: orig })
      return ok
    })()`)
    record('E', [{ n: 'settings-sqlite-persist', p: !!dbTheme }])
  })

  // ═══ 清理：恢复用户工作区 ═══
  await ev(`window.luminAPI.workspace.setRoot(${JSON.stringify(USER_WS)}).then(() => 'ok')`)

  // 控制台错误收集
  const realErrors = logErrors.filter(
    (t) =>
      !t.includes('DevTools') &&
      !t.includes('deprecated') &&
      !t.includes('ExperimentalWarning') &&
      !t.includes('Autofill') &&
      !t.includes('net::')
  )
  results.push({ phase: 'setup', name: 'console-errors', pass: realErrors.length === 0, detail: realErrors.slice(0, 3).join(' | ') })
  console.log(`${realErrors.length === 0 ? 'PASS' : 'FAIL'} [setup] console-errors — ${realErrors.length}`)

  const failed = results.filter((r) => !r.pass)
  console.log('\n──────────── 汇总 ────────────')
  console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - [${f.phase}] ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
  }
  ws.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
