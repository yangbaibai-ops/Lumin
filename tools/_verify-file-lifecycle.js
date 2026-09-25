'use strict'
// 验收：文件/目录生命周期里的**路径一致性**（审计 §2 P1 第 124 条）
//
// 原缺陷（清单原话）：「目录被删/改名后，当前文档路径不更新 → 保存会在旧路径复活目录」。
// 渲染层后来补上了"当前文档"这一半（`isInside` 判子孙 → 摘成未命名缓冲区 / 搬到新目录），
// 但同一条里还有三处会咬人，这套件盯的就是它们：
//
//   ① **索引**：`renameDocument` 只管被重命名那个节点，目录改名后所有子文档的
//      `documents.path` / `documents_history.path` 还指着旧路径 —— 搜索、最近列表、
//      标签、本地历史全部对不上号（`db.renameDirectory` 修）；
//   ② **最近列表**：那份数据活在渲染层设置里（`recentFiles`/`pinnedFiles`/`recentFolders`），
//      不跟着搬就是菜单里点一下"文件不存在"（`recent.migrateWithin` / `dropWithin` 修）；
//   ③ **保存不许 `mkdir -p`**：父目录被别处删掉后继续保存，旧目录会被凭空重建、
//      文件以旧名复活，而用户没有任何提示（`fileOps.writeFile` 现在抛 PARENT_MISSING，
//      渲染层映射成一句本地化提示）。
const path = require('path')
const os = require('os')
const fs = require('fs')
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

const WS = path.join(os.tmpdir(), 'lumin-lifecycle-ws')

const join = (...parts) => path.join(...parts)

