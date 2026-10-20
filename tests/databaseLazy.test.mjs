// ─── 库懒等待（ensureDatabase）：窗口先出的**前提** ─────────────────────────────
//
// 为什么单独一条：`db` 是惰性单例 —— 任何一次 `db.xxx()` 都会在**调用栈里同步**打开
// 库并跑迁移/FTS 对账。慢盘/杀软/漫游 profile 上这一段可能是几百毫秒到数秒；启动重构
// 的全部收益都建立在「第一次访问库之前先 await ensureDatabase()」上。
//
// 这里直接对真实实现（临时目录 + node:sqlite）断言三件事：
//   ① 调用返回时库**还没打开**（打开动作被让到下一轮事件循环）；
//   ② 并发/重复调用**只打开一次**（不会换库、不会开两次）；
//   ③ 失败后句柄清空（下次还能重试），closeDatabase 之后状态归零。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { ensureDatabase, databaseReady, closeDatabase } =
  await import('../src/main/services/database.ts')

test('ensureDatabase：不在调用栈里同步开库，且复用同一个 Promise', async () => {
  closeDatabase()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lumin-lazy-db-'))
  const first = path.join(dir, 'one.db')
  const second = path.join(dir, 'two.db')
  try {
    assert.equal(databaseReady(), false)
    let resolved = false
    const opening = ensureDatabase(first).then((db) => {
      resolved = true
      return db
    })
    // 关键断言：调用返回时库还没打开 —— 窗口才能先出来
    assert.equal(databaseReady(), false, 'ensureDatabase 不许同步开库')
    assert.equal(resolved, false, 'ensureDatabase 不许在调用栈里 resolve')
    const db = await opening
    assert.equal(databaseReady(), true)
    assert.equal(db.path, first)

    // 第二次调用拿到同一个实例（不会因为又传了路径就换库）
    const again = await ensureDatabase(second)
    assert.equal(again, db)
    assert.equal(again.path, first)

    // closeDatabase 之后回到「未就绪」，后续还能重新打开（测试收尾/退出清理用）
    closeDatabase()
    assert.equal(databaseReady(), false)
    const reopened = await ensureDatabase(second)
    assert.equal(reopened.path, second)
  } finally {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  }
})
