// `src/main/zip.ts`：无依赖的 ZIP 写入器（EPUB 与工作区快照共用）。
//
// 为什么值得单测：ZIP 是**二进制格式**，写错了不会报错，只会产出一个"看着像 zip、
// 双击打不开"的文件 —— 而它的两个用途都很要命：EPUB 是给阅读器的成品，
// 工作区快照是用户唯一的整体兜底。所以这里不复用被测代码的任何常量，
// 而是**自己按 ZIP 规范解析字节**（EOCD → 中央目录 → 本地头），
// 再用 `zlib.inflateRawSync` 还原内容、用 `zlib.crc32` 独立校验校验和。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, zipDeflate, zipStore } from '../src/main/zip.ts'
import { inflateRawSync, crc32 as zlibCrc32 } from 'node:zlib'
import { randomBytes } from 'node:crypto'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** 按 ZIP 规范解析出条目（独立于被测实现的读法） */
function readZip(buf) {
  // EOCD 在末尾（没有归档注释时就是最后 22 字节）
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  assert.notEqual(eocd, -1, '找不到 EOCD：这不是一个有效的 zip')
  const count = buf.readUInt16LE(eocd + 10)
  const centralSize = buf.readUInt32LE(eocd + 12)
  let p = buf.readUInt32LE(eocd + 16)
  assert.equal(p + centralSize, eocd, '中央目录长度与 EOCD 记录不符')

  const entries = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), SIG_CENTRAL, `第 ${i} 条中央目录签名不对`)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8')

    // 本地头（数据偏移以**本地头**里的 name/extra 长度为准：两者允许不同）
    assert.equal(buf.readUInt32LE(localOffset), SIG_LOCAL, `${name} 的本地头签名不对`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const payload = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 8 ? inflateRawSync(payload) : payload

    assert.equal(
      buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString('utf-8'),
      name
    )
    assert.equal(data.length, rawSize, `${name} 解出来的长度与声明的原始长度不符`)
    assert.equal(zlibCrc32(data) >>> 0, crc, `${name} 的 CRC-32 不对`)
    entries.push({ name, method, crc, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

test('zipStore：STORE 不压缩，内容逐字节还原（EPUB 的 mimetype 必须这样）', () => {
  const mimetype = Buffer.from('application/epub+zip', 'utf-8')
  const entries = readZip(zipStore([{ name: 'mimetype', data: mimetype }]))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'mimetype')
  assert.equal(entries[0].method, 0, 'STORE 的压缩方法必须是 0')
  assert.deepEqual(entries[0].data, mimetype)
})

test('zip：条目顺序与传入顺序一致（EPUB 规范要求 mimetype 是第一条）', () => {
  const names = readZip(
    zipStore([
      { name: 'mimetype', data: Buffer.from('application/epub+zip') },
      { name: 'META-INF/container.xml', data: Buffer.from('<container/>') },
      { name: 'OEBPS/chapter-1.xhtml', data: Buffer.from('<html/>') }
    ])
  ).map((e) => e.name)
  assert.deepEqual(names, ['mimetype', 'META-INF/container.xml', 'OEBPS/chapter-1.xhtml'])
})

test('zipDeflate：可压缩内容真的被压了（DEFLATE 方法 8 + 体积更小）', () => {
  const text = Buffer.from('工作区快照\n'.repeat(500), 'utf-8')
  const zip = zipDeflate([{ name: 'notes/a.md', data: text }])
  const entries = readZip(zip)
  assert.equal(entries[0].method, 8)
  assert.deepEqual(entries[0].data, text)
  assert.ok(
    zip.length < text.length / 2,
    `重复文本应该压掉一半以上：原始 ${text.length} → zip ${zip.length}`
  )
})

test('zipDeflate：压不小的条目退回 STORE（图片这类已压缩数据不会越压越大）', () => {
  // 真随机字节：DEFLATE 在它上面只会净增（每个块的头开销）
  const noise = randomBytes(4096)
  const zip = zipDeflate([{ name: 'a.png', data: noise }])
  const entries = readZip(zip)
  assert.equal(entries[0].method, 0, '压不小就该原样存，别白白多几百字节头')
  assert.deepEqual(entries[0].data, noise)
  assert.ok(zip.length < noise.length + 128, `zip 不该因为"压缩"而变大：${zip.length}`)
})

test('zip：UTF-8 文件名（中文目录）能正确往返，且设置了 0x0800 标志', () => {
  const buf = zipDeflate([{ name: '随笔/秋天.md', data: Buffer.from('# 秋') }])
  const entries = readZip(buf)
  assert.equal(entries[0].name, '随笔/秋天.md')
  assert.deepEqual(entries[0].data, Buffer.from('# 秋'))
  // 本地头的通用位标记第 11 位 = 文件名为 UTF-8
  assert.equal((buf.readUInt16LE(6) & 0x0800) !== 0, true)
})

test('zip：空条目与空归档都不炸（0 字节文件是合法的）', () => {
  const empty = readZip(zipStore([{ name: 'empty.txt', data: Buffer.alloc(0) }]))
  assert.equal(empty.length, 1)
  assert.equal(empty[0].data.length, 0)
  const none = readZip(zipStore([]))
  assert.deepEqual(none, [])
})

test('crc32：与 zlib 的实现逐值一致（自己写的查表不能有一点偏差）', () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('123456789'), // CRC-32 的标准测试向量 = 0xCBF43926
    Buffer.from('汉字与 emoji 🎯 混合'),
    Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
  ]
  for (const s of samples) {
    assert.equal(crc32(s) >>> 0, zlibCrc32(s) >>> 0, `长度为 ${s.length} 的样本 CRC 不一致`)
  }
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('readZip 自证：被破坏的字节会被认出来（校验和真的在起作用）', () => {
  const buf = zipStore([{ name: 'a.md', data: Buffer.from('hello world') }])
  const bad = Buffer.from(buf)
  // 翻掉**数据区**的第一个字节：长度声明仍然自洽，只有 CRC 能发现内容变了
  bad[30 + 4] ^= 0xff
  assert.throws(() => readZip(bad), /CRC/)
  assert.deepEqual(readZip(buf)[0].data, Buffer.from('hello world'), '原文件仍然可读')
})
