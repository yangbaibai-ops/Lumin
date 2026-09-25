'use strict'
// 验收：**保存与换文档时的数据安全**（本轮修掉的一类"静默丢字"）
//
// 覆盖四条彼此独立的缺陷（都曾在审计里定为 P0/P1）：
//  A. **保存期间继续输入**：`save()` 曾在 `await` 回来后把 `savedContent` 赋成"当前内容"，
//     于是写盘期间敲进去的字被标成"已保存"、脏标记消失、草稿还被删掉 —— 永久丢失。
//     现在：快照比对 + 串行化，内容变了就保持 dirty（并重排一次保存）。
//  B. **草稿只在停止输入后才写**：纯尾沿防抖在连续打字时会被无限推迟（实测 12s/600 字 = 0 份）。
//     现在：尾沿 1.2s + **最大等待 10s**。
//  C. **换文档前不刷编辑器**：Tiptap 是防抖 250ms 才序列化进 store 的，紧接着换文档时
//     那段输入既不在账上（不弹「未保存」确认）也会随旧实例卸载而消失。
//     现在：`confirmDiscardIfDirty` 先 flush 再取判据。
//  D. **真实 mtime**：写盘不再用 `Date.now()` 冒充 mtime（冲突检测/列表排序都依赖它）。
//
// 只读断言：全部按 store / DOM / 磁盘三方对照，不靠截图。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, sleep, waitEditor, Reporter, fatal } = require('./lib/harness')

