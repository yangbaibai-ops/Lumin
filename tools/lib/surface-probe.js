'use strict'
// ─── 两面探测的共享原语（页面侧表达式 + 小工具）───────────────────────────────
//
// L2/L3/L4 三个套件（`_verify-surfaces` / `_verify-surface-fuzz` / `_verify-surface-stress`）
// 都要做同一件事：把一篇 Markdown 装进编辑器 → 走应用自己的落盘管线取回真源 → 切面 → 比对。
// 差别只在「喂什么语料、断言什么」。所以探针（页面侧表达式）与几个小工具放在这里，
// 套件里只留判定逻辑 —— 与 `md-fidelity.js` 同一种分工。
//
// 为什么页面侧表达式是字符串：CDP 只能求值源码文本；写成常量既避免拼错引号，也让
// 「同一个探针」在三个套件里逐字一致（各写各的必然漂移）。
//
// 关键约定（踩过坑，别改）：
//   * `setContent` 只改编辑器、不动真源；装完必须走一次 `FLUSH`（beforeunload → flushSync），
//     否则任何一次账本对齐都会把真源内容灌回来覆盖掉刚装的夹具；
//   * 源码模式下编辑器是休眠的（instance=null），装载前必须先回到渲染面；
//   * 判「内容有没有丢」不能只看 `textContent`：公式/HTML 块/front matter 的原文存在
//     原子节点的 attrs 里（`modelText` 把它们一并算上）。

const { sleep, appPages } = require('./harness')

/** 把 Markdown 装进编辑器（不惊动真源） */
const LOAD = (md) => `(() => {
  const ed = window.__L.ed()
  if (!ed) return 'no-editor'
  ed.commands.setContent(${JSON.stringify(md)}, { emitUpdate: false })
  return 'ok'
})()`

/** 走应用自己的落盘管线（beforeunload → flushSync），返回真源内容 */
const FLUSH = `(() => {
  window.dispatchEvent(new Event('beforeunload'))
  return window.__L.files().current?.content ?? null
})()`

const STORE = `JSON.stringify((() => {
  const f = window.__L.files()
  return {
    content: f.current?.content ?? null,
    dirty: !!f.dirty,
    rev: f.contentRev,
    author: f.contentAuthor,
    staleWysiwyg: f.contentIsStale('wysiwyg'),
    mode: window.__L.ui().editorMode
  }
})())`

const PM = `JSON.stringify((() => {
  const ed = window.__L.ed()
  if (!ed) return null
  const c = { headings: [], codeBlocks: 0, mathBlocks: 0, hr: 0, quotes: 0, listItems: 0,
              taskItems: 0, tables: 0, images: 0, frontmatter: 0, htmlBlocks: 0 }
  const parts = []
  ed.state.doc.descendants((n) => {
    if (n.isText) { parts.push(n.text); return }
    const src = n.attrs && typeof n.attrs.source === 'string' ? n.attrs.source : null
    if (src) parts.push(src)
    if (n.type.name === 'image' && n.attrs.alt) parts.push(String(n.attrs.alt))
    switch (n.type.name) {
      case 'heading': c.headings.push(n.attrs.level); break
      case 'codeBlock': c.codeBlocks += 1; break
      case 'mathBlock': c.mathBlocks += 1; break
      case 'horizontalRule': c.hr += 1; break
      case 'blockquote': c.quotes += 1; break
      case 'listItem': c.listItems += 1; break
      case 'taskItem': c.taskItems += 1; break
      case 'table': c.tables += 1; break
      case 'image': c.images += 1; break
      case 'frontmatter': c.frontmatter += 1; break
      case 'htmlBlock': c.htmlBlocks += 1; break
    }
  })
  const sel = ed.state.selection
  return { counts: c, text: ed.state.doc.textContent, modelText: parts.join('\\n'),
           size: ed.state.doc.content.size, from: sel.from, to: sel.to }
})())`

/**
 * 文档树签名：`type#attrs(子节点,…)`，文本按判级器口径把「两个反斜杠」归一成一个
 * （非必要转义是保义改写，不归一会被误判成结构变化）。
 * 计数相同但**位置**变了也算结构损坏 —— 实测过 `> > a` + `> b` 那种把段落挪进内层引用的情况。
 */