async function main() {
  const report = new Reporter('文件生命周期：目录改名/删除后的路径一致性')
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }

  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(join(WS, 'sub', 'deep'), { recursive: true })
  fs.mkdirSync(join(WS, 'gone'), { recursive: true })
  fs.writeFileSync(join(WS, 'sub', 'a.md'), '# A\n\n第一版\n', 'utf-8')
  fs.writeFileSync(join(WS, 'sub', 'deep', 'b.md'), '# B\n\n子目录里的文件\n', 'utf-8')
  fs.writeFileSync(join(WS, 'gone', 'c.md'), '# C\n\n目录会被删掉\n', 'utf-8')

  const A_OLD = join(WS, 'sub', 'a.md')
  const A_NEW = join(WS, 'renamed', 'a.md')

  await ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  try {
    await ev(`(async () => {
      const f = window.__L.files()
      await f.setRoot(${JSON.stringify(WS)})
      await f.openPath(${JSON.stringify(A_OLD)})
      return 'ok'
    })()`)
    await sleep(900)

    // 让 a.md 有一份历史（第一次保存把"上一版"留成快照）+ 一条 DB 行
    await ev(`(async () => {
      const f = window.__L.files()
      f.setContent('# A\\n\\n第二版\\n', 'external')
      await f.save()
      return 'ok'
    })()`)
    await sleep(700)
    // 记一条"最近文档"（正常打开路径会自动记，这里显式确认它存在）
    await ev(
      `(() => { window.__L.store('recent').touchFile(${JSON.stringify(A_OLD)}); return 'ok' })()`
    )
    await sleep(400)

    const before = JSON.parse(
      await ev(`(async () => {
        const doc = await window.luminAPI.db.getDocument(${JSON.stringify(A_OLD)})
        const hist = await window.luminAPI.history.list(${JSON.stringify(A_OLD)}, 10)
        const recent = window.__L.settings().recentFiles.map((r) => r.path)
        return JSON.stringify({ hasDoc: !!doc, hist: hist.length, recent })
      })()`)
    )
    report.note('P0 ' + JSON.stringify(before))
    report.check(
      'fixture-indexed-with-history',
      before.hasDoc === true && before.hist >= 1 && before.recent.some((p) => p === A_OLD),
      JSON.stringify(before)
    )

    // ── ① 目录改名：当前文档路径 + 索引 + 历史 + 最近列表一起搬 ──────────────
    const renamed = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        await f.renameNode({ path: ${JSON.stringify(join(WS, 'sub'))}, name: 'sub', type: 'directory' }, ${JSON.stringify(WS)}, 'renamed')
        await new Promise((r) => setTimeout(r, 500))
        const s = window.__L.settings()
        return JSON.stringify({
          currentPath: f.current ? f.current.path : null,
          oldDoc: !!(await window.luminAPI.db.getDocument(${JSON.stringify(A_OLD)})),
          newDoc: !!(await window.luminAPI.db.getDocument(${JSON.stringify(A_NEW)})),
          newHist: (await window.luminAPI.history.list(${JSON.stringify(A_NEW)}, 10)).length,
          oldHist: (await window.luminAPI.history.list(${JSON.stringify(A_OLD)}, 10)).length,
          recent: s.recentFiles.map((r) => r.path),
          onDiskNew: (await window.luminAPI.file.exists(${JSON.stringify(A_NEW)})) === true,
          onDiskOld: (await window.luminAPI.file.exists(${JSON.stringify(A_OLD)})) === true
        })
      })()`)
    )
    report.note('A1 ' + JSON.stringify(renamed))
    report.check(
      'dir-rename-moves-current-doc',
      renamed.currentPath === A_NEW,
      JSON.stringify({ currentPath: renamed.currentPath })
    )
    report.check(
      'dir-rename-moves-index',
      renamed.oldDoc === false && renamed.newDoc === true,
      JSON.stringify({ oldDoc: renamed.oldDoc, newDoc: renamed.newDoc })
    )
    report.check(
      'dir-rename-moves-history',
      renamed.newHist >= 1 && renamed.oldHist === 0,
      JSON.stringify({ newHist: renamed.newHist, oldHist: renamed.oldHist })
    )
    report.check(
      'dir-rename-moves-recent-list',
      renamed.recent.some((p) => p === A_NEW) && !renamed.recent.some((p) => p === A_OLD),
      JSON.stringify({ recent: renamed.recent })
    )
    report.check(
      'dir-rename-moved-files-on-disk',
      renamed.onDiskNew === true && renamed.onDiskOld === false,
      JSON.stringify({ new: renamed.onDiskNew, old: renamed.onDiskOld })
    )

    // ── ② 目录删除：当前文档摘成未命名缓冲区 + 最近列表清死链 ────────────────
    const removed = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        await f.removeNode({ path: ${JSON.stringify(join(WS, 'renamed'))}, name: 'renamed', type: 'directory' }, ${JSON.stringify(WS)})
        await new Promise((r) => setTimeout(r, 600))
        return JSON.stringify({
          currentPath: f.current ? f.current.path : null,
          content: f.current ? f.current.content : null,
          dirty: f.dirty,
          recent: window.__L.settings().recentFiles.map((r) => r.path)
        })
      })()`)
    )
    report.note('B1 ' + JSON.stringify(removed))
    report.check(
      'dir-delete-detaches-current-doc',
      removed.currentPath === null && String(removed.content).includes('第二版'),
      JSON.stringify(removed)
    )
    report.check(
      'dir-delete-drops-recent-links',
      !removed.recent.some((p) => p.includes('renamed')),
      JSON.stringify({ recent: removed.recent })
    )

    // ── ③ 父目录消失后保存：必须失败，且**不许**把目录复活 ────────────────────
    const GONE = join(WS, 'gone')
    await ev(`(async () => {
      const f = window.__L.files()
      await f.openPath(${JSON.stringify(join(GONE, 'c.md'))})
      return 'ok'
    })()`)
    await sleep(700)
    fs.rmSync(GONE, { recursive: true, force: true }) // 模拟"别处把目录删了"
    const strict = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        f.setContent('# C\\n\\n目录已经没了\\n', 'external')
        const ok = await f.save()
        return JSON.stringify({ ok, saveError: f.saveError, currentPath: f.current ? f.current.path : null })
      })()`)
    )
    report.note('C1 ' + JSON.stringify(strict))
    report.check(
      'save-fails-when-parent-missing',
      strict.ok === false && typeof strict.saveError === 'string' && strict.saveError.length > 0,
      JSON.stringify(strict)
    )
    report.check(
      'save-error-is-human-readable',
      typeof strict.saveError === 'string' && !strict.saveError.includes('PARENT_MISSING'),
      JSON.stringify({ saveError: strict.saveError })
    )
    report.check(
      'save-does-not-recreate-directory',
      fs.existsSync(GONE) === false,
      `目录被复活了：${GONE}`
    )
  } finally {
    await ev(`(async () => {
      await window.__L.files().setRoot(null)
      return 'ok'
    })()`).catch(() => {})
    fs.rmSync(WS, { recursive: true, force: true })
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
