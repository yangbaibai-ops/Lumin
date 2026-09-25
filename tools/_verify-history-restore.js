'use strict'
// 验收：本地历史「载入某一版」（审计 §2 P1：载入历史版本没有脏数据确认，也不触发保存排程）
//
// 原缺陷两条：
//   ① `files.restoreHistory` 直接 `cur.content = entry.content` —— **不问**"有未保存的更改吗"。
//      用户刚写的一大段（只在内存里）会被一次点击换掉；
//   ② 它也不调 `scheduleSave()`、不写草稿 —— 源码模式下连草稿都不会被重写，
//      1.2 秒后旧草稿还可能被新内容覆盖（那份"刚恢复的版本"于是没有任何副本）。
//
// 判据：
//   1. 真实保存两次后历史里能看到上一版（这一条是前提，不是被测行为）；
//   2. **脏的时候必须先弹确认**；点取消 → 内容与脏标记都不许变；
//   3. 点确认 → 内容变成历史那一版、脏标记为真（= 未保存状态，等用户 Ctrl+S）；
//   4. 载入之后**立刻**有一份草稿（那份内容在用户保存前只存在于内存里）；
//   5. 载入也排上了保存（`saveTimer` 非空）；
//   6. 别的文档的历史条目不许被载入（路径不匹配返回 false）。
const path = require('path')
const os = require('os')
const fs = require('fs')
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

const WS = path.join(os.tmpdir(), 'lumin-history-ws')
const DOC = path.join(WS, 'history.md')
const OTHER = path.join(WS, 'other.md')
const V1 = '# 历史验收\n\n第一版正文 HISTORY-V1\n'
const V2 = '# 历史验收\n\n第二版正文 HISTORY-V2\n'
const DIRTY = 'DIRTY-未保存的第三版\n'

/** 草稿文件名与 main/drafts.ts 的 keyToFile 同规则 */
const draftFileFor = (p) =>
  path.join(
    process.env.LUMIN_DRAFTS_DIR || path.join(os.tmpdir(), 'lumin-suites-ud', 'drafts'),
    require('crypto')
      .createHash('sha1')
      .update('file-' + encodeURIComponent(p.toLowerCase()))
      .digest('hex')
      .slice(0, 16) + '.json'
  )

