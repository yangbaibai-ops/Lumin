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

  // 切到测试工作区并写入验收文件（清掉历史调试期残留的草稿，避免
  // 草稿恢复逻辑用旧内容覆盖验收文件）
  await ev(`window.luminAPI.workspace.setRoot(${JSON.stringify(TEST_DIR)}).then(() => 'ok')`)
  await ev(`window.luminAPI.drafts.remove('file-' + encodeURIComponent(${JSON.stringify(TEST_PATH)}.toLowerCase())).then(() => 'ok').catch(() => 'ok')`)
  await ev(
    `window.luminAPI.file.write(${JSON.stringify(TEST_PATH)}, ${JSON.stringify(TEST_MD)}).then(() => 'ok')`
  )

  // 确保处于编辑器路由（应用可能启动在欢迎页）
  await ev(`(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(1200)

  // 状态归一化：历史运行/探针可能把应用留在分屏或源码模式、
  // 或残留同步滚动开关——矩阵假定从实时渲染 + 同步滚动关闭起步
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; window.__vt.settings().syncScroll = false; return 'ok' })()`)
  await sleep(600)

  // 竞态加固：上轮运行残留的草稿防抖/自动保存定时器可能在本轮 setup 之后
  // 才落盘——等一轮（1600ms > 草稿 1200ms / 自动保存 500ms），再清草稿
  // 重写验收文件，保证 A 阶段读到的是干净内容
  await sleep(1600)
  await ev(`window.luminAPI.drafts.remove('file-' + encodeURIComponent(${JSON.stringify(TEST_PATH)}.toLowerCase())).then(() => 'ok').catch(() => 'ok')`)
  await ev(
    `window.luminAPI.file.write(${JSON.stringify(TEST_PATH)}, ${JSON.stringify(TEST_MD)}).then(() => 'ok')`
  )

  // ═══ A. 打开文件 → WYSIWYG 渲染 ═══
  await phase('A', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    const out = await ev(`(async () => {
      const out = []
      const files = window.__vt.files()
      // 竞态防护：上一轮运行末尾的草稿防抖定时器可能在本轮 setup 清理后
      // 才落盘——打开前再清一次草稿
      await window.luminAPI.drafts.remove('file-' + encodeURIComponent(${JSON.stringify(TEST_PATH)}.toLowerCase())).catch(() => {})
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
      const clone = pm ? pm.cloneNode(true) : null
      if (clone) clone.querySelectorAll('.md-marker').forEach((el) => el.remove())
      const text = clone ? clone.innerText : ''
      const raw = ['**', '\`\`\`', '| ---', '- [', '> '].filter((m) => text.includes(m))
      const es = window.__vt.pinia._s.get('editor')
      const curPath = (files.current?.path ?? '').replace(/\\\\/g, '/').toLowerCase()
      out.push({ n: 'open-path', p: curPath === ${JSON.stringify(TEST_PATH)}.toLowerCase(), d: files.current?.path ?? '' })
      out.push({ n: 'content-equal', p: files.current?.content === ${JSON.stringify(TEST_MD)}, d: 'len=' + (files.current?.content?.length ?? 0) + ' head=' + JSON.stringify((files.current?.content ?? '').slice(0, 40)) })
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
      return [{ n: 'heading-input-rule', p: !!h && h.classList.contains('md-reveal') && cont.includes('H1'), d: 'content=' + cont }]
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
      // 真实文本标记模型：用 toggleMdBold（写入标记文本 + mdStyle）；
      // 选区与样式命令分两次派发，避免链式 tr 与追加归一化交互
      ed.chain().focus().setTextSelection({ from: caret - 2, to: caret }).run()
      ed.commands.toggleMdBold()
      return [{ n: 'bold-apply', p: true }]
    })()`))
    await sleep(300)
    record('B', await ev(`(() => {
      const s = document.querySelector('.ProseMirror strong')
      // 光标落在构造内（toggle 把光标放在结束标记前）→ 装饰显现
      const markers = [...document.querySelectorAll('.ProseMirror .md-marker:has(> .md-reveal-inline)')]
      const markerText = markers.map((m) => m.textContent).join('|')
      // 显现态：标记恢复布局（rect 宽度 > 0）
      const widths = markers.map((m) => m.getBoundingClientRect().width)
      return [{
        n: 'bold-marker-reveal',
        p: !!s && s.textContent === '加粗' && markerText.includes('**') && widths.every((w) => w > 0),
        d: 'strong=' + (s?.textContent ?? '') + ' markers=' + markerText
      }]
    })()`))
    // 边界语义（#1）：光标在结束标记前/构造末尾仍显现；完全移出构造
    // （越过结束标记，右边界排他）后隐藏；左移回构造边界再次显现
    await keyPress('ArrowRight', 'ArrowRight', 39)
    await sleep(200)
    record('B', await ev(`(() => {
      const shown = document.querySelectorAll('.ProseMirror .md-marker:has(> .md-reveal-inline)').length
      return [{ n: 'bold-marker-boundary', p: shown === 2, d: 'shown=' + shown }]
    })()`))
    await keyPress('ArrowRight', 'ArrowRight', 39)
    await keyPress('ArrowRight', 'ArrowRight', 39)
    await keyPress('ArrowRight', 'ArrowRight', 39)
    await sleep(250)
    record('B', await ev(`(() => {
      const s = document.querySelector('.ProseMirror strong')
      const shown = document.querySelectorAll('.ProseMirror .md-marker:has(> .md-reveal-inline)').length
      // 隐藏态零占位：font-size:0 下标记 rect 宽度为 0（无占位空隙）
      const widths = [...document.querySelectorAll('.ProseMirror .md-marker')].map((m) => m.getBoundingClientRect().width)
      return [
        { n: 'bold-marker-hide-on-exit', p: !!s && shown === 0, d: 'shown=' + shown },
        { n: 'bold-marker-no-layout', p: widths.length === 2 && widths.every((w) => w === 0), d: 'widths=' + widths.join(',') }
      ]
    })()`))
    await keyPress('ArrowLeft', 'ArrowLeft', 37)
    await sleep(250)
    record('B', await ev(`(() => {
      const shown = document.querySelectorAll('.ProseMirror .md-marker:has(> .md-reveal-inline)').length
      return [{ n: 'bold-marker-boundary-left', p: shown === 2, d: 'shown=' + shown }]
    })()`))
    // 光标移出构造末尾再继续（Enter 切段不切在标记中间）
    await keyPress('ArrowRight', 'ArrowRight', 39)
    await keyPress('ArrowRight', 'ArrowRight', 39)
    await sleep(200)
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

  // ═══ F. 表格插入（默认 3×3 / 悬停网格选择）与代码块真实键入 ═══
  await phase('F', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    // 重写测试文件：消除上一轮运行残留的键入内容，保证断言确定性
    await ev(`window.luminAPI.file.write(${JSON.stringify(TEST_PATH)}, ${JSON.stringify(TEST_MD)}).then(() => 'ok')`)
    await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
    await sleep(800)
    await ev(`(() => { const ed = window.__vt.ed(); ed?.commands.focus('start'); return 'ok' })()`)

    // 1) 点击表格按钮 → 默认 3×3（表头行 + 2 数据行）
    await clickEl('.icon-btn[title="表格"]')
    await sleep(400)
    record('F', await ev(`(() => {
      const t = document.querySelector('.ProseMirror table')
      const trs = t ? [...t.querySelectorAll('tr')] : []
      const ths = t ? [...t.querySelectorAll('th')] : []
      const tds = t ? [...t.querySelectorAll('td')] : []
      return [{
        n: 'table-default-3x3',
        p: trs.length === 3 && ths.length === 3 && tds.length === 6,
        d: 'trs=' + trs.length + ' ths=' + ths.length + ' tds=' + tds.length
      }]
    })()`))

    // 2) 悬停按钮 → 网格选择器出现；点第 2 行第 3 列 → 插入 2×3
    // 先移开鼠标再移回，触发新的 mouseenter（悬停计时器在点击时已被取消）
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 320 })
    await sleep(150)
    const btnCenter = await ev(`(() => {
      const b = document.querySelector('.icon-btn[title="表格"]')?.getBoundingClientRect()
      return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null
    })()`)
    if (!btnCenter) throw new Error('表格按钮未定位')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btnCenter.x, y: btnCenter.y })
    await sleep(550)
    const pickerOk = await ev(`!!document.querySelector('.table-size-popover')`)
    const cellRect = await ev(`(() => {
      const pop = document.querySelector('.table-size-popover')
      const rows = pop ? [...pop.querySelectorAll('div.flex')] : []
      if (rows.length < 2) return null
      const cells = [...rows[1].querySelectorAll('button')]
      if (cells.length < 3) return null
      const b = cells[2].getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    })()`)
    if (!cellRect) throw new Error('网格格子未定位')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cellRect.x, y: cellRect.y })
    await sleep(200)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: cellRect.x, y: cellRect.y, button: 'left', clickCount: 1 })
    }
    await sleep(400)
    record('F', [{ n: 'table-picker-visible', p: !!pickerOk }])
    record('F', await ev(`(() => {
      const tables = [...document.querySelectorAll('.ProseMirror table')]
      const t = tables[tables.length - 1]
      const trs = t ? [...t.querySelectorAll('tr')] : []
      const ths = t ? [...t.querySelectorAll('th')] : []
      return [{
        n: 'table-grid-picker-2x3',
        p: trs.length === 2 && ths.length === 3,
        d: 'trs=' + trs.length + ' ths=' + ths.length
      }]
    })()`))

    // 3) 单元格最小/最大宽度 + 表格横向滚动
    record('F', await ev(`(() => {
      const td = document.querySelector('.ProseMirror td')
      const table = document.querySelector('.ProseMirror table')
      if (!td || !table) return [{ n: 'table-cell-width-css', p: false, d: 'no-td' }]
      const s = getComputedStyle(td)
      const ts = getComputedStyle(table)
      return [{
        n: 'table-cell-width-css',
        p:
          s.minWidth !== '0px' &&
          s.minWidth !== 'auto' &&
          ts.overflowX === 'auto' &&
          parseFloat(ts.width) > 0,
        d: 'min=' + s.minWidth + ' overflowX=' + ts.overflowX + ' tableW=' + ts.width
      }]
    })()`))

    // 3b) 表格占满写作区内容宽度（fixed 布局 + width:100%，任意列数）
    record('F', await ev(`(() => {
      const table = document.querySelector('.ProseMirror table')
      const pm = document.querySelector('.ProseMirror')
      if (!table || !pm) return [{ n: 'table-fills-width', p: false, d: 'no-table' }]
      const tr = table.getBoundingClientRect()
      const pr = pm.getBoundingClientRect()
      // px-6 内边距在外层 .editor-content 上，.ProseMirror 即内容盒
      return [{
        n: 'table-fills-width',
        p: Math.abs(tr.width - pr.width) < 6,
        d: 'tableW=' + tr.width.toFixed(0) + ' contentW=' + pr.width.toFixed(0)
      }]
    })()`))

    // 4) 代码块真实键入：焦点保持、内容同步、大纲不闪烁
    await ev(`window.luminAPI.workspace.setRoot(${JSON.stringify(TEST_DIR)}).then(() => 'ok')`)
    await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(TEST_PATH)}); return 'ok' })()`)
    await sleep(1000)
    await ensureBridge()
    const cmRect = await ev(`(() => {
      const cm = document.querySelector('.cm-content')
      if (!cm) return null
      const b = cm.getBoundingClientRect()
      return { x: b.left + 60, y: b.top + b.height - 10 }
    })()`)
    if (!cmRect) throw new Error('代码块未定位')
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: cmRect.x, y: cmRect.y, button: 'left', clickCount: 1 })
    }
    await sleep(300)
    await ev(`(() => {
      const tabs = [...document.querySelectorAll('aside button')]
      const outlineTab = tabs.find((b) => (b.textContent ?? '').includes('大纲'))
      outlineTab?.click()
      return 'ok'
    })()`)
    await sleep(600)
    await ev(`(() => { window.__outlineFirst = document.querySelector('[data-outline-item]'); return 'ok' })()`)
    for (const [ch, vk] of [['a', 65], ['b', 66]]) {
      await keyPress(ch, 'Key' + ch.toUpperCase(), vk, ch)
      await sleep(200)
    }
    record('F', await ev(`(() => {
      const cm = document.querySelector('.cm-content')
      const ae = document.activeElement
      const ed = window.__vt.ed()
      const md = ed?.storage.markdown.getMarkdown() ?? ''
      const btns = [...document.querySelectorAll('[data-outline-item]')]
      const firstSame = window.__outlineFirst === btns[0]
      const inCm = !!ae && !!ae.closest('.cm-editor')
      return [
        { n: 'cm-real-typing', p: !!cm && cm.textContent.includes('ab') && inCm, d: 'activeInCm=' + inCm },
        { n: 'cm-sync-after-typing', p: md.includes('ab') },
        {
          n: 'outline-dom-stable',
          p: firstSame && btns.length === 2,
          d: 'firstSame=' + firstSame + ' count=' + btns.length + ' texts=' + btns.map((b) => b.textContent).join('|')
        }
      ]
    })()`))
    await keyPress('Enter', 'Enter', 13, '\r')
    await sleep(300)
    record('F', await ev(`(() => {
      const NL = String.fromCharCode(10)
      const cm = document.querySelector('.cm-content')
      const ae = document.activeElement
      const ed = window.__vt.ed()
      const md = ed?.storage.markdown.getMarkdown() ?? ''
      const inCm = !!ae && !!ae.closest('.cm-editor')
      // CM 以独立 .cm-line div 渲染每一行：换行表现为行数增加，
      // 不能用 textContent 含换行字符判断（拼接无分隔符）
      const lineCount = cm ? cm.querySelectorAll('.cm-line').length : 0
      return [{
        n: 'cm-enter-newline',
        p: !!cm && lineCount >= 2 && inCm && md.includes('ab' + NL),
        d: 'activeInCm=' + inCm + ' lines=' + lineCount + ' mdNewline=' + md.includes('ab' + NL)
      }]
    })()`))

    // 5) Markdown 粘贴：块级解析成真实节点 + 标题标记符 + 可编辑（回归守护）
    const lastPt = await ev(`(() => {
      const pm = document.querySelector('.ProseMirror')
      const paras = [...pm.querySelectorAll('p')]
      const last = paras[paras.length - 1]
      const b = last.getBoundingClientRect()
      return { x: b.left + Math.min(80, b.width), y: b.top + b.height / 2 }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: lastPt.x, y: lastPt.y, button: 'left', clickCount: 1 })
    }
    await sleep(300)
    await ev(`(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', '# 粘贴验收\\n\\n粘贴段落**加粗**。\\n\\n- 粘贴项A\\n- 粘贴项B')
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      document.querySelector('.ProseMirror').dispatchEvent(e)
      return 'ok'
    })()`)
    await sleep(600)
    record('F', await ev(`(() => {
      const ed = window.__vt.ed()
      let heading = null
      let hasList = false
      ed.view.state.doc.descendants((n) => {
        if (n.type.name === 'heading' && n.textContent.indexOf('粘贴验收') > -1) heading = n
        if (n.type.name === 'bulletList') hasList = true
      })
      const md = window.__vt.files().current?.content ?? ''
      return [{
        n: 'paste-md-blocks',
        p: !!heading && hasList && md.includes('# 粘贴验收') && md.includes('- 粘贴项A'),
        d: 'heading=' + !!heading + ' list=' + hasList
      }]
    })()`))
    const hPt = await ev(`(() => {
      const h = [...document.querySelectorAll('.ProseMirror h1')].find((el) => el.textContent.indexOf('粘贴验收') > -1)
      if (!h) return null
      const b = h.getBoundingClientRect()
      return { x: b.left + 50, y: b.top + b.height / 2 }
    })()`)
    if (hPt) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: hPt.x, y: hPt.y, button: 'left', clickCount: 1 })
      }
      await sleep(350)
      const marker = await ev(`(() => {
        const h = [...document.querySelectorAll('.ProseMirror h1')].find((el) => el.textContent.indexOf('粘贴验收') > -1)
        return !!h && h.classList.contains('md-reveal')
      })()`)
      await send('Input.insertText', { text: 'P' })
      await sleep(350)
      record('F', await ev(`(() => {
        const ed = window.__vt.ed()
        let text = ''
        ed.view.state.doc.descendants((n) => {
          if (n.type.name === 'heading' && n.textContent.indexOf('粘贴') > -1 && n.textContent.indexOf('验收') > -1) text = n.textContent
        })
        return [
          { n: 'paste-heading-marker', p: ${marker}, d: 'reveal=' + ${marker} },
          { n: 'paste-heading-editable', p: text.includes('P') && text.includes('粘贴'), d: 'text=' + JSON.stringify(text) }
        ]
      })()`))
    } else {
      record('F', await ev(`(() => [
        { n: 'paste-heading-marker', p: false, d: 'no-heading' },
        { n: 'paste-heading-editable', p: false, d: 'no-heading' }
      ])()`))
    }

    // 5b) 粘贴标题去粗：`# **粗体标题**` → 标题节点无 bold 标记、源码无 **
    const lastPt2 = await ev(`(() => {
      const pm = document.querySelector('.ProseMirror')
      const paras = [...pm.querySelectorAll('p')]
      const last = paras[paras.length - 1]
      const b = last.getBoundingClientRect()
      return { x: b.left + Math.min(80, b.width), y: b.top + b.height / 2 }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: lastPt2.x, y: lastPt2.y, button: 'left', clickCount: 1 })
    }
    await sleep(300)
    await ev(`(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', '# **粗体标题**\\n\\n粗体正文段落。')
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      document.querySelector('.ProseMirror').dispatchEvent(e)
      return 'ok'
    })()`)
    await sleep(600)
    record('F', await ev(`(() => {
      const ed = window.__vt.ed()
      let hasBold = false
      let headingText = ''
      ed.view.state.doc.descendants((n) => {
        if (n.type.name === 'heading' && n.textContent.indexOf('粗体标题') > -1) {
          headingText = n.textContent
          n.descendants((m) => {
            if (m.isText && m.marks.some((mk) => mk.type.name === 'bold')) hasBold = true
          })
        }
      })
      const md = window.__vt.files().current?.content ?? ''
      return [{
        n: 'paste-heading-no-bold',
        p: headingText === '粗体标题' && !hasBold && md.includes('# 粗体标题') && !md.includes('**粗体标题**'),
        d: 'text=' + JSON.stringify(headingText) + ' hasBold=' + hasBold
      }]
    })()`))

    // 6) 源码/实时渲染切换：不渲染样式 → 可编辑 → 切回重建
    const modeBtn = await ev(`(() => {
      const b = [...document.querySelectorAll('.mode-seg-btn')].find((x) => (x.title || '').includes('源码模式'))
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.left + 4, y: r.top + r.height / 2 }
    })()`)
    if (modeBtn) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: modeBtn.x, y: modeBtn.y, button: 'left', clickCount: 1 })
      }
      await sleep(500)
      record('F', await ev(`(() => {
        const ta = document.querySelector('textarea.source-editor')
        const pm = document.querySelector('.ProseMirror')
        const focused = document.activeElement === ta
        return [{
          n: 'source-mode-enter',
          p: !!ta && !pm && focused && ta.value.includes('#') && !ta.value.includes('<'),
          d: 'textarea=' + !!ta + ' pm=' + !!pm + ' focused=' + focused + ' hasHash=' + (ta ? ta.value.includes('#') : false) + ' hasLt=' + (ta ? ta.value.includes('<') : false)
        }]
      })()`))
      await send('Input.insertText', { text: '源' })
      await sleep(400)
      record('F', await ev(`(() => {
        const content = window.__vt.files().current?.content ?? ''
        const ta = document.querySelector('textarea.source-editor')
        const host = ta?.parentElement?.parentElement
        const fills = !!(ta && host && ta.getBoundingClientRect().height >= host.getBoundingClientRect().height - 4)
        return [
          { n: 'source-mode-editable', p: content.includes('源'), d: 'storeHas=' + content.includes('源') + ' dirty=' + window.__vt.files().dirty },
          { n: 'source-fills-height', p: fills, d: 'taH=' + (ta ? ta.getBoundingClientRect().height.toFixed(0) : 0) + ' hostH=' + (host ? host.getBoundingClientRect().height.toFixed(0) : 0) }
        ]
      })()`))
      const backBtn = await ev(`(() => {
        const b = [...document.querySelectorAll('.mode-seg-btn')].find((x) => (x.title || '').includes('实时渲染'))
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: r.left + 4, y: r.top + r.height / 2 }
      })()`)
      if (backBtn) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x: backBtn.x, y: backBtn.y, button: 'left', clickCount: 1 })
        }
        await sleep(900)
        record('F', await ev(`(() => {
          const pm = document.querySelector('.ProseMirror')
          let hasTyped = false
          window.__vt.ed()?.view.state.doc.descendants((n) => { if (n.textContent.includes('源')) hasTyped = true })
          return [{
            n: 'source-back-wysiwyg',
            p: !!pm && !document.querySelector('textarea.source-editor') && hasTyped,
            d: 'pm=' + !!pm + ' typedInDoc=' + hasTyped
          }]
        })()`))
      }
    }

    // 7) 分屏对比：双面板 + 双向实时同步 + 分隔条拖拽（SQLite 持久化）
    const splitBtn = await ev(`(() => {
      const b = [...document.querySelectorAll('.mode-seg-btn')].find((x) => (x.title || '').includes('分屏'))
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.left + 4, y: r.top + r.height / 2 }
    })()`)
    if (splitBtn) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: splitBtn.x, y: splitBtn.y, button: 'left', clickCount: 1 })
      }
      await sleep(900)
      record('F', await ev(`(() => {
        const pm = document.querySelector('.ProseMirror')
        const ta = document.querySelector('textarea.source-editor')
        const host = ta ? ta.closest('.flex.h-full') : null
        const left = host ? host.firstElementChild : null
        return [{
          n: 'split-mode-enter',
          p: !!pm && !!ta && !!left && left.getBoundingClientRect().width > 200,
          d: 'pm=' + !!pm + ' src=' + !!ta
        }]
      })()`))

      // 右（源码）→ 左（渲染）：textarea 输入 → 防抖 setContent → PM 文档更新
      const taPt = await ev(`(() => {
        const ta = document.querySelector('textarea.source-editor')
        if (!ta) return null
        const r = ta.getBoundingClientRect()
        return { x: r.left + 80, y: r.top + 30 }
      })()`)
      if (taPt) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x: taPt.x, y: taPt.y, button: 'left', clickCount: 1 })
        }
        await sleep(250)
        await send('Input.insertText', { text: '右→左' })
        await sleep(800)
        record('F', await ev(`(() => {
          let found = false
          window.__vt.ed()?.view.state.doc.descendants((n) => { if (n.textContent.includes('右→左')) found = true })
          return [{ n: 'split-source-to-wysiwyg', p: found, d: 'found=' + found }]
        })()`))

        // 左（渲染）→ 右（源码）：WYSIWYG 输入 → 防抖序列化 → textarea 刷新
        const leftPt = await ev(`(() => {
          const host = document.querySelector('textarea.source-editor')?.closest('.flex.h-full')
          const pm = host?.querySelector('.ProseMirror')
          const paras = pm ? [...pm.querySelectorAll('p')] : []
          const p = paras.find((el) => el.textContent.length > 4) ?? paras[paras.length - 1]
          if (!p) return null
          const r = p.getBoundingClientRect()
          return { x: r.left + 40, y: r.top + r.height / 2 }
        })()`)
        if (leftPt) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x: leftPt.x, y: leftPt.y, button: 'left', clickCount: 1 })
          }
          await sleep(250)
          await send('Input.insertText', { text: '左→右' })
          await sleep(700)
          record('F', await ev(`(() => {
            const ta = document.querySelector('textarea.source-editor')
            return [{
              n: 'split-wysiwyg-to-source',
              p: !!ta && ta.value.includes('左→右'),
              d: 'srcHas=' + (ta ? ta.value.includes('左→右') : false)
            }]
          })()`))
        }
      }

      // 分隔条拖拽：比例变化 + settings.splitRatio 持久化
      const divPt = await ev(`(() => {
        const d = document.querySelector('.split-divider')
        if (!d) return null
        const r = d.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + 120 }
      })()`)
      if (divPt) {
        const ratioBefore = await ev(`(() => {
          const host = document.querySelector('textarea.source-editor')?.closest('.flex.h-full')
          const left = host?.firstElementChild
          return left && host ? left.getBoundingClientRect().width / host.getBoundingClientRect().width : 0.5
        })()`)
        // 按当前比例选择拖拽方向（有变化空间的方向），保证必定改变
        const dir = ratioBefore > 0.5 ? -120 : 120
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: divPt.x, y: divPt.y, button: 'left', buttons: 1, clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divPt.x + dir, y: divPt.y, button: 'left', buttons: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: divPt.x + dir, y: divPt.y, button: 'left', clickCount: 1 })
        await sleep(400)
        record('F', await ev(`(() => {
          const host = document.querySelector('textarea.source-editor')?.closest('.flex.h-full')
          const left = host?.firstElementChild
          const ratio = left && host ? left.getBoundingClientRect().width / host.getBoundingClientRect().width : 0.5
          const settings = window.__vt.pinia._s.get('settings')
          return [{
            n: 'split-divider-drag',
            p: Math.abs(ratio - ${ratioBefore}) > 0.02 && Math.abs(settings.splitRatio - ratio) < 0.001,
            d: 'before=' + ${ratioBefore}.toFixed(3) + ' ratio=' + ratio.toFixed(3) + ' persisted=' + settings.splitRatio.toFixed(3)
          }]
        })()`))
      }

      // 7b) 同步滚动：开关 + 双向滚动进度映射
      const chip = await ev(`(() => {
        const c = document.querySelector('.split-sync-chip')
        if (!c) return null
        const r = c.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()`)
      if (chip) {
        // 先扩容内容：追加 400 行，保证两侧都可滚动
        await ev(`(() => {
          const base = window.__vt.files().current.content
          window.__vt.files().setContent(base + '\\n\\n' + Array.from({ length: 400 }, (_, i) => '滚动行 ' + i).join('\\n'))
          return 'ok'
        })()`)
        await sleep(700)
        // 点击芯片开启同步滚动
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x: chip.x, y: chip.y, button: 'left', clickCount: 1 })
        }
        await sleep(300)
        const toggled = await ev(`(() => {
          const settings = window.__vt.pinia._s.get('settings')
          return settings.syncScroll === true
        })()`)
        // 右侧 textarea 滚到中段 → 左侧按比例跟随
        await ev(`(() => {
          const ta = document.querySelector('textarea.source-editor')
          ta.scrollTop = 600
          return 'ok'
        })()`)
        await sleep(400)
        const r2l = await ev(`(() => {
          const host = document.querySelector('textarea.source-editor')?.closest('.flex.h-full')
          const left = host?.querySelector('.editor-scroll')
          const ta = document.querySelector('textarea.source-editor')
          return { leftTop: left ? left.scrollTop : 0, taTop: ta ? ta.scrollTop : 0, taRange: ta ? ta.scrollHeight - ta.clientHeight : 0 }
        })()`)
        // 左侧滚回顶部 → 右侧跟随回顶
        await ev(`(() => {
          const host = document.querySelector('textarea.source-editor')?.closest('.flex.h-full')
          const left = host?.querySelector('.editor-scroll')
          left.scrollTop = 0
          return 'ok'
        })()`)
        await sleep(400)
        const l2r = await ev(`(() => {
          const ta = document.querySelector('textarea.source-editor')
          return { taTop: ta ? ta.scrollTop : 0 }
        })()`)
        record('F', await ev(`(() => {
          const settings = window.__vt.pinia._s.get('settings')
          return [
            { n: 'split-sync-toggle', p: ${toggled} && settings.syncScroll === true, d: 'on=' + settings.syncScroll },
            { n: 'split-scroll-r2l', p: ${r2l.leftTop} > 50, d: 'leftTop=' + ${Number(r2l.leftTop).toFixed(0)} },
            { n: 'split-scroll-l2r', p: ${l2r.taTop} < 600, d: 'taTop=' + ${Number(l2r.taTop).toFixed(0)} }
          ]
        })()`))
      }

      // 回到实时渲染（干净状态收尾）
      const wysBtn = await ev(`(() => {
        const b = [...document.querySelectorAll('.mode-seg-btn')].find((x) => (x.title || '').includes('实时渲染'))
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: r.left + 4, y: r.top + r.height / 2 }
      })()`)
      if (wysBtn) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x: wysBtn.x, y: wysBtn.y, button: 'left', clickCount: 1 })
        }
        await sleep(900)
      }
    }
  })

  // ═══ G. 光标在构造边界打字不丢粗体（真实文本标记模型，§4.13 补丁）═══
  // 复现：粗体 `**5**` 上，光标落到构造起点（`|**5**`）打字，新字符继承右侧
  // mdMarker 的 mark 与起始标记粘连成 `2**`，两侧标记不配对 → 整段字面量 →
  // 渲染失粗（但源码仍 `2**5**`，故 content-equal 永远抓不到，必须查 DOM strong）
  await phase('G', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
    await sleep(800)
    await ev(`(() => { const ed = window.__vt.ed(); ed?.commands.focus('start'); return 'ok' })()`)
    await ev(`(() => { const ed = window.__vt.ed(); ed?.commands.setContent('**5**'); return 'ok' })()`)
    await sleep(400)
    // 构造起点（第一个 * 之前）打字
    await ev(`(() => { const ed = window.__vt.ed(); ed?.chain().focus().setTextSelection(1).run(); return 'ok' })()`)
    await typeText('2')
    await sleep(400)
    record('G', await ev(`(() => {
      const ed = window.__vt.ed()
      if (!ed) return [{ n: 'boundary-type-start-keeps-bold', p: false, d: 'no-editor' }]
      const md = ed.storage.markdown.getMarkdown()
      const strong = [...document.querySelectorAll('.ProseMirror strong')].map((e) => e.textContent).join(',')
      return [{ n: 'boundary-type-start-keeps-bold', p: md === '2**5**' && strong === '5', d: 'md=' + JSON.stringify(md) + ' strong=' + strong }]
    })()`))
    // 构造终点（最后一个 * 之后）打字
    await ev(`(() => { const ed = window.__vt.ed(); ed?.chain().focus().setTextSelection(ed.state.doc.content.size).run(); return 'ok' })()`)
    await typeText('3')
    await sleep(400)
    record('G', await ev(`(() => {
      const ed = window.__vt.ed()
      if (!ed) return [{ n: 'boundary-type-end-keeps-bold', p: false, d: 'no-editor' }]
      const md = ed.storage.markdown.getMarkdown()
      const strong = [...document.querySelectorAll('.ProseMirror strong')].map((e) => e.textContent).join(',')
      return [{ n: 'boundary-type-end-keeps-bold', p: md === '2**5**3' && strong === '5', d: 'md=' + JSON.stringify(md) + ' strong=' + strong }]
    })()`))
    // 光标移出构造 → 折叠为纯粗体（无字面量残星）
    await ev(`(() => { const ed = window.__vt.ed(); ed?.chain().focus().setTextSelection(1).run(); return 'ok' })()`)
    await sleep(300)
    record('G', await ev(`(() => {
      const strong = [...document.querySelectorAll('.ProseMirror strong')].map((e) => e.textContent).join(',')
      const shown = document.querySelectorAll('.ProseMirror .md-marker:has(> .md-reveal-inline)').length
      return [{ n: 'boundary-type-fold-back-bold', p: strong === '5' && shown === 0, d: 'strong=' + strong + ' shown=' + shown }]
    })()`))
  })

  // ═══ H. Ctrl/Cmd+左键不整选节点（TyporaPointer，§4.14）═══
  // PM 内置 selectNodeModifier 在 Ctrl/Cmd+左键时把光标所在文本块 NodeSelection
  // 整选（.ProseMirror-selectednode 套主题色 outline）——Typora 无此逻辑；
  // 修复后 Ctrl+左键退化为普通点击（光标落点、折叠选区、无整选框）
  await phase('H', async () => {
    const bridged = await ensureBridge()
    if (bridged !== 'OK') throw new Error('桥接失败: ' + bridged)
    await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
    await sleep(800)
    await ev(`(() => {
      const ed = window.__vt.ed()
      ed?.commands.setContent('第一段 普通文本 点击目标 here。\\n\\n第二段 用于验证。')
      ed?.commands.focus('start')
      return 'ok'
    })()`)
    await sleep(600)
    // 第一段文字中部坐标（用 Range 精确取第 5~6 字符之间，避免点在线宽留白上）
    const pt = await ev(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const tn = [...p.childNodes].find((n) => n.nodeType === 3)
      const r = document.createRange()
      r.setStart(tn, 4)
      r.setEnd(tn, 5)
      const b = r.getBoundingClientRect()
      return { x: b.left + 1, y: b.top + b.height / 2 }
    })()`)
    // Ctrl+左键（modifiers: 2 = Ctrl）
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1, modifiers: 2 })
    }
    await sleep(500)
    record('H', await ev(`(() => {
      const ed = window.__vt.ed()
      if (!ed) return [{ n: 'ctrl-click-plain-caret', p: false, d: 'no-editor' }]
      const sel = ed.state.selection
      const selType = sel.constructor.name
      const whole = document.querySelector('.ProseMirror-selectednode')
      return [{
        n: 'ctrl-click-plain-caret',
        p: selType.includes('TextSelection') && sel.from === sel.to && sel.from > 1 && sel.from < 16 && !whole,
        d: 'type=' + selType + ' from=' + sel.from + ' whole=' + !!whole
      }]
    })()`))
    // 普通左键（无修饰键）行为不受影响：仍为普通光标点击
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1, modifiers: 0 })
    }
    await sleep(400)
    record('H', await ev(`(() => {
      const sel = window.__vt.ed()?.state.selection
      const selType = sel ? sel.constructor.name : 'none'
      return [{
        n: 'plain-click-unchanged',
        p: selType.includes('TextSelection') && !document.querySelector('.ProseMirror-selectednode'),
        d: 'type=' + selType
      }]
    })()`))
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
