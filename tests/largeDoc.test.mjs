// ─── 大文档降级闸的纯函数（本轮新增），对应 src/renderer/src/lib/largeDoc.ts ────
//
// 背景（实测，见桌面《待优化清单》F 项）：代码围栏是唯一的性能悬崖 —— 500 块文档打开 22.8s、
// 1500 块 >185s 且进程常驻 1.4GB；而纯散文 572k 字符只要 2.24s。降级闸按"围栏块数 / 字符数"
// 判定，超阈值直接进源码模式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEAVY_CHARS, HEAVY_FENCES, docLoad, isHeavyDoc } from '../src/renderer/src/lib/largeDoc.ts'

const fence = '```js\nconst a = 1\n```\n'
const prose = (n) => '这是一段散文。'.repeat(n)

test('围栏按对计数（``` 与 ~~~ 都算，含 0–3 空格缩进）', () => {
  assert.equal(docLoad(fence).fences, 1)
  assert.equal(docLoad(fence.repeat(3)).fences, 3)
  assert.equal(docLoad('~~~\ncode\n~~~\n').fences, 1)
  assert.equal(docLoad('   ```\ncode\n   ```\n').fences, 1, '列表里的围栏也算')
  assert.equal(docLoad('```\n未闭合\n').fences, 1, '未闭合的同样会建一个 CM，按一块算')
  assert.equal(docLoad('普通段落，没有围栏。').fences, 0)
})

test('行内反引号不算围栏', () => {
  assert.equal(docLoad('这是 `行内代码`，不是围栏。').fences, 0)
  assert.equal(docLoad('四个反引号 ````` 在行内也不匹配（必须行首）').fences, 0)
})

test('阈值：正常文档不降级，结构密集或超大文档降级', () => {
  assert.equal(isHeavyDoc(fence.repeat(HEAVY_FENCES - 1)), false)
  assert.equal(isHeavyDoc(fence.repeat(HEAVY_FENCES)), true, `${HEAVY_FENCES} 块起降级`)
  assert.equal(isHeavyDoc(prose(HEAVY_CHARS / 8)), false)
  assert.equal(isHeavyDoc('x'.repeat(HEAVY_CHARS)), true, `${HEAVY_CHARS} 字符起降级`)
})

test('真实量级自检：用户的稿子（1.6 万字 / 少量围栏）不该被闸到', () => {
  const draft = '# 剧本\n\n' + prose(2400) + '\n' + fence.repeat(3)
  const load = docLoad(draft)
  assert.ok(load.chars > 16000, '样本量级对得上（实际 ' + load.chars + '）')
  assert.equal(isHeavyDoc(draft), false)
})

test('docLoad 返回的字符数就是内容长度（含空白）', () => {
  const s = '# 标题\n\n正文\n'
  assert.equal(docLoad(s).chars, s.length)
})
