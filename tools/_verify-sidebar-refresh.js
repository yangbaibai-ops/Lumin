'use strict'
// 验收：侧栏头部那一行的「刷新」——**只在列表视图下出现**，且它的独有价值真的接上了
//
// 用户口径（第九轮讨论后的决定）：「保留，但只在列表视图下显示」。
// 依据是这一轮量到的三组数（探针结果，正文见 CHANGELOG）：
//   * 外部**新建 / 改名**文件 → 主进程 `fs.watch` 让树在 **~0.33s** 内自动更新（不用点刷新）；
//   * 外部**只改内容**（没有 rename 事件）→ 列表视图的「修改于」**不会**自己更新，
//     调用一次 refreshDir 之后才变成文件真实 mtime —— 这是它唯一独有的作用，
//     而这一作用只落在**列表视图的元数据**上（树视图看的是名字与结构，不受影响）。
// 所以：树视图下这颗按钮不再渲染（头部从三颗图标回到两颗），列表视图下照旧。
//
// 断言分两层，缺一不可：
//   * **显示规则**：树视图没有它、列表视图有它、没有工作区时也没有它（v-if 与 title 一起验）；
//   * **它还真的有用**：在列表视图里点它 → 列表那篇的「修改于」追平磁盘真实 mtime
//     （只验「按钮在不在」的话，把它接成一个空函数也照样全绿）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  connect,
  settle,
  sleep,
  clickCenter,
  bringToFront,
  Reporter,
  fatal
} = require('./lib/harness')

/** 侧栏头部那一行里的按钮标题（顺序即渲染顺序） */
const HEAD_BUTTONS = `(() => {
  const aside = document.querySelector('aside')
  if (!aside) return JSON.stringify({ missing: true })
  const head = aside.firstElementChild
  return JSON.stringify({
    titles: [...head.querySelectorAll('button')].map((b) => b.title || b.getAttribute('aria-label') || '')
  })
})()`

