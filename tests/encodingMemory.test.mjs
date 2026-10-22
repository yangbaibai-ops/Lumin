// 编码往返的诚实性（src/shared/encodingMemory.ts，审计 §2 P1「编码往返可能静默改字节」）。
//
// 这两条规则都很小，但错法都是**静默**的：
//   * 替换字符检测漏了 → 用户"打开→保存"之后字节变了却毫无提示（1 字节 → `EF BF BD`）；
//   * 记忆新鲜度判反了 → 要么旧记忆继续把新文件解成乱码（该忘不忘），
//     要么每次打开都当作过期（用户显式选过的编码白选，每次都被判定链改回去）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPLACEMENT_CHAR,
  encodingMemoryIsFresh,
  hasReplacementChar,
  rememberedForRequest,
  roundTripLossy
} from '../src/shared/encodingMemory.ts'
import iconv from 'iconv-lite'

test('hasReplacementChar：只认 U+FFFD，普通文本（含 emoji/生僻字）都不算', () => {
  assert.equal(hasReplacementChar('正常文本'), false)
  assert.equal(hasReplacementChar('emoji 🎯 与生僻字 龘'), false)
  assert.equal(hasReplacementChar(`坏字节${REPLACEMENT_CHAR}在这里`), true)
  // 单独一个替换字符也算（空文件不算）
  assert.equal(hasReplacementChar(REPLACEMENT_CHAR), true)
  assert.equal(hasReplacementChar(''), false)
})

test('hasReplacementChar：真实的有损解码能被认出来（非法 UTF-8 字节）', () => {
  // GBK 的「你好」字节，按 UTF-8 有损解码 → 必然出现替换字符
  const gbkBytes = iconv.encode('你好', 'gbk')
  const lossy = new TextDecoder('utf-8').decode(gbkBytes)
  assert.equal(hasReplacementChar(lossy), true, '非 fatal 解码会插入 U+FFFD')
  // 同一串字节按 GBK 解就没有替换字符
  assert.equal(hasReplacementChar(iconv.decode(gbkBytes, 'gbk')), false)
})

test('encodingMemoryIsFresh：mtime 一致才信；拿不到时间戳时按"信"处理', () => {
  assert.equal(encodingMemoryIsFresh(1000, 1000), true)
  assert.equal(encodingMemoryIsFresh(1000, 1000.5), true, '容差 1ms')
  assert.equal(encodingMemoryIsFresh(1000, 1002), false, '文件被换过 → 记忆过期')
  // 老记录没有 mtime / stat 失败：宁可沿用旧行为，也不要把用户选过的编码丢掉
  assert.equal(encodingMemoryIsFresh(null, 1000), true)
  assert.equal(encodingMemoryIsFresh(undefined, 1000), true)
  assert.equal(encodingMemoryIsFresh(1000, null), true)
  assert.equal(encodingMemoryIsFresh(Number.NaN, 1000), true)
})

test('roundTripLossy：往返一致 = 不丢字；被替换成 ? 就判为有损', () => {
  assert.equal(roundTripLossy('普通中文', '普通中文'), false)
  // GBK 里表示不了 emoji：iconv 会换成 '?'，往返就对不上
  const withEmoji = '正文 🎯 结束'
  const back = iconv.decode(iconv.encode(withEmoji, 'gbk'), 'gbk')
  assert.equal(roundTripLossy(withEmoji, back), true)
  assert.ok(back.includes('?'), `GBK 往返应当出现替代字符：${JSON.stringify(back)}`)
  // 同一段文本用 UTF-8 编解码则一模一样
  assert.equal(roundTripLossy(withEmoji, Buffer.from(withEmoji, 'utf-8').toString('utf-8')), false)
})

test('★ rememberedForRequest：显式自动检测忽略记忆；打开文件时的软默认仍用记忆', () => {
  // 用户报障的核心：手选 GBK → 记忆=gbk；再点自动检测必须不吃这份记忆
  assert.equal(rememberedForRequest('auto', 'gbk', false), null)
  assert.equal(rememberedForRequest('auto', 'gbk', undefined), null)
  // 打开文件（软默认）仍然记忆优先：同一文件多窗口一致
  assert.equal(rememberedForRequest('auto', 'gbk', true), 'gbk')
  // 显式具体编码：记忆本来就不参与（返回什么都不会被 decoder 使用）
  assert.equal(rememberedForRequest('utf-8', 'gbk', false), 'gbk')
  assert.equal(rememberedForRequest('auto', null, false), null)
})
