// ─── 原子写的 IO 单测（报告 §6.2「IO 层没有单测」的落地）──────────────────────
//
// 背景：`fileOps.ts` 里那段"同目录临时文件 → fsync → rename"此前**手抄了三遍**
// （文本写 / 二进制写 / 备份复制），而 `fileOps.ts` import 了 electron（回收站用 shell）、
// `services/database`、`services/encoding` —— 于是写作工具**最不能出错**的一段代码
// 在 `node --test` 里根本 import 不进来，只能靠 CDP 套件从外面敲。
// 波次 2 把它抽成 `src/main/services/atomicWrite.ts`（零 electron 依赖），这里用临时目录
// 直接对 IO 断言。每一条都对应一种"用户会丢内容"的真实故障。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  PARENT_MISSING,
  TMP_SUFFIX,
  atomicWrite,
  atomicWriteBytes,
  atomicWriteEncoded,
  copyFileAtomic,
  tempPathFor
} from '../src/main/services/atomicWrite.ts'
import { TEMP_SUFFIX_RE } from '../src/shared/tempName.ts'

/** 每个用例一个全新临时目录（互不干扰，跑完删掉） */
function makeDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lumin-atomic-${name}-`))
  return dir
}

const tmpFilesIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(TMP_SUFFIX))

test('写入即替换：内容整份换掉，返回的是写完后磁盘上的真实 mtimeMs', async () => {
  const dir = makeDir('replace')
  try {
    const file = path.join(dir, 'note.md')
    fs.writeFileSync(file, '旧的一版\n', 'utf-8')
    const before = fs.statSync(file).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    const mtimeMs = await atomicWriteEncoded(file, () => Buffer.from('# 新的一版\n', 'utf-8'))
    assert.equal(fs.readFileSync(file, 'utf-8'), '# 新的一版\n')
    const st = fs.statSync(file)
    assert.equal(mtimeMs, st.mtimeMs, '返回的 mtimeMs 必须等于磁盘上的真实值')
    assert.ok(st.mtimeMs >= before, 'mtime 应该前进')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('不留垃圾：成功之后目录里只有目标文件，没有 .lumin-tmp', async () => {
  const dir = makeDir('noclean')
  try {
    const file = path.join(dir, 'a.md')
    await atomicWriteBytes(file, Buffer.from('x'))
    await atomicWriteBytes(file, Buffer.from('y'))
    assert.deepEqual(tmpFilesIn(dir), [], `残留临时文件：${tmpFilesIn(dir).join(', ')}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('父目录不存在 → 抛 PARENT_MISSING，且**绝不**把目录建出来（审计 §2 P1 第 124 条）', async () => {
  const dir = makeDir('parent')
  try {
    const target = path.join(dir, 'gone', 'note.md')
    await assert.rejects(
      () => atomicWriteEncoded(target, () => Buffer.from('x')),
      (err) => String(err.message) === PARENT_MISSING,
      '父目录缺失必须抛 PARENT_MISSING'
    )
    assert.equal(fs.existsSync(path.join(dir, 'gone')), false, '目录被凭空重建了（旧 bug 会这样）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('requireParent: false 时按老语义 mkdir -p（二进制/备份/导出通道）', async () => {
  const dir = makeDir('mkdirp')
  try {
    const target = path.join(dir, 'assets', 'deep', 'pic.bin')
    await atomicWriteBytes(target, Buffer.from([1, 2, 3]), { requireParent: false })
    assert.deepEqual([...fs.readFileSync(target)], [1, 2, 3])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('失败必须收拾干净：rename 失败时不留临时文件、错误原样抛出', async () => {
  const dir = makeDir('fail')
  try {
    // 把**目标路径**做成一个非空目录：rename(tmp, 目录) 在 Windows/POSIX 上都会失败
    const target = path.join(dir, 'occupied')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'inside.txt'), 'x')
    await assert.rejects(() => atomicWriteBytes(target, Buffer.from('payload')))
    assert.deepEqual(tmpFilesIn(dir), [], `失败后残留临时文件：${tmpFilesIn(dir).join(', ')}`)
    assert.equal(fs.readFileSync(path.join(target, 'inside.txt'), 'utf-8'), 'x', '目标没被破坏')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('临时路径：与目标同目录、带 8 位随机后缀、能被 shared/tempName 的正则识别', () => {
  const dir = makeDir('tempname')
  try {
    const file = path.join(dir, 'note.md')
    const a = tempPathFor(file)
    const b = tempPathFor(file)
    assert.notEqual(a, b, '两次生成的临时名必须不同（两个写入者不能互相覆盖）')
    assert.equal(path.dirname(a), dir, '临时文件必须与目标同目录（跨盘 rename 不是原子的）')
    assert.ok(
      path.basename(a).startsWith('note.md.'),
      `临时名要以目标文件名为前缀：${path.basename(a)}`
    )
    assert.match(path.basename(a), TEMP_SUFFIX_RE, '后缀要能被启动清扫的残留正则识别')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('大字节完整性：1 MiB 随机数据逐字节往返（原子写不能截断）', async () => {
  const dir = makeDir('big')
  try {
    const file = path.join(dir, 'blob.bin')
    const bytes = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256
    await atomicWriteBytes(file, bytes)
    const back = fs.readFileSync(file)
    assert.equal(back.length, bytes.length)
    assert.equal(Buffer.compare(back, bytes), 0, '1 MiB 内容必须逐字节一致')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('并发写同一路径：最终磁盘上是**完整的一方**，不是两份的混合', async () => {
  const dir = makeDir('race')
  try {
    const file = path.join(dir, 'race.md')
    const A = 'A'.repeat(200_000)
    const B = 'B'.repeat(200_000)
    await Promise.all([
      atomicWriteEncoded(file, () => Buffer.from(A, 'utf-8')),
      atomicWriteEncoded(file, () => Buffer.from(B, 'utf-8'))
    ])
    const final = fs.readFileSync(file, 'utf-8')
    assert.ok(
      final === A || final === B,
      `最终内容既不是 A 也不是 B（长度 ${final.length}，说明两次写互相污染了）`
    )
    /**
     * 临时文件最终必须消失 —— 但**轮询一下再断言**：
     * 这条与另外 90 个测试文件并行跑（`node --test` 是每文件一个进程），
     * 负载高时 Windows 的目录项更新可能比 `Promise.all` 的 resolve 晚一拍，
     * 于是"刚 resolve 就 readdir"偶尔会看到还没消失的那一个（实测偶发一次，
     * 单跑 10/10 全绿）。给它 1 秒宽限，判据本身没变松。
     */
    let leftovers = tmpFilesIn(dir)
    for (let i = 0; i < 20 && leftovers.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
      leftovers = tmpFilesIn(dir)
    }
    assert.deepEqual(leftovers, [], '并发写之后不该留下临时文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('原子复制：目标先建目录、内容一致、不留临时文件（备份库文件那条路）', async () => {
  const dir = makeDir('copy')
  try {
    const src = path.join(dir, 'lumin.db')
    fs.writeFileSync(src, 'SQLite-ish bytes')
    const dest = path.join(dir, 'backups', '2026', 'lumin.db')
    await copyFileAtomic(src, dest)
    assert.equal(fs.readFileSync(dest, 'utf-8'), 'SQLite-ish bytes')
    assert.deepEqual(tmpFilesIn(path.join(dir, 'backups', '2026')), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('注入式写入（copy 语义）与默认实现走同一条 fsync+rename 路径', async () => {
  const dir = makeDir('inject')
  try {
    const file = path.join(dir, 'x.md')
    const calls = []
    const mtimeMs = await atomicWrite(file, async (tmp) => {
      calls.push(path.basename(tmp))
      await fsp.writeFile(tmp, 'injected')
    })
    assert.equal(fs.readFileSync(file, 'utf-8'), 'injected')
    assert.equal(calls.length, 1, '写回调只该被调用一次')
    assert.ok(Number.isFinite(mtimeMs), '返回 mtimeMs')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