const docMtime = (suffix) => `(() => {
  const docs = window.__L.store('workspaceDocs').docs
  const d = docs.find((x) => x.path.endsWith(${JSON.stringify(suffix)}))
  return JSON.stringify({ found: !!d, mtimeMs: d ? d.mtimeMs : null, count: docs.length })
})()`

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('侧栏头部「刷新」：只在列表视图下出现，且真的能刷新列表元数据')

  const dir = path.join(os.tmpdir(), 'lumin-sidebar-refresh-ws')
  const file = path.join(dir, 'note.md')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, '# note\n\n第一版内容\n', 'utf-8')

  try {
    // ── A. 没有工作区：头部只有「最近文档 + 新建文件」 ──
    await ev(`(async () => {
      await window.__L.files().setRoot(null)
      const ui = window.__L.ui()
      ui.sidebarVisible = true; ui.sidebarTab = 'files'; ui.sidebarFilesView = 'list'
      return 'ok'
    })()`)
    await sleep(800)
    const noRoot = JSON.parse(await ev(HEAD_BUTTONS))
    report.note('A 无工作区 ' + JSON.stringify(noRoot))
    report.check(
      'refresh-hidden-without-workspace',
      noRoot.titles.includes('新建文件') && !noRoot.titles.includes('刷新'),
      JSON.stringify(noRoot.titles)
    )

    // ── B. 树视图：刷新**不**出现 ──
    await ev(`(async () => {
      await window.__L.files().setRoot(${JSON.stringify(dir)})
      window.__L.ui().sidebarFilesView = 'tree'
      return 'ok'
    })()`)
    await sleep(1200)
    const tree = JSON.parse(await ev(HEAD_BUTTONS))
    report.note('B 树视图 ' + JSON.stringify(tree))
    // 注意头部还有一枚「工作区」按钮（title = 路径 + 换行 + 打开文件夹），所以只按标题判定，
    // 不按数量 —— 数数量会把「工作区那一枚」算进去（第一次跑就是这么假红的）。
    report.check(
      'refresh-hidden-in-tree-view',
      !tree.titles.includes('刷新') && tree.titles.includes('新建文件') && tree.titles.includes('最近文档'),
      JSON.stringify(tree.titles)
    )

    // ── C. 列表视图：刷新出现，且在「新建文件」右侧（顺序不乱） ──
    await ev(`(() => { window.__L.ui().sidebarFilesView = 'list'; return 'ok' })()`)
    await sleep(1500)
    const list = JSON.parse(
      await ev(`(() => {
        const head = document.querySelector('aside').firstElementChild
        const btns = [...head.querySelectorAll('button')].map((b) => ({
          title: b.title || '',
          left: Math.round(b.getBoundingClientRect().left)
        }))
        return JSON.stringify({ btns })
      })()`)
    )
    report.note('C 列表视图 ' + JSON.stringify(list))
    const refresh = list.btns.find((b) => b.title === '刷新')
    const newFile = list.btns.find((b) => b.title === '新建文件')
    report.check(
      'refresh-shown-in-list-view',
      !!refresh && !!newFile && refresh.left > newFile.left,
      JSON.stringify(list.btns)
    )

    // ── D. 它还真的有用：外部只改内容（无 rename）→ 刷新把「修改于」追平磁盘 ──
    const before = JSON.parse(await ev(docMtime('note.md')))
    // 把 mtime 抬到明显更晚（+120s）并改写内容：fs.watch 收到的是 change，按设计被忽略
    const future = new Date(Date.now() + 120_000)
    fs.writeFileSync(file, '# note\n\n外部改写的内容\n', 'utf-8')
    fs.utimesSync(file, future, future)
    const realMtime = fs.statSync(file).mtimeMs
    await sleep(2000)
    const stale = JSON.parse(await ev(docMtime('note.md')))
    report.note(
      'D ' +
        JSON.stringify({ before: before.mtimeMs, afterExternalWrite: stale.mtimeMs, realMtime })
    )
    report.check(
      'external-content-change-left-stale',
      before.found === true &&
        stale.found === true &&
        stale.mtimeMs !== realMtime &&
        stale.mtimeMs === before.mtimeMs,
      `外部只改内容后列表仍是旧值（${stale.mtimeMs}），磁盘真实值 ${realMtime} —— 这正是不自动更新的那一类`
    )

    await bringToFront(app)
    const clicked = await clickCenter(app.send, ev, 'aside button[title="刷新"]')
    await sleep(1800)
    const refreshed = JSON.parse(await ev(docMtime('note.md')))
    report.note('D-after-click ' + JSON.stringify({ clicked, refreshed }))
    report.check(
      'refresh-button-actually-rescans-list-metadata',
      clicked === true &&
        refreshed.found === true &&
        Math.abs(refreshed.mtimeMs - realMtime) < 2000,
      `点刷新后列表 mtime=${refreshed.mtimeMs}，磁盘真实=${realMtime}（差 ${Math.abs(refreshed.mtimeMs - realMtime)}ms）`
    )

    // ── E. 树视图下的入口没丢：工作区根节点右键菜单里仍有「刷新」 ──
    await ev(`(() => { window.__L.ui().sidebarFilesView = 'tree'; return 'ok' })()`)
    await sleep(900)
    const menu = JSON.parse(
      await ev(`(async () => {
        const root = document.querySelector('[data-tree-root]')
        if (!root) return JSON.stringify({ err: 'no-tree' })
        const r = root.getBoundingClientRect()
        root.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, clientX: Math.round(r.left + 60), clientY: Math.round(r.top + 8)
        }))
        await new Promise((res) => setTimeout(res, 400))
        // 语义锚点（role=menu，子菜单是 aria-label="submenu"），不认 Tailwind 的 z-index 类名
        const panel = document.querySelector('[role="menu"]:not([aria-label="submenu"])')
        return JSON.stringify({
          opened: !!panel,
          items: panel ? [...panel.querySelectorAll('button')].map((b) => b.textContent.trim()) : []
        })
      })()`)
    )
    report.note('E 树视图右键菜单 ' + JSON.stringify(menu))
    report.check(
      'refresh-still-reachable-from-tree-context-menu',
      menu.items.includes('刷新'),
      JSON.stringify(menu.items)
    )
    await ev(`(() => { window.__L.ui().contextMenu = null; return 'ok' })()`)
  } finally {
    await ev(`(async () => { await window.__L.files().setRoot(null); return 'ok' })()`).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }

  app.close()
  process.exit(report.finish())
}

main().catch((e) => fatal(e))
