// 粘贴护栏（纯判据）单测：规模扫描 / 判定 / 占位 / 超时回滚判据
//
// 对应本轮报障：思源式 HTML（大 base64 + 深嵌套 + 多表）粘贴把主线程卡死。
// 这里只钉**纯函数**：扩展接线（handlePaste / 看门狗）由 e2e 套件覆盖。
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  PASTE_FALLBACK_TEXT_CHARS,
  PASTE_HARD_SINGLE_IMAGE_BYTES,
  PASTE_MAX_DEPTH,
  PASTE_MAX_ELEMENTS,
  PASTE_SOFT_SINGLE_IMAGE_BYTES,
  decidePaste,
  dataUriBytesOfTag,
  omitOversizedInlineImages,
  plainTextFallback,
  scanPastedHtml,
  shouldRollback
} from '../src/renderer/src/lib/editor/pasteGuardCore.ts'

const labels = { omittedImage: (mb) => `[IMG ${mb}]` }

/** 造一张 data URI 图片的 HTML 片段（不真的编码，长度即代表字节预算） */
function img(bytes, attrs = '') {
  return `<img src="data:image/png;base64,${'A'.repeat(bytes)}" ${attrs}/>`
}
function doc(inner) {
  return `<div data-node-id="1" data-type="NodeDocument"><p>正文</p>${inner}</div>`
}

test('scanPastedHtml：统计体积 / 元素 / 深度 / 内联图片预算', () => {
  const html = doc(`<div><div><span>深</span></div></div>${img(1000)}<img src="a.png"/>`)
  const scan = scanPastedHtml(html)
  assert.equal(scan.chars, html.length)
  assert.ok(scan.elements >= 8, `elements=${scan.elements}`)
  assert.ok(scan.maxDepth >= 3, `depth=${scan.maxDepth}`)
  assert.equal(scan.images.length, 1, '只认 data URI 的 img')
  const uriLen = 'data:image/png;base64,'.length + 1000
  assert.equal(scan.imageBytes, uriLen)
  assert.equal(scan.maxImageBytes, uriLen)
})

test('dataUriBytesOfTag：单双引号与裸值都认，非 data: 不计数', () => {
  assert.equal(
    dataUriBytesOfTag('<img src="data:image/png;base64,AAAA">'),
    'data:image/png;base64,AAAA'.length
  )
  assert.ok(dataUriBytesOfTag("<img src='data:image/png;base64,AAAA'>") > 0)
  assert.ok(dataUriBytesOfTag('<img src=data:image/png;base64,AAAA>') > 0)
  assert.equal(dataUriBytesOfTag('<img src="a.png">'), 0)
  assert.equal(dataUriBytesOfTag('<img alt="x">'), 0)
})

test('正常富文本粘贴：allow（既有管线、内容一个字都不动）', () => {
  const html =
    '<h2>标题</h2><p>普通<strong>加粗</strong>与<em>斜体</em></p>' +
    '<ul><li>甲</li></ul><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>' +
    `<p>${img(200 * 1024)}</p>`
  const d = decidePaste({ html, text: '标题 普通加粗' }, labels)
  assert.equal(d.kind, 'allow')
})

test('单张图超 8MB：降级为可见占位，其余内容保留', () => {
  const html = doc(`<p>前文</p>${img(PASTE_SOFT_SINGLE_IMAGE_BYTES + 1024)}<p>后文</p>`)
  const d = decidePaste({ html, text: '前文 后文' }, labels)
  assert.equal(d.kind, 'degrade')
  assert.equal(d.omittedImages, 1)
  assert.ok(d.html.includes('[IMG 8.0]'), d.html.slice(0, 200))
  assert.ok(d.html.includes('前文') && d.html.includes('后文'), '前后正文必须还在')
  assert.ok(!d.html.includes('data:image'), '超大 data URI 必须被拿掉')
})

test('多张图合计超 12MB：按顺序省略，保留预算内的图', () => {
  const each = 5 * 1024 * 1024
  const html = doc(img(each) + img(each) + img(each))
  const d = decidePaste({ html, text: '' }, labels)
  assert.equal(d.kind, 'degrade')
  assert.equal(d.omittedImages, 1, '合计 15MB：前两张在 12MB 预算内，第三张超出')
  assert.equal((d.html.match(/data:image/g) || []).length, 2, '预算内的两张保留')
  assert.equal((d.html.match(/data-lumin-paste-omitted/g) || []).length, 1)
})

