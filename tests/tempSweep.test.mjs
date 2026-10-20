// ─── 启动清扫的**选择性**（用户报障：D 盘残留 `.lumin-tmp` 的兜底不能误伤别人）───────
//
// 背景：保存路径修好之后（atomicWrite 的 finally + 退出前排空），启动清扫只该处理
// **崩溃/断电**这类 finally 跑不到的残留。旧实现"看到 `*.lumin-tmp` 就删"有三类误伤：
//   1. 用户自己的文件恰好叫 `x.12345678.lumin-tmp`；
//   2. 目标文件已被用户删掉/移走的孤儿临时文件；
//   3. **刚写出来**、另一个窗口/进程正在写的临时文件（删掉等于破坏一次保存）。
//
// 本套件逐条钉住三条判据：本应用命名 + 年龄 > 10 分钟 + 同目录有对应目标文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { STALE_TEMP_MIN_AGE_MS, cleanStaleTempFiles } from '../src/main/services/tempSweep.ts'
import { tempTargetName } from '../src/shared/tempName.ts'

const OLD = 20 * 60 * 1000 // 20 分钟前
const FRESH = 60 * 1000 // 1 分钟前

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-sweep-'))
  const write = (name, text = 'x') => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, text)
    return p
  }
  /** 把文件 mtime 调到 `agoMs` 之前 */
  const age = (p, agoMs) => {
    const t = new Date(Date.now() - agoMs)
    fs.utimesSync(p, t, t)
  }
  return { dir, write, age }
}

const names = (dir) => fs.readdirSync(dir).sort()

test('只删：本应用命名 + 陈旧（>10 分钟）+ 同目录有目标文件', async () => {
  const f = fixture()
  try {
    f.write('note.md', '# note\n')
    const stale = f.write('note.md.a1b2c3d4.lumin-tmp', '半写状态')
    f.age(stale, OLD)
    const removed = await cleanStaleTempFiles(f.dir)
    assert.equal(removed, 1, '应只删掉那一个陈旧且有目标的临时文件')
    assert.deepEqual(names(f.dir), ['note.md'])
    assert.equal(fs.readFileSync(path.join(f.dir, 'note.md'), 'utf8'), '# note\n', '目标不许被动')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('刚写出来的（<10 分钟）一律不碰 —— 可能是另一个窗口正在写', async () => {
  const f = fixture()
  try {
    f.write('live.md', 'live\n')
    const fresh = f.write('live.md.deadbeef.lumin-tmp', '正在写')
    f.age(fresh, FRESH)
    const removed = await cleanStaleTempFiles(f.dir)
    assert.equal(removed, 0)
    assert.deepEqual(names(f.dir), ['live.md', 'live.md.deadbeef.lumin-tmp'])
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('没有对应目标文件的孤儿一律不碰（无法证明是我们的、也无法证明没用）', async () => {
  const f = fixture()
  try {
    const orphan = f.write('gone.md.a1b2c3d4.lumin-tmp', '孤儿')
    f.age(orphan, OLD)
    const removed = await cleanStaleTempFiles(f.dir)
    assert.equal(removed, 0)
    assert.deepEqual(names(f.dir), ['gone.md.a1b2c3d4.lumin-tmp'])
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('形状不对的（非 8 位十六进制 / 没有后缀前的名字）不碰 —— 可能是用户自己的文件', async () => {
  const f = fixture()
  try {
    f.write('mine.md', 'mine\n')
    const userish = [
      'mine.md.lumin-tmp', // 没有随机后缀
      'mine.md.zzzzzzzz.lumin-tmp', // 8 位但不是十六进制
      'mine.md.a1b2c3d.lumin-tmp' // 7 位
    ].map((n) => f.write(n, 'user'))
    for (const p of userish) f.age(p, OLD)
    const removed = await cleanStaleTempFiles(f.dir)
    assert.equal(removed, 0)
    assert.deepEqual(names(f.dir), ['mine.md', ...userish.map((p) => path.basename(p))].sort())
    // 反推目标名的函数本身也要与正则同口径
    assert.equal(tempTargetName('mine.md.a1b2c3d4.lumin-tmp'), 'mine.md')
    assert.equal(tempTargetName('mine.md.lumin-tmp'), null)
    assert.equal(tempTargetName('mine.md.zzzzzzzz.lumin-tmp'), null)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('递归子目录照清；隐藏目录与 node_modules 不扫（旧口径保留）', async () => {
  const f = fixture()
  try {
    const sub = path.join(f.dir, 'chapters')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'a.md'), 'a\n')
    const nested = path.join(sub, 'a.md.0123abcd.lumin-tmp')
    fs.writeFileSync(nested, 'nested')
    f.age(nested, OLD)

    const hidden = path.join(f.dir, '.git')
    fs.mkdirSync(hidden)
    fs.writeFileSync(path.join(hidden, 'a.md'), 'a\n')
    const inHidden = path.join(hidden, 'a.md.0123abcd.lumin-tmp')
    fs.writeFileSync(inHidden, 'hidden')
    f.age(inHidden, OLD)

    const nm = path.join(f.dir, 'node_modules')
    fs.mkdirSync(nm)
    fs.writeFileSync(path.join(nm, 'a.md'), 'a\n')
    const inNm = path.join(nm, 'a.md.0123abcd.lumin-tmp')
    fs.writeFileSync(inNm, 'nm')
    f.age(inNm, OLD)

    const removed = await cleanStaleTempFiles(f.dir)
    assert.equal(removed, 1, '只清 chapters 里那一个')
    assert.equal(fs.existsSync(nested), false)
    assert.equal(fs.existsSync(inHidden), true, '隐藏目录不扫')
    assert.equal(fs.existsSync(inNm), true, 'node_modules 不扫')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('注入 now/minAge 的口径：默认 10 分钟，边界按 >= 处理；未来 mtime 不当陈旧', async () => {
  const f = fixture()
  try {
    f.write('t.md', 't\n')
    const temp = f.write('t.md.abcdef01.lumin-tmp', 'x')
    const now = Date.now()
    // 比 now 早 9 分钟：不够陈旧
    fs.utimesSync(temp, new Date(now - 9 * 60 * 1000), new Date(now - 9 * 60 * 1000))
    assert.equal(await cleanStaleTempFiles(f.dir, { now }), 0)
    assert.equal(STALE_TEMP_MIN_AGE_MS, 10 * 60 * 1000)
    // 恰好 10 分钟：删除（判据是 >= minAge）
    fs.utimesSync(temp, new Date(now - 10 * 60 * 1000), new Date(now - 10 * 60 * 1000))
    assert.equal(await cleanStaleTempFiles(f.dir, { now }), 1)

    const future = f.write('t.md.abcdef02.lumin-tmp', 'x')
    fs.utimesSync(future, new Date(now + 60 * 1000), new Date(now + 60 * 1000))
    assert.equal(
      await cleanStaleTempFiles(f.dir, { now }),
      0,
      '未来 mtime（时钟回拨）不许当陈旧删掉'
    )
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('目标存在但是目录时不算"对应的目标文件"', async () => {
  const f = fixture()
  try {
    fs.mkdirSync(path.join(f.dir, 'weird.md'))
    const temp = f.write('weird.md.a1b2c3d4.lumin-tmp', 'x')
    f.age(temp, OLD)
    assert.equal(await cleanStaleTempFiles(f.dir), 0)
    assert.equal(fs.existsSync(temp), true)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})