async function main() {
  const report = new Reporter('本地历史：载入某一版要先问，并且真的留下痕迹')
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }

  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  fs.writeFileSync(DOC, V1, 'utf-8')
  fs.writeFileSync(OTHER, V1, 'utf-8')

  // 自动保存关掉：本套件要自己控制"什么时候脏"，不能让定时器插进来
  await ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(300)
  try {
    await ev(`(async () => {
      const f = window.__L.files()
      await f.setRoot(${JSON.stringify(WS)})
      await f.openPath(${JSON.stringify(DOC)})
      return 'ok'
    })()`)
    await sleep(1000)

    // ── 前提：保存两次，历史里应当有「上一版」 ──────────────────────────────
    const hist = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        f.setContent(${JSON.stringify(V2)}, 'external')
        await f.save()
        await new Promise((r) => setTimeout(r, 400))
        const list = await window.luminAPI.history.list(${JSON.stringify(DOC)}, 10)
        const first = list[0] ?? null
        const full = first ? await window.luminAPI.history.get(first.id) : null
        return JSON.stringify({
          count: list.length,
          content: full ? full.content : null,
          id: first ? first.id : null,
          onDisk: (await window.luminAPI.file.read(${JSON.stringify(DOC)})).content
        })
      })()`)
    )
    report.note('H0 ' + JSON.stringify(hist))
    report.check(
      'history-holds-previous-version',
      hist.count >= 1 && hist.content === V1 && hist.onDisk.includes('HISTORY-V2'),
      JSON.stringify({ count: hist.count, content: hist.content })
    )

    // ── ① 脏的时候载入历史：必须先弹确认；取消 → 什么都不变 ─────────────────
    await ev(
      `(() => { window.__L.files().setContent(${JSON.stringify(DIRTY)}, 'external'); return 'ok' })()`
    )
    await sleep(200)
    await ev(`(() => {
      window.__restoreResult = 'pending'
      window.__L.files().restoreHistory({ id: ${hist.id}, path: ${JSON.stringify(DOC)}, savedAt: Date.now(), size: 1, preview: '', content: ${JSON.stringify(V1)} })
        .then((r) => { window.__restoreResult = r })
      return 'ok'
    })()`)
    await sleep(400)
    const asked = JSON.parse(
      await ev(`(() => {
        const ui = window.__L.ui()
        return JSON.stringify({
          asked: !!ui.confirmState,
          title: ui.confirmState ? ui.confirmState.title : null,
          content: window.__L.files().current.content,
          dirty: window.__L.files().dirty,
          result: window.__restoreResult
        })
      })()`)
    )
    report.check(
      'restore-asks-when-dirty',
      asked.asked === true && asked.result === 'pending',
      JSON.stringify({ asked: asked.asked, title: asked.title, result: asked.result })
    )
    await ev(
      `(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(false); return 'ok' })()`
    )
    await sleep(500)
    const cancelled = JSON.parse(
      await ev(`(() => JSON.stringify({
        content: window.__L.files().current.content,
        dirty: window.__L.files().dirty,
        result: window.__restoreResult
      }))()`)
    )
    report.check(
      'cancel-keeps-buffer-untouched',
      cancelled.result === false && cancelled.content === DIRTY && cancelled.dirty === true,
      JSON.stringify(cancelled)
    )

    // ── ② 确认之后：内容换成历史那一版、仍是未保存状态、立刻有草稿、排上保存 ──
    const draftFile = draftFileFor(DOC)
    fs.rmSync(draftFile, { force: true }) // 先清掉，确保下面看到的是这次载入写的
    // 打开自动保存：`saveTimer` 只在自动保存开着时才排（手动保存本来就不该自动落盘），
    // 这条断言要验的正是"载入历史会触发保存排程"（审计 §2 P1 的后半句）。
    await ev(`(() => { window.__L.settings().set('autoSave', true); return 'ok' })()`)
    await sleep(200)
    await ev(`(() => {
      window.__restoreResult = 'pending'
      window.__L.files().restoreHistory({ id: ${hist.id}, path: ${JSON.stringify(DOC)}, savedAt: Date.now(), size: 1, preview: '', content: ${JSON.stringify(V1)} })
        .then((r) => { window.__restoreResult = r })
      return 'ok'
    })()`)
    await sleep(400)
    await ev(
      `(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(true); return 'ok' })()`
    )
    await sleep(700)
    const applied = JSON.parse(
      await ev(`(() => JSON.stringify({
        result: window.__restoreResult,
        content: window.__L.files().current.content,
        dirty: window.__L.files().dirty,
        savedContent: window.__L.files().current.savedContent,
        hasSaveTimer: !!window.__L.files().saveTimer
      }))()`)
    )
    report.check(
      'confirm-loads-history-and-stays-dirty',
      applied.result === true &&
        applied.content === V1 &&
        applied.dirty === true &&
        applied.savedContent.includes('HISTORY-V2'),
      JSON.stringify(applied)
    )
    report.check(
      'confirm-schedules-save',
      applied.hasSaveTimer === true,
      JSON.stringify({ hasSaveTimer: applied.hasSaveTimer })
    )
    const draft = fs.existsSync(draftFile) ? JSON.parse(fs.readFileSync(draftFile, 'utf-8')) : null
    report.check(
      'confirm-writes-draft-immediately',
      !!draft && draft.content === V1,
      JSON.stringify({ file: path.basename(draftFile), content: draft ? draft.content : null })
    )
    // 收尾：别让这次排上的自动保存把 V1 真写进磁盘（后面的段落要读磁盘上的 V2）
    await ev(`(() => {
      window.__L.files().cancelAutoSave()
      window.__L.settings().set('autoSave', false)
      return 'ok'
    })()`)
    await sleep(200)

    // ── ③ 别的文档的历史条目不许载入（路径不匹配 → false，且不弹确认）─────────
    const mismatch = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        await f.openPath(${JSON.stringify(OTHER)})
        await new Promise((r) => setTimeout(r, 600))
        const ok = await f.restoreHistory({ id: ${hist.id}, path: ${JSON.stringify(DOC)}, savedAt: Date.now(), size: 1, preview: '', content: 'X' })
        return JSON.stringify({ ok, path: f.current.path, content: f.current.content, confirm: !!window.__L.ui().confirmState })
      })()`)
    )
    report.check(
      'restore-rejects-other-document',
      mismatch.ok === false && mismatch.content !== 'X' && mismatch.confirm === false,
      JSON.stringify(mismatch)
    )
  } finally {
    await ev(`(async () => {
      const f = window.__L.files()
      await window.luminAPI.drafts.remove('file-' + encodeURIComponent(${JSON.stringify(DOC.toLowerCase())}))
      await window.luminAPI.history.clear(${JSON.stringify(DOC)})
      await f.setRoot(null)
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
