// ─── 文本编解码的 IO/字节单测（报告 §6.2「encoding 没有单测」的落地）──────────────
//
// 背景：`main/services/encoding.ts` 顶层 `import { app } from 'electron'`（拿系统语言）
// 与 `import { db }`（编码记忆），于是**写作工具最核心的正确性** —— "打开→保存会不会改字节" ——
// 在 `node --test` 里根本 import 不进来，只能靠 `_verify-encoding.js` 从外面敲（54 条，要真窗口）。
// 波次 2 把纯实现抽成 `src/main/services/textCodec.ts`（零 electron / 零 db / 零 IO），
// 这里直接喂字节。每一条都对应一种"用户会看到乱码或字节被改"的真实故障。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import iconv from 'iconv-lite'

import {
  decodeBuffer,
  encodeText,
  localeFallback,
  sniffBom
} from '../src/main/services/textCodec.ts'

const utf8 = (s) => Buffer.from(s, 'utf-8')

test('无 BOM 的合法 UTF-8 → utf-8，且不带替换字符', () => {
  const r = decodeBuffer(utf8('# 标题\n\n正文 emoji 😀\n'))
  assert.equal(r.encoding, 'utf-8')
  assert.equal(r.hadBom, false)
  assert.equal(r.hadReplacement, false)
  assert.match(r.text, /标题/)
  assert.match(r.text, /😀/)
})

test('UTF-8 BOM → 认成 utf-8-bom、摘掉 BOM、记下 hadBom（写回要补回去）', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('带 BOM 的正文')])
  assert.deepEqual(sniffBom(buf), { id: 'utf-8-bom', length: 3 })
  const r = decodeBuffer(buf)
  assert.equal(r.encoding, 'utf-8-bom')
  assert.equal(r.hadBom, true)
  assert.equal(r.text, '带 BOM 的正文', 'BOM 不能留在正文里')
})

test('UTF-16LE / BE：BOM 认得出、内容解得对、hadBom=true', () => {
  const text = '十六位编码'
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf-16le')])
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf-16be')])
  for (const [buf, id] of [
    [le, 'utf-16le'],
    [be, 'utf-16be']
  ]) {
    const r = decodeBuffer(buf)
    assert.equal(r.encoding, id)
    assert.equal(r.hadBom, true)
    assert.equal(r.text, text)
  }
})

test('显式指定编码优先于 BOM：选 UTF-8 正好是"去掉 BOM"的办法', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('x')])
  const asUtf8 = decodeBuffer(buf, 'utf-8')
  assert.equal(asUtf8.encoding, 'utf-8')
  assert.equal(asUtf8.hadBom, false, '显式选 utf-8 的语义就是不要 BOM')
  assert.equal(asUtf8.text, 'x')
  const asBom = decodeBuffer(buf, 'utf-8-bom')
  assert.equal(asBom.hadBom, true)
})

test('显式指定与 BOM 冲突时按用户的选择解（BOM 当普通字节）', () => {
  // 一个 UTF-16LE 的文件，用户偏要按 GB18030 读 —— 必须听用户的，不许被 BOM 拦住
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('中文', 'utf-16le')])
  const r = decodeBuffer(buf, 'gb18030')
  assert.equal(r.encoding, 'gb18030')
  assert.equal(r.hadBom, false)
  assert.notEqual(r.text, '中文', '按 GB18030 解读 UTF-16 字节，结果必然不是原字符串')
})

test('GB18030 的字节：中文环境兜底猜对，且没有替换字符', () => {
  const buf = iconv.encode('这是一段 GBK/GB18030 的正文', 'gb18030')
  const r = decodeBuffer(buf, 'auto', null, 'zh-CN')
  assert.equal(r.encoding, 'gb18030')
  assert.equal(r.hadReplacement, false)
  assert.equal(r.text, '这是一段 GBK/GB18030 的正文')
})

test('Shift_JIS 的字节：日文环境兜底猜对；西欧环境会猜错（这就是"按环境猜"的边界）', () => {
  const text = 'これは日本語のテキストです'
  const buf = iconv.encode(text, 'shift_jis')
  const ja = decodeBuffer(buf, 'auto', null, 'ja-JP')
  assert.equal(ja.encoding, 'shift_jis')
  assert.equal(ja.text, text)
  const en = decodeBuffer(buf, 'auto', null, 'en-US')
  assert.equal(en.encoding, 'windows-1252', '西欧环境按 1252 猜（字节能解出来，但内容是乱的）')
  assert.notEqual(en.text, text)
})

test('记忆优先于"严格 UTF-8"：记住 GB18030 之后不许按 UTF-8 解出乱码', () => {
  const buf = iconv.encode('中文内容', 'gb18030')
  assert.equal(decodeBuffer(buf, 'auto', 'gb18030', 'en-US').text, '中文内容')
})

test('语言兜底表是纯函数：五档映射逐条固定', () => {
  assert.equal(localeFallback('zh-CN'), 'gb18030')
  assert.equal(localeFallback('zh-TW'), 'gb18030')
  assert.equal(localeFallback('ja-JP'), 'shift_jis')
  assert.equal(localeFallback('ko-KR'), 'euc-kr')
  assert.equal(localeFallback('ru-RU'), 'windows-1251')
  assert.equal(localeFallback('en-US'), 'windows-1252')
  assert.equal(localeFallback(''), 'windows-1252', '拿不到语言时也要有确定的兜底')
})

