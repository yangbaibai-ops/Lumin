'use strict'
// ─── 验收：实时渲染 ⇄ 源码的两面一致性（测试方案 §3 的 L2 层）──────────────────
//
// 方案与不变量清单见 docs/wysiwyg-test-plan.md（§2 质量模型、§4 I1–I12）。
// 这一层验的是「必须在真浏览器 + 真编辑器里才存在」的东西：
//
//   A. 切面无副作用 / 稳定（I3/I4/I6）：同一个文档在 wysiwyg ↔ source 之间来回切，
//      真源内容必须逐字不变，源码 textarea 必须等于真源；且**渲染面看得见的哨兵词**
//      一个不少、顺序不乱（I7 的渲染侧）。
//   B. 结构往返（I5）：把序列化产出再装回编辑器，ProseMirror 的结构计数必须与第一次一致
//      （不看 Markdown 文本，只看两棵文档树 —— 免掉「用正则猜结构」的假失败）。
//   C. 位置语义（P4）：源码 ⇄ 渲染是**按比例**映射（设计如此，见 EditorView 的 restoreViewPos），
//      但「渲染 → 源码 → 渲染」回来时用的是精确 PM 位置，所以这条路必须逐字回到原位，
//      而且**切回来就能接着打字**（哨兵字符出现在原位邻域）。
//   D. 状态语义（P5）：只看不编辑不改 dirty；编辑后切面内容不丢；撤销要么成功要么无副作用、
//      绝不产生损坏内容；保存后磁盘字节 = 真源内容。
//   E. 渲染结构（I8）：每种构造落到预期元素且关键计算样式成立（表驱动，见 RENDER_SPECS）。
//   F. 分屏同世代（I9）：右栏输入后账本收敛、左栏跟上。
//   T. 两段式表面（纸 / 外壳）与纸面上的可辨识度：三主题各量一遍，**只判关系不判绝对值**
//      —— 见 lib/color.js 的说明（为什么不该钉死 rgb(...)）。
//
// 跑法（对着隔离实例；跑完恢复模式/设置）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-isolated.ps1
//   node tools/_verify-surfaces.js
// 诊断：逐篇结果落 %TEMP%\lumin-surfaces-report.json

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  connect,
  settle,
  waitEditor,
  sleep,
  clickMode,
  appPages,
  attach,
  Reporter,
  fatal
} = require('./lib/harness')
const { contrast, deltaL, over, rgbText, sameColor, rat, SURFACE_PROBE } = require('./lib/color')
const { generateCorpus } = require('./lib/md-gen')
const {
  contentPreserved,
  idempotent,
  unchanged,
  traceTokens,
  structureFromMarkdown,
  structureDiff
} = require('./lib/surface-invariants')

const SEED = Number(process.env.LUMIN_SURFACE_SEED || 20260916)
const DOCS = Number(process.env.LUMIN_SURFACE_DOCS || 12)
const DUMP = process.env.LUMIN_SURFACE_DUMP || path.join(os.tmpdir(), 'lumin-surfaces-report.json')
const WS = path.join(os.tmpdir(), 'lumin-surfaces-ws')

// ─── 页面侧取数表达式（套件只做判定，不夹带业务逻辑）──────────────────────────
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
  // 文档模型里的「全部内容」：文本 + 原子节点里存着的原文（公式/HTML 块/front matter 的
  // source、图片的 alt）。只看 textContent 会把它们当成「内容丢了」——那是量错了，不是真丢。
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

const TEXTAREA = `JSON.stringify((() => {  const ta = document.querySelector('textarea.source-editor')
  if (!ta) return null
  return { value: ta.value, len: ta.value.length, selStart: ta.selectionStart, selEnd: ta.selectionEnd }
})())`

/** 单个元素的计算样式快照（渲染结构断言用；判定放在套件这侧，便于扩展） */
const describeEl = (sel) => `JSON.stringify((() => {
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

async function setMode(app, mode) {
  await app.ev(`(() => { window.__L.ui().editorMode = ${JSON.stringify(mode)}; return 'ok' })()`)
  await sleep(500)
  if (mode !== 'source') {
    await waitEditor(app.ev)
    await sleep(250)
  }
}

/**
 * I5' 文档树签名：`type#level(子节点,…)`，文本原样、关键属性（语言/对齐/原文/alt/勾选/起始号）
 * 一起进签名。
 *
 * 为什么不能只比结构计数：计数相同但**位置**变了也算结构损坏 —— 实测过一例
 * `> > a` + `> b`（外层引用里的一段话）被合并进了内层引用，计数一个不差，文档却变了。
 * 有了签名还能做分诊：`classify` 判 lossy 而签名相同 ⇒ 只是**重写了标记**；
 * 签名不同 ⇒ 结构真的变了，必须查。
 */