const dir = path.join(os.tmpdir(), 'lumin-save-safety-ws')
const fileA = path.join(dir, 'alpha.md')
const fileB = path.join(dir, 'beta.md')
const DRAFT_KEY_A = 'file-' + encodeURIComponent(fileA.toLowerCase())

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('数据安全：保存期输入 / 草稿上限 / 换文档前 flush / 真实 mtime')

  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(fileA, '# alpha\n\n原始正文\n', 'utf-8')
  fs.writeFileSync(fileB, '# beta\n\n另一个文件\n', 'utf-8')

  try {
    await ev(`(async () => {
      const f = window.__L.files()
      window.__L.ui().sidebarVisible = true
      window.__L.ui().sidebarTab = 'files'
      await f.setRoot(${JSON.stringify(dir)})
      await f.openPath(${JSON.stringify(fileA)})
      return 'ok'
    })()`)
    if (!(await waitEditor(ev))) throw new Error('编辑器未就绪')
    await sleep(1200)

    // ── A. 保存期间继续输入：内容不许被标成"已保存" ────────────────────────
    const a = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        await window.luminAPI.drafts.remove(${JSON.stringify(DRAFT_KEY_A)})
        f.setContent('AAA-第一版', 'external')
        const p = f.save()              // 不 await：模拟"保存还在路上"
        f.setContent('BBB-保存期间敲的', 'external')   // 写盘期间的新输入
        await p
        const onDisk = await window.luminAPI.file.read(${JSON.stringify(fileA)})
        const draft = await window.luminAPI.drafts.load(${JSON.stringify(DRAFT_KEY_A)})
        return JSON.stringify({
          dirty: f.dirty,
          contentNow: f.current.content,
          savedContent: f.current.savedContent,
          disk: onDisk.content,
          draftKept: !!draft && draft.content.length > 0
        })
      })()`)
    )
    report.note('A ' + JSON.stringify(a))
    report.check(
      'save-keeps-dirty-when-content-changed',
      a.dirty === true && a.contentNow === 'BBB-保存期间敲的' && a.savedContent === 'AAA-第一版',
      `dirty=${a.dirty} / 内存=${a.contentNow} / 记账=${a.savedContent}（写盘期间的新输入必须仍算未保存）`
    )
    report.check(
      'save-written-snapshot-not-newer-content',
      a.disk.includes('AAA-第一版') && !a.disk.includes('BBB'),
      `磁盘上是发起保存时的那一份快照：${JSON.stringify(a.disk.slice(0, 40))}`
    )
    report.check(
      'draft-not-deleted-while-still-dirty',
      a.draftKept === true,
      '还有未保存内容时草稿不能被删（它正是崩溃恢复的依据）'
    )

    // ── B. 连续输入期间草稿必须有一份（最大等待 10s）─────────────────────
    const b = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        const key = ${JSON.stringify(DRAFT_KEY_A)}
        await window.luminAPI.drafts.remove(key)
        f.lastDraftAt = Date.now()      // 假装"刚写过一份"→ 只有最大等待能救场
        let mid = 0
        for (let i = 1; i <= 60; i++) {
          f.setContent('y'.repeat(i * 10), 'external')
          await new Promise((r) => setTimeout(r, 200))
          if (i === 55) {                // ≈11s 处采样（此时尾沿防抖早已被无限推迟）
            const d = await window.luminAPI.drafts.load(key)
            mid = d && d.content ? d.content.length : 0
          }
        }
        const last = await window.luminAPI.drafts.load(key)
        return JSON.stringify({ mid, end: last && last.content ? last.content.length : 0 })
      })()`)
    )
    report.note('B ' + JSON.stringify(b))
    report.check(
      'draft-written-during-continuous-typing',
      b.mid > 0,
      `连续输入 11s 时草稿长度=${b.mid}（0 = 纯尾沿防抖，会一直推迟到停手为止）`
    )

    // ── C. 换文档前先 flush：脏内容必须触发确认 ───────────────────────────
    const c = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        await f.openPath(${JSON.stringify(fileA)})
        await new Promise((r) => setTimeout(r, 400))
        const ed = window.__L.ed()
        window.__L.editor().markDirty = window.__L.editor().markDirty  // 保持原实现（只为可读性）
        ed.commands.insertContent('新敲的字')   // 触发 onUpdate → editorStore.dirty=true（序列化仍在 250ms 防抖里）
        const storeDirtyBefore = f.dirty         // 此刻 store 还看不见这次输入
        const editorDirty = window.__L.editor().dirty === true
        // 走真实入口：点文件树里的另一个文件
        const row = [...document.querySelectorAll('[data-tree-row]')].find(
          (r) => String(r.getAttribute('data-tree-path')).endsWith('beta.md')
        )
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 500))
        const ui = window.__L.ui()
        const asked = ui.confirmState ? ui.confirmState.title : null
        const stillOnA = String(f.current?.path ?? '').endsWith('alpha.md')
        return JSON.stringify({ storeDirtyBefore, editorDirty, asked, stillOnA })
      })()`)
    )
    report.note('C ' + JSON.stringify(c))
    report.check(
      'switch-flushes-pending-editor-change',
      c.editorDirty === true && typeof c.asked === 'string' && c.stillOnA === true,
      `flush 前 store.dirty=${c.storeDirtyBefore}；点击另一个文件后弹确认=${JSON.stringify(c.asked)}（应为字符串）且仍停在原文档`
    )
    // 取消这次确认，恢复干净状态
    await ev(
      `(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(false); return 'ok' })()`
    )
    await sleep(400)

    // ── D. 写盘返回真实 mtime ─────────────────────────────────────────────
    const d = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        f.setContent('# alpha\\n\\n真实 mtime 检查\\n', 'external')
        await f.save()
        const st = await window.luminAPI.file.read(${JSON.stringify(fileA)})
        return JSON.stringify({
          storeMtime: f.current.mtimeMs,
          diskMtime: st.mtimeMs,
          delta: Math.abs((f.current.mtimeMs ?? 0) - st.mtimeMs)
        })
      })()`)
    )
    report.note('D ' + JSON.stringify(d))
    report.check(
      'mtime-comes-from-disk',
      d.delta < 50,
      `store=${d.storeMtime} / 磁盘=${d.diskMtime}（差 ${d.delta}ms；用 Date.now() 冒充时这会明显偏大）`
    )

    // ── E. 串行化：两次并发 save 不会互相插队 ──────────────────────────────
    const e = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        f.setContent('并发一', 'external')
        const p1 = f.save()
        f.setContent('并发二', 'external')
        const p2 = f.save()
        const [r1, r2] = await Promise.all([p1, p2])
        const onDisk = await window.luminAPI.file.read(${JSON.stringify(fileA)})
        const leftovers = (await window.luminAPI.drafts.load(${JSON.stringify(DRAFT_KEY_A)}))?.content ?? ''
        return JSON.stringify({ r1, r2, disk: onDisk.content.trim(), dirty: f.dirty })
      })()`)
    )
    report.note('E ' + JSON.stringify(e))
    report.check(
      'concurrent-saves-are-serialized',
      e.r1 === true && e.r2 === true && (e.disk === '并发二' || e.dirty === true),
      `两次保存都成功，磁盘是完整的一份（不出现交错内容）：${JSON.stringify(e.disk)} / dirty=${e.dirty}`
    )

    // ── F. 写盘失败必须**看得见**（审计 §2 P1：退避重试 + 持久通知 + 状态栏红态）──
    // 造一个真实会失败的写盘：把文件设成只读（Windows 上 rename 覆盖只读文件 = EPERM，
    // 实测 `fs.chmodSync(file, 0o444)` 之后 `fs.rename` 必失败）。
    // 用户视角的对应场景是"文件被别的程序占用 / 磁盘满 / 只读盘"。
    fs.chmodSync(fileA, 0o444)
    const f1 = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        f.setContent('只读写不进去', 'external')
        const ok = await f.save()
        // 状态栏那一格：失败要变成 danger 色 + 专属文案（不能还写着"未保存的更改"）
        const cell = document.querySelector('[data-save-cell]')
        return JSON.stringify({
          ok,
          saveError: f.saveError,
          retryScheduled: f.saveRetryDelay > 0,
          cellText: (cell?.textContent ?? '').trim(),
          cellError: cell?.getAttribute('data-save-error') ?? null,
          dangerClass: (cell?.className ?? '').includes('text-danger')
        })
      })()`)
    )
    report.note('F ' + JSON.stringify(f1))
    report.check(
      'failed-save-reports-false-and-keeps-error',
      f1.ok === false && typeof f1.saveError === 'string' && f1.saveError.length > 0,
      `ok=${f1.ok} reason=${f1.saveError}`
    )
    report.check(
      'failed-save-schedules-backoff-retry',
      f1.retryScheduled === true,
      `退避延时 > 0（失败后必须继续尝试落盘，不能一停手就永远不试）`
    )
    report.check(
      'status-bar-shows-failure-state',
      f1.cellError !== null && f1.dangerClass === true && f1.cellText !== '',
      JSON.stringify({
        cellText: f1.cellText,
        cellError: f1.cellError,
        dangerClass: f1.dangerClass
      })
    )
    const notified = JSON.parse(
      await ev(`(async () => {
        const list = await window.luminAPI.notifications.list({ includeClosed: true })
        // 通知里不带 mergeKey（它在库里只用于合并），按"error 级 + 标题含文件名"找
        const hit = list.find((n) => n.level === 'error' && String(n.title).includes('alpha.md'))
        return JSON.stringify({ total: list.length, hit: hit ? { level: hit.level, title: hit.title, body: hit.body, closed: hit.closedAt } : null })
      })()`)
    )
    report.check(
      'failed-save-leaves-persistent-notification',
      !!notified.hit && notified.hit.closed === null && String(notified.hit.body).length > 0,
      JSON.stringify(notified.hit)
    )

    // 恢复可写后：错误态要**自动消失**（否则用户永远看到一格红的）
    fs.chmodSync(fileA, 0o666)
    const f2 = JSON.parse(
      await ev(`(async () => {
        const f = window.__L.files()
        const ok = await f.save()
        const cell = document.querySelector('[data-save-cell]')
        return JSON.stringify({
          ok,
          saveError: f.saveError,
          dirty: f.dirty,
          cellError: cell?.getAttribute('data-save-error') ?? null,
          cellText: (cell?.textContent ?? '').trim()
        })
      })()`)
    )
    report.note('F2 ' + JSON.stringify(f2))
    report.check(
      'successful-save-clears-failure-state',
      f2.ok === true && f2.saveError === null && f2.cellError === null && f2.dirty === false,
      JSON.stringify(f2)
    )
  } finally {
    // F 段把 alpha.md 设成了只读：先恢复可写，否则 Windows 上删目录会失败
    try {
      fs.chmodSync(fileA, 0o666)
    } catch {
      /* ignore */
    }
    await ev(`(async () => {
      await window.luminAPI.drafts.remove(${JSON.stringify(DRAFT_KEY_A)})
      await window.__L.files().setRoot(null)
      return 'ok'
    })()`).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }

  app.close()
  process.exit(report.finish())
}

main().catch((e) => fatal(e))