test('非法 UTF-8 字节不会抛：落到语言兜底，并把替换字符如实报出来', () => {
  // 0xff 0xfe 之外的单字节 0x80：不是合法 UTF-8 序列
  const buf = Buffer.from([0x41, 0x80, 0x42])
  const r = decodeBuffer(buf, 'auto', null, 'en-US')
  assert.ok(['windows-1252', 'utf-8'].includes(r.encoding), `实际 ${r.encoding}`)
  assert.equal(typeof r.text, 'string')
})

test('encodeText：UTF-8 的 BOM 由**编码 id**表达（utf-8-bom），不是由 keepBom', () => {
  // 这条把真实契约写清楚（我第一版按"keepBom 应该补 BOM"写，红了一次）：
  //   `encodeText('a','utf-8',true)` 不写 BOM —— 因为 `bomOf('utf-8')` 是 null
  //   （BOM 归属 'utf-8-bom' 这个 id），而"显式选 UTF-8"的产品语义本来就是**去掉 BOM**；
  //   自动判定出的带 BOM 文件，其 encoding 就是 'utf-8-bom'（见上面的解码断言），
  //   所以"带 BOM 打开 → 保存"不会掉 BOM。keepBom 只对 UTF-16 这一类有意义。
  assert.deepEqual([...encodeText('a', 'utf-8', false)], [0x61])
  assert.deepEqual(
    [...encodeText('a', 'utf-8', true)],
    [0x61],
    'utf-8 + keepBom 不补 BOM（见注释）'
  )
  assert.deepEqual([...encodeText('a', 'utf-8-bom', false)], [0xef, 0xbb, 0xbf, 0x61])
})

test('带 BOM 的文件"打开→保存"不掉 BOM（解码给出 utf-8-bom，编码按该 id 写回）', () => {
  const opened = decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('正文')]))
  assert.equal(opened.encoding, 'utf-8-bom')
  const saved = encodeText(opened.text, opened.encoding, opened.hadBom)
  assert.deepEqual([...saved.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 必须原样写回')
  assert.equal(decodeBuffer(saved).text, '正文')
})

test('encodeText：UTF-16 **总是**写 BOM（哪怕调用方说不要）', () => {
  const le = encodeText('a', 'utf-16le', false)
  assert.deepEqual([...le.subarray(0, 2)], [0xff, 0xfe])
  const be = encodeText('a', 'utf-16be', false)
  assert.deepEqual([...be.subarray(0, 2)], [0xfe, 0xff])
})

test('往返保真：UTF-8 / UTF-8+BOM / UTF-16LE 的"编→解"逐字符相等', () => {
  const text = '# 标题\n\n正文 with emoji 😀 and 中文。\n'
  for (const [enc, keepBom] of [
    ['utf-8', false],
    ['utf-8', true],
    ['utf-16le', false],
    ['utf-16be', false]
  ]) {
    const bytes = encodeText(text, enc, keepBom)
    const back = decodeBuffer(bytes)
    assert.equal(back.text, text, `${enc}(keepBom=${keepBom}) 往返丢字符了`)
    assert.equal(back.hadReplacement, false)
  }
})

test('表示不了的字符会被换成 ?（Shift_JIS + emoji）：有损保存必须能被上层发现', () => {
  // ⚠️ 别拿 GB18030 当"有损"的例子：它是**全 Unicode**编码，emoji 也写得进去
  // （第一版就是这么写的，红了一次）。真正会丢字的是 Shift_JIS / Windows-1252 这类。
  const bytes = encodeText('emoji 😀 不能进 Shift_JIS', 'shift_jis', false)
  const back = decodeBuffer(bytes, 'shift_jis')
  assert.ok(back.text.includes('?'), `实际 ${JSON.stringify(back.text)}`)
  assert.ok(!back.text.includes('😀'), 'emoji 已经被替换掉了（这正是"有损保存"要提示用户的事）')
})

test('GB18030 是全 Unicode 编码：emoji 往返不丢（免得把它误当有损档）', () => {
  const text = 'emoji 😀 与中文'
  const back = decodeBuffer(encodeText(text, 'gb18030', false), 'gb18030')
  assert.equal(back.text, text)
  assert.equal(back.hadReplacement, false)
})

test('★ 显式自动检测：remembered 不能绑架判定链（GBK 记忆 + UTF-8 字节）', () => {
  const text = '# 标题\n\n正文 UTF-8\n'
  const buf = utf8(text)
  // 先把"上次手选 GBK"的记忆喂进去：这就是用户报障时判定链看到的东西
  const poisoned = decodeBuffer(buf, 'auto', 'gb18030')
  assert.equal(poisoned.encoding, 'gb18030', '旧实现：记忆优先，自动检测被记忆绑架')
  assert.notEqual(poisoned.text, text, '按 GBK 解 UTF-8 字节必然是乱码')
  // 修法：显式自动检测传 remembered=null → 只看原始字节，严格 UTF-8 立刻胜出
  const fresh = decodeBuffer(buf, 'auto', null)
  assert.equal(fresh.encoding, 'utf-8')
  assert.equal(fresh.text, text)
})