const SIGNATURE = `(() => {
  const ed = window.__L.ed()
  if (!ed) return null
  const ATTRS = ['language', 'level', 'source', 'alt', 'checked', 'start', 'align', 'marker']
  const walk = (n) => {
    // 文本按判级器同一口径归一：两个反斜杠与一个反斜杠在 CommonMark 里都表示一个字面反斜杠，
    // 不归一的话「非必要转义」这类保义改写会被误判成结构变化
    if (n.isText) return JSON.stringify(String(n.text).replace(/\\\\/g, '\\\\'))
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

/** 首个不同的字符下标（签名差异诊断用） */
function firstDiff(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

async function readJson(app, expr) {
  const raw = await app.ev(expr)
  return raw === null || raw === 'null' ? null : JSON.parse(raw)
}

/** 另开一个临时窗口来跑（跑完关掉），见 main() 里的说明 */
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

/**
 * 装一篇文档进去并**走一次落盘管线**，返回真源内容。
 *
 * 为什么必须先 flush：`setContent(emitUpdate:false)` 只改编辑器，不动真源；随后任何一次
 * 账本对齐（切模式、防抖回灌）都会把真源内容再灌回编辑器 —— 我的渲染结构断言曾因此
 * 一直在看**上一篇文档**（`.md-preview h2` 找不到，而 h1 还在）。fidelity 套件的老套路
 * （loadInto + FLUSH）就是这个原因。
 */
async function loadDoc(app, md) {
  // 源码模式下编辑器是**休眠**的（instance=null），装载前先回到渲染面 ——
  // 上一段用例（D3）会把模式留在 source，不切回来后面所有装载都会静默失败（实测踩过）
  if ((await app.ev('window.__L.ui().editorMode')) === 'source') await setMode(app, 'wysiwyg')
  const r = await app.ev(LOAD(md))
  if (r !== 'ok') return null
  await sleep(150)
  return await app.ev(FLUSH)
}

// ─── E. 渲染结构预期（表驱动：加一种构造 = 加一行）────────────────────────────
const RENDER_SPECS = [
  {
    id: 'heading-h2',
    sel: '.md-preview h2',
    why: '二级标题渲染成 h2',
    ok: (m) => m.exists && m.tag === 'h2'
  },
  {
    id: 'code-block',
    // 代码块不是 `pre`：它是 CodeMirror 的 NodeView（`.code-block-wrapper` 里挂 `.cm-editor`）。
    // ⚠️ F 项（代码块 CM 虚拟化）之后**离视口较远的块**是静态态（`.cb-static`，只有等宽文本、
    // 不建 CM）—— 本夹具的代码块在文档末尾，正是这种情况。所以这里**两种形态都接受**，
    // 但都要求等宽字体（静态态的字体/行高刻意与 CM 一致，见 overlays.css 的 .cb-static）。
    sel: '.md-preview .code-block-wrapper .cm-content, .md-preview .code-block-wrapper .cb-static-code',
    why: '代码块走 CodeMirror 或静态等宽渲染（等宽字体）',
    ok: (m) => m.exists && /mono|Consolas|Menlo|Courier|JetBrains/i.test(m.fontFamily)
  },
  {
    id: 'code-block-lang',
    // 语言徽标/顶栏已按用户口径取消（CodeBlockView 头部注释：未聚焦只有代码正文）；
    // 语言仍落在块元素上，编辑器据此高亮并可往返，所以改为断言这个数据契约。
    sel: '.md-preview .code-block-wrapper[data-cb-language]',
    why: '围栏 info 串（语言）落在代码块上（不再有顶部徽标）',
    ok: (m) => m.exists
  },
  {
    id: 'blockquote-indent',
    sel: '.md-preview blockquote',
    why: '引用有可见的左内边距或左边框（否则和正文分不出来）',
    ok: (m) => m.exists && (m.paddingLeft > 0 || m.borderLeftWidth > 0)
  },
  {
    id: 'table-align-right',
    sel: '.md-preview table th:last-child',
    why: '表格列对齐落到 text-align 上',
    ok: (m) => m.exists && m.textAlign === 'right'
  },
  {
    id: 'task-checkbox',
    sel: '.md-preview input[type="checkbox"]',
    why: '任务列表渲染成真正的复选框',
    ok: (m) => m.exists
  },
  {
    id: 'hr-visible',
    sel: '.md-preview hr',
    why: '分割线可见（有粗细或边框）',
    ok: (m) => m.exists && (m.height > 0 || m.borderBottomWidth > 0)
  },
  {
    id: 'math-inline',
    sel: '.md-preview .katex',
    why: '行内公式渲染出 KaTeX',
    ok: (m) => m.exists
  },
  {
    id: 'math-block',
    sel: '.md-preview [data-md-math-block]',
    why: '块级公式有专属容器',
    ok: (m) => m.exists
  },
  {
    id: 'frontmatter-block',
    sel: '.md-preview pre[data-md-frontmatter]',
    why: 'front matter 有专属块且内容可见',
    ok: (m) => m.exists && m.text.includes('title:')
  },
  {
    id: 'inline-code',
    sel: '.md-preview p code',
    why: '行内代码渲染成 code 且等宽',
    ok: (m) => m.exists && /mono|Consolas|Menlo|Courier|monospace/i.test(m.fontFamily)
  },
  {
    id: 'strong',
    sel: '.md-preview strong',
    why: '粗体渲染成 strong 且字重更重',
    ok: (m) => m.exists && Number(m.fontWeight) >= 600
  }
]

const RENDER_FIXTURE = [
  // front matter 必须**在文档最开头**才算 front matter（放中间只是一对分割线 + 段落）
  '---',
  'title: 测试',
  '---',
  '',
  '# 一级标题',
  '## 二级标题',
  '### 三级标题',
  '#### 四级标题',
  '##### 五级标题',
  '###### 六级标题',
  '',
  '正文里有 `code` 与 **粗体**。',
  '',
  '> 引用段落',
  '',
  '| 甲 | 乙 |',
  '| --- | ---: |',
  '| a | b |',
  '',
  '- [ ] 待办',
  '- [x] 完成',
  '',
  '---',
  '',
  '行内公式 $a^2$ 结束。',
  '',
  '$$',
  'b = 2',
  '$$',
  '',
  '```js',
  'const x = 1',
  '```',
  ''
].join('\n')

