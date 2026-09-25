'use strict'
// 验收：外部改动检测（审计 §2 P1「无外部改动检测：别处改了同一文件，保存时静默覆盖」）
//
// 原缺陷：`files.save` 拿 `Date.now()` 冒充 mtime，从不与磁盘比对；`fs.watch` 又刻意
// 忽略内容变更事件 —— 于是 git 切分支 / 同步盘 / 别的编辑器改过同一文件之后，
// 一次 Ctrl+S 就无声地把别人写的内容盖掉（反过来外部改动也不会提示重载）。
//
// 现在的口径（`ipc.ts` 的 `file:write` 拿第 6 个参数 `expectMtimeMs`）：
//   写之前 stat 比对上一次读/写时的 mtime，不一致 ⇒ **不写**，回报 `conflict`，
//   由用户决定：手动保存当场问（覆盖 / 取消），取消后状态栏转红 + 通知卡片给出
//   「另存为」「重新打开（放弃我的改动）」；自动保存**不弹模态**（别把写作中的人拽出来），
//   只留失败态 + 通知，等用户显式决定。
//
// 判据：
//   1. 手动保存遇冲突 → 弹确认；取消 → **磁盘上仍是外部那份**（没被覆盖）、缓冲区仍是脏的、
//      状态栏失败态、通知卡片带两个按钮；
//   2. 同一场景选"覆盖" → 磁盘变成我这一份、脏标记清掉、失败态清掉；
//   3. 自动保存遇冲突 → **不弹模态**，磁盘不被覆盖，失败态亮起；
//   4. 通知里那条"重新打开（放弃我的改动）"走的那条路（`openPath(path, {discardChanges:true})`）
//      确实不弹确认、且缓冲区换成磁盘那一版。
const path = require('path')
const os = require('os')
const fs = require('fs')
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

const WS = path.join(os.tmpdir(), 'lumin-external-ws')
const DOC = path.join(WS, 'ext.md')

/** 从 Node 侧改文件（模拟"别的程序"），并把 mtime 明确往前推，避免文件系统时间戳精度打扰 */
function writeExternally(text) {
  fs.writeFileSync(DOC, text, 'utf-8')
  const future = new Date(Date.now() + 4000)
  fs.utimesSync(DOC, future, future)
}