test('单张超硬上限 16MB：整次拒绝（调用方不动文档）', () => {
  const html = doc(img(PASTE_HARD_SINGLE_IMAGE_BYTES + 1))
  const d = decidePaste({ html, text: '正文' }, labels)
  assert.equal(d.kind, 'reject')
  assert.equal(d.reason, 'single-image')
})

test('合计超硬上限 32MB：整次拒绝', () => {
  const each = 9 * 1024 * 1024
  const html = doc(img(each) + img(each) + img(each) + img(each))
  const d = decidePaste({ html, text: '' }, labels)
  assert.equal(d.kind, 'reject')
  assert.equal(d.reason, 'total-images')
})

test('结构护栏：元素数 / 深度超限 ⇒ 纯文本降级', () => {
  const many = `<div>${'<span>x</span>'.repeat(PASTE_MAX_ELEMENTS)}</div>`
  const d1 = decidePaste({ html: many, text: '纯文本' }, labels)
  assert.equal(d1.kind, 'fallback-text')
  assert.equal(d1.reason, 'too-many-elements')
  assert.equal(d1.text, '纯文本')

  let deep = 'x'
  for (let i = 0; i < PASTE_MAX_DEPTH + 5; i++) deep = `<div>${deep}</div>`
  const d2 = decidePaste({ html: deep, text: '更深' }, labels)
  assert.equal(d2.kind, 'fallback-text')
  assert.equal(d2.reason, 'too-deep')
  assert.equal(d2.text, '更深')
})

test('纯文本兜底：没有 text/plain 时剥标签；超长截断并标记', () => {
  const { text, truncated } = plainTextFallback('<p>甲</p><p>乙</p>', '')
  assert.equal(text, '甲 乙')
  assert.equal(truncated, false)
  const long = plainTextFallback(`<p>${'字'.repeat(PASTE_FALLBACK_TEXT_CHARS + 10)}</p>`, '')
  assert.equal(long.truncated, true)
  assert.equal(long.text.length, PASTE_FALLBACK_TEXT_CHARS)
})

test('占位只替换目标图片，其他字节原样', () => {
  const html = doc(`<p>甲</p>${img(1024)}<p>乙</p>`)
  const scan = scanPastedHtml(html)
  const out = omitOversizedInlineImages(html, scan, labels, { single: 100, total: 100 })
  assert.equal(out.omitted, 1)
  assert.ok(out.html.includes('<p>甲</p>') && out.html.includes('<p>乙</p>'))
  assert.ok(!out.html.includes('data:image'))
})

test('shouldRollback：只有"超时且文档真的变了"才回滚', () => {
  assert.equal(shouldRollback(2000, true, 1500), true)
  assert.equal(shouldRollback(1000, true, 1500), false)
  assert.equal(shouldRollback(9999, false, 1500), false, '文档没变就不该回滚')
  assert.equal(shouldRollback(Number.NaN, true, 1500), false)
})

test('扩展顺序：护栏必须排在 MathPaste **之后**（否则带 KaTeX 的剪贴板被它先接管）', () => {
  // 见 extensions.ts 里那段顺序说明：Tiptap 把插件反序塞进 view.state.plugins，
  // 而 someProp('handlePaste') 正向遍历 ⇒ **扩展数组里越靠后越先拿到粘贴事件**。
  // 实测（19 MB 思源夹具）：护栏写在 MathPaste 之前时，4 张 base64 被原样内联、护栏形同虚设。
  const src = readFileSync(
    new URL('../src/renderer/src/lib/editor/extensions.ts', import.meta.url),
    'utf8'
  )
  const math = src.indexOf('  MathPaste,')
  const guard = src.indexOf('  PasteFreezeGuard,')
  assert.ok(math > 0 && guard > 0, '两个扩展都要在 editorExtensions 里注册')
  assert.ok(guard > math, 'PasteFreezeGuard 必须写在 MathPaste 之后')
})
