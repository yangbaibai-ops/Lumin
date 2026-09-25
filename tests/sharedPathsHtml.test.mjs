// 跨进程共用的纯字符串路径工具与 HTML 转义（src/shared/paths.ts / src/shared/html.ts）。
//
// 这两块以前各有两份实现（主进程一份、渲染层一份），而"两份漂移"这件事对
// `escapeHtml` 尤其危险：导出件是要被浏览器打开的，少转一个引号就是一个注入点。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isInsideByString, normPath, parentDir, samePath } from '../src/shared/paths.ts'
import { escapeHtml } from '../src/shared/html.ts'

test('shared/paths：normPath 归一大小写与分隔符、去尾部分隔符', () => {
  assert.equal(normPath('D:/Notes/Sub/'), 'd:\\notes\\sub')
  assert.equal(normPath('D:\\Notes\\\\'), 'd:\\notes')
})

test('shared/paths：samePath 对 null / undefined 安全', () => {
  assert.equal(samePath('D:\\a\\b.md', 'd:/a/B.MD'), true)
  assert.equal(samePath(null, null), false)
  assert.equal(samePath(undefined, 'D:\\a'), false)
  assert.equal(samePath('', 'D:\\a'), false)
})

test('shared/paths：isInsideByString 是**字面**判断（不解析 `..`）——这是刻意的', () => {
  assert.equal(isInsideByString('C:\\Docs', 'C:\\Docs\\a.md'), true)
  assert.equal(isInsideByString('C:\\Docs', 'C:\\Docs2\\a.md'), false)
  assert.equal(isInsideByString(null, 'C:\\Docs\\a.md'), false)
  // ⚠️ 纯字符串版本**不做** `..` 解析：这一条就是"防逃逸必须用主进程那份"的证据
  assert.equal(
    isInsideByString('C:\\Docs', 'C:\\Docs\\..\\..\\evil.md'),
    true,
    '字面判断会放行 `..`（所以护栏要用 src/main/pathGuard.ts）'
  )
})

test('shared/paths：parentDir 覆盖裸文件名与盘根', () => {
  assert.equal(parentDir('C:\\x'), 'C:\\')
  assert.equal(parentDir('a.md'), '')
  assert.equal(parentDir('D:\\a\\b\\c.md'), 'D:\\a\\b')
  assert.equal(parentDir('D:\\a\\b\\'), 'D:\\a')
})

test('shared/html：escapeHtml 五个字符都转（含引号）', () => {
  assert.equal(
    escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'
  )
  assert.equal(escapeHtml(''), '')
  // null/undefined 不能变成 "undefined"（标题可能缺省）
  assert.equal(escapeHtml(undefined), '')
  assert.equal(escapeHtml(null), '')
})

test('shared/html：& 先转，不产生二次转义漏洞', () => {
  // 若先转 < 再转 &，`&lt;` 会变成 `&amp;lt;`（显示成字面 `&lt;`）——顺序错了就是双重转义
  assert.equal(escapeHtml('&lt;'), '&amp;lt;')
  assert.equal(escapeHtml('&'), '&amp;')
})
