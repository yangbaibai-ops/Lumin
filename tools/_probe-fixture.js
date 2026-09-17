'use strict'
// ─── 取证探针（一次性，非套件）：用户报障段落的三条写入路径 ──────────────────────
//
// 目的：把「哪些 `**` 没变 strong、它们变成了什么」钉死在数据上。
// 跑法：node tools/run-suites.js --suite=_probe-fixture.js
//
// 每条路径都打印：doc.textContent / 每个 text 节点的文本+marks / getMarkdown() /
// .md-preview 里 strong 的个数与每个 strong 的 textContent / 字面量与转义标记的个数。
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const {
  connect,
  settle,
  waitEditor,
  sleep,
  openDocWith,
  pressKey,
  fatal
} = require('./lib/harness')

const FIXTURE =
  '**一句话**：这是一个**工程素养明显高于平均水平**的桌面应用 —— 安全基线正确、踩坑记录齐全、验收文化扎实、冷启动实测不到 1 秒；但它把最重的风险押在了**「保存路径」与「Markdown 保真」**这两件写作工具的信：**写盘不是原子操作、没有本地历史、没有任何往返保真验收**。工程侧最拖后腿的是 **`npm run lint` 目前是坏的（912 errors）**、**没有 CI / 没有单元测试**、以及**验收脚本没有统一入口**。'

/** 最小复现候选（逐条单独喂） */
const MINIS = [
  '**「保存路径」与「Markdown 保真」**',
  '押在了**「保存路径」与「Markdown 保真」**这两件',
  '**`npm run lint` 目前是坏的（912 errors）**',
  '的是 **`npm run lint` 目前是坏的（912 errors）**',
  '**验收脚本没有统一入口**',
  '以及**验收脚本没有统一入口**。',
  '**2****2**',
  '**加粗**'
]

const DUMP = `(() => {
  const ed = window.__L.ed()
  if (!ed) return JSON.stringify({ err: 'no-editor' })
  const nodes = []
  ed.state.doc.descendants((n, pos) => {
    if (!n.isText) return
    nodes.push({
      pos,
      text: n.text,
      marks: n.marks.map((m) => {
        const a = m.attrs || {}
        if (m.type.name === 'mdMarker') return 'mdMarker(' + a.style + '/' + a.side + ')'
        if (m.type.name === 'mdStyle') return 'mdStyle(' + (a.styles || []).join('+') + ')'
        return m.type.name
      })
    })
  })
  const pm = document.querySelector('.ProseMirror')
  const strongs = pm ? [...pm.querySelectorAll('strong')] : []
  const markers = pm ? [...pm.querySelectorAll('.md-marker')] : []
  return JSON.stringify({
    docText: ed.state.doc.textContent,
    nodes,
    strongs: strongs.map((s) => s.textContent),
    literalMarkers: markers.filter((m) => m.dataset.side === 'literal').length,
    allMarkers: markers.length,
    escapeSpans: pm ? pm.querySelectorAll('.md-escape-backslash').length : -1,
    escapeChars: pm ? pm.querySelectorAll('.md-escape-char').length : -1,
    pHtml: pm ? [...pm.querySelectorAll('p')].map((p) => p.outerHTML).join('\\n') : null
  })
})()`

const FLUSH = `(() => {
  window.dispatchEvent(new Event('beforeunload'))
  return window.__L.files().current?.content ?? null
})()`

let app = null
const lines = []
function out(s) {
  lines.push(s)
  console.log(s)
}

async function snapshot(label) {
  const raw = JSON.parse(await app.ev(DUMP))
  const md = await app.ev(FLUSH)
  out(`\n────── ${label} ──────`)
  out(`docText : ${JSON.stringify(raw.docText)}`)
  out(`getMarkdown: ${JSON.stringify(md)}`)
  out(`strong(${raw.strongs.length}): ${JSON.stringify(raw.strongs)}`)
  out(
    `literalMarkers=${raw.literalMarkers} allMarkers=${raw.allMarkers} escBS=${raw.escapeSpans} escChars=${raw.escapeChars}`
  )
  out(
    `nodes   : ${raw.nodes.map((n) => `${JSON.stringify(n.text)}<${n.marks.join(',')}>`).join(' ')}`
  )
  out(`pHtml   : ${raw.pHtml}`)
  return { raw, md }
}

