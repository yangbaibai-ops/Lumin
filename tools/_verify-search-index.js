'use strict'
// 验收：全局搜索的**索引**与**命中定位**（审计 §7 第 17 条）
//
// 原问题两条：
//   ① 只搜「被打开或保存过」的文档 —— 工作区里从未打开过的 .md 搜不到（承诺大于实际）；
//   ② 点结果只把文件打开，不落到命中处（用户还得再 Ctrl+F 一次）。
//
// 判据：
//   1. 造一个工作区，里面有一篇 **Lumin 从未打开过** 的文档，正文含一个只出现在那里的词；
//   2. 打开工作区后（后台索引）**不开那篇文档**，直接全局搜索该词 → 必须命中它；
//   3. 点这条结果 → 文档被打开，且**查找栏已带着该查询、并选中了第一处命中**（定位到命中处）；
//   4. 再跑一次 `reindex()` → `indexed` 应远小于 `scanned`（没变的文件被 mtime 跳过，不重复读盘）。
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')
const os = require('os')
const path = require('path')
const fs = require('fs')

/** 只出现在"从未打开过"那篇里的词（正文与文件名都不含它的话就成了另一回事） */
const NEEDLE = 'zephyrmarker9381'

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const report = new Reporter('全局搜索：后台索引（含从未打开的文档）+ 命中定位')
  const { ev } = app

  // ── 夹具：一篇已打开过的 + 一篇从未打开过的（后者才是这条的重点）─────────────
  const ws = path.join(os.tmpdir(), 'lumin-search-index-ws')
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true })
  const openedDoc = path.join(ws, 'opened.md')
  const neverOpened = path.join(ws, 'notes', 'never-opened.md')
  fs.writeFileSync(openedDoc, '# 打开过的\n\n普通正文。\n', 'utf-8')
  // 关键：这篇**只存在于磁盘上**，Lumin 不会去打开它
  fs.writeFileSync(
    neverOpened,
    `# 从未打开过的一篇\n\n这是一段只有磁盘上才有的正文，里面藏着 ${NEEDLE} 这个词。\n`,
    'utf-8'
  )

  // 打开工作区（会触发后台索引）
  await ev(
    `(async () => { await window.__L.files().setRoot(${JSON.stringify(ws)}); return 'ok' })()`
  )
  // 只打开"打开过的那篇"，**绝不**碰 never-opened.md
  await ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(openedDoc)}); return 'ok' })()`
  )
  await sleep(1500)
  report.check(
    'never-opened-doc-not-open-in-editor',
    (await ev(`window.__L.files().current?.path`)) === openedDoc,
    String(await ev(`window.__L.files().current?.path`))
  )

  // ── 等后台索引跑完（轮询 status，最多 ~20s）────────────────────────────────
  // ⚠️ `Runtime.evaluate` 里的表达式**不能有顶层 await**（不是 async 上下文）：
  // 会报 "SyntaxError: missing ) after argument list" 这种误导性的错。一律包成 async IIFE。
  let status = null
  for (let i = 0; i < 40; i += 1) {
    status = JSON.parse(
      String(
        await ev(`(async () => JSON.stringify(await window.luminAPI.workspace.indexStatus()))()`)
      )
    )
    if (status.running === false && status.scanned > 0) break
    await sleep(500)
  }
  report.check(
    'background-index-ran',
    !!status && status.root === ws && status.scanned >= 2 && status.indexed >= 2,
    JSON.stringify(status)
  )

  // ── ① 从未打开过的文档能被搜到（这就是本条的核心）──────────────────────────
  const results = JSON.parse(
    String(
      await ev(
        `(async () => JSON.stringify(await window.luminAPI.db.search(${JSON.stringify(NEEDLE)}, 10)))()`
      )
    )
  )
  report.check(
    'never-opened-doc-is-searchable',
    results.length === 1 && results[0].path === neverOpened,
    JSON.stringify(results.map((r) => r.path))
  )
  report.check(
    'result-carries-snippet',
    typeof results[0]?.bodySnippet === 'string' && results[0].bodySnippet.includes(NEEDLE),
    JSON.stringify(results[0]?.bodySnippet)
  )

  // ── ② 索引只收文档、不收别的文件；且不污染"最近文档" ────────────────────────
  fs.writeFileSync(path.join(ws, 'ignore-me.txt.bak'), 'x', 'utf-8')
  fs.writeFileSync(path.join(ws, 'real.txt'), `# 也算文档\n\n${NEEDLE} 也在这里。\n`, 'utf-8')
  const again = JSON.parse(
    String(await ev(`(async () => JSON.stringify(await window.luminAPI.workspace.reindex()))()`))
  )
  report.check(
    'reindex-skips-unchanged-files',
    again.scanned >= 3 && again.indexed < again.scanned,
    JSON.stringify(again)
  )
  const afterSecond = JSON.parse(
    String(
      await ev(
        `(async () => JSON.stringify(await window.luminAPI.db.search(${JSON.stringify(NEEDLE)}, 10)))()`
      )
    )
  )
  report.check(
    'txt-files-are-indexed-too',
    afterSecond.some((r) => r.path.endsWith('real.txt')),
    JSON.stringify(afterSecond.map((r) => path.basename(r.path)))
  )
  // ── ② 「最近文档」不许被索引污染 ───────────────────────────────────────────
  // ⚠️ 界面上的「最近文档」来自 settings kv 的 `recentFiles`（`stores/recent.ts` 在**打开**时
  // 记一笔），而不是 `db.listRecent` —— 后者是 documents 表的原始查询，索引行本来就在里面
  // （`last_opened = 0`，排序时沉底）。所以要断言的是**界面那份**：从未打开过的文件不该出现。
  const recents = JSON.parse(String(await ev(`JSON.stringify(window.__L.settings().recentFiles)`)))
  report.check(
    'indexed-files-do-not-pollute-recents',
    !recents.some((r) => (r?.path ?? r) === neverOpened),
    JSON.stringify(recents.map((r) => r?.path ?? r).slice(0, 4))
  )
  const dbRecent = JSON.parse(
    String(await ev(`(async () => JSON.stringify(await window.luminAPI.db.listRecent(30)))()`))
  )
  const indexedRow = dbRecent.find((r) => r.path === neverOpened)
  report.check(
    'indexed-row-has-zero-last-opened',
    !!indexedRow && indexedRow.lastOpened === 0,
    JSON.stringify(
      indexedRow && { path: path.basename(indexedRow.path), lastOpened: indexedRow.lastOpened }
    )
  )

  // ── ③ 点结果 → 打开 + 定位到命中处（查找栏带查询 + 选中第一处）──────────────
  const located = JSON.parse(
    String(
      await ev(`(async () => {
        // 走真实路径：打开全局搜索面板 → 输入查询 → 点第一条**结果**（不是关闭按钮！）
        const ui = window.__L.ui()
        ui.openGlobalSearch()
        ui.globalSearch.query = ${JSON.stringify(NEEDLE)}
        // 等结果行出现（面板里第一枚 button 是关闭按钮，所以必须按 data-search-result 找）
        let rows = []
        for (let i = 0; i < 25 && !rows.length; i++) {
          await new Promise((r) => setTimeout(r, 150))
          rows = [...document.querySelectorAll('[data-search-result]')]
        }
        // 夹具里有两篇都含这个词（never-opened.md 与后加的 real.txt），
        // 所以按路径挑那一篇 —— 场景要验的正是"从未被打开过的那篇能被搜到并跳过去"
        const row = rows.find((el) => el.textContent.includes('never-opened'))
        if (!row) return JSON.stringify({ err: 'no-result-row', rows: rows.length })
        row.click()
        await new Promise((r) => setTimeout(r, 1600))
        const bar = document.querySelector('[data-find-disclosure]')
        const input = document.querySelector('[data-find-input]')
        const count = document.querySelector('[data-find-count]')
        return JSON.stringify({
          opened: window.__L.files().current?.path ?? null,
          findOpen: !!bar,
          query: input ? input.value : null,
          count: count ? count.textContent.trim() : null
        })
      })()`)
    )
  )
  report.check('click-result-opens-doc', located.opened === neverOpened, JSON.stringify(located))
  report.check(
    'click-result-jumps-to-hit',
    located.findOpen === true &&
      String(located.query) === NEEDLE &&
      /^1\s*\/\s*[1-9]/.test(String(located.count)),
    JSON.stringify(located)
  )

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
