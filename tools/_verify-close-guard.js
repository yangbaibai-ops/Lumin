'use strict'
// 验收：关窗兜底不再"2.5 秒强杀"（审计 §2 P1）
//
// 原缺陷：主进程给渲染层的保存机会是**固定 2.5 秒**的定时器，到点无条件 `win.close()`。
// 慢盘 / 大文件 / 多文档时 `flushAll()` 还没跑完窗口就没了 —— 丢的正是"用户以为已经保存"
// 的那一段（磁盘上停留在他上一次成功保存的版本）。
//
// 现在：渲染层在落盘期间**按秒发心跳**（`app:closeProgress`），主进程据此把兜底往后推；
// 连续 2.5 秒没心跳才强杀，总时长 30 秒封顶（判据是纯函数，单测在 tests/closeGuard.test.mjs）。
//
// 怎么在自动化里量出来：把 store 的 `flushAll` 换成"先睡 4.5 秒再真的刷"（比 2.5 秒的兜底长），
// 然后从页面触发关窗，**在 Node 侧**量两件事：
//   ① 窗口在 3.2 秒时**还活着**（旧实现这时已经被强杀）；
//   ② 窗口最终消失，且磁盘上是**新的内容**（证明那次慢刷真的跑完了，而不只是窗口多赖了一会儿）。
//
// ⚠️ 本套件把**自动保存打开**再关窗：手动保存模式下（出厂默认）关窗会先弹
//    「是否保存更改？」，没人点按钮就一直在等 —— 那条路（三条出路）由
//    `_verify-close-save-prompt.js` 专门验收；这里要量的是"慢落盘不被强杀"，
//    走自动保存那条"不弹框、直接 flush"的路最干净。
//
// ⚠️ 没有覆盖的：`session-end`（Windows 关机/注销）没法从页面触发 —— 它的**策略**
//    （只广播一次、先标记退出）由单测钉住，广播动作与关窗复用同一条 `before-close` 路径。
const os = require('os')
const path = require('path')
const fs = require('fs')
const { createHash } = require('crypto')
const { connect, settle, sleep, appPages, ensureFocus, Reporter, fatal } = require('./lib/harness')

const WS = path.join(os.tmpdir(), 'lumin-close-ws')
const DOC = path.join(WS, 'close.md')
const KEY = 'file-' + encodeURIComponent(DOC.toLowerCase())
const NEW_TEXT = 'CLOSE-GUARD-新内容'

/** 窗口还挂在调试端口上吗（窗口关掉后进程会退出，端口随之失效） */
async function windowAlive() {
  try {
    return (await appPages()).length > 0
  } catch {
    return false
  }
}

async function main() {
  const report = new Reporter('关窗兜底：慢落盘不被 2.5s 强杀')
  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  fs.writeFileSync(DOC, '# close\n\n原始正文\n', 'utf-8')

  const app = await connect()
  if (!(await settle(app.ev))) throw new Error('实例未进入就绪状态')
  const { ev } = app

  try {
    await ev(`(async () => {
      const f = window.__L.files()
      window.__L.settings().set('autoSave', true)
      await f.setRoot(${JSON.stringify(WS)})
      await f.openPath(${JSON.stringify(DOC)})
      return 'ok'
    })()`)
    await sleep(1200)

    // 把 flushAll 换成"慢刷"：先睡 4.5 秒（比 2.5 秒兜底长），再走原来那条路。
    // 这一段等价于"磁盘慢/文件大"的真实情形，只是把时间放大到能观测。
    const patched = String(
      await ev(`(() => {
        const f = window.__L.files()
        f.setContent(${JSON.stringify(NEW_TEXT)}, 'external')
        const orig = f.flushAll.bind(f)
        f.flushAll = async () => {
          await new Promise((r) => setTimeout(r, 4500))
          return orig()
        }
        return JSON.stringify({ dirty: f.dirty, has: f.current.content.includes(${JSON.stringify(NEW_TEXT)}) })
      })()`)
    )
    report.check(
      'fixture-doc-is-dirty',
      JSON.parse(patched).dirty === true && JSON.parse(patched).has === true,
      patched
    )

    // 关窗要靠主进程的 getFocusedWindow()，所以先把窗口提到前台（拿不到焦点就别硬判）
    if (!(await ensureFocus(app))) {
      report.skip('关窗兜底', '窗口拿不到焦点（getFocusedWindow 会是 null）')
      return report.finish()
    }
    await ev(`(() => { window.luminAPI.app.close(); return 'ok' })()`)

    const t0 = Date.now()
    let aliveAt3s = false
    let goneAtMs = null
    for (let i = 0; i < 44; i += 1) {
      await sleep(400)
      const alive = await windowAlive()
      const elapsed = Date.now() - t0
      if (alive && elapsed >= 3200) aliveAt3s = true
      if (!alive) {
        goneAtMs = elapsed
        break
      }
    }
    report.check(
      'slow-flush-survives-past-2.5s',
      aliveAt3s,
      `窗口在 3.2 秒时仍活着 = ${aliveAt3s}（旧实现会在 2.5 秒被强杀）`
    )
    report.check('window-eventually-closes', goneAtMs !== null, `关闭耗时 = ${goneAtMs}ms`)

    const onDisk = fs.readFileSync(DOC, 'utf-8')
    report.check(
      'slow-flush-actually-landed',
      onDisk.includes(NEW_TEXT),
      `磁盘内容 = ${JSON.stringify(onDisk.slice(0, 60))}`
    )
    // 保存成功 = 草稿没有恢复价值 → store 会把它删掉（`writeDraft` 的口径）。
    // 顺手证明 runner 给的草稿目录口径也是对的（`LUMIN_DRAFTS_DIR`）。
    const draftsDir =
      process.env.LUMIN_DRAFTS_DIR || path.join(os.tmpdir(), 'lumin-suites-ud', 'drafts')
    const draftFile = path.join(
      draftsDir,
      `${createHash('sha1').update(KEY).digest('hex').slice(0, 16)}.json`
    )
    report.check(
      'draft-cleared-after-successful-save',
      fs.existsSync(draftsDir) && !fs.existsSync(draftFile),
      `草稿残留在 ${draftFile}`
    )
  } finally {
    try {
      app.close()
    } catch {
      /* ignore */
    }
  }

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