async function openDoc(md) {
  await openDocWith(app, md)
  await sleep(600)
}

/** 真实剪贴板粘贴（与 _verify-inline-formats 同法） */
function writeClipboard(text) {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`],
    { stdio: 'ignore' }
  )
}
function readClipboard() {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], {
      encoding: 'utf-8',
      timeout: 8000
    })
  } catch {
    return null
  }
}

async function caretAt(offset, attempts = 8) {
  const expr = `(() => {
    const ed = window.__L.ed()
    const pm = document.querySelector('.ProseMirror')
    if (pm) pm.focus()
    const $f = ed.state.selection.$from
    let start = -1
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).isTextblock) { start = $f.start(d); break }
    ed.commands.focus(start + ${offset})
    return ed.isFocused ? 'ok' : 'NO-FOCUS'
  })()`
  for (let i = 0; i < attempts; i++) {
    const r = await app.ev(expr)
    if (r === 'ok') {
      await sleep(120)
      return
    }
    await sleep(250)
  }
  throw new Error('NO-FOCUS')
}

async function typeChars(text) {
  for (const ch of text) {
    await app.send('Input.insertText', { text: ch })
    await sleep(25)
  }
  await sleep(200)
}

async function main() {
  app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')

  const backup = JSON.parse(
    await app.ev(`JSON.stringify({ autoSave: window.__L.settings().autoSave })`)
  )
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(150)

  out(`夹具长度 = ${FIXTURE.length} 字符`)

  // ① 一次性 setContent（装载路径 / openDocWith）
  await openDoc(FIXTURE + '\n')
  await snapshot('① 装载（openDocWith = markdown-it 解析整篇）')

  // ② 逐字键入
  await openDoc('\n')
  await caretAt(0)
  await typeChars(FIXTURE)
  await snapshot('② 逐字键入')

  // ②b 一次性 insertContent（同一写入路径，无逐字中间态）
  await openDoc('\n')
  await caretAt(0)
  await app.ev(
    `(() => { window.__L.ed().commands.insertContent(${JSON.stringify(FIXTURE)}); return 'ok' })()`
  )
  await sleep(400)
  await snapshot('②b 一次性 insertContent')

  // ③ 真实 Ctrl+V
  const saved = readClipboard()
  if (saved === null) {
    out('\n(剪贴板不可用，跳过 ③)')
  } else {
    await openDoc('\n')
    await caretAt(0)
    writeClipboard(FIXTURE)
    await sleep(250)
    await pressKey(app.send, { key: 'v', code: 'KeyV', vk: 86, modifiers: 2 })
    await sleep(600)
    await snapshot('③ 真实 Ctrl+V 粘贴')
    try {
      writeClipboard(saved)
    } catch {
      /* ignore */
    }
  }

  // ④ 最小复现候选（装载路径）
  for (const m of MINIS) {
    await openDoc(m + '\n')
    const { raw } = await snapshot(`④ 装载最小复现 ${JSON.stringify(m)}`)
    out(`   ⇒ strong=${JSON.stringify(raw.strongs)} literalMarkers=${raw.literalMarkers}`)
  }

  // ⑤ 最小复现候选（逐字键入路径）
  for (const m of ['押在了**「保存路径」与「Markdown 保真」**这两件', '**2****2**']) {
    await openDoc('\n')
    await caretAt(0)
    await typeChars(m)
    const { raw } = await snapshot(`⑤ 键入最小复现 ${JSON.stringify(m)}`)
    out(`   ⇒ strong=${JSON.stringify(raw.strongs)} literalMarkers=${raw.literalMarkers}`)
  }

  await app.ev(
    `(() => { window.__L.settings().set('autoSave', ${JSON.stringify(backup.autoSave)}); return 'ok' })()`
  )
  app.close()

  const dest = path.join(__dirname, '..', 'out', '_probe-fixture.txt')
  fs.writeFileSync(dest, lines.join('\n'), 'utf-8')
  console.log('\n(完整输出已写入 ' + dest + ')')
  console.log('--- 1/1 PASS')
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