const SIGNATURE = `(() => {
  const ed = window.__L.ed()
  if (!ed) return null
  const ATTRS = ['language', 'level', 'source', 'alt', 'checked', 'start', 'align', 'marker']
  const walk = (n) => {
    // 文本按「渲染语义」归一后再比：反斜杠 + ASCII 标点 与 单个标点 在渲染上完全一样，
    // 两个反斜杠与一个反斜杠也一样 —— 序列化器会给纯文本里的标点补转义（下划线 → 反斜杠+下划线），
    // 那是保护性改写而不是结构变化；不归一的话每一处都会被误判成「结构变了」
    if (n.isText) return JSON.stringify(String(n.text).replace(/\\\\[!-/:-@[-\x60{-~]/g, (m) => m.slice(1)))
    const a = []
    for (const k of ATTRS) {
      const v = n.attrs ? n.attrs[k] : undefined
      if (v !== undefined && v !== null && v !== '' && v !== false) a.push(k + '=' + JSON.stringify(v))
    }
    const kids = []
    n.forEach((c) => kids.push(walk(c)))
    return n.type.name + (a.length ? '[' + a.join(',') + ']' : '') + '(' + kids.join(',') + ')'
  }
  return walk(ed.state.doc)
})()`

const TEXTAREA = `JSON.stringify((() => {
  const ta = document.querySelector('textarea.source-editor')
  if (!ta) return null
  return { value: ta.value, len: ta.value.length, selStart: ta.selectionStart, selEnd: ta.selectionEnd }
})())`

const DESCRIBE = (sel) => `JSON.stringify((() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return { exists: false }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return {
    exists: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').slice(0, 40),
    fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, fontFamily: cs.fontFamily,
    background: cs.backgroundColor, textAlign: cs.textAlign, display: cs.display,
    height: r.height, width: r.width, borderBottomWidth: parseFloat(cs.borderBottomWidth) || 0,
    borderLeftWidth: parseFloat(cs.borderLeftWidth) || 0, color: cs.color,
    paddingLeft: parseFloat(cs.paddingLeft) || 0
  }
})())`

const PERF = `(() => {
  const ed = window.__L.ed()
  return JSON.stringify({
    now: performance.now(),
    docSize: ed ? ed.state.doc.content.size : -1,
    domNodes: document.querySelectorAll('.md-preview *').length,
    heap: (performance.memory && performance.memory.usedJSHeapSize) || null
  })
})()`

async function readJson(app, expr) {
  const raw = await app.ev(expr)
  return raw === null || raw === 'null' ? null : JSON.parse(raw)
}

/** 切编辑面并等到目标面就绪（源码模式没有编辑器实例，只等 DOM） */
async function setMode(app, mode) {
  await app.ev(`(() => { window.__L.ui().editorMode = ${JSON.stringify(mode)}; return 'ok' })()`)
  await sleep(500)
  if (mode !== 'source') {
    for (let i = 0; i < 100; i++) {
      if (await app.ev('!!window.__L?.ed()')) break
      await sleep(100)
    }
    await sleep(250)
  }
}

/**
 * 装一篇文档并走一次落盘管线，返回真源内容。
 * 源码模式下先切回渲染面（否则 `ed()` 是 null，装载会**静默失败**）。
 */
async function loadDoc(app, md) {
  if ((await app.ev('window.__L.ui().editorMode')) === 'source') await setMode(app, 'wysiwyg')
  const r = await app.ev(LOAD(md))
  if (r !== 'ok') return null
  await sleep(150)
  return await app.ev(FLUSH)
}

/** 另开一个临时窗口（跑完关掉）：不碰调用者正在编辑的文档，且天然是干净缓冲区 */
async function openScratchWindow(app) {
  const before = (await appPages()).map((p) => p.id)
  await app.ev('(window.luminAPI.app.newWindow(), "ok")')
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    const page = (await appPages()).find((p) => !before.includes(p.id))
    if (page) return page
  }
  return null
}

/** 首个不同的字符下标（诊断用） */
function firstDiff(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

module.exports = {
  LOAD,
  FLUSH,
  STORE,
  PM,
  SIGNATURE,
  TEXTAREA,
  DESCRIBE,
  PERF,
  readJson,
  setMode,
  loadDoc,
  openScratchWindow,
  firstDiff
}