async function main() {
  const report = new Reporter('外部改动检测：保存时不许静默覆盖别人写的版本')
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }

  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  fs.writeFileSync(DOC, '# 原始\n', 'utf-8')

  await ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  try {
    await ev(`(async () => {
      const f = window.__L.files()
      await f.setRoot(${JSON.stringify(WS)})
      await f.openPath(${JSON.stringify(DOC)})
      return 'ok'
    })()`)
    await sleep(900)

    // ── ① 手动保存遇冲突 → 弹确认；取消 → 磁盘不许被覆盖 ────────────────────
    await ev(`(() => { window.__L.files().setContent('我的版本-1', 'external'); return 'ok' })()`)
    writeExternally('外部版本-1')
    await sleep(200)
    await ev(`(() => {
      window.__conflictResult = 'pending'
      window.__L.files().save().then((r) => { window.__conflictResult = r })
      return 'ok'
    })()`)
    await sleep(600)
    const asked = JSON.parse(
      await ev(`(() => {
        const ui = window.__L.ui()
        return JSON.stringify({
          asked: !!ui.confirmState,
          title: ui.confirmState ? ui.confirmState.title : null,
          result: window.__conflictResult,
          disk: null
        })
      })()`)
    )
    report.check(
      'conflict-asks-on-manual-save',
      asked.asked === true && asked.result === 'pending',
      JSON.stringify(asked)
    )
    await ev(
      `(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(false); return 'ok' })()`
    )
    await sleep(600)
    const cancelled = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        const list = await window.luminAPI.notifications.list({ includeClosed: true })
        const card = list.find((n) => String(n.title).includes('ext.md')) ?? null
        return JSON.stringify({
          result: window.__conflictResult,
          disk: (await window.luminAPI.file.read(${JSON.stringify(DOC)})).content,
          dirty: f.dirty,
          saveError: f.saveError,
          card: card ? { level: card.level, actions: card.actions.map((a) => a.id), kind: card.payload?.kind } : null
        })
      })()`)
    )
    report.note('A1 ' + JSON.stringify(cancelled))
    report.check(
      'cancel-does-not-overwrite-disk',
      cancelled.result === false && cancelled.disk.includes('外部版本-1'),
      JSON.stringify({ result: cancelled.result, disk: cancelled.disk })
    )
    report.check(
      'cancel-keeps-dirty-and-marks-failure',
      cancelled.dirty === true &&
        typeof cancelled.saveError === 'string' &&
        cancelled.saveError.length > 0,
      JSON.stringify({ dirty: cancelled.dirty, saveError: cancelled.saveError })
    )
    report.check(
      'conflict-leaves-actionable-notification',
      !!cancelled.card &&
        cancelled.card.kind === 'save-conflict' &&
        cancelled.card.actions.includes('save-as') &&
        cancelled.card.actions.includes('reload'),
      JSON.stringify(cancelled.card)
    )

    // ── ② 同一场景选「覆盖」→ 磁盘变成我这一份 ──────────────────────────────
    await ev(`(() => {
      window.__conflictResult = 'pending'
      window.__L.files().save().then((r) => { window.__conflictResult = r })
      return 'ok'
    })()`)
    await sleep(600)
    const askedAgain = await ev(`!!window.__L.ui().confirmState`)
    await ev(
      `(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(true); return 'ok' })()`
    )
    await sleep(700)
    const overwritten = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        return JSON.stringify({
          result: window.__conflictResult,
          disk: (await window.luminAPI.file.read(${JSON.stringify(DOC)})).content,
          dirty: f.dirty,
          saveError: f.saveError
        })
      })()`)
    )
    report.note('A2 ' + JSON.stringify(overwritten))
    report.check(
      'conflict-overwrite-writes-our-version',
      askedAgain === true &&
        overwritten.result === true &&
        overwritten.disk.includes('我的版本-1') &&
        overwritten.dirty === false &&
        overwritten.saveError === null,
      JSON.stringify(overwritten)
    )

    // ── ③ 自动保存遇冲突：不弹模态，也不覆盖 ────────────────────────────────
    await ev(
      `(() => { window.__L.settings().set('autoSave', true); window.__L.settings().set('autoSaveInterval', 1); return 'ok' })()`
    )
    await sleep(300)
    await ev(`(() => { window.__L.files().setContent('我的版本-2', 'external'); return 'ok' })()`)
    writeExternally('外部版本-2')
    await sleep(2600) // 自动保存 1s 一次
    const auto = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        return JSON.stringify({
          modalOpen: !!window.__L.ui().confirmState,
          disk: (await window.luminAPI.file.read(${JSON.stringify(DOC)})).content,
          dirty: f.dirty,
          saveError: f.saveError
        })
      })()`)
    )
    report.note('A3 ' + JSON.stringify(auto))
    report.check(
      'autosave-conflict-is-silent-and-safe',
      auto.modalOpen === false && auto.disk.includes('外部版本-2') && auto.dirty === true,
      JSON.stringify(auto)
    )
    report.check(
      'autosave-conflict-marks-failure',
      typeof auto.saveError === 'string' && auto.saveError.length > 0,
      JSON.stringify({ saveError: auto.saveError })
    )

    // ── ④ 通知卡片上「重新打开（放弃我的改动）」那条路 ──────────────────────
    await ev(`(() => {
      window.__L.settings().set('autoSave', false)
      window.__L.files().cancelAutoSave()
      return 'ok'
    })()`)
    await sleep(200)
    const reloaded = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        // 这就是通知处理器里 'reload' 分支的调用（用户已在卡片上明确点过）
        const ok = await f.openPath(${JSON.stringify(DOC)}, { discardChanges: true })
        return JSON.stringify({
          ok,
          asked: !!window.__L.ui().confirmState,
          content: f.current.content,
          dirty: f.dirty
        })
      })()`)
    )
    report.note('A4 ' + JSON.stringify(reloaded))
    report.check(
      'reload-action-takes-disk-version',
      reloaded.ok === true && reloaded.asked === false && reloaded.content.includes('外部版本-2'),
      JSON.stringify(reloaded)
    )
  } finally {
    await ev(`(async () => {
      await window.luminAPI.notifications.closeAll()
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
