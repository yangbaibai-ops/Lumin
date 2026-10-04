'use strict'
// 验收：文档标签（审计 §7 第 19 条：标签的 DB 与 IPC 早就有、界面一处都没有）
//
// 判据：
//   1. 没标签时状态栏**不出现**标签格（用户口径 §4.83：有标签才显示）；
//   2. 第一次加标签走 `⋯` 菜单 →「添加标签…」：弹输入框，输入解析成标签数组写进 SQLite
//      （`documents.tags`）—— 这条入口不依赖"已经有标签"，所以不会出现加不上第一个标签的死角；
//   3. 写完之后**状态栏自己**显示这些标签（不用重载）；
//   4. 列表视图每条画出标签，且**过滤词命中标签**时那条会出现（找文档的主要路径）；
//   5. 解析规则：中文逗号/顿号/井号前缀/大小写去重（纯函数另有单测，这里验端到端那一步）。
const { connect, settle, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')
const os = require('os')
const path = require('path')
const fs = require('fs')

const MD = '# 标签验收\n\n正文一段。\n'

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const report = new Reporter('标签：状态栏编辑 / 落库 / 列表展示与过滤')
  const { ev } = app

  // 工作区夹具（自足）
  const ws = path.join(os.tmpdir(), 'lumin-tags-ws')
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(ws, { recursive: true })
  const doc = path.join(ws, 'tagged.md')
  fs.writeFileSync(doc, MD, 'utf-8')
  await ev(
    `(async () => { await window.__L.files().setRoot(${JSON.stringify(ws)}); return 'ok' })()`
  )
  await sleep(700)
  await ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(doc)}); return 'ok' })()`
  )
  await sleep(900)
  report.check(
    'fixture-doc-open',
    (await ev(`window.__L.files().current?.path`)) === doc,
    String(await ev(`window.__L.files().current?.path`))
  )

  // ── ① 没有标签时**不该有**标签格（用户口径 §4.83：有标签才显示）─────────────
  const initial = await ev(`(() => {
    const btn = document.querySelector('[data-status-tags]')
    return JSON.stringify({ present: !!btn })
  })()`)
  const init = JSON.parse(String(initial))
  report.check('status-bar-hides-tag-cell-when-no-tags', init.present === false, String(initial))

  // ── ② 走真实交互：`⋯` 菜单 →「添加标签…」→ 提示框 → 输入 → 确定 ─────────────
  // ⚠️ 入口从"状态栏那一格"搬到了 `⋯` 菜单：那一格现在**有标签才有**，
  // 所以"第一次加标签"必须有一个不依赖"已经有标签"的入口（否则就是个死角）。
  // 输入里故意混上：中文逗号、顿号、井号前缀、大小写重复的同一个标签
  const typed = '#小说，第一章、work, Work, 草稿'
  const flow = await ev(`(async () => {
    const more = document.querySelector('[data-status-more]')
    if (!more) return JSON.stringify({ err: 'no-more-button' })
    more.click()
    let item = null
    for (let i = 0; i < 25 && !item; i++) {
      await new Promise((r) => setTimeout(r, 100))
      item = document.querySelector('[data-more-edit-tags]')
    }
    if (!item) return JSON.stringify({ err: 'no-edit-tags-item' })
    item.click()
    let input = null
    for (let i = 0; i < 25 && !input; i++) {
      await new Promise((r) => setTimeout(r, 100))
      input = document.querySelector('[data-prompt-input]')
    }
    if (!input) return JSON.stringify({ err: 'no-prompt-input' })
    input.value = ${JSON.stringify(typed)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const ok = [...document.querySelectorAll('button')].find((b) => /确定|OK|确认/i.test(b.textContent.trim()))
    if (!ok) return JSON.stringify({ err: 'no-confirm-button' })
    ok.click()
    return JSON.stringify({ ok: true })
  })()`)
  report.check('tag-prompt-flow-via-more-menu', JSON.parse(String(flow)).ok === true, String(flow))
  await sleep(900)

  // ── ③ 落库 + 状态栏自己刷新 ────────────────────────────────────────────────
  const stored = JSON.parse(
    String(
      await ev(
        `(async () => JSON.stringify(await window.luminAPI.db.getDocument(${JSON.stringify(doc)})))()`
      )
    )
  )
  report.check(
    'tags-persisted-normalized',
    JSON.stringify(stored.tags) === JSON.stringify(['小说', '第一章', 'work', '草稿']),
    JSON.stringify(stored.tags)
  )
  const chipText = String(
    await ev(`(document.querySelector('[data-status-tags]')?.textContent || '').trim()`)
  )
  report.check(
    'status-bar-shows-tags-after-adding',
    chipText.includes('小说') && chipText.includes('work'),
    chipText
  )

  // ── ④ 列表视图：画出标签，且过滤词命中标签 ─────────────────────────────────
  const listState = JSON.parse(
    String(
      await ev(`(async () => {
        window.__L.ui().sidebarTab = 'files'
        // ⚠️ 列表视图是 ui.sidebarFilesView（不是 settings 里的那个键）：
        // 设错了就还是树视图，过滤词作用在树上、列表一行都不会出现（第一版就是这么假红的）
        window.__L.ui().sidebarFilesView = 'list'
        await new Promise((r) => setTimeout(r, 500))
        // 侧栏那枚放大镜 → 长出过滤输入框（列表视图的 filter 就是它）
        const toggle = document.querySelector('[data-sidebar-search-toggle]')
        if (toggle) toggle.click()
        await new Promise((r) => setTimeout(r, 700))
        const input = document.querySelector('[data-sidebar-filter]')
        if (input) {
          // 过滤词只用**标签里**才有的词：文件名（tagged）与正文（标签验收…）都不含"草稿"
          input.value = '草稿'
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        await new Promise((r) => setTimeout(r, 700))
        const rows = [...document.querySelectorAll('aside button')].filter((b) => b.textContent.includes('tagged'))
        const chips = rows.length
          ? [...rows[0].querySelectorAll('span')].map((s) => s.textContent.trim()).filter((x) => x === '小说' || x === 'work')
          : []
        return JSON.stringify({ hasFilter: !!input, rows: rows.length, chips })
      })()`)
    )
  )
  report.check(
    'list-filter-matches-tag',
    listState.hasFilter === true && listState.rows >= 1,
    JSON.stringify(listState)
  )

  // 反向确认：把过滤词换成标签里没有的词，那一行必须消失（否则上面的断言可能只是"没生效=全显示"）
  const filteredOut = JSON.parse(
    String(
      await ev(`(async () => {
        const input = document.querySelector('[data-sidebar-filter]')
        input.value = 'zzz-不存在-zzz'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 700))
        const rows = [...document.querySelectorAll('aside button')].filter((b) => b.textContent.includes('tagged'))
        return JSON.stringify({ rows: rows.length })
      })()`)
    )
  )
  report.check('list-filter-actually-filters', filteredOut.rows === 0, JSON.stringify(filteredOut))

  // 收尾：清掉过滤词，别把状态留给下一条套件
  await ev(`(async () => {
    const input = document.querySelector('[data-sidebar-filter]')
    if (input) {
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return 'ok'
  })()`).catch(() => {})
  await sleep(300)

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