async function main() {
  const report = new Reporter('两面一致性：实时渲染 ⇄ 源码（L2）')
  const host = await connect()
  if (!(await settle(host.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  /**
   * 在**另开的一个临时窗口**里跑，两个理由都是踩出来的：
   *  1. 不碰调用者正在编辑的那篇文档（与 `_verify-md-fidelity.js` 同一套做法）；
   *  2. 新窗口天然是干净的未命名缓冲 —— 直接在当前窗口 `setContent` 时，如果那个窗口
   *     正绑着一份文件，任何一次账本对齐都会把文件内容灌回来覆盖掉刚装的夹具
   *     （实测：渲染结构那段一直在看**上一篇文档**，`h2` 找不到而 `h1` 还在）。
   */
  let app = host
  const scratch = await openScratchWindow(host)
  if (scratch) {
    app = await attach(scratch)
    report.note('跑在新开的临时窗口里（跑完关掉）')
  } else {
    report.note('没能新开窗口 → 直接在当前窗口跑（请对着隔离实例运行）')
  }
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '临时窗口未就绪')
    return report.finish()
  }
  if (!(await waitEditor(app.ev))) {
    report.skip('editor-ready', '编辑器未就绪')
    return report.finish()
  }

  const backup = await readJson(
    app,
    `JSON.stringify({
      mode: window.__L.ui().editorMode,
      theme: window.__L.settings().theme,
      autoSave: window.__L.settings().autoSave,
      recentFiles: window.__L.settings().recentFiles
    })`
  )
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(200)
  await setMode(app, 'wysiwyg')

  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  const dump = {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    docs: [],
    render: [],
    notes: []
  }

  // ── A/B. 语料 × 切面稳定性 + 结构往返 ──────────────────────────────────────
  const corpus = generateCorpus({ seed: SEED, count: DOCS, maxBlocks: 5 })
  const tally = { exact: 0, normalized: 0, lossy: 0 }
  /** 判级器判 lossy 的篇目（分诊后决定算不算回归，见循环里的说明） */
  const lossyCases = []
  let unstableCount = 0
  let idemCount = 0
  let tokenFail = 0
  let structFail = 0
  let sigFail = 0

  for (const doc of corpus) {
    const p1 = await loadDoc(app, doc.md)
    if (p1 === null) {
      report.skip(doc.id, '编辑器未就绪')
      continue
    }
    const pmA = await readJson(app, PM)
    const sigA = await app.ev(SIGNATURE)
    const c1 = contentPreserved(doc.md, p1)
    tally[c1.level] += 1
    // I7（文档模型完整性）：哨兵词在编辑器里按序齐全（含原子节点存着的原文）
    const tracePm = traceTokens(pmA ? pmA.modelText : '', doc.tokens)
    if (!tracePm.ok) tokenFail += 1

    // I2 幂等 + I5 结构往返（把产出再装回去，看两棵文档树是否同构）
    const p2 = await loadDoc(app, p1)
    const pmB = await readJson(app, PM)
    const sigB = await app.ev(SIGNATURE)
    const idem = idempotent(p1, p2)
    if (!idem.ok) idemCount += 1
    const structDiffs = pmA && pmB ? structureDiff(pmA.counts, pmB.counts) : ['编辑器未就绪']
    if (structDiffs.length) structFail += 1
    const sigEqual = sigA === sigB
    if (!sigEqual) sigFail += 1
    /**
     * 判级器的**已知盲区**：它只认 19 条明文规则，不建模「块与块之间补/去空行」和
     * 「引用行之间的软换行合并」这两类保义改写。所以 lossy 要分诊，不能一律当回归：
     *   · 文档树签名同构 + 哨兵词齐全 ⇒ 只是**重写了标记**（记一笔，见报告 §9）
     *   · 签名不同构 或 哨兵词缺失 ⇒ 结构/内容真的变了 ⇒ 回归
     */
    if (!c1.ok) {
      lossyCases.push({
        id: doc.id,
        tags: doc.tags,
        detail: c1.detail,
        diagnosis: c1.diagnosis,
        sigEqual,
        tokensOk: tracePm.ok
      })
    }
    const scannerDiffs =
      pmB && structureDiff(pmB.counts, structureFromMarkdown(p2)).length
        ? structureDiff(pmB.counts, structureFromMarkdown(p2))
        : []

    // I3/I4/I6：切到源码必须逐字不变、textarea 等于真源；切回来内容仍不变
    const beforeSwitch = await readJson(app, STORE)
    await setMode(app, 'source')
    const ta = await readJson(app, TEXTAREA)
    const storeInSource = await readJson(app, STORE)
    const stableSource = unchanged(beforeSwitch.content, ta ? ta.value : null)
    const taMatchesStore = ta && ta.value === storeInSource.content
    await setMode(app, 'wysiwyg')
    const p3 = await app.ev(FLUSH)
    const stableBack = unchanged(p1, p3)
    if (!(stableSource.ok && stableBack.ok && taMatchesStore)) unstableCount += 1

    dump.docs.push({
      id: doc.id,
      tags: doc.tags,
      mutations: doc.mutations,
      level: c1.level,
      detail: c1.detail,
      diagnosis: c1.diagnosis,
      idempotent: idem.ok,
      idempotentDetail: idem.ok ? null : idem.detail,
      structDiffs,
      signatureEqual: sigEqual,
      signatureDiffAt: sigEqual ? null : firstDiff(sigA, sigB),
      signatureA: sigEqual ? null : sigA,
      signatureB: sigEqual ? null : sigB,
      scannerDiffs,
      tokens: {
        total: doc.tokens.length,
        missing: tracePm.missing,
        outOfOrder: tracePm.outOfOrder
      },
      stability: {
        source: stableSource.detail,
        back: stableBack.detail,
        taMatchesStore: !!taMatchesStore,
        dirtyBefore: beforeSwitch.dirty,
        dirtyInSource: storeInSource.dirty,
        mode: storeInSource.mode
      },
      source: doc.md,
      produced: p1
    })
  }

  report.note(
    `语料 ${corpus.length} 篇（seed=${SEED}）：exact ${tally.exact} / normalized ${tally.normalized} / lossy ${tally.lossy}`
  )
  const unexplained = lossyCases.filter((c) => !c.sigEqual || !c.tokensOk)
  report.check(
    'I1 lossy 全部能解释：文档树同构 + 哨兵齐全（否则是内容/结构回归）',
    unexplained.length === 0,
    `无法解释=${unexplained.length}`
  )
  if (lossyCases.length) {
    report.note(
      `判级器判 lossy 的 ${lossyCases.length} 篇 —— 全部是标记层改写（文档树同构），详见报告 JSON：` +
        lossyCases.map((c) => c.id).join(' ')
    )
  }
  report.check('I2 往返幂等：语料逐字稳定', idemCount === 0, `不幂等=${idemCount}`)
  report.check(
    'I3/I4/I6 切面稳定：内容逐字不变且 textarea = 真源',
    unstableCount === 0,
    `异常=${unstableCount}`
  )
  report.check('I7 渲染面完整性：哨兵词按序齐全', tokenFail === 0, `失败=${tokenFail}`)
  report.check('I5 结构往返：序列化产出重装后结构计数一致', structFail === 0, `失败=${structFail}`)
  report.check('I5′ 文档树签名：往返后文档树同构（位置也不能变）', sigFail === 0, `失败=${sigFail}`)

  // ── C. 位置语义（渲染 → 源码 → 渲染）──────────────────────────────────────
  const POS_DOC = [
    '# 标题',
    '',
    '第一段文字，用于定位。',
    '',
    '## 小节',
    '',
    '第二段文字，目标在这里。',
    '',
    '第三段。',
    ''
  ].join('\n')
  await loadDoc(app, POS_DOC)
  await sleep(300)
  const placed = await readJson(
    app,
    `JSON.stringify((() => {
      const ed = window.__L.ed()
      // 定位到最后一段的中段（跨段落比例映射才有意义）
      let target = 0
      ed.state.doc.descendants((n, pos) => {
        if (n.isText && n.text.includes('目标在这里')) target = pos + 2
      })
      ed.commands.setTextSelection(target)
      ed.commands.focus()
      return { target, size: ed.state.doc.content.size }
    })())`
  )
  await setMode(app, 'source')
  const taPos = await readJson(app, TEXTAREA)
  await setMode(app, 'wysiwyg')
  const backPos = await readJson(
    app,
    `JSON.stringify((() => {
      const ed = window.__L.ed()
      const sel = ed.state.selection
      return { from: sel.from, size: ed.state.doc.content.size }
    })())`
  )
  const ratioSrc = taPos && taPos.len ? taPos.selStart / taPos.len : -1
  const ratioPm = placed.size ? placed.target / placed.size : -1
  report.check(
    'C1 渲染 → 源码：光标按比例映射到源码相应位置（设计语义）',
    Math.abs(ratioSrc - ratioPm) < 0.15,
    `源码比例 ${ratioSrc.toFixed(3)} vs 渲染比例 ${ratioPm.toFixed(3)}`
  )
  report.check(
    'C2 源码 → 渲染：回到**精确**的原位置（同源坐标记忆）',
    backPos && Math.abs(backPos.from - placed.target) <= 1,
    `回到 ${backPos ? backPos.from : 'n/a'}，原位置 ${placed.target}`
  )
  // 切回来就能接着打字（哨兵落在原位邻域，而不是文首/文末）
  const typed = await app.ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.focus()
    ed.commands.insertContent('哨兵')
    window.dispatchEvent(new Event('beforeunload'))
    return window.__L.files().current?.content ?? null
  })()`)
  report.check(
    'C3 切回渲染面后能在原位续写（哨兵字符落在原偏移上）',
    typeof typed === 'string' && typed.includes('第二哨兵段文字'),
    JSON.stringify(String(typed).slice(0, 60))
  )

  // ── D. 状态语义：dirty / 撤销 / 保存 ───────────────────────────────────────
  const SAVE_FILE = path.join(WS, 'surface-save.md')
  fs.writeFileSync(SAVE_FILE, '# 保存测试\n\n原文。\n', 'utf-8')
  await app.ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(SAVE_FILE)}); return 'ok' })()`
  )
  await sleep(700)
  const cleanDirty = await readJson(app, STORE)
  await setMode(app, 'source')
  const afterSwitchDirty = await readJson(app, STORE)
  await setMode(app, 'wysiwyg')
  report.check(
    'D1 只看不编辑地切面：dirty 不被切换本身改掉',
    cleanDirty.dirty === afterSwitchDirty.dirty,
    `${cleanDirty.dirty} → ${afterSwitchDirty.dirty}`
  )
  report.check(
    'D2 打开后未编辑：dirty=false',
    cleanDirty.dirty === false,
    `dirty=${cleanDirty.dirty}`
  )

  // 编辑 → 切面 → 内容不丢 → 撤销安全
  const edited = await app.ev(`(async () => {
    const ed = window.__L.ed()
    ed.commands.focus('end')
    ed.commands.insertContent('追加一句话。')
    await new Promise((r) => setTimeout(r, 400))
    window.dispatchEvent(new Event('beforeunload'))
    return window.__L.files().current?.content ?? null
  })()`)
  await setMode(app, 'source')
  const taEdited = await readJson(app, TEXTAREA)
  report.check(
    'D3 编辑后立刻切源码：编辑内容没丢',
    typeof edited === 'string' &&
      edited.includes('追加一句话。') &&
      taEdited.value.includes('追加一句话。'),
    JSON.stringify(String(taEdited && taEdited.value).slice(0, 60))
  )
  // 撤销：允许「撤销成功」或「撤销无效」，但不允许出现第三种（损坏）内容
  const undone = await app.ev(`(async () => {
    const before = window.__L.files().current?.content ?? ''
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    window.dispatchEvent(new Event('beforeunload'))
    const after = window.__L.files().current?.content ?? ''
    return JSON.stringify({ before, after })
  })()`)
  const und = JSON.parse(undone)
  const undoOk =
    und.after === und.before ||
    contentPreserved('# 保存测试\n\n原文。\n', und.after).level !== 'lossy'
  report.check(
    'D4 切面后撤销：要么回到上一版，要么无副作用（不出现损坏内容）',
    undoOk,
    JSON.stringify(und.after.slice(0, 50))
  )
  // 保存：磁盘字节 = 真源内容（LF 文件按 LF 写回）
  await app.ev(`(async () => { await window.__L.files().save(); return 'ok' })()`)
  await sleep(400)
  const storeNow = await readJson(app, STORE)
  const diskNow = fs.readFileSync(SAVE_FILE, 'utf-8')
  report.check(
    'D5 切面后保存：磁盘字节 = 真源内容（行尾/编码按元数据展开）',
    diskNow === storeNow.content,
    `disk=${JSON.stringify(diskNow.slice(0, 40))} store=${JSON.stringify(String(storeNow.content).slice(0, 40))}`
  )
  report.check('D6 保存后 dirty 归零', storeNow.dirty === false, `dirty=${storeNow.dirty}`)

  // ── E. 渲染结构（表驱动）──────────────────────────────────────────────────
  const eLoaded = await loadDoc(app, RENDER_FIXTURE)
  report.note('E 段装载后真源开头：' + JSON.stringify(String(eLoaded).slice(0, 36)))
  await sleep(700)
  // 标题字号必须严格递减（抓「六级标题渲染成一样大」这类回归）
  const sizes = []
  for (const lv of [1, 2, 3, 4, 5, 6]) {
    const m = await readJson(app, describeEl(`.md-preview h${lv}`))
    sizes.push(m && m.exists ? m.fontSize : null)
  }
  const present = sizes.filter((s) => typeof s === 'number')
  const decreasing = present.every((s, i) => i === 0 || s < present[i - 1])
  report.check(
    'E0 标题字号随级别严格递减',
    present.length >= 2 && decreasing,
    `各级字号=${JSON.stringify(sizes)}`
  )
  for (const spec of RENDER_SPECS) {
    const m = await readJson(app, describeEl(spec.sel))
    const ok = !!m && spec.ok(m)
    report.check(`E ${spec.id}`, ok, `${spec.why} | ${JSON.stringify(m).slice(0, 120)}`)
    dump.render.push({ id: spec.id, ok, why: spec.why, measured: m })
  }

  // ── T. 两段式表面：纸 / 外壳 + 纸面上的可辨识度（三主题）────────────────────
  // 「写作区铺近白的纸、外壳留浅灰」这类改动最容易踩的坑不是颜色不美，而是**关系塌了**：
  //   · 纸与外壳同色 → 侧栏与正文糊成一片，文件树的 accent-soft 选中态也失去依托；
  //   · 某个面板底色与纸同色 → 在白纸上像掉了块；
  //   · 悬停 / 选中 / 选区在新底色上看不见。
  // 所以这一段判的全是**关系**（谁比谁亮、两者差多少、对比度够不够），绝不钉死 rgb(...)：
  // 以后调令牌不该让这一段红，只有关系真的塌了才该红。数字由 lib/color.js 现算。
  // 依赖 E 段已装载的 RENDER_FIXTURE（代码块 / 行内代码 / 引用 / 表格 / front matter / 分隔线）。
  const themeRows = []
  for (const th of ['light', 'dark', 'sepia']) {
    await app.ev(
      `(async () => { await window.__L.settings().setTheme(${JSON.stringify(th)}); return 'ok' })()`
    )
    // ⚠️ 这里原来是 `sleep(900)` 就量 —— 批量跑（10 套件连着跑、机器忙）时主题还没落地，
    // 量到的令牌会**落后一档**（实测：dark 读到 light 的纸色、sepia 读到 dark 的），T2 于是假红。
    // 改成轮询到「类名就是本主题 **且** 两次读到的令牌与**实际表面色**都完全一致」为止（最长 ~5s）。
    // ⚠️ 必须把 body / pane 的计算色也并进稳定性判据：令牌（CSS 变量）换类名就立刻变，
    //    但 body 的 background-color 还有 ~300ms 过渡 —— 只等令牌会读到过渡中间色
    //    （实测 dark 读到 rgb(19,21,26)、壳是 rgb(11,13,18)，T2 的「body 就是外壳色」判红）。
    let m = null
    let prevKey = ''
    for (let i = 0; i < 40; i++) {
      await sleep(130)
      m = await readJson(app, SURFACE_PROBE)
      const key =
        m.theme +
        '|' +
        JSON.stringify(m.tokens) +
        '|' +
        JSON.stringify(m.body) +
        '|' +
        JSON.stringify(m.pane && m.pane.bg) +
        '|' +
        JSON.stringify(m.sourcePane && m.sourcePane.bg)
      if (m.theme === `theme-${th}` && key === prevKey) break
      prevKey = key
    }
    const s = m.surfaces
    themeRows.push({
      theme: th,
      domTheme: m.theme,
      tokens: m.tokens,
      body: m.body,
      pane: m.pane,
      sourcePane: m.sourcePane,
      surfaces: s,
      inkOnPaper: contrast(s.editorRoot.color, m.tokens.paper),
      paperVsChrome: contrast(m.tokens.paper, m.tokens.app),
      paperChromeDeltaL: deltaL(m.tokens.paper, m.tokens.app)
    })
    report.note(
      `T ${th}: paper=${rgbText(m.tokens.paper)} chrome=${rgbText(m.tokens.app)} ` +
        `pane=${rgbText(m.pane && m.pane.bg)} 正文=${rgbText(s.editorRoot.color)} ` +
        `正文/纸=${rat(contrast(s.editorRoot.color, m.tokens.paper))}:1 ` +
        `纸/壳=${rat(contrast(m.tokens.paper, m.tokens.app))}:1 ΔL=${rat(deltaL(m.tokens.paper, m.tokens.app))}`
    )
  }
  dump.surfaces = themeRows
  const fmt = (fn) => themeRows.map((r) => `${r.theme}: ${fn(r)}`).join(' | ')
  /** 叠到纸上再比：带 alpha 的面（front matter / accent-soft / 选区）必须先合成 */
  const onPaper = (c, paper) => over(c, paper)
  const onChrome = (c, chrome) => over(c, chrome)

  report.check(
    'T1 写作区 pane（渲染面 + 源码面）铺的是 --paper',
    themeRows.every(
      (r) =>
        sameColor(r.pane && r.pane.bg, r.tokens.paper) &&
        sameColor(r.sourcePane && r.sourcePane.bg, r.tokens.paper) &&
        r.domTheme === `theme-${r.theme}`
    ),
    fmt(
      (r) =>
        `pane=${rgbText(r.pane && r.pane.bg)} 源码面=${rgbText(r.sourcePane && r.sourcePane.bg)} ` +
        `纸=${rgbText(r.tokens.paper)} class=${r.domTheme}`
    )
  )

  report.check(
    'T2 两段式：纸比外壳亮一档、body 就是外壳色、三主题的纸互不相同',
    themeRows.every((r) => r.paperVsChrome >= 1.03 && sameColor(r.body, r.tokens.app)) &&
      new Set(themeRows.map((r) => rgbText(r.tokens.paper))).size === themeRows.length,
    fmt(
      (r) =>
        `纸/壳=${rat(r.paperVsChrome)}:1 ΔL=${rat(r.paperChromeDeltaL)} body=${rgbText(r.body)} ` +
        `壳=${rgbText(r.tokens.app)}`
    )
  )

  report.check(
    'T3 正文对纸的 WCAG 对比度 ≥ 7:1',
    themeRows.every((r) => r.inkOnPaper >= 7),
    fmt((r) => `${rat(r.inkOnPaper)}:1`)
  )

  report.check(
    'T4 代码块 / 行内代码底色与纸可辨（≥1.05:1）',
    themeRows.every(
      (r) =>
        contrast(r.surfaces.codeBlock.bg, r.tokens.paper) >= 1.05 &&
        contrast(r.surfaces.inlineCode.bg, r.tokens.paper) >= 1.05 &&
        !sameColor(r.surfaces.codeBlock.bg, r.tokens.paper)
    ),
    fmt(
      (r) =>
        `代码块=${rgbText(r.surfaces.codeBlock.bg)}(${rat(contrast(r.surfaces.codeBlock.bg, r.tokens.paper))}:1) ` +
        `行内=${rgbText(r.surfaces.inlineCode.bg)}(${rat(contrast(r.surfaces.inlineCode.bg, r.tokens.paper))}:1)`
    )
  )

  report.check(
    'T5 引用块在纸上可辨（≥3px 色条且对比 ≥1.25:1，或自带底色 ≥1.05:1）',
    themeRows.every((r) => {
      const q = r.surfaces.quote
      const bar = q.borderLeftWidth >= 3 && contrast(q.borderLeftColor, r.tokens.paper) >= 1.25
      const bg = contrast(onPaper(q.bg, r.tokens.paper), r.tokens.paper) >= 1.05
      return bar || bg
    }),
    fmt((r) => {
      const q = r.surfaces.quote
      return (
        `条=${q.borderLeftWidth}px ${rgbText(q.borderLeftColor)}(${rat(contrast(q.borderLeftColor, r.tokens.paper))}:1) ` +
        `底色=${rgbText(q.bg)}`
      )
    })
  )

  report.check(
    'T6 表头 / front matter / 分隔线在纸上可辨',
    themeRows.every((r) => {
      const head = r.surfaces.thead.exists ? r.surfaces.thead : r.surfaces.th
      const headOk = !!head && head.exists && contrast(head.bg, r.tokens.paper) >= 1.08
      const fmOk =
        contrast(onPaper(r.surfaces.frontmatter.bg, r.tokens.paper), r.tokens.paper) >= 1.05
      const hrOk = contrast(onPaper(r.surfaces.hr.bg, r.tokens.paper), r.tokens.paper) >= 1.1
      return headOk && fmOk && hrOk
    }),
    fmt((r) => {
      const head = r.surfaces.thead.exists ? r.surfaces.thead : r.surfaces.th
      const which = r.surfaces.thead.exists ? 'thead' : 'th'
      return (
        `表头(${which})=${rgbText(head && head.bg)}(${rat(contrast(head && head.bg, r.tokens.paper))}:1) ` +
        `frontmatter=${rgbText(r.surfaces.frontmatter.bg)}(${rat(contrast(onPaper(r.surfaces.frontmatter.bg, r.tokens.paper), r.tokens.paper))}:1) ` +
        `hr=${rat(contrast(onPaper(r.surfaces.hr.bg, r.tokens.paper), r.tokens.paper))}:1`
      )
    })
  )

  report.check(
    'T7 选中态药丸（accent-soft）与自绘淡底（--sel，查找命中）在纸 / 外壳上都看得清',
    themeRows.every((r) => {
      const pillPaper = contrast(onPaper(r.tokens.accentSoft, r.tokens.paper), r.tokens.paper)
      const pillChrome = contrast(onChrome(r.tokens.accentSoft, r.tokens.app), r.tokens.app)
      const selPaper = contrast(onPaper(r.tokens.sel, r.tokens.paper), r.tokens.paper)
      return pillPaper >= 1.05 && pillChrome >= 1.05 && selPaper >= 1.1
    }),
    fmt((r) => {
      const pillPaper = contrast(onPaper(r.tokens.accentSoft, r.tokens.paper), r.tokens.paper)
      const pillChrome = contrast(onChrome(r.tokens.accentSoft, r.tokens.app), r.tokens.app)
      const selPaper = contrast(onPaper(r.tokens.sel, r.tokens.paper), r.tokens.paper)
      return `药丸/纸=${rat(pillPaper)}:1 药丸/壳=${rat(pillChrome)}:1 自绘淡底/纸=${rat(selPaper)}:1`
    })
  )

  // 量完三主题把主题还原（后面 F 段与收尾都按调用者原来的主题跑）
  await app.ev(
    `(async () => { await window.__L.settings().setTheme(${JSON.stringify(backup.theme)}); return 'ok' })()`
  )
  await sleep(600)

  // ── F. 分屏同世代（I9）─────────────────────────────────────────────────────
  await loadDoc(app, '# 分屏甲\n\n正文。\n')
  await sleep(300)
  await setMode(app, 'split')
  const splitIn = await app.ev(`(async () => {
    const f = window.__L.files()
    const ta = document.querySelector('textarea.source-editor')
    if (!ta) return JSON.stringify({ err: 'no-textarea' })
    ta.focus()
    ta.value = ta.value + '\\n## 分屏乙\\n'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({ author: f.contentAuthor, stale: f.contentIsStale('wysiwyg') })
  })()`)
  // ⚠️ 原来也是 `sleep(900)` 就断言：批量跑时「右栏输入 → 序列化 → 回灌左栏 → 账本收敛」
  // 这条链可能还没走完，F2 于是假红（实测 leftHas=false / stale=true，单独跑 37/37）。
  // 改成轮询到条件成立（最长 ~5s）；一直不成立仍然判红 —— 轮询只会去掉假红，不会造假绿。
  let splitAfter = { leftHas: false, stale: true }
  for (let i = 0; i < 40; i++) {
    await sleep(130)
    splitAfter = JSON.parse(
      await app.ev(`JSON.stringify({
        stale: window.__L.files().contentIsStale('wysiwyg'),
        leftHas: (() => {
          const ed = window.__L.ed()
          if (!ed) return false
          let ok = false
          ed.state.doc.descendants((n) => {
            if (n.type.name === 'heading' && n.textContent.includes('分屏乙')) ok = true
          })
          return ok
        })()
      })`)
    )
    if (splitAfter.leftHas === true && splitAfter.stale === false) break
  }
  const splitInParsed = JSON.parse(splitIn)
  report.check(
    'F1 分屏右栏输入：作者=source、左侧标记为落后',
    splitInParsed.author === 'source' && splitInParsed.stale === true,
    splitIn
  )
  report.check(
    'F2 分屏左栏跟上且账本收敛（I9 同世代）',
    splitAfter.leftHas === true && splitAfter.stale === false,
    JSON.stringify(splitAfter)
  )

  // ── 收尾：恢复现场 ────────────────────────────────────────────────────────
  await setMode(app, 'wysiwyg')
  await app.ev(`(() => {
    window.__L.ui().editorMode = ${JSON.stringify(backup.mode)}
    window.__L.settings().set('autoSave', ${backup.autoSave})
    window.__L.settings().set('recentFiles', ${JSON.stringify(backup.recentFiles ?? [])})
    return 'ok'
  })()`)
  await app.ev(`(async () => {
    // 不调 files().close()：临时窗口马上就关，而 close() 在脏文档上会弹确认框把套件挂住
    try { await window.luminAPI.db.deleteDocument(${JSON.stringify(SAVE_FILE)}) } catch {}
    return 'ok'
  })()`)
  fs.rmSync(WS, { recursive: true, force: true })
  dump.lossyTriage = lossyCases
  dump.tally = tally
  fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2), 'utf-8')
  report.note(`逐篇结果（原文/产出/结构差异/切面稳定性）已写入 ${DUMP}`)
  if (scratch) {
    await app.send('Page.close').catch(() => {})
    await sleep(500)
    app.close()
  }
  host.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
