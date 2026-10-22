'use strict'
// 验收（审计 P2「5MB 保存把软换行合并」）：20,000 行 / ~5.2MB 文档的保存往返。
//
// 复现：造一份 20,000 行、混合段落/列表/代码块/表格的 Markdown → 打开 → 切成实时渲染
// → 量 `getMarkdown()`、直接保存、以及"走一次编辑器归一化再保存"三段的**行数与字节**。
//
// 验收口径：
//   ① `getMarkdown()` 与磁盘**逐字节相同**（行数 20,000 → 20,000）；
//   ② 不改内容直接保存：磁盘字节完全不变；
//   ③ 编辑器归一化后保存：行数不减少、`getMarkdown()` 与落盘一致。
//
// 跑法：`node tools/_verify-bigdoc-save.js`（自管隔离实例，端口 9545，不碰用户实例）。
delete process.env.ELECTRON_RUN_AS_NODE

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  spawnApp,
  startIsolated,
  fatal
} = require('./lib/harness')

const PORT = 9545
const UD = path.join(os.tmpdir(), 'lumin-bigdoc-ud')
const FILE = path.join(os.tmpdir(), 'lumin-bigdoc-20k.md')
const TARGET_LINES = 20000

const lineCount = (s) =>
  s.endsWith('\n') ? s.slice(0, -1).split('\n').length : s.split('\n').length

/** 20,000 行 / ~5.2MB；结构是**规范形态**（单空行分块、`- ` 列表、`| --- |` 表格），
 *  这样"逐字节相同"是可达的，而不是拿规范化差异当借口。 */
function makeFixture() {
  const cjk = (ch, n) => ch.repeat(n)
  const lines = []
  let block = 0
  while (lines.length < TARGET_LINES) {
    block += 1
    lines.push(`## 第 ${block} 节：大文档往返`, '')
    for (let i = 0; i < 6; i += 1) lines.push(`${cjk('字', 240)}第${block}段第${i + 1}行。`)
    lines.push(
      '',
      `- 第一项 ${cjk('甲', 150)}`,
      `- 第二项 ${cjk('乙', 150)}`,
      `  - 嵌套项 ${cjk('丙', 150)}`,
      `- 第三项 ${cjk('丁', 150)}`,
      ''
    )
    lines.push('| 列一 | 列二 | 列三 |', '| --- | --- | --- |')
    for (let i = 0; i < 4; i += 1) lines.push(`| 值 ${i} | ${cjk('数', 70)} | ${block} |`)
    lines.push(
      '',
      '```js',
      `const block${block} = { index: ${block} }`,
      `function run${block}(input) {`,
      '  return input.map((x) => x + 1)',
      '}',
      '```',
      ''
    )
    lines.push(
      `${cjk('尾', 200)}结束第${block}节。`,
      `${cjk('尾', 200)}结束第${block}节第二行。`,
      ''
    )
  }
  const exact = lines.slice(0, TARGET_LINES)
  if (!exact[exact.length - 1]) exact[exact.length - 1] = '结束行。'
  const text = exact.join('\n').replace(/\n+$/, '\n')
  fs.writeFileSync(FILE, text, 'utf8')
  return text
}

async function main() {
  const report = new Reporter('大文档保存：20,000 行文本 getMarkdown / 保存前后逐字节一致')
  const source = makeFixture()
  const sourceBytes = Buffer.from(source, 'utf8')
  fs.rmSync(UD, { recursive: true, force: true })
  startIsolated({ userData: UD, port: PORT, cleanupOnly: true })
  const proc = spawnApp({ userData: UD, port: PORT, env: { LUMIN_TRUSTED_PATHS: os.tmpdir() } })
  let w = null
  try {
    w = await connect({ port: PORT, timeoutMs: 60000 }).catch(() => null)
    if (!w) {
      report.skip('实例', '隔离实例没起来（端口 9545）')
      return report.finish()
    }
    const { ev } = w
    if (!(await settle(ev))) {
      report.skip('实例', '页面没就绪')
      return report.finish()
    }
    await ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
    await ev(`(() => {
      window.__OPEN_DONE = false
      window.__L.files().openPath(${JSON.stringify(FILE)})
        .catch(() => {})
        .finally(() => { window.__OPEN_DONE = true })
      return 'ok'
    })()`)
    let prompted = false
    for (let i = 0; i < 150; i += 1) {
      if (await ev(`!!window.__L.ui().tripleState`)) {
        prompted = true
        await ev(`(() => { window.__L.ui().resolveTriple('alt'); return 'ok' })()`)
        break
      }
      if (await ev(`window.__OPEN_DONE === true`)) break
      await sleep(200)
    }
    for (let i = 0; i < 200; i += 1) {
      const ok = await ev(
        `window.__L.files().current?.path?.toLowerCase() === ${JSON.stringify(FILE.toLowerCase())}`
      )
      if (ok) break
      await sleep(200)
    }
    report.check(
      'bigdoc-opened',
      await ev(
        `window.__L.files().current?.path?.toLowerCase() === ${JSON.stringify(FILE.toLowerCase())}`
      ),
      `大文档提示=${prompted}`
    )
    // 打开时可能被降级到源码模式；切到实时渲染才是"整篇解析成 PM 文档"那条路
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await waitEditor(ev, 60000)
    await sleep(2500)
    const raw = await ev(
      `(() => { const ed = window.__L.ed(); return ed ? ed.storage.markdown.getMarkdown() : null })()`
    )
    report.check(
      'getMarkdown-keeps-lines',
      typeof raw === 'string' && lineCount(raw) === lineCount(source),
      `getMarkdown ${raw === null ? 'null' : lineCount(raw)} 行 / 原文 ${lineCount(source)} 行`
    )
    report.check(
      'getMarkdown-equals-disk',
      raw === source,
      `getMarkdown ${raw === null ? 0 : Buffer.byteLength(raw)}B / 磁盘 ${sourceBytes.length}B`
    )

    // ② 不改内容直接保存
    await ev(`window.__L.files().save()`)
    await sleep(800)
    const afterDirect = fs.readFileSync(FILE)
    report.check(
      'direct-save-keeps-bytes',
      afterDirect.equals(sourceBytes),
      `保存后 ${afterDirect.length}B / 原文 ${sourceBytes.length}B`
    )
    report.check(
      'direct-save-keeps-lines',
      lineCount(afterDirect.toString('utf8')) === lineCount(source),
      `保存后 ${lineCount(afterDirect.toString('utf8'))} 行`
    )

    // ③ 走一次编辑器归一化（等价于"动一下再撤销"）：再保存仍不得减少行数
    await ev(
      `(() => { window.__L.files().setContent(${JSON.stringify(raw ?? '')}, 'wysiwyg'); return 'ok' })()`
    )
    await sleep(300)
    await ev(`window.__L.files().save()`)
    await sleep(800)
    const afterNorm = fs.readFileSync(FILE)
    const normText = afterNorm.toString('utf8')
    report.check(
      'normalized-save-keeps-lines',
      lineCount(normText) >= lineCount(source),
      `归一化保存后 ${lineCount(normText)} 行 / 原文 ${lineCount(source)} 行`
    )
    report.check(
      'normalized-save-getMarkdown-equals-disk',
      normText === raw,
      `落盘 ${afterNorm.length}B / getMarkdown ${raw === null ? 0 : Buffer.byteLength(raw)}B`
    )
  } finally {
    try {
      if (w) w.close()
    } catch {
      /* ignore */
    }
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    startIsolated({ userData: UD, port: PORT, cleanupOnly: true })
  }
  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
